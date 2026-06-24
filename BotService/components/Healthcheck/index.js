const { Component, logger } = require('live-srt-lib')
const http = require('http')

// Mirrors the Transcriber's Healthcheck component (a tiny liveness server probed
// from the Dockerfile HEALTHCHECK via healthcheck.sh). Unlike the Transcriber's
// dumb 'OK' TCP responder, the BotService reports real component state — active
// bot count, whether the shared Chromium is connected, and whether the loopback
// audio server is listening — read live from the BrokerClient it depends on.
class Healthcheck extends Component {
    constructor(app) {
        // Depend on BrokerClient so this component loads after it and we can read
        // its live state (BOTSERVICE_COMPONENTS=BrokerClient,Healthcheck).
        super(app, 'BrokerClient')
        this.id = this.constructor.name
        this.brokerClient = app.components['BrokerClient']
        this.init()
        this.setupHealthCheckServer()
    }

    // Snapshot of liveness, sourced from the real BrokerClient/BrowserPool/
    // LocalAudioServer state (no cached counters).
    getStatus() {
        const bc = this.brokerClient
        const browser = bc && bc.browserPool && bc.browserPool.browser
        const browserConnected = !!(browser && browser.isConnected())
        const audioServerListening = !!(bc && bc.audioServer && bc.audioServer.getPort() > 0)
        // E6: a replica with no live browser or a non-listening audio server cannot
        // serve a bot — report 'degraded' (paired with a 503 over HTTP) so the
        // Docker HEALTHCHECK fails and a wedged replica is restarted (pairs with E5).
        const healthy = browserConnected && audioServerListening
        return {
            status: healthy ? 'ok' : 'degraded',
            activeBots: bc ? bc.bots.size : 0,
            browserConnected,
            audioServerListening
        }
    }

    setupHealthCheckServer() {
        this.healthCheckServer = http.createServer((req, res) => {
            const status = this.getStatus()
            const body = JSON.stringify(status)
            // E6: 503 when degraded so the HEALTHCHECK probe treats it as unhealthy.
            const code = status.status === 'ok' ? 200 : 503
            res.writeHead(code, { 'Content-Type': 'application/json' })
            res.end(body)
        })
        this.healthCheckServer.on('error', (error) => {
            logger.error(`BotService HealthCheck server error: ${error.message}`)
        })

        const port = parseInt(process.env.BOTSERVICE_HEALTHCHECK_HTTP, 10)
        this.healthCheckServer.listen(port, () => {
            logger.info(`BotService HealthCheck server listening on port ${port}`)
        })
    }
}

module.exports = app => new Healthcheck(app)
