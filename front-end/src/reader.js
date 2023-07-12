class Reader {
  constructor (text = '') {
    document.getElementById('reader-content-text').innerText = text
    document.getElementById('clipboard-button').addEventListener('click', (e) => { this.copy() })
    document.getElementById('export-button').addEventListener('click', (e) => { this.toggleExportMenu() })
    this.resetCopyButton()
  }

  appendText (text) {
    const currentText = document.getElementById('reader-content-text').textContent
    const newText = currentText + text
    document.getElementById('reader-content-text').textContent = newText
  }

  resetPartial () {
    document.getElementById('reader-content-partial').innerText = ''
  }

  appendPartial (text) {
    const currentText = document.getElementById('reader-content-partial').textContent
    const newText = currentText + text
    document.getElementById('reader-content-partial').textContent = newText
  }

  reset () {
    document.getElementById('reader-content-text').innerText = ''
    document.getElementById('reader-content-partial').innerText = ''
  }

  copy () {
    const currentText = document.getElementById('reader-content-text').textContent + document.getElementById('reader-content-partial').textContent
    navigator.clipboard.writeText(currentText).then(
      () => {
        document.querySelector('#clipboard-button > img').src = '/static/check-lg.svg'
        document.querySelector('#clipboard-button > span').innerText = 'Copied'
        setTimeout(this.resetCopyButton, 1500)
        /* clipboard successfully set */
      },
      () => {
        document.querySelector('#clipboard-button > img').src = '/static/x-lg.svg'
        setTimeout(this.resetCopyButton, 1500)
        /* clipboard write failed */
      }
    )
  }

  resetCopyButton () {
    document.querySelector('#clipboard-button > img').src = '/static/clipboard-fill.svg'
    document.querySelector('#clipboard-button > span').innerText = 'Copy content'
  }

  showExportMenu () {
    document.getElementById('export-menu').setAttribute('show', 'true')
  }

  hideExportMenu () {
    document.getElementById('export-menu').removeAttribute('show')
  }

  toggleExportMenu () {
    if (document.getElementById('export-menu').hasAttribute('show')) {
      this.hideExportMenu()
    } else {
      this.showExportMenu()
    }
  }
}

const reader = new Reader()
export default reader
