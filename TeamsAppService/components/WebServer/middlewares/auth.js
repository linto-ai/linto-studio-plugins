'use strict'

const jwt = require('jsonwebtoken')
const jwksRsa = require('jwks-rsa')
const { logger } = require('live-srt-lib')

const APP_ID = process.env.TEAMSAPPSERVICE_APP_ID || ''
const TENANT_ID = process.env.TEAMSAPPSERVICE_AZURE_TENANT_ID || ''
const BASE_URL = process.env.TEAMSAPPSERVICE_BASE_URL || ''
const DOMAIN = BASE_URL ? new URL(BASE_URL).host : ''

// Expected audience: the Application ID URI configured in Azure AD
const AUDIENCE = `api://${DOMAIN}/${APP_ID}`
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`
const JWKS_URI = 'https://login.microsoftonline.com/common/discovery/v2.0/keys'

// JWKS client with caching (keys are cached for 24 hours)
// Uses "common" endpoint to support tokens from any tenant (multi-tenant app)
const jwksClient = jwksRsa({
  jwksUri: JWKS_URI,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
  rateLimit: true,
  jwksRequestsPerMinute: 10
})

/**
 * Retrieve the signing key from Azure AD JWKS endpoint.
 * @param {Object} header - JWT header containing kid
 * @param {Function} callback
 */
function getSigningKey(header, callback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      logger.error(`[Auth] Failed to get signing key: ${err.message}`)
      return callback(err)
    }
    const signingKey = key.getPublicKey()
    callback(null, signingKey)
  })
}

/**
 * Validate a JWT token string.
 * @param {string} tokenString - The raw JWT token
 * @returns {Promise<Object>} Decoded token claims
 */
function validateToken(tokenString) {
  return new Promise((resolve, reject) => {
    if (!TENANT_ID) {
      return reject(new Error('TEAMSAPPSERVICE_AZURE_TENANT_ID is not configured'))
    }

    jwt.verify(tokenString, getSigningKey, {
      algorithms: ['RS256'],
      audience: AUDIENCE
    }, (err, decoded) => {
      if (err) {
        return reject(err)
      }
      // Multi-tenant issuer validation: accept Azure AD v1.0 and v2.0 issuers
      const iss = decoded.iss || ''
      const isV2 = iss.startsWith('https://login.microsoftonline.com/') && iss.endsWith('/v2.0')
      const isV1 = iss.startsWith('https://sts.windows.net/') && iss.endsWith('/')
      if (!isV1 && !isV2) {
        return reject(new Error(`Invalid issuer: ${iss}`))
      }
      resolve(decoded)
    })
  })
}

/**
 * Extract Bearer token from Authorization header.
 * @param {Object} req - Express request
 * @returns {string|null}
 */
function extractToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }
  return authHeader.slice(7)
}

/**
 * Express middleware: requires a valid Azure AD JWT.
 * Rejects with 401 if no valid token is present.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    })
  }

  try {
    const decoded = await validateToken(token)
    req.user = {
      oid: decoded.oid,
      name: decoded.name,
      email: decoded.preferred_username,
      tenantId: decoded.tid
    }
    next()
  } catch (err) {
    logger.warn(`[Auth] Token validation failed: ${err.message}`)
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    })
  }
}

/**
 * Express middleware: optionally validates Azure AD JWT.
 * Attaches user info if token is present, but continues without auth if not.
 */
async function optionalAuth(req, res, next) {
  const token = extractToken(req)
  if (!token) {
    return next()
  }

  try {
    const decoded = await validateToken(token)
    req.user = {
      oid: decoded.oid,
      name: decoded.name,
      email: decoded.preferred_username,
      tenantId: decoded.tid
    }
  } catch (err) {
    logger.debug(`[Auth] Optional auth token invalid: ${err.message}`)
    // Continue without user - non-blocking
  }

  next()
}

/**
 * Express middleware: requires Azure AD auth AND an active emeeting account link.
 * First validates the Azure AD token, then looks up the teamsAccountLinks table
 * by oid to verify the user is paired to an emeeting organization.
 * Sets req.emeetingOrg = { organizationId } on success.
 * Returns 403 with ACCOUNT_NOT_LINKED if no active link is found.
 */
async function requireEmeetingAuth(req, res, next) {
  const token = extractToken(req)
  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    })
  }

  try {
    const decoded = await validateToken(token)
    req.user = {
      oid: decoded.oid,
      name: decoded.name,
      email: decoded.preferred_username,
      tenantId: decoded.tid
    }
  } catch (err) {
    logger.warn(`[Auth] Token validation failed: ${err.message}`)
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    })
  }

  try {
    const { Model } = require('live-srt-lib')
    const link = await Model.TeamsAccountLink.findOne({
      where: {
        azureOid: req.user.oid,
        status: 'active'
      }
    })

    if (!link) {
      return res.status(403).json({
        error: 'ACCOUNT_NOT_LINKED',
        message: 'Your Teams account is not linked to an emeeting organization. Please enter your LinTO Studio API token.'
      })
    }

    req.emeetingOrg = {
      organizationId: link.organizationId,
      lintoUserId: link.lintoUserId,
      orgRole: link.orgRole || 0,
      orgPermissions: link.orgPermissions || 0,
      studioToken: link.studioToken
    }

    next()
  } catch (err) {
    logger.error(`[Auth] Account link lookup failed: ${err.message}`)
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify account link'
    })
  }
}

module.exports = { requireAuth, requireEmeetingAuth, optionalAuth, validateToken }
