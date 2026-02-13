const { Model } = require('live-srt-lib')

module.exports = (webserver) => {
    return [
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
