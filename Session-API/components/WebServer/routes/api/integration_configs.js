const { Model, logger, Security } = require("live-srt-lib");
const crypto = require("crypto");
const axios = require("axios");

function maskConfig(config) {
    if (!config) return config;
    try {
        const parsed = typeof config === 'string' ? JSON.parse(config) : config;
        if (parsed.clientSecret) {
            parsed.clientSecret = '***';
        }
        return parsed;
    } catch {
        return config;
    }
}

module.exports = (webserver) => {
    return [{
        // GET /integration-configs — List configs for organization
        path: '/integration-configs',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10;
            const offset = req.query.offset ?? 0;

            try {
                const where = {};
                if (req.query.organizationId) where.organizationId = req.query.organizationId;

                const results = await Model.IntegrationConfig.findAndCountAll({
                    limit,
                    offset,
                    where
                });

                const configs = results.rows.map(row => {
                    const json = row.toJSON();
                    json.config = maskConfig(json.config);
                    return json;
                });

                res.json({
                    configs,
                    totalItems: results.count
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /integration-configs/:id — Detail
        path: '/integration-configs/:id',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const config = await Model.IntegrationConfig.findByPk(id);
                if (!config) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const json = config.toJSON();
                json.config = maskConfig(json.config);
                res.json(json);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs — Create
        path: '/integration-configs',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { organizationId, provider, config, setupProgress } = req.body;
                if (!organizationId || !provider) {
                    return res.status(400).json({ error: 'organizationId and provider are required' });
                }

                let encryptedConfig = config;
                if (config) {
                    encryptedConfig = new Security().encrypt(typeof config === 'string' ? config : JSON.stringify(config));
                }

                const integrationConfig = await Model.IntegrationConfig.create({
                    organizationId,
                    provider,
                    config: encryptedConfig,
                    setupProgress: setupProgress || {}
                });

                const json = integrationConfig.toJSON();
                json.config = maskConfig(json.config);
                res.status(201).json(json);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // PUT /integration-configs/:id — Update
        path: '/integration-configs/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const allowedFields = ['status', 'config', 'setupProgress', 'mediaHostDns'];
                const updates = {};
                for (const field of allowedFields) {
                    if (req.body[field] !== undefined) {
                        updates[field] = req.body[field];
                    }
                }

                if (updates.config) {
                    updates.config = new Security().encrypt(typeof updates.config === 'string' ? updates.config : JSON.stringify(updates.config));
                }

                await integrationConfig.update(updates);

                const json = integrationConfig.toJSON();
                json.config = maskConfig(json.config);
                res.json(json);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // DELETE /integration-configs/:id — Soft delete
        path: '/integration-configs/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                await integrationConfig.update({ status: 'disabled' });
                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs/:id/validate-credentials — Test OAuth2 token
        path: '/integration-configs/:id/validate-credentials',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const decryptedConfig = new Security().safeDecrypt(integrationConfig.config);
                let parsed;
                try {
                    parsed = JSON.parse(decryptedConfig);
                } catch {
                    return res.status(400).json({ error: 'Invalid config format' });
                }

                const { tenantId, clientId, clientSecret } = parsed;
                if (!tenantId || !clientId || !clientSecret) {
                    return res.status(400).json({ error: 'Config must contain tenantId, clientId, and clientSecret' });
                }

                try {
                    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
                    const response = await axios.post(tokenUrl, new URLSearchParams({
                        grant_type: 'client_credentials',
                        client_id: clientId,
                        client_secret: clientSecret,
                        scope: 'https://graph.microsoft.com/.default'
                    }), {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });

                    res.json({ valid: true, expiresIn: response.data.expires_in });
                } catch (err) {
                    const errorMsg = err.response?.data?.error_description || err.message;
                    res.json({ valid: false, error: errorMsg });
                }
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs/:id/generate-provisioning-token
        path: '/integration-configs/:id/generate-provisioning-token',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const token = crypto.randomBytes(32).toString('hex');
                await integrationConfig.update({ provisioningToken: token });

                res.json({ provisioningToken: token });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /register-media-host — No org auth, uses provisioningToken
        path: '/register-media-host',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { token, dns } = req.body;
                if (!token) {
                    return res.status(400).json({ error: 'token is required' });
                }

                const integrationConfig = await Model.IntegrationConfig.findOne({
                    where: { provisioningToken: token }
                });

                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Invalid provisioning token' });
                }

                const updates = {
                    provisioningToken: null,
                    setupProgress: { ...integrationConfig.setupProgress, mediaHost: true }
                };
                if (dns) {
                    updates.mediaHostDns = dns;
                }

                await integrationConfig.update(updates);

                webserver.emit('mediaHostRegistered', integrationConfig.id);

                res.json({
                    mqtt: {
                        host: process.env.BROKER_HOST,
                        port: process.env.BROKER_PORT,
                        username: process.env.BROKER_USERNAME || '',
                        password: process.env.BROKER_PASSWORD || ''
                    },
                    integrationConfigId: integrationConfig.id
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs/:id/generate-deploy-link
        path: '/integration-configs/:id/generate-deploy-link',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                if (!integrationConfig.provisioningToken) {
                    return res.status(400).json({ error: 'Generate a provisioning token first' });
                }

                const sessionApiCallbackUrl = process.env.SESSION_API_HOST || `http://localhost:${process.env.SESSION_API_WEBSERVER_HTTP_PORT || 8000}`;
                const templateUrl = 'https://raw.githubusercontent.com/linagora/emeeting-media-host/main/azuredeploy.json';
                const deployLink = `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(templateUrl)}` +
                    `?provisioningToken=${encodeURIComponent(integrationConfig.provisioningToken)}` +
                    `&sessionApiCallbackUrl=${encodeURIComponent(sessionApiCallbackUrl)}`;

                res.json({ deployLink });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs/:id/health-report
        path: '/integration-configs/:id/health-report',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                await integrationConfig.update({
                    lastHealthCheck: new Date(),
                    healthStatus: req.body
                });

                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }];
};
