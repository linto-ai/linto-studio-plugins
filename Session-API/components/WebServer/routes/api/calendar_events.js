const { Model, logger, getPlatformConfig, getDecryptedCredentials } = require("live-srt-lib");
const { Op } = Model;
const axios = require("axios");

module.exports = (webserver) => {
    return [{
        // GET /calendar-events — List events with filters
        path: '/calendar-events',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = parseInt(req.query.limit) || 10;
            const offset = parseInt(req.query.offset) || 0;

            try {
                const where = {};
                if (req.query.organizationId) where.organizationId = req.query.organizationId;
                if (req.query.graphUserId) where['$calendarSubscription.graphUserId$'] = req.query.graphUserId;
                if (req.query.status) where.status = req.query.status;

                if (req.query.from || req.query.to) {
                    where.startDateTime = {};
                    if (req.query.from) where.startDateTime[Op.gte] = new Date(req.query.from);
                    if (req.query.to) where.startDateTime[Op.lte] = new Date(req.query.to);
                }

                const results = await Model.MsTeamsEvent.findAndCountAll({
                    limit,
                    offset,
                    where,
                    include: [{
                        model: Model.CalendarSubscription,
                        attributes: { exclude: ['studioToken'] }
                    }],
                    order: [['startDateTime', 'DESC']]
                });

                res.json({
                    events: results.rows,
                    totalItems: results.count
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /calendar-events/stats — KPIs
        path: '/calendar-events/stats',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const now = new Date();
                const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

                const periodFrom = req.query.from ? new Date(req.query.from) : startOfDay;
                const periodTo = req.query.to ? new Date(req.query.to) : endOfDay;

                const [activeSubscriptions, totalEvents, transcribedEvents] = await Promise.all([
                    Model.CalendarSubscription.count({ where: { status: 'active' } }),
                    Model.MsTeamsEvent.count({
                        where: { startDateTime: { [Op.gte]: periodFrom, [Op.lte]: periodTo } }
                    }),
                    Model.MsTeamsEvent.count({
                        where: {
                            status: 'transcribed',
                            startDateTime: { [Op.gte]: periodFrom, [Op.lte]: periodTo }
                        }
                    })
                ]);

                res.json({
                    activeSubscriptions,
                    meetingsInPeriod: totalEvents,
                    transcribedInPeriod: transcribedEvents,
                    coverageRate: totalEvents > 0 ? Math.round((transcribedEvents / totalEvents) * 100) : 0
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /calendar-events/:id — Detail
        path: '/calendar-events/:id',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const event = await Model.MsTeamsEvent.findByPk(id, {
                    include: [{
                        model: Model.CalendarSubscription,
                        attributes: { exclude: ['studioToken'] }
                    }]
                });

                if (!event) {
                    return res.status(404).json({ error: 'Calendar event not found' });
                }

                res.json(event);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /calendar-subscriptions/:id/health — Subscription health check
        path: '/calendar-subscriptions/:id/health',
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

                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

                const [lastEvent, recentEventCount] = await Promise.all([
                    Model.MsTeamsEvent.findOne({
                        where: { calendarSubscriptionId: id },
                        order: [['startDateTime', 'DESC']]
                    }),
                    Model.MsTeamsEvent.count({
                        where: {
                            calendarSubscriptionId: id,
                            startDateTime: { [Op.gte]: sevenDaysAgo }
                        }
                    })
                ]);

                res.json({
                    graphSubscriptionExpiry: subscription.graphSubscriptionExpiry,
                    lastActivity: lastEvent ? lastEvent.startDateTime : null,
                    recentEventsCount: recentEventCount
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /calendar-subscriptions/:id/refresh — Force Graph subscription refresh
        path: '/calendar-subscriptions/:id/refresh',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const subscription = await Model.CalendarSubscription.findByPk(id);
                if (!subscription) {
                    return res.status(404).json({ error: 'Calendar subscription not found' });
                }

                webserver.emit('refreshCalendarSubscription', id);

                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /graph-users?search=... — Search Microsoft Graph users
        path: '/graph-users',
        method: 'get',
        controller: async (req, res, next) => {
            const { search } = req.query;
            if (!search || search.length < 2) {
                return res.status(400).json({ error: 'search parameter is required (min 2 characters)' });
            }

            try {
                const platformConfig = await getPlatformConfig('teams');
                if (!platformConfig) {
                    return res.status(404).json({ error: 'No Teams platform integration config found' });
                }

                const decrypted = getDecryptedCredentials(platformConfig);
                if (!decrypted) {
                    return res.status(500).json({ error: 'Failed to decrypt integration config credentials' });
                }

                const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
                const { tenantId, clientId, clientSecret } = parsed;

                // Get OAuth2 token
                const tokenResponse = await axios.post(
                    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
                    new URLSearchParams({
                        grant_type: 'client_credentials',
                        client_id: clientId,
                        client_secret: clientSecret,
                        scope: 'https://graph.microsoft.com/.default'
                    }),
                    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
                );

                const accessToken = tokenResponse.data.access_token;

                // Search users via Graph API
                const graphResponse = await axios.get(
                    `https://graph.microsoft.com/v1.0/users`,
                    {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        params: {
                            $filter: `startsWith(displayName,'${search}') or startsWith(mail,'${search}')`,
                            $select: 'id,displayName,mail',
                            $top: 20
                        }
                    }
                );

                res.json({
                    users: (graphResponse.data.value || []).map(u => ({
                        id: u.id,
                        displayName: u.displayName,
                        mail: u.mail
                    }))
                });
            } catch (err) {
                if (err.response?.status === 401) {
                    return res.status(401).json({ error: 'Azure credentials are invalid or expired' });
                }
                next(err);
            }
        }
    }];
};
