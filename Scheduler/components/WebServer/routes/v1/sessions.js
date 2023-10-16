const debug = require('debug')('scheduler:router:v1:sessions')
const { Model } = require("live-srt-lib")
const { v4: uuidv4 } = require('uuid')


module.exports = (webserver) => {
    return [{
        path: '/sessions',
        method: 'post',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                try {
                    const sessionId = await webserver.app.components['BrokerClient'].createSession(req.body)
                    res.json({'sessionId': sessionId})
                } catch (err) {
                    res.status(500).json({ "error": err.message });
                }
            } catch (err) {
                debug(err)
                next(err);
            }
        }
    }, {
        path: '/sessions/:id',
        method: 'delete',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                await webserver.app.components['BrokerClient'].deleteSession(req.params.id)
                res.json({'success': true})
            } catch (err) {
                res.status(500).json({ "error": err.message });
                debug(err)
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/start',
        method: 'put',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                await webserver.app.components['BrokerClient'].startSession(req.params.id)
                res.json({'success': true})
            } catch (err) {
                res.status(500).json({ "error": err.message });
                debug(err)
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/stop',
        method: 'put',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                await webserver.app.components['BrokerClient'].stopSession(req.params.id)
                res.json({'success': true})
            } catch (err) {
                res.status(500).json({ "error": err.message });
                debug(err)
                next(err);
            }
        }
    }];
};
