const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('mocha')
const http = require('http')
const path = require('path')

const { loadBrokerClient, uninstallMocks } = require('./helpers')

const healthcheckPath = path.resolve(__dirname, '../components/Healthcheck/index.js')

// Load the Healthcheck component against the same live-srt-lib mocks the
// BrokerClient tests use, wired to a real (mock-backed) BrokerClient so the
// status it reports comes from genuine bots/browserPool/audioServer state.
// Binds the HTTP server on an ephemeral port (BOTSERVICE_HEALTHCHECK_HTTP=0).
function loadHealthcheck () {
  const { instance: brokerClient } = loadBrokerClient() // installs the lib mocks
  const app = { components: { BrokerClient: brokerClient } }
  process.env.BOTSERVICE_HEALTHCHECK_HTTP = '0'
  delete require.cache[healthcheckPath]
  const factory = require(healthcheckPath)
  const hc = factory(app)
  return { brokerClient, hc }
}

describe('Healthcheck', () => {
  afterEach(() => { uninstallMocks() })

  it('getStatus reports liveness sourced from real BrokerClient state', () => {
    const { brokerClient, hc } = loadHealthcheck()
    // No browser launched; audioServer.getPort stubbed to 12345 in helpers.
    // E6: a non-connected browser is degraded even though the audio server listens.
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
    // E6: browser connected AND audio server listening -> healthy.
    assert.equal(s.status, 'ok')

    hc.healthCheckServer.close()
  })

  // E6: a wedged replica (no live browser / no audio server) reports 'degraded'
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
    // E6: make it healthy — connected browser + listening audio server.
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
})
