const { Server } = require('socket.io')
const { Component, logger } = require('live-srt-lib')

/**
 * WebSocketServer Component
 * Socket.IO server for real-time transcription streaming to Teams app clients.
 */
class WebSocketServer extends Component {
  static states = {
    WAITING: 'waiting',
    READY: 'ready',
    ERROR: 'error'
  }

  constructor(app) {
    super(app)
    this.id = this.constructor.name
    this.state = WebSocketServer.states.WAITING

    // Wait for WebServer to be ready
    const webServer = app.components['WebServer']
    if (!webServer) {
      logger.error('[TeamsAppService] WebSocketServer requires WebServer component')
      this.state = WebSocketServer.states.ERROR
      return
    }

    // Track clients per room
    this._roomClients = new Map() // room -> Set of socket IDs

    // Initialize Socket.IO when WebServer is ready
    const initSocketIO = () => {
      const server = webServer.getServer()
      if (!server) {
        logger.error('[TeamsAppService] WebServer HTTP server not available')
        this.state = WebSocketServer.states.ERROR
        return
      }

      this.io = new Server(server, {
        path: '/socket.io',
        cors: {
          origin: '*',
          methods: ['GET', 'POST']
        },
        // Explicit timeout configuration to prevent premature disconnections
        pingInterval: 25000,  // Send ping every 25 seconds
        pingTimeout: 60000,   // Wait 60 seconds for pong before disconnecting
        connectTimeout: 45000 // Allow 45 seconds for initial connection
      })

      this._setupEventHandlers()
      this.state = WebSocketServer.states.READY
      logger.info('[TeamsAppService] WebSocketServer initialized')
      this.emit('ready')
    }

    if (webServer.state === 'ready') {
      initSocketIO()
    } else {
      webServer.once('ready', initSocketIO)
    }

    this.init()
  }

  /**
   * Setup Socket.IO event handlers.
   */
  _setupEventHandlers() {
    this.io.on('connection', (socket) => {
      logger.info(`[TeamsAppService] Client connected: ${socket.id}`)

      const brokerClient = this.app.components['BrokerClient']

      // Send broker status on connect
      socket.emit(brokerClient?.state === 'ready' ? 'broker_ok' : 'broker_ko')

      // Handle join_room - client wants to receive transcriptions for a session/channel
      socket.on('join_room', async (data) => {
        try {
          const { sessionId, channelId } = data
          if (!sessionId || !channelId) {
            socket.emit('error', { message: 'Missing sessionId or channelId' })
            return
          }

          const room = `${sessionId}/${channelId}`
          socket.join(room)

          // Track room membership
          if (!this._roomClients.has(room)) {
            this._roomClients.set(room, new Set())
          }
          this._roomClients.get(room).add(socket.id)

          // Subscribe to transcriptions on MQTT
          if (brokerClient) {
            await brokerClient.subscribeToTranscriptions(sessionId, channelId)
          }

          logger.info(`[TeamsAppService] Client ${socket.id} joined room ${room}`)
          socket.emit('joined', { room, sessionId, channelId })
        } catch (err) {
          logger.error(`[TeamsAppService] Error joining room:`, err)
          socket.emit('error', { message: 'Failed to join room' })
        }
      })

      // Handle leave_room
      socket.on('leave_room', async (data) => {
        try {
          const { sessionId, channelId } = data
          if (!sessionId || !channelId) return

          const room = `${sessionId}/${channelId}`
          socket.leave(room)

          // Update room membership
          const clients = this._roomClients.get(room)
          if (clients) {
            clients.delete(socket.id)
            if (clients.size === 0) {
              this._roomClients.delete(room)
            }
          }

          // Unsubscribe from transcriptions on MQTT
          if (brokerClient) {
            await brokerClient.unsubscribeFromTranscriptions(sessionId, channelId)
          }

          logger.info(`[TeamsAppService] Client ${socket.id} left room ${room}`)
          socket.emit('left', { room, sessionId, channelId })
        } catch (err) {
          logger.error(`[TeamsAppService] Error leaving room:`, err)
        }
      })

      // Handle disconnect
      socket.on('disconnect', async () => {
        logger.info(`[TeamsAppService] Client disconnected: ${socket.id}`)

        // Clean up room memberships and unsubscribe if needed
        for (const [room, clients] of this._roomClients.entries()) {
          if (clients.has(socket.id)) {
            clients.delete(socket.id)

            if (clients.size === 0) {
              this._roomClients.delete(room)

              // Unsubscribe from MQTT
              const [sessionId, channelId] = room.split('/')
              if (brokerClient && sessionId && channelId) {
                await brokerClient.unsubscribeFromTranscriptions(sessionId, channelId)
              }
            }
          }
        }
      })
    })
  }

  /**
   * Broadcast transcription to a room.
   * @param {string} sessionId
   * @param {string} channelId
   * @param {string} type - 'partial' or 'final'
   * @param {Object} data - Transcription data
   */
  broadcastTranscription(sessionId, channelId, type, data) {
    const room = `${sessionId}/${channelId}`
    this.io.to(room).emit(type, data)
  }

  /**
   * Get total connected client count.
   * @returns {number}
   */
  getClientCount() {
    return this.io?.sockets?.sockets?.size || 0
  }

  /**
   * Get client count for a specific room.
   * @param {string} room
   * @returns {number}
   */
  getRoomClientCount(room) {
    return this._roomClients.get(room)?.size || 0
  }
}

module.exports = app => new WebSocketServer(app)
