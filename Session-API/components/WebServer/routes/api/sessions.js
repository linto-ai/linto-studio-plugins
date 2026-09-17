const { Model, logger } = require("live-srt-lib")
const { ApiError, validateTranslations, enrichTranslations, hasNoTranscriberProfile, resolveTranscriberProfile } = require('./translationHelpers');

// Fields a client may set via PUT/PATCH on /sessions/:id.
// System-managed fields (id, status, startTime, endTime, pausedAt, erroredOn,
// createdAt, updatedAt) are intentionally excluded so HTTP clients cannot
// bypass the dedicated lifecycle endpoints (/pause, /resume, /stop, ...).
const ALLOWED_SESSION_FIELDS = ['name', 'scheduleOn', 'endOn', 'autoStart', 'autoEnd', 'visibility', 'owner', 'organizationId', 'meta'];
// Client-writable channel columns on PUT /sessions/:id. Everything else on the
// Channel model is owned by the platform (streamStatus / transcriberId /
// lastSegmentId are written by the Scheduler, streamEndpoints and languages are
// derived here, audioFile by the Transcriber, sessionId by the route) and must
// never be settable from the request body.
const ALLOWED_CHANNEL_FIELDS = ['name', 'keepAudio', 'diarization', 'compressAudio', 'enableLiveTranscripts', 'transcriberProfileId', 'translations', 'meta'];

function pickAllowedChannelFields(channel) {
    return Object.fromEntries(
        Object.entries(channel).filter(([k]) => ALLOWED_CHANNEL_FIELDS.includes(k))
    );
}

// Session ids are public by design (Studio URLs, public session API, org
// listings), so a stream is identified by the session's PRIVATE id instead
// (Transcriber/components/StreamingServer/streamId.js). `privateId` never
// leaves the API except embedded in the channels' streamEndpoints, which Studio
// already hides on public sessions.
const SESSION_EXCLUDED_ATTRIBUTES = ['privateId'];
const CHANNEL_EXCLUDED_ATTRIBUTES = ['sessionId'];

function newPrivateId() {
    return require('crypto').randomUUID();
}

function getEndpoints(sessionPrivateId, channelId) {
    const sessionId = sessionPrivateId;
    const {
        STREAMING_PASSPHRASE,
        STREAMING_SRT_MODE,
        STREAMING_HOST,
        STREAMING_SRT_UDP_PORT,
        STREAMING_RTMP_TCP_PORT,
        STREAMING_WS_TCP_PORT,
        STREAMING_PROXY_SRT_HOST,
        STREAMING_PROXY_SRT_UDP_PORT,
        STREAMING_PROXY_RTMP_HOST,
        STREAMING_PROXY_RTMP_TCP_PORT,
        STREAMING_PROXY_WS_HOST,
        STREAMING_PROXY_WS_TCP_PORT,
        STREAMING_PROTOCOLS,
        STREAMING_WS_SECURE,
        STREAMING_WS_ENDPOINT,
        STREAMING_RTMP_SECURE,
    } = process.env;

    const protocols = STREAMING_PROTOCOLS ? STREAMING_PROTOCOLS.split(',') : [];
    const endpoints = {};

    if (protocols.includes('SRT')) {
        const srtPort = STREAMING_PROXY_SRT_UDP_PORT && STREAMING_PROXY_SRT_UDP_PORT !== 'false' ? STREAMING_PROXY_SRT_UDP_PORT : STREAMING_SRT_UDP_PORT;
        let srtMode = STREAMING_SRT_MODE;
        if (STREAMING_SRT_MODE === 'caller') {
            srtMode = 'listener';
        } else if (STREAMING_SRT_MODE === 'listener') {
            srtMode = 'caller';
        }
        const host = STREAMING_PROXY_SRT_HOST && STREAMING_PROXY_SRT_HOST !== 'false' ? STREAMING_PROXY_SRT_HOST : STREAMING_HOST;
        let srtString = `srt://${host}:${srtPort}?streamid=${sessionId},${channelId}&mode=${srtMode}`;
        if (STREAMING_PASSPHRASE && STREAMING_PASSPHRASE !== 'false') {
            srtString += `&passphrase=${STREAMING_PASSPHRASE}`;
        }
        endpoints.srt = srtString;
    }

    if (protocols.includes('RTMP')) {
        const rtmpProto = STREAMING_RTMP_SECURE && STREAMING_RTMP_SECURE !== 'false' ? 'rtmps' : 'rtmp';
        const rtmpPort = STREAMING_PROXY_RTMP_TCP_PORT && STREAMING_PROXY_RTMP_TCP_PORT !== 'false' ? STREAMING_PROXY_RTMP_TCP_PORT : STREAMING_RTMP_TCP_PORT;
        const host = STREAMING_PROXY_RTMP_HOST && STREAMING_PROXY_RTMP_HOST !== 'false' ? STREAMING_PROXY_RTMP_HOST : STREAMING_HOST;
        const rtmpString = `${rtmpProto}://${host}:${rtmpPort}/${sessionId}/${channelId}`;
        endpoints.rtmp = rtmpString;
    }

    if (protocols.includes('WS')) {
        const wsProto = STREAMING_WS_SECURE && STREAMING_WS_SECURE !== 'false' ? 'wss' : 'ws';
        const wsPort = STREAMING_PROXY_WS_TCP_PORT && STREAMING_PROXY_WS_TCP_PORT !== 'false' ? STREAMING_PROXY_WS_TCP_PORT : STREAMING_WS_TCP_PORT;
        const wsEndpoint = STREAMING_WS_ENDPOINT && STREAMING_WS_ENDPOINT !== 'false' ? `${STREAMING_WS_ENDPOINT}/` : '';
        const host = STREAMING_PROXY_WS_HOST && STREAMING_PROXY_WS_HOST !== 'false' ? STREAMING_PROXY_WS_HOST : STREAMING_HOST;
        const wsString = `${wsProto}://${host}:${wsPort}/${wsEndpoint}${sessionId},${channelId}`;
        endpoints.ws = wsString;
    }
    return endpoints;
}

