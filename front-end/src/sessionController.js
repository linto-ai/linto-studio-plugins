import Session from './session.js'
export default class SessionController {
  constructor () {
    this.sessionDict = {}

    this.loadSessions('active', null)
    this.loadSessions(null, null)
    this.listenInput(true)
    this.listenInput(false)

    this.currentSession = null
    this.currentChannelName = null
    this.currentChannelId = 0
    this.currentChannel = null
    this.lastSessionActive = false

    this.socket = io("ws://localhost:8001")
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

    const response = await fetch(`http://localhost:8000/v1/sessions${appendFilter}`, {
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
          return { "name": channel.name, "language": channel.language, "id": channel.transcriber_id }
        })
      })
    }
    return totalItems
  }

  loadSessions (isActive, searchName) {
    const pageSize = 2
    this.fetchSessions(isActive, searchName, pageSize, 0).then(totalItems => {
      const tuiId = isActive == 'active' ? 'tui-pagination-container-started' : 'tui-pagination-container-stopped'
      const pagination = new tui.Pagination(tuiId, {
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
        if (this.currentSession) {
          this.lastSessionActive = this.currentSession.status == 'active'
        }
        this.currentSession = session
      }
    }
  }

  onSelectChannel (sessionId, channel, sessionActive) {
    console.log(`Session ${sessionId} channel ${channel.id} selected`)
    this.preFillChannel(sessionId)

    if (this.currentChannel && this.lastSessionActive) {
      this.socket.emit('leave_room', this.currentChannel.id)
    }

    this.currentChannel = channel
    if (sessionActive) {
      this.socket.emit('join_room', this.currentChannel.id)
    }

    this.configureExports(sessionId, this.currentChannel.id)
  }

  preFillChannel (sessionId) {
    fetch(`http://localhost:8000/v1/sessions/${sessionId}`, {
      headers: {
          'Accept': 'application/json'
      }})
    .then(response => response.json())
    .then(session => {
      for (const channel of session.channels) {
        if (channel.name != this.currentChannel.name || !channel.closed_captions) {
          continue
        }
        for (const closed_caption of channel.closed_captions) {
          this.currentSession.addFinal(this.currentChannel.name, closed_caption)
        }
      }
    })
  }

  configureExports (sessionId, channelId) {
    for (const type of ['txt', 'doc', 'vtt', 'srt']) {
      const url = `http://localhost:8001/export/${type}?sessionId=${sessionId}&transcriberId=${channelId}`
      document.getElementById(`export-${type}`).href = url
    }
  }
}
