import Session from './session.js'
export default class SessionController {
  constructor () {
    this.sessionDict = {}
    document.getElementById('export-txt').addEventListener('click', (e) => { this.exportTxt() })
    document.getElementById('export-doc').addEventListener('click', (e) => { this.exportDoc() })
    document.getElementById('export-vtt').addEventListener('click', (e) => { this.exportVtt() })
    document.getElementById('export-srt').addEventListener('click', (e) => { this.exportSrt() })
  }

  addSession ({ id, status, start, end, channels }) {
    this.sessionDict[id] = new Session({ id, status, start, end, channels, onSelected: this.onSelectSession.bind(this), onSelectedChannel: this.onSelectChannel.bind(this) })
  }

  onSelectSession (sessionId) {
    for (const [id, session] of Object.entries(this.sessionDict)) {
      if (id !== sessionId) {
        session.unSelect()
      }
    }
  }

  onSelectChannel (sessionId, channelId) {
    // var socket = io();
    console.log(`Session ${sessionId} channel ${channelId} selected`)
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
