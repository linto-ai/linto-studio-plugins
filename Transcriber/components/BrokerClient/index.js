const { MqttClient, Component } = require('live-srt-lib')
const { getAppId } = require('../../appContext');
const logger = require('../../logger')
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
    this.uniqueId = getAppId(); //unique ID for this instance / path for MQTT
    this.serversStarted = false; // Track if streaming servers have been started (to handle MQTT reconnection)

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

  handleStartBot(sessionId, channelId, address) {
    this.emit("jitsi-bot-start", sessionId, channelId, address);
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
    logger.info(`Registered all ACTIVE and READY sessions: ${this.sessions.length}`);
  }

  activateSession(session, channel) {
    // called by controllers/StreamingServer/controllers/StreamingServer.js uppon receiving session-start message
    this.client.publish(`session`, { transcriberId: this.uniqueId, sessionId: session.id, status: 'active', channelId: channel.id }, 2, false, true);
  }

  deactivate(session, channelId) {
    // called by controllers/StreamingServer/controllers/StreamingServer.js uppon receiving session-stop message
    this.client.publish(`session`, { transcriberId: this.uniqueId, sessionId: session.id, status: 'inactive', channelId: channelId }, 2, false, true);
  }

  async connect() {
    const { DISCONNECTED, WAITING_SCHEDULER, ERROR } = this.constructor.states;
    delete this.client;
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs });
    this.client.registerDomainSpecificValues(this.domainSpecificValues)
    this.client.on("ready", () => {
      if (this.serversStarted) {
        // Reconnection: servers are already running, go directly to READY
        this.state = BrokerClient.states.READY;
        this.client.publishStatus();
        logger.info(`${this.uniqueId} Reconnected to broker - READY (servers already running)`)
      } else {
        // First connection: wait for scheduler to start servers
        this.state = WAITING_SCHEDULER;
        logger.info(`${this.uniqueId} Connected to broker - WAITING_SCHEDULER`)
      }
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
      logger.error(`${this.uniqueId} Something went wrong with broker connection`, err)
    });
    this.client.on("close", () => {
      this.state = DISCONNECTED;
      logger.warn(`${this.uniqueId} Disconnected from broker - CLOSE`)
    })
    this.client.on("offline", () => {
      this.state = DISCONNECTED;
      logger.warn(`${this.uniqueId} Disconnected from broker - BROKER OFFLINE`)
    })
    this.client.on("message", (topic, message) => {
      this.emit("message", topic, message);
    });
  }
}

module.exports = app => new BrokerClient(app);
