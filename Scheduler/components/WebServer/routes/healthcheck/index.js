const debug = require('debug')('scheduler:router:test')

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
