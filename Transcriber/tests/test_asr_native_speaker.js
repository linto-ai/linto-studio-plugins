/**
 * Unit tests for the ASR wrapper's native-diarization and secret-redaction
 * surface (Transcriber/ASR/index.js):
 *   - constructor wiring of speakerTracker / diarizationMode / _prevFinalSegmentId
 *   - _applyNativeSpeaker guard / assignment / read-only secondary behaviour
 *   - _secretValues build + caching + fail-soft
 *   - _redactSecrets string coercion, length floor, replace-all, Error handling
 *   - init()/provider 'error' redaction
 *   - provider 'transcribing'/'transcribed' native-speaker + bounded-memory cleanup
 *
 * Same plumbing as test_asr_pause_resume.js: inject a mocked live-srt-lib +
 * neutral logger via setupMocks, then drive the real ASR/index.js against
 * FakeTranscriber (channel.enableLiveTranscripts:false). The provider is driven
 * directly with emit() so interleaving/cardinality are fully controlled — no
 * timers, no network, deterministic.
 */

const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const ASR_MOCK_OPTS = {
    invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js')],
    mockWs: false,
    circularBuffer: true,
};

let teardown;

describe('ASR native diarization + secret redaction', () => {
    let ASR;

    before(() => {
        teardown = setupMocks(ASR_MOCK_OPTS);
        ASR = require('../ASR/index.js');
    });

    after(() => {
        if (teardown) teardown();
    });

    function makeSession() {
        return { id: 'test-session-id' };
    }

    function makeChannel(overrides = {}) {
        return Object.assign({
            id: 'test-channel-id',
            enableLiveTranscripts: false, // forces FakeTranscriber as provider
            keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } },
            translations: [],
        }, overrides);
    }

    async function makeAsr(options = {}, channelOverrides = {}) {
        const asr = new ASR(makeSession(), makeChannel(channelOverrides), options);
        // init() is queued on the transition lock without await in the
        // constructor; let it settle so provider/state are set up.
        await new Promise((r) => setImmediate(r));
        await asr._transitionLock;
        return asr;
    }

    // A pilotable SpeakerTracker double that records calls and returns scripted
    // speakers per segment. No timers / no real diarization state.
    function makeTracker(scripted = {}) {
        return {
            assignCalls: [],
            clearCalls: [],
            speakers: Object.assign({}, scripted), // segmentId -> speaker | null
            assignSpeakerToSegment(segmentId) { this.assignCalls.push(segmentId); },
            getSpeakerForSegment(segmentId) {
                return Object.prototype.hasOwnProperty.call(this.speakers, segmentId)
                    ? this.speakers[segmentId]
                    : null;
            },
            clearSegment(segmentId) { this.clearCalls.push(segmentId); },
        };
    }

    // -------- Constructor wiring -----------------------------------------

    describe('constructor wiring', () => {
        it('stores the provided speakerTracker', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ speakerTracker: tracker });
            assert.strictEqual(asr.speakerTracker, tracker);
        });

        it('speakerTracker defaults to null', async () => {
            const asr = await makeAsr();
            assert.strictEqual(asr.speakerTracker, null);
        });

        it('stores the provided diarizationMode', async () => {
            const asr = await makeAsr({ diarizationMode: 'native' });
            assert.strictEqual(asr.diarizationMode, 'native');
        });

        it("diarizationMode defaults to 'asr'", async () => {
            const asr = await makeAsr();
            assert.strictEqual(asr.diarizationMode, 'asr');
        });

        it('_prevFinalSegmentId initializes to null', async () => {
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: makeTracker() });
            assert.strictEqual(asr._prevFinalSegmentId, null);
        });
    });

    // -------- _applyNativeSpeaker ----------------------------------------

    describe('_applyNativeSpeaker', () => {
        it("early-exits (no assignment) when diarizationMode is 'asr'", async () => {
            const tracker = makeTracker({ 5: { id: 'u1', name: 'Alice' } });
            const asr = await makeAsr({ diarizationMode: 'asr', speakerTracker: tracker });
            const t = { segmentId: 5, locutor: 'orig' };
            asr._applyNativeSpeaker(t);
            assert.strictEqual(tracker.assignCalls.length, 0);
            assert.strictEqual(t.locutor, 'orig', 'locutor untouched when not in native mode');
        });

        it('early-exits when speakerTracker is null (even in native mode)', async () => {
            const asr = await makeAsr({ diarizationMode: 'native' });
            assert.strictEqual(asr.speakerTracker, null);
            const t = { segmentId: 5, locutor: 'orig' };
            // Must not throw despite null tracker.
            asr._applyNativeSpeaker(t);
            assert.strictEqual(t.locutor, 'orig');
        });

        it('calls assignSpeakerToSegment for primary results (isPrimary !== false)', async () => {
            const tracker = makeTracker({ 7: { id: 'u1', name: 'Alice' } });
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            asr._applyNativeSpeaker({ segmentId: 7 });           // untagged => primary
            asr._applyNativeSpeaker({ segmentId: 7, isPrimary: true });
            assert.deepStrictEqual(tracker.assignCalls, [7, 7]);
        });

        it('skips assignSpeakerToSegment for secondary results (isPrimary === false)', async () => {
            const tracker = makeTracker({ 7: { id: 'u1', name: 'Alice' } });
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            asr._applyNativeSpeaker({ segmentId: 7, isPrimary: false });
            assert.strictEqual(tracker.assignCalls.length, 0, 'secondary must not own the assignment');
        });

        it('applies speaker via locutor preferring name over id', async () => {
            const tracker = makeTracker({ 3: { id: 'u9', name: 'Bob' } });
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const t = { segmentId: 3, locutor: 'provider-said' };
            asr._applyNativeSpeaker(t);
            assert.strictEqual(t.locutor, 'Bob');
        });

        it('falls back to speaker.id when name is absent', async () => {
            const tracker = makeTracker({ 3: { id: 'u9' } });
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const t = { segmentId: 3, locutor: 'provider-said' };
            asr._applyNativeSpeaker(t);
            assert.strictEqual(t.locutor, 'u9');
        });

        it('no-op on locutor when getSpeakerForSegment returns null', async () => {
            const tracker = makeTracker({}); // no speaker for any segment
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const t = { segmentId: 11, locutor: 'keep-me' };
            asr._applyNativeSpeaker(t);
            assert.strictEqual(t.locutor, 'keep-me', 'locutor unmodified when no speaker known');
        });
    });

    // -------- _secretValues ----------------------------------------------

    describe('_secretValues', () => {
        it('returns the cached Set on the second call without rebuilding', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'supersecretkey' } },
            });
            const first = asr._secretValues();
            const second = asr._secretValues();
            assert.strictEqual(first, second, 'same Set instance is returned (cached)');
        });

        it('collects both the encrypted at-rest and the decrypted credential forms', async () => {
            // MockSecurity.safeDecrypt strips an 'encrypted:' prefix.
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'encrypted:plaintextkey' } },
            });
            const secrets = asr._secretValues();
            assert.ok(secrets.has('encrypted:plaintextkey'), 'at-rest value collected');
            assert.ok(secrets.has('plaintextkey'), 'decrypted value collected');
        });

        it('skips empty/non-string credential fields without error', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: {
                    config: {
                        type: 'fake',
                        key: '',            // empty
                        apiKey: null,       // non-string
                        credentials: 12345, // non-string
                        password: 'realpassword',
                    },
                },
            });
            const secrets = asr._secretValues();
            assert.ok(!secrets.has(''), 'empty string not added');
            assert.ok(!secrets.has(12345), 'number not added');
            assert.ok(secrets.has('realpassword'), 'the one valid string field is collected');
        });

        it('is fail-soft on decrypt exceptions: the at-rest value is still redacted', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'tokenvalue123' } },
            });
            // Force safeDecrypt to throw on this instance's Security; build happens lazily.
            const secrets = (() => {
                // Patch the prototype temporarily so the lazily-built set hits the throw.
                const SecurityCtor = require('live-srt-lib').Security;
                const orig = SecurityCtor.prototype.safeDecrypt;
                SecurityCtor.prototype.safeDecrypt = () => { throw new Error('decrypt boom'); };
                try {
                    return asr._secretValues();
                } finally {
                    SecurityCtor.prototype.safeDecrypt = orig;
                }
            })();
            assert.ok(secrets.has('tokenvalue123'), 'at-rest value redacted despite decrypt throwing');
        });

        it('is fail-soft when the profile/config is missing (returns an empty Set)', async () => {
            const asr = await makeAsr({}, { transcriberProfile: null });
            const secrets = asr._secretValues();
            assert.ok(secrets instanceof Set);
            assert.strictEqual(secrets.size, 0);
        });

        it('is fail-soft when accessing channel/config throws (returns an empty Set)', async () => {
            const asr = await makeAsr();
            // Make channel.transcriberProfile throw on access.
            Object.defineProperty(asr, 'channel', {
                configurable: true,
                get() { throw new Error('channel exploded'); },
            });
            const secrets = asr._secretValues();
            assert.ok(secrets instanceof Set);
            assert.strictEqual(secrets.size, 0, 'setup error swallowed, empty set returned');
        });
    });

    // -------- _redactSecrets ---------------------------------------------

    describe('_redactSecrets', () => {
        it('extracts and uses error.message when given an Error object', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'megasecret' } },
            });
            const out = asr._redactSecrets(new Error('auth failed with key megasecret'));
            assert.strictEqual(out, 'auth failed with key [REDACTED]');
        });

        it('returns a string (not the original Error object)', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'megasecret' } },
            });
            const out = asr._redactSecrets(new Error('boom megasecret'));
            assert.strictEqual(typeof out, 'string');
        });

        it('converts a non-string value to string via String()', async () => {
            const asr = await makeAsr();
            assert.strictEqual(asr._redactSecrets(42), '42');
            assert.strictEqual(asr._redactSecrets(true), 'true');
        });

        it('returns the original value when String() conversion throws', async () => {
            const asr = await makeAsr();
            // Object whose toString throws and has no .message -> String() throws.
            const evil = { toString() { throw new Error('no string for you'); } };
            const out = asr._redactSecrets(evil);
            assert.strictEqual(out, evil, 'unconvertible value returned untouched');
        });

        it('ignores secrets shorter than 6 chars (no incidental redaction)', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'abc' } }, // len 3
            });
            const out = asr._redactSecrets('value abc here');
            assert.strictEqual(out, 'value abc here', 'short secret must not be scrubbed');
        });

        it('replaces every occurrence of each secret', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'repeatedSecret' } },
            });
            const out = asr._redactSecrets('repeatedSecret then repeatedSecret again repeatedSecret');
            assert.strictEqual(out, '[REDACTED] then [REDACTED] again [REDACTED]');
        });

        it('returns the input unchanged when no secret matches', async () => {
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'notpresenthere' } },
            });
            const out = asr._redactSecrets('a clean log line');
            assert.strictEqual(out, 'a clean log line');
        });
    });

    // -------- init() / provider 'error' redaction ------------------------

    describe('error redaction in logging paths', () => {
        it('init() error handler redacts secrets before logging', async () => {
            const errors = [];
            const asr = new ASR(makeSession(), makeChannel({
                // No profile config + live transcripts on would normally use Fake,
                // but we force a real init failure path below.
                transcriberProfile: { config: { type: 'nonexistent-provider-xyz', key: 'initkeysecret' } },
                enableLiveTranscripts: true,
            }), {});
            asr.logger.error = (m) => errors.push(m);
            await new Promise((r) => setImmediate(r));
            await asr._transitionLock;
            // loadAsr throws "No ASR named 'nonexistent-provider-xyz' ..." — message
            // does not contain the secret, but the redaction wrapper must have run
            // (string, not the Error object).
            assert.strictEqual(asr.state, ASR.states.ERROR);
            assert.ok(errors.length >= 1, 'init failure was logged');
            assert.ok(errors.every((e) => typeof e === 'string'),
                'logged error went through _redactSecrets (string output)');
        });

        it("init() redacts a secret that surfaces in the thrown error message", async () => {
            const errors = [];
            // Force init to throw an error whose message embeds the secret.
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'leakyinitsecret' } },
            });
            asr.logger.error = (m) => errors.push(m);
            // Re-run init; init() rebuilds the provider, so patch the FakeTranscriber
            // prototype's start() to throw an error embedding the secret.
            const FakeTranscriber = require('../ASR/fake/index.js');
            const origStart = FakeTranscriber.prototype.start;
            FakeTranscriber.prototype.start = async () => {
                throw new Error('cannot connect: leakyinitsecret');
            };
            try {
                await asr.init();
            } finally {
                FakeTranscriber.prototype.start = origStart;
            }
            assert.ok(errors.some((e) => e === 'cannot connect: [REDACTED]'),
                `expected redacted message, got ${JSON.stringify(errors)}`);
        });

        it("provider 'error' event redacts secrets before logging", async () => {
            const errors = [];
            const asr = await makeAsr({}, {
                transcriberProfile: { config: { type: 'fake', key: 'providererrsecret' } },
            });
            asr.logger.error = (m) => errors.push(m);
            asr.provider.emit('error', new Error('SDK auth rejected providererrsecret'));
            assert.ok(errors.some((e) => e === 'SDK auth rejected [REDACTED]'),
                `expected redacted provider error, got ${JSON.stringify(errors)}`);
        });
    });

    // -------- provider 'transcribing' / 'transcribed' native speaker -----

    describe("provider events apply native speaker", () => {
        it("'transcribing' (partial) applies native speaker before emit", async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg = asr.segmentId;
            tracker.speakers[seg] = { id: 'u1', name: 'Alice' };
            const partials = [];
            asr.on('partial', (t) => partials.push(t));

            asr.provider.emit('transcribing', { text: 'hello' });

            assert.strictEqual(partials.length, 1);
            assert.strictEqual(partials[0].locutor, 'Alice', 'partial carries native speaker');
            assert.ok(tracker.assignCalls.includes(seg), 'partial assigned the segment');
        });

        it("'transcribed' (final) applies native speaker before emit", async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg = asr.segmentId;
            tracker.speakers[seg] = { id: 'u2', name: 'Bob' };
            const finals = [];
            asr.on('final', (t) => finals.push(t));

            asr.provider.emit('transcribed', { text: 'world' });

            assert.strictEqual(finals.length, 1);
            assert.strictEqual(finals[0].locutor, 'Bob', 'final carries native speaker');
        });
    });

    // -------- bounded-memory cleanup on primary finals -------------------

    describe("'transcribed' bounded-memory cleanup", () => {
        it('updates _prevFinalSegmentId to the current segment after a primary final', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'first', isPrimary: true });
            assert.strictEqual(asr._prevFinalSegmentId, seg);
        });

        it('does NOT clearSegment on the first primary final (_prevFinalSegmentId still null)', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            asr.provider.emit('transcribed', { text: 'first', isPrimary: true });
            assert.strictEqual(tracker.clearCalls.length, 0, 'nothing to clear on first final');
        });

        it('clears the PREVIOUS segment (not the current) on the second primary final', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg1 = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'one', isPrimary: true });   // seg1, no clear
            const seg2 = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'two', isPrimary: true });   // clears seg1
            assert.deepStrictEqual(tracker.clearCalls, [seg1],
                'only the previous primary final segment is cleared');
            assert.strictEqual(asr._prevFinalSegmentId, seg2);
        });

        it('skips clearSegment entirely when speakerTracker is null', async () => {
            // native mode but no tracker: cleanup branch must be skipped (and never throw).
            const asr = await makeAsr({ diarizationMode: 'native' });
            assert.strictEqual(asr.speakerTracker, null);
            const start = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'one', isPrimary: true });
            asr.provider.emit('transcribed', { text: 'two', isPrimary: true });
            // _prevFinalSegmentId still tracked even without a tracker.
            assert.strictEqual(asr._prevFinalSegmentId, start + 1);
        });

        it('secondary final (isPrimary===false) skips cleanup and the _prevFinalSegmentId update', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            // Establish a primary so _prevFinalSegmentId/_lastPrimarySegmentId are set.
            const seg1 = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'primary', isPrimary: true });
            const prevAfterPrimary = asr._prevFinalSegmentId; // seg1
            const segAfterPrimary = asr.segmentId;             // seg1+1
            tracker.clearCalls.length = 0;

            asr.provider.emit('transcribed', { text: 'translation', isPrimary: false });

            assert.strictEqual(asr._prevFinalSegmentId, prevAfterPrimary,
                'secondary must not touch _prevFinalSegmentId');
            assert.strictEqual(asr.segmentId, segAfterPrimary, 'secondary must not advance segmentId');
            assert.strictEqual(tracker.clearCalls.length, 0, 'secondary must not clear any segment');
        });
    });

    // -------- dual-recognizer secondary reads primary's speaker ----------

    describe('dual-recognizer secondary inherits primary speaker (read-only)', () => {
        it('secondary partial reads the speaker from the primary segment without assigning', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg = asr.segmentId;
            // Primary partial assigns + reads.
            tracker.speakers[seg] = { id: 'u1', name: 'Alice' };
            const partials = [];
            asr.on('partial', (t) => partials.push(t));
            asr.provider.emit('transcribing', { text: 'hi', isPrimary: true });
            const assignsAfterPrimary = tracker.assignCalls.length;

            // Secondary partial (translation) pinned to the same segment via
            // _lastPrimarySegmentId; reads the speaker but does NOT assign.
            asr.provider.emit('transcribing', { text: 'salut', isPrimary: false });

            assert.strictEqual(tracker.assignCalls.length, assignsAfterPrimary,
                'secondary partial must not call assignSpeakerToSegment');
            assert.strictEqual(partials[1].locutor, 'Alice',
                'secondary partial inherits the primary segment speaker');
            assert.strictEqual(partials[1].segmentId, seg, 'secondary pinned to primary segment');
        });

        it('secondary final reads the speaker from the primary segment without assigning', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg = asr.segmentId;
            tracker.speakers[seg] = { id: 'u2', name: 'Bob' };
            const finals = [];
            asr.on('final', (t) => finals.push(t));
            asr.provider.emit('transcribed', { text: 'hello', isPrimary: true });
            const assignsAfterPrimary = tracker.assignCalls.length;

            asr.provider.emit('transcribed', { text: 'bonjour', isPrimary: false });

            assert.strictEqual(tracker.assignCalls.length, assignsAfterPrimary,
                'secondary final must not call assignSpeakerToSegment');
            assert.strictEqual(finals[1].locutor, 'Bob',
                'secondary final inherits the primary segment speaker');
            assert.strictEqual(finals[1].segmentId, seg);
        });
    });

    // -------- speaker persistence / bounded memory across boundaries -----

    describe('segment speaker persistence across boundaries', () => {
        it('the just-emitted segment survives one more boundary (current + 1) before cleanup', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const seg1 = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'A', isPrimary: true }); // emits seg1
            // After the first final, seg1 is NOT yet cleared — a lagging secondary
            // could still read it.
            assert.ok(!tracker.clearCalls.includes(seg1),
                'seg1 still available immediately after its own final (lag window)');
            const seg2 = asr.segmentId;
            asr.provider.emit('transcribed', { text: 'B', isPrimary: true }); // emits seg2, clears seg1
            assert.ok(tracker.clearCalls.includes(seg1), 'seg1 cleared one boundary later');
            assert.ok(!tracker.clearCalls.includes(seg2), 'seg2 still kept (its own final just emitted)');
        });

        it('memory is bounded: only the previous segment is ever cleared, never older ones', async () => {
            const tracker = makeTracker();
            const asr = await makeAsr({ diarizationMode: 'native', speakerTracker: tracker });
            const segs = [];
            for (let i = 0; i < 4; i++) {
                segs.push(asr.segmentId);
                asr.provider.emit('transcribed', { text: `seg${i}`, isPrimary: true });
            }
            // 4 primary finals: clears fire for segs[0], segs[1], segs[2]; the last
            // (segs[3]) is still kept. Each clear is exactly the immediately-previous
            // segment — no older segment is re-cleared and no double-clears.
            assert.deepStrictEqual(tracker.clearCalls, [segs[0], segs[1], segs[2]]);
            assert.ok(!tracker.clearCalls.includes(segs[3]), 'most recent segment is retained');
        });
    });
});
