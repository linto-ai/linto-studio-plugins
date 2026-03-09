const { Op } = require('sequelize');
const Model = require('./model/model.js');
const Security = require('./security.js');

const mediaHostInclude = {
    model: Model.MediaHost,
    as: 'mediaHosts'
};

/**
 * Get platform config directly for a given provider.
 */
async function getPlatformConfig(provider) {
    return Model.IntegrationConfig.findOne({
        where: {
            scope: 'platform',
            provider,
            status: { [Op.ne]: 'disabled' }
        },
        include: [mediaHostInclude]
    });
}

/**
 * Decrypt integration config credentials using Security.safeDecrypt().
 */
function getDecryptedCredentials(integrationConfig) {
    if (!integrationConfig || !integrationConfig.config) return null;
    const security = new Security();
    return security.safeDecrypt(integrationConfig.config);
}

/**
 * Get platform config + decrypt combined.
 * Returns { credentials, configId } or null.
 */
async function getEffectiveCredentials(provider) {
    const config = await getPlatformConfig(provider);
    if (!config) return null;

    const decrypted = getDecryptedCredentials(config);
    if (!decrypted) return null;

    return {
        credentials: decrypted,
        configId: config.id
    };
}

module.exports = {
    getPlatformConfig,
    getDecryptedCredentials,
    getEffectiveCredentials
};
