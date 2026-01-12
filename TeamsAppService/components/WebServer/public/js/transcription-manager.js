/**
 * Transcription Manager
 * Manages transcription state and rendering in the UI.
 */
class TranscriptionManager {
  constructor(options = {}) {
    this.container = options.container || document.getElementById('transcription-container')
    this.maxEntries = options.maxEntries || 100
    this.autoScroll = options.autoScroll !== false
    this.fontSize = options.fontSize || 'md'

    // Store transcriptions
    this.transcriptions = []
    this.currentPartial = null

    // Track selected language (for translations)
    this.selectedLanguage = options.selectedLanguage || null
  }

  /**
   * Add a partial transcription.
   * @param {Object} data - Transcription data
   */
  addPartial(data) {
    // Update or create partial entry
    const entryId = `partial-${data.speakerId || 'unknown'}`

    // Remove existing partial for this speaker
    this._removeEntry(entryId)

    // Add new partial
    this.currentPartial = {
      id: entryId,
      type: 'partial',
      speakerId: data.speakerId || 'Speaker',
      text: this._getText(data),
      timestamp: new Date(),
      data: data
    }

    this._renderEntry(this.currentPartial)

    if (this.autoScroll) {
      this._scrollToBottom()
    }
  }

  /**
   * Add a final transcription.
   * @param {Object} data - Transcription data
   */
  addFinal(data) {
    // Remove current partial if it's from the same speaker
    if (this.currentPartial) {
      this._removeEntry(this.currentPartial.id)
      this.currentPartial = null
    }

    // Create final entry
    const entry = {
      id: `final-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'final',
      speakerId: data.speakerId || 'Speaker',
      text: this._getText(data),
      timestamp: new Date(),
      data: data
    }

    this.transcriptions.push(entry)

    // Limit entries
    if (this.transcriptions.length > this.maxEntries) {
      const removed = this.transcriptions.shift()
      this._removeEntry(removed.id)
    }

    this._renderEntry(entry)

    if (this.autoScroll) {
      this._scrollToBottom()
    }
  }

  /**
   * Get text based on selected language.
   * @param {Object} data - Transcription data
   * @returns {string}
   */
  _getText(data) {
    // If a translation language is selected and available
    if (this.selectedLanguage && data.translations) {
      const translation = data.translations.find(t => t.language === this.selectedLanguage)
      if (translation) {
        return translation.text
      }
    }

    // Return original text
    return data.text || ''
  }

  /**
   * Set the selected language for display.
   * @param {string|null} language
   */
  setSelectedLanguage(language) {
    this.selectedLanguage = language
    this._reRenderAll()
  }

  /**
   * Set font size.
   * @param {string} size - 'sm', 'md', or 'lg'
   */
  setFontSize(size) {
    this.fontSize = size
    const sizeMap = { sm: '12px', md: '14px', lg: '18px' }
    this.container.style.fontSize = sizeMap[size] || '14px'
  }

  /**
   * Toggle auto-scroll.
   * @param {boolean} enabled
   */
  setAutoScroll(enabled) {
    this.autoScroll = enabled
    if (enabled) {
      this._scrollToBottom()
    }
  }

  /**
   * Clear all transcriptions.
   */
  clear() {
    this.transcriptions = []
    this.currentPartial = null
    this.container.innerHTML = ''
    this._showEmptyState()
  }

  /**
   * Render a transcription entry.
   * @param {Object} entry
   */
  _renderEntry(entry) {
    // Remove empty state if present
    const emptyState = this.container.querySelector('.empty-state')
    if (emptyState) {
      emptyState.remove()
    }

    const entryEl = document.createElement('div')
    entryEl.id = entry.id
    entryEl.className = `transcription-entry ${entry.type}`

    const headerEl = document.createElement('div')
    headerEl.className = 'transcription-header'

    const speakerEl = document.createElement('span')
    speakerEl.className = 'speaker-id'
    speakerEl.textContent = entry.speakerId

    const timestampEl = document.createElement('span')
    timestampEl.className = 'timestamp'
    timestampEl.textContent = this._formatTime(entry.timestamp)

    headerEl.appendChild(speakerEl)
    headerEl.appendChild(timestampEl)

    const textEl = document.createElement('div')
    textEl.className = 'transcription-text'
    textEl.textContent = entry.text

    entryEl.appendChild(headerEl)
    entryEl.appendChild(textEl)

    this.container.appendChild(entryEl)
  }

  /**
   * Remove an entry by ID.
   * @param {string} id
   */
  _removeEntry(id) {
    const el = document.getElementById(id)
    if (el) {
      el.remove()
    }
  }

  /**
   * Re-render all entries (used when language changes).
   */
  _reRenderAll() {
    this.container.innerHTML = ''

    if (this.transcriptions.length === 0 && !this.currentPartial) {
      this._showEmptyState()
      return
    }

    this.transcriptions.forEach(entry => {
      entry.text = this._getText(entry.data)
      this._renderEntry(entry)
    })

    if (this.currentPartial) {
      this.currentPartial.text = this._getText(this.currentPartial.data)
      this._renderEntry(this.currentPartial)
    }

    if (this.autoScroll) {
      this._scrollToBottom()
    }
  }

  /**
   * Format timestamp.
   * @param {Date} date
   * @returns {string}
   */
  _formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  /**
   * Scroll container to bottom.
   */
  _scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight
  }

  /**
   * Show empty state.
   */
  _showEmptyState() {
    const emptyState = document.createElement('div')
    emptyState.className = 'empty-state'
    emptyState.innerHTML = `
      <div class="empty-state-icon">&#128172;</div>
      <div class="empty-state-title">No transcriptions yet</div>
      <div class="empty-state-text">Transcriptions will appear here when the meeting starts</div>
    `
    this.container.appendChild(emptyState)
  }

  /**
   * Show loading state.
   */
  showLoading() {
    this.container.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <div class="loading-text">Connecting...</div>
      </div>
    `
  }

  /**
   * Show error state.
   * @param {string} message
   */
  showError(message) {
    this.container.innerHTML = `
      <div class="error-state">
        <div class="error-state-icon">&#9888;</div>
        <div class="error-state-title">Connection Error</div>
        <div class="error-state-text">${message}</div>
      </div>
    `
  }
}

// Export for use
window.TranscriptionManager = TranscriptionManager
