// Common mocking helpers for Scheduler BrokerClient tests.
//
// BrokerClient pulls Component, MqttClient, Model and logger from `live-srt-lib`.
// We swap the entire module via the require-cache so the real Sequelize / MQTT
// stacks never load — the constructor would otherwise try to connect to the
// broker, schedule timers, walk the controllers directory, and reset sessions.
//
// Each test gets:
//   - a mutable Model with spy-friendly stubs (overrideable per test)
//   - a logs[] array that captures every logger call (level + concatenated message)
//   - a mqttPublishes[] array capturing this.client.publish() arguments
//   - the BrokerClient class (uninstantiated) so the test controls construction

const path = require('path');
// Node's built-in EventEmitter is API-compatible enough for our needs (on/emit)
// and avoids forcing tests to install the eventemitter3 dependency.
const EventEmitter = require('events');

const liveSrtLibPath = require.resolve('live-srt-lib');
const brokerClientPath = path.resolve(__dirname, '../components/BrokerClient/index.js');

// Sequelize Op stub: BrokerClient uses Model.Op.in / Model.Op.lt / Model.Op.lte / Model.Op.not.
// Symbols would be opaque to assertions, so plain string keys keep the where-clause readable.
const Op = {
    in: 'OP_IN',
    lt: 'OP_LT',
    lte: 'OP_LTE',
    not: 'OP_NOT',
};

function makeLogger(logs) {
    const push = (level) => (...args) => {
        logs.push({ level, msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') });
    };
    return {
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
        debug: push('debug'),
        log: push('log'),
    };
}

// Stand-in for the live-srt-lib Component base class. Strips out controllers
// loading and event-emitter quirks we don't need in unit tests, while keeping
// the EventEmitter contract so .emit() calls in BrokerClient don't blow up.
class FakeComponent extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
        this._state = 'uninitialized';
    }
    async init() { /* no-op: real impl walks controllers/ on disk */ }
    get state() { return this._state; }
    set state(v) { const old = this._state; this._state = v; if (old !== v) this.emit(v); }
}

// Stand-in for MqttClient. The real client opens a TCP connection in its
// constructor; we just need a publish/publishStatus surface and the 'ready'
// event to never fire automatically (tests trigger flows directly).
function makeMqttClient(mqttPublishes) {
    const client = new EventEmitter();
    client.publish = (topic, payload, qos, retain, json) => {
        mqttPublishes.push({ topic, payload, qos, retain, json });
    };
    client.publishStatus = () => {};
    return client;
}

class MockMqttClient {
    constructor() { /* never used: see installMocks */ }
}

function buildModel(overrides = {}) {
    // Default no-op stubs; tests override per-method to assert call args or
    // inject return values. Update returns Sequelize's [count, rows] shape.
    const noop = async () => [0, []];
    // Mirror Sequelize's Transaction.LOCK enum so code that passes
    // { lock: transaction.LOCK.UPDATE } to findByPk works under the mock.
    const LOCK = { UPDATE: 'UPDATE', SHARE: 'SHARE', NO_KEY_UPDATE: 'NO KEY UPDATE', KEY_SHARE: 'KEY SHARE' };
    const makeTx = () => ({ commit: async () => {}, rollback: async () => {}, LOCK });
    const sequelize = {
        // Pass-through transaction wrapper: BrokerClient calls
        // Model.sequelize.transaction(async (t) => { ... }) (managed) or
        // Model.sequelize.transaction() (unmanaged). Real impl returns a
        // transaction object the callback receives / the caller awaits.
        transaction: async (cb) => {
            if (typeof cb === 'function') {
                return cb(makeTx());
            }
            return makeTx();
        },
        literal: (sql) => ({ __literal: sql }),
        escape: (val) => `'${val}'`,
        fn: (...args) => ({ __fn: args }),
        col: (name) => ({ __col: name }),
    };

    return Object.assign({
        Op,
        sequelize,
        Session: {
            findAll: noop,
            findByPk: async () => null,
            findOne: async () => null,
            update: noop,
        },
        Channel: {
            findAll: noop,
            findByPk: async () => null,
            count: async () => 0,
            update: noop,
        },
        TranscriberProfile: {},
        Translator: {
            update: noop,
            upsert: noop,
        },
        Bot: {
            findByPk: async () => null,
            destroy: noop,
        },
        Caption: {
            create: noop,
        },
        TranslatedCaption: {
            create: noop,
        },
    }, overrides);
}

// Install mocks in require.cache so any subsequent `require('live-srt-lib')`
// resolves to our fake bundle. Must run BEFORE require()-ing BrokerClient.
function installMocks({ model, logger, mqttClient }) {
    const exportsBundle = {
        Component: FakeComponent,
        MqttClient: function MqttClientCtor() { return mqttClient; },
        Model: model,
        logger,
        Application: class {},
        CircularBuffer: class {},
        Config: {},
        CustomErrors: {},
        Security: class {},
    };
    require.cache[liveSrtLibPath] = {
        id: liveSrtLibPath,
        filename: liveSrtLibPath,
        loaded: true,
        exports: exportsBundle,
    };
    // Force re-evaluation of BrokerClient against the new mocks.
    delete require.cache[brokerClientPath];
}

function uninstallMocks() {
    delete require.cache[liveSrtLibPath];
    delete require.cache[brokerClientPath];
}

// Construct a BrokerClient with mocks, neutralising the periodic interval the
// constructor schedules so tests stay deterministic. Returns the instance.
async function loadBrokerClient({ model = buildModel(), logger, mqttClient, app = { components: {} } } = {}) {
    const logs = [];
    logger = logger || makeLogger(logs);
    const mqttPublishes = [];
    mqttClient = mqttClient || makeMqttClient(mqttPublishes);

    // Block setInterval inside the BrokerClient constructor so tests never
    // accumulate background timers (mocha would otherwise hang on exit).
    const realSetInterval = global.setInterval;
    global.setInterval = () => ({ unref() {}, ref() {} });

    installMocks({ model, logger, mqttClient });
    let BrokerClientFactory;
    try {
        BrokerClientFactory = require(brokerClientPath);
    } finally {
        global.setInterval = realSetInterval;
    }

    // BrokerClient is exported as a factory: `app => new BrokerClient(app)`.
    // Calling it returns the instance directly.
    const instance = BrokerClientFactory(app);
    return { instance, logs, mqttPublishes, model };
}

module.exports = {
    Op,
    buildModel,
    makeLogger,
    makeMqttClient,
    installMocks,
    uninstallMocks,
    loadBrokerClient,
};
