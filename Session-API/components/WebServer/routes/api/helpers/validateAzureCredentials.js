const { Security } = require("live-srt-lib");
const axios = require("axios");

/**
 * Validate Azure OAuth2 credentials from an IntegrationConfig record.
 * Shared between org-scoped and platform-scoped validate-credentials routes.
 *
 * @param {object} integrationConfig - Sequelize IntegrationConfig instance
 * @returns {Promise<{valid: boolean, expiresIn?: number, error?: string}>}
 * @throws {{statusCode: number, message: string}} on bad config format
 */
async function validateAzureCredentials(integrationConfig) {
    const decryptedConfig = new Security().safeDecrypt(integrationConfig.config);
    let parsed;
    try {
        parsed = JSON.parse(decryptedConfig);
    } catch {
        const err = new Error("Invalid config format");
        err.statusCode = 400;
        throw err;
    }

    const { tenantId, clientId, clientSecret } = parsed;
    if (!tenantId || !clientId || !clientSecret) {
        const err = new Error("Config must contain tenantId, clientId, and clientSecret");
        err.statusCode = 400;
        throw err;
    }

    try {
        const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const response = await axios.post(tokenUrl, new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
            scope: "https://graph.microsoft.com/.default"
        }), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });

        return { valid: true, expiresIn: response.data.expires_in };
    } catch (err) {
        const errorMsg = err.response?.data?.error_description || err.message;
        return { valid: false, error: errorMsg };
    }
}

module.exports = { validateAzureCredentials };
