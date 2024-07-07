const debug = require('debug')(`transcriber:BrokerClient`);
const { MqttClient, Component } = require('live-srt-lib')
const { v4: uuidv4 } = require('uuid');
class BrokerClient extends Component {

  static states = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    READY: 'ready',
    WAITING_SCHEDULER: 'waiting_scheduler',
    ERROR: 'error'
  };

  constructor(app) {
    super(app);
    this._state = BrokerClient.states.DISCONNECTED;
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.sessions = []; //sessions will be updated by the system/out/sessions/statuses messages (see controllers/MqttMessages.js)
    this.uniqueId = uuidv4(); //unique ID for this instance / path for MQTT

    this.domainSpecificValues = {
      srt_mode: this.srt_mode,
      uniqueId: this.uniqueId
    }

    this.pub = `transcriber/out/${this.uniqueId}`;
    this.subs = [`transcriber/in/${this.uniqueId}/#`, `scheduler/status`, `system/out/sessions/#`]

    this.state = BrokerClient.states.CONNECTING;
    this.init(); // binds controllers
    this.connect();
  }

  handleSessions(sessions) {
    // Create a set of incoming session IDs for easy lookup
    // called by controllers/MqttMessages.js uppon receiving system/out/sessions/statuses message
    // only ready and active sessions are present in the incoming sessions (broker retained message only holds ready and active sessions)
    const incomingSessionIds = new Set(sessions.map(session => session.id));

    // Filter out sessions that are not present in the incoming sessions
    this.sessions = this.sessions.filter(session => incomingSessionIds.has(session.id));

    // Update existing sessions or add new ones
    for (const session of sessions) {
      const index = this.sessions.findIndex(s => s.id === session.id);
      if (index === -1) {
        // If the session is not found, add it
        this.sessions.push(session);
      } else {
        // If the session is found, update it
        this.sessions[index] = session;
      }
    }
    // to be consumed by streaming server controller
    this.emit("sessions", this.sessions)
    debug(`Registered all ACTIVE and READY sessions: ${this.sessions.length}`);
  }

  activateSession(session, channelIndex) {
    // called by controllers/StreamingServer/controllers/StreamingServer.js uppon receiving session-start message
    this.client.publish(`session`, { transcriber_id: this.uniqueId, id: session.id, status: 'active', channel: channelIndex }, 2, false, true);
  }

  deactivate(session, channelIndex) {
    // called by controllers/StreamingServer/controllers/StreamingServer.js uppon receiving session-stop message
    this.client.publish(`session`, { transcriber_id: this.uniqueId, id: session.id, status: 'inactive', channel: channelIndex }, 2, false, true);
  }

  async connect() {
    const { DISCONNECTED, WAITING_SCHEDULER, ERROR } = this.constructor.states;
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
}

module.exports = app => new BrokerClient(app);
