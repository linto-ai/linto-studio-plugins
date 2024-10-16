const debug = require('debug')('session-api:router:api-docs:transcriber_profiles');
const { Model } = require("live-srt-lib");

function isValidLocale(locale) {
    const pattern = /^[a-z]{2}-[A-Z]{2}$/;
    return pattern.test(locale);
}

const validateTranscriberProfile = (body) => {
    const config = body.config;
    if (!config) {
        return { error: 'TranscriberProfile object is missing', status: 400 };
    }
    if (!config.type || !config.name || !config.description || !config.languages || !config.languages.length) {
        return { error: 'TranscriberProfile object is missing required properties', status: 400 };
    }
    if (config.type === 'linto' && (!config.languages.every(lang => lang.candidate && lang.endpoint))) {
        return { error: 'Invalid Linto TranscriberProfile endpoint or languages', status: 400 };
    }
    if (config.type === 'microsoft' && (!config.languages.every(lang => isValidLocale(lang.candidate)) || !config.region || !config.key)) {
        return { error: 'Invalid Microsoft TranscriberProfile languages, region, or key', status: 400 };
    }
    if (config.languages.some(lang => typeof lang !== 'object')) {
        return { error: 'Invalid TranscriberProfile languages', status: 400 };
    }
    if (config.languages.some(lang => typeof lang.candidate !== 'string' || (lang.endpoint !== undefined && typeof lang.endpoint !== 'string'))) {
        return { error: 'Invalid TranscriberProfile language properties', status: 400 };
    }
};

const extendTranscriberProfile = (body) => {
    const config = body.config;
    const translationEnv = process.env[`ASR_AVAILABLE_TRANSLATIONS_${config.type.toUpperCase()}`];
    if (translationEnv) {
        body.config.availableTranslations = translationEnv.split(',');
    }
    else {
        body.config.availableTranslations = [];
    }

    const diarizationEnv = process.env[`ASR_HAS_DIARIZATION_${config.type.toUpperCase()}`];
    if (diarizationEnv) {
        body.config.hasDiarization = diarizationEnv.toUpperCase() == 'TRUE';
    }
    else {
        body.config.hasDiarization = false;
    }

    return body;
};

module.exports = (webserver) => {
    return [{
        path: '/transcriber_profiles',
        method: 'get',
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
        controller: async (req, res, next) => {
            try {
                const validationResult = validateTranscriberProfile(req.body);
                if (validationResult) {
                    return res.status(validationResult.status).send(validationResult.error);
                }
                const config = await Model.TranscriberProfile.create(extendTranscriberProfile(req.body));
                res.json(config);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles/:id',
        method: 'put',
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
