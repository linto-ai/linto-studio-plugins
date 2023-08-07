import Session from './session.js'
export default class SessionController {
  constructor () {
    this.sessionDict = {}
    document.getElementById('export-txt').addEventListener('click', (e) => { this.exportTxt() })
    document.getElementById('export-doc').addEventListener('click', (e) => { this.exportDoc() })
    document.getElementById('export-vtt').addEventListener('click', (e) => { this.exportVtt() })
    document.getElementById('export-srt').addEventListener('click', (e) => { this.exportSrt() })

    fetch('http://localhost:8000/v1/sessions', {
      headers: {
          'Accept': 'application/json'
      }})
    .then(response => response.json())
    .then(sessions => {
      for (const session of sessions) {
        this.addSession({
          id: session.id,
          status: session.status,
          name: session.name,
          start: session.start_time,
          end: session.end_time,
          channels: session.channels.map(channel => {
            return { "name": channel.name, "room_uuid": channel.transcriber_id }
          })
        })
      }
    })

    this.currentSession = null
    this.currentChannel = null
    this.socket = io("ws://localhost:8001")
    this.socket.on('connect', () => {
      console.log('connected to socket.io server')

      this.socket.on('partial', (msg) => {
        if (this.currentSession && this.currentChannel) {
          this.currentSession.resetPartialText(this.currentChannel)
          this.currentSession.addPartialText(this.currentChannel, msg)
        }
      })

      this.socket.on('final', (msg) => {
        if (this.currentSession && this.currentChannel) {
          this.currentSession.addText(this.currentChannel, msg)
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
    this.lastChannelId = 0
  }

  addSession ({ id, status, name, start, end, channels }) {
    this.sessionDict[id] = new Session({
      id, status, name, start, end, channels,
      onSelected: this.onSelectSession.bind(this),
      onSelectedChannel: this.onSelectChannel.bind(this)
    })
  }

  onSelectSession (sessionId) {
    for (const [id, session] of Object.entries(this.sessionDict)) {
      if (id !== sessionId) {
        session.unSelect()
      }
      else {
        this.currentSession = session
      }
    }
  }

  onSelectChannel (sessionId, channelName, channelId) {
    if (this.lastChannelId) {
      this.socket.emit('leave_room', this.lastChannelId)
    }
    this.socket.emit('join_room', channelId)
    this.lastChannelId = channelId
    this.currentChannel = channelName
    this.preFillChannel(sessionId)
    console.log(`Session ${sessionId} channel ${channelId} selected`)
  }

  preFillChannel (sessionId) {
    fetch(`http://localhost:8000/v1/sessions/${sessionId}`, {
      headers: {
          'Accept': 'application/json'
      }})
    .then(response => response.json())
    .then(session => {
      for (const channel of session.channels) {
        if (channel.name != this.currentChannel || !channel.closed_captions) {
          continue
        }
        for (const closed_caption of channel.closed_captions) {
          this.currentSession.addText(this.currentChannel, closed_caption.text)
        }
      }
    })
  }

  exportTxt () {
    console.log('Export TXT')
  }

  exportDoc () {
    console.log('Export DOC')
  }

  exportVtt () {
    console.log('Export VTT')
  }

  exportSrt () {
    console.log('Export SRT')
  }
}
