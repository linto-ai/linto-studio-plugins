const debug = require('debug')('session-api:router:api-docs:transcriber_profiles');
const { Model } = require("live-srt-lib");

const validateTranscriberProfile = (body) => {
    const config = body.config;
    if (!config) {
        return { error: 'TranscriberProfile object is missing', status: 400 };
    }
    if (!config.type || !config.name || !config.description || !config.languages || !config.languages.length) {
        return { error: 'TranscriberProfile object is missing required properties', status: 400 };
    }
    if (config.type !== 'linto' && config.type !== 'microsoft') {
        return { error: `Invalid TranscriberProfile type: ${config.type}`, status: 400 };
    }
    if (config.type === 'linto' && (!config.endpoint || typeof config.endpoint !== 'string')) {
        return { error: 'Invalid Linto TranscriberProfile endpoint', status: 400 };
    }
    if (config.type === 'microsoft' && (!config.key || typeof config.key !== 'string' || !config.region || typeof config.region !== 'string')) {
        return { error: 'Invalid Microsoft TranscriberProfile key or region', status: 400 };
    }
    if (config.languages.some(lang => typeof lang !== 'string')) {
        return { error: 'Invalid TranscriberProfile languages', status: 400 };
    }
    if (config.languages.includes('*') && config.languages.length > 1) {
        return { error: 'Invalid TranscriberProfile languages: wildcard cannot be combined with other languages', status: 400 };
    }
};

module.exports = (webserver) => {
    return [{
        path: '/transcriber_profiles',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const configs = await Model.TranscriberProfile.findAll();
                res.json(configs);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles/:id',
        method: 'get',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const config = await Model.TranscriberProfile.findByPk(req.params.id);
                if (!config) {
                    return res.status(404).send('Transcriber config not found');
                }
                res.json(config);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles',
        method: 'post',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const validationResult = validateTranscriberProfile(req.body);
                if (validationResult) {
                    return res.status(validationResult.status).send(validationResult.error);
                }
                const config = await Model.TranscriberProfile.create(req.body);
                res.json(config);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles/:id',
        method: 'put',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const config = await Model.TranscriberProfile.findByPk(req.params.id);
                if (!config) {
                    return res.status(404).send('Transcriber config not found');
                }
                const validationResult = validateTranscriberProfile(req.body);
                if (validationResult) {
                    return res.status(validationResult.status).send(validationResult.error);
                }
                await config.update(req.body);
                res.json(config);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles/:id',
        method: 'delete',
        requireAuth: false,
        controller: async (req, res, next) => {
            try {
                const config = await Model.TranscriberProfile.findByPk(req.params.id);
                if (!config) {
                    return res.status(404).send('Transcriber config not found');
                }
                await config.destroy();
                res.json(config);
            } catch (err) {
                next(err);
            }
        }
    }];
};