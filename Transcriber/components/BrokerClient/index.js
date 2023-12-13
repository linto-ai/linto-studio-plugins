const debug = require('debug')(`transcriber:BrokerClient`);
const { MqttClient, Component } = require('live-srt-lib')
const { v4: uuidv4 } = require('uuid');
class BrokerClient extends Component {

  static states = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    READY: 'ready',
    WAITING_SCHEDULER: 'waiting_scheduler',
    ERROR: 'error',
    SESSION_BOUND: 'session_bound', //connected and bound to a session
  };

  constructor(app) {
    super(app);
    this._state = BrokerClient.states.DISCONNECTED;
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.uniqueId = uuidv4(); //unique ID for this instance / path for MQTT
    this.streaming_protocol = process.env.STREAMING_PROTOCOL
    this.srt_mode = process.env.SRT_MODE || null;
    this.bound_session = null; // will bind to a session when used

    this.domainSpecificValues = {
      streaming_protocol: this.streaming_protocol,
      srt_mode: this.srt_mode,
      uniqueId: this.uniqueId
    }

    this.pub = `transcriber/out/${this.uniqueId}`;
    this.subs = [`transcriber/in/${this.uniqueId}/#`, `scheduler/status`]

    this.state = BrokerClient.states.CONNECTING;
    this.emit("connecting");
    this.init(); // binds controllers
    this.connect();
  }

  async connect() {
    const { DISCONNECTED, CONNECTING, WAITING_SCHEDULER, READY, ERROR, SESSION_BOUND } = this.constructor.states;
    delete this.client;
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs });
    this.client.registerDomainSpecificValues(this.domainSpecificValues)
    this.client.on("ready", () => {
      // status will be published only when scheduler online message is received
      this.state = WAITING_SCHEDULER;
      debug(`${this.uniqueId} Connected to broker - WAITING_SCHEDULER`)
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
      debug(`${this.uniqueId} Something went wrong with broker connection`, err)
    });
    this.client.on("close", () => {
      this.state = DISCONNECTED;
      debug(`${this.uniqueId} Disconnected from broker - CLOSE`)
    })
    this.client.on("offline", () => {
      this.state = DISCONNECTED;
      debug(`${this.uniqueId} Disconnected from broker - BROKER OFFLINE`)
    })

    this.client.on("message", (topic, message) => {
      this.emit("message", topic, message);
    });
  }

  async setSession(sessionInfo) {
    const { sessionId, transcriberProfile } = sessionInfo;
    this.bound_session = sessionId;
    // MQTT status payload update
    this.client.registerDomainSpecificValues({ bound_session: this.bound_session })
    this.state = BrokerClient.states.SESSION_BOUND;
    debug(`${this.uniqueId} Bound to session ${this.bound_session}`)
    // publish will occur when streaming server component will change state upon configure method call, see Transcriber/components/StreamingServer/controllers/StreamingServer.js
    if (this.app.components['StreamingServer'].state == 'initialized') {
      this.app.components['ASR'].configure(transcriberProfile)
    }
    else {
      this.app.components['StreamingServer'].on('initialized', () => {
        this.app.components['ASR'].configure(transcriberProfile)
      })
    }
  }

  async start() {
    debug(`${this.uniqueId} started from session`)
    this.app.components['StreamingServer'].start()
  }

  async free() {
    this.bound_session = null;
    this.state = BrokerClient.states.READY;
    debug(`${this.uniqueId} Freed from session`)
    this.app.components['StreamingServer'].initialize()
    this.client.registerDomainSpecificValues({ bound_session: null })
    this.client.publishStatus();
  }
}

module.exports = app => new BrokerClient(app);
