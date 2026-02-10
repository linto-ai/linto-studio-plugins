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
  let authToken = null
  let isAccountLinked = false
  let isSessionOwner = false

  // Font sizes
  const fontSizes = ['sm', 'md', 'lg']

  /**
   * Extract the OID (Object ID) from a JWT token.
   * @param {string} token - JWT token
   * @returns {string|null} The OID or null if extraction fails
   */
  function getOidFromToken(token) {
    if (!token) return null
    try {
      const payload = token.split('.')[1]
      const decoded = JSON.parse(atob(payload))
      return decoded.oid || null
    } catch (e) {
      console.error('[TeamsApp] Failed to decode token:', e)
      return null
    }
  }

  /**
   * Get a fresh auth token from Teams SDK.
   * Teams SDK handles caching and refresh internally.
   * @returns {Promise<string|null>}
   */
  async function refreshAuthToken() {
    if (!window.teamsSdk || !window.teamsSdk.isInTeams()) {
      return null
    }

    try {
      authToken = await window.teamsSdk.getAuthToken()
      return authToken
    } catch (err) {
      console.warn('[TeamsApp] Failed to refresh auth token:', err)
      return authToken // Return cached token if refresh fails
    }
  }

  /**
   * Fetch with auth token support.
   * Automatically refreshes the token and adds Authorization header.
   * @param {string} url - The URL to fetch
   * @param {Object} options - Fetch options
   * @returns {Promise<Response>}
   */
  async function authFetch(url, options = {}) {
    // Refresh token before each call (Teams SDK caches internally)
    await refreshAuthToken()

    const headers = { ...options.headers }
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`
    }

    return fetchWithTimeout(url, { ...options, headers })
  }

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

        // Get auth token before meeting lookup (needed for ownership check)
        await refreshAuthToken()
      } else {
        // For testing outside of Teams
        console.log('[TeamsApp] Running outside of Teams')
        // Use query params for testing
        const params = new URLSearchParams(window.location.search)
        threadId = params.get('threadId')
        sessionId = params.get('sessionId')
        channelId = params.get('channelId')
      }

      // If we have sessionId/channelId from params, skip account check and meeting lookup
      if (sessionId && channelId) {
        if (isSessionOwner) {
          showStopTranscriptionUI()
        }
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
   * Check if the current user's Azure AD account is linked to an emeeting organization.
   * @returns {Promise<{linked: boolean, organizationId?: string}>}
   */
  async function checkAccountStatus() {
    try {
      const response = await authFetch('/v1/account-status')

      if (!response.ok) {
        console.warn('[TeamsApp] Account status check failed:', response.status)
        return { linked: false }
      }

      return await response.json()
    } catch (err) {
      console.warn('[TeamsApp] Error checking account status:', err.message)
      return { linked: false }
    }
  }

  /**
   * Ensure the user is authenticated via SSO.
   * If no token is available, attempts to acquire one.
   * @throws {Error} if authentication fails
   */
  async function ensureAuthenticated() {
    if (authToken) return

    if (!window.teamsSdk || !window.teamsSdk.isInTeams()) {
      throw new Error('Sign-in is required to start a transcription. Please open this app inside Microsoft Teams.')
    }

    try {
      authToken = await window.teamsSdk.getAuthToken()
    } catch (err) {
      console.error('[TeamsApp] SSO authentication failed:', err)
      throw new Error('Sign-in is required to start a transcription. Please ensure the app has been consented by your Teams administrator.')
    }
  }

  /**
   * Ensure the user's account is linked to an emeeting organization.
   * Shows inline pairing UI if not linked.
   * @returns {Promise<void>} resolves when account is linked
   */
  async function ensureAccountLinked() {
    if (isAccountLinked) return

    const accountStatus = await checkAccountStatus()
    if (accountStatus.linked) {
      isAccountLinked = true
      return
    }

    // Show inline pairing and wait for completion
    await showInlinePairingUI()
    isAccountLinked = true
  }

  /**
   * Show inline pairing UI inside the start-session container.
   * Returns a Promise that resolves when pairing succeeds, or rejects on cancel.
   * @returns {Promise<void>}
   */
  function showInlinePairingUI() {
    return new Promise((resolve, reject) => {
      const container = document.querySelector('.start-session-container')
      if (!container) {
        reject(new Error('UI container not found'))
        return
      }

      // Hide the start button while pairing
      const startBtn = document.getElementById('start-transcription-btn')
      if (startBtn) startBtn.style.display = 'none'

      // Remove existing inline pairing if any
      const existing = document.getElementById('inline-pairing')
      if (existing) existing.remove()

      const pairingEl = document.createElement('div')
      pairingEl.id = 'inline-pairing'
      pairingEl.className = 'inline-pairing'
      pairingEl.innerHTML = `
        <p class="inline-pairing-text">To start a transcription, link your account first.</p>
        <div class="pairing-form">
          <label class="pairing-label" for="pairing-key-input">Pairing Key</label>
          <input
            type="text"
            id="pairing-key-input"
            class="pairing-input"
            placeholder="EMT-XXXX-XXXX-XXXX-XXXX"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="pair-btn" class="btn btn-primary btn-pair">Link Account</button>
          <button id="pair-cancel-btn" class="btn btn-secondary btn-pair">Cancel</button>
          <p id="pair-error" class="pairing-error" style="display:none;"></p>
        </div>
      `
      container.appendChild(pairingEl)

      const keyInput = document.getElementById('pairing-key-input')
      const pairBtn = document.getElementById('pair-btn')
      const cancelBtn = document.getElementById('pair-cancel-btn')
      const errorEl = document.getElementById('pair-error')

      keyInput.focus()

      function cleanup() {
        pairingEl.remove()
        if (startBtn) {
          startBtn.style.display = ''
          startBtn.disabled = false
          startBtn.textContent = 'Start Transcription'
          startBtn.classList.remove('btn-loading')
        }
      }

      cancelBtn.addEventListener('click', () => {
        cleanup()
        reject(new Error('cancelled'))
      })

      async function onSubmit() {
        const key = keyInput.value.trim()
        if (!key) {
          errorEl.textContent = 'Please enter a pairing key'
          errorEl.style.display = 'block'
          return
        }

        pairBtn.disabled = true
        pairBtn.textContent = 'Linking...'
        pairBtn.classList.add('btn-loading')
        keyInput.disabled = true
        cancelBtn.disabled = true
        errorEl.style.display = 'none'

        try {
          const response = await authFetch('/v1/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
          })

          const data = await response.json()

          if (!response.ok) {
            let message = data.message || 'Failed to link account'
            if (response.status === 429) {
              message = 'Too many attempts. Please wait a moment and try again.'
            }
            errorEl.textContent = message
            errorEl.style.display = 'block'
            pairBtn.disabled = false
            pairBtn.textContent = 'Link Account'
            pairBtn.classList.remove('btn-loading')
            keyInput.disabled = false
            cancelBtn.disabled = false
            keyInput.focus()
            return
          }

          console.log('[TeamsApp] Account paired successfully:', data.organizationId)
          cleanup()
          resolve()
        } catch (err) {
          console.error('[TeamsApp] Pairing error:', err)
          errorEl.textContent = 'Network error. Please try again.'
          errorEl.style.display = 'block'
          pairBtn.disabled = false
          pairBtn.textContent = 'Link Account'
          pairBtn.classList.remove('btn-loading')
          keyInput.disabled = false
          cancelBtn.disabled = false
        }
      }

      pairBtn.addEventListener('click', onSubmit)
      keyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onSubmit()
      })
    })
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
        showStartTranscriptionUI()
        updateStatus('disconnected', 'No active transcription')
        return
      }

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }

      const meeting = await response.json()
      sessionId = meeting.sessionId
      channelId = meeting.channelId

      console.log('[TeamsApp] Meeting found:', meeting)

      // Check if current user is the owner
      const currentUserOid = getOidFromToken(authToken)
      isSessionOwner = !!(currentUserOid && meeting.owner && currentUserOid === meeting.owner)
      console.log('[TeamsApp] Ownership check: currentOid=%s, meetingOwner=%s, isOwner=%s',
        currentUserOid, meeting.owner, isSessionOwner)

      // Update language selector if translations available
      if (meeting.translations && meeting.translations.length > 0) {
        updateLanguageOptions(meeting.translations)
      }

      // Show stop button only if current user is the owner
      if (isSessionOwner) {
        showStopTranscriptionUI()
      }

      // Load transcription history before connecting to live feed
      await loadTranscriptionHistory(threadId)

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
   * Update the translations checkboxes based on the selected profile.
   * @param {Object} profile
   */
  function updateTranslationOptions(profile) {
    const container = document.getElementById('translations-container')
    const list = document.getElementById('translations-list')
    if (!container || !list) return

    list.innerHTML = ''
    const raw = profile?.config?.availableTranslations
    const available = Array.isArray(raw) ? raw : (raw?.discrete || [])

    if (available.length === 0) {
      container.style.display = 'none'
      return
    }

    available.forEach(lang => {
      const chip = document.createElement('label')
      chip.className = 'translation-chip'
      chip.innerHTML = `<input type="checkbox" value="${lang}"><span>${getLanguageName(lang)}</span>`
      list.appendChild(chip)
    })

    container.style.display = 'block'
  }

  /**
   * Get the list of selected translation language codes.
   * @returns {string[]}
   */
  function getSelectedTranslations() {
    const list = document.getElementById('translations-list')
    if (!list) return []
    return Array.from(list.querySelectorAll('input:checked')).map(cb => cb.value)
  }

  /**
   * Show the "Start Transcription" UI when no active transcription is found.
   */
  function showStartTranscriptionUI() {
    transcriptionContainer.innerHTML = `
      <div class="start-session-container">
        <div class="start-session-icon">T</div>
        <h2 class="start-session-title">No Active Transcription</h2>
        <p class="start-session-text">Start a live transcription for this meeting.</p>
        <div id="profile-selector" class="profile-selector" style="display:none;">
          <label class="profile-label">Transcription profile</label>
          <div id="profile-list" class="profile-list"></div>
          <select id="profile-select" class="profile-select" style="display:none;"></select>
        </div>
        <div id="session-options" class="session-options" style="display:none;">
          <div class="option-row">
            <label class="option-label" for="opt-diarization">
              <input type="checkbox" id="opt-diarization">
              <span>Speaker diarization</span>
            </label>
          </div>
          <div class="option-row">
            <label class="option-label" for="opt-keep-audio">
              <input type="checkbox" id="opt-keep-audio" checked>
              <span>Keep audio recording</span>
            </label>
          </div>
          <div id="translations-container" class="option-row" style="display:none;">
            <span class="option-section-title">Translations</span>
            <div id="translations-list" class="translations-list"></div>
          </div>
        </div>
        <button id="start-transcription-btn" class="btn btn-primary btn-start">
          Start Transcription
        </button>
      </div>
    `

    const startBtn = document.getElementById('start-transcription-btn')
    startBtn.addEventListener('click', onStartTranscription)
  }

  /**
   * Handle "Start Transcription" button click.
   */
  async function onStartTranscription() {
    const startBtn = document.getElementById('start-transcription-btn')
    startBtn.disabled = true
    startBtn.textContent = 'Starting...'
    startBtn.classList.add('btn-loading')

    try {
      // 0. Ensure auth and account linking before proceeding
      await ensureAuthenticated()
      await ensureAccountLinked()

      // 1. Fetch transcriber profiles
      const profileSelect = document.getElementById('profile-select')
      const profileSelector = document.getElementById('profile-selector')

      if (profileSelect.options.length === 0) {
        const profilesResponse = await authFetch('/v1/transcriber-profiles')

        if (!profilesResponse.ok) {
          throw new Error('Failed to load transcription profiles')
        }

        const profiles = await profilesResponse.json()

        if (!profiles || profiles.length === 0) {
          throw new Error('No transcription profiles available')
        }

        const profileList = document.getElementById('profile-list')
        const loadedProfiles = {}

        // Populate profile cards
        profiles.forEach((profile, index) => {
          loadedProfiles[profile.id] = profile
          const name = (profile.config && profile.config.name) || `Profile ${profile.id}`
          const description = (profile.config && profile.config.description) || ''

          const option = document.createElement('option')
          option.value = profile.id
          profileSelect.appendChild(option)

          const card = document.createElement('label')
          card.className = 'profile-card' + (index === 0 ? ' selected' : '')
          card.innerHTML = `
            <input type="radio" name="profile" value="${profile.id}" ${index === 0 ? 'checked' : ''}>
            <div class="profile-card-content">
              <span class="profile-card-name">${name}</span>
              ${description ? `<span class="profile-card-desc">${description}</span>` : ''}
            </div>
          `
          card.querySelector('input').addEventListener('change', () => {
            profileList.querySelectorAll('.profile-card').forEach(c => c.classList.remove('selected'))
            card.classList.add('selected')
            profileSelect.value = profile.id
            updateTranslationOptions(loadedProfiles[profile.id])
          })
          profileList.appendChild(card)
        })

        profileSelect.value = profiles[0].id
        updateTranslationOptions(profiles[0])

        // Show selector and session options, wait for user choice
        profileSelector.style.display = 'block'
        document.getElementById('session-options').style.display = 'block'
        startBtn.disabled = false
        startBtn.textContent = 'Start Transcription'
        startBtn.classList.remove('btn-loading')
        return
      }

      const transcriberProfileId = profileSelect.value

      if (!transcriberProfileId) {
        throw new Error('Please select a transcription profile')
      }

      // 2. Get the meeting join URL
      updateStatus('connecting', 'Getting meeting info...')
      let meetingJoinUrl = null

      if (window.teamsSdk && window.teamsSdk.isInTeams()) {
        meetingJoinUrl = await window.teamsSdk.getMeetingJoinUrl()
      }

      if (!meetingJoinUrl) {
        throw new Error('Unable to get meeting join URL. Make sure you are in a Teams meeting.')
      }

      // 3. Create session
      updateStatus('connecting', 'Creating session...')

      const sessionResponse = await authFetch('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcriberProfileId: parseInt(transcriberProfileId, 10),
          meetingJoinUrl,
          threadId,
          translations: getSelectedTranslations(),
          diarization: document.getElementById('opt-diarization').checked,
          keepAudio: document.getElementById('opt-keep-audio').checked
        })
      })

      if (!sessionResponse.ok) {
        const errData = await sessionResponse.json().catch(() => ({}))
        throw new Error(errData.message || 'Failed to create transcription session')
      }

      const sessionData = await sessionResponse.json()
      sessionId = sessionData.sessionId
      channelId = sessionData.channelId

      console.log('[TeamsApp] Session created:', sessionData)

      // 4. Update language selector with selected translations
      const selectedTranslations = getSelectedTranslations()
      if (selectedTranslations.length > 0) {
        updateLanguageOptions(selectedTranslations)
      }

      // 5. Connect to transcriptions
      isSessionOwner = true
      transcriptionManager.clear()
      showStopTranscriptionUI()
      await connectToTranscriptions()

    } catch (err) {
      // If pairing was cancelled, just reset the button silently
      if (err.message === 'cancelled') return

      console.error('[TeamsApp] Start transcription error:', err)
      startBtn.disabled = false
      startBtn.textContent = 'Start Transcription'
      startBtn.classList.remove('btn-loading')
      updateStatus('disconnected', 'Error')

      // Show error inline
      let errorEl = document.getElementById('start-error')
      if (!errorEl) {
        errorEl = document.createElement('p')
        errorEl.id = 'start-error'
        errorEl.className = 'start-session-error'
        startBtn.parentNode.appendChild(errorEl)
      }
      errorEl.textContent = err.message
    }
  }

  /**
   * Show the "Stop Transcription" button in the header.
   */
  function showStopTranscriptionUI() {
    // Remove existing stop button if any
    const existing = document.getElementById('stop-transcription-btn')
    if (existing) existing.remove()

    const controls = document.querySelector('.controls')
    if (!controls) return

    const stopBtn = document.createElement('button')
    stopBtn.id = 'stop-transcription-btn'
    stopBtn.className = 'btn btn-danger btn-stop'
    stopBtn.textContent = 'Stop'
    stopBtn.title = 'Stop Transcription'
    stopBtn.addEventListener('click', onStopTranscription)

    controls.prepend(stopBtn)
  }

  /**
   * Handle "Stop Transcription" button click.
   */
  async function onStopTranscription() {
    const stopBtn = document.getElementById('stop-transcription-btn')
    if (!stopBtn || !sessionId) return

    stopBtn.disabled = true
    stopBtn.textContent = 'Stopping...'

    try {
      const response = await authFetch(`/v1/sessions/${sessionId}/stop`, {
        method: 'PUT'
      })

      if (!response.ok) {
        throw new Error('Failed to stop session')
      }

      console.log('[TeamsApp] Session stopped')
      stopBtn.remove()
      updateStatus('disconnected', 'Stopped')

      // Disconnect WebSocket
      if (wsClient) {
        wsClient.disconnect()
        wsClient = null
      }

      // Reset state
      sessionId = null
      channelId = null
      isSessionOwner = false

      // Show start UI again
      showStartTranscriptionUI()

    } catch (err) {
      console.error('[TeamsApp] Stop transcription error:', err)
      stopBtn.disabled = false
      stopBtn.textContent = 'Stop'
    }
  }

  /**
   * Load transcription history from the server.
   * @param {string} threadId
   */
  async function loadTranscriptionHistory(threadId) {
    try {
      console.log('[TeamsApp] Loading transcription history...')
      const response = await fetchWithTimeout(`/v1/meetings/${encodeURIComponent(threadId)}/history`)

      if (!response.ok) {
        console.warn('[TeamsApp] Failed to load history:', response.status)
        transcriptionManager.clear()
        return
      }

      const data = await response.json()
      const transcriptions = data.transcriptions || []

      console.log(`[TeamsApp] Loaded ${transcriptions.length} historical transcriptions`)

      if (transcriptions.length > 0) {
        transcriptionManager.loadHistory(transcriptions)
      } else {
        transcriptionManager.clear()
      }
    } catch (err) {
      console.warn('[TeamsApp] Error loading history:', err.message)
      transcriptionManager.clear()
      // Non-blocking - continue without history
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
        // Don't clear - we want to keep the history loaded before connection
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

      await wsClient.connect(authToken)

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
      'ar': 'Arabic',
      'bg': 'Bulgarian',
      'bs': 'Bosnian',
      'cs': 'Czech',
      'cy': 'Welsh',
      'da': 'Danish',
      'de': 'German',
      'de-DE': 'German (Germany)',
      'el': 'Greek',
      'en': 'English',
      'en-GB': 'English (UK)',
      'en-US': 'English (US)',
      'es': 'Spanish',
      'es-ES': 'Spanish (Spain)',
      'et': 'Estonian',
      'eu': 'Basque',
      'fi': 'Finnish',
      'fr': 'French',
      'fr-FR': 'French (France)',
      'gl': 'Galician',
      'hi': 'Hindi',
      'hu': 'Hungarian',
      'id': 'Indonesian',
      'it': 'Italian',
      'ja': 'Japanese',
      'ko': 'Korean',
      'lt': 'Lithuanian',
      'lv': 'Latvian',
      'mk': 'Macedonian',
      'nb': 'Norwegian',
      'nl': 'Dutch',
      'pl': 'Polish',
      'pt': 'Portuguese',
      'ro': 'Romanian',
      'ru': 'Russian',
      'sk': 'Slovak',
      'sl': 'Slovenian',
      'sr': 'Serbian',
      'sv': 'Swedish',
      'th': 'Thai',
      'tr': 'Turkish',
      'uk': 'Ukrainian',
      'vi': 'Vietnamese',
      'zh': 'Chinese',
      'zhh': 'Chinese (Traditional)'
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

  // Restore Stop button when tab becomes visible again (Teams hides/shows iframe on panel switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sessionId && isSessionOwner) {
      if (!document.getElementById('stop-transcription-btn')) {
        console.log('[TeamsApp] Restoring Stop button after visibility change')
        showStopTranscriptionUI()
      }
    }
  })

  // Initialize on load
  init()
})()
