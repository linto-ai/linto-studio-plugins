// Language detection for the streaming transcriber.
//
// The transcriber emits short finals ("Allô, oui, c'est bien."). Running franc
// on each tiny segment is unreliable: trigram statistics need volume, so a
// three-word French final routinely trigram-matches Spanish, German, Dutch or
// English. Measured on 400 short Tatoeba sentences per language, per-segment
// franc mislabels ~13% of them.
//
// The fix is to stop looking at one short segment and look at a ROLLING WINDOW
// of the recent transcript instead. franc is reliable once it has ~150-200
// characters, which a window always has after warm-up:
//   - A one-segment ghost never dominates the window, so it is smoothed away.
//   - A real, sustained switch fills the window with the new language and flips
//     naturally, with a latency of roughly one window's worth of new speech.
//
// On the same corpus this drops the mislabel rate to ~0.1% while still following
// a French->English switch within a few segments. The numbers and the
// reproducible evaluation procedure are in doc/language-detection.md.
//
// franc is only ever asked among the profile's candidate languages (`only`).

// franc is ESM-only; load it lazily so require() of this module stays
// synchronous. Until it resolves, detection is a no-op (returns the last known
// language, or null).
let _franc = null;
import('franc').then(m => { _franc = m.franc; }).catch(() => {});

// BCP 47 -> ISO 639-3 mapping for franc.
const BCP47_TO_ISO3 = {
    'fr-FR': 'fra', 'en-US': 'eng', 'de-DE': 'deu', 'es-ES': 'spa', 'it-IT': 'ita',
    'pt-PT': 'por', 'pt-BR': 'por', 'nl-NL': 'nld', 'ru-RU': 'rus', 'uk-UA': 'ukr',
    'zh-CN': 'zho', 'ja-JP': 'jpn', 'ko-KR': 'kor', 'ar-SA': 'ara', 'hi-IN': 'hin',
    'pl-PL': 'pol', 'sv-SE': 'swe', 'da-DK': 'dan', 'fi-FI': 'fin', 'el-GR': 'ell',
    'cs-CZ': 'ces', 'ro-RO': 'ron', 'hu-HU': 'hun', 'bg-BG': 'bul', 'hr-HR': 'hrv',
    'sk-SK': 'slk', 'sl-SI': 'slv', 'et-EE': 'est', 'lv-LV': 'lav', 'lt-LT': 'lit',
};

const DEFAULT_THRESHOLDS = {
    // Size of the rolling detection window, in characters. Bigger = fewer
    // mislabels and slower switches; ~180 is the measured sweet spot.
    windowChars: parseInt(process.env.ASR_LANG_WINDOW_CHARS || '180', 10),
    // Below this many characters of window, don't trust anything yet.
    minChars: 12,
    // For partials, re-run franc only once the window has grown this much since
    // the last check (finals always re-run).
    recheckChars: 40,
};

/**
 * Create a language detector from a list of BCP-47 candidates.
 *
 * @param {string[]} candidates - BCP-47 codes from transcriberProfile.config.languages
 * @param {object} [options]
 * @param {(text: string, opts: object) => string} [options.franc]
 *        Injected franc (returns an ISO-639-3 code or 'und'). Defaults to the
 *        lazily-loaded real franc. Present for deterministic unit tests.
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [options.thresholds]
 * @returns {{ detectLanguage: (text: string, force?: boolean) => string|null, _state: () => object }}
 */
function createLangDetector(candidates, options = {}) {
    const cfg = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    const injectedFranc = options.franc || null;

    const allowedIso3 = [];
    const iso3ToBcp47 = {};
    for (const bcp47 of (candidates || [])) {
        const iso3 = BCP47_TO_ISO3[bcp47];
        if (iso3 && !allowedIso3.includes(iso3)) {
            allowedIso3.push(iso3);
            iso3ToBcp47[iso3] = bcp47;
        }
    }

    let buffer = '';     // last `windowChars` of FINALIZED transcript
    let last = null;     // last resolved language (held through 'und' / short)
    let lastCheckLen = 0;

    function detectLanguage(text, force = false) {
        if (!allowedIso3.length || !text) return last;
        const seg = text.trim();
        if (!seg) return last;

        // Detection window: recent finalized text plus the segment in hand.
        const window = (buffer ? buffer + ' ' + seg : seg).slice(-cfg.windowChars);

        // A final extends the rolling buffer with its segment; a partial only
        // peeks (the same segment's text is appended once, when it finalizes).
        if (force) buffer = window;

        // Rate-limit partial re-detection.
        if (!force && last && (window.length - lastCheckLen) < cfg.recheckChars) {
            return last;
        }

        const francFn = injectedFranc || _franc;
        if (!francFn) return last;                 // franc not loaded yet
        // Guard tiny windows on partials only. A final always attempts franc
        // (as the previous detector did), so a segment never emits with a less
        // determined language than before.
        if (!force && window.length < cfg.minChars) return last;

        lastCheckLen = window.length;

        let iso3;
        try {
            iso3 = francFn(window, { only: allowedIso3 });
        } catch (e) {
            return last;
        }
        if (iso3 && iso3 !== 'und' && iso3ToBcp47[iso3]) {
            last = iso3ToBcp47[iso3];
        }
        return last;
    }

    return {
        detectLanguage,
        _state: () => ({ buffer, last }),
    };
}

module.exports = { BCP47_TO_ISO3, DEFAULT_THRESHOLDS, createLangDetector };
