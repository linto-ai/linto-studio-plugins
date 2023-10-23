import Session from './session.js'
import io from 'socket.io-client'
import Pagination from 'tui-pagination'

export default class SessionController {
  constructor () {
    this.sessionDict = {}

    this.init()

    this.currentSession = null
    this.currentChannelName = null
    this.currentChannelId = 0
    this.currentChannel = null

    const socketioUrl = process.env.DELIVERY_WS_PUBLIC_URL
    const socketioBasePath = process.env.DELIVERY_WS_BASE_PATH || ''

    const checkUrl = new URL(socketioUrl)
    if (!checkUrl.protocol.startsWith('ws')) {
      console.error(`socketio url should start with ws or wss. Current: ${socketioUrl}`)
    }
    if (checkUrl.pathname != '/') {
      console.error(`socketio url should not have a path (it will be a socketio namespace). Current: ${socketioUrl}`)
    }

    this.socket = io(socketioUrl, {path: `${socketioBasePath}/socket.io`})
    this.socket.on('connect', () => {
      console.log('connected to socket.io server')

      this.socket.on('partial', (msg) => {
        if (this.currentSession && this.currentChannel) {
          this.currentSession.resetPartialText(this.currentChannel.name)
          this.currentSession.addPartialText(this.currentChannel.name, msg)
        }
      })

      this.socket.on('final', (final) => {
        if (this.currentSession && this.currentChannel.name) {
          this.currentSession.resetPartialText(this.currentChannel.name)
          this.currentSession.addFinal(this.currentChannel.name, final)
        }
      })

      this.socket.on('broker_ko', () => {
        const appState = document.querySelector('#app-state')
        appState.classList.remove('app-state-ok')
        appState.classList.add('app-state-ko')
      })

      this.socket.on('broker_ok', () => {
        const appState = document.getElementById('app-state')
        appState.classList.remove('app-state-ko')
        appState.classList.add('app-state-ok')
      })
    })
  }

  init() {
    this.loadSessions('active', null)
    this.loadSessions(null, null)
    this.listenInput(true)
    this.listenInput(false)
  }

  listenInput(isActive) {
    const wait = 200
    let timer;
    const inputId = isActive ? 'session-list-started-search' : 'session-list-stopped-search'
    const inputElement = document.getElementById(inputId)

    inputElement.addEventListener("keyup", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.loadSessions(isActive, inputElement.value)
      }, wait)
    })
  }

  async fetchSessions (isActive, searchName, limit, offset) {
    var filters = []
    if (isActive) {
      filters.push(`isActive=yes`)
    }
    else {
      filters.push(`isActive=no`)
    }
    if (searchName) {
      filters.push(`searchName=${searchName}`)
    }
    if (limit) {
      filters.push(`limit=${limit}`)
    }
    if (offset) {
      filters.push(`offset=${offset}`)
    }

    var appendFilter = ''
    if (filters.length > 0) {
      appendFilter = '?' + filters.join('&')
    }

    const response = await fetch(`${process.env.SESSION_API_PUBLIC_URL}/v1/sessions${appendFilter}`, {
      headers: {
        'Accept': 'application/json'
      }
    })
    const {sessions, totalItems} = await response.json()
    this.removeSessions(isActive)
    for (const session of sessions) {
      this.addSession({
        id: session.id,
        status: session.status,
        name: session.name,
        start: session.start_time,
        end: session.end_time,
        channels: session.channels.map(channel => {
          return { "name": channel.name, "languages": channel.languages, "id": channel.transcriber_id }
        })
      })
    }
    return totalItems
  }

  loadSessions (isActive, searchName) {
    const pageSize = 10
    this.fetchSessions(isActive, searchName, pageSize, 0).then(totalItems => {
      const tuiId = isActive == 'active' ? 'tui-pagination-container-started' : 'tui-pagination-container-stopped'
      const pagination = new Pagination(tuiId, {
        usageStatistics: false,
        totalItems: totalItems,
        itemsPerPage: pageSize,
        visiblePages: 3,
        centerAlign: true
      })

      pagination.on('afterMove', (event) => {
        const currentPage = event.page
        this.fetchSessions(isActive, searchName, pageSize, (currentPage-1) * pageSize)
      })
    })
  }

  removeSessions (isActive) {
    for (const sessionId in this.sessionDict) {
      if (isActive && this.sessionDict[sessionId].status == 'active' || !isActive && this.sessionDict[sessionId].status != 'active') {
        this.sessionDict[sessionId].removeSessionFromList()
        delete this.sessionDict[sessionId]
      }
    }
  }

  addSession ({ id, status, name, start, end, channels }) {
    let session = new Session({
      id, status, name, start, end, channels,
      onSelected: this.onSelectSession.bind(this),
      onSelectedChannel: this.onSelectChannel.bind(this)
    })
    this.sessionDict[id] = session
    return session
  }

  onSelectSession (sessionId) {
    for (const [id, session] of Object.entries(this.sessionDict)) {
      if (id !== sessionId) {
        session.unSelect()
      }
      else {
        this.currentSession = session
        const sessionLinkButton = document.getElementById('session-link-button')
        if (sessionLinkButton) {
          sessionLinkButton.dataset.sessionid = session.id
        }
      }
    }
  }

  onSelectChannel (sessionId, channel, sessionActive) {
    console.log(`Session ${sessionId} channel ${channel.id} selected`)
    this.preFillChannel(sessionId)

    if (this.currentChannel) {
      console.log(`Leaving room ${this.currentChannel.id}`)
      this.socket.emit('leave_room', this.currentChannel.id)
    }

    this.currentChannel = channel
    if (sessionActive) {
      console.log(`Joining room ${this.currentChannel.id}`)
      this.socket.emit('join_room', this.currentChannel.id)
    }

    this.configureExports(sessionId, this.currentChannel.id)
  }

  preFillChannel (sessionId) {
    fetch(`${process.env.SESSION_API_PUBLIC_URL}/v1/sessions/${sessionId}`, {
      headers: {
          'Accept': 'application/json'
      }})
    .then(response => response.json())
    .then(session => {
      for (const channel of session.channels) {
        if (channel.name != this.currentChannel.name || !channel.closed_captions) {
          continue
        }
        this.currentSession.addFinalBulk(channel)
      }
    })
  }

  configureExports (sessionId, channelId) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    for (const type of ['txt', 'doc', 'vtt', 'srt']) {
      const url = `${process.env.DELIVERY_PUBLIC_URL}/export/${type}?sessionId=${sessionId}&transcriberId=${channelId}&timezone=${encodeURIComponent(timezone)}`
      document.getElementById(`export-${type}`).href = url
    }
  }
}
