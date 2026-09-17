const assert = require('assert');
const { describe, it } = require('mocha');
const { buildModel, loadBrokerClient, uninstallMocks } = require('./helpers');

// The Transcriber resolves a stream by the session's PRIVATE id, so the
// WebSocket URL handed to a bot must carry session.privateId, never the
// public id. A session without privateId cannot be streamed to.

describe('BrokerClient bot WebSocket URL uses the session private id', () => {
  const PRIVATE_ID = '9b2e4c1a-0d3f-4e5a-8b6c-7d8e9f0a1b2c';

  function model({ privateId }) {
    return buildModel({
      Bot: {
        findByPk: async () => ({ id: 42, channelId: 11, url: 'https://meet.example/room', provider: 'visio', enableDisplaySub: false, subSource: null }),
        update: async () => [1, []],
        destroy: async () => [1, []]
      },
      Channel: { findByPk: async () => ({ id: 11, sessionId: 'sess-public' }) },
      Session: { findByPk: async () => ({ id: 'sess-public', privateId, channels: [
        { id: 10, transcriberProfile: null },
        { id: 11, transcriberProfile: null },
      ] }) }
    });
  }

  it('#startBot() publishes a websocketUrl built from privateId and the channel index', async () => {
    const { instance, mqttPublishes } = await loadBrokerClient({ model: model({ privateId: PRIVATE_ID }) });
    try {
      instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
      await instance.startBot(42);
      const pub = mqttPublishes.find(p => p.topic === 'botservice/in/bs1/startbot');
      assert.ok(pub, 'startbot published');
      assert.ok(pub.payload.websocketUrl.endsWith(`/transcriber-ws/${PRIVATE_ID},1`), pub.payload.websocketUrl);
      assert.ok(!pub.payload.websocketUrl.includes('sess-public'), 'the public id must not be in the stream URL');
    } finally { uninstallMocks(); }
  });

  it('#startBot() logs an error when the session has no privateId (the Transcriber will refuse the URL)', async () => {
    const { instance, logs } = await loadBrokerClient({ model: model({ privateId: null }) });
    try {
      instance.botservices = [{ uniqueId: 'bs1', online: true, activeBots: 0, capabilities: ['visio'] }];
      await instance.startBot(42);
      assert.ok(logs.some(l => l.level === 'error' && /privateId/.test(l.msg)), 'missing privateId must be logged as an error');
    } finally { uninstallMocks(); }
  });
});
