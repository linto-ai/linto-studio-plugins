const { Model, logger, getDecryptedCredentials } = require("live-srt-lib");
const crypto = require("crypto");
const dns = require("dns");
const net = require("net");
const fs = require("fs");
const path = require("path");

const setupScriptTemplate = fs.readFileSync(path.join(__dirname, 'setup-manual.ps1.template'), 'utf8');

function generateSetupScript(fqdn, sslMode, pfxPath, config) {
    const sslParam = sslMode === 'pfx' ? 'pfx' : 'letsencrypt';
    return setupScriptTemplate
        .replace(/\{\{FQDN\}\}/g, fqdn)
        .replace(/\{\{SSL_MODE\}\}/g, sslParam)
        .replace(/\{\{PFX_PATH\}\}/g, pfxPath || '')
        .replace(/\{\{MQTT_HOST\}\}/g, config.mqttHost || '')
        .replace(/\{\{MQTT_PORT\}\}/g, config.mqttPort || '')
        .replace(/\{\{MQTT_USERNAME\}\}/g, config.mqttUsername || '')
        .replace(/\{\{MQTT_PASSWORD\}\}/g, config.mqttPassword || '')
        .replace(/\{\{MQTT_PROTOCOL\}\}/g, config.mqttProtocol || '')
        .replace(/\{\{MQTT_WS_PATH\}\}/g, config.mqttWsPath || '')
        .replace(/\{\{MEDIA_HOST_ID\}\}/g, config.mediaHostId || '')
        .replace(/\{\{INTEGRATION_CONFIG_ID\}\}/g, config.integrationConfigId || '')
        .replace(/\{\{TENANT_ID\}\}/g, config.tenantId || '')
        .replace(/\{\{CLIENT_ID\}\}/g, config.clientId || '')
        .replace(/\{\{CLIENT_SECRET\}\}/g, config.clientSecret || '')
        .replace(/\{\{PACKAGE_URL\}\}/g, config.packageUrl || '')
        .replace(/\{\{PACKAGE_SHA256\}\}/g, config.packageSha256 || '');
}

