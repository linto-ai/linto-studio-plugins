const debug = require('debug')('scheduler:router:v1:sessions')
const { Model } = require("live-srt-lib")
const { v4: uuidv4 } = require('uuid')


module.exports = (webserver) => {
    return [{
        path: '/sessions',
        method: 'post',
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
        controller: async (req, res, next) => {
            try {
                const error = await webserver.app.components['BrokerClient'].deleteSession(req.params.id)
                if (error) {
                    res.status(500).json({ "error": error })
                }
                else {
                    res.json({'success': true})
                }
            } catch (err) {
                res.status(500).json({ "error": err.message });
                debug(err)
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/start',
        method: 'put',
        controller: async (req, res, next) => {
            try {
                const error = await webserver.app.components['BrokerClient'].startSession(req.params.id)
                if (error) {
                    res.status(500).json({ "error": error })
                }
                else {
                    res.json({'success': true})
                }
            } catch (err) {
                res.status(500).json({ "error": err.message })
                debug(err)
                next(err)
            }
        }
    }, {
        path: '/sessions/:id/reset',
        method: 'put',
        controller: async (req, res, next) => {
            try {
                const error = await webserver.app.components['BrokerClient'].resetSession(req.params.id)
                if (error) {
                    res.status(500).json({ "error": error })
                }
                else {
                    res.json({'success': true})
                }
            } catch (err) {
                res.status(500).json({ "error": err.message })
                debug(err)
                next(err)
            }
        }
    }, {
        path: '/sessions/:id/stop',
        method: 'put',
        controller: async (req, res, next) => {
            try {
                const error = await webserver.app.components['BrokerClient'].stopSession(req.params.id)
                if (error) {
                    res.status(500).json({ "error": error })
                }
                else {
                    res.json({'success': true})
                }
            } catch (err) {
                res.status(500).json({ "error": err.message });
                debug(err)
                next(err);
            }
        }
    }];
};
