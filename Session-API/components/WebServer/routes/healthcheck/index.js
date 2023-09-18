const debug = require('debug')('session-api:router:healthcheck')

module.exports = (webserver) => {
    return [{
        path: '/',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            res.json({
                status: "success"
            })
        }
    }]
}
