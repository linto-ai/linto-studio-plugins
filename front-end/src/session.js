import scroller from './scroller.js'
import reader from './reader.js'

export default class Session {
  constructor ({ id, status, name, start, end, channels, onSelected, onSelectedChannel }) {
    this.id = id
    this.status = status // "on" or "off"
    this.name = name
    this.start = start
    this.end = end
    this.channels = channels
    this.selected = false
    this.onSelectedCallback = onSelected
    this._onSelectedChannelCallback = onSelectedChannel

    this.channelsText = {}
    for (const channel of this.channels) {
      this.channelsText[channel.name] = { text: '', partialText: '' }
    }

    this.currentChannel = this.channels[0]

    this.appendSessionToList()
    // this.updateSessionStatus('off')
  }

  displaySessionList (sessionList) {
    for (const session of sessionList) {
      this.appendSessionToList(session)
    }
  }

  onSelectedChannelCallback (sessionId, channelName, channelId) {
    this.selectChannel(channelName)
    this._onSelectedChannelCallback(sessionId, channelName, channelId)
  }

  unSelect () {
    this.selected = false
    document.getElementById(`session-${this.id}`).removeAttribute('selected')
  }

  select () {
    this.selected = true
    document.getElementById(`session-${this.id}`).setAttribute('selected', 'true')
    this.displayChannels()
    this.onSelectedChannelCallback(this.id, this.channels[0].name, this.channels[0].room_uuid)

    if (this.onSelectedCallback) { this.onSelectedCallback(this.id) }
  }

  appendSessionToList () {
    const self = this

    let listDom
    if (this.status === 'active') {
      listDom = document.querySelector('#session-list-started > ul')
    } else {
      listDom = document.querySelector('#session-list-stopped > ul')
    }

    const sessionHtmlElement = document.createElement('li')
    sessionHtmlElement.classList.add('session-line')
    sessionHtmlElement.id = `session-${this.id}`
    sessionHtmlElement.setAttribute('status', this.status)
    sessionHtmlElement.addEventListener('click', (e) => { self.select() })

    const sessionHtmlElementStatus = document.createElement('div')
    sessionHtmlElementStatus.classList.add('session-status')

    const sessionHtmlElementName = document.createElement('div')
    sessionHtmlElementName.classList.add('session-name')
    sessionHtmlElementName.innerText = this.name

    const sessionHtmlElementStart = document.createElement('div')
    sessionHtmlElementStart.classList.add('session-start')
    sessionHtmlElementStart.innerText = this.start

    const sessionHtmlElementEnd = document.createElement('div')
    sessionHtmlElementEnd.classList.add('session-end')
    sessionHtmlElementEnd.innerText = this.end

    sessionHtmlElement.appendChild(sessionHtmlElementStatus)
    sessionHtmlElement.appendChild(sessionHtmlElementName)
    sessionHtmlElement.appendChild(sessionHtmlElementStart)
    sessionHtmlElement.appendChild(sessionHtmlElementEnd)

    listDom.prepend(sessionHtmlElement)
  }

  displayChannels () {
    const channelList = document.getElementById('channel-selector')
    channelList.onchange = null
    channelList.onchange = (e) => {
      for (const option of e.target) {
        if (option.value == e.target.value) {
          this.onSelectedChannelCallback(this.id, option.value, option.dataset.room_uuid)
          break
        }
      }
    }

    channelList.innerHTML = ''
    for (const channel of this.channels) {
      const channelHtmlElement = document.createElement('option')
      channelHtmlElement.dataset.room_uuid = channel.room_uuid
      channelHtmlElement.value = channel.name
      channelHtmlElement.innerText = `Session ${this.id} channel ${channel.name}`
      channelList.appendChild(channelHtmlElement)
    }
  }

  updateChannels (channels) {
    this.channels = channels
    this.displayChannels()
    this.onSelectedChannelCallback(this.id, this.channels[0].name, this.channels[0].room_uuid)
  }

  updateSessionStatus (status) {
    this.status = status

    const domElement = document.getElementById(`session-${this.id}`)
    domElement.setAttribute('status', status)
    let listDom
    if (this.status === 'on') {
      listDom = document.querySelector('#session-list-started > ul')
    } else {
      listDom = document.querySelector('#session-list-stopped > ul')
    }

    listDom.prepend(domElement)
  }

  addText (channel, text) {
    this.channelsText[channel].text += text
    if (channel === this.currentChannel && this.selected) {
      scroller.appendText(text)
      reader.appendText(text)
    }
  }

  addPartialText (channel, partialText) {
    this.channelsText[channel].partialText += partialText
    if (channel === this.currentChannel && this.selected) {
      scroller.appendPartial(partialText)
      reader.appendPartial(partialText)
    }
  }

  selectChannel (channel) {
    this.currentChannel = channel
    scroller.reset()
    reader.reset()
  }

  resetText (channel) {
    this.channelsText[channel].text = ''
    if (channel === this.currentChannel && this.selected) {
      scroller.resetText()
      reader.resetPartial()
    }
  }

  resetPartialText (channel) {
    this.channelsText[channel].partialText = ''
    if (channel === this.currentChannel && this.selected) {
      scroller.resetPartial()
      reader.resetPartial()
    }
  }
}
