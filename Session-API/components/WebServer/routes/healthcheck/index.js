module.exports = (webserver) => {
    return [{
        path: '/',
        method: 'get',
        controller: async (req, res, next) => {
            res.json({
                status: "success"
            })
        }
    }]
}
