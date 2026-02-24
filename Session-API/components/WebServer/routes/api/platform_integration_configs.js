const { Model, Security, logger } = require("live-srt-lib");
const { validateAzureCredentials } = require("./helpers/validateAzureCredentials");

function decryptAndMaskConfig(config) {
    if (!config) return config;
    try {
        const security = new Security();
        const decrypted = security.safeDecrypt(config);
        const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
        if (parsed.clientSecret) {
            parsed.clientSecret = '***';
        }
        return parsed;
    } catch {
        return null;
    }
}

module.exports = (webserver) => {
    return [{
        // GET /integration-configs/platform — List all platform configs
        path: '/integration-configs/platform',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const configs = await Model.IntegrationConfig.findAll({
                    where: { scope: 'platform' },
                    include: [
                        { model: Model.MediaHost, as: 'mediaHosts' }
                    ]
                });

                const results = configs.map(c => {
                    const json = c.toJSON();
                    json.config = decryptAndMaskConfig(json.config);
                    return json;
                });

                res.json({ configs: results });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs/platform — Create a platform config
        path: '/integration-configs/platform',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { provider, config, setupProgress } = req.body;
                if (!provider) {
                    return res.status(400).json({ error: 'provider is required' });
                }

                let encryptedConfig = config;
                if (config) {
                    encryptedConfig = new Security().encrypt(typeof config === 'string' ? config : JSON.stringify(config));
                }

                const integrationConfig = await Model.IntegrationConfig.create({
                    scope: 'platform',
                    organizationId: null,
                    provider,
                    config: encryptedConfig,
                    setupProgress: setupProgress || {}
                });

                const json = integrationConfig.toJSON();
                json.config = decryptAndMaskConfig(json.config);
                res.status(201).json(json);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /integration-configs/platform/:id — Detail with credentials (super-admin)
        path: '/integration-configs/platform/:id',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const config = await Model.IntegrationConfig.findOne({
                    where: { id, scope: 'platform' },
                    include: [
                        { model: Model.MediaHost, as: 'mediaHosts' }
                    ]
                });

                if (!config) {
                    return res.status(404).json({ error: 'Platform integration config not found' });
                }

                const json = config.toJSON();
                json.config = decryptAndMaskConfig(json.config); // Masked but visible to super-admin
                res.json(json);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // PUT /integration-configs/platform/:id — Update (credentials, lock, status)
        path: '/integration-configs/platform/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const config = await Model.IntegrationConfig.findOne({
                    where: { id, scope: 'platform' }
                });

                if (!config) {
                    return res.status(404).json({ error: 'Platform integration config not found' });
                }

                const allowedFields = ['status', 'config', 'setupProgress', 'allowOrganizationOverride'];
                const updates = {};
                for (const field of allowedFields) {
                    if (req.body[field] !== undefined) {
                        updates[field] = req.body[field];
                    }
                }

                if (updates.config) {
                    updates.config = new Security().encrypt(typeof updates.config === 'string' ? updates.config : JSON.stringify(updates.config));
                }

                await config.update(updates);

                // Publish MQTT notification for credential updates
                if (updates.config && webserver.mqttClient) {
                    webserver.mqttClient.publish(`integration-config/updated/${id}`, { configId: id }, 0, false, true);
                }

                const json = config.toJSON();
                json.config = decryptAndMaskConfig(json.config);
                res.json(json);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // DELETE /integration-configs/platform/:id — Soft delete
        path: '/integration-configs/platform/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const config = await Model.IntegrationConfig.findOne({
                    where: { id, scope: 'platform' }
                });

                if (!config) {
                    return res.status(404).json({ error: 'Platform integration config not found' });
                }

                await config.update({ status: 'disabled' });
                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /integration-configs/platform/:id/validate-credentials — Test OAuth2 token (platform scope)
        path: '/integration-configs/platform/:id/validate-credentials',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const config = await Model.IntegrationConfig.findOne({
                    where: { id, scope: 'platform' }
                });

                if (!config) {
                    return res.status(404).json({ error: 'Platform integration config not found' });
                }

                const result = await validateAzureCredentials(config);
                res.json(result);
            } catch (err) {
                if (err.statusCode) {
                    return res.status(err.statusCode).json({ error: err.message });
                }
                next(err);
            }
        }
    }, {
        // GET /integration-configs/platform/:provider/usage — Stats: nb orgs inheriting, nb orgs with own config
        path: '/integration-configs/platform/:provider/usage',
        method: 'get',
        controller: async (req, res, next) => {
            const { provider } = req.params;
            try {
                // Count orgs with their own active config for this provider
                const orgConfigs = await Model.IntegrationConfig.findAll({
                    where: {
                        scope: 'organization',
                        provider,
                        status: { [Model.Op.ne]: 'disabled' }
                    },
                    attributes: ['organizationId']
                });

                const orgIds = orgConfigs.map(c => c.organizationId);

                // Check if platform config exists
                const platformConfig = await Model.IntegrationConfig.findOne({
                    where: {
                        scope: 'platform',
                        provider,
                        status: { [Model.Op.ne]: 'disabled' }
                    }
                });

                res.json({
                    provider,
                    platformConfigExists: !!platformConfig,
                    platformConfigId: platformConfig?.id || null,
                    organizationsWithOwnConfig: orgIds.length,
                    organizationIds: orgIds
                });
            } catch (err) {
                next(err);
            }
        }
    }];
};
