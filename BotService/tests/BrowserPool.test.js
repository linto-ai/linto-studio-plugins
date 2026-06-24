const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')

// Mock `playwright` so unit tests never launch a real browser. playwright is an
// installed dependency, so require.resolve finds it; we replace its cache entry
// with a stub BEFORE requiring BrowserPool (which does `require('playwright')`).
let launchCount = 0
function makeMockBrowser () {
  let connected = true
  const listeners = {}
  return {
    _disconnect () { connected = false; (listeners.disconnected || []).forEach(fn => fn()) },
    isConnected: () => connected,
    on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn) },
    newContext: async () => ({
      close: async () => {},
      newPage: async () => ({ close: async () => {}, on: () => {}, addInitScript: async () => {}, goto: async () => {} })
    }),
    close: async () => { connected = false }
  }
}
let currentBrowser = null
require.cache[require.resolve('playwright')] = {
  id: 'playwright',
  filename: 'playwright',
  loaded: true,
  exports: {
    chromium: {
      launch: async () => { launchCount++; currentBrowser = makeMockBrowser(); return currentBrowser }
    }
  }
}

const BrowserPool = require('../bot/BrowserPool')

describe('BrowserPool', () => {
  let pool
  beforeEach(() => { launchCount = 0; currentBrowser = null; pool = new BrowserPool({ maxContexts: 3 }) })
  afterEach(async () => { await pool.destroy() })

  it('launches a single shared browser on init', async () => {
    await pool.init()
    assert.equal(launchCount, 1)
    assert.notEqual(pool.browser, null)
  })

  it('creates an isolated context+page', async () => {
    await pool.init()
    const r = await pool.createContext('a')
    assert.ok(r && r.context && r.page)
    assert.equal(pool.getActiveCount(), 1)
  })

  it('lazily launches the browser if createContext is called before init', async () => {
    const r = await pool.createContext('a')
    assert.ok(r && r.page)
    assert.equal(launchCount, 1)
  })

  it('creates multiple isolated contexts sharing one browser', async () => {
    await pool.createContext('a')
    await pool.createContext('b')
    await pool.createContext('c')
    assert.equal(pool.getActiveCount(), 3)
    assert.equal(launchCount, 1)
  })

  it('returns null when maxContexts is reached', async () => {
    await pool.createContext('a')
    await pool.createContext('b')
    await pool.createContext('c')
    assert.equal(await pool.createContext('d'), null)
    assert.equal(pool.getActiveCount(), 3)
  })

  it('never exceeds maxContexts under concurrent createContext() calls', async () => {
    const n = 10 // > maxContexts (3)
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => pool.createContext(`c${i}`))
    )
    const ok = results.filter(r => r && r.page)
    assert.equal(ok.length, pool.maxContexts) // exactly maxContexts succeed
    assert.equal(pool.getActiveCount(), pool.maxContexts) // pool never overflows
    assert.equal(launchCount, 1) // still one shared browser
  })

  it('destroyContext decrements the count and is a no-op for unknown ids', async () => {
    await pool.createContext('a')
    await pool.createContext('b')
    await pool.destroyContext('a')
    assert.equal(pool.getActiveCount(), 1)
    await pool.destroyContext('nope') // no throw
  })

  it('isAvailable reflects the cap', async () => {
    await pool.init()
    assert.equal(pool.isAvailable(), true)
    await pool.createContext('a')
    await pool.createContext('b')
    await pool.createContext('c')
    assert.equal(pool.isAvailable(), false)
  })

  it('relaunches a fresh browser after a disconnect (crash recovery)', async () => {
    await pool.createContext('a')
    assert.equal(pool.getActiveCount(), 1)
    currentBrowser._disconnect() // simulate Chromium crash
    assert.equal(pool.browser, null)
    assert.equal(pool.getActiveCount(), 0)
    const r = await pool.createContext('b')
    assert.ok(r && r.page)
    assert.equal(launchCount, 2)
  })

  it('destroy() closes everything', async () => {
    await pool.createContext('a')
    await pool.createContext('b')
    await pool.destroy()
    assert.equal(pool.getActiveCount(), 0)
    assert.equal(pool.browser, null)
  })

  describe('failure recovery', () => {
    // Handle to the live playwright stub so individual tests can inject failures
    // into launch()/newContext() and then restore the happy-path behaviour.
    const stub = require.cache[require.resolve('playwright')].exports.chromium
    let realLaunch
    beforeEach(() => { realLaunch = stub.launch })
    afterEach(() => { stub.launch = realLaunch })

    it('dedupes concurrent (re)launches into one launch even when callers race', async () => {
      // Two createContext() calls before any browser exists must share the single
      // in-flight launch promise rather than spawning two browsers.
      const [a, b] = await Promise.all([pool.createContext('a'), pool.createContext('b')])
      assert.ok(a && a.page && b && b.page)
      assert.equal(launchCount, 1) // one shared browser despite the race
      assert.equal(pool.getActiveCount(), 2)
    })

    it('returns null and frees the reservation when launch() fails, then recovers next call', async () => {
      stub.launch = async () => { throw new Error('chromium spawn failed') }
      const failed = await pool.createContext('a')
      assert.equal(failed, null)
      assert.equal(pool.getActiveCount(), 0)
      assert.equal(pool.reserved, 0, 'reservation released on launch failure (no leaked slot)')
      assert.equal(pool.browser, null)
      // Capacity is intact: a later successful launch creates a context normally.
      stub.launch = realLaunch
      const ok = await pool.createContext('b')
      assert.ok(ok && ok.page)
      assert.equal(pool.getActiveCount(), 1)
    })

    it('leaves no stale entry and frees the slot when context creation fails', async () => {
      await pool.init()
      const goodNewContext = currentBrowser.newContext
      currentBrowser.newContext = async () => { throw new Error('newContext boom') }
      const failed = await pool.createContext('a')
      assert.equal(failed, null)
      assert.equal(pool.getActiveCount(), 0)
      assert.equal(pool.contexts.has('a'), false, 'no stale context entry left behind')
      assert.equal(pool.reserved, 0, 'reservation released on context-create failure')
      // Slot is reusable: a subsequent good create succeeds.
      currentBrowser.newContext = goodNewContext
      const ok = await pool.createContext('a')
      assert.ok(ok && ok.page)
      assert.equal(pool.getActiveCount(), 1)
    })

    it('does not leak a reservation when a failed creation would otherwise hold a slot at the cap', async () => {
      const small = new BrowserPool({ maxContexts: 1 })
      await small.init()
      const good = currentBrowser.newContext
      currentBrowser.newContext = async () => { throw new Error('boom') }
      assert.equal(await small.createContext('a'), null) // fails, must release the only slot
      currentBrowser.newContext = good
      const ok = await small.createContext('b') // would be refused if the slot leaked
      assert.ok(ok && ok.page)
      assert.equal(small.getActiveCount(), 1)
      await small.destroy()
    })

    it('relaunches a fresh browser on the next create after a launch failure', async () => {
      stub.launch = async () => { throw new Error('first launch down') }
      assert.equal(await pool.createContext('a'), null)
      assert.equal(launchCount, 0) // failed launches do not increment the success counter
      stub.launch = realLaunch
      const ok = await pool.createContext('b')
      assert.ok(ok && ok.page)
      assert.equal(launchCount, 1) // a brand-new browser was launched
    })

    it('leaves no connected browser after a destroy() that races an in-flight create', async () => {
      // destroy() marks the pool destroyed and awaits `this.launching`, and the
      // launch path closes any browser that resolves after destroy instead of
      // installing it (which would leak). The in-flight create likewise refuses
      // to re-insert a context into a drained pool.
      const creating = pool.createContext('a')
      await pool.destroy()
      const raced = await creating.catch(() => null) // resolves to null in a destroyed pool

      // Leak is fixed: no connected browser left dangling, pool fully drained.
      assert.equal(pool.browser, null, 'no browser installed after destroy')
      assert.equal(pool.getActiveCount(), 0, 'no context re-inserted after destroy')
      assert.equal(raced, null, 'the raced create yields no usable context')
      // The orphaned browser launched mid-create must have been closed, not leaked.
      if (currentBrowser) assert.equal(currentBrowser.isConnected(), false, 'orphaned browser closed')

      // Recoverability: the pool can still be driven again afterwards.
      const ok = await pool.createContext('b')
      assert.ok(ok && ok.page, 'pool remains usable after a destroy/create race')
      assert.equal(pool.getActiveCount(), 1)
      await pool.destroy()
    })
  })
})
