const crypto = require('crypto')
const { Model } = require('live-srt-lib')
const { Op } = Model

/**
 * Generate a user-friendly pairing key: EMT-XXXX-XXXX-XXXX-XXXX
 * Uses 32 random bytes encoded as hex, formatted with dashes.
 * @returns {string}
 */
function generatePairingKey() {
    const bytes = crypto.randomBytes(16)
    const hex = bytes.toString('hex').toUpperCase()
    // Format: EMT-XXXX-XXXX-XXXX-XXXX (4 groups of 4 hex chars)
    return `EMT-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

/**
 * Hash a pairing key using SHA-256.
 * @param {string} plaintext
 * @returns {string}
 */
function hashKey(plaintext) {
    return crypto.createHash('sha256').update(plaintext).digest('hex')
}

module.exports = (webserver) => {
    return [
    {
        // Create a new pairing key
        path: '/pairing-keys',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { organizationId, description, maxUses, expiresAt, createdBy } = req.body

                if (!organizationId) {
                    return res.status(400).json({ error: 'organizationId is required' })
                }

                if (maxUses !== undefined && maxUses !== null && (typeof maxUses !== 'number' || maxUses < 1)) {
                    return res.status(400).json({ error: 'maxUses must be a positive integer' })
                }

                if (expiresAt !== undefined && expiresAt !== null) {
                    const expDate = new Date(expiresAt)
                    if (isNaN(expDate.getTime()) || expDate <= new Date()) {
                        return res.status(400).json({ error: 'expiresAt must be a valid future date' })
                    }
                }

                const plaintext = generatePairingKey()
                const keyHash = hashKey(plaintext)

                const pairingKey = await Model.PairingKey.create({
                    keyHash,
                    organizationId,
                    createdBy: createdBy || null,
                    description: description || null,
                    maxUses: maxUses || null,
                    expiresAt: expiresAt || null
                })

                // Return plaintext ONCE - it will never be retrievable again
                res.status(201).json({
                    id: pairingKey.id,
                    key: plaintext,
                    organizationId: pairingKey.organizationId,
                    description: pairingKey.description,
                    maxUses: pairingKey.maxUses,
                    usedCount: pairingKey.usedCount,
                    expiresAt: pairingKey.expiresAt,
                    status: pairingKey.status,
                    createdAt: pairingKey.createdAt
                })
            } catch (err) {
                next(err)
            }
        }
    },
    {
        // List pairing keys (without the hash)
        path: '/pairing-keys',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const limit = parseInt(req.query.limit) || 10
                const offset = parseInt(req.query.offset) || 0
                const organizationId = req.query.organizationId

                const where = {}
                if (organizationId) {
                    where.organizationId = organizationId
                }

                const results = await Model.PairingKey.findAndCountAll({
                    limit,
                    offset,
                    where,
                    attributes: { exclude: ['keyHash'] },
                    order: [['createdAt', 'DESC']]
                })

                res.json({
                    pairingKeys: results.rows,
                    totalItems: results.count
                })
            } catch (err) {
                next(err)
            }
        }
    },
    {
        // Revoke a pairing key
        path: '/pairing-keys/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const { id } = req.params

                const pairingKey = await Model.PairingKey.findByPk(id)
                if (!pairingKey) {
                    return res.status(404).json({ error: 'Pairing key not found' })
                }

                await pairingKey.update({ status: 'revoked' })

                res.json({ success: true, id: pairingKey.id, status: 'revoked' })
            } catch (err) {
                next(err)
            }
        }
    },
    {
        // List teams account links
        path: '/teams-account-links',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const limit = parseInt(req.query.limit) || 10
                const offset = parseInt(req.query.offset) || 0
                const organizationId = req.query.organizationId

                const where = {}
                if (organizationId) {
                    where.organizationId = organizationId
                }

                const results = await Model.TeamsAccountLink.findAndCountAll({
                    limit,
                    offset,
                    where,
                    order: [['createdAt', 'DESC']]
                })

                res.json({
                    teamsAccountLinks: results.rows,
                    totalItems: results.count
                })
            } catch (err) {
                next(err)
            }
        }
    },
    {
        // Revoke a teams account link
        path: '/teams-account-links/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const { id } = req.params

                const link = await Model.TeamsAccountLink.findByPk(id)
                if (!link) {
                    return res.status(404).json({ error: 'Account link not found' })
                }

                await link.update({ status: 'revoked' })

                res.json({ success: true, id: link.id, status: 'revoked' })
            } catch (err) {
                next(err)
            }
        }
    }]
}
