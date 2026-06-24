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

  describe('guards and idempotency', () => {
    const stub = require.cache[require.resolve('playwright')].exports.chromium
    let realLaunch
    beforeEach(() => { realLaunch = stub.launch })
    afterEach(() => { stub.launch = realLaunch })

    it('_ensureBrowser short-circuits when the browser is already connected', async () => {
      await pool.init()
      assert.equal(launchCount, 1)
      const first = pool.browser
      // A second _ensureBrowser() must return the SAME live browser without
      // launching again and without going through the in-flight launch promise.
      const again = await pool._ensureBrowser()
      assert.strictEqual(again, first, 'returns the existing connected browser')
      assert.equal(launchCount, 1, 'no extra launch when already connected')
    })

    it('replaces an existing context when createContext is called with a live id', async () => {
      await pool.init()
      const first = await pool.createContext('dup')
      assert.ok(first && first.context)
      const firstContext = first.context
      let closed = false
      // Observe that the OLD context is closed when the id is reused.
      const realClose = firstContext.close
      firstContext.close = async () => { closed = true; return realClose.call(firstContext) }

      const second = await pool.createContext('dup')
      assert.ok(second && second.context, 'a fresh context is created for the reused id')
      assert.equal(closed, true, 'the previous context for the id was destroyed first')
      assert.notStrictEqual(second.context, firstContext, 'the entry is a brand-new context')
      assert.equal(pool.getActiveCount(), 1, 'the reused id still counts as a single context')
      assert.strictEqual(pool.contexts.get('dup').context, second.context, 'the map points at the new context')
    })

    it("the 'disconnected' listener ignores a stale browser reference", async () => {
      await pool.createContext('a')
      const staleBrowser = currentBrowser // captured by the disconnect listener
      assert.equal(pool.getActiveCount(), 1)

      // Force a relaunch by simulating a crash, so a NEW browser becomes current.
      staleBrowser._disconnect()
      assert.equal(pool.browser, null)
      const r = await pool.createContext('b')
      assert.ok(r && r.page)
      const liveBrowser = pool.browser
      assert.notStrictEqual(liveBrowser, staleBrowser)
      assert.equal(pool.getActiveCount(), 1)

      // The STALE browser fires 'disconnected' again (e.g. delayed teardown). Its
      // listener must see this.browser !== browser and do nothing: it must not
      // null out the live browser nor clear the live contexts.
      staleBrowser._disconnect()
      assert.strictEqual(pool.browser, liveBrowser, 'live browser untouched by a stale disconnect')
      assert.equal(pool.getActiveCount(), 1, 'live contexts untouched by a stale disconnect')
    })

    it('cleans up and releases the reservation when newPage() fails', async () => {
      await pool.init()
      let contextClosed = false
      const goodNewContext = currentBrowser.newContext
      currentBrowser.newContext = async () => ({
        close: async () => { contextClosed = true },
        // newPage rejects: createContext must close the just-created context and
        // release the reserved slot, leaving no entry behind.
        newPage: async () => { throw new Error('newPage boom') }
      })

      const failed = await pool.createContext('a')
      assert.equal(failed, null)
      assert.equal(contextClosed, true, 'the orphaned context was closed after newPage failed')
      assert.equal(pool.contexts.has('a'), false, 'no stale entry after newPage failure')
      assert.equal(pool.reserved, 0, 'reservation released after newPage failure')

      // The slot is reusable.
      currentBrowser.newContext = goodNewContext
      const ok = await pool.createContext('a')
      assert.ok(ok && ok.page)
      assert.equal(pool.getActiveCount(), 1)
    })

    it('destroyContext swallows a page.close() exception and still drops the entry', async () => {
      await pool.init()
      const r = await pool.createContext('a')
      r.page.close = async () => { throw new Error('page close boom') }
      let contextClosed = false
      const realCtxClose = r.context.close
      r.context.close = async () => { contextClosed = true; return realCtxClose.call(r.context) }

      // Must not re-throw even though page.close() rejects, and must still close
      // the context and remove the entry.
      await pool.destroyContext('a')
      assert.equal(pool.contexts.has('a'), false, 'entry removed despite page.close failure')
      assert.equal(contextClosed, true, 'context.close still attempted after page.close threw')
      assert.equal(pool.getActiveCount(), 0)
    })

    it('destroyContext swallows a context.close() exception and still drops the entry', async () => {
      await pool.init()
      const r = await pool.createContext('a')
      r.context.close = async () => { throw new Error('context close boom') }

      await pool.destroyContext('a') // must not re-throw
      assert.equal(pool.contexts.has('a'), false, 'entry removed despite context.close failure')
      assert.equal(pool.getActiveCount(), 0)
    })

    it('destroy() swallows a browser.close() exception', async () => {
      await pool.createContext('a')
      pool.browser.close = async () => { throw new Error('browser close boom') }
      await pool.destroy() // must not re-throw
      assert.equal(pool.browser, null, 'browser reference cleared even though close threw')
      assert.equal(pool.getActiveCount(), 0)
    })

    it('destroy() swallows an in-flight launch rejection', async () => {
      // A launch is in flight and will reject AFTER destroy() starts awaiting it.
      // destroy() awaits this.launching inside a try/catch and must not re-throw.
      stub.launch = async () => { throw new Error('launch rejects late') }
      const creating = pool.createContext('a') // kicks off the failing launch
      await pool.destroy() // awaits this.launching, which rejects — must be swallowed
      await creating.catch(() => {})
      assert.equal(pool.browser, null)
      assert.equal(pool.destroyed, false, 'destroyed flag cleared even on launch rejection')
    })

    it('is reusable after destroy(): a new cycle of contexts works', async () => {
      await pool.createContext('a')
      await pool.createContext('b')
      assert.equal(pool.getActiveCount(), 2)
      await pool.destroy()
      assert.equal(pool.getActiveCount(), 0)
      assert.equal(pool.destroyed, false, 'destroyed flag cleared for reuse')

      // Second cycle: createContext must succeed (not be refused as destroyed) and
      // relaunch a fresh browser since destroy() closed the previous one.
      const r1 = await pool.createContext('c')
      const r2 = await pool.createContext('d')
      assert.ok(r1 && r1.page && r2 && r2.page)
      assert.equal(pool.getActiveCount(), 2)
      assert.equal(launchCount, 2, 'a fresh browser was launched for the new cycle')
    })

    it('handles concurrent destroyContext() calls on the same id without a race', async () => {
      await pool.init()
      await pool.createContext('a')
      assert.equal(pool.getActiveCount(), 1)
      // Two teardown calls race (e.g. an explicit destroy plus a crash handler).
      // The entry is deleted synchronously before the first await, so only one
      // call ever sees an entry; both resolve without throwing and the count is 0.
      await Promise.all([pool.destroyContext('a'), pool.destroyContext('a')])
      assert.equal(pool.getActiveCount(), 0)
      assert.equal(pool.contexts.has('a'), false)
    })

    it('handles concurrent destroyContext() across ids during a browser crash', async () => {
      await pool.createContext('a')
      await pool.createContext('b')
      await pool.createContext('c')
      assert.equal(pool.getActiveCount(), 3)
      // Tear all contexts down concurrently (as a crash cleanup would) — every
      // call must complete without a race corrupting the map.
      await Promise.all(['a', 'b', 'c'].map(id => pool.destroyContext(id)))
      assert.equal(pool.getActiveCount(), 0)
      assert.equal(pool.contexts.size, 0)
    })
  })
})
