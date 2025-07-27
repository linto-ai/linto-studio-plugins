module.exports = (webServer) => [{
    path: '/notifications',
    method: 'post',
    controller: async (req, res, next) => {
        try {
            await webServer.handleNotification(req, res);
        } catch (err) {
            next(err);
        }
    }
}];
