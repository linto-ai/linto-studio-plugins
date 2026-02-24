const { Op } = require('sequelize');
const Model = require('./model/model.js');
const Security = require('./security.js');
const logger = require('./logger.js');

const mediaHostInclude = {
    model: Model.MediaHost,
    as: 'mediaHosts'
};

const sharedMediaHostInclude = {
    model: Model.MediaHost,
    as: 'sharedMediaHost'
};

/**
 * Resolve integration config with cascade: organization > platform.
 * Returns { config, inherited, locked } or null.
 */
async function resolveIntegrationConfig(organizationId, provider) {
    // First, try to find an organization-scoped active config
    const orgConfig = await Model.IntegrationConfig.findOne({
        where: {
            scope: 'organization',
            organizationId,
            provider,
            status: { [Op.ne]: 'disabled' }
        },
        include: [mediaHostInclude, sharedMediaHostInclude]
    });

    if (orgConfig) {
        return { config: orgConfig, inherited: false, locked: false };
    }

    // Fallback to platform config
    const platformConfig = await Model.IntegrationConfig.findOne({
        where: {
            scope: 'platform',
            provider,
            status: { [Op.ne]: 'disabled' }
        },
        include: [mediaHostInclude]
    });

    if (platformConfig) {
        return {
            config: platformConfig,
            inherited: true,
            locked: !platformConfig.allowOrganizationOverride
        };
    }

    return null;
}

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
 * Check whether the organization can override the platform config.
 */
async function canOrganizationOverride(organizationId, provider) {
    const platformConfig = await getPlatformConfig(provider);
    if (!platformConfig) {
        return true; // No platform config, org can create freely
    }
    return platformConfig.allowOrganizationOverride;
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
 * Resolve + decrypt combined.
 * Returns { credentials, configId, inherited } or null.
 */
async function getEffectiveCredentials(organizationId, provider) {
    const result = await resolveIntegrationConfig(organizationId, provider);
    if (!result) return null;

    const decrypted = getDecryptedCredentials(result.config);
    if (!decrypted) return null;

    return {
        credentials: decrypted,
        configId: result.config.id,
        inherited: result.inherited
    };
}

module.exports = {
    resolveIntegrationConfig,
    getPlatformConfig,
    canOrganizationOverride,
    getDecryptedCredentials,
    getEffectiveCredentials
};
