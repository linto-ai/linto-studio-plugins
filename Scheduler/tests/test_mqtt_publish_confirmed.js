const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');

// lib's MqttClient.publishConfirmed(): resolves once the broker acknowledged
// the message, rejects instead of dropping it silently (publish() does while
// offline), so that the caller can retry. The real lib/mqtt.js, over a fake
// `mqtt` package client.

const libMqttPath = path.join(path.dirname(require.resolve('live-srt-lib')), 'mqtt.js');
const mqttPackagePath = require.resolve('mqtt', { paths: [path.dirname(libMqttPath)] });

class FakeMqttConnection extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.published = [];
        this.ack = (cb) => cb(); // what the broker does with a publish
    }
    publish(topic, message, options, cb) {
        this.published.push({ topic, message, options });
        this.ack(cb);
    }
    subscribe() {}
    unsubscribe() {}
}

describe('MqttClient.publishConfirmed()', () => {
    let MqttClient;
    let connection;
    let origMqtt;

    before(() => {
        origMqtt = require.cache[mqttPackagePath];
        require.cache[mqttPackagePath] = {
            id: mqttPackagePath, filename: mqttPackagePath, loaded: true,
            exports: { connect: () => { connection = new FakeMqttConnection(); return connection; } },
        };
        delete require.cache[libMqttPath];
        MqttClient = require(libMqttPath);
    });

    after(() => {
        if (origMqtt) require.cache[mqttPackagePath] = origMqtt; else delete require.cache[mqttPackagePath];
        delete require.cache[libMqttPath];
    });

    const client = () => new MqttClient({ pub: 'scheduler', uniqueId: 'scheduler' });

    it('resolves once the broker acknowledged the message', async () => {
        const c = client();
        let acknowledge;
        connection.ack = (cb) => { acknowledge = cb; };
        let settled = false;
        const publishing = c.publishConfirmed('system/out/sessions/ended', { id: 's1' }).then(() => { settled = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(settled, false, 'not before the acknowledgment');
        acknowledge();
        await publishing;
        assert.deepStrictEqual(connection.published, [{
            topic: 'system/out/sessions/ended', message: JSON.stringify({ id: 's1' }), options: { qos: 1, retain: false },
        }]);
    });

    it('rejects while offline, without publishing', async () => {
        const c = client();
        connection.connected = false;
        await assert.rejects(c.publishConfirmed('system/out/sessions/ended', {}), /offline/);
        assert.deepStrictEqual(connection.published, []);
    });

    it('rejects on a publish error', async () => {
        const c = client();
        connection.ack = (cb) => cb(new Error('connection closed'));
        await assert.rejects(c.publishConfirmed('system/out/sessions/ended', {}), /connection closed/);
    });

    it('rejects without acknowledgment within the timeout', async () => {
        const c = client();
        connection.ack = () => {};
        await assert.rejects(c.publishConfirmed('system/out/sessions/ended', {}, 1, false, 30), /no acknowledgment within 30 ms/);
    });

    it('resolves a subtopic under the client root, like publish()', async () => {
        const c = client();
        await c.publishConfirmed('status', {});
        assert.strictEqual(connection.published[0].topic, 'scheduler/status');
    });
});

// The real mqtt.js client, over an in-memory fake broker. mqtt.js keeps a QoS 1
// message it had no acknowledgment for in its outgoing store and sends it again
// on its next connection (clean session or not). Once publishConfirmed() gave
// up on it, the caller retries the publication itself: mqtt.js must not send
// it again too.
describe('MqttClient.publishConfirmed() with mqtt.js', () => {
    const { Duplex } = require('stream');
    const RealMqtt = require(mqttPackagePath);
    const mqttPacket = require(require.resolve('mqtt-packet', { paths: [path.dirname(mqttPackagePath)] }));
    let MqttClient;
    let origMqtt;
    let broker;
    let clients;

    // Accepts connections, records the publications, acknowledges them only
    // when `acknowledges` is set.
    function fakeBroker() {
        const state = { publishes: [], acknowledges: true, connections: [] };
        state.streamBuilder = () => {
            const parser = mqttPacket.parser();
            const stream = new Duplex({
                read() {},
                write(chunk, encoding, cb) { parser.parse(chunk); cb(); },
            });
            const send = (packet) => { if (!stream.destroyed) stream.push(mqttPacket.generate(packet)); };
            parser.on('packet', (packet) => {
                if (packet.cmd === 'connect') send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
                if (packet.cmd === 'publish') {
                    state.publishes.push({ topic: packet.topic, dup: packet.dup });
                    if (packet.qos > 0 && state.acknowledges) send({ cmd: 'puback', messageId: packet.messageId });
                }
            });
            state.connections.push(stream);
            return stream;
        };
        return state;
    }

    before(() => {
        origMqtt = require.cache[mqttPackagePath];
        require.cache[mqttPackagePath] = {
            id: mqttPackagePath, filename: mqttPackagePath, loaded: true,
            exports: {
                connect: (options) => new RealMqtt.MqttClient(broker.streamBuilder, { ...options, keepalive: 0, reconnectPeriod: 20 }),
            },
        };
        delete require.cache[libMqttPath];
        MqttClient = require(libMqttPath);
    });

    after(() => {
        if (origMqtt) require.cache[mqttPackagePath] = origMqtt; else delete require.cache[mqttPackagePath];
        delete require.cache[libMqttPath];
    });

    beforeEach(() => {
        broker = fakeBroker();
        clients = [];
    });

    afterEach(() => clients.forEach((c) => c.client.end(true)));

    async function connected() {
        const c = new MqttClient({ pub: 'scheduler', uniqueId: 'scheduler', subs: [] });
        clients.push(c);
        await new Promise((resolve) => c.once('ready', resolve));
        return c;
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const ended = () => broker.publishes.filter((p) => p.topic === 'system/out/sessions/ended');

    it('resolves on the broker\'s acknowledgment', async () => {
        const c = await connected();
        await c.publishConfirmed('system/out/sessions/ended', { id: 's1' }, 1, false, 500);
        assert.strictEqual(ended().length, 1);
    });

    it('is not sent again by mqtt.js on reconnect once it timed out', async () => {
        const c = await connected();
        broker.acknowledges = false; // e.g. the acknowledgment is lost
        await assert.rejects(c.publishConfirmed('system/out/sessions/ended', { id: 's1' }, 1, false, 50), /no acknowledgment/);
        assert.strictEqual(ended().length, 1);
        broker.acknowledges = true;
        broker.connections[0].destroy(); // the connection drops: mqtt.js reconnects
        await wait(200);
        assert.ok(broker.connections.length >= 2, 'reconnected');
        assert.deepStrictEqual(ended().length, 1, 'mqtt.js did not send it again: the caller\'s retry is the only one');
    });

    it('is sent again by mqtt.js on reconnect while still waiting for the acknowledgment', async () => {
        const c = await connected();
        broker.acknowledges = false;
        const publishing = c.publishConfirmed('system/out/sessions/ended', { id: 's1' }, 1, false, 2000);
        await wait(20);
        broker.acknowledges = true;
        broker.connections[0].destroy();
        await publishing; // acknowledged once sent again
        assert.strictEqual(ended().length, 2, 'sent, then sent again by mqtt.js');
    });
});
