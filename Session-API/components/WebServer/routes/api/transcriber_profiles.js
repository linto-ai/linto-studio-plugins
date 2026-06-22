const { Model, logger, Security } = require("live-srt-lib");
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
// Pure validation/crypto/extension helpers live in a sibling module so the unit
// tests can exercise the exact same code the route runs (no re-implementation).
const {
    validateTranscriberProfile,
    bundleAmazonCredentials,
    cryptTranscriberProfileKey,
    obfuscateTranscriberProfileKey,
    injectExternalTranslations,
    extendTranscriberProfile,
} = require('./transcriber_profiles.helpers');

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
                    return res.status(404).json({ error: 'Transcriber config not found' });
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
                        return res.status(400).json({ error: `Invalid JSON in config field: ${parseErr.message}` });
                    }
                }

                // Ensure req.body has the expected structure for validation
                if (!req.body.config) {
                    return res.status(400).json({ error: `Config field is required. Received body: ${JSON.stringify(req.body)}` });
                }

                if (req.body.config.type === 'amazon') {
                    // Validate certificate and privateKey files
                    if (!req.files || !req.files.certificate || !req.files.privateKey) {
                        return res.status(400).json({ error: 'Amazon profiles require certificate and privateKey files' });
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
                    return res.status(validationResult.status).json({ error: validationResult.error });
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
                    return res.status(404).json({ error: 'Transcriber config not found' });
                }

                // Check if config is provided in the request body
                if (!req.body.config) {
                    return res.status(400).json({ error: 'Config object is required' });
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
                    return res.status(404).json({ error: 'Transcriber config not found' });
                }
                await config.destroy();
                res.json(config);
            } catch (err) {
                next(err);
            }
        }
    }];
};
