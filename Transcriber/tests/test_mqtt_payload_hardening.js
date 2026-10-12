/**
 * Unit tests for the Transcriber's inbound MQTT payload hardening (MqttMessages).
 *
 * Mirrors the Scheduler hardening: a retained topic cleared with an empty
 * payload, or a malformed JSON message, must be skipped (with a warning) rather
 * than thrown out of the async message handler — which previously crashed the
 * Transcriber. We mock the logger, wire the real MqttMessages controller onto a
 * minimal context with an EventEmitter `client`, and feed it raw payloads.
 */

const assert = require('assert');
const path = require('path');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach } = require('mocha');

const loggerPath = path.resolve(__dirname, '../logger.js');
const controllerPath = path.resolve(__dirname, '../components/BrokerClient/controllers/MqttMessages.js');

const warnings = [];
const mockLogger = { info() {}, warn(m) { warnings.push(m); }, error() {}, debug() {}, log() {} };

let teardown;
let registerMqttMessages;

function setupMocks() {
  const origLogger = require.cache[loggerPath];
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true, exports: mockLogger,
  };
  delete require.cache[controllerPath];
  registerMqttMessages = require(controllerPath);
  return function () {
    if (origLogger) require.cache[loggerPath] = origLogger; else delete require.cache[loggerPath];
    delete require.cache[controllerPath];
  };
}

// Build a minimal handler context and emit a raw message through it.
function makeCtx() {
  const ctx = { client: new EventEmitter(), sessionsHandled: [] };
  ctx.handleSessions = (sessions) => { ctx.sessionsHandled.push(sessions); };
  registerMqttMessages.call(ctx);
  return ctx;
}

function emit(ctx, topic, body) {
  ctx.client.emit('message', topic, Buffer.from(body));
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MqttMessages inbound payload hardening', () => {
  before(() => { teardown = setupMocks(); });
  after(() => { if (teardown) teardown(); });
  beforeEach(() => { warnings.length = 0; });

  it('ignores an empty sessions/statuses snapshot without crashing or handling', async () => {
    const ctx = makeCtx();
    await emit(ctx, 'system/out/sessions/statuses', '');
    assert.strictEqual(ctx.sessionsHandled.length, 0);
  });

  it('ignores a malformed sessions/statuses snapshot (warns, does not handle)', async () => {
    const ctx = makeCtx();
    await emit(ctx, 'system/out/sessions/statuses', '{broken');
    assert.strictEqual(ctx.sessionsHandled.length, 0);
    assert.ok(warnings.some((m) => /malformed JSON/i.test(m)), 'expected a malformed-payload warning');
  });

  it('still handles a valid sessions/statuses snapshot', async () => {
    const ctx = makeCtx();
    await emit(ctx, 'system/out/sessions/statuses', JSON.stringify([{ id: 'S1', status: 'active' }]));
    assert.strictEqual(ctx.sessionsHandled.length, 1);
    assert.strictEqual(ctx.sessionsHandled[0][0].id, 'S1');
  });

  it('does not crash on an empty scheduler status payload', async () => {
    const ctx = makeCtx();
    // handleSchedulerMessage would read ctx.state / ctx.constructor.states; if the
    // empty payload were not skipped, reaching it (or JSON.parse) would throw.
    await emit(ctx, 'scheduler/status', '');
    assert.ok(true);
  });
});

// The Scheduler's status (retained) is the cue for every transcriber to
// announce itself. A transcriber's own status is not retained: one published
// on its reconnection before the Scheduler's (e.g. both reconnecting after a
// broker restart) is lost to the Scheduler, so it announces itself again.
describe('MqttMessages scheduler status', () => {
  before(() => { teardown = setupMocks(); });
  after(() => { if (teardown) teardown(); });

  class Ctx {
    static states = { WAITING_SCHEDULER: 'waiting_scheduler', READY: 'ready' };
  }

  function connectedCtx(state) {
    const ctx = new Ctx();
    ctx.client = new EventEmitter();
    ctx.state = state;
    ctx.uniqueId = 't1';
    ctx.statuses = 0;
    ctx.client.publishStatus = () => { ctx.statuses += 1; };
    ctx.started = 0;
    ctx.maybeStartServers = () => { ctx.started += 1; };
    registerMqttMessages.call(ctx);
    return ctx;
  }

  it('announces itself again when the Scheduler comes back online', async () => {
    const ctx = connectedCtx(Ctx.states.READY);
    await emit(ctx, 'scheduler/status', JSON.stringify({ uniqueId: 'scheduler', online: true }));
    assert.strictEqual(ctx.statuses, 1);
    assert.strictEqual(ctx.started, 0, 'its servers are already running');
  });

  it('does not announce itself when the Scheduler goes offline', async () => {
    const ctx = connectedCtx(Ctx.states.READY);
    await emit(ctx, 'scheduler/status', JSON.stringify({ uniqueId: 'scheduler', online: false }));
    assert.strictEqual(ctx.statuses, 0);
  });

  it('still registers through maybeStartServers on its first connection', async () => {
    const ctx = connectedCtx(Ctx.states.WAITING_SCHEDULER);
    await emit(ctx, 'scheduler/status', JSON.stringify({ uniqueId: 'scheduler', online: true }));
    assert.strictEqual(ctx.started, 1);
    assert.strictEqual(ctx.statuses, 0, 'maybeStartServers publishes it');
  });
});
