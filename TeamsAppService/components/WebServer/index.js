const express = require('express')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { Component, logger } = require('live-srt-lib')

/**
 * WebServer Component
 * Express server for serving static files and REST API.
 */
class WebServer extends Component {
  static states = {
    STARTING: 'starting',
    READY: 'ready',
    ERROR: 'error'
  }

  constructor(app) {
    super(app)
    this.id = this.constructor.name
    this.state = WebServer.states.STARTING

    this.port = parseInt(process.env.TEAMSAPPSERVICE_HTTPS_PORT || '443')
    this.express = express()

    // Load SSL certificates
    const certsDir = process.env.TEAMSAPPSERVICE_CERTS_DIR || path.join(__dirname, '../../certs')
    this.sslOptions = {
      key: fs.readFileSync(path.join(certsDir, 'key.pem')),
      cert: fs.readFileSync(path.join(certsDir, 'cert.pem'))
    }

    // Middleware
    this.express.use(express.json())
    this.express.use(express.urlencoded({ extended: true }))

    // Request logging middleware
    this.express.use((req, res, next) => {
      logger.info(`[WebServer] ${req.method} ${req.url} - ${req.ip}`)
      next()
    })

    // CORS middleware for Teams app
    this.express.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200)
      }
      next()
    })

    // Static files for Teams app
    const publicPath = path.join(__dirname, 'public')
    this.express.use(express.static(publicPath))

    // Load routes
    this._loadRoutes()

    // Health check
    this.express.get('/healthcheck', (req, res) => {
      const brokerClient = this.app.components['BrokerClient']
      const meetingRegistry = this.app.components['MeetingRegistry']

      res.json({
        status: 'ok',
        service: 'teamsappservice',
        timestamp: new Date().toISOString(),
        broker: brokerClient?.state || 'unknown',
        activeMeetings: meetingRegistry?.getMeetingCount() || 0
      })
    })

    // Start HTTPS server
    this.server = https.createServer(this.sslOptions, this.express).listen(this.port, () => {
      this.state = WebServer.states.READY
      logger.info(`[TeamsAppService] WebServer (HTTPS) listening on port ${this.port}`)
      this.emit('ready')
    })

    this.server.on('error', (err) => {
      this.state = WebServer.states.ERROR
      logger.error(`[TeamsAppService] WebServer error:`, err)
      this.emit('error', err)
    })

    this.init()
  }

  /**
   * Load API routes.
   */
  _loadRoutes() {
    const apiRoutes = require('./routes/api')(this.app)
    this.express.use('/v1', apiRoutes)

    const manifestRoutes = require('./routes/manifest')(this)
    this.express.use('/manifest', manifestRoutes)
  }

  /**
   * Get the HTTP server instance (used by WebSocketServer).
   * @returns {http.Server}
   */
  getServer() {
    return this.server
  }
}

module.exports = app => new WebServer(app)
