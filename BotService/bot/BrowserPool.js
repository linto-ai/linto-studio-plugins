const EventEmitter = require('events')
const { logger } = require('live-srt-lib')
const { chromium } = require('playwright')

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--mute-audio',
  '--use-fake-ui-for-media-stream', // auto-accept the mic/camera permission prompt
  // Provide a synthetic mic/camera so getUserMedia succeeds in headless Chromium.
  // Without a capture device the meeting SPA's getUserMedia throws NotFoundError,
  // which on LiveKit-based clients (Visio) aborts the join before the signaling
  // WebSocket falls back to the working endpoint — the bot then never connects.
  '--use-fake-device-for-media-capture',
  '--autoplay-policy=no-user-gesture-required',
  // The in-page interceptor connects back to the loopback audio server over
  // ws://127.0.0.1; the meeting page's CSP (connect-src) / mixed-content policy
  // otherwise blocks that loopback so no captured PCM ever reaches Node.
  '--disable-web-security',
  '--allow-running-insecure-content'
]

const CONTEXT_OPTIONS = {
  bypassCSP: true, // required to inject the WebRTC interception init script
  permissions: ['microphone', 'camera'],
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

/**
 * BrowserPool — one shared headless Chromium for the whole process, with one
 * isolated BrowserContext per bot (keyed by an opaque id). Caps concurrency at
 * `maxContexts` and lazily (re)launches the browser if it is missing or has
 * crashed, so a browser disconnect doesn't permanently break the service.
 */
class BrowserPool extends EventEmitter {
  constructor (options = {}) {
    super()
    this.maxContexts = options.maxContexts || 10
    this.browser = null
    this.launching = null // in-flight launch promise (dedupes concurrent (re)launches)
    this.contexts = new Map() // id -> { context, page }
    this.reserved = 0 // slots claimed by in-flight createContext() calls not yet in `contexts`
    this.destroyed = false // T19: set by destroy(); launch/create must not repopulate after it
  }

  async init () {
    await this._ensureBrowser()
  }

  async _ensureBrowser () {
    if (this.browser && this.browser.isConnected()) return this.browser
    if (this.launching) return this.launching

    this.launching = chromium.launch({ headless: true, args: LAUNCH_ARGS })
      .then((browser) => {
        // T19: the pool was destroyed while this launch was in flight. Do NOT
        // install the browser (it would leak — destroy() already ran and nothing
        // would ever close it); close it here and report it as unavailable.
        if (this.destroyed) {
          logger.info('BrowserPool: launch resolved after destroy, closing the orphaned browser')
          browser.close().catch(() => {})
          return null
        }
        this.browser = browser
        browser.on('disconnected', () => {
          // Crash or external close: drop the reference and forget the now-dead
          // contexts so the next createContext() relaunches a fresh browser, and
          // signal owners so they can tear down the bots whose pages just died
          // (their mixers/WS live outside the pool and would otherwise leak).
          if (this.browser === browser) {
            logger.warn('BrowserPool: Chromium disconnected, clearing pool')
            this.browser = null
            this.contexts.clear()
            this.emit('disconnected')
          }
        })
        logger.info('BrowserPool: Chromium launched')
        return browser
      })
      .finally(() => { this.launching = null })

    return this.launching
  }

  /**
   * Create an isolated context+page for `id`. Returns null when the pool is
   * full so the caller can surface back-pressure (rather than overcommitting).
   * @returns {Promise<{context, page}|null>}
   */
  async createContext (id) {
    if (this.destroyed) {
      logger.warn(`BrowserPool: pool destroyed, refusing context ${id}`)
      return null
    }
    if (this.contexts.has(id)) {
      logger.warn(`BrowserPool: context ${id} already exists, replacing`)
      await this.destroyContext(id)
    }

    // Reserve a slot SYNCHRONOUSLY (no await between the cap check and the
    // increment) so that concurrent createContext() calls cannot all pass the
    // check before any of them registers a context and overflow the pool. The
    // cap counts both live contexts and in-flight reservations; the slot is
    // released on any failure path below.
    if (this.contexts.size + this.reserved >= this.maxContexts) {
      logger.warn(`BrowserPool: max contexts (${this.maxContexts}) reached, refusing ${id}`)
      return null
    }
    this.reserved++

    let browser
    try {
      browser = await this._ensureBrowser()
    } catch (e) {
      this.reserved--
      logger.error(`BrowserPool: failed to launch Chromium: ${e.message}`)
      return null
    }

    // T19: destroy() may have run while the launch was in flight — _ensureBrowser
    // then resolves to null (the orphaned browser was closed). Bail without
    // inserting a context that destroy() already drained.
    if (this.destroyed || !browser) {
      this.reserved--
      logger.warn(`BrowserPool: pool destroyed during launch, refusing context ${id}`)
      return null
    }

    let context
    try {
      context = await browser.newContext(CONTEXT_OPTIONS)
      const page = await context.newPage()
      // T19: a destroy() could still have raced the newContext()/newPage() awaits;
      // never re-insert into a destroyed pool — close the fresh context instead.
      if (this.destroyed) {
        try { await context.close() } catch (_) { /* best effort */ }
        logger.warn(`BrowserPool: pool destroyed during context create, discarding ${id}`)
        return null
      }
      this.contexts.set(id, { context, page })
      logger.info(`BrowserPool: context created for ${id} (${this.contexts.size}/${this.maxContexts})`)
      return { context, page }
    } catch (e) {
      if (context) { try { await context.close() } catch (_) { /* best effort */ } }
      logger.error(`BrowserPool: failed to create context for ${id}: ${e.message}`)
      return null
    } finally {
      this.reserved--
    }
  }

  async destroyContext (id) {
    const entry = this.contexts.get(id)
    if (!entry) return
    this.contexts.delete(id)
    try { await entry.page.close() } catch (e) { logger.debug(`BrowserPool: page close ${id}: ${e.message}`) }
    try { await entry.context.close() } catch (e) { logger.debug(`BrowserPool: context close ${id}: ${e.message}`) }
    logger.info(`BrowserPool: context destroyed for ${id} (${this.contexts.size}/${this.maxContexts})`)
  }

  async destroy () {
    // T19: mark destroyed FIRST so any in-flight launch/create that resolves after
    // this point closes its browser/context instead of repopulating the pool.
    this.destroyed = true
    for (const id of [...this.contexts.keys()]) {
      await this.destroyContext(id)
    }
    if (this.browser) {
      const browser = this.browser
      this.browser = null
      try { await browser.close() } catch (e) { /* already gone */ }
      logger.info('BrowserPool: browser closed')
    }
    // T19: await the in-flight launch so the orphaned-browser close above has
    // actually happened by the time destroy() returns (no connected browser left
    // dangling). The launch path sees `destroyed` and closes its own browser.
    if (this.launching) {
      try { await this.launching } catch (e) { /* launch failure is fine here */ }
    }
    // Recoverability: the pool can be driven again after a destroy(). Clearing the
    // flag is safe now — every prior in-flight launch/create has observed it set.
    this.destroyed = false
  }

  getActiveCount () {
    return this.contexts.size
  }

  isAvailable () {
    return this.contexts.size < this.maxContexts
  }
}

module.exports = BrowserPool
