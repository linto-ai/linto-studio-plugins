export class Scroller {
  constructor () {
    document.getElementById('scroller').scroll(0, 1000)
  }

  appendText (text) {
    const currentText = document.getElementById('transcription-text').textContent
    const newText = currentText + text
    document.getElementById('transcription-text').textContent = newText
    this.forceScroll(0)
  }

  appendPartial (text) {
    const currentText = document.getElementById('transcription-partial').textContent
    const newText = currentText + text
    document.getElementById('transcription-partial').textContent = newText
    this.forceScroll(0)
  }

  resetPartial () {
    document.getElementById('transcription-partial').innerHTML = ''
  }

  forceScroll (time) {
    setTimeout(() => {
      document.getElementById('scroller').scroll(0, document.getElementById('scroller').scrollHeight)
    }, time)
  }

  resetText () {
    document.getElementById('transcription-text').innerHTML = ''
    document.getElementById('transcription-partial').innerHTML = ''
  }

  reset () {
    this.resetPartial()
    this.resetText()
  }
}

const scroller = new Scroller()
export default scroller
