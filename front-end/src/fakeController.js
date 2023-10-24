import SessionController from './sessionController.js'
import { txt1EN, txt1FR, txt2EN, txt2FR, txt3EN, txt3FR } from './text.js'

export default class FakeController extends SessionController {
  constructor () {
    super()


    const channelsPastry = [
      { "name": 'pastryFR', "languages": ['fr'], "id": 'pastry-fr' },
      { "name": 'pastryEN', "languages": ['en'], "id": 'pastry-en' }
    ]

    const channelsJamesWebb = [
      { "name": 'james webbFR', "languages": ['fr'], "id": 'james-webb-fr' },
      { "name": 'james webbEN', "languages": ['en'], "id": 'james-webb-en' }
    ]

    const channelsCuttleFish = [
      { "name": 'cuttleFishFR', "languages": ['fr'], "id": 'cuttleFish-fr' },
      { "name": 'cuttleFishEN', "languages": ['en'], "id": 'cuttleFish-en' }
    ]


    this.addSession({ id: 'pastry', status: 'active', start: '2023-10-12T08:31:03.803Z', end: null, channels: channelsPastry, name: 'Pastry long' })
    this.addSession({ id: 'james webb', status: 'off', start: '2023-09-12T08:31:03.803Z', end: '2023-10-10T08:31:03.803Z', channels: channelsJamesWebb, name: 'James Webb' })
    this.addSession({ id: 'cuttleFish', status: 'off', start: '2023-09-12T08:31:03.803Z', end: '2023-10-10T08:31:03.803Z', channels: channelsCuttleFish, name: 'Cuttle Fish' })

    this.sessionDict['james webb'].addFinal('james webbFR', {text: txt2FR, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')
    this.sessionDict['james webb'].addFinal('james webbEN', {text: txt2EN, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')

    this.sessionDict.cuttleFish.addFinal('cuttleFishFR', {text: txt3FR, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')
    this.sessionDict.cuttleFish.addFinal('cuttleFishEN', {text: txt3EN, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')

    this.sessionDict['pastry'].addFinal('pastryFR', {text: txt1FR, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')
    this.sessionDict['pastry'].addFinal('pastryEN', {text: txt1EN, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')


    //this.contentSession1EN = JSON.parse(JSON.stringify(breakTxt1EN))
    //this.phraseSession1EN = this.contentSession1EN.shift()
    this.timerSession1 = null

    //this.contentSession1FR = JSON.parse(JSON.stringify(breakTxt1FR))
    //this.phraseSession1FR = this.contentSession1FR.shift()

    this.oldSession = null
  }

  onSelectChannel(sessionId, channelId) {
    if(sessionId === 'pastry') {
      this.sessionDict['pastry'].addFinal('pastryFR', {text: txt1FR, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')
      this.sessionDict['pastry'].addFinal('pastryEN', {text: txt1EN, astart: "2023-10-12T08:31:03.803Z", start: "223.10", end: "245.67"}, '')  
    }
  }

  // onSelectChannel (sessionId, channelId) {
  //   if (sessionId === 'pastry' && this.oldSession !== 'pastry') {
  //     this.timerSession1 = setInterval(() => {
  //       if (this.contentSession1EN.length > 0) {
  //         const phrase = this.phraseSession1EN
  //         if (phrase.words.length > 0) {
  //           const word = phrase.words.shift()
  //           this.sessionDict.pastry.addFinal('pastryEN', '', word + ' ')
  //         } else {
  //           this.sessionDict.pastry.resetPartialText('pastryEN')
  //           this.sessionDict.pastry.addFinal('pastryEN', phrase.withPunctuation + '.', '')
  //           this.phraseSession1EN = this.contentSession1EN.shift()
  //         }
  //       }

  //       if (this.contentSession1FR.length > 0) {
  //         const phrase = this.phraseSession1FR
  //         if (phrase.words.length > 0) {
  //           const word = phrase.words.shift()
  //           this.sessionDict.pastry.addFinal('pastryFR', '', word + ' ')
  //         } else {
  //           this.sessionDict.pastry.resetPartialText('pastryFR')
  //           this.sessionDict.pastry.addFinal('pastryFR', phrase.withPunctuation + '.', '')
  //           this.phraseSession1FR = this.contentSession1FR.shift()
  //         }
  //       }
  //     }, 400)
  //     // this.sessionDict["james webb"]
  //   } else {
  //     clearInterval(this.timerSession1EN)
  //   }
  //   this.oldSession = sessionId
  //   // var socket = io();
  //   console.log(`Session ${sessionId} channel ${channelId} selected`)
  // }
}
