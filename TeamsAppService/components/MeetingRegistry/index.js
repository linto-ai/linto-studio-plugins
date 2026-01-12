const { Component, logger } = require('live-srt-lib')

/**
 * MeetingRegistry Component
 * In-memory store for mapping Teams threadId to session/channel information.
 */
class MeetingRegistry extends Component {
  static states = {
    READY: 'ready',
    ERROR: 'error'
  }

  constructor(app) {
    super(app)
    this.id = this.constructor.name

    // Map: threadId -> { sessionId, channelId, languages, translations, connectedAt }
    this._meetings = new Map()

    // Map: sessionId_channelId -> threadId (reverse lookup)
    this._sessionChannelToThread = new Map()

    this.state = MeetingRegistry.states.READY
    logger.info(`[TeamsAppService] MeetingRegistry initialized`)

    this.init()
  }

  /**
   * Register a new meeting when bot joins.
   * @param {string} threadId - Teams thread ID
   * @param {string} sessionId - Session ID
   * @param {string} channelId - Channel ID
   * @param {Object} options - Additional options (languages, translations)
   */
  registerMeeting(threadId, sessionId, channelId, options = {}) {
    const meeting = {
      sessionId,
      channelId,
      threadId,
      languages: options.languages || [],
      translations: options.translations || [],
      connectedAt: new Date().toISOString()
    }

    this._meetings.set(threadId, meeting)
    this._sessionChannelToThread.set(`${sessionId}_${channelId}`, threadId)

    logger.info(`[TeamsAppService] Registered meeting: threadId=${threadId}, sessionId=${sessionId}, channelId=${channelId}`)

    this.emit('meeting-registered', meeting)
    return meeting
  }

  /**
   * Unregister a meeting when bot leaves.
   * @param {string} threadId - Teams thread ID
   */
  unregisterMeeting(threadId) {
    const meeting = this._meetings.get(threadId)
    if (!meeting) {
      logger.warn(`[TeamsAppService] Attempted to unregister unknown meeting: threadId=${threadId}`)
      return null
    }

    this._meetings.delete(threadId)
    this._sessionChannelToThread.delete(`${meeting.sessionId}_${meeting.channelId}`)

    logger.info(`[TeamsAppService] Unregistered meeting: threadId=${threadId}, sessionId=${meeting.sessionId}, channelId=${meeting.channelId}`)

    this.emit('meeting-unregistered', meeting)
    return meeting
  }

  /**
   * Get meeting by Teams thread ID.
   * @param {string} threadId - Teams thread ID
   * @returns {Object|null} Meeting info or null
   */
  getMeeting(threadId) {
    return this._meetings.get(threadId) || null
  }

  /**
   * Get meeting by session/channel ID.
   * @param {string} sessionId - Session ID
   * @param {string} channelId - Channel ID
   * @returns {Object|null} Meeting info or null
   */
  getMeetingBySession(sessionId, channelId) {
    const threadId = this._sessionChannelToThread.get(`${sessionId}_${channelId}`)
    if (!threadId) return null
    return this._meetings.get(threadId) || null
  }

  /**
   * Check if a meeting exists for the given thread ID.
   * @param {string} threadId - Teams thread ID
   * @returns {boolean}
   */
  hasMeeting(threadId) {
    return this._meetings.has(threadId)
  }

  /**
   * Get all registered meetings.
   * @returns {Array} Array of meeting objects
   */
  getAllMeetings() {
    return Array.from(this._meetings.values())
  }

  /**
   * Get count of registered meetings.
   * @returns {number}
   */
  getMeetingCount() {
    return this._meetings.size
  }
}

module.exports = app => new MeetingRegistry(app)
