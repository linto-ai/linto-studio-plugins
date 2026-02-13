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

module.exports = { createLinTOClient }
