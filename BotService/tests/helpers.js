// Mock helpers for BotService BrokerClient tests. We swap `live-srt-lib` in the
// require cache so the real MQTT stack never connects, mirroring the Scheduler's
// test approach. Component/logger are real-enough stubs; MqttClient is a mock the
// test drives directly (its 'ready'/'message' events fire on demand).
const path = require('path')
const EventEmitter = require('events')

const liveSrtLibPath = require.resolve('live-srt-lib')
const brokerClientPath = path.resolve(__dirname, '../components/BrokerClient/index.js')

function makeLogger (logs) {
  const push = (level) => (...args) => logs.push({ level, msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') })
  return { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), log: push('log') }
}

class FakeComponent extends EventEmitter {
  constructor (app) { super(); this.app = app; this._state = 'uninitialized' }
  async init () {}
  get state () { return this._state }
  set state (v) { const old = this._state; this._state = v; if (old !== v) this.emit(v) }
}

function makeMqttClient (record) {
  const client = new EventEmitter()
  client.publish = (topic, payload, qos, retain, requireOnline) => record.publishes.push({ topic, payload, qos, retain, requireOnline })
  client.publishStatus = (additional = {}) => record.statuses.push(additional)
  return client
}

function installMocks ({ logger, mqttClient }) {
  require.cache[liveSrtLibPath] = {
    id: liveSrtLibPath,
    filename: liveSrtLibPath,
    loaded: true,
    exports: {
      Component: FakeComponent,
      MqttClient: function () { return mqttClient },
      logger,
      Application: class {},
      Model: {},
      CircularBuffer: class {},
      Config: {},
      CustomErrors: {},
      Security: class {}
    }
  }
  delete require.cache[brokerClientPath]
}

function uninstallMocks () {
  delete require.cache[liveSrtLibPath]
  delete require.cache[brokerClientPath]
}

// Build a BrokerClient against the mocks. Stubs the BrowserPool/LocalAudioServer
// init so emitting 'ready' never launches a real browser or binds a port.
function loadBrokerClient () {
  const logs = []
  const record = { publishes: [], statuses: [] }
  const mqttClient = makeMqttClient(record)
  installMocks({ logger: makeLogger(logs), mqttClient })

  const factory = require(brokerClientPath)
  const instance = factory({ components: {} })
  instance.browserPool.init = async () => {}
  instance.audioServer.start = async () => {}
  instance.audioServer.getPort = () => 12345
  return { instance, mqttClient, logs, ...record }
}

module.exports = { loadBrokerClient, uninstallMocks, FakeComponent }
