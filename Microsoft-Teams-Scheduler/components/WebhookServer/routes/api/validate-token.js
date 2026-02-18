'use strict'

const { logger } = require('live-srt-lib')
const { validateStudioToken } = require('../../../../utils/lintoSdk')

module.exports = (webServer) => [{
    path: '/validate-token',
    method: 'post',
    controller: async (req, res, next) => {
        try {
            const { studioToken } = req.body
            if (!studioToken) {
                return res.status(400).json({ error: 'studioToken is required' })
            }

            let tokenInfo
            try {
                tokenInfo = await validateStudioToken(studioToken)
            } catch (err) {
                logger.warn(`[MS-Teams-Scheduler] Studio token validation failed: ${err.message}`)
                return res.status(400).json({ error: 'Invalid studio token: ' + err.message })
            }

            if (tokenInfo.orgRole < 3) {
                return res.status(403).json({ error: 'Insufficient permissions: role >= 3 required' })
            }

            res.json({
                valid: true,
                orgRole: tokenInfo.orgRole,
                orgPermissions: tokenInfo.orgPermissions,
                organizationId: tokenInfo.organizationId
            })
        } catch (err) {
            next(err)
        }
    }
}]
