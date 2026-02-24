const { Model, logger, Security, canOrganizationOverride } = require("live-srt-lib");
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
        // GET /integration-configs — List configs for organization
        // If organizationId is provided without scope, include both org configs AND platform config (without credentials)
        path: '/integration-configs',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10;
            const offset = req.query.offset ?? 0;

            try {
                const where = {};
                if (req.query.organizationId) where.organizationId = req.query.organizationId;
                if (req.query.scope) where.scope = req.query.scope;

                // Fetch organization configs
                const results = await Model.IntegrationConfig.findAndCountAll({
                    limit,
                    offset,
                    where: {
                        ...where,
                        scope: where.scope || 'organization'
                    },
                    include: [
                        { model: Model.MediaHost, as: 'mediaHosts' }
                    ]
                });

                const configs = results.rows.map(row => {
                    const json = row.toJSON();
                    json.config = decryptAndMaskConfig(json.config);
                    return json;
                });

                // If organizationId is provided and no explicit scope filter,
                // also include platform configs (without credentials)
                let platformConfigs = [];
                if (req.query.organizationId && !req.query.scope) {
                    const platformResults = await Model.IntegrationConfig.findAll({
                        where: {
                            scope: 'platform',
                            status: { [Model.Op.ne]: 'disabled' }
                        },
                        include: [
                            { model: Model.MediaHost, as: 'mediaHosts' }
                        ]
                    });

                    platformConfigs = platformResults.map(row => {
                        const json = row.toJSON();
                        json.config = null; // Mask ALL credentials for platform configs
                        return json;
                    });
                }

                res.json({
                    configs: [...configs, ...platformConfigs],
                    totalItems: results.count + platformConfigs.length
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
                // Platform configs: mask all credentials for org admins
                if (json.scope === 'platform') {
                    json.config = null;
                } else {
                    json.config = decryptAndMaskConfig(json.config);
                }
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
                const { organizationId, provider, config, setupProgress, scope } = req.body;
                const effectiveScope = scope || 'organization';

                if (effectiveScope === 'organization') {
                    if (!organizationId || !provider) {
                        return res.status(400).json({ error: 'organizationId and provider are required' });
                    }

                    // Check if organization can override platform config
                    const canOverride = await canOrganizationOverride(organizationId, provider);
                    if (!canOverride) {
                        return res.status(403).json({ error: 'Platform configuration is locked. Organization cannot override.' });
                    }
                } else if (effectiveScope === 'platform') {
                    if (organizationId) {
                        return res.status(400).json({ error: 'Platform configs must not have an organizationId' });
                    }
                    if (!provider) {
                        return res.status(400).json({ error: 'provider is required' });
                    }
                } else {
                    return res.status(400).json({ error: 'scope must be organization or platform' });
                }

                let encryptedConfig = config;
                if (config) {
                    encryptedConfig = new Security().encrypt(typeof config === 'string' ? config : JSON.stringify(config));
                }

                const createData = {
                    scope: effectiveScope,
                    organizationId: effectiveScope === 'platform' ? null : organizationId,
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
                    allowOrganizationOverride: platformConfig.allowOrganizationOverride,
                    mediaHostCount: (platformConfig.mediaHosts || []).length,
                    mediaHostsHealthy: healthyCount
                });
            } catch (err) {
                next(err);
            }
        }
    }];
};
