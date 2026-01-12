const { logger } = require('live-srt-lib')

/**
 * Controller for handling BrokerClient events in MeetingRegistry.
 */
module.exports = function () {
  // Handle meeting-joined event from TeamsMediaBot
  this.app.components['BrokerClient']?.on('meeting-joined', (payload) => {
    const { sessionId, channelId, threadId, joinedAt } = payload

    if (!threadId || !sessionId || !channelId) {
      logger.warn('[TeamsAppService] Invalid meeting-joined payload:', payload)
      return
    }

    this.registerMeeting(threadId, sessionId, channelId, { joinedAt })
  })

  // Handle meeting-left event from TeamsMediaBot
  this.app.components['BrokerClient']?.on('meeting-left', (payload) => {
    const { threadId } = payload

    if (!threadId) {
      logger.warn('[TeamsAppService] Invalid meeting-left payload:', payload)
      return
    }

    this.unregisterMeeting(threadId)
  })
}
