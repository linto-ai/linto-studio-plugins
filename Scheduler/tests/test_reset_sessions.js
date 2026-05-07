const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// resetSessions() runs once at scheduler startup to recover after a crash.
// Critically, the filter is strictly `status: 'active'` — paused sessions must
// survive the restart so an operator can resume them.
describe('BrokerClient.resetSessions()', () => {
    it('downgrades only active sessions to ready (paused untouched)', async () => {
        const sessionUpdates = [];
        const channelUpdates = [];

        const model = buildModel({
            Session: {
                update: async (values, options) => {
                    sessionUpdates.push({ values, options });
                    return [0, []];
                },
            },
            Channel: {
                update: async (values, options) => {
                    channelUpdates.push({ values, options });
                    return [0, []];
                },
            },
            Translator: {
                update: async () => [0, []],
            },
        });

        const { instance } = await loadBrokerClient({ model });
        try {
            await instance.resetSessions();
        } finally {
            uninstallMocks();
        }

        // One Session.update call: where status === 'active' → 'ready'.
        const sessionActiveReset = sessionUpdates.find(c =>
            c.options.where && c.options.where.status === 'active' && c.values.status === 'ready'
        );
        assert.ok(sessionActiveReset,
            `expected Session.update with where status='active' → 'ready'; got ${JSON.stringify(sessionUpdates)}`);

        // No update should ever target a paused session.
        for (const upd of sessionUpdates) {
            const status = upd.options.where && upd.options.where.status;
            assert.notStrictEqual(status, 'paused',
                'resetSessions must never touch paused sessions');
            // Reject array-style filters that would silently include 'paused'.
            assert.ok(!(Array.isArray(status) && status.includes('paused')),
                `resetSessions filter should not include paused; got ${JSON.stringify(status)}`);
        }
    });

    it('resets channels with streamStatus=active only', async () => {
        const channelUpdates = [];
        const model = buildModel({
            Session: {
                update: async () => [0, []],
            },
            Channel: {
                update: async (values, options) => {
                    channelUpdates.push({ values, options });
                    return [0, []];
                },
            },
        });

        const { instance } = await loadBrokerClient({ model });
        try {
            await instance.resetSessions();
        } finally {
            uninstallMocks();
        }

        assert.strictEqual(channelUpdates.length, 1,
            `expected exactly one Channel.update; got ${channelUpdates.length}`);
        const upd = channelUpdates[0];
        assert.strictEqual(upd.values.streamStatus, 'inactive');
        assert.strictEqual(upd.options.where.streamStatus, 'active');
    });

    it('does not target channels of paused sessions in its include filter', async () => {
        // The Channel.update include scopes to sessions with status='active' so
        // the streams of paused sessions stay intact across the reset.
        const channelUpdates = [];
        const model = buildModel({
            Session: { update: async () => [0, []] },
            Channel: {
                update: async (values, options) => {
                    channelUpdates.push({ values, options });
                    return [0, []];
                },
            },
        });

        const { instance } = await loadBrokerClient({ model });
        try {
            await instance.resetSessions();
        } finally {
            uninstallMocks();
        }

        const upd = channelUpdates[0];
        assert.ok(Array.isArray(upd.options.include), 'include should be an array');
        const sessionInclude = upd.options.include.find(i => i.as === 'session');
        assert.ok(sessionInclude, 'expected an include scoping to session alias');
        assert.strictEqual(sessionInclude.where.status, 'active',
            'channel reset must scope to sessions with status=active only');
    });
});
