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
    this.sub_templates = [
      transcriberId => `transcriber/out/${transcriberId}/partial`,
      transcriberId => `transcriber/out/${transcriberId}/final`
    ]
    this.subs = [`transcriber/out/+/partial`, `transcriber/out/+/final`]
    this.client = new MqttClient({ pub: this.pub, retain: false, uniqueId: "delivery" });
    this.client.on("ready", () => {
      this.state = READY
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init();
  }

  subscribe(transcriberId) {
    debug(`Subscribe to transcriber ${transcriberId}`)
    for (const sub_template of this.sub_templates) {
      this.client.subscribe(sub_template(transcriberId))
    }
  }

  unsubscribe(transcriberId) {
    debug(`Unsubscribe from transcriber ${transcriberId}`)
    for (const sub_template of this.sub_templates) {
      this.client.unsubscribe(sub_template(transcriberId))
    }
  }
}

module.exports = app => new BrokerClient(app);
