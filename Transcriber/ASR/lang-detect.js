// Dynamic import for ESM-only franc module
let _franc = null;
import('franc').then(m => { _franc = m.franc; });

// BCP 47 -> ISO 639-3 mapping for franc language detection
const BCP47_TO_ISO3 = {
    'fr-FR': 'fra',
    'en-US': 'eng',
    'de-DE': 'deu',
    'es-ES': 'spa',
    'it-IT': 'ita',
    'pt-PT': 'por',
    'pt-BR': 'por',
    'nl-NL': 'nld',
    'ru-RU': 'rus',
    'uk-UA': 'ukr',
    'zh-CN': 'zho',
    'ja-JP': 'jpn',
    'ko-KR': 'kor',
    'ar-SA': 'ara',
    'hi-IN': 'hin',
    'pl-PL': 'pol',
    'sv-SE': 'swe',
    'da-DK': 'dan',
    'fi-FI': 'fin',
    'el-GR': 'ell',
    'cs-CZ': 'ces',
    'ro-RO': 'ron',
    'hu-HU': 'hun',
    'bg-BG': 'bul',
    'hr-HR': 'hrv',
    'sk-SK': 'slk',
    'sl-SI': 'slv',
    'et-EE': 'est',
    'lv-LV': 'lav',
    'lt-LT': 'lit',
};

// Language detection thresholds
const LANG_DETECT_MIN_CHARS = 30;
const LANG_DETECT_RECHECK_CHARS = 80;

/**
 * Create a language detector from a list of BCP-47 language candidates.
 * Returns an object with detectLanguage(text, force) method.
 *
 * @param {string[]} candidates - BCP-47 codes from transcriberProfile.config.languages
 * @returns {{ detectLanguage: (text: string, force?: boolean) => string|null }}
 */
function createLangDetector(candidates) {
    const allowedIso3 = [];
    const iso3ToBcp47 = {};

    for (const bcp47 of candidates) {
        const iso3 = BCP47_TO_ISO3[bcp47];
        if (iso3 && !allowedIso3.includes(iso3)) {
            allowedIso3.push(iso3);
            iso3ToBcp47[iso3] = bcp47;
        }
    }

    let cachedLang = null;
    let lastCheckLen = 0;

    /**
     * Detect language from text using franc, constrained to profile languages.
     * Uses caching: only re-detects when text grows significantly.
     * @param {string} text
     * @param {boolean} force - Force re-detection (for finals)
     * @returns {string|null} BCP 47 language tag or null if undetermined
     */
    function detectLanguage(text, force = false) {
        if (!allowedIso3.length || !text || text.trim().length === 0) {
            return cachedLang;
        }

        const textLen = text.length;

        if (textLen < LANG_DETECT_MIN_CHARS && !force) {
            return cachedLang;
        }

        if (!force && cachedLang && (textLen - lastCheckLen) < LANG_DETECT_RECHECK_CHARS) {
            return cachedLang;
        }

        if (!_franc) return cachedLang;
        const detected = _franc(text, { only: allowedIso3 });
        const bcp47 = detected === 'und' ? null : (iso3ToBcp47[detected] || null);

        if (bcp47) {
            cachedLang = bcp47;
            lastCheckLen = textLen;
        }

        return cachedLang;
    }

    return { detectLanguage };
}

module.exports = { BCP47_TO_ISO3, createLangDetector };