module.exports = (webserver) => {
    return [{
        // POST /integration-configs/:configId/media-hosts — Create a MediaHost for this config
        path: '/integration-configs/:configId/media-hosts',
        method: 'post',
        controller: async (req, res, next) => {
            const { configId } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(configId);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const { deploymentMode, dns, publicIp, manualConfig } = req.body;

                if (deploymentMode && !['azure', 'manual'].includes(deploymentMode)) {
                    return res.status(400).json({ error: 'deploymentMode must be azure or manual' });
                }

                const mediaHost = await Model.MediaHost.create({
                    integrationConfigId: configId,
                    deploymentMode: deploymentMode || null,
                    dns: dns || null,
                    publicIp: publicIp || null,
                    manualConfig: manualConfig || null
                });

                res.status(201).json(mediaHost.toJSON());
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /integration-configs/:configId/media-hosts — List MediaHosts for a config
        path: '/integration-configs/:configId/media-hosts',
        method: 'get',
        controller: async (req, res, next) => {
            const { configId } = req.params;
            try {
                const integrationConfig = await Model.IntegrationConfig.findByPk(configId);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const mediaHosts = await Model.MediaHost.findAll({
                    where: { integrationConfigId: configId }
                });

                res.json({ mediaHosts });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /media-hosts/:id — Detail of a MediaHost
        path: '/media-hosts/:id',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id, {
                    include: [{ model: Model.IntegrationConfig }]
                });
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }
                res.json(mediaHost.toJSON());
            } catch (err) {
                next(err);
            }
        }
    }, {
        // PUT /media-hosts/:id — Update a MediaHost configuration
        path: '/media-hosts/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }
                if (mediaHost.status === 'decommissioned') {
                    return res.status(400).json({ error: 'Cannot update a decommissioned media host' });
                }
                const allowedFields = ['dns', 'publicIp', 'manualConfig'];
                const updates = {};
                for (const field of allowedFields) {
                    if (req.body[field] !== undefined) {
                        updates[field] = req.body[field];
                    }
                }
                if (Object.keys(updates).length === 0) {
                    return res.status(400).json({ error: 'No updatable fields provided (allowed: dns, publicIp, manualConfig)' });
                }
                await mediaHost.update(updates);
                res.json(mediaHost.toJSON());
            } catch (err) {
                next(err);
            }
        }
    }, {
        // DELETE /media-hosts/:id — Decommission (status → 'decommissioned')
        path: '/media-hosts/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }
                await mediaHost.update({ status: 'decommissioned' });
                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /media-hosts/:id/generate-provisioning-token — Generate 32 bytes hex token
        path: '/media-hosts/:id/generate-provisioning-token',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }

                const token = crypto.randomBytes(32).toString('hex');
                await mediaHost.update({ provisioningToken: token });

                res.json({ provisioningToken: token });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /register-media-host — Phone-home (auth by token, returns { mqtt, mediaHostId, integrationConfigId })
        path: '/register-media-host',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { token, dns } = req.body;
                if (!token) {
                    return res.status(400).json({ error: 'token is required' });
                }

                const mediaHost = await Model.MediaHost.findOne({
                    where: { provisioningToken: token }
                });

                if (!mediaHost) {
                    return res.status(404).json({ error: 'Invalid provisioning token' });
                }

                const updates = {
                    provisioningToken: null,
                    status: 'online'
                };
                if (dns) {
                    updates.dns = dns;
                }

                await mediaHost.update(updates);

                // Update setupProgress on parent IntegrationConfig
                const integrationConfig = await Model.IntegrationConfig.findByPk(mediaHost.integrationConfigId);
                if (integrationConfig) {
                    await integrationConfig.update({
                        setupProgress: { ...integrationConfig.setupProgress, mediaHost: true }
                    });
                }

                webserver.emit('mediaHostRegistered', mediaHost.integrationConfigId);

                res.json({
                    mqtt: {
                        host: process.env.BROKER_HOST,
                        port: process.env.BROKER_PORT,
                        username: process.env.BROKER_USERNAME || '',
                        password: process.env.BROKER_PASSWORD || ''
                    },
                    mediaHostId: mediaHost.id,
                    integrationConfigId: mediaHost.integrationConfigId
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /media-hosts/:id/generate-deploy-link — Azure ARM template link
        path: '/media-hosts/:id/generate-deploy-link',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }

                if (!mediaHost.provisioningToken) {
                    return res.status(400).json({ error: 'Generate a provisioning token first' });
                }

                const sessionApiCallbackUrl = process.env.SESSION_API_HOST || `http://localhost:${process.env.SESSION_API_WEBSERVER_HTTP_PORT || 8000}`;
                const templateUrl = 'https://raw.githubusercontent.com/linagora/emeeting-media-host/main/azuredeploy.json';
                const deployLink = `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent(templateUrl)}` +
                    `?provisioningToken=${encodeURIComponent(mediaHost.provisioningToken)}` +
                    `&sessionApiCallbackUrl=${encodeURIComponent(sessionApiCallbackUrl)}`;

                res.json({ deployLink });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /media-hosts/:id/setup-script — PowerShell script (auth by token query param)
        path: '/media-hosts/:id/setup-script',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const { token } = req.query;
                if (!token) {
                    return res.status(403).json({ error: 'Provisioning token is required' });
                }

                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }

                if (mediaHost.provisioningToken !== token) {
                    return res.status(403).json({ error: 'Invalid provisioning token' });
                }

                // Load IntegrationConfig and decrypt Azure AD credentials
                const integrationConfig = await Model.IntegrationConfig.findByPk(mediaHost.integrationConfigId);
                if (!integrationConfig) {
                    return res.status(404).json({ error: 'Integration config not found' });
                }

                const decryptedRaw = getDecryptedCredentials(integrationConfig);
                const decryptedConfig = decryptedRaw ? JSON.parse(decryptedRaw) : {};
                const manualConfig = mediaHost.manualConfig || {};

                // Determine MQTT settings based on scope
                let mqttHost, mqttPort, mqttUsername, mqttPassword, mqttProtocol, mqttWsPath;
                if (integrationConfig.scope === 'platform') {
                    // Platform scope: read MQTT from manualConfig.mqtt (admin-entered)
                    const mqtt = manualConfig.mqtt || {};
                    mqttHost = mqtt.host || '';
                    mqttPort = mqtt.port || '';
                    mqttUsername = mqtt.username || '';
                    mqttPassword = mqtt.password || '';
                    mqttProtocol = mqtt.protocol || '';
                    mqttWsPath = mqtt.wsPath || '';
                } else {
                    // Organization scope (SaaS): use process.env.BROKER_*
                    mqttHost = process.env.BROKER_HOST || '';
                    mqttPort = process.env.BROKER_PORT || '';
                    mqttUsername = process.env.BROKER_USERNAME || '';
                    mqttPassword = process.env.BROKER_PASSWORD || '';
                    mqttProtocol = process.env.BROKER_PROTOCOL || '';
                    mqttWsPath = process.env.BROKER_WS_PATH || '';
                }

                const script = generateSetupScript(
                    manualConfig.fqdn || '',
                    manualConfig.sslMode || 'letsencrypt',
                    manualConfig.pfxPath || '',
                    {
                        mqttHost,
                        mqttPort,
                        mqttUsername,
                        mqttPassword,
                        mqttProtocol,
                        mqttWsPath,
                        mediaHostId: mediaHost.id,
                        integrationConfigId: integrationConfig.id,
                        tenantId: decryptedConfig.tenantId || '',
                        clientId: decryptedConfig.clientId || '',
                        clientSecret: decryptedConfig.clientSecret || '',
                        packageUrl: process.env.TEAMS_MEDIA_BOT_PACKAGE_URL || '',
                        packageSha256: process.env.TEAMS_MEDIA_BOT_PACKAGE_SHA256 || ''
                    }
                );

                // Consume provisioning token and set status to provisioned
                // Note: setupProgress.mediaHost is NOT set here — it will be set when the
                // TeamsMediaBot actually connects via MQTT (detected by the Scheduler)
                const statusUpdate = { provisioningToken: null };
                if (mediaHost.status === 'provisioning') {
                    statusUpdate.status = 'provisioned';
                }
                await mediaHost.update(statusUpdate);

                res.setHeader('Content-Type', 'text/plain');
                res.setHeader('Content-Disposition', 'attachment; filename="setup-manual.ps1"');
                res.send(script);
            } catch (err) {
                next(err);
            }
        }
    }, {
        // GET /media-hosts/:id/media-host-package — Serve or redirect to TeamsMediaBot package (auth by token)
        path: '/media-hosts/:id/media-host-package',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const { token } = req.query;
                if (!token) {
                    return res.status(403).json({ error: 'Provisioning token is required' });
                }

                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }

                if (mediaHost.provisioningToken !== token) {
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

                if (packageUrl.startsWith('/') || packageUrl.match(/^[a-zA-Z]:\\/)) {
                    if (!fs.existsSync(packageUrl)) {
                        return res.status(404).json({ error: 'Package file not found on server' });
                    }
                    res.setHeader('Content-Type', 'application/zip');
                    res.setHeader('Content-Disposition', 'attachment; filename="TeamsMediaBot.zip"');
                    const stream = fs.createReadStream(packageUrl);
                    stream.pipe(res);
                } else {
                    res.redirect(302, packageUrl);
                }
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /media-hosts/:id/health-report — Update healthStatus and lastHealthCheck
        path: '/media-hosts/:id/health-report',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }

                await mediaHost.update({
                    lastHealthCheck: new Date(),
                    healthStatus: req.body
                });

                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }, {
        // POST /media-hosts/:id/check-connectivity — Test DNS + MQTT
        path: '/media-hosts/:id/check-connectivity',
        method: 'post',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const mediaHost = await Model.MediaHost.findByPk(id);
                if (!mediaHost) {
                    return res.status(404).json({ error: 'Media host not found' });
                }

                const { fqdn } = req.body;
                if (!fqdn || typeof fqdn !== 'string') {
                    return res.status(400).json({ error: 'fqdn is required' });
                }

                const results = { dns: false, resolvedIp: null, mqtt: false };

                try {
                    const { address } = await dns.promises.lookup(fqdn);
                    results.dns = true;
                    results.resolvedIp = address;
                } catch {
                    // DNS resolution failed
                }

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
