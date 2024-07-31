const debug = require('debug')('session-api:router:api:sessions')
const { Model } = require("live-srt-lib")
const bcp47 = require('language-tags');
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function getEndpoints(sessionId, channelIndex) {
    const {
        STREAMING_PASSPHRASE,
        STREAMING_SRT_MODE,
        STREAMING_HOST,
        STREAMING_SRT_UDP_PORT,
        STREAMING_RTMP_TCP_PORT,
        STREAMING_WS_TCP_PORT,
        STREAMING_PROXY_HOST,
        STREAMING_PROXY_SRT_UDP_PORT,
        STREAMING_PROXY_RTMP_TCP_PORT,
        STREAMING_PROXY_WS_TCP_PORT,
        STREAMING_PROTOCOLS,
    } = process.env;

    const protocols = STREAMING_PROTOCOLS ? STREAMING_PROTOCOLS.split(',') : [];
    const host = STREAMING_PROXY_HOST && STREAMING_PROXY_HOST !== 'false' ? STREAMING_PROXY_HOST : STREAMING_HOST;
    const endpoints = {};

    if (protocols.includes('SRT')) {
        const srtPort = STREAMING_PROXY_SRT_UDP_PORT && STREAMING_PROXY_SRT_UDP_PORT !== 'false' ? STREAMING_PROXY_SRT_UDP_PORT : STREAMING_SRT_UDP_PORT;
        let srtMode = STREAMING_SRT_MODE;
        if (STREAMING_SRT_MODE === 'caller') {
            srtMode = 'listener';
        } else if (STREAMING_SRT_MODE === 'listener') {
            srtMode = 'caller';
        }
        const srtString = `srt://${host}:${srtPort}?streamid=${sessionId},${channelIndex}&mode=${srtMode}` +
            `${STREAMING_PASSPHRASE ? `&passphrase=${STREAMING_PASSPHRASE}` : ''}`;
        endpoints.srt = srtString;
    }

    if (protocols.includes('RTMP')) {
        const rtmpPort = STREAMING_PROXY_RTMP_TCP_PORT && STREAMING_PROXY_RTMP_TCP_PORT !== 'false' ? STREAMING_PROXY_RTMP_TCP_PORT : STREAMING_RTMP_TCP_PORT;
        const rtmpString = `rtmp://${host}:${rtmpPort}/${sessionId}/${channelIndex}`;
        endpoints.rtmp = rtmpString;
    }

    if (protocols.includes('WS')) {
        const wsPort = STREAMING_PROXY_WS_TCP_PORT && STREAMING_PROXY_WS_TCP_PORT !== 'false' ? STREAMING_PROXY_WS_TCP_PORT : STREAMING_WS_TCP_PORT;
        const wsString = `ws://${host}:${wsPort}/${sessionId}/${channelIndex}`;
        endpoints.ws = wsString;
    }
    return endpoints;
}
module.exports = (webserver) => {
    return [{
        path: '/sessions/active',
        method: 'get',
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
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10
            const offset = req.query.offset ?? 0
            const searchName = req.query.searchName
            let where = {}

            const statusList = req.query.status ? req.query.status.split(',') : null
            if (statusList) {
                where.status = { [Model.Op.in]: statusList }
            }

            if (searchName) {
                where.name = { [Model.Op.startsWith]: searchName }
            }

            Model.Session.findAndCountAll({
                limit: limit,
                offset: offset,
                include: {
                    model: Model.Channel,
                    attributes: {
                        exclude: ['id', 'session_id', 'closed_captions', 'translated_closed_captions']
                    }
                },
                where: where
            }).then(results => {
                res.json({
                    sessions: results.rows,
                    totalItems: results.count
                })
            }).catch(err => next(err))
        }
    }, {
        path: '/sessions',
        method: 'post',
        controller: async (req, res, next) => {
            const channels = req.body.channels
            if (!channels || channels.length == 0) {
                return res.status(400).json({ "error": "At least one channel is required" })
            }
            let session
            const t = await Model.sequelize.transaction();
            try {
                session = await Model.Session.create({
                    status: 'ready',
                    name: req.body.name || `New session ${new Date().toISOString()}`,
                    start_time: req.body.start_time || null,
                    end_time: req.body.end_time || null,
                    errored_on: null,
                    owner: req.body.owner || null,
                    organizationId: req.body.organizationId || null,
                    public: req.body.public || false
                }, { transaction: t });
                // Create channels
                for (const channel of channels) {
                    if (channel.translations) {
                        if (!Array.isArray(channel.translations) || !channel.translations.every(bcp47.check)) {
                            throw new ApiError(400, "Channel translations must be an array of bcp47 strings");
                        }
                    }
                    let transcriberProfile = await Model.TranscriberProfile.findByPk(channel.transcriberProfileId, { transaction: t });
                    if (!transcriberProfile) {
                        throw new ApiError(400, `Transcriber profile with id ${channel.transcriberProfileId} not found`);
                    }
                    const languages = transcriberProfile.config.languages.map(language => language.candidate)
                    const translations = channel.translations
                    await Model.Channel.create({
                        index: channels.indexOf(channel),
                        keepAudio: channel.keepAudio || false,
                        diarization: channel.diarization || false,
                        languages: languages, //array of BCP47 language tags from transcriber profile
                        translations: translations, //array of BCP47 language tags
                        stream_status: 'inactive',
                        stream_endpoints: getEndpoints(session.id, channels.indexOf(channel)),
                        sessionId: session.id,
                        transcriberProfileId: transcriberProfile.id,
                        name: channel.name
                    }, { transaction: t });
                }
                await t.commit();
                // return the session with channels
                const result = await Model.Session.findByPk(session.id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['id', 'session_id']
                        }
                    }
                });
                debug('Session created', result.id);
                webserver.emit('session-update')
                res.json(result);
            } catch (err) {
                await t.rollback();
                return next(err)
            }
        }
    }, {
        path: '/sessions/:id/start-bot',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { id } = req.params;
                const { url, channelIndex, botType } = req.body;
                if (!id || !url || channelIndex === undefined || !botType) {
                    return res.status(400).json({ error: "sessionId, url, channelIndex, and botType are required" });
                }
                const session = await Model.Session.findByPk(id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['id', 'sessionId']
                        }
                    }
                });
                if (!session) {
                    return res.status(404).json({ error: "Session not found" });
                }
                const channel = session.channels.find(c => c.index === channelIndex);
                if (!channel) {
                    return res.status(404).json({ error: "Channel not found" });
                }
                // Check if the channel's stream_status is 'inactive'
                if (channel.stream_status !== 'inactive') {
                    return res.status(400).json({ error: "The channel must be inactive to start a bot" });
                }
                webserver.emit('startbot', id, channelIndex, url, botType);
                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/stop-bot',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { id } = req.params;
                const { channelIndex } = req.body;

                if (!id || channelIndex === undefined) {
                    return res.status(400).json({ error: "sessionId and channelIndex are required" });
                }

                const session = await Model.Session.findByPk(id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['id', 'sessionId']
                        }
                    }
                });

                if (!session) {
                    return res.status(404).json({ error: "Session not found" });
                }

                const channel = session.channels.find(c => c.index === channelIndex);
                if (!channel) {
                    return res.status(404).json({ error: "Channel not found" });
                }
                webserver.emit('stopbot', id, channelIndex);
                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id);
                if (!session) {
                    return res.status(404).send('Session not found');
                }
                // Check if session is active and "force" parameter is not true
                if (session.status === 'active' && req.query.force !== 'true') {
                    throw new ApiError(400, "Active sessions cannot be deleted without force parameter");
                }
                await session.destroy();
                debug('Session deleted', session.id);
                webserver.emit('session-update');
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/stop',
        method: 'put',
        controller: async (req, res, next) => {
            const sessionId = req.params.id;
            try {
                // First, check if the session exists and is active
                const session = await Model.Session.findByPk(sessionId);
                if (!session) {
                    throw new ApiError(404, 'Session not found');
                }
                if (session.status === 'active' && req.query.force !== 'true') {
                    throw new ApiError(400, "Active sessions cannot be stopped without force parameter");
                }

                // If session is not active or force is true, proceed with update
                await Model.Session.update({
                    status: 'terminated',
                    end_time: new Date()
                }, {
                    where: {
                        'id': sessionId
                    }
                });
                await Model.Channel.update({
                    stream_status: 'inactive'
                }, {
                    where: {
                        'session_id': sessionId
                    }
                });
                webserver.emit('session-update');
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/start',
        method: 'put',
        controller: async (req, res, next) => {
            const sessionId = req.params.id
            try {
                await Model.Session.update({
                    status: 'ready',
                    start_time: new Date()
                }, {
                    where: {
                        'id': sessionId
                    }
                })
                webserver.emit('session-update')
                res.json({ 'success': true })
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/purge',
        method: 'post',
        controller: async (req, res, next) => {
            const force = req.query.force;
            debug('force', force)
            if (force === 'true') {
                try {
                    await Model.Session.destroy({
                        where: {}
                    });
                    debug('All sessions purged');
                    webserver.emit('session-update')
                    res.json({ 'success': true });
                } catch (err) {
                    next(err);
                }
                return;
            }
            try {
                await Model.Session.destroy({
                    where: {
                        status: 'terminated'
                    }
                });
                debug('Terminated sessions purged');
                webserver.emit('session-update')
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }

    }];
};
