const { Model, logger, Security } = require("live-srt-lib");
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

function isValidLocale(locale) {
    const pattern = /^[a-z]{2}-[A-Z]{2}$/;
    return pattern.test(locale);
}

const validateTranscriberProfile = (body, update=false) => {
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
    if (config.type === 'microsoft' && (!config.languages.every(lang => isValidLocale(lang.candidate)) || !config.region || (!config.key && !update))) {
        return { error: 'Invalid Microsoft TranscriberProfile languages, region, or key', status: 400 };
    }
    if (config.type === 'amazon' && (!config.languages.every(lang => isValidLocale(lang.candidate)) || !config.region || !config.trustAnchorArn || !config.profileArn || !config.roleArn)) {
        // certificate and privateKey will be validated in the route handler after file upload
        return;
    }
    if (config.type === 'openai_streaming') {
        if (!config.endpoint || !config.model) {
            return { error: 'OpenAI Streaming profiles require endpoint and model', status: 400 };
        }
        if (config.protocol && !['vllm', 'openai'].includes(config.protocol)) {
            return { error: 'Invalid protocol. Must be "vllm" or "openai"', status: 400 };
        }
    }
    if (config.type === 'voxstral' && !config.endpoint) {
        return { error: 'Voxstral profiles require an endpoint', status: 400 };
    }
    if (config.languages.some(lang => typeof lang !== 'object')) {
        return { error: 'Invalid TranscriberProfile languages', status: 400 };
    }
    if (config.languages.some(lang => typeof lang.candidate !== 'string' || (lang.endpoint !== undefined && typeof lang.endpoint !== 'string'))) {
        return { error: 'Invalid TranscriberProfile language properties', status: 400 };
    }
};

const bundleAmazonCredentials = (certificate, privateKey, passphrase) => {
    // Bundle certificate, private key, and passphrase into a JSON string
    const bundle = JSON.stringify({
        certificate: certificate.toString('utf-8'),
        privateKey: privateKey.toString('utf-8'),
        passphrase: passphrase || ''
    });
    return new Security().encrypt(bundle);
};

const cryptTranscriberProfileKey = (body) => {
    if (body.config.key) {
        body.config.key = new Security().encrypt(body.config.key);
    }
    if (body.config.credentials) {
        body.config.credentials = new Security().encrypt(body.config.credentials);
    }
    if (body.config.apiKey) {
        body.config.apiKey = new Security().encrypt(body.config.apiKey);
    }

    return body;
}

const obfuscateTranscriberProfileKey = (transcriberProfile) => {
    if (transcriberProfile.config.key) {
        transcriberProfile.config.key = "Secret key is hidden";
    }
    if (transcriberProfile.config.credentials) {
        transcriberProfile.config.credentials = "Secret credentials are hidden";
    }
    if (transcriberProfile.config.apiKey) {
        transcriberProfile.config.apiKey = "Secret key is hidden";
    }
    return transcriberProfile;
}

const injectExternalTranslations = (profile, onlineTranslators) => {
    const config = profile.config;

    // discrete: from stored profile config (legacy string array, object array, or already-expanded object)
    const stored = config.availableTranslations || [];
    let discreteLangs;
    if (Array.isArray(stored)) {
        discreteLangs = stored.map(entry => typeof entry === 'string' ? entry : entry.target);
    } else {
        // Already in {discrete, external} format (saved back from frontend)
        discreteLangs = stored.discrete || [];
    }
    config.availableTranslations = {
        discrete: discreteLangs,
        external: onlineTranslators.map(t => ({ translator: t.name, languages: t.languages }))
    };

    return profile;
};

