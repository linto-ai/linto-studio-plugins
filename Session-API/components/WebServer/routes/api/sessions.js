const debug = require('debug')('session-api:router:api:sessions')
const { Model } = require("live-srt-lib")
const bcp47 = require('language-tags');
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function getEndpoints(sessionId, channelId) {
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
        let srtString = `srt://${host}:${srtPort}?streamid=${sessionId},${channelId}&mode=${srtMode}`;
        if (STREAMING_PASSPHRASE && STREAMING_PASSPHRASE !== 'false') {
            srtString += `&passphrase=${STREAMING_PASSPHRASE}`;
        }
        endpoints.srt = srtString;
    }

    if (protocols.includes('RTMP')) {
        const rtmpPort = STREAMING_PROXY_RTMP_TCP_PORT && STREAMING_PROXY_RTMP_TCP_PORT !== 'false' ? STREAMING_PROXY_RTMP_TCP_PORT : STREAMING_RTMP_TCP_PORT;
        const rtmpString = `rtmp://${host}:${rtmpPort}/${sessionId}/${channelId}`;
        endpoints.rtmp = rtmpString;
    }

    if (protocols.includes('WS')) {
        const wsPort = STREAMING_PROXY_WS_TCP_PORT && STREAMING_PROXY_WS_TCP_PORT !== 'false' ? STREAMING_PROXY_WS_TCP_PORT : STREAMING_WS_TCP_PORT;
        const wsString = `ws://${host}:${wsPort}/${sessionId},${channelId}`;
        endpoints.ws = wsString;
    }
    return endpoints;
}
module.exports = (webserver) => {
    return [
    {
        path: '/sessions/:id',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['sessionId']
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
            const statusList = req.query.statusList ? req.query.statusList.split(',') : null
            const organizationId = req.query.organizationId;
            const visibility = req.query.visibility;

            let where = {}

            if (statusList) {
                where.status = { [Model.Op.in]: statusList }
            }

            if (searchName) {
                where.name = { [Model.Op.startsWith]: searchName }
            }

            if (organizationId) {
                where.organizationId = organizationId;
            }

            if (visibility) {
                where.visibility = visibility;
            }

            Model.Session.findAndCountAll({
                limit: limit,
                offset: offset,
                include: {
                    model: Model.Channel,
                    attributes: {
                        exclude: ['sessionId', 'closedCaptions']
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
                    startTime: req.body.startTime || null,
                    endTime: req.body.endTime || null,
                    erroredOn: null,
                    owner: req.body.owner || null,
                    organizationId: req.body.organizationId || null,
                    visibility: req.body.visibility || 'private'
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
                    const newChannel = await Model.Channel.create({
                        keepAudio: channel.keepAudio || false,
                        diarization: channel.diarization || false,
                        languages: languages, //array of BCP47 language tags from transcriber profile
                        translations: translations, //array of BCP47 language tags
                        streamStatus: 'inactive',
                        sessionId: session.id,
                        transcriberProfileId: transcriberProfile.id,
                        name: channel.name
                    }, { transaction: t });

                    await Model.Channel.update({
                        streamEndpoints: getEndpoints(session.id, newChannel.id),
                    }, {
                        transaction: t,
                        where: {
                            'id': newChannel.id
                        }
                    });
                }
                await t.commit();
                // return the session with channels
                const result = await Model.Session.findByPk(session.id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['sessionId']
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
        path: '/sessions/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const sessionId = req.params.id;

            const session = await Model.Session.findByPk(sessionId);
            if (!session) {
                return res.status(404).json({ "error": `Session ${sessionId} not found` });
            }

            // Update is only possible before startTime
            if (session.startTime && new Date() >= session.startTime) {
                return res.status(400).json({ "error": "Can't update a session after startTime" });
            }

            const { channels: updatedChannels, ...sessionAttributes } = req.body;


            if (!updatedChannels || updatedChannels.length == 0) {
                return res.status(400).json({ "error": "At least one channel is required" });
            }

            for (const channel of updatedChannels) {
                if (channel.id && !await Model.Channel.findByPk(channel.id)) {
                    return res.status(404).json({ "error": `Channel ${channel.id} not found` });
                }
            }

            const currentChannels = await Model.Channel.findAll({
                where: {
                    sessionId
                }
            });

            const transaction = await Model.sequelize.transaction();
            try {
                await Model.Session.update(sessionAttributes, {
                    transaction,
                    where: {id: session.id}
                });

                // Update channels
                for (const currentChannel of currentChannels) {
                    for (const updatedChannel of updatedChannels) {
                        if (currentChannel.id != updatedChannel.id) {
                            continue;
                        }

                        const updatedAttrs = updatedChannel;

                        if (updatedChannel.translations) {
                            if (!Array.isArray(updatedChannel.translations) || !updatedChannel.translations.every(bcp47.check)) {
                                throw new ApiError(400, "Channel translations must be an array of bcp47 strings");
                            }
                        }

                        if (updatedChannel.transcriberProfileId) {
                            let transcriberProfile = await Model.TranscriberProfile.findByPk(updatedChannel.transcriberProfileId, { transaction });
                            if (!transcriberProfile) {
                                throw new ApiError(400, `Transcriber profile with id ${updatedChannel.transcriberProfileId} not found`);
                            }
                            const languages = transcriberProfile.config.languages.map(language => language.candidate);
                            updatedAttrs.languages = languages;
                        }

                        await Model.Channel.update({
                            ...updatedAttrs,
                            sessionId: session.id,
                        }, {
                            transaction,
                            where: {
                                'id': updatedChannel.id
                            }
                        });
                    }
                }

                // Delete channels
                const updateChannelIds = updatedChannels.map(channel => channel.id);
                for (const channel of currentChannels) {
                    if (updateChannelIds.includes(channel.id)) {
                        continue;
                    }

                    await Model.Channel.destroy({
                        where: {
                            id: channel.id
                        }
                    }, { transaction });
                }

                // Create channels
                const currentChannelIds = currentChannels.map(channel => channel.id);
                for (const channel of updatedChannels) {
                    if (currentChannelIds.includes(channel.id)) {
                        continue;
                    }

                    if (channel.translations) {
                        if (!Array.isArray(channel.translations) || !channel.translations.every(bcp47.check)) {
                            throw new ApiError(400, "Channel translations must be an array of bcp47 strings");
                        }
                    }
                    let transcriberProfile = await Model.TranscriberProfile.findByPk(channel.transcriberProfileId, { transaction });
                    if (!transcriberProfile) {
                        throw new ApiError(400, `Transcriber profile with id ${channel.transcriberProfileId} not found`);
                    }
                    const languages = transcriberProfile.config.languages.map(language => language.candidate)
                    const translations = channel.translations

                    const newChannel = await Model.Channel.create({
                        keepAudio: channel.keepAudio || false,
                        diarization: channel.diarization || false,
                        languages: languages, //array of BCP47 language tags from transcriber profile
                        translations: translations, //array of BCP47 language tags
                        streamStatus: 'inactive',
                        sessionId: session.id,
                        transcriberProfileId: transcriberProfile.id,
                        name: channel.name
                    }, { transaction });

                    await Model.Channel.update({
                        streamEndpoints: getEndpoints(session.id, newChannel.id),
                    }, {
                        transaction,
                        where: {
                            'id': newChannel.id
                        }
                    });

                }

                await transaction.commit();

                // return the session with channels
                const result = await Model.Session.findByPk(session.id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['sessionId']
                        }
                    }
                });
                debug('Session updated', result.id);
                webserver.emit('session-update')
                res.json(result);
            } catch (err) {
                debug(err);
                await transaction.rollback();
                return next(err)
            }
        }
    }, {
        path: '/sessions/:id/start-bot',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { id } = req.params;
                const { url, channelId, botType } = req.body;
                if (!id || !url || channelId === undefined || !botType) {
                    return res.status(400).json({ error: "sessionId, url, channelId, and botType are required" });
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
                const channel = session.channels.find(c => c.id === channelId);
                if (!channel) {
                    return res.status(404).json({ error: "Channel not found" });
                }
                // Check if the channel's streamStatus is 'inactive'
                if (channel.streamStatus !== 'inactive') {
                    return res.status(400).json({ error: "The channel must be inactive to start a bot" });
                }
                webserver.emit('startbot', id, channelId, url, botType);
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
                const { channelId } = req.body;

                if (!id || channelId === undefined) {
                    return res.status(400).json({ error: "sessionId and channelId are required" });
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

                const channel = session.channels.find(c => c.id === channelId);
                if (!channel) {
                    return res.status(404).json({ error: "Channel not found" });
                }
                webserver.emit('stopbot', id, channelId);
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
                    endTime: new Date()
                }, {
                    where: {
                        'id': sessionId
                    }
                });
                await Model.Channel.update({
                    streamStatus: 'inactive'
                }, {
                    where: {
                        'sessionId': sessionId
                    }
                });
                webserver.emit('session-update');

                const result = await Model.Session.findByPk(session.id, {
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: ['id', 'session_id']
                        }
                    }
                });
                res.json(result);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/purge',
        method: 'post',
        controller: async (req, res, next) => {
            const force = req.query.force === 'true';
            const where = force ? {} : {status: 'terminated'};
            const msg = force ? 'All sessions purged' : 'Terminated sessions purged'

            try {
                await Model.Session.destroy({
                    where: where
                });
                debug(msg);
                webserver.emit('session-update')
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }
    }];
};
