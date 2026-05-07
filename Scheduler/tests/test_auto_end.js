const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks, Op } = require('./helpers');

// autoEnd() fires from the 60s scheduler tick. The patch extended its scope
// from ['ready'] to ['ready', 'paused'] so endOn-expired paused meetings are
// terminated cleanly, and emits a warn whenever a paused session is reaped.
describe('BrokerClient.autoEnd()', () => {
    it('queries findAll and update with status filter ["ready", "paused"]', async () => {
        let findAllArgs = null;
        let updateArgs = null;
        const model = buildModel({
            Session: {
                findAll: async (args) => { findAllArgs = args; return []; },
                update: async (values, options) => {
                    updateArgs = { values, options };
                    return [0, []];
                },
            },
        });

        const { instance } = await loadBrokerClient({ model });
        try {
            await instance.autoEnd();
        } finally {
            uninstallMocks();
        }

        assert.ok(findAllArgs, 'findAll should be called inside the transaction');
        // Sequelize Op-keyed object: { [Op.in]: [...] }. Our helper uses
        // string keys so the assertion is straightforward.
        assert.deepStrictEqual(findAllArgs.where.status, { [Op.in]: ['ready', 'paused'] });
        assert.strictEqual(findAllArgs.where.autoEnd, true);

        assert.ok(updateArgs, 'Session.update should be called');
        assert.strictEqual(updateArgs.values.status, 'terminated');
        assert.deepStrictEqual(updateArgs.options.where.status, { [Op.in]: ['ready', 'paused'] });
    });

    it('emits a warn for each paused session being auto-terminated', async () => {
        const sessionsToEnd = [
            { id: 'sess-paused-A', status: 'paused' },
            { id: 'sess-ready-B', status: 'ready' },
            { id: 'sess-paused-C', status: 'paused' },
        ];

        const model = buildModel({
            Session: {
                findAll: async () => sessionsToEnd,
                findByPk: async (id) => ({ id, organizationId: 'org-1' }),
                update: async () => [3, sessionsToEnd.map(s => ({ id: s.id, organizationId: 'org-1' }))],
            },
            Channel: {
                update: async () => [0, []],
            },
        });

        const { instance, logs, mqttPublishes } = await loadBrokerClient({ model });
        try {
            const updated = await instance.autoEnd();
            assert.strictEqual(updated, true, 'autoEnd should report changes happened');
        } finally {
            uninstallMocks();
        }

        const pausedWarns = logs.filter(l => l.level === 'warn' && /paused/i.test(l.msg));
        // Two paused sessions in the batch → two warn logs.
        assert.strictEqual(pausedWarns.length, 2,
            `expected 2 warn logs for paused auto-end; got ${JSON.stringify(pausedWarns)}`);
        assert.ok(pausedWarns.some(w => w.msg.includes('sess-paused-A')));
        assert.ok(pausedWarns.some(w => w.msg.includes('sess-paused-C')));
        // Plain 'ready' auto-end does not warn (only debug).
        assert.ok(!pausedWarns.some(w => w.msg.includes('sess-ready-B')));

        // Per-session sessions/ended notifications go out for all 3.
        const endedPubs = mqttPublishes.filter(p => p.topic === 'system/out/sessions/ended');
        assert.strictEqual(endedPubs.length, 3);
    });

    it('marks all channels of ended sessions as inactive', async () => {
        let channelUpdate = null;
        const model = buildModel({
            Session: {
                findAll: async () => [{ id: 's1', status: 'paused' }],
                findByPk: async () => ({ id: 's1', organizationId: 'o' }),
                update: async () => [1, [{ id: 's1', organizationId: 'o' }]],
            },
            Channel: {
                update: async (values, options) => {
                    channelUpdate = { values, options };
                    return [1, []];
                },
            },
        });

        const { instance } = await loadBrokerClient({ model });
        try {
            await instance.autoEnd();
        } finally {
            uninstallMocks();
        }

        assert.ok(channelUpdate, 'Channel.update should be called when sessions are auto-ended');
        assert.strictEqual(channelUpdate.values.streamStatus, 'inactive');
        assert.deepStrictEqual(channelUpdate.options.where.sessionId, { [Op.in]: ['s1'] });
    });

    it('returns false and skips channel updates when nothing matches', async () => {
        let channelUpdated = false;
        const model = buildModel({
            Session: {
                findAll: async () => [],
                update: async () => [0, []],
            },
            Channel: {
                update: async () => { channelUpdated = true; return [0, []]; },
            },
        });

        const { instance } = await loadBrokerClient({ model });
        let result;
        try {
            result = await instance.autoEnd();
        } finally {
            uninstallMocks();
        }

        assert.strictEqual(result, false);
        assert.strictEqual(channelUpdated, false,
            'Channel.update must not run when no sessions were auto-ended');
    });
});
