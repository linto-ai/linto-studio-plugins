class Reader {
  constructor (text = '') {
    const finals = document.getElementById('reader-content-finals')
    finals.innerText = text
    document.getElementById('clipboard-button').addEventListener('click', (e) => { this.copy() })
    document.getElementById('export-button').addEventListener('mouseover', (e) => {
      this.showExportMenu()
    })
    document.getElementById('export-button').addEventListener('mouseout', (e) => {
      this.hideExportMenu()
    })
    this.resetCopyButton()

    const sessionLinkButton = document.getElementById('session-link-button')
    if (sessionLinkButton) {
      sessionLinkButton.addEventListener('click', (e) => { this.copySessionLink() })
      this.resetCopySessionLinkButton()
    }
  }

  finalTemplate(text, start, lang, locutor) {
    return `<div class="reader-content-final row">
      <div class="reader-content-timestamp column column-10">
          <div>${start}</div>
          <div>${lang}</div>
          <div>${locutor}</div>
      </div>
      <div class="reader-content-text column column-90">${text}</div>
    </div>`
  }

  addFinal (text, start, lang, locutor) {
    const finals = document.getElementById('reader-content-finals')
    finals.innerHTML += this.finalTemplate(text, start, lang, locutor)
    finals.scrollTop = finals.scrollHeight
  }

  addFinalBulk (f) {
    const finals = document.getElementById('reader-content-finals')
    finals.innerHTML = f(this.finalTemplate)
    finals.scrollTop = finals.scrollHeight // scroll to bottom
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

  copySessionLink () {
    const sessionLinkButton = document.getElementById('session-link-button')
    const sessionId = sessionLinkButton.dataset.sessionid

    if (!sessionId) {
      alert("Please select a session before copying the link.")
      return
    }

    const userPath = window.location.href.substring(0, window.location.href.lastIndexOf('/'))
    const sessionLink = `${userPath}/user.html?sessionId=${sessionId}`

    console.log(`Generated link to session: ${sessionLink}`)
    if (!window.isSecureContext) {
      alert("Can't copy to clipboard in an unsecure context, please use HTTPS.")
      return
    }

    navigator.clipboard.writeText(sessionLink).then(
      () => {
        document.querySelector('#session-link-button > span').innerText = 'Copied'
        setTimeout(this.resetCopySessionLinkButton, 1500)
        /* clipboard successfully set */
      },
      () => {
        setTimeout(this.resetCopySessionLinkButton, 1500)
        /* clipboard write failed */
      }
    )
  }

  copy () {
    const currentText = document.getElementById('reader-content-finals').textContent + document.getElementById('reader-content-partial').textContent
    navigator.clipboard.writeText(currentText).then(
      () => {
        document.querySelector('#clipboard-button > span').innerText = 'Copied'
        setTimeout(this.resetCopyButton, 1500)
        /* clipboard successfully set */
      },
      () => {
        setTimeout(this.resetCopyButton, 1500)
        /* clipboard write failed */
      }
    )
  }

  resetCopyButton () {
    document.querySelector('#clipboard-button > span').innerText = 'Copy content'
  }

  resetCopySessionLinkButton () {
    document.querySelector('#session-link-button > span').innerText = 'Copy session link'
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
