class Reader {
  constructor (text = '') {
    document.getElementById('reader-content-finals').innerText = text
    document.getElementById('clipboard-button').addEventListener('click', (e) => { this.copy() })
    document.getElementById('export-button').addEventListener('mouseover', (e) => {
      this.showExportMenu()
    })
    document.getElementById('export-button').addEventListener('mouseout', (e) => {
      this.hideExportMenu()
    })
    this.resetCopyButton()
  }

  addFinal (text, start, end) {
    const finals = document.getElementById('reader-content-finals')
    finals.innerHTML += `
    <div class="reader-content-final row">
      <div class="reader-content-timestamp column column-10">
          <div class="timestamp-start">${start}</div>
          <div class="timestamp-end">${end}</div>
      </div>
      <div class="reader-content-text column column-90">${text}</div>
    </div>`
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
    document.getElementById('reader-content-finals').innerText = ''
    document.getElementById('reader-content-partial').innerText = ''
  }

  copy () {
    const currentText = document.getElementById('reader-content-finals').textContent + document.getElementById('reader-content-partial').textContent
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
}

const reader = new Reader()
export default reader
