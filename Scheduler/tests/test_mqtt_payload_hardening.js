// Unit tests for the Scheduler's inbound MQTT payload hardening (MqttEvents).
//
// A retained topic can be cleared with an empty payload, and a misbehaving
// publisher can send malformed JSON; before the hardening, the unguarded
// JSON.parse() in the message handler threw out of the async callback and
// crashed the Scheduler. These tests wire the real MqttEvents controller onto a
// mocked BrokerClient and feed it empty / malformed / valid payloads.

const assert = require('assert');
const path = require('path');
const { describe, it } = require('mocha');
const { loadBrokerClient, uninstallMocks } = require('./helpers');

const mqttEventsPath = path.resolve(__dirname, '../components/BrokerClient/controllers/MqttEvents.js');

// MqttEvents reads `logger` from live-srt-lib, which loadBrokerClient already
// mocked; require it fresh so it binds to that mock.
async function wireHandler(instance) {
  delete require.cache[mqttEventsPath];
  const register = require(mqttEventsPath);
  await register.call(instance);
}

// Emit a raw MQTT message and let the async handler's microtasks flush.
function emit(instance, topic, body) {
  instance.client.emit('message', topic, Buffer.from(body));
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MqttEvents inbound payload hardening', () => {
  it('ignores an empty retained botservice status without crashing or registering', async () => {
    const { instance } = await loadBrokerClient();
    try {
      await wireHandler(instance);
      instance.botservices = [];
      await emit(instance, 'botservice/out/bs-x/status', '');
      assert.deepStrictEqual(instance.botservices, []);
    } finally { uninstallMocks(); delete require.cache[mqttEventsPath]; }
  });

  it('ignores a malformed botservice status (warns, does not register)', async () => {
    const { instance, logs } = await loadBrokerClient();
    try {
      await wireHandler(instance);
      instance.botservices = [];
      await emit(instance, 'botservice/out/bs-x/status', '{not valid json');
      assert.deepStrictEqual(instance.botservices, []);
      assert.ok(logs.some((l) => l.level === 'warn' && /malformed JSON/i.test(l.msg)),
        'expected a warning about the malformed payload');
    } finally { uninstallMocks(); delete require.cache[mqttEventsPath]; }
  });

  it('still registers a valid botservice status', async () => {
    const { instance } = await loadBrokerClient();
    try {
      await wireHandler(instance);
      instance.botservices = [];
      await emit(instance, 'botservice/out/bs-x/status',
        JSON.stringify({ uniqueId: 'bs-x', online: true, capabilities: ['visio'], activeBots: 0 }));
      assert.strictEqual(instance.botservices.length, 1);
      assert.strictEqual(instance.botservices[0].uniqueId, 'bs-x');
    } finally { uninstallMocks(); delete require.cache[mqttEventsPath]; }
  });

  it('does not invoke startBot on an empty scheduler/in payload', async () => {
    const { instance } = await loadBrokerClient();
    try {
      await wireHandler(instance);
      let called = false;
      instance.startBot = async () => { called = true; };
      await emit(instance, 'scheduler/in/schedule/startbot', '');
      assert.strictEqual(called, false);
    } finally { uninstallMocks(); delete require.cache[mqttEventsPath]; }
  });

  it('ignores an empty transcriber status without crashing', async () => {
    const { instance } = await loadBrokerClient();
    try {
      await wireHandler(instance);
      let registered = false;
      instance.registerTranscriber = async () => { registered = true; };
      await emit(instance, 'transcriber/out/tr-x/status', '');
      assert.strictEqual(registered, false);
    } finally { uninstallMocks(); delete require.cache[mqttEventsPath]; }
  });
});
