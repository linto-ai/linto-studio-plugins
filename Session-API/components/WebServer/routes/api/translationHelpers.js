const { Model, logger } = require("live-srt-lib");
const bcp47 = require('language-tags');

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Primaries that have Azure-distinct regional or script variants. Mixing a bare
// primary with a variant from this set causes Azure SDK Issue #3024 collisions
// (the service resolves the bare code to one variant and drops the other). For
// other primaries (en, es, de, ...) Azure has no distinct regional target, so
// combining bare + variant is harmless and we let it through.
// KEEP IN SYNC with AZURE_DISTINCT_TARGETS in Transcriber/ASR/microsoft/azureLocale.js.
const COLLISION_RISK_PRIMARIES = new Set(['pt', 'fr', 'zh', 'sr', 'tlh']);

// Audio-only channel: no profile is signalled by a missing or null id.
function hasNoTranscriberProfile(transcriberProfileId) {
    return transcriberProfileId == null;
}

// Returns the profile for the id, null for an audio-only channel, or throws 400 if the id is unknown.
async function resolveTranscriberProfile(transcriberProfileId, transaction) {
    if (hasNoTranscriberProfile(transcriberProfileId)) return null;
    const profile = await Model.TranscriberProfile.findByPk(transcriberProfileId, { transaction });
    if (!profile) {
        throw new ApiError(400, `Transcriber profile with id ${transcriberProfileId} not found`);
    }
    return profile;
}

function validateTranslations(translations) {
    if (!translations) return null;
    if (!Array.isArray(translations)) throw new ApiError(400, "translations must be an array");

    const validated = translations.map(entry => {
        if (typeof entry === 'string') {
            if (!bcp47.check(entry)) throw new ApiError(400, `Invalid BCP47 tag: ${entry}`);
            return { target: entry, mode: 'discrete' };
        }
        if (typeof entry !== 'object' || !entry.target || !entry.mode) {
            throw new ApiError(400, "Each translation entry must have 'target' and 'mode'");
        }
        if (!bcp47.check(entry.target)) throw new ApiError(400, `Invalid BCP47 tag: ${entry.target}`);
        if (!['discrete', 'external'].includes(entry.mode)) {
            throw new ApiError(400, "Translation mode must be 'discrete' or 'external'");
        }
        if (entry.mode === 'external' && (!entry.translator || typeof entry.translator !== 'string')) {
            throw new ApiError(400, "External translation must specify 'translator'");
        }
        return entry;
    });

    // Reject ambiguous combos: two entries that share a primary subtag where at
    // least one carries a region/script. Mixing e.g. `pt` and `pt-PT` triggers
    // collisions in Azure's resolver (see speech-sdk issue #3024).
    const byPrimary = new Map();
    for (const entry of validated) {
        const canonical = bcp47(entry.target).format();
        const primary = canonical.split('-')[0].toLowerCase();
        const list = byPrimary.get(primary) || [];
        list.push(canonical);
        byPrimary.set(primary, list);
    }
    for (const [primary, list] of byPrimary.entries()) {
        if (list.length < 2) continue;
        const lowered = list.map(t => t.toLowerCase());
        const unique = new Set(lowered);
        if (unique.size < lowered.length) {
            throw new ApiError(400, `Duplicate translation target: ${list.join(', ')}`);
        }
        if (!COLLISION_RISK_PRIMARIES.has(primary)) continue;
        const hasBare = unique.has(primary);
        const hasVariant = [...unique].some(t => t !== primary);
        if (hasBare && hasVariant) {
            throw new ApiError(400, `Ambiguous translation targets sharing primary subtag '${primary}': ${list.join(', ')}`);
        }
    }

    return validated;
}

function bcp47Equal(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (!bcp47.check(a) || !bcp47.check(b)) return a.toLowerCase() === b.toLowerCase();
    return bcp47(a).format().toLowerCase() === bcp47(b).format().toLowerCase();
}

async function enrichTranslations(validatedTranslations, transcriberProfile) {
    if (!validatedTranslations || validatedTranslations.length === 0) return validatedTranslations;

    const profileTranslations = transcriberProfile.config.availableTranslations || [];
    const discreteLangs = new Set(
        profileTranslations
            .filter(t => !t.mode || t.mode === 'discrete')
            .map(t => typeof t === 'string' ? t : t.target)
    );

    const onlineTranslators = await Model.Translator.findAll({ where: { online: true } });

    return validatedTranslations.map(entry => {
        if (entry.mode === 'external') return entry;
        if ([...discreteLangs].some(lang => bcp47Equal(entry.target, lang))) return entry;
        for (const translator of onlineTranslators) {
            if (translator.languages && translator.languages.some(lang => bcp47Equal(entry.target, lang))) {
                return { target: entry.target, mode: 'external', translator: translator.name };
            }
        }
        if (logger && logger.warn) {
            logger.warn(`Translation target '${entry.target}' is not advertised by the profile and no online translator supports it; falling back to discrete (provider may default to a different locale).`);
        }
        return entry;
    });
}

module.exports = {
    ApiError,
    validateTranslations,
    bcp47Equal,
    enrichTranslations,
    hasNoTranscriberProfile,
    resolveTranscriberProfile,
};
