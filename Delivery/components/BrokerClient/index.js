const debug = require('debug')(`delivery:BrokerClient`);
const { MqttClient, Component } = require('live-srt-lib')

class BrokerClient extends Component {

  static states = {
    CONNECTING: 'connecting',
    READY: 'ready',
    ERROR: 'error',
  };

  _state = null;

  constructor(app) {
    super(app);
    const { CONNECTING, READY, ERROR } = this.constructor.states;
    this.id = this.constructor.name;
    this.state = CONNECTING;
    this.pub = "delivery"
    this.subs = [`transcriber/out/+/partial`, `transcriber/out/+/final`]
    this.client = new MqttClient({ pub: this.pub, subs: this.subs, retain: false, uniqueId: "delivery" });
    this.client.on("ready", () => {
      this.state = READY
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init();
  }
}

module.exports = app => new BrokerClient(app);
