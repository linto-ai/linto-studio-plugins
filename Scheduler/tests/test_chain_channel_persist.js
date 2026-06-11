const assert = require('assert');
const { describe, it, before, after, beforeEach } = require('mocha');
const { loadBrokerClient, uninstallMocks } = require('./helpers');

// chainChannelPersist(sessionId, channelId, fn) serializes persistence tasks
// per channel so the Postgres commit order matches the MQTT arrival order —
// which is what turns the end-of-stream marker and the 'inactive' deactivate
// into real drain barriers. These are pure in-memory tests: `fn` is a
// synthetic task, no DB or broker involved.
describe('BrokerClient.chainChannelPersist()', () => {
    let instance;

    before(async () => {
        const loaded = await loadBrokerClient();
        instance = loaded.instance;
    });

    after(() => uninstallMocks());

    beforeEach(() => {
        instance.channelPersistChains.clear();
    });

    const tick = () => new Promise((r) => setImmediate(r));

    it('runs tasks of the same channel strictly in arrival order', async () => {
        const order = [];
        // A is slow, B is fast: without serialization B would finish first.
        const a = instance.chainChannelPersist('s', 'c', async () => {
            await new Promise((r) => setTimeout(r, 25));
            order.push('A');
        });
        const b = instance.chainChannelPersist('s', 'c', async () => {
            order.push('B');
        });
        await Promise.all([a, b]);
        assert.deepStrictEqual(order, ['A', 'B'],
            'B must wait for the slower A on the same channel');
    });

    it('runs different channels independently (no cross-channel blocking)', async () => {
        const order = [];
        const slow = instance.chainChannelPersist('s', 'c1', async () => {
            await new Promise((r) => setTimeout(r, 30));
            order.push('c1');
        });
        const fast = instance.chainChannelPersist('s', 'c2', async () => {
            order.push('c2');
        });
        await Promise.all([slow, fast]);
        assert.deepStrictEqual(order, ['c2', 'c1'],
            'a slow task on c1 must not delay c2');
    });

    it('keeps the chain alive after a task throws', async () => {
        const order = [];
        // The returned promise is guarded (.catch), so awaiting never rejects.
        await instance.chainChannelPersist('s', 'c', async () => {
            order.push('fail');
            throw new Error('boom');
        });
        await instance.chainChannelPersist('s', 'c', async () => {
            order.push('after');
        });
        assert.deepStrictEqual(order, ['fail', 'after'],
            'a task queued after a failed one must still run');
    });

    it('prunes the map entry once the chain settles (bounded memory)', async () => {
        const p = instance.chainChannelPersist('s', 'c', async () => {});
        assert.strictEqual(instance.channelPersistChains.size, 1,
            'entry present while the task is in flight');
        await p;
        await tick();
        assert.strictEqual(instance.channelPersistChains.size, 0,
            'entry pruned after the chain settles and is still the tail');
    });

    it('keeps the entry while a newer task is still queued', async () => {
        const a = instance.chainChannelPersist('s', 'c', async () => {
            await new Promise((r) => setTimeout(r, 20));
        });
        const b = instance.chainChannelPersist('s', 'c', async () => {
            await new Promise((r) => setTimeout(r, 20));
        });
        await a;
        await tick();
        assert.strictEqual(instance.channelPersistChains.size, 1,
            'A settling must not prune the entry while B is still the tail');
        await b;
        await tick();
        assert.strictEqual(instance.channelPersistChains.size, 0);
    });
});
