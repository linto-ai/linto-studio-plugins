// Pure transcriber-profile helpers (validation, secret crypto/obfuscation,
// profile extension). Extracted from transcriber_profiles.js so they can be
// unit-tested directly against the SAME code the route runs — re-implementing
// them in the test would let the route drift without the suite noticing.
//
// These helpers depend only on live-srt-lib (Security) and language-tags; no
// Model / multer / Express, so they load cleanly in a plain mocha context.
const { Security } = require("live-srt-lib");
const tags = require('language-tags');

function isValidLocale(locale) {
    return tags.check(locale);
}

const validateTranscriberProfile = (body, update = false) => {
    const config = body.config;
    if (!config) {
        return { error: 'TranscriberProfile object is missing', status: 400 };
    }
    if (!config.type || !config.name || !config.description || !config.languages || !config.languages.length) {
        return { error: 'TranscriberProfile object is missing required properties', status: 400 };
    }
    if (config.type === 'linto' && (!config.languages.every(lang => lang.candidate && lang.endpoint))) {
        return { error: 'Invalid Linto TranscriberProfile endpoint or languages', status: 400 };
    }
    if (config.type === 'microsoft' && (!config.languages.every(lang => isValidLocale(lang.candidate)) || !config.region || (!config.key && !update))) {
        return { error: 'Invalid Microsoft TranscriberProfile languages, region, or key', status: 400 };
    }
    if (config.type === 'amazon' && (!config.languages.every(lang => isValidLocale(lang.candidate)) || !config.region || !config.trustAnchorArn || !config.profileArn || !config.roleArn)) {
        // certificate and privateKey will be validated in the route handler after file upload
        return;
    }
    if (config.type === 'google' && (!config.languages.every(lang => isValidLocale(lang.candidate)) || (!config.credentials && !update))) {
        return { error: 'Invalid Google TranscriberProfile languages or missing credentials', status: 400 };
    }
    if (config.type === 'openai_streaming') {
        if (!config.endpoint || !config.model) {
            return { error: 'OpenAI Streaming profiles require endpoint and model', status: 400 };
        }
        if (config.protocol && !['vllm', 'openai'].includes(config.protocol)) {
            return { error: 'Invalid protocol. Must be "vllm" or "openai"', status: 400 };
        }
    }
    if (config.type === 'voxstral' && !config.endpoint) {
        return { error: 'Voxstral profiles require an endpoint', status: 400 };
    }
    if (config.languages.some(lang => typeof lang !== 'object')) {
        return { error: 'Invalid TranscriberProfile languages', status: 400 };
    }
    if (config.languages.some(lang => typeof lang.candidate !== 'string' || (lang.endpoint !== undefined && typeof lang.endpoint !== 'string'))) {
        return { error: 'Invalid TranscriberProfile language properties', status: 400 };
    }
};

const bundleAmazonCredentials = (certificate, privateKey, passphrase) => {
    // Bundle certificate, private key, and passphrase into a JSON string
    const bundle = JSON.stringify({
        certificate: certificate.toString('utf-8'),
        privateKey: privateKey.toString('utf-8'),
        passphrase: passphrase || ''
    });
    return new Security().encrypt(bundle);
};

const cryptTranscriberProfileKey = (body) => {
    if (body.config.key) {
        body.config.key = new Security().encrypt(body.config.key);
    }
    if (body.config.credentials) {
        body.config.credentials = new Security().encrypt(body.config.credentials);
    }
    if (body.config.apiKey) {
        body.config.apiKey = new Security().encrypt(body.config.apiKey);
    }

    return body;
};

const obfuscateTranscriberProfileKey = (transcriberProfile) => {
    if (transcriberProfile.config.key) {
        transcriberProfile.config.key = "Secret key is hidden";
    }
    if (transcriberProfile.config.credentials) {
        transcriberProfile.config.credentials = "Secret credentials are hidden";
    }
    if (transcriberProfile.config.apiKey) {
        transcriberProfile.config.apiKey = "Secret key is hidden";
    }
    return transcriberProfile;
};

const injectExternalTranslations = (profile, onlineTranslators) => {
    const config = profile.config;

    // discrete: from stored profile config (legacy string array, object array, or already-expanded object)
    const stored = config.availableTranslations || [];
    let discreteLangs;
    if (Array.isArray(stored)) {
        discreteLangs = stored.map(entry => typeof entry === 'string' ? entry : entry.target);
    } else {
        // Already in {discrete, external} format (saved back from frontend)
        discreteLangs = stored.discrete || [];
    }
    config.availableTranslations = {
        discrete: discreteLangs,
        external: onlineTranslators.map(t => ({ translator: t.name, languages: t.languages }))
    };

    return profile;
};

const extendTranscriberProfile = (body) => {
    const config = body.config;
    const translationEnv = process.env[`ASR_AVAILABLE_TRANSLATIONS_${config.type.toUpperCase()}`];
    if ('availableTranslations' in config) {
        if (!Array.isArray(config.availableTranslations) && config.availableTranslations.discrete) {
            // Frontend sent back expanded {discrete, external} format — convert to internal array
            body.config.availableTranslations = config.availableTranslations.discrete.map(lang => ({ target: lang.trim(), mode: 'discrete' }));
        } else if (Array.isArray(config.availableTranslations) && config.availableTranslations.length > 0 && typeof config.availableTranslations[0] === 'string') {
            // Legacy string array
            body.config.availableTranslations = config.availableTranslations.map(lang => ({ target: lang.trim(), mode: 'discrete' }));
        }
        // else keep as-is (already object format or empty)
    }
    else if (translationEnv) {
        body.config.availableTranslations = translationEnv.split(',').map(lang => ({ target: lang.trim(), mode: 'discrete' }));
    }
    else {
        body.config.availableTranslations = [];
    }

    const diarizationEnv = process.env[`ASR_HAS_DIARIZATION_${config.type.toUpperCase()}`];
    if (diarizationEnv) {
        body.config.hasDiarization = diarizationEnv.toUpperCase() == 'TRUE';
    }
    else if (config.type === 'google') {
        // Google profiles are fully self-contained: the diarization capability is
        // carried in the profile itself (no deployment env var required).
        body.config.hasDiarization = config.hasDiarization === true;
    }
    else {
        body.config.hasDiarization = false;
    }

    return body;
};

module.exports = {
    isValidLocale,
    validateTranscriberProfile,
    bundleAmazonCredentials,
    cryptTranscriberProfileKey,
    obfuscateTranscriberProfileKey,
    injectExternalTranslations,
    extendTranscriberProfile,
};
