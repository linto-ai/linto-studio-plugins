const express = require('express')
const { logger } = require('live-srt-lib')

/**
 * API routes for TeamsAppService.
 */
module.exports = function (app) {
  const router = express.Router()

  /**
   * GET /v1/meetings/:threadId
   * Lookup meeting info by Teams thread ID.
   */
  router.get('/meetings/:threadId', (req, res) => {
    const { threadId } = req.params
    const meetingRegistry = app.components['MeetingRegistry']

    if (!meetingRegistry) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'MeetingRegistry not initialized'
      })
    }

    const meeting = meetingRegistry.getMeeting(threadId)

    if (!meeting) {
      logger.debug(`[TeamsAppService] Meeting not found for threadId=${threadId}`)
      return res.status(404).json({
        error: 'Not found',
        message: `No active meeting found for threadId: ${threadId}`
      })
    }

    logger.debug(`[TeamsAppService] Meeting found for threadId=${threadId}: sessionId=${meeting.sessionId}, channelId=${meeting.channelId}`)

    res.json({
      sessionId: meeting.sessionId,
      channelId: meeting.channelId,
      threadId: meeting.threadId,
      languages: meeting.languages,
      translations: meeting.translations,
      connectedAt: meeting.connectedAt
    })
  })

  /**
   * GET /v1/meetings
   * List all active meetings.
   */
  router.get('/meetings', (req, res) => {
    const meetingRegistry = app.components['MeetingRegistry']

    if (!meetingRegistry) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'MeetingRegistry not initialized'
      })
    }

    const meetings = meetingRegistry.getAllMeetings()

    res.json({
      count: meetings.length,
      meetings: meetings.map(m => ({
        sessionId: m.sessionId,
        channelId: m.channelId,
        threadId: m.threadId,
        connectedAt: m.connectedAt
      }))
    })
  })

  /**
   * GET /v1/status
   * Get service status.
   */
  router.get('/status', (req, res) => {
    const brokerClient = app.components['BrokerClient']
    const meetingRegistry = app.components['MeetingRegistry']
    const webSocketServer = app.components['WebSocketServer']

    res.json({
      service: 'teamsappservice',
      status: 'ok',
      timestamp: new Date().toISOString(),
      components: {
        broker: brokerClient?.state || 'unknown',
        meetingRegistry: meetingRegistry?.state || 'unknown',
        webSocketServer: webSocketServer?.state || 'unknown'
      },
      stats: {
        activeMeetings: meetingRegistry?.getMeetingCount() || 0,
        connectedClients: webSocketServer?.getClientCount() || 0
      }
    })
  })

  return router
}
