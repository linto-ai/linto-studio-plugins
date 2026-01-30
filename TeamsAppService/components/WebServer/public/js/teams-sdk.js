/**
 * Teams SDK Wrapper
 * Provides a simplified interface to the Microsoft Teams JavaScript SDK.
 */
class TeamsSdkWrapper {
  constructor() {
    this.context = null
    this.initialized = false
    this.theme = 'default'
  }

  /**
   * Initialize the Teams SDK.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return

    try {
      // Check if running inside Teams
      if (typeof microsoftTeams === 'undefined') {
        console.warn('[TeamsSdk] Microsoft Teams SDK not available')
        return
      }

      await microsoftTeams.app.initialize()
      this.initialized = true
      console.log('[TeamsSdk] SDK initialized successfully')

      // Notify Teams that the app is loaded (removes the loading indicator)
      microsoftTeams.app.notifyAppLoaded()
      console.log('[TeamsSdk] App loaded notification sent')

      // Notify Teams that the app has successfully loaded (REQUIRED within 30 seconds)
      // Without this call, Teams will display "Sorry... We couldn't reach this app" error
      microsoftTeams.app.notifySuccess()
      console.log('[TeamsSdk] App success notification sent')

      // Register theme change handler
      microsoftTeams.app.registerOnThemeChangeHandler((theme) => {
        this.theme = theme
        this._applyTheme(theme)
      })
    } catch (err) {
      console.error('[TeamsSdk] Failed to initialize SDK:', err)
      throw err
    }
  }

  /**
   * Get the current Teams context.
   * @returns {Promise<Object>}
   */
  async getContext() {
    if (this.context) return this.context

    try {
      if (!this.initialized) {
        await this.initialize()
      }

      this.context = await microsoftTeams.app.getContext()
      console.log('[TeamsSdk] Context retrieved:', this.context)

      // Apply initial theme
      if (this.context.app?.theme) {
        this.theme = this.context.app.theme
        this._applyTheme(this.context.app.theme)
      }

      return this.context
    } catch (err) {
      console.error('[TeamsSdk] Failed to get context:', err)
      throw err
    }
  }

  /**
   * Get the meeting/chat thread ID from context.
   * @returns {Promise<string|null>}
   */
  async getThreadId() {
    const context = await this.getContext()

    // For meetings, use meeting.id or chat.id
    const threadId = context.meeting?.id ||
                     context.chat?.id ||
                     context.channel?.id ||
                     null

    console.log('[TeamsSdk] Thread ID:', threadId)
    return threadId
  }

  /**
   * Get the current user info.
   * @returns {Promise<Object>}
   */
  async getUserInfo() {
    const context = await this.getContext()
    return {
      id: context.user?.id,
      displayName: context.user?.displayName,
      email: context.user?.userPrincipalName,
      tenant: context.user?.tenant?.id
    }
  }

  /**
   * Get an SSO auth token from Teams.
   * Teams SDK handles caching and refresh internally.
   * @returns {Promise<string>} JWT token
   */
  async getAuthToken() {
    if (!this.initialized) {
      await this.initialize()
    }

    try {
      const token = await microsoftTeams.authentication.getAuthToken()
      console.log('[TeamsSdk] Auth token acquired')
      return token
    } catch (err) {
      console.error('[TeamsSdk] Failed to get auth token:', err)
      throw err
    }
  }

  /**
   * Get the meeting join URL using the Teams meeting API.
   * Requires RSC permission OnlineMeeting.ReadBasic.Chat.
   * @returns {Promise<string|null>} Meeting join URL or null
   */
  async getMeetingJoinUrl() {
    if (!this.initialized) {
      await this.initialize()
    }

    try {
      const details = await new Promise((resolve, reject) => {
        const result = microsoftTeams.meeting.getMeetingDetails((err, cbResult) => {
          if (err) return reject(err)
          resolve(cbResult)
        })
        // SDK v2.22+ returns a Promise, older versions use callback
        if (result && typeof result.then === 'function') {
          result.then(resolve, reject)
        }
      })
      const joinUrl = details?.details?.joinUrl || null
      console.log('[TeamsSdk] Meeting join URL:', joinUrl ? 'found' : 'not found')
      return joinUrl
    } catch (err) {
      console.error('[TeamsSdk] Failed to get meeting details:', err)
      return null
    }
  }

  /**
   * Notify Teams that configuration is complete.
   * Used in configuration/settings pages.
   */
  notifySuccess() {
    if (typeof microsoftTeams !== 'undefined') {
      microsoftTeams.pages.config.setValidityState(true)
    }
  }

  /**
   * Register save handler for configuration.
   * @param {Function} handler
   */
  registerSaveHandler(handler) {
    if (typeof microsoftTeams !== 'undefined') {
      microsoftTeams.pages.config.registerOnSaveHandler((saveEvent) => {
        const result = handler()
        if (result) {
          microsoftTeams.pages.config.setConfig({
            entityId: 'live-transcription',
            contentUrl: window.location.origin + '/teams-app-tab.html',
            suggestedDisplayName: 'Live Transcription'
          })
          saveEvent.notifySuccess()
        } else {
          saveEvent.notifyFailure()
        }
      })
    }
  }

  /**
   * Apply Teams theme to the document.
   * @param {string} theme - 'default', 'dark', or 'contrast'
   */
  _applyTheme(theme) {
    const themeMap = {
      'default': 'light',
      'dark': 'dark',
      'contrast': 'contrast'
    }

    const mappedTheme = themeMap[theme] || 'light'
    document.documentElement.setAttribute('data-theme', mappedTheme)
    console.log('[TeamsSdk] Theme applied:', mappedTheme)
  }

  /**
   * Check if running inside Teams.
   * @returns {boolean}
   */
  isInTeams() {
    return typeof microsoftTeams !== 'undefined'
  }
}

// Export singleton instance
window.teamsSdk = new TeamsSdkWrapper()