async function getSessionChannelIds(sessionId, transaction) {
    const channels = await Model.Channel.findAll({
        where: { sessionId },
        attributes: ['id'],
        raw: true,
        transaction,
    });
    return channels.map(c => c.id);
}

// `session` is the Session instance (it carries privateId). A row that somehow
// has none (migration not applied) gets one here so its endpoints stay valid.
async function setChannelsEndpoints(session, transaction) {
    const sessionId = session.id;
    let privateId = session.privateId;
    if (!privateId) {
        privateId = newPrivateId();
        await session.update({ privateId }, { transaction });
    }
    const channels = await Model.Channel.findAll({
        where: {
            sessionId
        },
        order: [['id', 'ASC']],
        transaction
    });


    for (const [index, channel] of channels.entries()) {
        await Model.Channel.update({
            streamEndpoints: getEndpoints(privateId, index),
        }, {
            transaction,
            where: {
                'id': channel.id
            }
        });
    }
}

// Load one session (with its channels, optionally with captions) for a READ path.
//
// CONTRACT: returns a PLAIN, token-scrubbed object — NOT a Sequelize instance
// (the scrub has to serialize the row to strip a sub-key of the JSON `meta`
// column). Read-only: `.update()`, `.save()`, `.reload()`, `.getChannels()`… are
// NOT available on the result. A caller that needs the instance must do its own
// Model.Session.findByPk().
//
// @param  {string}  sessionId
// @param  {boolean} withCaptions  also attach closedCaptions / translatedCaptions
// @returns {Promise<object|null>} scrubbed plain session, or null when not found
async function getSessionResult(sessionId, withCaptions=false) {
    const session = await Model.Session.findByPk(sessionId, {
        attributes: { exclude: SESSION_EXCLUDED_ATTRIBUTES },
        include: {
            model: Model.Channel,
            attributes: {
                exclude: CHANNEL_EXCLUDED_ATTRIBUTES
            },
        },
        order: [[Model.Channel, 'id', 'ASC']]
    });

    if (!session) {
        return null;
    }

    for (const [index, channel] of session.channels.entries()) {
        channel.setDataValue('index', index);
    }

    if (withCaptions) {
        const channelIds = session.channels.map(c => c.id);
        const [allCaptions, allTranslations] = await Promise.all([
            Model.Caption.findAll({
                where: { channelId: channelIds },
                order: [['channelId', 'ASC'], ['id', 'ASC']],
                raw: true,
            }),
            Model.TranslatedCaption.findAll({
                where: { channelId: channelIds },
                raw: true,
            }),
        ]);

        const captionsByChannel = {};
        for (const c of allCaptions) {
            if (!captionsByChannel[c.channelId]) captionsByChannel[c.channelId] = [];
            captionsByChannel[c.channelId].push(Model.formatCaption(c));
        }
        const translationsByChannel = {};
        for (const t of allTranslations) {
            if (!translationsByChannel[t.channelId]) translationsByChannel[t.channelId] = [];
            translationsByChannel[t.channelId].push(t);
        }

        for (const channel of session.channels) {
            channel.setDataValue('closedCaptions', captionsByChannel[channel.id] || []);
            channel.setDataValue('translatedCaptions',
                Model.groupTranslatedCaptions(translationsByChannel[channel.id] || []));
        }
    }

    // Serialize + scrub HERE so EVERY read path (detail, create, update, pause,
    // resume, start, stop, delete-captions…) returns a token-free plain object.
    // The Meet-minted native join token is a sub-key of the JSON `meta` column
    // and must never reach a client (scrubbing on only the two GETs left it
    // leaking on the ~11 mutation responses). Tolerate a plain object (test
    // fixtures) as well as a Sequelize instance.
    const plain = typeof session.toJSON === 'function' ? session.toJSON() : session;
    return scrubNativeTokens(plain);
}

