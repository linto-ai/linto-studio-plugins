const express = require('express')
const { logger, Model } = require('live-srt-lib')
const { normalizeThreadId } = require('../../../utils/threadId')
const { validateStudioToken, createLinTOClient } = require('../../../utils/lintoSdk')
const { requireAuth, requireEmeetingAuth, optionalAuth } = require('../middlewares/auth')

const SESSION_API_HOST = process.env.SESSION_API_HOST || 'http://localhost:8005'

/**
 * API routes for TeamsAppService.
 */
module.exports = function (app) {
  const router = express.Router()

  /**
   * GET /v1/account-status
   * Check if the authenticated Azure AD user is linked to an emeeting organization.
   * Requires Azure AD authentication.
   */
  router.get('/account-status', requireAuth, async (req, res) => {
    try {
      const link = await Model.TeamsAccountLink.findOne({
        where: {
          azureOid: req.user.oid,
          status: 'active'
        }
      })

      if (!link) {
        return res.json({
          linked: false
        })
      }

      res.json({
        linked: true,
        organizationId: link.organizationId,
        displayName: link.displayName,
        email: link.email,
        orgRole: link.orgRole || 0,
        orgPermissions: link.orgPermissions || 0
      })
    } catch (err) {
      logger.error(`[TeamsAppService] Error checking account status: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check account status'
      })
    }
  })

  /**
   * POST /v1/link-studio
   * Link the authenticated Azure AD user to an emeeting organization using a LinTO Studio token.
   * The token is validated via the LinTO SDK, then a teamsAccountLink is created
   * with the user's organization, role, and permissions.
   * Requires Azure AD authentication.
   *
   * Body: { studioToken: "..." }
   */
  router.post('/link-studio', requireAuth, async (req, res) => {
    const { studioToken } = req.body

    if (!studioToken || typeof studioToken !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'A LinTO Studio API token is required'
      })
    }

    try {
      // Check if user is already linked
      const existingLink = await Model.TeamsAccountLink.findOne({
        where: {
          azureOid: req.user.oid,
          status: 'active'
        }
      })

      if (existingLink) {
        return res.status(409).json({
          error: 'Already Linked',
          message: 'Your account is already linked to an organization',
          organizationId: existingLink.organizationId
        })
      }

      // Validate token via LinTO SDK
      const { user: studioUser, organizationId, orgRole, orgPermissions } = await validateStudioToken(studioToken)

      // Verify minimum role: orgRole >= 3 required (meeting creation permission)
      if (orgRole < 3) {
        return res.status(403).json({
          error: 'Insufficient Permissions',
          message: 'Your LinTO Studio account does not have permission to create meetings in this organization'
        })
      }

      // Create account link
      const link = await Model.TeamsAccountLink.create({
        azureOid: req.user.oid,
        azureTenantId: req.user.tenantId,
        organizationId,
        lintoUserId: studioUser._id,
        orgRole,
        orgPermissions,
        studioToken,
        displayName: req.user.name || null,
        email: req.user.email || null
      })

      logger.info(`[TeamsAppService] Account linked: oid=${req.user.oid}, org=${organizationId}, role=${orgRole}`)

      res.status(201).json({
        linked: true,
        organizationId: link.organizationId,
        displayName: link.displayName,
        email: link.email,
        orgRole: link.orgRole,
        orgPermissions: link.orgPermissions
      })
    } catch (err) {
      // Handle unique constraint violation (race condition: user linked between check and create)
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({
          error: 'Already Linked',
          message: 'Your account is already linked to an organization'
        })
      }

      // SDK validation errors (invalid token, no org) -> 400
      if (err.message.includes('Invalid studio token') || err.message.includes('no organizations') || err.message.includes('not configured')) {
        logger.warn(`[TeamsAppService] Studio token validation failed: ${err.message}`)
        return res.status(400).json({
          error: 'Invalid Token',
          message: err.message
        })
      }

      logger.error(`[TeamsAppService] Error linking account: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to link account'
      })
    }
  })

  /**
   * DELETE /v1/unlink
   * Remove the authenticated user's account link.
   * Requires emeeting authentication (must be currently linked).
   */
  router.delete('/unlink', requireEmeetingAuth, async (req, res) => {
    try {
      const link = await Model.TeamsAccountLink.findOne({
        where: {
          azureOid: req.user.oid,
          status: 'active'
        }
      })

      if (!link) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'No active account link found'
        })
      }

      await link.update({ status: 'revoked' })

      logger.info(`[TeamsAppService] Account unpaired: oid=${req.user.oid}`)

      res.json({ success: true })
    } catch (err) {
      logger.error(`[TeamsAppService] Error unpairing account: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to unpair account'
      })
    }
  })

  /**
   * GET /v1/meetings/:threadId
   * Lookup meeting info by Teams thread ID.
   * Accepts both Base64-encoded (from Teams SDK) and raw (Graph API) formats.
   */
  router.get('/meetings/:threadId', optionalAuth, (req, res) => {
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
      owner: meeting.owner,
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
  router.get('/meetings/:threadId/history', optionalAuth, async (req, res) => {
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
   * GET /v1/transcriber-profiles
   * Proxy to Session-API to list available transcriber profiles for quick meetings.
   * Requires emeeting authentication (linked account).
   * Filters profiles by the user's linked organizationId.
   */
  router.get('/transcriber-profiles', requireEmeetingAuth, async (req, res) => {
    try {
      const client = await createLinTOClient(req.emeetingOrg.studioToken)
      const data = await client.listTranscriberProfiles({ quickMeeting: true })
      res.json(data)
    } catch (err) {
      if (err.status) {
        return res.status(err.status >= 500 ? 502 : err.status).json({
          error: err.statusText || 'Error',
          message: err.body?.message || err.message
        })
      }
      logger.error(`[TeamsAppService] Error fetching transcriber profiles: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to fetch transcriber profiles'
      })
    }
  })

  /**
   * POST /v1/sessions
   * Create a new transcription session with a Teams bot.
   * Requires emeeting authentication (linked account).
   * Uses the linked organizationId for the session.
   *
   * Body: { transcriberProfileId, meetingJoinUrl, threadId }
   */
  router.post('/sessions', requireEmeetingAuth, async (req, res) => {
    // Check role: orgRole >= 3 required for quick meeting creation
    if ((req.emeetingOrg.orgRole || 0) < 3) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient role to create sessions'
      })
    }

    const { transcriberProfileId, meetingJoinUrl, threadId, translations, diarization, keepAudio } = req.body

    if (!transcriberProfileId || !meetingJoinUrl || !threadId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: transcriberProfileId, meetingJoinUrl, threadId'
      })
    }

    try {
      // 1. Create session via SDK (studio-api injects owner and organizationId)
      const channelConfig = {
        transcriberProfileId,
        diarization: diarization !== undefined ? diarization : false,
        enableLiveTranscripts: true,
        keepAudio: keepAudio !== undefined ? keepAudio : true
      }

      if (Array.isArray(translations) && translations.length > 0) {
        channelConfig.translations = translations
      }

      logger.info(`[TeamsAppService] Creating session for user=${req.user.oid}, org=${req.emeetingOrg.organizationId}, profile=${transcriberProfileId}`)

      const client = await createLinTOClient(req.emeetingOrg.studioToken)
      const session = await client.createSession({ channels: [channelConfig] })
      const sessionId = session.id
      const channelId = session.channels?.[0]?.id

      if (!channelId) {
        logger.error(`[TeamsAppService] Session created but no channel returned`)
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Session created but no channel was returned'
        })
      }

      // 2. Create bot via SDK
      try {
        await client.createBot({ url: meetingJoinUrl, channelId, provider: 'teams', enableDisplaySub: true })
      } catch (botErr) {
        logger.warn(`[TeamsAppService] Session ${sessionId} created but bot creation failed: ${botErr.message}`)
      }

      // 3. Register in MeetingRegistry
      const meetingRegistry = app.components['MeetingRegistry']
      if (meetingRegistry) {
        const normalizedThreadId = normalizeThreadId(threadId)
        meetingRegistry.registerMeeting(normalizedThreadId, sessionId, channelId, {
          translations: Array.isArray(translations) ? translations : [],
          owner: req.user.oid
        })
        logger.info(`[TeamsAppService] Meeting registered: threadId=${normalizedThreadId}, session=${sessionId}`)
      }

      res.status(201).json({
        sessionId,
        channelId,
        status: session.status || 'created'
      })
    } catch (err) {
      logger.error(`[TeamsAppService] Error creating session: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create transcription session'
      })
    }
  })

  /**
   * PUT /v1/sessions/:id/stop
   * Stop a transcription session.
   * Requires emeeting authentication (linked account).
   */
  router.put('/sessions/:id/stop', requireEmeetingAuth, async (req, res) => {
    const sessionId = req.params.id

    try {
      logger.info(`[TeamsAppService] Stopping session ${sessionId} requested by user=${req.user.oid}`)

      const client = await createLinTOClient(req.emeetingOrg.studioToken)
      const data = await client.stopSession(sessionId, { force: true })
      res.json(data)
    } catch (err) {
      if (err.status) {
        return res.status(err.status >= 500 ? 502 : err.status).json({
          error: err.status >= 500 ? 'Bad Gateway' : 'Error',
          message: err.body?.message || 'Failed to stop session'
        })
      }
      logger.error(`[TeamsAppService] Error stopping session: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to stop transcription session'
      })
    }
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
