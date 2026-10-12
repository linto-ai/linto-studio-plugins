const assert = require('assert');
const { describe, it, afterEach } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks, Op } = require('./helpers');

// The Scheduler resynchronizes on every connection to the broker (first, or
// after a broker restart or a network outage). It used to republish the
// sessions snapshot only when a transcriber announced itself. A restarted
// broker loses the retained snapshot, and a transcriber that reconnected before
// the Scheduler announced itself unheard (its status is not retained), so the
// snapshot stayed missing until the next status change (integration scenario
// 11, intermittently).

const STATUSES = 'system/out/sessions/statuses';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Scheduler resynchronization on connecting to the broker', () => {
    afterEach(() => uninstallMocks());

    // Records the resync steps in `events`.
    function recordingModel(events, overrides = {}) {
        return buildModel(Object.assign({
            Session: {
                findAll: async (opts = {}) => {
                    if (opts.where && opts.where[Op.or]) {
                        events.push('owed notices read');
                        return [];
                    }
                    events.push('snapshot read');
                    return [{ id: 's1', status: 'ready' }];
                },
                update: async (values) => {
                    if (values.status === 'ready') events.push('sessions reset');
                    return [0, []];
                },
            },
            Channel: { update: async () => { events.push('channels reset'); return [0, []]; } },
            Translator: { update: async () => { events.push('translators reset'); return [0, []]; }, upsert: async () => [] },
        }, overrides));
    }

    async function connected(model, events) {
        const loaded = await loadBrokerClient({ model });
        const publish = loaded.instance.client.publish;
        loaded.instance.client.publish = (topic, ...rest) => {
            if (topic === STATUSES) events.push('snapshot published');
            publish(topic, ...rest);
        };
        loaded.instance.client.publishStatus = () => events.push('status');
        return loaded;
    }

    it('publishes the sessions snapshot on every connection, after the reset, then finishes the owed notices', async () => {
        const events = [];
        const { instance } = await connected(recordingModel(events), events);
        const cycle = ['status', 'channels reset', 'sessions reset', 'translators reset', 'snapshot read', 'snapshot published', 'owed notices read'];
        instance.client.emit('ready');
        await wait(20);
        assert.deepStrictEqual(events, cycle);
        events.length = 0;
        instance.client.emit('ready'); // e.g. after a broker restart
        await wait(20);
        assert.deepStrictEqual(events, cycle);
    });

    it('does not hold the snapshot back behind a slow recovery of owed notices', async () => {
        const events = [];
        const model = recordingModel(events);
        const findAll = model.Session.findAll;
        model.Session.findAll = async (opts = {}) => {
            if (opts.where && opts.where[Op.or]) {
                events.push('owed notices read');
                return new Promise(() => {}); // the database hangs on that query
            }
            return findAll(opts);
        };
        const { instance } = await connected(model, events);
        instance.client.emit('ready');
        await wait(20);
        assert.ok(events.includes('snapshot published'), events.join(' | '));
        assert.ok(events.indexOf('snapshot published') < events.indexOf('owed notices read'), events.join(' | '));
        events.length = 0;
        instance.client.emit('ready'); // the recovery still hangs: the resync does not wait for it
        await wait(20);
        assert.ok(events.includes('snapshot published'), events.join(' | '));
    });

    it('keeps online the translators heard of on this connection', async () => {
        const events = [];
        const translators = [
            { name: 'stale', online: true, updatedAt: new Date(Date.now() - 60000) }, // gone while disconnected
        ];
        const model = recordingModel(events, {
            Translator: {
                update: async (values, opts) => {
                    const limit = opts.where.updatedAt[Op.lt];
                    translators.filter((t) => t.updatedAt < limit).forEach((t) => Object.assign(t, values));
                    return [0, []];
                },
                upsert: async (values) => {
                    const existing = translators.find((t) => t.name === values.name);
                    if (existing) Object.assign(existing, values, { updatedAt: new Date() });
                    else translators.push(Object.assign({ updatedAt: new Date() }, values));
                    return [];
                },
            },
            Session: {
                findAll: async () => [],
                // The reset is slow: the translator's retained status arrives meanwhile.
                update: async () => { await wait(20); return [0, []]; },
            },
        });
        const { instance } = await connected(model, events);
        instance.client.emit('ready');
        await wait(5);
        await instance.registerTranslator({ name: 'fresh', languages: ['fr'], online: true }); // its retained status
        await wait(50);
        assert.deepStrictEqual(translators.map((t) => [t.name, t.online]), [['stale', false], ['fresh', true]]);
    });

    it('registers a transcriber once, however often it announces itself', async () => {
        const { instance } = await loadBrokerClient();
        await instance.registerTranscriber({ uniqueId: 't1', online: true });
        await instance.registerTranscriber({ uniqueId: 't1', online: true }); // again, on the Scheduler's reconnection
        assert.deepStrictEqual(instance.transcribers.map((t) => t.uniqueId), ['t1']);
    });

    it('publishes snapshots in call order, each read at its turn', async () => {
        let reads = 0;
        const model = buildModel({
            Session: {
                findAll: async () => {
                    reads += 1;
                    if (reads === 1) {
                        await wait(30); // a slow read, from before a change
                        return [{ id: 's1', status: 'active' }];
                    }
                    return [{ id: 's1', status: 'ready' }];
                },
            },
        });
        const { instance, mqttPublishes } = await loadBrokerClient({ model });
        await Promise.all([instance.publishSessions(), instance.publishSessions()]);
        const snapshots = mqttPublishes.filter((p) => p.topic === STATUSES).map((p) => p.payload[0].status);
        assert.deepStrictEqual(snapshots, ['active', 'ready'], 'the latest read is the one retained');
    });
});
