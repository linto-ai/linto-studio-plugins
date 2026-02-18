'use strict'
const { logger } = require('live-srt-lib')

const LINTO_STUDIO_BASE_URL = process.env.LINTO_STUDIO_BASE_URL

let LinTOModule = null

async function getLinTO() {
    if (!LinTOModule) {
        LinTOModule = (await import('@linto-ai/linto')).default
    }
    return LinTOModule
}

async function createLinTOClient(studioToken) {
    if (!LINTO_STUDIO_BASE_URL) {
        throw new Error('LINTO_STUDIO_BASE_URL is not configured')
    }
    const LinTO = await getLinTO()
    return new LinTO({ authToken: studioToken, baseUrl: LINTO_STUDIO_BASE_URL })
}

/**
 * Validate a LinTO Studio token and retrieve user/organization info.
 * @param {string} studioToken - The LinTO Studio API token
 * @returns {Promise<{user: Object, organizations: Array, organizationId: string, orgRole: number, orgPermissions: number}>}
 */
async function validateStudioToken(studioToken) {
    if (!LINTO_STUDIO_BASE_URL) {
        throw new Error('LINTO_STUDIO_BASE_URL is not configured')
    }

    const LinTO = await getLinTO()
    const client = new LinTO({ authToken: studioToken, baseUrl: LINTO_STUDIO_BASE_URL })

    const user = await client.validateToken()
    if (!user || !user._id) {
        throw new Error('Invalid studio token: could not retrieve user info')
    }

    const organizations = await client.getOrganizations()
    if (!organizations || organizations.length === 0) {
        throw new Error('User has no organizations')
    }

    const org = organizations[0]
    const organizationId = org._id

    let orgRole = 0
    let orgPermissions = 0
    const membership = org.users?.find(u => u.userId === user._id)
    if (membership) {
        orgRole = membership.role || 0
        orgPermissions = membership.permissions || 0
    }

    logger.debug(`[LinTO SDK] Token validated: userId=${user._id}, org=${organizationId}, role=${orgRole}`)

    return { user, organizations, organizationId, orgRole, orgPermissions }
}

module.exports = { createLinTOClient, validateStudioToken }
