import SessionController from './sessionController.js'
import { breakTxt1EN, breakTxt1FR, txt2EN, txt2FR, txt3EN, txt3FR } from './text.js'

export default class FakeController extends SessionController {
  constructor () {
    super()

    this.addSession({ id: 'pastry', status: 'on', start: '10:08:00', end: '00:00:00', channels: ['en', 'fr'] })
    this.addSession({ id: 'james webb', status: 'off', start: '10:00:00', end: '10:06:25', channels: ['en', 'fr'] })
    this.addSession({ id: 'cuttleFish', status: 'off', start: '08:52:10', end: '09:15:03', channels: ['en', 'fr'] })

    this.sessionDict['james webb'].addText('fr', txt2FR, '')
    this.sessionDict['james webb'].addText('en', txt2EN, '')

    this.sessionDict.cuttleFish.addText('fr', txt3FR, '')
    this.sessionDict.cuttleFish.addText('en', txt3EN, '')

    this.contentSession1EN = JSON.parse(JSON.stringify(breakTxt1EN))
    this.phraseSession1EN = this.contentSession1EN.shift()
    this.timerSession1 = null

    this.contentSession1FR = JSON.parse(JSON.stringify(breakTxt1FR))
    this.phraseSession1FR = this.contentSession1FR.shift()

    this.oldSession = null
  }

  onSelectChannel (sessionId, channelId) {
    if (sessionId === 'pastry' && this.oldSession !== 'pastry') {
      this.timerSession1 = setInterval(() => {
        if (this.contentSession1EN.length > 0) {
          const phrase = this.phraseSession1EN
          if (phrase.words.length > 0) {
            const word = phrase.words.shift()
            this.sessionDict.pastry.addText('en', '', word + ' ')
          } else {
            this.sessionDict.pastry.resetPartialText('en')
            this.sessionDict.pastry.addText('en', phrase.withPunctuation + '.', '')
            this.phraseSession1EN = this.contentSession1EN.shift()
          }
        }

        if (this.contentSession1FR.length > 0) {
          const phrase = this.phraseSession1FR
          if (phrase.words.length > 0) {
            const word = phrase.words.shift()
            this.sessionDict.pastry.addText('fr', '', word + ' ')
          } else {
            this.sessionDict.pastry.resetPartialText('fr')
            this.sessionDict.pastry.addText('fr', phrase.withPunctuation + '.', '')
            this.phraseSession1FR = this.contentSession1FR.shift()
          }
        }
      }, 400)
      // this.sessionDict["james webb"]
    } else {
      clearInterval(this.timerSession1EN)
    }
    this.oldSession = sessionId
    // var socket = io();
    console.log(`Session ${sessionId} channel ${channelId} selected`)
  }
}
