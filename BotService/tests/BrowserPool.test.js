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
})
