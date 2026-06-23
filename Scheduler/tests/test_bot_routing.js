const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

describe('BrokerClient bot routing (BotService)', () => {
  describe('#selectBotService()', () => {
    it('returns null when nothing supports the provider', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['jitsi'] }];
        assert.equal(instance.selectBotService('visio'), null);
      } finally { uninstallMocks(); }
    });

    it('prefers specialists then least loaded', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [
          { uniqueId: 'generalist', online: true, activeBots: 0, capabilities: ['jitsi', 'bigbluebutton', 'teams', 'visio'] },
          { uniqueId: 'specialist-busy', online: true, activeBots: 5, capabilities: ['visio'] },
          { uniqueId: 'specialist-free', online: true, activeBots: 1, capabilities: ['visio'] }
        ];
        assert.equal(instance.selectBotService('visio').uniqueId, 'specialist-free');
      } finally { uninstallMocks(); }
    });

    it('ignores offline replicas', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: false, activeBots: 0, capabilities: ['visio'] }];
        assert.equal(instance.selectBotService('visio'), null);
      } finally { uninstallMocks(); }
    });

    it('breaks an activeBots tie by lower reported memory (rss)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        const MB = 1024 * 1024;
        instance.botservices = [
          // Same bot count, but the first carries a 30-participant Visio load.
          { uniqueId: 'heavy', online: true, activeBots: 2, rss: 1800 * MB, capabilities: ['visio'] },
          { uniqueId: 'light', online: true, activeBots: 2, rss: 300 * MB, capabilities: ['visio'] }
        ];
        assert.equal(instance.selectBotService('visio').uniqueId, 'light');
      } finally { uninstallMocks(); }
    });

    it('activeBots dominates memory (a much lighter but busier replica is not preferred)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        const MB = 1024 * 1024;
        instance.botservices = [
          { uniqueId: 'busy-light', online: true, activeBots: 5, rss: 100 * MB, capabilities: ['visio'] },
          { uniqueId: 'idle-heavy', online: true, activeBots: 0, rss: 1900 * MB, capabilities: ['visio'] }
        ];
        assert.equal(instance.selectBotService('visio').uniqueId, 'idle-heavy');
      } finally { uninstallMocks(); }
    });

    it('excludes a replica that advertised no capabilities (backpressure)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [
          { uniqueId: 'overloaded', online: true, activeBots: 0, capabilities: [] },
          { uniqueId: 'healthy', online: true, activeBots: 3, capabilities: ['visio'] }
        ];
        assert.equal(instance.selectBotService('visio').uniqueId, 'healthy');
      } finally { uninstallMocks(); }
    });
  });

  describe('#registerBotService()/#unregisterBotService()', () => {
    it('adds, then updates load/capabilities on heartbeat', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 0, capabilities: ['visio'] });
        assert.equal(instance.botservices.length, 1);
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 3, capabilities: ['visio', 'teams'] });
        assert.equal(instance.botservices.length, 1);
        assert.equal(instance.botservices[0].activeBots, 3);
        assert.deepEqual(instance.botservices[0].capabilities, ['visio', 'teams']);
      } finally { uninstallMocks(); }
    });

    it('stores reported memory/load and metrics on register and heartbeat', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 1, rss: 1000, heapUsed: 500, metrics: { botJoinAttempts: 2 }, capabilities: ['visio'] });
        assert.equal(instance.botservices[0].rss, 1000);
        assert.equal(instance.botservices[0].heapUsed, 500);
        assert.deepEqual(instance.botservices[0].metrics, { botJoinAttempts: 2 });
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 2, rss: 2000, heapUsed: 800, metrics: { botJoinAttempts: 5 }, capabilities: ['visio'] });
        assert.equal(instance.botservices[0].rss, 2000);
        assert.equal(instance.botservices[0].heapUsed, 800);
        assert.deepEqual(instance.botservices[0].metrics, { botJoinAttempts: 5 });
      } finally { uninstallMocks(); }
    });

    it('removes the replica and drops its ownership entries', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 1, capabilities: ['visio'] });
        instance.botOwnership.set('s1_1', 'bs1');
        instance.botOwnership.set('s2_2', 'bs2');
        await instance.unregisterBotService({ uniqueId: 'bs1' });
        assert.equal(instance.botservices.length, 0);
        assert.equal(instance.botOwnership.has('s1_1'), false);
        assert.equal(instance.botOwnership.has('s2_2'), true);
      } finally { uninstallMocks(); }
    });

    it('reaps orphaned Bot rows owned by a dead replica', async () => {
      const destroys = [];
      const model = buildModel({ Bot: { destroy: async (opts) => { destroys.push(opts); return [2, []]; } } });
      const { instance } = await loadBrokerClient({ model });
      try {
        await instance.unregisterBotService({ uniqueId: 'bs1' });
        assert.ok(destroys.some(d => d.where && d.where.botservice === 'bs1'));
      } finally { uninstallMocks(); }
    });
  });

  describe('#startBot()', () => {
    function modelWithBot(updates) {
      return buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, channelId: 10, url: 'https://meet.example/room', provider: 'visio', enableDisplaySub: false, subSource: null }),
          update: async (values, opts) => { if (updates) updates.push({ values, opts }); return [1, []]; },
          destroy: async () => [1, []]
        },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => ({ id: 'sess-1', channels: [{ id: 10, transcriberProfile: null }] }) }
      });
    }

    it('routes startbot to the selected BotService, persists ownership, records the map', async () => {
      const updates = [];
      const { instance, mqttPublishes } = await loadBrokerClient({ model: modelWithBot(updates) });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        const pub = mqttPublishes.find(p => p.topic === 'botservice/in/bs1/startbot');
        assert.ok(pub, 'startbot published to the owning BotService');
        assert.equal(pub.payload.botType, 'visio');
        assert.equal(pub.payload.botId, 42);
        assert.ok(pub.payload.websocketUrl.includes('/transcriber-ws/sess-1,0'), pub.payload.websocketUrl);
        assert.equal(instance.botOwnership.get('sess-1_10'), 'bs1');
        // durable ownership persisted on the Bot row
        assert.ok(updates.some(u => u.values.botservice === 'bs1' && u.opts.where.id === 42));
      } finally { uninstallMocks(); }
    });

    it('does not publish when the session is missing (null-guarded)', async () => {
      const model = buildModel({
        Bot: { findByPk: async () => ({ id: 42, channelId: 10, provider: 'visio' }) },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-x' }) },
        Session: { findByPk: async () => null } // deleted/orphaned
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('does not publish when no BotService supports the provider', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient({ model: modelWithBot() });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['jitsi'] }];
        await instance.startBot(42);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });
  });

  describe('#stopBot()', () => {
    it('destroys the row and routes a targeted stopbot to the owner', async () => {
      const destroys = [];
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async (opts) => { destroys.push(opts); return [1, []]; }
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        instance.botOwnership.set('sess-1_10', 'bs1');
        await instance.stopBot(42);
        assert.equal(destroys.length, 1);
        const pub = mqttPublishes.find(p => p.topic === 'botservice/in/bs1/stopbot');
        assert.ok(pub, 'stopbot routed to the owning BotService');
        assert.deepEqual(pub.payload, { sessionId: 'sess-1', channelId: 10 });
        assert.equal(instance.botOwnership.has('sess-1_10'), false);
      } finally { uninstallMocks(); }
    });

    it('routes via the persisted owner when the in-memory map is empty (post-restart)', async () => {
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, botservice: 'bs-persisted', channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async () => [1, []]
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        // No botOwnership entry (simulating a Scheduler restart that lost the map).
        await instance.stopBot(42);
        assert.ok(mqttPublishes.find(p => p.topic === 'botservice/in/bs-persisted/stopbot'));
      } finally { uninstallMocks(); }
    });
  });

  describe('#recordBotError() (T10)', () => {
    it('logs and re-emits the error, persisting only when the column exists', async () => {
      const updates = [];
      const model = buildModel({
        Bot: { update: async (values, opts) => { updates.push({ values, opts }); return [1, []]; } }
      });
      // No error_reason column declared -> no persisted write attempted.
      model.Bot.rawAttributes = { id: {}, provider: {} };
      const { instance, logs, mqttPublishes } = await loadBrokerClient({ model });
      try {
        await instance.recordBotError(42, 'Page crashed');
        assert.equal(updates.length, 0, 'no DB write without the column');
        assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('42') && l.msg.includes('Page crashed')));
        const pub = mqttPublishes.find(p => p.topic === 'system/out/bots/error');
        assert.ok(pub, 'error re-emitted on system/out');
        assert.deepEqual(pub.payload, { botId: 42, reason: 'Page crashed' });
      } finally { uninstallMocks(); }
    });

    it('persists error_reason on the Bot row when the column exists', async () => {
      const updates = [];
      const model = buildModel({
        Bot: { update: async (values, opts) => { updates.push({ values, opts }); return [1, []]; } }
      });
      model.Bot.rawAttributes = { id: {}, error_reason: {} };
      const { instance } = await loadBrokerClient({ model });
      try {
        await instance.recordBotError(7, 'join-timeout');
        assert.equal(updates.length, 1);
        assert.equal(updates[0].values.error_reason, 'join-timeout');
        assert.equal(updates[0].opts.where.id, 7);
      } finally { uninstallMocks(); }
    });

    it('ignores a null botId', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient();
      try {
        await instance.recordBotError(null, 'whatever');
        assert.equal(mqttPublishes.filter(p => p.topic === 'system/out/bots/error').length, 0);
      } finally { uninstallMocks(); }
    });
  });
});
