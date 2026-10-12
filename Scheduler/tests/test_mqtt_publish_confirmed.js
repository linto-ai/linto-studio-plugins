const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');
const { describe, it, before, after } = require('mocha');

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
