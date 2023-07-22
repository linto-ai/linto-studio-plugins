const debug = require('debug')('session-api:router:api-docs:transcriber_profiles');
const { Model } = require("live-srt-lib");
const { v4: uuidv4 } = require('uuid');

module.exports = (webserver) => {
    return [{
        path: '/sessions/active',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const sessions = await Model.Session.findAll({
                    where: {
                        status: 'active'
                    }
                });
                res.json(sessions);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/terminated',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const sessions = await Model.Session.findAll({
                    where: {
                        status: 'terminated'
                    }
                });
                res.json(sessions);
            } catch (err) {
                next(err);
            }
        }
    },
    {
        path: '/sessions/:id',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id, {
                    include: {
                      model: Model.Channel,
                      attributes: {
                        exclude: ['id', 'sessionId']
                      }
                    }
                  });
                if (!session) {
                    return res.status(404).send('Session not found');
                }
                res.json(session);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const sessions = await Model.Session.findAll({
                    include: {
                        model: Model.Channel,
                        attributes: {
                          exclude: ['id', 'sessionId']
                        }
                      }
                  });
                res.json(sessions);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions',
        method: 'post',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                try {
                    // generate session id immediately (outside of model) so we can identify the handled session on MQTT messages or topics
                    const sessionId = uuidv4();
                    // scheduler will drive the session creation and model updates
                    webserver.app.components['BrokerClient'].forwardSessionCreation(req.body, sessionId)
                    await webserver.waitAckSessionCreation(sessionId);
                    const sessionWithChannels = await Model.Session.findByPk(sessionId, {
                        include: {
                            model: Model.Channel,
                            attributes: {
                              exclude: ['id', 'sessionId']
                            }
                          }
                      });
                    res.json(sessionWithChannels);
                } catch (err) {
                    res.status(500).json({ "error": err.message });
                }
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id',
        method: 'delete',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id);
                if (!session) {
                    return res.status(404).send('Session not found');
                }
                webserver.app.components['BrokerClient'].forwardSessionDeletion(session.id)
                res.json(session);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/start',
        method: 'put',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id);
                if (!session) {
                    return res.status(404).send('Session not found');
                }
                await session.update({
                    status: 'active',
                    start_time: new Date()
                });
                const channels = await Model.Channel.findAll({
                    where: {
                        sessionId: session.id
                    }
                });
                for (let i = 0; i < channels.length; i++) {
                    const channel = channels[i];
                    await channel.update({
                        stream_status: 'active',
                        transcriber_status: 'streaming'
                    });
                }
                res.json(session);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/stop',
        method: 'put',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id);
                if (!session) {
                    return res.status(404).send('Session not found');
                }
                await session.update({
                    status: 'terminated',
                    end_time: new Date()
                });
                const channels = await Model.Channel.findAll({
                    where: {
                        sessionId: session.id
                    }
                });
                for (let i = 0; i < channels.length; i++) {
                    const channel = channels[i];
                    await channel.update({
                        stream_status: 'inactive',
                        transcriber_status: 'closed'
                    });
                }
                res.json(session);
            } catch (err) {
                next(err);
            }
        }
    }];
};