// Apply `fn` to every descriptor of a `meta.native` container while PRESERVING
// its container shape. `native` is documented as a capability map, but `meta` is
// a free-form client-writable JSON column: a client can PUT an ARRAY there, and
// Object.entries/Object.fromEntries would silently rewrite it into an object with
// numeric string keys — so what the client reads back (or what lands in the DB)
// would not be what it sent. An array is therefore mapped as an array. It is
// mapped, not skipped: a token nested in an array-valued `native` must still be
// scrubbed, never leaked because the container had an unexpected shape.
function mapNativeDescriptors(native, fn) {
    if (Array.isArray(native)) return native.map((desc, i) => fn(desc, String(i)));
    return Object.fromEntries(
        Object.entries(native).map(([cap, desc]) => [cap, fn(desc, cap)])
    );
}

// Strip the native join token from a serialized session before it leaves a read path.
// meta.native[<cap>].token (generic capability map) and the meta.linto_native.token
// back-compat alias are per-room join credentials minted by Meet; they must never reach
// a client. The token is a sub-key of the JSON `meta` column, so it cannot be an
// attributes.exclude — it is stripped from the plain object after toJSON/serialization.
// Every other meta key (room, state, livekitUrl, ...) is preserved untouched: the PATH-A
// frontend polls the session for those. The input plain object is returned (with a fresh
// meta / native / descriptor objects so the underlying instance is never mutated).
function scrubNativeTokens(session) {
    const meta = session && session.meta;
    if (!meta || typeof meta !== 'object') return session;
    const stripToken = (desc) => {
        if (!desc || typeof desc !== 'object' || !('token' in desc)) return desc;
        const { token, ...rest } = desc;
        return rest;
    };
    const scrubbed = { ...meta };
    if (meta.native && typeof meta.native === 'object') {
        scrubbed.native = mapNativeDescriptors(meta.native, stripToken);
    }
    if (meta.linto_native) {
        scrubbed.linto_native = stripToken(meta.linto_native);
    }
    session.meta = scrubbed;
    return session;
}

// C6: re-inject the sub-keys the read paths scrub into a client-supplied `meta`.
// `meta` is a full-replacement JSON column (Model.Session.update overwrites it),
// but scrubNativeTokens() makes meta.native[<cap>].token / meta.linto_native.token
// UNREADABLE. A client that does a read-modify-write — exactly what the Studio
// frontend does, it polls the session for meta.room / state / livekitUrl — would
// therefore PUT back a descriptor with the token missing and silently destroy a
// Meet-minted join credential nothing in this repo can re-mint (the session then
// degrades to the web bot with no error anywhere).
//
// Rule: a secret the client cannot read must never be erasable by omission.
//   - descriptor kept, no usable token supplied  -> re-inject the stored token
//   - descriptor kept, a real token supplied     -> the client wins (re-mint path:
//                                                   Meet writes the token here)
//   - descriptor (or the whole native map) dropped -> the capability itself is
//     being removed: nothing is resurrected, and the removal is visible on read.
// Anything outside those sub-keys keeps the legacy full-replacement semantics.
function mergeProtectedMeta(incoming, stored) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
    if (!stored || typeof stored !== 'object') return incoming;
    // A token is only "supplied" when it is a non-empty string; null / '' means
    // "I have no value for this" (typically a scrubbed read-back), not "erase it".
    const keepToken = (desc, storedDesc) => {
        if (!desc || typeof desc !== 'object' || Array.isArray(desc)) return desc;
        const storedToken = storedDesc && typeof storedDesc === 'object' ? storedDesc.token : undefined;
        if (typeof desc.token === 'string' && desc.token.length > 0) return desc; // explicit (re-)mint
        if (typeof storedToken !== 'string' || storedToken.length === 0) return desc; // nothing to preserve
        return { ...desc, token: storedToken };
    };
    const merged = { ...incoming };
    if (incoming.native && typeof incoming.native === 'object') {
        const storedNative = (stored.native && typeof stored.native === 'object') ? stored.native : {};
        // Shape-preserving (see mapNativeDescriptors): an array-valued `native`
        // is stored as the array the client sent, not rewritten into an object.
        merged.native = mapNativeDescriptors(incoming.native, (desc, cap) => keepToken(desc, storedNative[cap]));
    }
    if (incoming.linto_native) {
        merged.linto_native = keepToken(incoming.linto_native, stored.linto_native);
    }
    return merged;
}

