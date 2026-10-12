const assert = require('assert');
const { describe, it, afterEach } = require('mocha');
const { buildModel, loadBrokerClient, makeMqttClient, uninstallMocks, Op } = require('./helpers');

// A session end driven by the Scheduler (bot auto-leave, autoEnd) publishes
// system/out/sessions/ended, upon which studio-api builds the conversation from
// the stored captions and deletes the session. The notification must therefore
// wait until the channels' transcribers have stopped their streams and every
// caption they published is persisted (the 'inactive' deactivation is the
// barrier: the Transcriber publishes it after its last final and end-of-stream
// marker, and the per-channel persistence chain commits them in that order).

const SESSION = 'sess-1';
const ENDED = 'publish system/out/sessions/ended';
const STATUSES = 'publish system/out/sessions/statuses';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One session with one channel (id 10). `state.active` is the number of its
// channels with streamStatus 'active'; every DB write and MQTT publish is
// recorded in `events`, in order.
async function load({ active = 1, captionDelayMs = 0, sessionsQuery } = {}) {
    const events = [];
    const state = { active, status: 'active', notice: null, counts: 0 };
    const publishes = [];
    const mqttClient = makeMqttClient(publishes);
    const recordPublish = mqttClient.publish;
    mqttClient.publish = (topic, ...rest) => {
        events.push(`publish ${topic}`);
        recordPublish(topic, ...rest);
    };
    const recordConfirmed = mqttClient.publishConfirmed;
    mqttClient.publishConfirmed = async (topic, ...rest) => {
        await recordConfirmed(topic, ...rest);
        events.push(`publish ${topic}`);
    };
    const loaded = {};
    const model = buildModel({
        Session: {
            findAll: sessionsQuery || (async () => []),
            findByPk: async (id) => ({ id, status: state.status, organizationId: 'org-1' }),
            update: async (values, opts) => {
                if ('endedNotice' in values && values.status === undefined) {
                    // Claim ('sending:<claim>', of a 'pending' notice here), then
                    // clear (null) or give back ('pending') of the owed sessions/ended.
                    const claiming = typeof values.endedNotice === 'string' && values.endedNotice.startsWith('sending:');
                    const matches = claiming ? state.notice === 'pending' : opts.where.endedNotice === state.notice;
                    if (!matches) return [0, []];
                    state.notice = values.endedNotice;
                    if (values.endedNotice === null) events.push('notice cleared');
                    return [1, [{ id: SESSION, organizationId: 'org-1' }]];
                }
                if (values.status !== 'terminated') return [1, []]; // updateSession's recompute
                const where = opts.where.status;
                const matches = where && where[Op.in] ? where[Op.in].includes(state.status)
                    : !(where && where[Op.ne] === state.status);
                if (!matches) return [0, []];
                state.status = 'terminated';
                state.notice = values.endedNotice;
                events.push('terminated');
                return [1, [{ id: SESSION, organizationId: 'org-1' }]];
            },
        },
        Channel: {
            count: async (opts) => {
                state.counts += 1;
                assert.deepStrictEqual(opts.where, { sessionId: SESSION, streamStatus: 'active' });
                return loaded.countHook ? loaded.countHook(state) : state.active;
            },
            update: async (values, opts) => {
                if (values.streamStatus === 'inactive') {
                    state.active = 0;
                    // updateSession deactivates inside its transaction; the end
                    // paths and unregisterTranscriber force channels without one.
                    events.push(opts.transaction ? 'channel deactivated' : 'channels forced inactive');
                }
                return [1, []];
            },
        },
        Caption: {
            create: async (data) => {
                if (captionDelayMs) await delay(captionDelayMs);
                events.push(`caption ${data.segmentId === undefined ? 'marker' : data.segmentId}`);
            },
        },
        TranslatedCaption: {
            create: async (data) => {
                if (captionDelayMs) await delay(captionDelayMs);
                events.push(`translation ${data.segmentId}`);
            },
        },
    });
    const { instance, logs } = await loadBrokerClient({ model, mqttClient });
    return Object.assign(loaded, { instance, logs, events, state, publishes });
}

