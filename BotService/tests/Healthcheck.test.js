const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const http = require('http')
const path = require('path')

const { loadBrokerClient, uninstallMocks } = require('./helpers')

const healthcheckPath = path.resolve(__dirname, '../components/Healthcheck/index.js')
const liveSrtLibPath = require.resolve('live-srt-lib')

// Load the Healthcheck component against the same live-srt-lib mocks the
// BrokerClient tests use, wired to a real (mock-backed) BrokerClient so the
// status it reports comes from genuine bots/browserPool/audioServer state.
// Binds the HTTP server on an ephemeral port (BOTSERVICE_HEALTHCHECK_HTTP=0).
// Returns the captured logs array so tests can assert on logger output.
function loadHealthcheck () {
  const { instance: brokerClient, logs } = loadBrokerClient() // installs the lib mocks
  const app = { components: { BrokerClient: brokerClient } }
  process.env.BOTSERVICE_HEALTHCHECK_HTTP = '0'
  delete require.cache[healthcheckPath]
  const factory = require(healthcheckPath)
  const hc = factory(app)
  return { brokerClient, hc, logs }
}

// Small helper: GET a path on a (listening) healthcheck server and resolve the
// parsed { statusCode, contentType, json } once the body is read.
function httpGet (server, reqPath, method) {
  return new Promise((resolve, reject) => {
    const port = server.address().port
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: method || 'GET' }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let json = null
        try { json = body ? JSON.parse(body) : null } catch (_) { /* HEAD has no body */ }
        resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'], json, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function onceListening (server) {
  return new Promise((resolve) => {
    if (server.listening) return resolve()
    server.once('listening', resolve)
  })
}

// Real-Component lib mock used only for the missing-dependency case: the shared
// FakeComponent in helpers.js intentionally ignores requiredComponents, so we
// swap in the real Component (which enforces deps and throws componentMissingError).
function installRealComponentMock () {
  const realLib = jestlessRequireReal()
  const logs = []
  const push = (level) => (...args) => logs.push({ level, msg: args.join(' ') })
  require.cache[liveSrtLibPath] = {
    id: liveSrtLibPath,
    filename: liveSrtLibPath,
    loaded: true,
    exports: {
      Component: realLib.Component,
      logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') },
      MqttClient: function () { return {} },
      Application: class {},
      Model: {},
      CircularBuffer: class {},
      Config: {},
      CustomErrors: realLib.CustomErrors,
      Security: class {}
    }
  }
  delete require.cache[healthcheckPath]
  return { logs }
}

// Load the real live-srt-lib once, bypassing whatever mock currently sits in the
// cache, so we can borrow its genuine Component/CustomErrors classes.
function jestlessRequireReal () {
  const cached = require.cache[liveSrtLibPath]
  delete require.cache[liveSrtLibPath]
  const real = require('live-srt-lib')
  // restore the (mock or absent) cache entry for the caller to manage
  if (cached) require.cache[liveSrtLibPath] = cached
  else delete require.cache[liveSrtLibPath]
  return real
}

describe('Healthcheck', () => {
  afterEach(() => { uninstallMocks() })

  it('getStatus reports liveness sourced from real BrokerClient state', () => {
    const { brokerClient, hc } = loadHealthcheck()
    // No browser launched; audioServer.getPort stubbed to 12345 in helpers.
    // A non-connected browser is degraded even though the audio server listens.
    let s = hc.getStatus()
    assert.equal(s.status, 'degraded')
    assert.equal(s.activeBots, 0)
    assert.equal(s.browserConnected, false)
    assert.equal(s.audioServerListening, true)

    // Reflect live state changes from the BrokerClient/BrowserPool.
    brokerClient.bots.set('s1_c1', {})
    brokerClient.bots.set('s2_c2', {})
    brokerClient.browserPool.browser = { isConnected: () => true }
    s = hc.getStatus()
    assert.equal(s.activeBots, 2)
    assert.equal(s.browserConnected, true)
    // Browser connected AND audio server listening -> healthy.
    assert.equal(s.status, 'ok')

    hc.healthCheckServer.close()
  })

  // A wedged replica (no live browser / no audio server) reports 'degraded'
  // with HTTP 503 so the Docker HEALTHCHECK fails and it is restarted.
  it('returns degraded + HTTP 503 when the browser is not connected', (done) => {
    const { hc } = loadHealthcheck()
    hc.healthCheckServer.once('listening', () => {
      const port = hc.healthCheckServer.address().port
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          assert.equal(res.statusCode, 503)
          assert.match(res.headers['content-type'], /application\/json/)
          const json = JSON.parse(body)
          assert.equal(json.status, 'degraded')
          assert.ok('activeBots' in json && 'browserConnected' in json && 'audioServerListening' in json)
          hc.healthCheckServer.close(() => done())
        })
      }).on('error', done)
    })
  })

  it('serves status as JSON over HTTP 200 when healthy', (done) => {
    const { brokerClient, hc } = loadHealthcheck()
    // Make it healthy — connected browser + listening audio server.
    brokerClient.browserPool.browser = { isConnected: () => true }
    hc.healthCheckServer.once('listening', () => {
      const port = hc.healthCheckServer.address().port
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          assert.equal(res.statusCode, 200)
          assert.match(res.headers['content-type'], /application\/json/)
          const json = JSON.parse(body)
          assert.equal(json.status, 'ok')
          assert.ok('activeBots' in json && 'browserConnected' in json && 'audioServerListening' in json)
          hc.healthCheckServer.close(() => done())
        })
      }).on('error', done)
    })
  })

  it('sets component id to the class name Healthcheck', () => {
    const { hc } = loadHealthcheck()
    assert.equal(hc.id, 'Healthcheck')
    hc.healthCheckServer.close()
  })

  it('init runs without error and loads no controllers (no controllers dir)', () => {
    // Construction calls this.init(); reaching here without a throw proves the
    // component initialises cleanly even though it ships no controllers/ folder.
    const { hc } = loadHealthcheck()
    assert.ok(hc instanceof Object)
    assert.equal(typeof hc.getStatus, 'function')
    assert.ok(hc.healthCheckServer, 'healthCheckServer is set up')
    hc.healthCheckServer.close()
  })

  it('logs the listen message with the configured port on server listen', async () => {
    const { hc, logs } = loadHealthcheck()
    await onceListening(hc.healthCheckServer)
    const listenLog = logs.find(l => /HealthCheck server listening on port/.test(l.msg))
    assert.ok(listenLog, 'a listen log is emitted')
    assert.equal(listenLog.level, 'info')
    // The log reports the RESOLVED port (port 0 binds an ephemeral one).
    const resolved = hc.healthCheckServer.address().port
    assert.ok(resolved > 0, 'an ephemeral port was bound')
    assert.match(listenLog.msg, new RegExp(`listening on port ${resolved}$`))
    hc.healthCheckServer.close()
  })

  // --- componentMissingError (gap 1): enforced by the real Component base. ---
  it('throws componentMissingError when app.components lacks BrokerClient', () => {
    installRealComponentMock()
    try {
      const factory = require(healthcheckPath)
      assert.throws(
        () => factory({ components: {} }),
        (err) => {
          assert.equal(err.name, 'COMPONENT_MISSING')
          assert.deepEqual(err.missingComponents, ['BrokerClient'])
          return true
        }
      )
    } finally {
      uninstallMocks()
      delete require.cache[liveSrtLibPath]
      delete require.cache[healthcheckPath]
    }
  })

  // --- getStatus() guards on null sub-components. ---
  it('getStatus returns sensible degraded status when brokerClient is null', () => {
    const { hc } = loadHealthcheck()
    hc.brokerClient = null
    const s = hc.getStatus()
    assert.equal(s.status, 'degraded')
    assert.equal(s.activeBots, 0)
    assert.equal(s.browserConnected, false)
    assert.equal(s.audioServerListening, false)
    hc.healthCheckServer.close()
  })

  it('getStatus reports browserConnected false when browserPool is null', () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.browserPool = null
    const s = hc.getStatus()
    assert.equal(s.browserConnected, false)
    // audioServer still listens (stubbed to 12345) so only the browser is down.
    assert.equal(s.audioServerListening, true)
    assert.equal(s.status, 'degraded')
    hc.healthCheckServer.close()
  })

  it('getStatus reports audioServerListening false when audioServer is null', () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.audioServer = null
    brokerClient.browserPool.browser = { isConnected: () => true }
    const s = hc.getStatus()
    assert.equal(s.audioServerListening, false)
    assert.equal(s.browserConnected, true)
    assert.equal(s.status, 'degraded')
    hc.healthCheckServer.close()
  })

  it('getStatus treats audioServer.getPort() === 0 as not listening', () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.audioServer.getPort = () => 0
    brokerClient.browserPool.browser = { isConnected: () => true }
    const s = hc.getStatus()
    assert.equal(s.audioServerListening, false)
    assert.equal(s.status, 'degraded')
    hc.healthCheckServer.close()
  })

  it('getStatus treats a negative audioServer.getPort() as not listening', () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.audioServer.getPort = () => -1
    brokerClient.browserPool.browser = { isConnected: () => true }
    const s = hc.getStatus()
    assert.equal(s.audioServerListening, false)
    assert.equal(s.status, 'degraded')
    hc.healthCheckServer.close()
  })

  // --- getStatus() never lets a probe-time error escape: it reports 'degraded'
  // (and logs) instead of throwing into the HTTP handler. ---
  it('reports degraded (no throw) when browser.isConnected() throws', () => {
    const { brokerClient, hc, logs } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => { throw new Error('boom-isConnected') } }
    const s = hc.getStatus()
    assert.equal(s.status, 'degraded')
    assert.ok(logs.find(l => l.level === 'error' && /boom-isConnected/.test(l.msg)), 'the failure is logged')
    hc.healthCheckServer.close()
  })

  it('reports degraded (no throw) when audioServer.getPort() throws', () => {
    const { brokerClient, hc, logs } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => true }
    brokerClient.audioServer.getPort = () => { throw new Error('boom-getPort') }
    const s = hc.getStatus()
    assert.equal(s.status, 'degraded')
    assert.ok(logs.find(l => l.level === 'error' && /boom-getPort/.test(l.msg)), 'the failure is logged')
    hc.healthCheckServer.close()
  })

  // --- HTTP server error handling. ---
  it('logs an error when the healthCheckServer emits an error event', () => {
    const { hc, logs } = loadHealthcheck()
    hc.healthCheckServer.emit('error', new Error('synthetic-server-error'))
    const errLog = logs.find(l => l.level === 'error' && /synthetic-server-error/.test(l.msg))
    assert.ok(errLog, 'server error is logged via logger.error')
    assert.match(errLog.msg, /BotService HealthCheck server error/)
    hc.healthCheckServer.close()
  })

  it('defaults to a valid port when BOTSERVICE_HEALTHCHECK_HTTP is unset (no crash)', () => {
    // Unset → fall back to the default port instead of server.listen(NaN) →
    // ERR_SOCKET_BAD_PORT crashing startup. The constructor must not throw.
    const { instance: brokerClient } = loadBrokerClient()
    const app = { components: { BrokerClient: brokerClient } }
    const saved = process.env.BOTSERVICE_HEALTHCHECK_HTTP
    delete process.env.BOTSERVICE_HEALTHCHECK_HTTP
    delete require.cache[healthcheckPath]
    let hc
    try {
      assert.doesNotThrow(() => { hc = require(healthcheckPath)(app) })
    } finally {
      if (hc && hc.healthCheckServer) { try { hc.healthCheckServer.close() } catch (e) { /* noop */ } }
      if (saved !== undefined) process.env.BOTSERVICE_HEALTHCHECK_HTTP = saved
      else process.env.BOTSERVICE_HEALTHCHECK_HTTP = '0'
    }
  })

  it('throws a CLEAR error when BOTSERVICE_HEALTHCHECK_HTTP is non-numeric', () => {
    const { instance: brokerClient } = loadBrokerClient()
    const app = { components: { BrokerClient: brokerClient } }
    process.env.BOTSERVICE_HEALTHCHECK_HTTP = 'not-a-port'
    delete require.cache[healthcheckPath]
    try {
      assert.throws(() => require(healthcheckPath)(app), /must be a port/)
    } finally {
      process.env.BOTSERVICE_HEALTHCHECK_HTTP = '0'
    }
  })

  it('logs an error when the configured port is already in use', (done) => {
    // Occupy a port, then point a second healthcheck server at it and verify the
    // EADDRINUSE error is surfaced through the logger.error handler.
    const blocker = http.createServer(() => {})
    blocker.listen(0, () => {
      const busyPort = blocker.address().port
      const { instance: brokerClient, logs } = loadBrokerClient()
      const app = { components: { BrokerClient: brokerClient } }
      process.env.BOTSERVICE_HEALTHCHECK_HTTP = String(busyPort)
      delete require.cache[healthcheckPath]
      const hc = require(healthcheckPath)(app)
      hc.healthCheckServer.once('error', () => {
        // give the synchronous logger.error call a tick to land
        setImmediate(() => {
          const errLog = logs.find(l => l.level === 'error' && /HealthCheck server error/.test(l.msg))
          assert.ok(errLog, 'EADDRINUSE surfaced via logger.error')
          assert.match(errLog.msg, /EADDRINUSE|address already in use/i)
          process.env.BOTSERVICE_HEALTHCHECK_HTTP = '0'
          try { hc.healthCheckServer.close() } catch (_) {}
          blocker.close(() => done())
        })
      })
    })
  })

  // --- HTTP routing: every path/method returns the same status snapshot. ---
  it('returns the same status for /, /health, /status and /api/status', async () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => true }
    await onceListening(hc.healthCheckServer)
    const paths = ['/', '/health', '/status', '/api/status']
    const results = await Promise.all(paths.map(p => httpGet(hc.healthCheckServer, p)))
    for (const r of results) {
      assert.equal(r.statusCode, 200)
      assert.match(r.contentType, /application\/json/)
      assert.equal(r.json.status, 'ok')
    }
    hc.healthCheckServer.close()
  })

  it('responds identically to GET, POST, HEAD and DELETE', async () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => true }
    await onceListening(hc.healthCheckServer)
    const get = await httpGet(hc.healthCheckServer, '/', 'GET')
    const post = await httpGet(hc.healthCheckServer, '/', 'POST')
    const del = await httpGet(hc.healthCheckServer, '/', 'DELETE')
    const head = await httpGet(hc.healthCheckServer, '/', 'HEAD')
    assert.equal(get.statusCode, 200)
    assert.equal(post.statusCode, 200)
    assert.equal(del.statusCode, 200)
    assert.equal(head.statusCode, 200)
    assert.equal(get.json.status, 'ok')
    assert.equal(post.json.status, 'ok')
    assert.equal(del.json.status, 'ok')
    // HEAD carries the status code but no body.
    assert.equal(head.body, '')
    hc.healthCheckServer.close()
  })

  it('serves many concurrent requests with a consistent status', async () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => true }
    brokerClient.bots.set('s1_c1', {})
    await onceListening(hc.healthCheckServer)
    const results = await Promise.all(
      Array.from({ length: 25 }, () => httpGet(hc.healthCheckServer, '/'))
    )
    for (const r of results) {
      assert.equal(r.statusCode, 200)
      assert.equal(r.json.status, 'ok')
      assert.equal(r.json.activeBots, 1)
      assert.equal(r.json.browserConnected, true)
    }
    hc.healthCheckServer.close()
  })

  it('serialises a large activeBots count correctly', async () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => true }
    for (let i = 0; i < 1500; i++) brokerClient.bots.set('bot_' + i, {})
    await onceListening(hc.healthCheckServer)
    const r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.statusCode, 200)
    assert.equal(r.json.activeBots, 1500)
    assert.equal(typeof r.json.activeBots, 'number')
    hc.healthCheckServer.close()
  })

  it('reflects a browser state change between requests', async () => {
    const { brokerClient, hc } = loadHealthcheck()
    await onceListening(hc.healthCheckServer)
    // First request: no browser -> degraded/503.
    let r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.statusCode, 503)
    assert.equal(r.json.browserConnected, false)
    // Browser comes up between requests -> next snapshot is healthy.
    brokerClient.browserPool.browser = { isConnected: () => true }
    r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.statusCode, 200)
    assert.equal(r.json.browserConnected, true)
    // And drops again -> degraded once more (no stale cached state).
    brokerClient.browserPool.browser = { isConnected: () => false }
    r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.statusCode, 503)
    assert.equal(r.json.browserConnected, false)
    hc.healthCheckServer.close()
  })

  it('reflects bots count changes between requests (no cached counter)', async () => {
    const { brokerClient, hc } = loadHealthcheck()
    brokerClient.browserPool.browser = { isConnected: () => true }
    await onceListening(hc.healthCheckServer)
    let r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.json.activeBots, 0)
    brokerClient.bots.set('a', {})
    brokerClient.bots.set('b', {})
    r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.json.activeBots, 2)
    brokerClient.bots.delete('a')
    r = await httpGet(hc.healthCheckServer, '/')
    assert.equal(r.json.activeBots, 1)
    hc.healthCheckServer.close()
  })
})
