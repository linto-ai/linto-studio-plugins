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
  }

  async init () {
    await this._ensureBrowser()
  }

  async _ensureBrowser () {
    if (this.browser && this.browser.isConnected()) return this.browser
    if (this.launching) return this.launching

    this.launching = chromium.launch({ headless: true, args: LAUNCH_ARGS })
      .then((browser) => {
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

    let context
    try {
      context = await browser.newContext(CONTEXT_OPTIONS)
      const page = await context.newPage()
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
    for (const id of [...this.contexts.keys()]) {
      await this.destroyContext(id)
    }
    if (this.browser) {
      const browser = this.browser
      this.browser = null
      try { await browser.close() } catch (e) { /* already gone */ }
      logger.info('BrowserPool: browser closed')
    }
  }

  getActiveCount () {
    return this.contexts.size
  }

  isAvailable () {
    return this.contexts.size < this.maxContexts
  }
}

module.exports = BrowserPool
