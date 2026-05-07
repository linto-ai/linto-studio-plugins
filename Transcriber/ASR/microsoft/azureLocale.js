// Azure Speech Translation accepts a fixed set of target codes (per the official
// "Translate to text language" table). Regional variants use lowercase region
// (`pt-pt`, `fr-ca`); script variants use Title Case script (`zh-Hans`, `sr-Latn`).
// Anything outside this set is collapsed to its primary subtag — the only safe
// fallback, matching Azure's documented defaults (e.g. `pt` = Brazilian, `fr` = French).

const AZURE_DISTINCT_TARGETS = new Set([
    'fr-ca',
    'pt-pt',
    'zh-Hans',
    'zh-Hant',
    'sr-Cyrl',
    'sr-Latn',
    'tlh-Latn',
    'tlh-Piqd',
]);

const AZURE_VALID_TARGETS = new Set([
    'af', 'sq', 'am', 'ar', 'hy', 'as', 'az', 'bn', 'bs', 'bg', 'yue', 'ca',
    'lzh', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'prs', 'nl', 'en', 'et',
    'fj', 'fil', 'fi', 'fr', 'fr-ca', 'de', 'el', 'gu', 'ht', 'he', 'hi',
    'mww', 'hu', 'is', 'id', 'iu', 'ga', 'it', 'ja', 'kn', 'kk', 'km',
    'tlh-Latn', 'tlh-Piqd', 'ko', 'ku', 'kmr', 'lo', 'lv', 'lt', 'mg', 'ms',
    'ml', 'mt', 'mi', 'mr', 'my', 'ne', 'nb', 'or', 'ps', 'fa', 'pl', 'pt',
    'pt-pt', 'pa', 'otq', 'ro', 'ru', 'sm', 'sr-Cyrl', 'sr-Latn', 'sk', 'sl',
    'es', 'sw', 'sv', 'ty', 'ta', 'te', 'th', 'ti', 'to', 'tr', 'uk', 'ur',
    'vi', 'cy', 'yua',
]);

function toAzureCode(bcp47) {
    if (typeof bcp47 !== 'string' || !bcp47) return bcp47;

    const parts = bcp47.split('-').filter(Boolean);
    if (parts.length === 0) return bcp47;

    const language = parts[0].toLowerCase();
    if (parts.length === 1) return language;

    const subtag = parts[1];
    // Script subtags are 4 alpha chars (ISO 15924), regions are 2 alpha or 3 digits.
    const isScript = /^[A-Za-z]{4}$/.test(subtag);
    const normalizedSubtag = isScript
        ? subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase()
        : subtag.toLowerCase();

    const azureCandidate = `${language}-${normalizedSubtag}`;
    if (AZURE_DISTINCT_TARGETS.has(azureCandidate)) return azureCandidate;
    return language;
}

function isAzureValid(code) {
    return AZURE_VALID_TARGETS.has(code);
}

module.exports = {
    toAzureCode,
    isAzureValid,
    AZURE_DISTINCT_TARGETS,
    AZURE_VALID_TARGETS,
};
