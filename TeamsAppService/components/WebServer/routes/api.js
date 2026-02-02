const crypto = require('crypto')
const express = require('express')
const { logger, Model } = require('live-srt-lib')
const { normalizeThreadId } = require('../../../utils/threadId')
const { requireAuth, requireEmeetingAuth, optionalAuth } = require('../middlewares/auth')

const SESSION_API_HOST = process.env.SESSION_API_HOST || 'http://localhost:8005'

// Rate limiting state for POST /v1/pair (per IP)
const pairAttempts = new Map()
const PAIR_RATE_LIMIT = 5 // max attempts
const PAIR_RATE_WINDOW_MS = 60000 // per minute

/**
 * Check rate limit for pairing attempts.
 * @param {string} key - Rate limit key (IP address)
 * @returns {boolean} true if allowed, false if rate limited
 */
function checkPairRateLimit(key) {
  const now = Date.now()
  const entry = pairAttempts.get(key)

  if (!entry || now - entry.windowStart > PAIR_RATE_WINDOW_MS) {
    pairAttempts.set(key, { windowStart: now, count: 1 })
    return true
  }

  if (entry.count >= PAIR_RATE_LIMIT) {
    return false
  }

  entry.count++
  return true
}

/**
 * Hash a pairing key using SHA-256.
 * @param {string} plaintext
 * @returns {string}
 */
function hashKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex')
}

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
        email: link.email
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
   * POST /v1/pair
   * Pair the authenticated Azure AD user to an emeeting organization using a pairing key.
   * The key is validated (hash match, not expired, not revoked, within maxUses),
   * then a teamsAccountLink is created and the key's usedCount is incremented.
   * Rate limited to 5 attempts per minute per IP.
   * Requires Azure AD authentication.
   *
   * Body: { key: "EMT-XXXX-XXXX-XXXX-XXXX" }
   */
  router.post('/pair', requireAuth, async (req, res) => {
    const rateLimitKey = req.ip
    if (!checkPairRateLimit(rateLimitKey)) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Too many pairing attempts. Please try again later.'
      })
    }

    const { key } = req.body

    if (!key || typeof key !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'A pairing key is required'
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

      // Hash the provided key and look it up
      const keyHash = hashKey(key.trim())
      const pairingKey = await Model.PairingKey.findOne({
        where: { keyHash }
      })

      if (!pairingKey) {
        return res.status(400).json({
          error: 'Invalid Key',
          message: 'The pairing key is invalid'
        })
      }

      // Check status
      if (pairingKey.status === 'revoked') {
        return res.status(400).json({
          error: 'Key Revoked',
          message: 'This pairing key has been revoked'
        })
      }

      // Check expiration
      if (pairingKey.expiresAt && new Date(pairingKey.expiresAt) <= new Date()) {
        await pairingKey.update({ status: 'expired' })
        return res.status(400).json({
          error: 'Key Expired',
          message: 'This pairing key has expired'
        })
      }

      // Check max uses
      if (pairingKey.maxUses !== null && pairingKey.usedCount >= pairingKey.maxUses) {
        return res.status(400).json({
          error: 'Key Exhausted',
          message: 'This pairing key has reached its maximum number of uses'
        })
      }

      // Create account link
      const link = await Model.TeamsAccountLink.create({
        azureOid: req.user.oid,
        azureTenantId: req.user.tenantId,
        organizationId: pairingKey.organizationId,
        displayName: req.user.name || null,
        email: req.user.email || null
      })

      // Increment usage count
      await pairingKey.increment('usedCount')

      logger.info(`[TeamsAppService] Account paired: oid=${req.user.oid}, org=${pairingKey.organizationId}`)

      res.status(201).json({
        linked: true,
        organizationId: link.organizationId,
        displayName: link.displayName,
        email: link.email
      })
    } catch (err) {
      // Handle unique constraint violation (race condition: user linked between check and create)
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({
          error: 'Already Linked',
          message: 'Your account is already linked to an organization'
        })
      }

      logger.error(`[TeamsAppService] Error pairing account: ${err.message}`)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to pair account'
      })
    }
  })

  /**
   * DELETE /v1/unpair
   * Remove the authenticated user's account link.
   * Requires emeeting authentication (must be currently linked).
   */
  router.delete('/unpair', requireEmeetingAuth, async (req, res) => {
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
      const orgId = req.emeetingOrg.organizationId
      const url = `${SESSION_API_HOST}/v1/transcriber_profiles?quickMeeting=true&organizationId=${encodeURIComponent(orgId)}`
      logger.debug(`[TeamsAppService] Fetching transcriber profiles from ${url}`)

      const response = await fetch(url)

      if (!response.ok) {
        logger.error(`[TeamsAppService] Session-API returned ${response.status} for transcriber profiles`)
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Failed to fetch transcriber profiles from Session-API'
        })
      }

      const data = await response.json()
      res.json(data)
    } catch (err) {
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
    const { transcriberProfileId, meetingJoinUrl, threadId, translations, diarization, keepAudio } = req.body

    if (!transcriberProfileId || !meetingJoinUrl || !threadId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: transcriberProfileId, meetingJoinUrl, threadId'
      })
    }

    try {
      // 1. Create session via Session-API
      const channelConfig = {
        transcriberProfileId,
        diarization: diarization !== undefined ? diarization : false,
        enableLiveTranscripts: true,
        keepAudio: keepAudio !== undefined ? keepAudio : true
      }

      if (Array.isArray(translations) && translations.length > 0) {
        channelConfig.translations = translations
      }

      const sessionPayload = {
        owner: req.user.oid,
        organizationId: req.emeetingOrg.organizationId,
        channels: [channelConfig]
      }

      logger.info(`[TeamsAppService] Creating session for user=${req.user.oid}, org=${req.emeetingOrg.organizationId}, profile=${transcriberProfileId}`)

      const sessionResponse = await fetch(`${SESSION_API_HOST}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionPayload)
      })

      if (!sessionResponse.ok) {
        const errBody = await sessionResponse.text()
        logger.error(`[TeamsAppService] Session-API returned ${sessionResponse.status}: ${errBody}`)
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Failed to create session in Session-API'
        })
      }

      const session = await sessionResponse.json()
      const sessionId = session.id
      const channelId = session.channels?.[0]?.id

      if (!channelId) {
        logger.error(`[TeamsAppService] Session created but no channel returned`)
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Session created but no channel was returned'
        })
      }

      // 2. Create bot via Session-API
      const botPayload = {
        url: meetingJoinUrl,
        channelId,
        provider: 'teams',
        enableDisplaySub: true
      }

      logger.info(`[TeamsAppService] Creating bot for session=${sessionId}, channel=${channelId}`)

      const botResponse = await fetch(`${SESSION_API_HOST}/v1/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(botPayload)
      })

      if (!botResponse.ok) {
        const errBody = await botResponse.text()
        logger.error(`[TeamsAppService] Session-API bot creation returned ${botResponse.status}: ${errBody}`)
        // Session was created but bot failed - still return session info
        logger.warn(`[TeamsAppService] Session ${sessionId} created but bot creation failed`)
      }

      // 3. Register in MeetingRegistry
      const meetingRegistry = app.components['MeetingRegistry']
      if (meetingRegistry) {
        const normalizedThreadId = normalizeThreadId(threadId)
        meetingRegistry.registerMeeting(normalizedThreadId, sessionId, channelId)
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

      const response = await fetch(`${SESSION_API_HOST}/v1/sessions/${sessionId}/stop?force=true`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      })

      if (!response.ok) {
        const errBody = await response.text()
        logger.error(`[TeamsAppService] Session-API stop returned ${response.status}: ${errBody}`)
        return res.status(response.status >= 500 ? 502 : response.status).json({
          error: response.status >= 500 ? 'Bad Gateway' : 'Error',
          message: 'Failed to stop session'
        })
      }

      const data = await response.json()
      res.json(data)
    } catch (err) {
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