const extendTranscriberProfile = (body) => {
    const config = body.config;
    const translationEnv = process.env[`ASR_AVAILABLE_TRANSLATIONS_${config.type.toUpperCase()}`];
    if ('availableTranslations' in config) {
        if (!Array.isArray(config.availableTranslations) && config.availableTranslations.discrete) {
            // Frontend sent back expanded {discrete, external} format — convert to internal array
            body.config.availableTranslations = config.availableTranslations.discrete.map(lang => ({ target: lang.trim(), mode: 'discrete' }));
        } else if (Array.isArray(config.availableTranslations) && config.availableTranslations.length > 0 && typeof config.availableTranslations[0] === 'string') {
            // Legacy string array
            body.config.availableTranslations = config.availableTranslations.map(lang => ({ target: lang.trim(), mode: 'discrete' }));
        }
        // else keep as-is (already object format or empty)
    }
    else if (translationEnv) {
        body.config.availableTranslations = translationEnv.split(',').map(lang => ({ target: lang.trim(), mode: 'discrete' }));
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
            const organizationId = req.query.organizationId;
            const quickMeeting = req.query.quickMeeting;
            let where = {}

            if (organizationId) {
                where.organizationId = organizationId;
            }
            if (quickMeeting === "true") {
                where.quickMeeting = quickMeeting;
            }
            else if (quickMeeting === "false") {
                where.quickMeeting = quickMeeting;
            }

            try {
                const configs = await Model.TranscriberProfile.findAll({where});
                const obfuscatedConfigs = configs.map(cfg =>
                  obfuscateTranscriberProfileKey(cfg.toJSON())
                );
                const onlineTranslators = await Model.Translator.findAll({ where: { online: true } });
                const result = obfuscatedConfigs.map(cfg => injectExternalTranslations(cfg, onlineTranslators));
                res.json(result);
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
                const obfuscated = obfuscateTranscriberProfileKey(config.toJSON());
                const onlineTranslators = await Model.Translator.findAll({ where: { online: true } });
                res.json(injectExternalTranslations(obfuscated, onlineTranslators));
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles',
        method: 'post',
        middleware: [upload.fields([{ name: 'certificate', maxCount: 1 }, { name: 'privateKey', maxCount: 1 }])],
        controller: async (req, res, next) => {
            try {
                // Debug logging
                logger.debug(`POST /transcriber_profiles - req.body: ${JSON.stringify(req.body)}`);
                logger.debug(`POST /transcriber_profiles - req.files: ${JSON.stringify(Object.keys(req.files || {}))}`);

                // Handle multipart/form-data - config comes as a string
                if (req.body.config && typeof req.body.config === 'string') {
                    try {
                        req.body.config = JSON.parse(req.body.config);
                    } catch (parseErr) {
                        return res.status(400).send(`Invalid JSON in config field: ${parseErr.message}`);
                    }
                }

                // Ensure req.body has the expected structure for validation
                if (!req.body.config) {
                    return res.status(400).send(`Config field is required. Received body: ${JSON.stringify(req.body)}`);
                }

                if (req.body.config.type === 'amazon') {
                    // Validate certificate and privateKey files
                    if (!req.files || !req.files.certificate || !req.files.privateKey) {
                        return res.status(400).send('Amazon profiles require certificate and privateKey files');
                    }

                    // Bundle credentials
                    req.body.config.credentials = bundleAmazonCredentials(
                        req.files.certificate[0].buffer,
                        req.files.privateKey[0].buffer,
                        req.body.config.passphrase
                    );

                    // Remove separate fields (only store bundled credentials)
                    delete req.body.config.certificate;
                    delete req.body.config.privateKey;
                    delete req.body.config.passphrase;
                }

                const validationResult = validateTranscriberProfile(req.body);
                if (validationResult) {
                    return res.status(validationResult.status).send(validationResult.error);
                }
                const config = await Model.TranscriberProfile.create({
                        ...extendTranscriberProfile(cryptTranscriberProfileKey(req.body)),
                        meta: req.body.meta || null
                    });
                res.json(obfuscateTranscriberProfileKey(config));
            } catch (err) {
                logger.error(`Error creating transcriber profile: ${err.message}`);
                next(err);
            }
        }
    }, {
        path: '/transcriber_profiles/:id',
        method: 'put',
        middleware: [upload.fields([{ name: 'certificate', maxCount: 1 }, { name: 'privateKey', maxCount: 1 }])],
        controller: async (req, res, next) => {
            try {
                const config = await Model.TranscriberProfile.findByPk(req.params.id);
                if (!config) {
                    return res.status(404).send('Transcriber config not found');
                }

                // Check if config is provided in the request body
                if (!req.body.config) {
                    return res.status(400).send('Config object is required');
                }

                // Handle Amazon profile with file uploads
                if (req.body.config && typeof req.body.config === 'string') {
                    req.body.config = JSON.parse(req.body.config);
                }

                if (req.body.config && req.body.config.type === 'amazon' && req.files) {
                    // If certificate and privateKey files are provided, bundle them
                    if (req.files.certificate && req.files.privateKey) {
                        req.body.config.credentials = bundleAmazonCredentials(
                            req.files.certificate[0].buffer,
                            req.files.privateKey[0].buffer,
                            req.body.config.passphrase
                        );
                    }

                    // Remove separate fields (only store bundled credentials)
                    delete req.body.config.certificate;
                    delete req.body.config.privateKey;
                    delete req.body.config.passphrase;
                }

                // Merge existing config with partial update
                const mergedConfig = {
                    ...config.config,
                    ...req.body.config
                };

                // Handle API key encryption if a new key is provided
                if (req.body.config.key) {
                    mergedConfig.key = new Security().encrypt(req.body.config.key);
                }
                // Handle credentials encryption if new credentials are provided
                if (req.body.config.credentials) {
                    mergedConfig.credentials = new Security().encrypt(req.body.config.credentials);
                }
                // Handle apiKey encryption if a new apiKey is provided
                if (req.body.config.apiKey) {
                    mergedConfig.apiKey = new Security().encrypt(req.body.config.apiKey);
                }


                // Prepare the body with merged config and all other fields from request
                const body = {
                    ...req.body,
                    config: mergedConfig
                };

                // Apply extensions and update
                await config.update(extendTranscriberProfile(body));
                res.json(obfuscateTranscriberProfileKey(config));
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
