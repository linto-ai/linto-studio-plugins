const { Model, logger, Security } = require("live-srt-lib");
const { validateAzureCredentials } = require("./helpers/validateAzureCredentials");

function decryptAndMaskConfig(config) {
    if (!config) return config;
    try {
        // Decrypt the AES-256-CBC encrypted config first
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
        // GET /integration-configs — List platform configs
        path: '/integration-configs',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10;
            const offset = req.query.offset ?? 0;

            try {
                const where = { scope: 'platform' };

                const results = await Model.IntegrationConfig.findAndCountAll({
                    limit,
                    offset,
                    where,
                    include: [
                        { model: Model.MediaHost, as: 'mediaHosts' }
                    ]
                });

                const configs = results.rows.map(row => {
                    const json = row.toJSON();
                    json.config = decryptAndMaskConfig(json.config);
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
                const config = await Model.IntegrationConfig.findByPk(id, {
                    include: [
                        { model: Model.MediaHost, as: 'mediaHosts' }
                    ]
                });
                if (!config) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const json = config.toJSON();
                json.config = decryptAndMaskConfig(json.config);
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
                const { provider, config, setupProgress } = req.body;

                if (!provider) {
                    return res.status(400).json({ error: 'provider is required' });
                }

                let encryptedConfig = config;
                if (config) {
                    encryptedConfig = new Security().encrypt(typeof config === 'string' ? config : JSON.stringify(config));
                }

                const createData = {
                    scope: 'platform',
                    organizationId: null,
                    provider,
                    config: encryptedConfig,
                    setupProgress: setupProgress || {}
                };

                const integrationConfig = await Model.IntegrationConfig.create(createData);

                const json = integrationConfig.toJSON();
                json.config = decryptAndMaskConfig(json.config);
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

                const allowedFields = ['status', 'config', 'setupProgress'];
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

                // Publish MQTT notification for credential updates
                if (updates.config && webserver.mqttClient) {
                    webserver.mqttClient.publish(`integration-config/updated/${id}`, { configId: id }, 0, false, true);
                }

                const json = integrationConfig.toJSON();
                json.config = decryptAndMaskConfig(json.config);
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

                const result = await validateAzureCredentials(integrationConfig);
                res.json(result);
            } catch (err) {
                if (err.statusCode) {
                    return res.status(err.statusCode).json({ error: err.message });
                }
                next(err);
            }
        }
    }, {
        // GET /integration-configs/platform-status/:provider — Platform config status (no credentials)
        path: '/integration-configs/platform-status/:provider',
        method: 'get',
        controller: async (req, res, next) => {
            const { provider } = req.params;
            try {
                const platformConfig = await Model.IntegrationConfig.findOne({
                    where: {
                        scope: 'platform',
                        provider,
                        status: { [Model.Op.ne]: 'disabled' }
                    },
                    include: [
                        { model: Model.MediaHost, as: 'mediaHosts' }
                    ]
                });

                if (!platformConfig) {
                    return res.json({ exists: false });
                }

                const healthyCount = (platformConfig.mediaHosts || []).filter(
                    mh => mh.status === 'online'
                ).length;

                res.json({
                    exists: true,
                    status: platformConfig.status,
                    provider: platformConfig.provider,
                    mediaHostCount: (platformConfig.mediaHosts || []).length,
                    mediaHostsHealthy: healthyCount
                });
            } catch (err) {
                next(err);
            }
        }
    }];
};
