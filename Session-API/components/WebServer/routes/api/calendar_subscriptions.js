const { Model, logger } = require("live-srt-lib")
const axios = require("axios")

const MSTEAMS_SCHEDULER_BASE_URL = process.env.MSTEAMS_SCHEDULER_BASE_URL

module.exports = (webserver) => {
    return [{
        path: '/calendar-subscriptions',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10
            const offset = req.query.offset ?? 0

            try {
                const results = await Model.CalendarSubscription.findAndCountAll({
                    limit: limit,
                    offset: offset,
                    attributes: { exclude: ['studioToken'] }
                });

                res.json({
                    subscriptions: results.rows,
                    totalItems: results.count
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/calendar-subscriptions/:id',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const subscription = await Model.CalendarSubscription.findByPk(id, {
                    attributes: { exclude: ['studioToken'] }
                });
                if (!subscription) {
                    return res.status(404).json({ error: 'Calendar subscription not found' });
                }
                res.json(subscription);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/calendar-subscriptions',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { graphUserId, studioToken, organizationId, transcriberProfileId } = req.body;
                if (!graphUserId || !studioToken || !organizationId || !transcriberProfileId) {
                    return res.status(400).json({ error: 'graphUserId, studioToken, organizationId, and transcriberProfileId are required' });
                }

                // Validate studio token via MS-Teams-Scheduler
                try {
                    const response = await axios.post(`${MSTEAMS_SCHEDULER_BASE_URL}/validate-token`, { studioToken });
                    if (response.data.orgRole < 3) {
                        return res.status(403).json({ error: 'Insufficient permissions: studio token does not have meeting creation rights (role >= 3 required)' });
                    }
                } catch (err) {
                    if (err.response) {
                        logger.warn(`[Session-API] Studio token validation failed: ${err.response.data?.error}`);
                        return res.status(err.response.status).json({ error: err.response.data?.error || 'Token validation failed' });
                    }
                    logger.error(`[Session-API] MS-Teams-Scheduler unreachable: ${err.message}`);
                    return res.status(502).json({ error: 'Token validation service unavailable' });
                }

                const profile = await Model.TranscriberProfile.findByPk(transcriberProfileId);
                if (!profile) {
                    return res.status(404).json({ error: 'Transcriber profile not found' });
                }

                const subscription = await Model.CalendarSubscription.create({
                    graphUserId,
                    studioToken,
                    organizationId,
                    transcriberProfileId,
                    translations: req.body.translations,
                    diarization: req.body.diarization,
                    keepAudio: req.body.keepAudio,
                    enableDisplaySub: req.body.enableDisplaySub,
                    createdBy: req.body.createdBy,
                    status: 'pending'
                });

                webserver.emit('createCalendarSubscription', subscription.id);

                const response = subscription.toJSON();
                delete response.studioToken;
                res.status(201).json(response);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/calendar-subscriptions/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const subscription = await Model.CalendarSubscription.findByPk(id);
                if (!subscription) {
                    return res.status(404).json({ error: 'Calendar subscription not found' });
                }

                const allowedFields = ['graphUserId', 'organizationId', 'transcriberProfileId',
                    'translations', 'diarization', 'keepAudio', 'enableDisplaySub', 'createdBy'];
                const updates = {};
                for (const field of allowedFields) {
                    if (req.body[field] !== undefined) {
                        updates[field] = req.body[field];
                    }
                }

                if (updates.transcriberProfileId) {
                    const profile = await Model.TranscriberProfile.findByPk(updates.transcriberProfileId);
                    if (!profile) {
                        return res.status(404).json({ error: 'Transcriber profile not found' });
                    }
                }

                await subscription.update(updates);

                const response = subscription.toJSON();
                delete response.studioToken;
                res.json(response);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/calendar-subscriptions/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const subscription = await Model.CalendarSubscription.findByPk(id);
                if (!subscription) {
                    return res.status(404).json({ error: 'Calendar subscription not found' });
                }

                await subscription.update({ status: 'disabled' });
                webserver.emit('deleteCalendarSubscription', subscription.id);

                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }];
};
