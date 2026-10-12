const assert = require('assert');
const { describe, it, afterEach } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks, Op } = require('./helpers');

// system/out/sessions/ended is owed by the Scheduler for a session it ended
// (autoEnd, bot auto-leave): the sessions.endedNotice marker records it, set in
// the same UPDATE as 'terminated' ('pending'), claimed before the publication
// ('sending'), cleared once the broker acknowledged it. A Scheduler restart in
// the middle of the drain, or a broker outage at publication time, no longer
// loses the notification (Studio would never store the conversation):
// recoverEndedNotices() finishes it, at least once. Session-API's stop clears
// the marker when Studio takes the ending over: the Scheduler then publishes
// nothing.

const ENDED = 'system/out/sessions/ended';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-memory sessions table, applying the conditional UPDATEs and the
// endedNotice query of the Scheduler. No channel is active: drains are immediate.
function database(rows) {
    const updates = [];
    const matches = (row, where) => Object.entries(where).every(([key, condition]) => {
        if (key === Op.or) return condition.some((alternative) => matches(row, alternative));
        const value = row[key];
        if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
        if (condition && typeof condition === 'object') {
            if (condition[Op.in]) return condition[Op.in].includes(value);
            if (condition[Op.ne] !== undefined) return value !== condition[Op.ne];
            if (condition[Op.startsWith] !== undefined) return typeof value === 'string' && value.startsWith(condition[Op.startsWith]);
            if (condition[Op.lt] !== undefined) return value instanceof Date && value < condition[Op.lt];
            return false;
        }
        return value === condition;
    });
    const model = buildModel({
        Session: {
            findAll: async (opts = {}) => (opts.where && opts.where[Op.or]
                ? rows.filter((row) => matches(row, opts.where)).map((row) => ({ id: row.id }))
                : []),
            findByPk: async (id) => rows.find((row) => row.id === id) || null,
            update: async (values, opts) => {
                if (values.status && typeof values.status === 'object') return [1, []]; // updateSession's recompute
                const hit = rows.filter((row) => matches(row, opts.where || {}));
                hit.forEach((row) => Object.assign(row, values));
                updates.push({ values, where: opts.where });
                return [hit.length, hit.map((row) => ({ id: row.id, organizationId: row.organizationId }))];
            },
        },
        Channel: {
            count: async () => 0,
            update: async () => [0, []],
        },
    });
    return { model, rows, updates };
}

const session = (id, fields = {}) => Object.assign({ id, status: 'active', organizationId: 'org', endedNotice: null, endedNoticeLeaseUntil: null }, fields);
const ended = (publishes) => publishes.filter((p) => p.topic === ENDED).map((p) => p.payload.id);

