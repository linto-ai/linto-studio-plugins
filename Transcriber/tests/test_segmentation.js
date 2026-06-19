const assert = require('assert');
const { setupMocks } = require('./helpers/asr_mocks');

// Coverage for the hybrid segmentation logic that _runSegmentationTick() owns
// (priorities 0-4). The hard-silence drain (priority 5) is pinned separately in
// test_segmentation_reanchor.js. These exercise the deterministic, clock-driven
// paths the Voxtral re-anchor refactor moved into _runSegmentationTick().

describe('Segmentation: priorities 0-4 (punctuation / word-count / silence)', function () {
    let OpenAIStreamingTranscriber;
    let teardown;

    before(function () {
        teardown = setupMocks();
        OpenAIStreamingTranscriber = require('../ASR/openai_streaming/index');
    });

    after(function () {
        if (teardown) teardown();
    });

    // Build a transcriber with overridable segmentation thresholds so each test
    // can isolate a single priority with short, readable text.
    function makeTranscriber(configOverrides = {}) {
        const session = { id: 'test-session' };
        const channel = {
            id: 'test-channel',
            transcriberProfile: {
                config: {
                    type: 'openai_streaming',
                    protocol: 'vllm',
                    endpoint: 'ws://localhost:8000',
                    languages: [{ candidate: 'fr-FR' }, { candidate: 'en-US' }],
                    ...configOverrides
                }
            }
        };
        const t = new OpenAIStreamingTranscriber(session, channel);
        t.start();
        t._sessionReady = true;
        return t;
    }

    function capture(t) {
        const emitted = [];
        t.on('transcribed', p => emitted.push(p));
        return emitted;
    }

    // -- Priority 0: internal sentence boundary (the primary mechanism) --------

    it('Priority 0: _checkInternalBoundary splits at a sentence boundary and keeps the remainder', function () {
        const t = makeTranscriber({ minWords: 2 });
        const emitted = capture(t);

        t.accumulatedText = 'Bonjour le monde. Comment ca va';
        t._checkInternalBoundary();

        assert.strictEqual(emitted.length, 1, 'should emit the completed sentence');
        assert.strictEqual(emitted[0].text, 'Bonjour le monde.');
        assert.strictEqual(t.accumulatedText.trim(), 'Comment ca va', 'remainder is kept for the next segment');
    });

    it('Priority 0: handlePartial splits at the internal boundary as tokens arrive', function () {
        const t = makeTranscriber({ minWords: 2 });
        const emitted = capture(t);

        t.handlePartial('Bonjour le monde. Comment ca va');

        assert.strictEqual(emitted.length, 1, 'partial accumulation should trigger the boundary split');
        assert.strictEqual(emitted[0].text, 'Bonjour le monde.');
    });

    it('Priority 0: does not split when the completed part is below minWords', function () {
        const t = makeTranscriber({ minWords: 4 });
        const emitted = capture(t);

        t.accumulatedText = 'Hi there. Now a longer continuation follows here';
        t._checkInternalBoundary();

        assert.strictEqual(emitted.length, 0, 'a 2-word head must not be cut when minWords is 4');
    });

    // -- Priority 1: hard max words ------------------------------------------

    it('Priority 1: force-cuts at the last sentence boundary when hard max words is exceeded', function () {
        const t = makeTranscriber({ hardMaxWords: 5, minWords: 2 });
        const emitted = capture(t);

        t.accumulatedText = 'one two three. four five six';   // 6 words, break after word 3
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1001);

        assert.strictEqual(emitted.length, 1);
        assert.strictEqual(emitted[0].text, 'one two three.');
        assert.strictEqual(t.accumulatedText.trim(), 'four five six', 'tail is retained for the next segment');
    });

    it('Priority 1: emits everything when hard max is exceeded with no usable break point', function () {
        const t = makeTranscriber({ hardMaxWords: 4, minWords: 2 });
        const emitted = capture(t);

        t.accumulatedText = 'alpha beta gamma delta epsilon';   // 5 words, no punctuation
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1001);

        assert.strictEqual(emitted.length, 1);
        assert.strictEqual(emitted[0].text, 'alpha beta gamma delta epsilon');
        assert.strictEqual(t.accumulatedText, '', 'whole buffer flushed when there is no break point');
    });

    // -- Priority 2: soft max words + punctuation (no silence needed) ---------

    it('Priority 2: emits on soft max words + sentence punctuation without waiting for silence', function () {
        const t = makeTranscriber({ softMaxWords: 4, hardMaxWords: 100, minWords: 2 });
        const emitted = capture(t);

        t.accumulatedText = 'this is quite enough.';   // 4 words + sentence end
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1001);                  // ~no silence

        assert.strictEqual(emitted.length, 1, 'long-enough punctuated text emits immediately');
        assert.strictEqual(emitted[0].text, 'this is quite enough.');
    });

    // -- Priority 3: silence + punctuation + min words -----------------------

    it('Priority 3: emits on silence past the threshold with sentence punctuation', function () {
        const t = makeTranscriber({ silenceThreshold: 100, softMaxWords: 50, hardMaxWords: 100, minWords: 3 });
        const emitted = capture(t);

        t.accumulatedText = 'a short sentence here.';   // 4 words, '.', below soft max
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1000 + 150);            // silence 150 > 100, < hardSilence

        assert.strictEqual(emitted.length, 1);
        assert.strictEqual(emitted[0].text, 'a short sentence here.');
    });

    // -- Priority 4: medium silence + punctuation for shorter segments -------

    it('Priority 4: emits a shorter segment on medium silence + punctuation', function () {
        const t = makeTranscriber({
            punctSilenceThreshold: 100, silenceThreshold: 5000,
            softMaxWords: 8, hardMaxWords: 100, minWords: 3
        });
        const emitted = capture(t);

        t.accumulatedText = 'four words right here.';   // 4 words >= softMax/2, '.'
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1000 + 200);            // 200 > punctSilence 100, < silence 5000

        assert.strictEqual(emitted.length, 1);
        assert.strictEqual(emitted[0].text, 'four words right here.');
    });

    // -- minWords guard: hold tiny fragments ---------------------------------

    it('holds a sub-minWords fragment instead of emitting it (minWords guard)', function () {
        const t = makeTranscriber({ minWords: 5, hardSilenceThreshold: 100000 });
        const emitted = capture(t);

        t.accumulatedText = 'too short.';              // 2 words
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1000 + 50);

        assert.strictEqual(emitted.length, 0, 'a 2-word fragment must not be emitted below minWords');
        assert.strictEqual(t.accumulatedText, 'too short.', 'fragment is retained');
    });

    it('does not emit on silence alone when there is no sentence punctuation', function () {
        const t = makeTranscriber({ silenceThreshold: 100, punctSilenceThreshold: 100, hardSilenceThreshold: 100000, minWords: 3 });
        const emitted = capture(t);

        t.accumulatedText = 'no ending punctuation here at all';   // 6 words, no '.'
        t.lastDeltaTime = 1000;
        t._runSegmentationTick(1000 + 5000);          // long silence but below hardSilence

        assert.strictEqual(emitted.length, 0, 'priorities 2-4 all require sentence punctuation');
    });
});
