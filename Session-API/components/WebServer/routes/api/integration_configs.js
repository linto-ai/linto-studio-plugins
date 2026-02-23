const { Model, logger, Security } = require("live-srt-lib");
const crypto = require("crypto");
const axios = require("axios");
const dns = require("dns");
const net = require("net");
const fs = require("fs");
const path = require("path");

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

const setupScriptTemplate = fs.readFileSync(path.join(__dirname, 'setup-manual.ps1.template'), 'utf8');

function generateSetupScript(fqdn, sslMode, provisioningToken, sessionApiCallbackUrl, pfxPath) {
    const sslParam = sslMode === 'pfx' ? 'pfx' : 'letsencrypt';
    const packageUrl = process.env.TEAMS_MEDIA_BOT_PACKAGE_URL || '';
    const packageSha256 = process.env.TEAMS_MEDIA_BOT_PACKAGE_SHA256 || '';
    return setupScriptTemplate
        .replace(/\{\{FQDN\}\}/g, fqdn)
        .replace(/\{\{PROVISIONING_TOKEN\}\}/g, provisioningToken)
        .replace(/\{\{SESSION_API_CALLBACK_URL\}\}/g, sessionApiCallbackUrl)
        .replace(/\{\{SSL_MODE\}\}/g, sslParam)
        .replace(/\{\{PFX_PATH\}\}/g, pfxPath || '')
        .replace(/\{\{PACKAGE_URL\}\}/g, packageUrl)
        .replace(/\{\{PACKAGE_SHA256\}\}/g, packageSha256);
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

                const allowedFields = ['status', 'config', 'setupProgress', 'mediaHostDns', 'deploymentMode', 'manualConfig'];
                const updates = {};
                for (const field of allowedFields) {
                    if (req.body[field] !== undefined) {
                        updates[field] = req.body[field];
                    }
                }

                if (updates.deploymentMode !== undefined && !['azure', 'manual'].includes(updates.deploymentMode)) {
                    return res.status(400).json({ error: 'deploymentMode must be azure or manual' });
                }
                if (updates.manualConfig && (!updates.manualConfig.fqdn || typeof updates.manualConfig.fqdn !== 'string' || !updates.manualConfig.fqdn.trim())) {
                    return res.status(400).json({ error: 'manualConfig.fqdn is required and must be a non-empty string' });
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
        // GET /integration-configs/:id/setup-script
        path: '/integration-configs/:id/setup-script',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const { token } = req.query;
                if (!token) {
                    return res.status(403).json({ error: 'Provisioning token is required' });
                }

                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                if (integrationConfig.provisioningToken !== token) {
                    return res.status(403).json({ error: 'Invalid provisioning token' });
                }

                const manualConfig = integrationConfig.manualConfig || {};
                const sessionApiCallbackUrl = process.env.SESSION_API_HOST || `http://localhost:${process.env.SESSION_API_WEBSERVER_HTTP_PORT || 8000}`;

                const script = generateSetupScript(
                    manualConfig.fqdn || '',
                    manualConfig.sslMode || 'letsencrypt',
                    token,
                    sessionApiCallbackUrl,
                    manualConfig.pfxPath || ''
                );

                res.setHeader('Content-Type', 'text/plain');
                res.setHeader('Content-Disposition', 'attachment; filename="setup-manual.ps1"');
                res.send(script);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /integration-configs/:id/media-host-package — Serve or redirect to TeamsMediaBot package
        path: '/integration-configs/:id/media-host-package',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const { token } = req.query;
                if (!token) {
                    return res.status(403).json({ error: 'Provisioning token is required' });
                }

                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                if (integrationConfig.provisioningToken !== token) {
                    return res.status(403).json({ error: 'Invalid provisioning token' });
                }

                const packageUrl = process.env.TEAMS_MEDIA_BOT_PACKAGE_URL;
                if (!packageUrl) {
                    return res.status(404).json({ error: 'Package not configured (TEAMS_MEDIA_BOT_PACKAGE_URL not set)' });
                }

                const packageSha256 = process.env.TEAMS_MEDIA_BOT_PACKAGE_SHA256 || '';
                if (packageSha256) {
                    res.setHeader('X-Package-SHA256', packageSha256);
                }

                // If it looks like a local file path, serve it directly
                if (packageUrl.startsWith('/') || packageUrl.match(/^[a-zA-Z]:\\/)) {
                    if (!fs.existsSync(packageUrl)) {
                        return res.status(404).json({ error: 'Package file not found on server' });
                    }
                    res.setHeader('Content-Type', 'application/zip');
                    res.setHeader('Content-Disposition', 'attachment; filename="TeamsMediaBot.zip"');
                    const stream = fs.createReadStream(packageUrl);
                    stream.pipe(res);
                } else {
                    // Remote URL — redirect
                    res.redirect(302, packageUrl);
                }
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
    }, {
        // POST /integration-configs/:id/check-connectivity
        path: '/integration-configs/:id/check-connectivity',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(id);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const { fqdn } = req.body;
                if (!fqdn || typeof fqdn !== 'string') {
                    return res.status(400).json({ error: 'fqdn is required' });
                }

                const results = { dns: false, resolvedIp: null, mqtt: false };

                // Check DNS resolution
                try {
                    const { address } = await dns.promises.lookup(fqdn);
                    results.dns = true;
                    results.resolvedIp = address;
                } catch {
                    // DNS resolution failed
                }

                // Check MQTT broker connectivity
                const brokerHost = process.env.BROKER_HOST;
                const brokerPort = parseInt(process.env.BROKER_PORT || '1883', 10);
                if (brokerHost) {
                    try {
                        await new Promise((resolve, reject) => {
                            const socket = net.createConnection({ host: brokerHost, port: brokerPort, timeout: 5000 }, () => {
                                socket.destroy();
                                resolve();
                            });
                            socket.on('error', reject);
                            socket.on('timeout', () => {
                                socket.destroy();
                                reject(new Error('timeout'));
                            });
                        });
                        results.mqtt = true;
                    } catch {
                        // MQTT broker unreachable
                    }
                }

                res.json({ results });
            } catch (err) {
                next(err);
            }
        }
    }];
};
