const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// Verifies the A5 patch: publishSessions() must surface paused sessions to
// the broker alongside active/ready, otherwise downstream consumers (studio,
// transcribers reconnecting) lose visibility of paused work.
describe('BrokerClient.publishSessions()', () => {
    let instance, mqttPublishes, findAllCallArgs;

    before(async () => {
        findAllCallArgs = null;
        const model = buildModel({
            Session: {
                findAll: async (args) => {
                    findAllCallArgs = args;
                    // Return one session per status to also exercise the publish payload.
                    return [
                        { id: 's1', status: 'active', channels: [] },
                        { id: 's2', status: 'ready', channels: [] },
                        { id: 's3', status: 'paused', channels: [] },
                    ];
                },
                update: async () => [0, []],
            },
        });
        const loaded = await loadBrokerClient({ model });
        instance = loaded.instance;
        mqttPublishes = loaded.mqttPublishes;
        await instance.publishSessions();
    });

    after(() => uninstallMocks());

    it('queries Session.findAll with status filter [active, ready, paused]', () => {
        assert.ok(findAllCallArgs, 'findAll should have been called');
        assert.deepStrictEqual(
            findAllCallArgs.where.status,
            ['active', 'ready', 'paused'],
            `expected status filter to include paused; got ${JSON.stringify(findAllCallArgs.where.status)}`
        );
    });

    it('publishes the resulting sessions on system/out/sessions/statuses (retained)', () => {
        const pub = mqttPublishes.find(p => p.topic === 'system/out/sessions/statuses');
        assert.ok(pub, 'expected a publish to system/out/sessions/statuses');
        assert.strictEqual(pub.retain, true, 'statuses topic should be retained');
        assert.strictEqual(pub.payload.length, 3);
    });

    it('selects channels and transcriberProfile via include', () => {
        assert.ok(Array.isArray(findAllCallArgs.include));
        const channelInclude = findAllCallArgs.include.find(i => i.as === 'channels');
        assert.ok(channelInclude, 'expected an include for channels alias');
    });
});
