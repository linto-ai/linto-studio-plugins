const express = require('express')
const { logger } = require('live-srt-lib')
const { normalizeThreadId } = require('../../../utils/threadId')

const SESSION_API_HOST = process.env.SESSION_API_HOST || 'http://localhost:8005'

/**
 * API routes for TeamsAppService.
 */
module.exports = function (app) {
  const router = express.Router()

  /**
   * GET /v1/meetings/:threadId
   * Lookup meeting info by Teams thread ID.
   * Accepts both Base64-encoded (from Teams SDK) and raw (Graph API) formats.
   */
  router.get('/meetings/:threadId', (req, res) => {
    const rawThreadId = req.params.threadId
    const threadId = normalizeThreadId(rawThreadId)
    const meetingRegistry = app.components['MeetingRegistry']

    logger.debug(`[TeamsAppService] Looking up meeting: raw=${rawThreadId}, normalized=${threadId}`)

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
   * GET /v1/meetings/:threadId/history
   * Get transcription history for a meeting.
   * Fetches closedCaptions from Session-API.
   */
  router.get('/meetings/:threadId/history', async (req, res) => {
    const rawThreadId = req.params.threadId
    const threadId = normalizeThreadId(rawThreadId)
    const meetingRegistry = app.components['MeetingRegistry']

    logger.debug(`[TeamsAppService] Fetching history for threadId=${threadId}`)

    if (!meetingRegistry) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'MeetingRegistry not initialized'
      })
    }

    const meeting = meetingRegistry.getMeeting(threadId)

    if (!meeting) {
      return res.status(404).json({
        error: 'Not found',
        message: `No active meeting found for threadId: ${threadId}`
      })
    }

    try {
      // Fetch session data from Session-API (includes closedCaptions)
      const sessionUrl = `${SESSION_API_HOST}/v1/sessions/${meeting.sessionId}`
      logger.debug(`[TeamsAppService] Fetching session from ${sessionUrl}`)

      const response = await fetch(sessionUrl)

      if (!response.ok) {
        logger.error(`[TeamsAppService] Session-API returned ${response.status}`)
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Failed to fetch session data from Session-API'
        })
      }

      const session = await response.json()

      // Find the channel matching our channelId (use == for type coercion since id can be string or number)
      const channel = session.channels?.find(c => c.id == meeting.channelId)

      if (!channel) {
        logger.debug(`[TeamsAppService] Channel ${meeting.channelId} not found in session. Available: ${session.channels?.map(c => c.id).join(', ')}`)
        return res.json({ transcriptions: [] })
      }

      // Return closedCaptions as transcriptions array
      const transcriptions = channel.closedCaptions || []

      logger.debug(`[TeamsAppService] Returning ${transcriptions.length} transcriptions for threadId=${threadId}`)

      res.json({
        sessionId: meeting.sessionId,
        channelId: meeting.channelId,
        transcriptions
      })
    } catch (err) {
      logger.error(`[TeamsAppService] Error fetching history: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to fetch transcription history'
      })
    }
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
