/**
 * Teams App Tab Main Script
 * Main entry point for the Teams side panel transcription app.
 */
(async function () {
  // Constants
  const FETCH_TIMEOUT_MS = 10000 // 10 seconds timeout for HTTP requests

  /**
   * Fetch with timeout support.
   * @param {string} url - The URL to fetch
   * @param {Object} options - Fetch options
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<Response>}
   */
  async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })
      return response
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // DOM Elements
  const statusDot = document.getElementById('status-dot')
  const statusText = document.getElementById('status-text')
  const languageSelect = document.getElementById('language-select')
  const fontSizeDecreaseBtn = document.getElementById('font-size-decrease')
  const fontSizeIncreaseBtn = document.getElementById('font-size-increase')
  const transcriptionContainer = document.getElementById('transcription-container')

  // State
  let sessionId = null
  let channelId = null
  let threadId = null
  let wsClient = null
  let transcriptionManager = null
  let currentFontSize = 'md'

  // Font sizes
  const fontSizes = ['sm', 'md', 'lg']

  /**
   * Initialize the app.
   */
  async function init() {
    try {
      // Show loading state
      transcriptionContainer.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <div class="loading-text">Initializing...</div>
        </div>
      `

      // Initialize transcription manager
      transcriptionManager = new TranscriptionManager({
        container: transcriptionContainer
      })

      // Initialize Teams SDK
      if (window.teamsSdk && window.teamsSdk.isInTeams()) {
        await window.teamsSdk.initialize()
        threadId = await window.teamsSdk.getThreadId()
        console.log('[TeamsApp] Thread ID:', threadId)
      } else {
        // For testing outside of Teams
        console.log('[TeamsApp] Running outside of Teams')
        // Use query params for testing
        const params = new URLSearchParams(window.location.search)
        threadId = params.get('threadId')
        sessionId = params.get('sessionId')
        channelId = params.get('channelId')
      }

      // If we have sessionId/channelId from params, skip meeting lookup
      if (sessionId && channelId) {
        await connectToTranscriptions()
        return
      }

      // Lookup meeting info by threadId
      if (threadId) {
        await lookupMeeting(threadId)
      } else {
        transcriptionManager.showError('Unable to determine meeting context')
        updateStatus('disconnected', 'No meeting context')
      }

    } catch (err) {
      console.error('[TeamsApp] Initialization error:', err)
      transcriptionManager.showError('Failed to initialize: ' + err.message)
      updateStatus('disconnected', 'Error')
    }
  }

  /**
   * Lookup meeting info from the server.
   * @param {string} threadId
   */
  async function lookupMeeting(threadId) {
    updateStatus('connecting', 'Looking up meeting...')

    try {
      const response = await fetchWithTimeout(`/v1/meetings/${encodeURIComponent(threadId)}`)

      if (response.status === 404) {
        transcriptionManager.showError('No active transcription for this meeting. Please ensure the transcription bot has joined.')
        updateStatus('disconnected', 'Not active')
        return
      }

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }

      const meeting = await response.json()
      sessionId = meeting.sessionId
      channelId = meeting.channelId

      console.log('[TeamsApp] Meeting found:', meeting)

      // Update language selector if translations available
      if (meeting.translations && meeting.translations.length > 0) {
        updateLanguageOptions(meeting.translations)
      }

      await connectToTranscriptions()

    } catch (err) {
      console.error('[TeamsApp] Meeting lookup error:', err)
      if (err.name === 'AbortError') {
        transcriptionManager.showError('Meeting lookup timed out. Please try again.')
        updateStatus('disconnected', 'Timeout')
      } else {
        transcriptionManager.showError('Failed to lookup meeting: ' + err.message)
        updateStatus('disconnected', 'Error')
      }
    }
  }

  /**
   * Connect to the WebSocket for transcriptions.
   */
  async function connectToTranscriptions() {
    updateStatus('connecting', 'Connecting...')

    try {
      wsClient = new WebSocketClient()

      wsClient.on('connect', () => {
        console.log('[TeamsApp] WebSocket connected')
        updateStatus('connected', 'Connected')
        wsClient.joinRoom(sessionId, channelId)
        transcriptionManager.clear()
      })

      wsClient.on('disconnect', (reason) => {
        console.log('[TeamsApp] WebSocket disconnected:', reason)
        updateStatus('disconnected', 'Disconnected')
      })

      wsClient.on('error', (err) => {
        console.error('[TeamsApp] WebSocket error:', err)
        updateStatus('disconnected', 'Error')
      })

      wsClient.on('brokerStatus', ({ connected }) => {
        if (!connected) {
          updateStatus('disconnected', 'Broker offline')
        }
      })

      wsClient.on('partial', (data) => {
        transcriptionManager.addPartial(data)
      })

      wsClient.on('final', (data) => {
        transcriptionManager.addFinal(data)
      })

      await wsClient.connect()

    } catch (err) {
      console.error('[TeamsApp] Connection error:', err)
      transcriptionManager.showError('Failed to connect: ' + err.message)
      updateStatus('disconnected', 'Connection failed')
    }
  }

  /**
   * Update connection status UI.
   * @param {string} status - 'connected', 'disconnected', or 'connecting'
   * @param {string} text
   */
  function updateStatus(status, text) {
    statusDot.className = `status-dot ${status}`
    statusText.textContent = text
  }

  /**
   * Update language dropdown options.
   * @param {Array} translations
   */
  function updateLanguageOptions(translations) {
    // Clear existing options except the first one (Original)
    while (languageSelect.options.length > 1) {
      languageSelect.remove(1)
    }

    // Add translation options
    translations.forEach(lang => {
      const option = document.createElement('option')
      option.value = lang
      option.textContent = getLanguageName(lang)
      languageSelect.appendChild(option)
    })
  }

  /**
   * Get human-readable language name.
   * @param {string} code - BCP47 language code
   * @returns {string}
   */
  function getLanguageName(code) {
    const names = {
      'en': 'English',
      'en-US': 'English (US)',
      'en-GB': 'English (UK)',
      'fr': 'French',
      'fr-FR': 'French (France)',
      'de': 'German',
      'de-DE': 'German (Germany)',
      'es': 'Spanish',
      'es-ES': 'Spanish (Spain)',
      'it': 'Italian',
      'pt': 'Portuguese',
      'zh': 'Chinese',
      'ja': 'Japanese',
      'ko': 'Korean',
      'ar': 'Arabic',
      'ru': 'Russian'
    }
    return names[code] || code
  }

  /**
   * Handle language selection change.
   */
  function onLanguageChange() {
    const value = languageSelect.value
    transcriptionManager.setSelectedLanguage(value === '' ? null : value)
  }

  /**
   * Handle font size change.
   * @param {number} delta - 1 for increase, -1 for decrease
   */
  function changeFontSize(delta) {
    const currentIndex = fontSizes.indexOf(currentFontSize)
    const newIndex = Math.max(0, Math.min(fontSizes.length - 1, currentIndex + delta))
    currentFontSize = fontSizes[newIndex]
    console.log('[TeamsApp] Font size changed to:', currentFontSize)

    if (transcriptionManager) {
      transcriptionManager.setFontSize(currentFontSize)
    }

    // Also apply directly to container as fallback
    const sizeMap = { sm: '12px', md: '14px', lg: '18px' }
    transcriptionContainer.style.fontSize = sizeMap[currentFontSize] || '14px'
  }

  // Event listeners
  languageSelect.addEventListener('change', onLanguageChange)
  fontSizeDecreaseBtn.addEventListener('click', () => changeFontSize(-1))
  fontSizeIncreaseBtn.addEventListener('click', () => changeFontSize(1))

  // Initialize on load
  init()
})()