module.exports = (webserver) => {
    return [
    {
        path: '/sessions/:id',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const withCaptions = req.query.withCaptions !== 'false';
                const session = await getSessionResult(req.params.id, withCaptions);
                if (!session) {
                    return res.status(404).json({ error: 'Session not found' });
                }
                // getSessionResult already returns a scrubbed plain object.
                res.json(session);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/channels/:channelId',
        method: 'get',
        controller: async (req, res, next) => {
            const { id: sessionId, channelId } = req.params;
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;

            try {
                const session = await Model.Session.findByPk(sessionId);
                if (!session) {
                    return res.status(404).json({ error: 'Session not found' });
                }

                const channel = await Model.Channel.findOne({
                    where: { id: channelId, sessionId },
                    attributes: { exclude: CHANNEL_EXCLUDED_ATTRIBUTES }
                });
                if (!channel) {
                    return res.status(404).json({ error: 'Channel not found' });
                }

                // Compute the index (same logic as getSessionResult)
                const allChannels = await Model.Channel.findAll({
                    where: { sessionId },
                    attributes: ['id'],
                    order: [['id', 'ASC']]
                });
                channel.setDataValue('index', allChannels.findIndex(c => c.id === channel.id));

                // Retrieve paginated captions via the model method
                const captions = await Model.Channel.getPaginatedCaptions(
                    parseInt(channelId), { limit, offset }
                );

                const result = channel.toJSON();
                result.organizationId = session.organizationId;
                result.visibility = session.visibility;
                result.closedCaptions = captions.closedCaptions;
                result.totalClosedCaptions = captions.totalClosedCaptions;
                result.translatedCaptions = captions.translatedCaptions;
                result.totalTranslatedCaptions = captions.totalTranslatedCaptions;

                res.json(result);
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
            const excludeVisibility = req.query.excludeVisibility;
            const scheduleOn = req.query.scheduleOn;
            const endOn = req.query.endOn;

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

            if (excludeVisibility) {
                where.visibility = { ...where.visibility, [Model.Op.ne]: excludeVisibility };
            }

            if (scheduleOn && scheduleOn.before) {
                where.scheduleOn = { [Model.Op.lt]: new Date(scheduleOn.before) };
            }

            if (scheduleOn && scheduleOn.after) {
                where.scheduleOn = { [Model.Op.gt]: new Date(scheduleOn.after) };
            }

            if (endOn && endOn.before) {
                where.endOn = { [Model.Op.lt]: new Date(endOn.before) };
            }

            if (endOn && endOn.after) {
                where.endOn = { [Model.Op.gt]: new Date(endOn.after) };
            }

            try {
                const results = await Model.Session.findAndCountAll({
                    limit: limit,
                    offset: offset,
                    distinct: true,
                    attributes: { exclude: SESSION_EXCLUDED_ATTRIBUTES },
                    include: {
                        model: Model.Channel,
                        attributes: {
                            exclude: CHANNEL_EXCLUDED_ATTRIBUTES
                        },
                    },
                    where: where,
                    order: [[Model.Channel, 'id', 'ASC']]
                });

                // set channels index
                results.rows.forEach(session => {
                    session.channels.forEach((channel, index) => {
                        channel.setDataValue('index', index);
                    });
                });

                res.json({
                    sessions: results.rows.map(session => scrubNativeTokens(session.toJSON())),
                    totalItems: results.count
                });
            } catch (err) {
                next(err);
            }
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
            const transaction = await Model.sequelize.transaction();
            try {
                session = await Model.Session.create({
                    privateId: newPrivateId(),
                    status: req.body.scheduleOn ? 'on_schedule' : 'ready',
                    name: req.body.name || `New session ${new Date().toISOString()}`,
                    startTime: null,
                    endTime: null,
                    scheduleOn: req.body.scheduleOn || null,
                    endOn: req.body.endOn || null,
                    erroredOn: null,
                    owner: req.body.owner || null,
                    organizationId: req.body.organizationId || null,
                    visibility: req.body.visibility || 'private',
                    autoStart: req.body.autoStart || false,
                    autoEnd: req.body.autoEnd || false,
                    meta: req.body.meta || null
                }, { transaction });
                // Create channels
                for (const [index, channel] of channels.entries()) {
                    const validatedTranslations = validateTranslations(channel.translations);

                    const transcriberProfile = await resolveTranscriberProfile(channel.transcriberProfileId, transaction);
                    const keepAudio = channel.keepAudio ?? true;
                    // Audio quality invariant: an audio-only channel (no profile) is a "not live" mode,
                    // so its kept audio stays uncompressed (WAV) for an eventual offline transcription. See bots.js.
                    const compressAudio = transcriberProfile ? (channel.compressAudio ?? true) : false;
                    if (!compressAudio && !keepAudio) {
                        throw new ApiError(400, "Compress audio is not enabled and keep audio is not enabled on channel");
                    }

                    const languages = transcriberProfile ? transcriberProfile.config.languages.map(language => language.candidate) : [];
                    const translations = transcriberProfile ? await enrichTranslations(validatedTranslations, transcriberProfile) : validatedTranslations;
                    await Model.Channel.create({
                        keepAudio: keepAudio,
                        diarization: channel.diarization ?? false,
                        compressAudio: compressAudio,
                        // No profile: force live transcripts off (FakeTranscriber path).
                        enableLiveTranscripts: transcriberProfile ? (channel.enableLiveTranscripts ?? true) : false,
                        languages: languages, //array of BCP47 language tags from transcriber profile
                        translations: translations,
                        streamStatus: 'inactive',
                        sessionId: session.id,
                        transcriberProfileId: transcriberProfile ? transcriberProfile.id : null,
                        name: channel.name,
                        meta: channel.meta
                    }, { transaction });
                }
                await setChannelsEndpoints(session, transaction);
                await transaction.commit();

                // return the session with channels
                const result = await getSessionResult(session.id);
                logger.debug('Session created', result.id);
                webserver.emit('session-update')
                res.json(result);
            } catch (err) {
                logger.debug(err);
                await transaction.rollback();
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

            const { channels: updatedChannels } = req.body;
            const sessionAttributes = Object.fromEntries(
                Object.entries(req.body).filter(([k]) => ALLOWED_SESSION_FIELDS.includes(k))
            );
            // C6: `meta` is replaced wholesale, so re-inject the scrubbed (unreadable)
            // sub-keys from the stored row before writing.
            if ('meta' in sessionAttributes) {
                sessionAttributes.meta = mergeProtectedMeta(sessionAttributes.meta, session.meta);
            }


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

                        const updatedAttrs = pickAllowedChannelFields(updatedChannel);
                        const clearingProfile = 'transcriberProfileId' in updatedChannel && hasNoTranscriberProfile(updatedChannel.transcriberProfileId);

                        if (updatedChannel.translations) {
                            const validated = validateTranslations(updatedChannel.translations);
                            const profileId = clearingProfile ? null : (updatedChannel.transcriberProfileId || currentChannel.transcriberProfileId);
                            const profile = profileId ? await Model.TranscriberProfile.findByPk(profileId, { transaction }) : null;
                            updatedAttrs.translations = profile ? await enrichTranslations(validated, profile) : validated;
                        }

                        if (updatedChannel.compressAudio === false && updatedChannel.keepAudio === false) {
                            throw new ApiError(400, "Compress audio is not enabled and keep audio is not enabled on channel");
                        }

                        if (clearingProfile) {
                            // Switch the channel to audio-only: no live, and uncompressed audio
                            // (audio quality invariant, see bots.js).
                            updatedAttrs.transcriberProfileId = null;
                            updatedAttrs.languages = [];
                            updatedAttrs.enableLiveTranscripts = false;
                            updatedAttrs.compressAudio = false;
                        } else if (updatedChannel.transcriberProfileId) {
                            const transcriberProfile = await resolveTranscriberProfile(updatedChannel.transcriberProfileId, transaction);
                            updatedAttrs.languages = transcriberProfile.config.languages.map(language => language.candidate);
                            // Re-assigning a profile re-enables live unless the client explicitly opts out;
                            // mirrors the create path (default true with a profile). Without this, a channel
                            // previously switched to audio-only would keep enableLiveTranscripts=false and stay
                            // silent on the FakeTranscriber path despite having a real profile.
                            if (!('enableLiveTranscripts' in updatedChannel)) {
                                updatedAttrs.enableLiveTranscripts = true;
                            }
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

                    const validatedTranslations = validateTranslations(channel.translations);

                    const transcriberProfile = await resolveTranscriberProfile(channel.transcriberProfileId, transaction);
                    const keepAudio = channel.keepAudio ?? true;
                    // Audio quality invariant: an audio-only channel (no profile) is a "not live" mode,
                    // so its kept audio stays uncompressed (WAV) for an eventual offline transcription. See bots.js.
                    const compressAudio = transcriberProfile ? (channel.compressAudio ?? true) : false;
                    if (!compressAudio && !keepAudio) {
                        throw new ApiError(400, "Compress audio is not enabled and keep audio is not enabled on channel");
                    }

                    const languages = transcriberProfile ? transcriberProfile.config.languages.map(language => language.candidate) : [];
                    const translations = transcriberProfile ? await enrichTranslations(validatedTranslations, transcriberProfile) : validatedTranslations;

                    await Model.Channel.create({
                        keepAudio: keepAudio,
                        diarization: channel.diarization ?? false,
                        compressAudio: compressAudio,
                        // No profile: force live transcripts off (FakeTranscriber path).
                        enableLiveTranscripts: transcriberProfile ? (channel.enableLiveTranscripts ?? true) : false,
                        languages: languages, //array of BCP47 language tags from transcriber profile
                        translations: translations,
                        streamStatus: 'inactive',
                        sessionId: session.id,
                        transcriberProfileId: transcriberProfile ? transcriberProfile.id : null,
                        name: channel.name,
                        meta: channel.meta
                    }, { transaction });
                }

                await setChannelsEndpoints(session, transaction);
                await transaction.commit();

                // return the session with channels
                const result = await getSessionResult(session.id);
                logger.debug('Session updated', result.id);
                webserver.emit('session-update')
                res.json(result);
            } catch (err) {
                logger.debug(err);
                await transaction.rollback();
                return next(err)
            }
        }
    }, {
        path: '/sessions/:id',
        method: 'patch',
        controller: async (req, res, next) => {
            const sessionId = req.params.id;

            const session = await Model.Session.findByPk(sessionId);
            if (!session) {
                return res.status(404).json({ "error": `Session ${sessionId} not found` });
            }

            const sessionAttributes = Object.fromEntries(
                Object.entries(req.body).filter(([k]) => ALLOWED_SESSION_FIELDS.includes(k))
            );
            // C6: same full-replacement hazard as PUT — a PATCH that carries `meta`
            // replaces the whole JSON column, so re-inject the scrubbed sub-keys.
            if ('meta' in sessionAttributes) {
                sessionAttributes.meta = mergeProtectedMeta(sessionAttributes.meta, session.meta);
            }

            const transaction = await Model.sequelize.transaction();
            try {
                await Model.Session.update(sessionAttributes, {
                    transaction,
                    where: {id: session.id}
                });

                await transaction.commit();

                // return the session with channels
                const result = await getSessionResult(session.id);
                logger.debug('Session updated', result.id);
                webserver.emit('session-update')
                res.json(result);
            } catch (err) {
                logger.debug(err);
                await transaction.rollback();
                return next(err)
            }
        }
    }, {
        path: '/sessions/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const session = await Model.Session.findByPk(req.params.id);
                if (!session) {
                    return res.status(404).json({ error: 'Session not found' });
                }
                // Check if session is active or paused and "force" parameter is not true
                if (['active', 'paused'].includes(session.status) && req.query.force !== 'true') {
                    throw new ApiError(400, "Active or paused sessions cannot be deleted without force parameter");
                }
                await session.destroy();
                logger.debug('Session deleted', session.id);
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
                if (['active', 'paused'].includes(session.status) && req.query.force !== 'true') {
                    throw new ApiError(400, "Active or paused sessions cannot be stopped without force parameter");
                }

                const waitFinal = req.query.waitFinal === 'true';

                // If session is not active or force is true, proceed with update
                await Model.Session.update({
                    status: 'terminated',
                    endTime: new Date()
                }, {
                    where: {
                        'id': sessionId
                    }
                });
                if (!waitFinal) {
                    // Legacy behaviour, byte-for-byte: callers that do not opt in
                    // to the drain barrier get the channels forced inactive now.
                    await Model.Channel.update({
                        streamStatus: 'inactive'
                    }, {
                        where: {
                            'sessionId': sessionId
                        }
                    });
                }
                // Removing the session from the retained statuses broadcast makes
                // the transcribers force-cut any stream still open, triggering the
                // flush -> end-of-stream marker -> deactivate sequence.
                webserver.emit('session-update');

                if (waitFinal) {
                    // Drain barrier: wait until every channel has been deactivated
                    // by its transcriber. The Scheduler serializes per-channel
                    // commits (finals -> marker -> inactive), so once no channel is
                    // 'active' every published caption is committed and visible.
                    const timeoutMs = parseInt(process.env.SESSION_STOP_FLUSH_TIMEOUT_MS, 10) || 10000;
                    const deadline = Date.now() + timeoutMs;
                    let stillActive = await Model.Channel.count({
                        where: { sessionId, streamStatus: 'active' }
                    });
                    while (stillActive > 0 && Date.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                        stillActive = await Model.Channel.count({
                            where: { sessionId, streamStatus: 'active' }
                        });
                    }
                    if (stillActive > 0) {
                        logger.warn(`stop waitFinal: ${stillActive} channel(s) of session ${sessionId} still active after ${timeoutMs}ms — captions may be incomplete`);
                    }
                    // Normalize every still-open channel to inactive so the session is
                    // never left half-open (legacy parity: the old path forced ALL
                    // channels inactive unconditionally).
                    await Model.Channel.update(
                        { streamStatus: 'inactive' },
                        { where: { sessionId, streamStatus: { [Model.Op.ne]: 'inactive' } } }
                    );
                }

                const result = await getSessionResult(session.id);
                res.json(result);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/pause',
        method: 'put',
        controller: async (req, res, next) => {
            try {
                const sessionId = req.params.id;

                // Atomic active→paused transition. The previous
                // "findByPk → check status → update" pattern had a TOCTOU
                // race when two PUT /pause requests arrived in parallel:
                // both could observe status='active', both passed the
                // idempotence guard, both ran update(), and both emitted
                // session-paused — duplicating the MQTT event.
                // We move the guard into the UPDATE's WHERE clause so
                // only one row write actually transitions; the loser
                // sees affected=0 and re-reads to choose between the
                // idempotent branch (now-paused) and the 400 branch
                // (some other invalid status).
                const [affected] = await Model.Session.update(
                    { status: 'paused', pausedAt: new Date() },
                    { where: { id: sessionId, status: 'active' } }
                );

                if (affected === 0) {
                    const session = await Model.Session.findByPk(sessionId);
                    if (!session) {
                        throw new ApiError(404, `Session ${sessionId} not found`);
                    }
                    // Idempotent: a concurrent request (or earlier one)
                    // already paused this session.
                    if (session.status === 'paused') {
                        const result = await getSessionResult(session.id);
                        return res.json(result);
                    }
                    throw new ApiError(400, `Cannot pause session in status '${session.status}'. Only active sessions can be paused.`);
                }

                const session = await Model.Session.findByPk(sessionId);
                logger.info(`Pausing session ${sessionId} (org=${session.organizationId}, fromStatus=active)`);

                webserver.emit('session-update');
                webserver.emit('session-paused', session);

                const result = await getSessionResult(sessionId);
                res.json(result);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/resume',
        method: 'put',
        controller: async (req, res, next) => {
            try {
                const sessionId = req.params.id;

                // Symmetric atomic transition with /pause: only one
                // paused→active write succeeds, so concurrent PUT /resume
                // requests yield at most one session-resumed MQTT event.
                const [affected] = await Model.Session.update(
                    { status: 'active', pausedAt: null },
                    { where: { id: sessionId, status: 'paused' } }
                );

                if (affected === 0) {
                    const session = await Model.Session.findByPk(sessionId);
                    if (!session) {
                        throw new ApiError(404, `Session ${sessionId} not found`);
                    }
                    if (session.status === 'active') {
                        const result = await getSessionResult(session.id);
                        return res.json(result);
                    }
                    throw new ApiError(400, `Cannot resume session in status '${session.status}'. Only paused sessions can be resumed.`);
                }

                const session = await Model.Session.findByPk(sessionId);
                logger.info(`Resuming session ${sessionId} (org=${session.organizationId})`);

                webserver.emit('session-update');
                webserver.emit('session-resumed', session);

                const result = await getSessionResult(sessionId);
                res.json(result);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/clear',
        method: 'put',
        controller: async (req, res, next) => {
            try {
                const sessionId = req.params.id;
                const session = await Model.Session.findByPk(sessionId);
                if (!session) {
                    throw new ApiError(404, `Session ${sessionId} not found`);
                }

                // Allowed in pre/in-progress statuses. Terminated/on_schedule
                // are refused: nothing to clear in on_schedule (no captions yet)
                // and a terminated session is an immutable archive.
                const allowed = ['ready', 'active', 'paused'];
                if (!allowed.includes(session.status)) {
                    throw new ApiError(400, `Cannot clear session in status '${session.status}'. Only sessions in status ${allowed.join(', ')} can be cleared.`);
                }

                const channelIds = await getSessionChannelIds(sessionId);

                logger.info(`Clearing session ${sessionId} (org=${session.organizationId}, status=${session.status}, channels=${channelIds.length})`);

                if (channelIds.length > 0) {
                    await Model.sequelize.transaction(async (transaction) => {
                        await Promise.all([
                            Model.Caption.destroy({ where: { channelId: channelIds }, transaction }),
                            Model.TranslatedCaption.destroy({ where: { channelId: channelIds }, transaction }),
                            Model.Channel.update(
                                { lastSegmentId: 0 },
                                { where: { id: channelIds }, transaction }
                            ),
                        ]);
                    });
                }

                webserver.emit('session-update');
                webserver.emit('session-cleared', session, channelIds);

                const result = await getSessionResult(sessionId);
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

            // Organization scoping. The Studio proxy injects body.organizationId on
            // the per-organization route, so a Meeting Manager only ever purges
            // (or force-purges) the sessions of the organization in the path. The
            // administration route carries no organization and keeps the global
            // behaviour. A body-level scope always wins over a global purge: there is
            // no way to opt out of it once present.
            const organizationId = req.body && req.body.organizationId;
            if (organizationId !== undefined && organizationId !== null && organizationId !== '') {
                if (typeof organizationId !== 'string') {
                    return res.status(400).json({ error: 'organizationId must be a string' });
                }
                where.organizationId = organizationId;
            }
            const scope = where.organizationId ? `organization ${where.organizationId}` : 'all organizations';
            const msg = force ? `All sessions purged (${scope})` : `Terminated sessions purged (${scope})`;

            try {
                await Model.Session.destroy({
                    where: where
                });
                logger.debug(msg);
                webserver.emit('session-update')
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/sessions/:id/delete-captions',
        method: 'delete',
        controller: async (req, res, next) => {
            const sessionId = req.params.id;
            const { start_time, end_time } = req.query;
            const timeRegex = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

            if (start_time && !timeRegex.test(start_time)) {
              return res.status(400).json({ error: "Invalid start_time format. Expected HH:mm:ss or null" });
            }

            if (end_time && !timeRegex.test(end_time)) {
              return res.status(400).json({ error: "Invalid end_time format. Expected HH:mm:ss or null" });
            }

            function toSeconds(t) {
              const [h, m, s] = t.split(':');
              return +h * 3600 + +m * 60 + parseFloat(s);
            }

            const startSecs = start_time ? toSeconds(start_time) : null;
            const endSecs   = end_time   ? toSeconds(end_time)   : null;

            try {
                const session = await Model.Session.findByPk(sessionId);
                if (!session) {
                    throw new ApiError(404, 'Session not found');
                }

                // If no time bounds specified, nothing to delete (matches original behavior)
                if (startSecs === null && endSecs === null) {
                    const result = await getSessionResult(session.id, true);
                    return res.json(result);
                }

                const channelIds = await getSessionChannelIds(sessionId);

                if (channelIds.length === 0) {
                    const result = await getSessionResult(session.id, true);
                    return res.json(result);
                }

                // Wrap all deletions in a transaction for atomicity
                await Model.sequelize.transaction(async (transaction) => {
                    // Get per-channel base timestamps (earliest astart per channel)
                    // Each channel has its own time reference since channels can start at different times
                    //
                    // TIMELINE INVARIANT (holds for per-stream diarization too). A caption's
                    // position on the channel timeline is
                    //     (astart - MIN(astart) over the channel) + start
                    // which is only meaningful while `astart` is the origin of the flow that
                    // produced the caption and `start` is an offset FROM THAT ORIGIN — i.e.
                    // while astart + start is a real instant.
                    // Per-stream mode keeps that contract: each participant gets its own
                    // sub-ASR, so its own astart (provider.startedAt) AND its own offsets.
                    // The frame header's meetingTimeMs is NOT a second time base — it is
                    // only used to add back the silence the bot's VAD elided from that
                    // participant's audio (Transcriber/ASR/index.js `_applyTimeline`, which
                    // ADDS a gap to start/end and never re-origins them). So a late joiner's
                    // captions are correctly pushed forward here by their astart delta, and
                    // the legacy (mixed / SRT / RTMP / WS) path is untouched.
                    // Should a future change ever publish MEETING-origin offsets while
                    // keeping a per-participant astart, this rebase would double-count each
                    // participant's join offset — and so would every other consumer that
                    // places captions on a timeline. See doc/streaming-protocols.md
                    // ("Per-stream ingest — caption timeline").
                    const channelBases = await Model.sequelize.query(
                        `SELECT "channelId", MIN(astart) as base FROM captions WHERE "channelId" IN (:channelIds) GROUP BY "channelId"`,
                        { replacements: { channelIds }, type: Model.Sequelize.QueryTypes.SELECT, transaction }
                    );

                    if (channelBases.length === 0) return;

                    // Delete captions and translated_captions per-channel, each with its own base
                    const channelSegmentMap = {};
                    for (const { channelId: chId, base } of channelBases) {
                        const chBase = new Date(base);
                        let conditions = ['"channelId" = :chId'];
                        const replacements = { chId };

                        if (startSecs !== null) {
                            conditions.push(`(EXTRACT(EPOCH FROM (astart - :chBase)) + start) >= :startSecs`);
                            replacements.chBase = chBase;
                            replacements.startSecs = startSecs;
                        }
                        if (endSecs !== null) {
                            conditions.push(`COALESCE(
                                EXTRACT(EPOCH FROM (aend - :chBase)),
                                EXTRACT(EPOCH FROM (astart - :chBase)) + "end"
                            ) <= :endSecs`);
                            replacements.chBase = chBase;
                            replacements.endSecs = endSecs;
                        }

                        const whereClause = conditions.join(' AND ');

                        const deletedCaptions = await Model.sequelize.query(
                            `DELETE FROM captions WHERE ${whereClause} RETURNING "segmentId"`,
                            { replacements, type: Model.Sequelize.QueryTypes.SELECT, transaction }
                        );

                        const segIds = new Set(deletedCaptions.map(c => c.segmentId).filter(Boolean));
                        if (segIds.size > 0) {
                            channelSegmentMap[chId] = segIds;
                        }
                    }

                    // Delete corresponding translated_captions per-channel
                    for (const [chId, segIds] of Object.entries(channelSegmentMap)) {
                        await Model.TranslatedCaption.destroy({
                            where: { channelId: parseInt(chId), segmentId: [...segIds] },
                            transaction,
                        });
                    }
                });

                const result = await getSessionResult(session.id, true);
                res.json(result);
            } catch (err) {
                next(err);
            }
        }
    }];
};
