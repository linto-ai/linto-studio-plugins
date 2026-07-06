const assert = require('assert');
const { createLangDetector } = require('../ASR/lang-detect');

// Language detection suite (rolling-window detector).
//
// The mechanics (how the window is built and fed to franc) are exercised with
// an injected fake `franc` so we can see exactly what text franc is asked about
// and control its verdict. A final block runs the REAL franc and shows the
// before/after: franc alone mislabels every short French final, the windowed
// detector keeps the whole monologue French, and a genuine switch still lands.

const CANDS = ['fr-FR', 'en-US', 'es-ES', 'nl-NL', 'de-DE'];

// Detector whose franc returns whatever `ret` was set to, and records the
// window it was asked about and the options it was passed.
function harness(candidates = CANDS, thresholds) {
    let ret = 'und';
    let seen = null;
    let calls = 0;
    const det = createLangDetector(candidates, {
        thresholds,
        franc: (window, opts) => { calls += 1; seen = window; harness._lastOpts = opts; return ret; },
    });
    return {
        det,
        detect(iso3, text, force = true) { ret = iso3; return det.detectLanguage(text, force); },
        seen: () => seen,
        calls: () => calls,
        state: () => det._state(),
    };
}

describe('lang-detect: rolling window', function () {

    it('returns null before any resolved detection', function () {
        const h = harness();
        assert.strictEqual(h.detect('und', 'x'.repeat(40)), null);
        assert.strictEqual(h.state().last, null);
    });

    it('maps franc\'s ISO-639-3 result to the profile BCP-47 tag', function () {
        const h = harness();
        assert.strictEqual(h.detect('fra', 'x'.repeat(40)), 'fr-FR');
        assert.strictEqual(h.detect('eng', 'x'.repeat(40)), 'en-US');
    });

    it('builds the window from recent finals plus the current text', function () {
        const h = harness(CANDS, { minChars: 1 });
        h.detect('fra', 'aaaa');
        assert.strictEqual(h.seen(), 'aaaa');
        h.detect('fra', 'bbbb');
        assert.strictEqual(h.seen(), 'aaaa bbbb');
    });

    it('caps the window at windowChars (keeps the most recent characters)', function () {
        const h = harness(CANDS, { windowChars: 10, minChars: 3 });
        h.detect('fra', 'abcdefghij');       // 10 chars
        h.detect('fra', 'KLMNO');            // window would be 16 -> keep last 10
        assert.strictEqual(h.seen(), 'fghij KLMNO'.slice(-10));
    });

    it('finals extend the buffer; partials only peek', function () {
        const h = harness(CANDS, { minChars: 1, recheckChars: 1 });
        h.detect('fra', 'aaaa');             // final -> buffer = "aaaa"
        assert.strictEqual(h.state().buffer, 'aaaa');
        h.detect('fra', 'pp', false);        // partial -> peeks, does not extend
        assert.strictEqual(h.seen(), 'aaaa pp');
        assert.strictEqual(h.state().buffer, 'aaaa');
        h.detect('fra', 'bbbb');             // next final builds on "aaaa", not "aaaa pp"
        assert.strictEqual(h.seen(), 'aaaa bbbb');
    });

    it('passes only the profile languages to franc (the allow-list)', function () {
        const h = harness(['fr-FR', 'en-US']);
        h.detect('fra', 'x'.repeat(40));
        assert.deepStrictEqual(harness._lastOpts.only, ['fra', 'eng']);
    });

    it('holds the last language through an undetermined window', function () {
        const h = harness();
        h.detect('fra', 'x'.repeat(40));     // fr
        assert.strictEqual(h.detect('und', 'y'.repeat(40)), 'fr-FR');
        assert.strictEqual(h.state().last, 'fr-FR');
    });

    it('ignores an out-of-profile franc result', function () {
        const h = harness(['fr-FR', 'en-US']);
        h.detect('fra', 'x'.repeat(40));     // fr
        // franc "wins" with Dutch, which is not in the profile -> unchanged.
        assert.strictEqual(h.detect('nld', 'y'.repeat(40)), 'fr-FR');
    });

    it('does not trust a tiny PARTIAL window (but a final always tries franc)', function () {
        const h = harness(CANDS, { minChars: 12 });
        const before = h.calls();
        assert.strictEqual(h.detect('fra', 'salut', false), null);   // partial, 5 chars < 12
        assert.strictEqual(h.calls(), before, 'short partial must short-circuit before franc');
        // A short FINAL still attempts franc (no less determined than before).
        assert.strictEqual(h.detect('fra', 'salut', true), 'fr-FR');
        assert.strictEqual(h.calls(), before + 1);
    });

    it('survives franc throwing (returns the last language)', function () {
        const det = createLangDetector(CANDS, { franc: () => { throw new Error('boom'); } });
        assert.strictEqual(det.detectLanguage('x'.repeat(40), true), null);
    });

    it('returns null when no candidate languages are configured', function () {
        const h = harness([]);
        assert.strictEqual(h.detect('fra', 'x'.repeat(40)), null);
    });

    it('returns the last language on empty / whitespace text', function () {
        const h = harness();
        h.detect('fra', 'x'.repeat(40));
        assert.strictEqual(h.det.detectLanguage('', true), 'fr-FR');
        assert.strictEqual(h.det.detectLanguage('   ', true), 'fr-FR');
    });

    it('rate-limits franc on growing partials, always runs on finals', function () {
        let calls = 0;
        const det = createLangDetector(['fr-FR', 'en-US'], {
            franc: () => { calls += 1; return 'fra'; },
            thresholds: { recheckChars: 40 },
        });
        det.detectLanguage('a'.repeat(60), true);          // final -> runs (buffer=60)
        assert.strictEqual(calls, 1);
        det.detectLanguage('b'.repeat(5), false);          // partial: window +6 < 40 -> cached
        assert.strictEqual(calls, 1);
        det.detectLanguage('b'.repeat(100), false);        // partial: window jumps > 40 -> runs
        assert.strictEqual(calls, 2);
        det.detectLanguage('c'.repeat(3), true);           // final -> always runs
        assert.strictEqual(calls, 3);
    });
});

