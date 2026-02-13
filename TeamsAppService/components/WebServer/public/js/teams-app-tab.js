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
  const settingsBtn = document.getElementById('settings-btn')
  const settingsDropdown = document.getElementById('settings-dropdown')
  const uiLanguageSelect = document.getElementById('ui-language-select')

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
   * Populate the UI language selector with supported locales.
   */
  function populateUILanguageSelect() {
    uiLanguageSelect.innerHTML = ''
    window.i18n.supportedLocales.forEach(loc => {
      const option = document.createElement('option')
      option.value = loc
      try {
        const dn = new Intl.DisplayNames([loc], { type: 'language' })
        const name = dn.of(loc)
        option.textContent = name.charAt(0).toUpperCase() + name.slice(1)
      } catch (e) {
        option.textContent = loc
      }
      uiLanguageSelect.appendChild(option)
    })
    uiLanguageSelect.value = window.i18n.locale
  }

  /**
   * Refresh all dynamic content after a locale change.
   */
  function refreshDynamicContent() {
    // Re-translate the "Original" option in language select
    const originalOption = languageSelect.querySelector('option[value=""]')
    if (originalOption) {
      originalOption.textContent = window.i18n.t('languageOriginal')
    }

    // Re-translate language names in the translation selector using Intl.DisplayNames
    for (let i = 1; i < languageSelect.options.length; i++) {
      const opt = languageSelect.options[i]
      opt.textContent = getLanguageName(opt.value)
    }

    // Re-translate stop button if present
    const stopBtn = document.getElementById('stop-transcription-btn')
    if (stopBtn && !stopBtn.disabled) {
      stopBtn.textContent = window.i18n.t('btnStop')
      stopBtn.title = window.i18n.t('btnStopTranscription')
    }

    // Re-translate start session UI if visible
    const startTitle = document.querySelector('.start-session-title')
    if (startTitle) startTitle.textContent = window.i18n.t('startTitle')
    const startText = document.querySelector('.start-session-text')
    if (startText) startText.textContent = window.i18n.t('startDescription')
    const startBtn = document.getElementById('start-transcription-btn')
    if (startBtn && !startBtn.disabled) startBtn.textContent = window.i18n.t('btnStartTranscription')
    const profileLabel = document.querySelector('.profile-label')
    if (profileLabel) profileLabel.textContent = window.i18n.t('profileLabel')

    // Re-translate session options
    const diarizationLabelEl = document.getElementById('diarization-label')
    if (diarizationLabelEl) diarizationLabelEl.textContent = window.i18n.t('diarizationLabel')
    const keepAudioLabelEl = document.getElementById('keep-audio-label')
    if (keepAudioLabelEl) keepAudioLabelEl.textContent = window.i18n.t('keepAudioLabel')
    const translationsLabelEl = document.getElementById('translations-label')
    if (translationsLabelEl) translationsLabelEl.textContent = window.i18n.t('optTranslations')
    // Re-translate translation chip labels
    document.querySelectorAll('#translations-list .translation-chip span').forEach(span => {
      const checkbox = span.previousElementSibling
      if (checkbox && checkbox.value) {
        span.textContent = getLanguageName(checkbox.value)
      }
    })
    const diarizationTooltip = document.getElementById('diarization-tooltip')
    if (diarizationTooltip) diarizationTooltip.textContent = window.i18n.t('diarizationTooltip')
    const diarizationNativeLabel = document.getElementById('diarization-label-native')
    if (diarizationNativeLabel) diarizationNativeLabel.textContent = window.i18n.t('diarizationNative')
    const diarizationSoftwareLabel = document.getElementById('diarization-label-software')
    if (diarizationSoftwareLabel) diarizationSoftwareLabel.textContent = window.i18n.t('diarizationSoftware')
    const diarizationHint = document.getElementById('diarization-hint')
    if (diarizationHint) {
      const diarizationCheckbox = document.getElementById('opt-diarization')
      diarizationHint.textContent = diarizationCheckbox && diarizationCheckbox.checked
        ? window.i18n.t('diarizationSoftwareHint')
        : window.i18n.t('diarizationNativeHint')
    }
    const keepAudioTooltip = document.getElementById('keep-audio-tooltip')
    if (keepAudioTooltip) keepAudioTooltip.textContent = window.i18n.t('keepAudioTooltip')
    const keepAudioOnLabel = document.getElementById('keep-audio-label-on')
    if (keepAudioOnLabel) keepAudioOnLabel.textContent = window.i18n.t('keepAudioOn')
    const keepAudioOffLabel = document.getElementById('keep-audio-label-off')
    if (keepAudioOffLabel) keepAudioOffLabel.textContent = window.i18n.t('keepAudioOff')

    // Re-translate inline pairing UI if visible
    const pairingText = document.querySelector('.inline-pairing-text')
    if (pairingText) pairingText.textContent = window.i18n.t('linkStudioText')
    const pairingLabel = document.querySelector('.pairing-label')
    if (pairingLabel) pairingLabel.textContent = window.i18n.t('studioTokenLabel')
    const tokenInput = document.getElementById('studio-token-input')
    if (tokenInput) tokenInput.placeholder = window.i18n.t('studioTokenPlaceholder')
    const pairBtn = document.getElementById('pair-btn')
    if (pairBtn && !pairBtn.disabled) pairBtn.textContent = window.i18n.t('btnLinkAccount')
    const cancelBtn = document.getElementById('pair-cancel-btn')
    if (cancelBtn && !cancelBtn.disabled) cancelBtn.textContent = window.i18n.t('btnCancel')
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
          <div class="loading-text">${window.i18n.t('initializing')}</div>
        </div>
      `

      // Initialize transcription manager
      transcriptionManager = new TranscriptionManager({
        container: transcriptionContainer
      })

      // Initialize Teams SDK
      if (window.teamsSdk && window.teamsSdk.isInTeams()) {
        await window.teamsSdk.initialize()

        // Initialize i18n from Teams locale
        const locale = await window.teamsSdk.getLocale()
        window.i18n.init(locale)
        window.i18n.apply()
        populateUILanguageSelect()

        threadId = await window.teamsSdk.getThreadId()
        console.log('[TeamsApp] Thread ID:', threadId)

        // Get auth token before meeting lookup (needed for ownership check)
        await refreshAuthToken()
      } else {
        // For testing outside of Teams
        console.log('[TeamsApp] Running outside of Teams')

        // Initialize i18n with default locale
        window.i18n.init('en')
        window.i18n.apply()
        populateUILanguageSelect()

        // Use query params for testing
        const params = new URLSearchParams(window.location.search)
        threadId = params.get('threadId')
        sessionId = params.get('sessionId')
        channelId = params.get('channelId')

        // Allow locale override via query param for testing
        const localeParam = params.get('locale')
        if (localeParam) {
          window.i18n.init(localeParam)
          window.i18n.apply()
          uiLanguageSelect.value = window.i18n.locale
          refreshDynamicContent()
        }
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
        transcriptionManager.showError(window.i18n.t('errorNoMeetingContext'))
        updateStatus('disconnected', window.i18n.t('statusError'))
      }

    } catch (err) {
      console.error('[TeamsApp] Initialization error:', err)
      transcriptionManager.showError(window.i18n.t('errorInitFailed') + ': ' + err.message)
      updateStatus('disconnected', window.i18n.t('statusError'))
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
      throw new Error(window.i18n.t('errorSignInRequired'))
    }

    try {
      authToken = await window.teamsSdk.getAuthToken()
    } catch (err) {
      console.error('[TeamsApp] SSO authentication failed:', err)
      throw new Error(window.i18n.t('errorSignInConsent'))
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
        <p class="inline-pairing-text">${window.i18n.t('linkStudioText')}</p>
        <div class="pairing-form">
          <label class="pairing-label" for="studio-token-input">${window.i18n.t('studioTokenLabel')}</label>
          <input
            type="password"
            id="studio-token-input"
            class="pairing-input"
            placeholder="${window.i18n.t('studioTokenPlaceholder')}"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="pair-btn" class="btn btn-primary btn-pair">${window.i18n.t('btnLinkAccount')}</button>
          <button id="pair-cancel-btn" class="btn btn-secondary btn-pair">${window.i18n.t('btnCancel')}</button>
          <p id="pair-error" class="pairing-error" style="display:none;"></p>
        </div>
      `
      container.appendChild(pairingEl)

      const tokenInput = document.getElementById('studio-token-input')
      const pairBtn = document.getElementById('pair-btn')
      const cancelBtn = document.getElementById('pair-cancel-btn')
      const errorEl = document.getElementById('pair-error')

      tokenInput.focus()

      function cleanup() {
        pairingEl.remove()
        if (startBtn) {
          startBtn.style.display = ''
          startBtn.disabled = false
          startBtn.textContent = window.i18n.t('btnStartTranscription')
          startBtn.classList.remove('btn-loading')
        }
      }

      cancelBtn.addEventListener('click', () => {
        cleanup()
        reject(new Error('cancelled'))
      })

      async function onSubmit() {
        const studioToken = tokenInput.value.trim()
        if (!studioToken) {
          errorEl.textContent = window.i18n.t('errorStudioTokenRequired')
          errorEl.style.display = 'block'
          return
        }

        pairBtn.disabled = true
        pairBtn.textContent = window.i18n.t('btnLinking')
        pairBtn.classList.add('btn-loading')
        tokenInput.disabled = true
        cancelBtn.disabled = true
        errorEl.style.display = 'none'

        try {
          const response = await authFetch('/v1/link-studio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studioToken })
          })

          const data = await response.json()

          if (!response.ok) {
            const message = response.status === 403
              ? window.i18n.t('errorInsufficientPermissions')
              : (data.message || window.i18n.t('errorLinkFailed'))
            errorEl.textContent = message
            errorEl.style.display = 'block'
            pairBtn.disabled = false
            pairBtn.textContent = window.i18n.t('btnLinkAccount')
            pairBtn.classList.remove('btn-loading')
            tokenInput.disabled = false
            cancelBtn.disabled = false
            tokenInput.focus()
            return
          }

          console.log('[TeamsApp] Account linked successfully:', data.organizationId)
          cleanup()
          resolve()
        } catch (err) {
          console.error('[TeamsApp] Linking error:', err)
          errorEl.textContent = window.i18n.t('errorNetwork')
          errorEl.style.display = 'block'
          pairBtn.disabled = false
          pairBtn.textContent = window.i18n.t('btnLinkAccount')
          pairBtn.classList.remove('btn-loading')
          tokenInput.disabled = false
          cancelBtn.disabled = false
        }
      }

      pairBtn.addEventListener('click', onSubmit)
      tokenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onSubmit()
      })
    })
  }

  /**
   * Lookup meeting info from the server.
   * @param {string} threadId
   */
  async function lookupMeeting(threadId) {
    updateStatus('connecting', window.i18n.t('statusLookingUp'))

    try {
      const response = await fetchWithTimeout(`/v1/meetings/${encodeURIComponent(threadId)}`)

      if (response.status === 404) {
        showStartTranscriptionUI()
        updateStatus('disconnected', window.i18n.t('statusNoActive'))
        return
      }

      if (!response.ok) {
        throw new Error(window.i18n.t('errorServerError') + ': ' + response.status)
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
        transcriptionManager.showError(window.i18n.t('errorLookupTimeout'))
        updateStatus('disconnected', window.i18n.t('statusTimeout'))
      } else {
        transcriptionManager.showError(window.i18n.t('errorLookupFailed') + ': ' + err.message)
        updateStatus('disconnected', window.i18n.t('statusError'))
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
        <h2 class="start-session-title">${window.i18n.t('startTitle')}</h2>
        <p class="start-session-text">${window.i18n.t('startDescription')}</p>
        <div id="profile-selector" class="profile-selector" style="display:none;">
          <label class="profile-label">${window.i18n.t('profileLabel')}</label>
          <div id="profile-list" class="profile-list"></div>
          <select id="profile-select" class="profile-select" style="display:none;"></select>
        </div>
        <div id="session-options" class="session-options" style="display:none;">
          <div class="option-group">
            <div class="option-group-header">
              <span class="option-group-title" id="diarization-label">${window.i18n.t('diarizationLabel')}</span>
              <span class="help-icon" id="diarization-help">?<span class="help-tooltip" id="diarization-tooltip">${window.i18n.t('diarizationTooltip')}</span></span>
            </div>
            <div class="toggle-row">
              <span id="diarization-label-native" class="toggle-label active">${window.i18n.t('diarizationNative')}</span>
              <label class="toggle-switch">
                <input type="checkbox" id="opt-diarization">
                <span class="toggle-slider"></span>
              </label>
              <span id="diarization-label-software" class="toggle-label">${window.i18n.t('diarizationSoftware')}</span>
            </div>
            <span id="diarization-hint" class="toggle-hint">${window.i18n.t('diarizationNativeHint')}</span>
          </div>
          <div class="option-group">
            <div class="option-group-header">
              <span class="option-group-title" id="keep-audio-label">${window.i18n.t('keepAudioLabel')}</span>
              <span class="help-icon">?<span class="help-tooltip" id="keep-audio-tooltip">${window.i18n.t('keepAudioTooltip')}</span></span>
            </div>
            <div class="toggle-row">
              <span id="keep-audio-label-on" class="toggle-label active">${window.i18n.t('keepAudioOn')}</span>
              <label class="toggle-switch">
                <input type="checkbox" id="opt-keep-audio">
                <span class="toggle-slider"></span>
              </label>
              <span id="keep-audio-label-off" class="toggle-label">${window.i18n.t('keepAudioOff')}</span>
            </div>
          </div>
          <div id="translations-container" class="option-group" style="display:none;">
            <span class="option-group-title" id="translations-label">${window.i18n.t('optTranslations')}</span>
            <div id="translations-list" class="translations-list"></div>
          </div>
        </div>
        <button id="start-transcription-btn" class="btn btn-primary btn-start">
          ${window.i18n.t('btnStartTranscription')}
        </button>
      </div>
    `

    const startBtn = document.getElementById('start-transcription-btn')
    startBtn.addEventListener('click', onStartTranscription)

    // Diarization toggle logic
    const diarizationCheckbox = document.getElementById('opt-diarization')
    const nativeLabel = document.getElementById('diarization-label-native')
    const softwareLabel = document.getElementById('diarization-label-software')
    const hint = document.getElementById('diarization-hint')

    function updateDiarizationUI() {
      const isSoftware = diarizationCheckbox.checked
      nativeLabel.classList.toggle('active', !isSoftware)
      softwareLabel.classList.toggle('active', isSoftware)
      hint.textContent = isSoftware
        ? window.i18n.t('diarizationSoftwareHint')
        : window.i18n.t('diarizationNativeHint')
    }

    diarizationCheckbox.addEventListener('change', updateDiarizationUI)
    nativeLabel.addEventListener('click', () => { diarizationCheckbox.checked = false; updateDiarizationUI() })
    softwareLabel.addEventListener('click', () => { diarizationCheckbox.checked = true; updateDiarizationUI() })

    // Keep audio toggle logic
    const keepAudioCheckbox = document.getElementById('opt-keep-audio')
    const keepAudioOffLabel = document.getElementById('keep-audio-label-off')
    const keepAudioOnLabel = document.getElementById('keep-audio-label-on')

    function updateKeepAudioUI() {
      const isOff = keepAudioCheckbox.checked
      keepAudioOnLabel.classList.toggle('active', !isOff)
      keepAudioOffLabel.classList.toggle('active', isOff)
    }

    keepAudioCheckbox.addEventListener('change', updateKeepAudioUI)
    keepAudioOnLabel.addEventListener('click', () => { keepAudioCheckbox.checked = false; updateKeepAudioUI() })
    keepAudioOffLabel.addEventListener('click', () => { keepAudioCheckbox.checked = true; updateKeepAudioUI() })
  }

  /**
   * Handle "Start Transcription" button click.
   */
  async function onStartTranscription() {
    const startBtn = document.getElementById('start-transcription-btn')
    startBtn.disabled = true
    startBtn.textContent = window.i18n.t('btnStarting')
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
          throw new Error(window.i18n.t('errorLoadProfiles'))
        }

        const profiles = await profilesResponse.json()

        if (!profiles || profiles.length === 0) {
          throw new Error(window.i18n.t('errorNoProfiles'))
        }

        const profileList = document.getElementById('profile-list')
        const loadedProfiles = {}

        // Populate profile cards
        profiles.forEach((profile, index) => {
          loadedProfiles[profile.id] = profile
          const name = (profile.config && profile.config.name) || `${window.i18n.t('profileFallbackName')} ${profile.id}`
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
        startBtn.textContent = window.i18n.t('btnStartTranscription')
        startBtn.classList.remove('btn-loading')
        return
      }

      const transcriberProfileId = profileSelect.value

      if (!transcriberProfileId) {
        throw new Error(window.i18n.t('errorSelectProfile'))
      }

      // 2. Get the meeting join URL
      updateStatus('connecting', window.i18n.t('statusGettingInfo'))
      let meetingJoinUrl = null

      if (window.teamsSdk && window.teamsSdk.isInTeams()) {
        meetingJoinUrl = await window.teamsSdk.getMeetingJoinUrl()
      }

      if (!meetingJoinUrl) {
        throw new Error(window.i18n.t('errorNoJoinUrl'))
      }

      // 3. Create session
      updateStatus('connecting', window.i18n.t('statusCreatingSession'))

      const sessionResponse = await authFetch('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcriberProfileId: parseInt(transcriberProfileId, 10),
          meetingJoinUrl,
          threadId,
          translations: getSelectedTranslations(),
          diarization: document.getElementById('opt-diarization').checked,
          keepAudio: !document.getElementById('opt-keep-audio').checked
        })
      })

      if (!sessionResponse.ok) {
        const errData = await sessionResponse.json().catch(() => ({}))
        throw new Error(errData.message || window.i18n.t('errorCreateSession'))
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
      startBtn.textContent = window.i18n.t('btnStartTranscription')
      startBtn.classList.remove('btn-loading')
      updateStatus('disconnected', window.i18n.t('statusError'))

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
    stopBtn.textContent = window.i18n.t('btnStop')
    stopBtn.title = window.i18n.t('btnStopTranscription')
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
    stopBtn.textContent = window.i18n.t('btnStopping')

    try {
      const response = await authFetch(`/v1/sessions/${sessionId}/stop`, {
        method: 'PUT'
      })

      if (!response.ok) {
        throw new Error(window.i18n.t('errorStopSession'))
      }

      console.log('[TeamsApp] Session stopped')
      stopBtn.remove()
      updateStatus('disconnected', window.i18n.t('statusStopped'))

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
      stopBtn.textContent = window.i18n.t('btnStop')
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
    updateStatus('connecting', window.i18n.t('statusConnecting'))

    try {
      wsClient = new WebSocketClient()

      wsClient.on('connect', () => {
        console.log('[TeamsApp] WebSocket connected')
        updateStatus('connected', window.i18n.t('statusConnected'))
        wsClient.joinRoom(sessionId, channelId)
        // Don't clear - we want to keep the history loaded before connection
      })

      wsClient.on('disconnect', (reason) => {
        console.log('[TeamsApp] WebSocket disconnected:', reason)
        updateStatus('disconnected', window.i18n.t('statusDisconnected'))
      })

      wsClient.on('error', (err) => {
        console.error('[TeamsApp] WebSocket error:', err)
        updateStatus('disconnected', window.i18n.t('statusError'))
      })

      wsClient.on('brokerStatus', ({ connected }) => {
        if (!connected) {
          updateStatus('disconnected', window.i18n.t('statusBrokerOffline'))
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
      transcriptionManager.showError(window.i18n.t('errorConnectFailed') + ': ' + err.message)
      updateStatus('disconnected', window.i18n.t('statusConnectionFailed'))
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
   * Get human-readable language name using Intl.DisplayNames.
   * @param {string} code - BCP47 language code
   * @returns {string}
   */
  function getLanguageName(code) {
    try {
      const dn = new Intl.DisplayNames([window.i18n.locale], { type: 'language' })
      const name = dn.of(code)
      return name.charAt(0).toUpperCase() + name.slice(1)
    } catch (e) {
      return code
    }
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

  // Settings dropdown toggle
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const isVisible = settingsDropdown.style.display !== 'none'
    settingsDropdown.style.display = isVisible ? 'none' : 'block'
  })

  // Close settings dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!settingsDropdown.contains(e.target) && e.target !== settingsBtn) {
      settingsDropdown.style.display = 'none'
    }
  })

  // UI language change handler
  uiLanguageSelect.addEventListener('change', () => {
    window.i18n.init(uiLanguageSelect.value)
    window.i18n.apply()
    refreshDynamicContent()
  })

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
