/**
 * WebSocket Client
 * Socket.IO client for receiving real-time transcriptions.
 */
class WebSocketClient {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || window.location.origin
    this.socket = null
    this.connected = false
    this.currentRoom = null

    // Event handlers
    this._handlers = {
      connect: [],
      disconnect: [],
      error: [],
      partial: [],
      final: [],
      brokerStatus: [],
      botError: []
    }
  }

  /**
   * Connect to the WebSocket server.
   * @param {string} [authToken] - Optional auth token for authenticated connections
   * @returns {Promise<void>}
   */
  connect(authToken) {
    return new Promise((resolve, reject) => {
      if (this.socket && this.connected) {
        resolve()
        return
      }

      try {
        // Build connection options
        const options = {
          path: '/socket.io',
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: 10,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          timeout: 45000  // Match server connectTimeout
        }

        // Pass auth token if available
        if (authToken) {
          options.auth = { token: authToken }
        }

        // Use Socket.IO client with explicit timeout configuration
        this.socket = io(this.serverUrl, options)

        this.socket.on('connect', () => {
          console.log('[WebSocketClient] Connected to server')
          this.connected = true
          this._emit('connect')
          resolve()
        })

        this.socket.on('disconnect', (reason) => {
          console.log('[WebSocketClient] Disconnected:', reason)
          this.connected = false
          this.currentRoom = null
          this._emit('disconnect', reason)
        })

        this.socket.on('connect_error', (err) => {
          console.error('[WebSocketClient] Connection error:', err)
          this._emit('error', err)
          reject(err)
        })

        // Broker status events
        this.socket.on('broker_ok', () => {
          console.log('[WebSocketClient] Broker connected')
          this._emit('brokerStatus', { connected: true })
        })

        this.socket.on('broker_ko', () => {
          console.log('[WebSocketClient] Broker disconnected')
          this._emit('brokerStatus', { connected: false })
        })

        // Room events
        this.socket.on('joined', (data) => {
          console.log('[WebSocketClient] Joined room:', data.room)
          this.currentRoom = data.room
        })

        this.socket.on('left', (data) => {
          console.log('[WebSocketClient] Left room:', data.room)
          if (this.currentRoom === data.room) {
            this.currentRoom = null
          }
        })

        // Transcription events
        this.socket.on('partial', (data) => {
          this._emit('partial', data)
        })

        this.socket.on('final', (data) => {
          this._emit('final', data)
        })

        this.socket.on('bot_error', (data) => {
          console.warn('[WebSocketClient] Bot error:', data)
          this._emit('botError', data)
        })

        this.socket.on('error', (data) => {
          console.error('[WebSocketClient] Server error:', data)
          this._emit('error', new Error(data.message || 'Unknown error'))
        })

      } catch (err) {
        console.error('[WebSocketClient] Failed to connect:', err)
        reject(err)
      }
    })
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect() {
    if (this.socket) {
      if (this.currentRoom) {
        this.leaveRoom()
      }
      this.socket.disconnect()
      this.socket = null
      this.connected = false
      this.currentRoom = null
    }
  }

  /**
   * Join a transcription room.
   * @param {string} sessionId
   * @param {string} channelId
   */
  joinRoom(sessionId, channelId) {
    if (!this.socket || !this.connected) {
      console.error('[WebSocketClient] Cannot join room: not connected')
      return
    }

    // Leave current room first
    if (this.currentRoom) {
      this.leaveRoom()
    }

    console.log('[WebSocketClient] Joining room:', sessionId, channelId)
    this.socket.emit('join_room', { sessionId, channelId })
  }

  /**
   * Leave the current transcription room.
   */
  leaveRoom() {
    if (!this.socket || !this.currentRoom) return

    const [sessionId, channelId] = this.currentRoom.split('/')
    console.log('[WebSocketClient] Leaving room:', sessionId, channelId)
    this.socket.emit('leave_room', { sessionId, channelId })
    this.currentRoom = null
  }

  /**
   * Register an event handler.
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event].push(handler)
    }
  }

  /**
   * Remove an event handler.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter(h => h !== handler)
    }
  }

  /**
   * Emit an event to registered handlers.
   * @param {string} event
   * @param {*} data
   */
  _emit(event, data) {
    if (this._handlers[event]) {
      this._handlers[event].forEach(handler => {
        try {
          handler(data)
        } catch (err) {
          console.error(`[WebSocketClient] Error in ${event} handler:`, err)
        }
      })
    }
  }

  /**
   * Check if connected to the server.
   * @returns {boolean}
   */
  isConnected() {
    return this.connected
  }

  /**
   * Get the current room.
   * @returns {string|null}
   */
  getCurrentRoom() {
    return this.currentRoom
  }
}

// Export for use
window.WebSocketClient = WebSocketClient
