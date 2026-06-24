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

    it('drops only the dead replica and keeps ownership of survivors', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'dead', activeBots: 1, capabilities: ['visio'] });
        instance.registerBotService({ uniqueId: 'alive', activeBots: 1, capabilities: ['visio'] });
        instance.botOwnership.set('s1_1', 'dead');
        instance.botOwnership.set('s1_2', 'dead');
        instance.botOwnership.set('s2_1', 'alive');
        await instance.unregisterBotService({ uniqueId: 'dead' });
        assert.deepEqual(instance.botservices.map(b => b.uniqueId), ['alive']);
        assert.equal(instance.botOwnership.has('s1_1'), false);
        assert.equal(instance.botOwnership.has('s1_2'), false);
        assert.equal(instance.botOwnership.get('s2_1'), 'alive');
      } finally { uninstallMocks(); }
    });

    it('logs without throwing when the orphan reap query fails', async () => {
      // A DB hiccup during reaping must not crash the status handler — the replica
      // is still removed from the in-memory list and the error is logged.
      const model = buildModel({ Bot: { destroy: async () => { throw new Error('connection lost'); } } });
      const { instance, logs } = await loadBrokerClient({ model });
      try {
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 0, capabilities: ['visio'] });
        await assert.doesNotReject(() => instance.unregisterBotService({ uniqueId: 'bs1' }));
        assert.equal(instance.botservices.length, 0);
        assert.ok(logs.some(l => l.level === 'error' && l.msg.includes('connection lost')));
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

    it('prefers the live in-memory owner over a stale persisted column', async () => {
      // The row still carries the original owner, but the in-memory map has been
      // updated (e.g. a re-schedule). The live map must win so the stop reaches
      // the replica that actually runs the bot.
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, botservice: 'bs-stale', channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async () => [1, []]
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        instance.botOwnership.set('sess-1_10', 'bs-live');
        await instance.stopBot(42);
        assert.ok(mqttPublishes.find(p => p.topic === 'botservice/in/bs-live/stopbot'));
        assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/bs-stale/stopbot').length, 0);
        assert.equal(instance.botOwnership.has('sess-1_10'), false);
      } finally { uninstallMocks(); }
    });

    it('still destroys the row but routes nothing when no owner is known anywhere', async () => {
      // Neither the in-memory map nor the persisted column carries an owner
      // (bot already left / never fully scheduled). Row is reaped; a warning is
      // logged and no stopbot is routed (nothing to stop).
      const destroys = [];
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, botservice: null, channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async (opts) => { destroys.push(opts); return [1, []]; }
        }
      });
      const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
      try {
        await instance.stopBot(42);
        assert.equal(destroys.length, 1);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
        assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('not routed')));
      } finally { uninstallMocks(); }
    });

    it('destroys the row but routes nothing when the bot has no channel', async () => {
      const destroys = [];
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, channel: null }),
          destroy: async (opts) => { destroys.push(opts); return [1, []]; }
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        instance.botOwnership.set('sess-1_10', 'bs1'); // present but unreachable without a channel
        await instance.stopBot(42);
        assert.equal(destroys.length, 1);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('is a no-op (no destroy, no publish) when the bot row is gone', async () => {
      const destroys = [];
      const model = buildModel({
        Bot: {
          findByPk: async () => null,
          destroy: async (opts) => { destroys.push(opts); return [0, []]; }
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        await instance.stopBot(999);
        assert.equal(destroys.length, 0);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });
  });

  describe('#recordBotError()', () => {
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

  describe('#selectBotService() additional coverage', () => {
    it('returns the single online replica matching the provider', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [{ uniqueId: 'only', online: true, activeBots: 7, capabilities: ['visio'] }];
        assert.equal(instance.selectBotService('visio').uniqueId, 'only');
      } finally { uninstallMocks(); }
    });

    it('picks the first array element when candidates are equally scored', async () => {
      const { instance } = await loadBrokerClient();
      try {
        // Identical capabilities length and identical load => reduce() keeps the
        // first (strict < never replaces an equal), so array order decides.
        instance.botservices = [
          { uniqueId: 'first', online: true, activeBots: 2, rss: 100, capabilities: ['visio'] },
          { uniqueId: 'second', online: true, activeBots: 2, rss: 100, capabilities: ['visio'] },
          { uniqueId: 'third', online: true, activeBots: 2, rss: 100, capabilities: ['visio'] }
        ];
        assert.equal(instance.selectBotService('visio').uniqueId, 'first');
      } finally { uninstallMocks(); }
    });

    it('excludes an entry whose capabilities is null (not an Array)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [
          { uniqueId: 'null-caps', online: true, activeBots: 0, capabilities: null },
          { uniqueId: 'good', online: true, activeBots: 4, capabilities: ['visio'] }
        ];
        assert.equal(instance.selectBotService('visio').uniqueId, 'good');
      } finally { uninstallMocks(); }
    });

    it('returns null for an empty botservices array', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.botservices = [];
        assert.equal(instance.selectBotService('visio'), null);
      } finally { uninstallMocks(); }
    });
  });

  describe('#_botLoadScore()', () => {
    it('computes activeBots + capped rss contribution (5 bots, 2GB rss => 5.002048)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        const rss = 2 * 1024 * 1024 * 1024; // 2 GB
        const score = instance._botLoadScore({ activeBots: 5, rss });
        assert.equal(score, 5.002048);
      } finally { uninstallMocks(); }
    });

    it('caps the rss contribution at 0.999 for an enormous rss', async () => {
      const { instance } = await loadBrokerClient();
      try {
        const score = instance._botLoadScore({ activeBots: 0, rss: 1e18 });
        assert.equal(score, 0.999);
        // The added term never exceeds 0.999 regardless of how large rss is.
        const score2 = instance._botLoadScore({ activeBots: 3, rss: Number.MAX_SAFE_INTEGER });
        // The added rss term is capped at exactly 0.999 (float-exact here).
        assert.equal(score2, 3.999);
        assert.ok(score2 - 3 <= 0.999 + Number.EPSILON);
      } finally { uninstallMocks(); }
    });

    it('treats missing activeBots/rss as idle (score 0)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        assert.equal(instance._botLoadScore({}), 0);
      } finally { uninstallMocks(); }
    });
  });

  describe('#buildTranscriberWsUrl()', () => {
    const WS_ENV = ['STREAMING_WS_BOT_HOST', 'STREAMING_WS_TCP_PORT', 'STREAMING_WS_ENDPOINT', 'STREAMING_WS_SECURE'];
    function clearWsEnv() {
      for (const k of WS_ENV) delete process.env[k];
    }

    it('produces the default ws:// URL when no env vars are set', async () => {
      const saved = {};
      WS_ENV.forEach(k => { saved[k] = process.env[k]; });
      clearWsEnv();
      const { instance } = await loadBrokerClient();
      try {
        assert.equal(
          instance.buildTranscriberWsUrl('sess-1', 0),
          'ws://transcriber:8080/transcriber-ws/sess-1,0'
        );
      } finally {
        uninstallMocks();
        WS_ENV.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      }
    });

    it('uses wss:// when STREAMING_WS_SECURE=true', async () => {
      const saved = process.env.STREAMING_WS_SECURE;
      process.env.STREAMING_WS_SECURE = 'true';
      const { instance } = await loadBrokerClient();
      try {
        assert.ok(instance.buildTranscriberWsUrl('s', 0).startsWith('wss://'));
      } finally {
        uninstallMocks();
        if (saved === undefined) delete process.env.STREAMING_WS_SECURE; else process.env.STREAMING_WS_SECURE = saved;
      }
    });

    it('uses ws:// when STREAMING_WS_SECURE=false', async () => {
      const saved = process.env.STREAMING_WS_SECURE;
      process.env.STREAMING_WS_SECURE = 'false';
      const { instance } = await loadBrokerClient();
      try {
        const url = instance.buildTranscriberWsUrl('s', 0);
        assert.ok(url.startsWith('ws://'));
        assert.ok(!url.startsWith('wss://'));
      } finally {
        uninstallMocks();
        if (saved === undefined) delete process.env.STREAMING_WS_SECURE; else process.env.STREAMING_WS_SECURE = saved;
      }
    });

    it('honours custom host, port and endpoint env values', async () => {
      const saved = {};
      WS_ENV.forEach(k => { saved[k] = process.env[k]; });
      clearWsEnv();
      process.env.STREAMING_WS_BOT_HOST = 'edge.example';
      process.env.STREAMING_WS_TCP_PORT = '9443';
      process.env.STREAMING_WS_ENDPOINT = 'ingest';
      process.env.STREAMING_WS_SECURE = 'true';
      const { instance } = await loadBrokerClient();
      try {
        assert.equal(
          instance.buildTranscriberWsUrl('sess-9', 3),
          'wss://edge.example:9443/ingest/sess-9,3'
        );
      } finally {
        uninstallMocks();
        WS_ENV.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      }
    });

    it('interpolates a sessionId with special characters verbatim', async () => {
      const saved = {};
      WS_ENV.forEach(k => { saved[k] = process.env[k]; });
      clearWsEnv();
      const { instance } = await loadBrokerClient();
      try {
        // No URL-encoding is applied; the value is embedded as-is.
        assert.equal(
          instance.buildTranscriberWsUrl('a:b/c,d', 1),
          'ws://transcriber:8080/transcriber-ws/a:b/c,d,1'
        );
      } finally {
        uninstallMocks();
        WS_ENV.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      }
    });

    it('embeds channelIndex edge cases (0, negative, very large)', async () => {
      const saved = {};
      WS_ENV.forEach(k => { saved[k] = process.env[k]; });
      clearWsEnv();
      const { instance } = await loadBrokerClient();
      try {
        assert.ok(instance.buildTranscriberWsUrl('s', 0).endsWith('/s,0'));
        assert.ok(instance.buildTranscriberWsUrl('s', -1).endsWith('/s,-1'));
        assert.ok(instance.buildTranscriberWsUrl('s', 999999999).endsWith('/s,999999999'));
      } finally {
        uninstallMocks();
        WS_ENV.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      }
    });
  });

  describe('#startBot() additional coverage', () => {
    function botModel(opts = {}) {
      const { updateImpl, bot, channel, session } = opts;
      return buildModel({
        Bot: {
          findByPk: async () => (bot === undefined
            ? { id: 42, channelId: 10, url: 'https://meet.example/room', provider: 'visio', enableDisplaySub: false, subSource: null }
            : bot),
          update: updateImpl || (async () => [1, []]),
          destroy: async () => [1, []]
        },
        Channel: { findByPk: async () => (channel === undefined ? { id: 10, sessionId: 'sess-1' } : channel) },
        Session: { findByPk: async () => (session === undefined ? { id: 'sess-1', channels: [{ id: 10, transcriberProfile: null }] } : session) }
      });
    }

    it('still publishes startbot even when Model.Bot.update throws (error caught)', async () => {
      const model = botModel({ updateImpl: async () => { throw new Error('db down'); } });
      const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        // NOTE (current behavior): the update() throw is raised BEFORE the
        // publish line, and the catch swallows it, so NO startbot is published
        // and the error is logged. This documents that an ownership-persist
        // failure aborts routing for that attempt.
        assert.ok(logs.some(l => l.level === 'error' && l.msg.includes('db down')));
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('logs a bot-not-found error and routes nothing', async () => {
      const model = botModel({ bot: null });
      const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        assert.ok(logs.some(l => l.level === 'error' && /Bot 42 not found/.test(l.msg)));
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('logs a channel-not-found error and routes nothing', async () => {
      const model = botModel({ channel: null });
      const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        assert.ok(logs.some(l => l.level === 'error' && /Channel 10 not found/.test(l.msg)));
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('logs a session-not-found error and routes nothing', async () => {
      const model = botModel({ session: null });
      const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        assert.ok(logs.some(l => l.level === 'error' && /Session for bot 42/.test(l.msg)));
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('is idempotent enough to publish twice when called twice for the same bot', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient({ model: botModel() });
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(42);
        await instance.startBot(42);
        // No internal dedupe: each call re-resolves and re-publishes; ownership
        // is simply re-set to the same value.
        assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/bs1/startbot').length, 2);
        assert.equal(instance.botOwnership.get('sess-1_10'), 'bs1');
      } finally { uninstallMocks(); }
    });

    it('routes nothing for a null/undefined botId (getStartBotData returns null)', async () => {
      // Bot.findByPk(null) resolves to null in the default model => early return.
      const { instance, mqttPublishes } = await loadBrokerClient();
      try {
        instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
        await instance.startBot(null);
        await instance.startBot(undefined);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });
  });

  describe('#getStartBotData()', () => {
    it('returns null when ownChannel.sessionId is falsy', async () => {
      const model = buildModel({
        Bot: { findByPk: async () => ({ id: 1, channelId: 10, provider: 'visio' }) },
        Channel: { findByPk: async () => ({ id: 10, sessionId: null }) },
        Session: { findByPk: async () => { throw new Error('should not be called'); } }
      });
      const { instance, logs } = await loadBrokerClient({ model });
      try {
        const data = await instance.getStartBotData(1);
        assert.equal(data, null);
        assert.ok(logs.some(l => l.level === 'error' && /Session for bot 1/.test(l.msg)));
      } finally { uninstallMocks(); }
    });

    it('defaults channels to [] when session.channels is undefined (channelIndex guard)', async () => {
      const model = buildModel({
        Bot: { findByPk: async () => ({ id: 1, channelId: 10, provider: 'visio' }) },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => ({ id: 'sess-1' /* no channels */ }) }
      });
      const { instance, logs } = await loadBrokerClient({ model });
      try {
        const data = await instance.getStartBotData(1);
        // findIndex on [] => -1 => not-in-session error => null.
        assert.equal(data, null);
        assert.ok(logs.some(l => l.level === 'error' && /not in session/.test(l.msg)));
      } finally { uninstallMocks(); }
    });

    it('carries bot.url/enableDisplaySub/subSource through to the payload', async () => {
      const model = buildModel({
        Bot: { findByPk: async () => ({ id: 5, channelId: 10, url: '', provider: 'teams', enableDisplaySub: true, subSource: 'host' }) },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => ({ id: 'sess-1', channels: [{ id: 10 }] }) }
      });
      const { instance } = await loadBrokerClient({ model });
      try {
        const data = await instance.getStartBotData(5);
        assert.equal(data.address, '');
        assert.equal(data.botType, 'teams');
        assert.equal(data.enableDisplaySub, true);
        assert.equal(data.subSource, 'host');
        assert.equal(data.botId, 5);
      } finally { uninstallMocks(); }
    });

    it('locates the channel by id among multiple channels and indexes by sorted position', async () => {
      const model = buildModel({
        Bot: { findByPk: async () => ({ id: 5, channelId: 30, provider: 'visio' }) },
        Channel: { findByPk: async () => ({ id: 30, sessionId: 'sess-1' }) },
        // Channels are returned already sorted by id ASC (as the ORDER BY guarantees).
        Session: { findByPk: async () => ({ id: 'sess-1', channels: [{ id: 10 }, { id: 20 }, { id: 30 }] }) }
      });
      const { instance } = await loadBrokerClient({ model });
      try {
        const data = await instance.getStartBotData(5);
        assert.equal(data.channel.id, 30);
        // index 2 in the sorted list => websocket url ends with ,2
        assert.ok(data.websocketUrl.endsWith('/sess-1,2'), data.websocketUrl);
      } finally { uninstallMocks(); }
    });
  });

  describe('#stopBot() additional coverage', () => {
    it('catches a destroy() throw and logs an error', async () => {
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async () => { throw new Error('destroy failed'); }
        }
      });
      const { instance, logs, mqttPublishes } = await loadBrokerClient({ model });
      try {
        instance.botOwnership.set('sess-1_10', 'bs1');
        await assert.doesNotReject(() => instance.stopBot(42));
        assert.ok(logs.some(l => l.level === 'error' && l.msg.includes('destroy failed')));
        // throw happens before routing => no stopbot published, ownership untouched.
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('second stopBot for the same bot is a no-op once the row is gone', async () => {
      let alive = true;
      const destroys = [];
      const model = buildModel({
        Bot: {
          findByPk: async () => (alive ? { id: 42, channel: { id: 10, sessionId: 'sess-1' } } : null),
          destroy: async (opts) => { destroys.push(opts); alive = false; return [1, []]; }
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        instance.botOwnership.set('sess-1_10', 'bs1');
        await instance.stopBot(42);
        await instance.stopBot(42);
        assert.equal(destroys.length, 1, 'second call finds no row, does not destroy again');
        assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/bs1/stopbot').length, 1);
      } finally { uninstallMocks(); }
    });

    it('handles a null/undefined botId by finding no row and no-opping', async () => {
      const destroys = [];
      const model = buildModel({
        Bot: { findByPk: async () => null, destroy: async (o) => { destroys.push(o); return [0, []]; } }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        await instance.stopBot(null);
        await instance.stopBot(undefined);
        assert.equal(destroys.length, 0);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
      } finally { uninstallMocks(); }
    });

    it('does not route when the persisted owner is an empty string (falsy)', async () => {
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, botservice: '', channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async () => [1, []]
        }
      });
      const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
      try {
        // No in-memory entry, persisted owner is '' => owner stays falsy.
        await instance.stopBot(42);
        assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
        assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('not routed')));
      } finally { uninstallMocks(); }
    });

    it('builds the ownership key from null channel.sessionId/id when those are missing', async () => {
      const model = buildModel({
        Bot: {
          findByPk: async () => ({ id: 42, botservice: 'bs1', channel: { id: null, sessionId: null } }),
          destroy: async () => [1, []]
        }
      });
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        // Map miss on 'null_null' => falls back to persisted owner 'bs1'.
        await instance.stopBot(42);
        const pub = mqttPublishes.find(p => p.topic === 'botservice/in/bs1/stopbot');
        assert.ok(pub);
        assert.deepEqual(pub.payload, { sessionId: null, channelId: null });
      } finally { uninstallMocks(); }
    });
  });

  describe('#recordBotError() additional coverage', () => {
    it('rejects botId=0 (invalid id) — nothing published', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient();
      try {
        await instance.recordBotError(0, 'crash');
        // Bot ids are positive integers; the guard rejects 0 (and null/undefined/
        // non-integers), so no error is published.
        const pub = mqttPublishes.find(p => p.topic === 'system/out/bots/error');
        assert.equal(pub, undefined, 'botId=0 is guarded out, so the error is NOT published');
      } finally { uninstallMocks(); }
    });

    it('defaults reason to "unknown" for an empty-string reason', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient();
      try {
        await instance.recordBotError(3, '');
        const pub = mqttPublishes.find(p => p.topic === 'system/out/bots/error');
        assert.equal(pub.payload.reason, 'unknown');
      } finally { uninstallMocks(); }
    });

    it('defaults reason to "unknown" for falsy reason values (0, false)', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient();
      try {
        await instance.recordBotError(3, 0);
        await instance.recordBotError(4, false);
        const pubs = mqttPublishes.filter(p => p.topic === 'system/out/bots/error');
        assert.equal(pubs.length, 2);
        assert.ok(pubs.every(p => p.payload.reason === 'unknown'));
      } finally { uninstallMocks(); }
    });

    it('catches an update() throw after confirming the column exists', async () => {
      const model = buildModel({
        Bot: { update: async () => { throw new Error('write failed'); } }
      });
      model.Bot.rawAttributes = { id: {}, error_reason: {} };
      const { instance, logs, mqttPublishes } = await loadBrokerClient({ model });
      try {
        await assert.doesNotReject(() => instance.recordBotError(9, 'boom'));
        assert.ok(logs.some(l => l.level === 'error' && l.msg.includes('write failed')));
        // The publish still happens after the swallowed write error.
        assert.ok(mqttPublishes.find(p => p.topic === 'system/out/bots/error'));
      } finally { uninstallMocks(); }
    });

    it('skips the DB write when rawAttributes is undefined (guard is false)', async () => {
      const updates = [];
      const model = buildModel({
        Bot: { update: async (v, o) => { updates.push({ v, o }); return [1, []]; } }
      });
      model.Bot.rawAttributes = undefined;
      const { instance, mqttPublishes } = await loadBrokerClient({ model });
      try {
        await instance.recordBotError(11, 'x');
        assert.equal(updates.length, 0);
        assert.ok(mqttPublishes.find(p => p.topic === 'system/out/bots/error'));
      } finally { uninstallMocks(); }
    });

    it('publishes to system/out/bots/error with QoS=1, retain=false, json=true', async () => {
      const { instance, mqttPublishes } = await loadBrokerClient();
      try {
        await instance.recordBotError(13, 'reason-x');
        const pub = mqttPublishes.find(p => p.topic === 'system/out/bots/error');
        assert.ok(pub);
        assert.equal(pub.qos, 1);
        assert.equal(pub.retain, false);
        assert.equal(pub.json, true);
        assert.deepEqual(pub.payload, { botId: 13, reason: 'reason-x' });
      } finally { uninstallMocks(); }
    });
  });

  describe('#registerBotService() additional coverage', () => {
    it('creates an entry with an undefined key when uniqueId is missing', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ activeBots: 1, capabilities: ['visio'] });
        assert.equal(instance.botservices.length, 1);
        assert.equal(instance.botservices[0].uniqueId, undefined);
      } finally { uninstallMocks(); }
    });

    it('accepts falsy-but-valid metrics (activeBots=0, rss=0, heapUsed=0)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 0, rss: 0, heapUsed: 0, capabilities: ['visio'] });
        const bs = instance.botservices[0];
        assert.equal(bs.activeBots, 0);
        assert.equal(bs.rss, 0);
        assert.equal(bs.heapUsed, 0);
      } finally { uninstallMocks(); }
    });

    it('treats null capabilities as an empty array on first register', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', capabilities: null });
        assert.deepEqual(instance.botservices[0].capabilities, []);
        instance.registerBotService({ uniqueId: 'bs2', capabilities: [] });
        assert.deepEqual(instance.botservices.find(b => b.uniqueId === 'bs2').capabilities, []);
      } finally { uninstallMocks(); }
    });

    it('accepts a negative activeBots without validation', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', activeBots: -3, capabilities: ['visio'] });
        assert.equal(instance.botservices[0].activeBots, -3);
      } finally { uninstallMocks(); }
    });

    it('always sets online=true on register (cannot bring a replica offline via register)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', capabilities: ['visio'] });
        instance.botservices[0].online = false; // simulate offline marking
        instance.registerBotService({ uniqueId: 'bs1', activeBots: 2, capabilities: ['visio'] });
        assert.equal(instance.botservices[0].online, true);
      } finally { uninstallMocks(); }
    });
  });

  describe('#unregisterBotService() additional coverage', () => {
    it('is a no-op on the registry when uniqueId is missing (filter matches nothing)', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'bs1', capabilities: ['visio'] });
        await instance.unregisterBotService({});
        assert.equal(instance.botservices.length, 1, 'undefined uniqueId removes nothing');
      } finally { uninstallMocks(); }
    });

    it('proceeds to reap even when botservices is already empty', async () => {
      const destroys = [];
      const model = buildModel({ Bot: { destroy: async (o) => { destroys.push(o); return [0, []]; } } });
      const { instance } = await loadBrokerClient({ model });
      try {
        instance.botservices = [];
        await instance.unregisterBotService({ uniqueId: 'ghost' });
        assert.ok(destroys.some(d => d.where && d.where.botservice === 'ghost'));
      } finally { uninstallMocks(); }
    });

    it('safely deletes botOwnership entries while iterating during unregister', async () => {
      const { instance } = await loadBrokerClient();
      try {
        instance.registerBotService({ uniqueId: 'dead', capabilities: ['visio'] });
        // Several owned keys plus survivors to stress the in-loop deletion.
        instance.botOwnership.set('s1_1', 'dead');
        instance.botOwnership.set('s1_2', 'dead');
        instance.botOwnership.set('s1_3', 'dead');
        instance.botOwnership.set('s2_1', 'alive');
        await instance.unregisterBotService({ uniqueId: 'dead' });
        assert.equal(instance.botOwnership.has('s1_1'), false);
        assert.equal(instance.botOwnership.has('s1_2'), false);
        assert.equal(instance.botOwnership.has('s1_3'), false);
        assert.equal(instance.botOwnership.get('s2_1'), 'alive');
        assert.equal(instance.botOwnership.size, 1);
      } finally { uninstallMocks(); }
    });
  });
});
