const assert = require('assert');
const { describe, it, before, after } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// updateSession() builds a Sequelize literal SQL CASE expression that must
// preserve `paused` and `terminated` statuses untouched. We capture the
// literal passed to Session.update and assert on its raw SQL string —
// fully simulating the DB engine isn't worth the complexity here, so this is
// effectively a smoke test on the SQL fragment shape.
describe('BrokerClient.updateSession()', () => {
    let updateCalls;
    let instance;

    before(async () => {
        updateCalls = [];
        const model = buildModel({
            Session: {
                findAll: async () => [],
                findByPk: async () => null,
                update: async (values, options) => {
                    updateCalls.push({ table: 'Session', values, options });
                    return [1, []];
                },
            },
            Channel: {
                findAll: async () => [],
                count: async () => 0,
                update: async (values, options) => {
                    updateCalls.push({ table: 'Channel', values, options });
                    return [1, []];
                },
            },
        });
        const loaded = await loadBrokerClient({ model });
        instance = loaded.instance;

        // Trigger an "active" stream update on a session — the only path that
        // exercises the full CASE expression with paused/terminated guards.
        await instance.updateSession('transcriber-1', 'session-42', 'channel-99', 'active');
    });

    after(() => uninstallMocks());

    it('issues an UPDATE on the Session table', () => {
        const sessionUpdate = updateCalls.find(c => c.table === 'Session');
        assert.ok(sessionUpdate, 'expected Session.update to be called');
    });

    it('uses a CASE expression that short-circuits when status = paused', () => {
        const sessionUpdate = updateCalls.find(c => c.table === 'Session');
        const statusLiteral = sessionUpdate.values.status;
        assert.ok(statusLiteral && statusLiteral.__literal,
            'status should be a sequelize.literal()');
        const sql = statusLiteral.__literal;
        // The patch adds `WHEN "status" = 'paused' THEN "status"` as the first branch.
        assert.ok(/WHEN\s+"status"\s*=\s*'paused'\s+THEN\s+"status"/i.test(sql),
            `paused guard missing in SQL CASE; got: ${sql}`);
    });

    it('uses a CASE expression that short-circuits when status = terminated', () => {
        const sessionUpdate = updateCalls.find(c => c.table === 'Session');
        const sql = sessionUpdate.values.status.__literal;
        assert.ok(/WHEN\s+"status"\s*=\s*'terminated'\s+THEN\s+"status"/i.test(sql),
            `terminated guard missing in SQL CASE; got: ${sql}`);
    });

    it('targets the right session row in the WHERE clause', () => {
        const sessionUpdate = updateCalls.find(c => c.table === 'Session');
        assert.deepStrictEqual(sessionUpdate.options.where, { id: 'session-42' });
    });

    it('updates the channel with provided streamStatus and transcriberId', () => {
        const channelUpdate = updateCalls.find(c => c.table === 'Channel');
        assert.ok(channelUpdate, 'expected Channel.update to be called');
        assert.strictEqual(channelUpdate.values.streamStatus, 'active');
        assert.strictEqual(channelUpdate.values.transcriberId, 'transcriber-1');
    });
});