describe('Durable sessions/ended (endedNotice)', () => {
    afterEach(() => uninstallMocks());

    it('marks the notice owed in the same conditional UPDATE that terminates a bot session', async () => {
        const db = database([session('s1')]);
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        await instance.endBotSession('s1');
        assert.deepStrictEqual(db.updates[0].values.endedNotice, 'pending');
        assert.strictEqual(db.updates[0].values.status, 'terminated');
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
        assert.strictEqual(db.rows[0].endedNotice, null, 'cleared once acknowledged');
    });

    it('marks the notice owed in autoEnd\'s terminating UPDATE', async () => {
        const db = database([session('s1', { status: 'ready', autoEnd: true })]);
        db.model.Session.update = (orig => async (values, opts) => {
            // autoEnd's UPDATE filters on endOn: the in-memory rows ignore it.
            if (opts.where && opts.where.endOn) delete opts.where.endOn;
            return orig(values, opts);
        })(db.model.Session.update);
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        assert.strictEqual(await instance.autoEnd(), true);
        assert.strictEqual(db.updates[0].values.endedNotice, 'pending');
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
        assert.strictEqual(db.rows[0].endedNotice, null);
    });

    it('retries an autoEnd whose end failed after the termination committed', async () => {
        const db = database([session('s1', { status: 'paused', autoEnd: true })]);
        db.model.Session.update = (orig => async (values, opts) => {
            if (opts.where && opts.where.endOn) delete opts.where.endOn;
            return orig(values, opts);
        })(db.model.Session.update);
        let failures = 1;
        db.model.Channel.update = async () => {
            if (failures-- > 0) throw new Error('connection lost');
            return [0, []];
        };
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        assert.strictEqual(await instance.autoEnd(), true);
        assert.deepStrictEqual(ended(mqttPublishes), [], 'the end failed');
        assert.strictEqual(db.rows[0].status, 'terminated');
        assert.strictEqual(db.rows[0].endedNotice, 'pending', 'still owed');
        await instance.recoverEndedNotices(); // next tick
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
        assert.strictEqual(db.rows[0].endedNotice, null);
    });

    it('publishes nothing when Studio took the ending over (Session-API stop cleared the marker)', async () => {
        const db = database([session('s1')]);
        db.model.Channel.count = async () => { db.rows[0].endedNotice = null; return 0; }; // the stop lands during the drain
        const { instance, mqttPublishes, logs } = await loadBrokerClient({ model: db.model });
        await instance.endBotSession('s1');
        assert.deepStrictEqual(ended(mqttPublishes), []);
        assert.ok(logs.some((l) => /no longer owed/.test(l.msg)), JSON.stringify(logs));
    });

    it('keeps the notice owed while the broker is offline, then publishes it once on recovery', async () => {
        const db = database([session('s1')]);
        const { instance, mqttPublishes, logs } = await loadBrokerClient({ model: db.model });
        instance.client.offline = true;
        await instance.endBotSession('s1');
        assert.deepStrictEqual(ended(mqttPublishes), [], 'not silently dropped either');
        assert.strictEqual(db.rows[0].endedNotice, 'pending', 'still owed, the claim given back');
        assert.ok(logs.some((l) => l.level === 'error' && /retried later/.test(l.msg)));

        instance.client.offline = false;
        await instance.recoverEndedNotices();
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
        assert.strictEqual(db.rows[0].endedNotice, null);
        await instance.recoverEndedNotices();
        assert.deepStrictEqual(ended(mqttPublishes), ['s1'], 'nothing owed any more');
    });

    it('finishes the notices left by a restart when it connects to the broker', async () => {
        const past = new Date(Date.now() - 1000);
        const future = new Date(Date.now() + 60000);
        const db = database([
            session('drained', { status: 'terminated', endedNotice: 'pending' }), // stopped mid-drain
            session('published', { status: 'terminated', endedNotice: 'sending:0badc0de', endedNoticeLeaseUntil: past }), // stopped before clearing
            session('publishing', { status: 'terminated', endedNotice: 'sending:5ca1ab1e', endedNoticeLeaseUntil: future }), // claimed elsewhere, lease running
            session('done', { status: 'terminated' }),
            session('live'),
        ]);
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        instance.client.emit('ready');
        await wait(50);
        assert.deepStrictEqual(ended(mqttPublishes).sort(), ['drained', 'published'], 'at least once');
        assert.deepStrictEqual(db.rows.map((row) => row.endedNotice), [null, null, 'sending:5ca1ab1e', null, null]);
    });

    it('publishes once when two ends of one session overlap (a second bot leaves during the drain)', async () => {
        const db = database([session('s1')]);
        let releaseDrain;
        const drained = new Promise((resolve) => { releaseDrain = resolve; });
        db.model.Channel.count = async () => { await drained; return 0; };
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        const first = instance.endBotSession('s1'); // terminates, drains
        await wait(10);
        await instance.endBotSession('s1'); // already terminated: does not end it again
        assert.ok(instance.endingSessions.has('s1'), 'the first end still holds the session');
        const recovery = instance.recoverEndedNotices(); // a tick during the drain
        await wait(10);
        releaseDrain();
        await Promise.all([first, recovery]);
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
    });

    it('lets a single publication claim a notice: another end finds it claimed', async () => {
        const db = database([session('s1', { status: 'terminated', endedNotice: 'pending' })]);
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        let releasePublish;
        const publishConfirmed = instance.client.publishConfirmed;
        instance.client.publishConfirmed = async (...args) => {
            await new Promise((resolve) => { releasePublish = resolve; });
            return publishConfirmed(...args);
        };
        const first = instance.publishSessionEnded('s1', 100); // claims, publication in flight
        await wait(10);
        assert.match(db.rows[0].endedNotice, /^sending:/);
        await instance.publishSessionEnded('s1', 100); // e.g. a recovery in another Scheduler process
        releasePublish();
        await first;
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
        assert.strictEqual(db.rows[0].endedNotice, null);
    });

    it('does not run an end twice: skips the ends in progress, one recovery at a time', async () => {
        const db = database([session('s1')]);
        let releaseDrain;
        db.model.Channel.count = async () => new Promise((resolve) => { releaseDrain = () => resolve(0); });
        const { instance, mqttPublishes } = await loadBrokerClient({ model: db.model });
        const ending = instance.endBotSession('s1'); // draining: marker 'pending'
        await wait(10);
        await Promise.all([instance.recoverEndedNotices(), instance.recoverEndedNotices()]);
        releaseDrain();
        await ending;
        assert.deepStrictEqual(ended(mqttPublishes), ['s1']);
    });
});

describe('endedNotice claim size', () => {
    const path = require('path');
    afterEach(() => uninstallMocks());

    // The column, as the migration creates it and as lib's model declares it.
    async function columnLength() {
        const libDir = path.dirname(require.resolve('live-srt-lib'));
        const Sequelize = require(require.resolve('sequelize', { paths: [libDir] }));
        const migration = require(path.resolve(__dirname, '../../migration/migrations/20261012000000-add-session-ended-notice.js'));
        let column;
        await migration.up({ addColumn: async (table, name, definition) => { column = definition; } }, Sequelize);
        const { Session } = require(path.join(libDir, 'model/model.js'));
        assert.strictEqual(Session.rawAttributes.endedNotice.type.options.length, column.type.options.length, 'model and migration agree');
        return column.type.options.length;
    }

    it('fits the claim the Scheduler stores, with room to spare', async () => {
        const db = database([session('s1')]);
        const { instance } = await loadBrokerClient({ model: db.model });
        await instance.endBotSession('s1');
        const claim = db.updates.find((u) => typeof u.values.endedNotice === 'string' && u.values.endedNotice.startsWith('sending:')).values.endedNotice;
        const { ENDED_NOTICE_CLAIM_LENGTH } = require('../components/BrokerClient/index.js');
        assert.strictEqual(claim.length, ENDED_NOTICE_CLAIM_LENGTH);
        assert.ok(ENDED_NOTICE_CLAIM_LENGTH < await columnLength());
    });
});
