import SessionController from './sessionController.js'

export default class UserSessionController extends SessionController {
  constructor () {
    super()
    const urlParams = new URLSearchParams(window.location.search)
    const sessionId = urlParams.get('sessionId')
    this.fetchSession(sessionId)
  }

  init() {
    // do not load the sessions
  }

  async fetchSession (sessionId) {
    const response = await fetch(`${process.env.SESSION_API_PUBLIC_URL}/v1/sessions/${sessionId}`, {
      headers: {
        'Accept': 'application/json'
      }
    })
    const session = await response.json()
    const sessionUi = this.addSession({
      id: session.id,
      status: session.status,
      name: session.name,
      start: session.start_time,
      end: session.end_time,
      channels: session.channels.map(channel => {
        return { "name": channel.name, "languages": channel.languages, "id": channel.transcriber_id }
      })
    })
    sessionUi.select()
  }
}
