const debug = require('debug')(`session-api:BrokerClient`);
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
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.state = CONNECTING;
    this.pub = `session/out`;
    this.subs = [`session/in/+/#`]

    this.state = CONNECTING;
    this.emit("connecting");
    this.client = new MqttClient({ pub: `session`, subs: this.subs, retain: false, uniqueId: 'session-api' });
    this.client.on("ready", () => {
      this.state = READY
      this.client.publishStatus();
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init(); // binds controllers, those will handle messages
  }

  forwardSessionCreation(requestBody, sessionId) {
    this.client.publish(`${this.pub}/${sessionId}/ask_creation`, requestBody);
  }

}

module.exports = app => new BrokerClient(app);