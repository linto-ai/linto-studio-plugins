const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// reconcileStuckSessions() is the defense-in-depth safety net for the
// cross-channel race: a session left status='active' with zero active channels
// (no owner, quiet long enough) must be healed back to 'ready'. It must NOT
// touch sessions that could still be activating.
describe('BrokerClient.reconcileStuckSessions()', () => {
    const QUIET_AGO = new Date(Date.now() - 120 * 1000); // 2 min ago: well past the 45s window
    const RECENT = new Date(); // now: inside the window

    // Build a model where one active session has the given channels, plus a
    // lockable session instance returned by findByPk that records save().
    function modelFor(channels, lockedStatus = 'active') {
        const saves = [];
        const lockedSession = {
            id: 'sess-1',
            status: lockedStatus,
            save: async function () { saves.push({ id: this.id, status: this.status }); },
        };
        const model = buildModel({
            Session: {
                findAll: async () => [{ id: 'sess-1' }],
                findByPk: async () => lockedSession,
                update: async () => [0, []],
            },
            Channel: {
                findAll: async () => channels,
                count: async () => channels.filter(c => c.streamStatus === 'active').length,
            },
        });
        return { model, saves };
    }

    it('heals an active session with 0 active channels, no owner, quiet long enough', async () => {
        const { model, saves } = modelFor([
            { streamStatus: 'inactive', transcriberId: null, updatedAt: QUIET_AGO },
            { streamStatus: 'inactive', transcriberId: null, updatedAt: QUIET_AGO },
        ]);
        const { instance, logs } = await loadBrokerClient({ model });
        let healed;
        try {
            healed = await instance.reconcileStuckSessions();
        } finally {
            uninstallMocks();
        }

        assert.strictEqual(healed, true, 'reconciler should report it healed a session');
        assert.strictEqual(saves.length, 1, 'the stuck session should be saved exactly once');
        assert.strictEqual(saves[0].status, 'ready', 'stuck session must be set to ready');
        const warned = logs.some(l => l.level === 'warn' && /reconciler/i.test(l.msg) && l.msg.includes('sess-1'));
        assert.ok(warned, 'a warn should be emitted when healing a stuck session');
    });

    it('does NOT heal when a channel is still active', async () => {
        const { model, saves } = modelFor([
            { streamStatus: 'active', transcriberId: 't1', updatedAt: QUIET_AGO },
            { streamStatus: 'inactive', transcriberId: null, updatedAt: QUIET_AGO },
        ]);
        const { instance } = await loadBrokerClient({ model });
        let healed;
        try {
            healed = await instance.reconcileStuckSessions();
        } finally {
            uninstallMocks();
        }
        assert.strictEqual(healed, false);
        assert.strictEqual(saves.length, 0, 'an active channel must prevent healing');
    });

    it('does NOT heal when a channel still has an owning transcriber', async () => {
        const { model, saves } = modelFor([
            { streamStatus: 'inactive', transcriberId: 't1', updatedAt: QUIET_AGO },
        ]);
        const { instance } = await loadBrokerClient({ model });
        let healed;
        try {
            healed = await instance.reconcileStuckSessions();
        } finally {
            uninstallMocks();
        }
        assert.strictEqual(healed, false);
        assert.strictEqual(saves.length, 0, 'a lingering owner must prevent healing');
    });

    it('does NOT heal a session that went quiet only recently (activation may be in flight)', async () => {
        const { model, saves } = modelFor([
            { streamStatus: 'inactive', transcriberId: null, updatedAt: RECENT },
        ]);
        const { instance } = await loadBrokerClient({ model });
        let healed;
        try {
            healed = await instance.reconcileStuckSessions();
        } finally {
            uninstallMocks();
        }
        assert.strictEqual(healed, false);
        assert.strictEqual(saves.length, 0, 'recently-touched sessions must be left alone');
    });

    it('does NOT heal when channels have no usable updatedAt timestamp', async () => {
        const { model, saves } = modelFor([
            { streamStatus: 'inactive', transcriberId: null, updatedAt: null },
        ]);
        const { instance } = await loadBrokerClient({ model });
        let healed;
        try {
            healed = await instance.reconcileStuckSessions();
        } finally {
            uninstallMocks();
        }
        assert.strictEqual(healed, false);
        assert.strictEqual(saves.length, 0, 'missing timestamps must skip, never blindly heal');
    });

    it('re-checks under the lock and skips if the session is no longer active', async () => {
        // Channels look stuck, but by the time we lock, the row is already 'ready'.
        const { model, saves } = modelFor([
            { streamStatus: 'inactive', transcriberId: null, updatedAt: QUIET_AGO },
        ], 'ready');
        const { instance } = await loadBrokerClient({ model });
        let healed;
        try {
            healed = await instance.reconcileStuckSessions();
        } finally {
            uninstallMocks();
        }
        assert.strictEqual(healed, false);
        assert.strictEqual(saves.length, 0, 'must not write if the locked row is no longer active');
    });
});
