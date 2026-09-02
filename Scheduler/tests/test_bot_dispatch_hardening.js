const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// Hardening of the bot dispatch path (companion of test_bot_routing.js):
//   K7  — the provider fallback env key must be settable by a shell / .env
//   §2c — the join-failed fail-safe must not depend on the gate list
//   least privilege — a web (demoted) dispatch must not carry the native token
//   liveness — never dispatch onto a Bot row that vanished mid-schedule
//   bounded memory — nativeBots / reroutedBots must not outlive their Bot row
describe('BrokerClient bot dispatch hardening', () => {

  const nativeSignal = {
    room: 'room-1',
    state: 'ready',
    native: { 'visio-native': { livekitUrl: 'ws://lk', room: 'room-1', token: 'jwt-tok' } }
  };

  // provider="visio-native" so the PRIMARY capability is the gated/native one and
  // the fallback env under test is BOT_PROVIDER_FALLBACK_VISIO(_|-)NATIVE.
  function nativeProviderModel({ meta = nativeSignal, botUpdate } = {}) {
    return buildModel({
      Bot: {
        findAll: async () => [],
        findByPk: async () => ({ id: 42, channelId: 10, url: 'https://meet.example/room', provider: 'visio-native', enableDisplaySub: false, subSource: null }),
        update: botUpdate || (async () => [1, []]),
        destroy: async () => [1, []]
      },
      Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
      Session: { findByPk: async () => ({ id: 'sess-1', meta, channels: [{ id: 10, transcriberProfile: null }] }) }
    });
  }

  // Scope any subset of the routing env vars around one case.
  function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return Promise.resolve().then(fn).finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
  }

  describe('K7: BOT_PROVIDER_FALLBACK_<PROVIDER> env key', () => {
    it("honours the shell-settable '_' form for a dashed provider (visio-native)", async () => {
      // The dashed name a shell / .env file cannot export must not be the only
      // way to configure the fallback: with only the '_' form set, the native
      // primary must still fall back to the web replica.
      await withEnv({
        BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio',
        'BOT_PROVIDER_FALLBACK_VISIO-NATIVE': undefined,
        SESSION_GATED_CAPABILITIES: 'visio-native'
      }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          assert.ok(pub, 'fallback resolved from the underscored env name');
          assert.equal(pub.payload.botType, 'visio');
        } finally { uninstallMocks(); }
      });
    });

    it('still reads the legacy dashed name when only that one is set (back-compat)', async () => {
      await withEnv({
        BOT_PROVIDER_FALLBACK_VISIO_NATIVE: undefined,
        'BOT_PROVIDER_FALLBACK_VISIO-NATIVE': 'visio-native,visio',
        SESSION_GATED_CAPABILITIES: 'visio-native'
      }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          assert.ok(mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot'));
        } finally { uninstallMocks(); }
      });
    });

    it('prefers the underscored value when both names are set', async () => {
      await withEnv({
        BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio',
        'BOT_PROVIDER_FALLBACK_VISIO-NATIVE': 'jitsi',
        SESSION_GATED_CAPABILITIES: 'visio-native'
      }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [
            { uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] },
            { uniqueId: 'jitsi', online: true, activeBots: 0, capabilities: ['jitsi'] }
          ];
          await instance.startBot(42);
          assert.ok(mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot'));
          assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/jitsi/startbot').length, 0);
        } finally { uninstallMocks(); }
      });
    });

    it('regression: an unset fallback still dispatches on the primary capability', async () => {
      await withEnv({
        BOT_PROVIDER_FALLBACK_VISIO_NATIVE: undefined,
        'BOT_PROVIDER_FALLBACK_VISIO-NATIVE': undefined,
        SESSION_GATED_CAPABILITIES: 'visio-native'
      }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [{ uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] }];
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/native/startbot');
          assert.ok(pub);
          assert.equal(pub.payload.botType, 'visio-native');
        } finally { uninstallMocks(); }
      });
    });
  });

  describe('native join token in the startbot payload', () => {
    it('keeps the token on a NATIVE dispatch (the bot needs it to join)', async () => {
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [{ uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] }];
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/native/startbot');
          assert.equal(pub.payload.session.meta.native['visio-native'].token, 'jwt-tok');
        } finally { uninstallMocks(); }
      });
    });

    it('strips the token on a WEB (demoted/fallback) dispatch, keeping every other meta key', async () => {
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          // Native replica offline -> the bot lands on the web sibling, which has
          // no use for a LiveKit join credential.
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          const desc = pub.payload.session.meta.native['visio-native'];
          assert.equal('token' in desc, false, 'join token removed from the web payload');
          assert.equal(desc.livekitUrl, 'ws://lk', 'the rest of the descriptor is preserved');
          assert.equal(pub.payload.session.meta.room, 'room-1');
          assert.equal(pub.payload.session.meta.state, 'ready');
        } finally { uninstallMocks(); }
      });
    });

    it('strips the legacy meta.linto_native.token alias too', async () => {
      const alias = { room: 'room-1', linto_native: { livekitUrl: 'ws://lk', room: 'room-1', token: 'jwt-tok' } };
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel({ meta: alias }) });
        try {
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          assert.equal('token' in pub.payload.session.meta.linto_native, false);
          assert.equal(pub.payload.session.meta.linto_native.room, 'room-1');
        } finally { uninstallMocks(); }
      });
    });

    it('never mutates the session it scrubs (the DB row keeps its token)', async () => {
      const stored = { id: 'sess-1', meta: JSON.parse(JSON.stringify(nativeSignal)), channels: [{ id: 10, transcriberProfile: null }] };
      const model = buildModel({
        Bot: {
          findAll: async () => [],
          findByPk: async () => ({ id: 42, channelId: 10, url: 'u', provider: 'visio-native' }),
          update: async () => [1, []],
          destroy: async () => [1, []]
        },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => stored }
      });
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          assert.equal(stored.meta.native['visio-native'].token, 'jwt-tok');
        } finally { uninstallMocks(); }
      });
    });

    it('a plain web bot (no native meta) is dispatched unchanged', async () => {
      // Legacy path parity: a session with no native signal keeps the exact same
      // payload it had before the scrub existed.
      const meta = { room: 'room-1', state: 'ready' };
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO: undefined, SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const model = buildModel({
          Bot: {
            findAll: async () => [],
            findByPk: async () => ({ id: 42, channelId: 10, url: 'u', provider: 'visio' }),
            update: async () => [1, []],
            destroy: async () => [1, []]
          },
          Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
          Session: { findByPk: async () => ({ id: 'sess-1', meta, channels: [{ id: 10, transcriberProfile: null }] }) }
        });
        const { instance, mqttPublishes } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          assert.deepEqual(pub.payload.session.meta, { room: 'room-1', state: 'ready' });
        } finally { uninstallMocks(); }
      });
    });
  });

  describe('§2c: forceDemote does not depend on SESSION_GATED_CAPABILITIES', () => {
    it('re-routes to the web sibling even when the gate list is empty (mis-set)', async () => {
      // A mis-set gate would otherwise turn the join-failed fail-safe into a
      // no-op: the native leg would survive forceDemote and the bot would be
      // re-dispatched onto the replica that just failed to join.
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: '' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [
            { uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] },
            { uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }
          ];
          await instance.startBot(42);
          assert.ok(instance.nativeBots.has(42), 'first dispatch went native');
          await instance.recordBotError(42, 'join-failed');
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          assert.ok(pub, 're-routed to the web sibling despite the empty gate list');
          assert.equal(pub.payload.botType, 'visio');
          assert.equal(instance.nativeBots.has(42), false, 'no longer a native dispatch');
          // And the re-routed (web) payload carries no join token.
          assert.equal('token' in pub.payload.session.meta.native['visio-native'], false);
        } finally { uninstallMocks(); }
      });
    });

    it('re-routes even when the gate lists an unrelated capability', async () => {
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'teams-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: nativeProviderModel() });
        try {
          instance.botservices = [
            { uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] },
            { uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }
          ];
          await instance.startBot(42);
          await instance.recordBotError(42, 'join-failed');
          assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/web/startbot').length, 1);
        } finally { uninstallMocks(); }
      });
    });
  });

  describe('K7c: SESSION_GATED_CAPABILITIES can only ADD to the gate, never remove "-native"', () => {
    // The ORDINARY dispatch must fail CLOSED on a partial override, exactly like
    // forceDemote does (§2c above). With BOT_PROVIDER_FALLBACK_VISIO="visio-native,
    // visio" a gate list that no longer mentions "visio-native" would otherwise send
    // EVERY tokenless `visio` bot (Studio-UI, Teams, DINUM) to the native replica.
    function webProviderModel(meta) {
      return buildModel({
        Bot: {
          findAll: async () => [],
          findByPk: async () => ({ id: 42, channelId: 10, url: 'https://meet.example/room', provider: 'visio', enableDisplaySub: false, subSource: null }),
          update: async () => [1, []],
          destroy: async () => [1, []]
        },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => ({ id: 'sess-1', meta, channels: [{ id: 10, transcriberProfile: null }] }) }
      });
    }

    const bothReplicas = () => ([
      { uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] },
      { uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }
    ]);

    it('demotes a tokenless session even when the gate list is EMPTY', async () => {
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO: 'visio-native,visio', SESSION_GATED_CAPABILITIES: '' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: webProviderModel({ room: 'room-1' }) });
        try {
          instance.botservices = bothReplicas();
          await instance.startBot(42);
          assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/native/startbot').length, 0,
            'no dispatch onto the native replica without a declared capability + token');
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          assert.ok(pub, 'dispatched to the web replica');
          assert.equal(pub.payload.botType, 'visio');
          assert.equal(instance.nativeBots.has(42), false);
        } finally { uninstallMocks(); }
      });
    });

    it('demotes a tokenless session when the gate lists an UNRELATED capability', async () => {
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'teams-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: webProviderModel({ room: 'room-1' }) });
        try {
          instance.botservices = bothReplicas();
          await instance.startBot(42);
          assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/native/startbot').length, 0);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot');
          assert.ok(pub, 'dispatched to the web replica');
          assert.equal(pub.payload.botType, 'visio');
        } finally { uninstallMocks(); }
      });
    });

    it('demotes a session that DECLARES the capability but carries no token, gate list empty', async () => {
      const meta = { room: 'room-1', native: { 'visio-native': { livekitUrl: 'ws://lk', room: 'room-1' } } };
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO: 'visio-native,visio', SESSION_GATED_CAPABILITIES: '' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: webProviderModel(meta) });
        try {
          instance.botservices = bothReplicas();
          await instance.startBot(42);
          assert.equal(mqttPublishes.filter(p => p.topic === 'botservice/in/native/startbot').length, 0);
          assert.equal(mqttPublishes.find(p => p.topic === 'botservice/in/web/startbot').payload.botType, 'visio');
        } finally { uninstallMocks(); }
      });
    });

    it('still routes NATIVE when the session declares it AND has a token, gate list empty', async () => {
      // The hardening only ever ADDS to the gate: a legitimate native session must
      // keep reaching the native replica whatever the operator set the list to.
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO: 'visio-native,visio', SESSION_GATED_CAPABILITIES: '' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model: webProviderModel(nativeSignal) });
        try {
          instance.botservices = bothReplicas();
          await instance.startBot(42);
          const pub = mqttPublishes.find(p => p.topic === 'botservice/in/native/startbot');
          assert.ok(pub, 'declared + tokened session still routes native');
          assert.equal(pub.payload.botType, 'visio-native');
          assert.equal(instance.nativeBots.has(42), true);
        } finally { uninstallMocks(); }
      });
    });

    it('LEGACY: a non-native provider is untouched by the fail-closed rule', async () => {
      // "teams" has no "-native" suffix and is not in the list, so it must dispatch
      // byte-identically whatever SESSION_GATED_CAPABILITIES says.
      const model = buildModel({
        Bot: {
          findAll: async () => [],
          findByPk: async () => ({ id: 42, channelId: 10, url: 'https://teams.example/room', provider: 'teams' }),
          update: async () => [1, []],
          destroy: async () => [1, []]
        },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => ({ id: 'sess-1', meta: { room: 'room-1' }, channels: [{ id: 10, transcriberProfile: null }] }) }
      });
      await withEnv({ BOT_PROVIDER_FALLBACK_TEAMS: undefined, SESSION_GATED_CAPABILITIES: '' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'teamsbot', online: true, activeBots: 0, capabilities: ['teams'] }];
          await instance.startBot(42);
          const pubs = mqttPublishes.filter(p => p.topic === 'botservice/in/teamsbot/startbot');
          assert.equal(pubs.length, 1);
          assert.equal(pubs[0].payload.botType, 'teams');
        } finally { uninstallMocks(); }
      });
    });
  });

  describe('dispatch onto a vanished Bot row', () => {
    it('does not publish startbot when the ownership write affected 0 rows', async () => {
      // DELETE /bots (or an unregisterBotService reap) destroyed the row while
      // getStartBotData was awaiting: dispatching now would start a bot that no
      // stopBot can ever reach.
      const model = nativeProviderModel({ botUpdate: async () => [0, []] });
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes, logs } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] }];
          await instance.startBot(42);
          assert.equal(mqttPublishes.filter(p => p.topic.startsWith('botservice/in/')).length, 0);
          assert.ok(logs.some(l => l.level === 'warn' && /vanished/.test(l.msg)));
          // No stale ownership and no stale dispatch markers left behind.
          assert.equal(instance.botOwnership.has('sess-1_10'), false);
          assert.equal(instance.nativeBots.has(42), false);
          assert.equal(instance.reroutedBots.has(42), false);
        } finally { uninstallMocks(); }
      });
    });

    it('still publishes when the ownership write reports 1 row (nominal)', async () => {
      const model = nativeProviderModel({ botUpdate: async () => [1, []] });
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] }];
          await instance.startBot(42);
          assert.ok(mqttPublishes.find(p => p.topic === 'botservice/in/native/startbot'));
          assert.equal(instance.botOwnership.get('sess-1_10'), 'native');
        } finally { uninstallMocks(); }
      });
    });

    it('LEGACY: a plain web bot with a live row publishes exactly one startbot', async () => {
      // The [0]-rows abort is a NEW way for a dispatch to be swallowed, and it
      // sits on the pre-existing web-bot path. Pin the positive case so a future
      // change to that guard cannot silently kill the plain visio/teams/jitsi
      // dispatch: update reports [1] -> exactly one publish, on the primary
      // capability, with the ownership recorded.
      const model = buildModel({
        Bot: {
          findAll: async () => [],
          findByPk: async () => ({ id: 42, channelId: 10, url: 'https://meet.example/room', provider: 'visio' }),
          update: async () => [1],   // Sequelize v6 without `returning`: [affectedCount]
          destroy: async () => [1, []]
        },
        Channel: { findByPk: async () => ({ id: 10, sessionId: 'sess-1' }) },
        Session: { findByPk: async () => ({ id: 'sess-1', meta: { room: 'room-1' }, channels: [{ id: 10, transcriberProfile: null }] }) }
      });
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO: undefined, SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'web', online: true, activeBots: 0, capabilities: ['visio'] }];
          await instance.startBot(42);
          const pubs = mqttPublishes.filter(p => p.topic === 'botservice/in/web/startbot');
          assert.equal(pubs.length, 1, 'exactly one startbot published');
          assert.equal(pubs[0].payload.botType, 'visio');
          assert.equal(pubs[0].payload.session.id, 'sess-1');
          assert.equal(pubs[0].payload.channel.id, 10);
          assert.equal(instance.botOwnership.get('sess-1_10'), 'web');
          assert.equal(instance.nativeBots.has(42), false, 'a web dispatch is not marked native');
        } finally { uninstallMocks(); }
      });
    });

    it('tolerates a driver that does not return the [count] shape (legacy dispatch)', async () => {
      const model = nativeProviderModel({ botUpdate: async () => undefined });
      await withEnv({ BOT_PROVIDER_FALLBACK_VISIO_NATIVE: 'visio-native,visio', SESSION_GATED_CAPABILITIES: 'visio-native' }, async () => {
        const { instance, mqttPublishes } = await loadBrokerClient({ model });
        try {
          instance.botservices = [{ uniqueId: 'native', online: true, activeBots: 0, capabilities: ['visio-native'] }];
          await instance.startBot(42);
          assert.ok(mqttPublishes.find(p => p.topic === 'botservice/in/native/startbot'));
        } finally { uninstallMocks(); }
      });
    });

    it('forgets the dispatch markers when the bot row is already gone', async () => {
      const model = buildModel({
        Bot: { findAll: async () => [], findByPk: async () => null, destroy: async () => [0, []] }
      });
      const { instance } = await loadBrokerClient({ model });
      try {
        instance.nativeBots.add(42);
        instance.reroutedBots.add(42);
        await instance.startBot(42);
        assert.equal(instance.nativeBots.has(42), false);
        assert.equal(instance.reroutedBots.has(42), false);
      } finally { uninstallMocks(); }
    });
  });

  describe('marker lifetime (bounded memory)', () => {
    it('unregisterBotService forgets the markers of the bots it reaps', async () => {
      const model = buildModel({
        Bot: {
          findAll: async (opts) => (opts && opts.where && opts.where.botservice === 'dead')
            ? [{ id: 42 }, { id: 43 }]
            : [],
          destroy: async () => [2, []]
        }
      });
      const { instance } = await loadBrokerClient({ model });
      try {
        instance.nativeBots.add(42);
        instance.reroutedBots.add(42);
        instance.nativeBots.add(43);
        instance.nativeBots.add(99); // owned by a live replica: must survive
        await instance.unregisterBotService({ uniqueId: 'dead' });
        assert.equal(instance.nativeBots.has(42), false);
        assert.equal(instance.reroutedBots.has(42), false);
        assert.equal(instance.nativeBots.has(43), false);
        assert.equal(instance.nativeBots.has(99), true);
      } finally { uninstallMocks(); }
    });

    it('still reaps the rows when listing the orphans fails', async () => {
      const model = buildModel({
        Bot: {
          findAll: async () => { throw new Error('listing failed'); },
          destroy: async () => [1, []]
        }
      });
      const { instance, logs } = await loadBrokerClient({ model });
      try {
        await assert.doesNotReject(() => instance.unregisterBotService({ uniqueId: 'dead' }));
        assert.ok(logs.some(l => l.level === 'error' && /listing failed/.test(l.msg)));
      } finally { uninstallMocks(); }
    });

    it('stopBot forgets both markers', async () => {
      const model = buildModel({
        Bot: {
          findAll: async () => [],
          findByPk: async () => ({ id: 42, channel: { id: 10, sessionId: 'sess-1' } }),
          destroy: async () => [1, []]
        }
      });
      const { instance } = await loadBrokerClient({ model });
      try {
        instance.nativeBots.add(42);
        instance.reroutedBots.add(42);
        await instance.stopBot(42);
        assert.equal(instance.nativeBots.has(42), false);
        assert.equal(instance.reroutedBots.has(42), false);
      } finally { uninstallMocks(); }
    });
  });
});