// The payoff on the REAL franc: same short French finals the live stream
// produces, profile fr/en/es/nl/de. franc alone tags each tiny segment with a
// different wrong language; the windowed detector, seeing accumulated context,
// keeps the whole monologue French and still follows a genuine switch.
describe('lang-detect: real franc, before/after', function () {
    let franc;
    before(async function () {
        franc = (await import('franc')).franc;
    });

    const ONLY = ['fra', 'eng', 'spa', 'nld', 'deu'];
    const MONOLOGUE = [
        "Bonjour à toutes et à tous, je vais faire un petit test de transcription en direct.",
        "Allô, oui, c'est bien.",        // franc alone -> Spanish
        "Voilà, c'est fait.",            // franc alone -> German
        "D'accord, ça marche.",          // franc alone -> English
        "Ça va aller, t'inquiète.",      // franc alone -> Dutch
        "Merci beaucoup à toi.",         // franc alone -> English
        "Non mais attends un peu.",      // franc alone -> English
    ];

    it('sanity: detects clear French and clear English', function () {
        const d1 = createLangDetector(CANDS, { franc });
        assert.strictEqual(d1.detectLanguage(MONOLOGUE[0], true), 'fr-FR');
        const d2 = createLangDetector(CANDS, { franc });
        assert.strictEqual(d2.detectLanguage(
            "Hello everyone, I really hope you are doing very well today and enjoying it.", true), 'en-US');
    });

    it('BASELINE: raw franc mislabels every short French segment', function () {
        const wrong = MONOLOGUE.slice(1)
            .map(t => franc(t, { only: ONLY }))
            .filter(l => l !== 'und' && l !== 'fra');
        assert.strictEqual(wrong.length, MONOLOGUE.length - 1);
        assert.ok(new Set(wrong).size >= 3, `across several wrong languages: ${[...new Set(wrong)].join(', ')}`);
    });

    it('FIX: the windowed detector keeps the whole monologue in French', function () {
        const d = createLangDetector(CANDS, { franc });
        const labels = MONOLOGUE.map(t => d.detectLanguage(t, true));
        assert.deepStrictEqual(labels, MONOLOGUE.map(() => 'fr-FR'),
            `every segment should stay fr-FR, got: ${labels.join(', ')}`);
    });

    it('still follows a genuine switch to English', function () {
        const d = createLangDetector(CANDS, { franc });
        d.detectLanguage(MONOLOGUE[0], true);              // French established
        const EN = "Okay, so from now on I am going to speak only in English for quite a "
            + "while, just to make sure a real and sustained language switch is detected properly.";
        assert.strictEqual(d.detectLanguage(EN, true), 'en-US');
    });

    it('holds English against a lone French-looking blip right after the switch', function () {
        const d = createLangDetector(CANDS, { franc });
        d.detectLanguage(MONOLOGUE[0], true);
        d.detectLanguage("This is a long English sentence to firmly establish English "
            + "as the language being spoken in this session right now.", true);
        assert.strictEqual(d.detectLanguage("Allô, oui, c'est bien.", true), 'en-US');
    });

    // The partial (non-final) language is carried in the transcribing payload and
    // used as the SOURCE language for live translation, so it must stay coherent:
    // once a session is established, every partial proposes that language, never
    // a ghost, even for a prefix franc would misread on its own.
    it('proposes a coherent, stable language on partials (translation source)', function () {
        const d = createLangDetector(CANDS, { franc });
        d.detectLanguage(MONOLOGUE[0], true);              // French session established
        // A new French utterance arriving as growing partials; its "Allô" prefix
        // is exactly what franc alone tags as Spanish.
        const growing = ["Allô", "Allô, oui", "Allô, oui, c'est", "Allô, oui, c'est bien"];
        const labels = growing.map(p => d.detectLanguage(p, false));
        assert.deepStrictEqual(labels, growing.map(() => 'fr-FR'),
            `partials must stay French, got: ${labels.join(', ')}`);
        // ...and the final of that same segment agrees.
        assert.strictEqual(d.detectLanguage("Allô, oui, c'est bien.", true), 'fr-FR');
    });
});