// The Transcriber's stop sequence for channel 10 as the Scheduler receives it on
// MQTT (see Transcriber StreamingServer._stopAsr): the final flushed by the ASR,
// the end-of-stream marker, then the 'inactive' deactivation, each chained on
// the channel exactly as controllers/MqttEvents.js does.
function transcriberStops(instance) {
    instance.chainChannelPersist(SESSION, '10', () => instance.saveTranscription(
        { segmentId: 7, text: 'last words', locutor: 'Alice' }, SESSION, '10'));
    instance.chainChannelPersist(SESSION, '10', () => instance.saveTranscription(
        { text: '', locutor: 'bot', astart: 'a', aend: 'b' }, SESSION, '10'));
    instance.chainChannelPersist(SESSION, 10, () => instance.updateSession('tr-1', SESSION, 10, 'inactive'));
}

const endedCount = (publishes) => publishes.filter((p) => p.topic === 'system/out/sessions/ended').length;

describe('Session end drain barrier', () => {
    const ORIG_TIMEOUT = process.env.SESSION_STOP_FLUSH_TIMEOUT_MS;
    afterEach(() => {
        uninstallMocks();
        if (ORIG_TIMEOUT === undefined) delete process.env.SESSION_STOP_FLUSH_TIMEOUT_MS;
        else process.env.SESSION_STOP_FLUSH_TIMEOUT_MS = ORIG_TIMEOUT;
    });

    describe('endBotSession()', () => {
        it('publishes sessions/ended only once the stream stopped and its last captions are stored', async () => {
            const { instance, events, publishes } = await load({ captionDelayMs: 20 });
            const ending = instance.endBotSession(SESSION);
            await tick();
            assert.deepStrictEqual(events, ['terminated', STATUSES],
                'terminated, then the statuses snapshot that makes the transcribers cut the stream');

            await delay(30);
            assert.ok(!events.includes(ENDED), 'nothing published while the channel is still active');

            transcriberStops(instance);
            await ending;
            assert.deepStrictEqual(events.slice(2), [
                'caption 7', 'caption marker', 'channel deactivated', STATUSES,
                'channels forced inactive', ENDED, 'notice cleared',
            ]);
            assert.strictEqual(endedCount(publishes), 1);
            assert.deepStrictEqual(publishes.find((p) => p.topic === 'system/out/sessions/ended').payload,
                { id: SESSION, organizationId: 'org-1' });
        });

        it('publishes at once when the stream was already deactivated', async () => {
            const { instance, events, publishes } = await load({ active: 0 });
            await instance.endBotSession(SESSION);
            assert.deepStrictEqual(events, ['terminated', STATUSES, 'channels forced inactive', ENDED, 'notice cleared']);
            assert.strictEqual(endedCount(publishes), 1);
        });

        it('times out cleanly when the transcriber never deactivates the channel', async () => {
            process.env.SESSION_STOP_FLUSH_TIMEOUT_MS = '80';
            const { instance, events, publishes, logs } = await load(); // stays active: dead transcriber
            const start = Date.now();
            await instance.endBotSession(SESSION);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 75 && elapsed < 1000, `bounded by the timeout, took ${elapsed}ms`);
            assert.ok(logs.some((l) => l.level === 'warn' && l.msg.includes(SESSION) && /still active 80ms/.test(l.msg)),
                JSON.stringify(logs));
            assert.deepStrictEqual(events.slice(-3), ['channels forced inactive', ENDED, 'notice cleared'],
                'the session is never left half-open');
            assert.strictEqual(endedCount(publishes), 1);
        });

        it('publishes exactly once for concurrent and repeated ends of the same session', async () => {
            const { instance, publishes } = await load();
            const first = instance.endBotSession(SESSION);
            const second = instance.endBotSession(SESSION);
            await tick();
            transcriberStops(instance);
            await Promise.all([first, second]);
            await instance.endBotSession(SESSION);
            assert.strictEqual(endedCount(publishes), 1);
        });

        it('still drains and publishes when republishing the statuses fails', async () => {
            const { instance, events, publishes, logs } = await load({
                active: 0,
                sessionsQuery: async () => { throw new Error('db hiccup'); },
            });
            await instance.endBotSession(SESSION);
            assert.ok(logs.some((l) => l.level === 'error' && l.msg.includes('db hiccup')));
            assert.strictEqual(endedCount(publishes), 1);
            assert.deepStrictEqual(events.slice(-2), [ENDED, 'notice cleared']);
        });
    });

    describe('waitSessionDrained()', () => {
        it('waits on deactivation events, not on polling, and ignores other sessions', async () => {
            const { instance, state } = await load();
            let drained = null;
            const waiting = instance.waitSessionDrained(SESSION, 5000).then((r) => { drained = r; });
            await delay(50);
            assert.strictEqual(state.counts, 1, 'no polling while nothing happens');
            instance.emit('channel-inactive', 'other-session', 99);
            await tick();
            assert.strictEqual(state.counts, 1, "another session's deactivation does not wake it");
            state.active = 0;
            instance.emit('channel-inactive', SESSION, 10);
            await waiting;
            assert.strictEqual(drained, true);
            assert.strictEqual(state.counts, 2);
        });

        it('does not miss a deactivation committed while the count query runs', async () => {
            const loaded = await load();
            const { instance, state } = loaded;
            loaded.countHook = (s) => {
                if (s.counts > 1) return s.active;
                // The count read the channel as active, then the deactivation
                // committed before the query returned.
                s.active = 0;
                instance.emit('channel-inactive', SESSION, 10);
                return 1;
            };
            const start = Date.now();
            assert.strictEqual(await instance.waitSessionDrained(SESSION, 5000), true);
            assert.ok(Date.now() - start < 1000, 'recounted at once instead of waiting for the timeout');
            assert.strictEqual(state.counts, 2);
        });

        it('is woken by a transcriber going offline (its channels are forced inactive)', async () => {
            const { instance } = await load();
            const waiting = instance.waitSessionDrained(SESSION, 5000);
            await tick();
            const start = Date.now();
            await instance.unregisterTranscriber({ uniqueId: 'tr-1' });
            assert.strictEqual(await waiting, true);
            assert.ok(Date.now() - start < 1000);
        });

        it('waits for the writes already queued on the session channels', async () => {
            const { instance, events } = await load({ active: 0, captionDelayMs: 30 });
            instance.chainChannelPersist(SESSION, '10', () => instance.saveTranslation(
                { segmentId: 7, targetLang: 'en', text: 'last words' }, SESSION, '10'));
            assert.strictEqual(await instance.waitSessionDrained(SESSION, 5000), true);
            assert.deepStrictEqual(events, ['translation 7']);
        });

        it('returns false on timeout and stops listening', async () => {
            const { instance } = await load();
            assert.strictEqual(await instance.waitSessionDrained(SESSION, 30), false);
            assert.strictEqual(instance.listenerCount('channel-inactive'), 0);
        });
    });

    describe('updateSession()', () => {
        it("emits 'channel-inactive' after committing a deactivation, and only then", async () => {
            const { instance, events } = await load();
            const seen = [];
            instance.on('channel-inactive', (sessionId, channelId) => {
                seen.push([sessionId, channelId]);
                events.push('event');
            });
            await instance.updateSession('tr-1', SESSION, 10, 'active');
            assert.deepStrictEqual(seen, [], 'not on activation');
            await instance.updateSession('tr-1', SESSION, 10, 'inactive');
            assert.deepStrictEqual(seen, [[SESSION, 10]]);
            assert.ok(events.indexOf('event') > events.indexOf('channel deactivated'));
        });
    });

    describe('autoEnd()', () => {
        it('publishes sessions/ended for a paused session only after its stream is cut and drained', async () => {
            const { instance, events, publishes, state } = await load({
                sessionsQuery: async () => [{ id: SESSION, status: 'paused' }],
            });
            state.status = 'paused';
            const ending = instance.autoEnd();
            await tick();
            assert.deepStrictEqual(events, ['terminated', STATUSES]);
            // A paused ASR has no pending final: only the marker precedes the deactivation.
            instance.chainChannelPersist(SESSION, '10', () => instance.saveTranscription(
                { text: '', locutor: 'bot', astart: 'a', aend: 'b' }, SESSION, '10'));
            instance.chainChannelPersist(SESSION, 10, () => instance.updateSession('tr-1', SESSION, 10, 'inactive'));
            assert.strictEqual(await ending, true);
            assert.deepStrictEqual(events.slice(2), [
                'caption marker', 'channel deactivated', STATUSES, 'channels forced inactive', ENDED, 'notice cleared',
            ]);
            assert.strictEqual(endedCount(publishes), 1);
        });
    });
});
