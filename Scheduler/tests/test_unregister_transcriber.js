const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// When a transcriber drops, paused sessions cannot remain paused (they have no
// owner anymore). The patch downgrades them to 'ready' AND emits a warn so an
// operator notices the implicit state change.
describe('BrokerClient.unregisterTranscriber()', () => {
    it('downgrades a paused session to ready and warns explicitly', async () => {
        const channelUpdates = [];
        const sessionSaves = [];

        // Mock session that mimics a Sequelize instance: mutable .status + .save()
        const pausedSession = {
            id: 'sess-paused-1',
            status: 'paused',
            save: async function () {
                sessionSaves.push({ id: this.id, status: this.status });
            },
        };

        const model = buildModel({
            Session: {
                findAll: async () => [pausedSession],
                update: async () => [0, []],
            },
            Channel: {
                update: async (values, options) => {
                    channelUpdates.push({ values, options });
                    return [1, []];
                },
                count: async () => 0, // no remaining active channels → triggers downgrade
            },
        });

        const { instance, logs } = await loadBrokerClient({ model });
        try {
            await instance.unregisterTranscriber({ uniqueId: 'transcriber-X' });
        } finally {
            uninstallMocks();
        }

        // 1. Channels owned by the dropped transcriber are released.
        assert.strictEqual(channelUpdates.length, 1);
        assert.strictEqual(channelUpdates[0].values.streamStatus, 'inactive');
        assert.strictEqual(channelUpdates[0].values.transcriberId, null);
        assert.deepStrictEqual(channelUpdates[0].options.where, { transcriberId: 'transcriber-X' });

        // 2. The paused session is saved as 'ready'.
        assert.strictEqual(sessionSaves.length, 1);
        assert.strictEqual(sessionSaves[0].status, 'ready',
            'paused session should be downgraded to ready when its transcriber goes offline');

        // 3. A warn log is emitted with both the session id and transcriber id.
        const warns = logs.filter(l => l.level === 'warn');
        assert.ok(warns.length >= 1, `expected at least one warn log; got ${JSON.stringify(logs)}`);
        const matched = warns.find(w =>
            w.msg.includes('sess-paused-1') &&
            w.msg.includes('transcriber-X') &&
            /paused/i.test(w.msg) &&
            /ready/.test(w.msg)
        );
        assert.ok(matched, `expected warn mentioning paused→ready downgrade; got ${JSON.stringify(warns)}`);
    });

    it('does not warn when the affected session was not paused', async () => {
        const readySession = {
            id: 'sess-ready-1',
            status: 'ready',
            save: async function () {},
        };

        const model = buildModel({
            Session: {
                findAll: async () => [readySession],
                update: async () => [0, []],
            },
            Channel: {
                update: async () => [1, []],
                count: async () => 0,
            },
        });

        const { instance, logs } = await loadBrokerClient({ model });
        try {
            await instance.unregisterTranscriber({ uniqueId: 'transcriber-Y' });
        } finally {
            uninstallMocks();
        }

        const pausedWarns = logs.filter(l => l.level === 'warn' && /paused/i.test(l.msg));
        assert.strictEqual(pausedWarns.length, 0,
            'no paused warn should be emitted for a session that was already ready');
    });
});
