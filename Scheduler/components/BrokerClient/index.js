const debug = require('debug')(`scheduler:BrokerClient`);
const { MqttClient, Component, Model, Op } = require('live-srt-lib')

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
    this.uniqueId = 'scheduler'
    this.state = CONNECTING;
    this.pub = `scheduler`;
    this.subs = [`transcriber/out/+/status`, `session/out/+/#`]
    this.state = CONNECTING;
    this.emit("connecting");
    //Note specific retain status for last will and testament cause we wanna ALWAYS know when scheduler is offline
    //Scheduler online status is required for other components to publish their status, ensuing synchronization of the system
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true });
    this.client.on("ready", () => {
      this.state = READY
      this.client.publishStatus();
      this.transcribers = new Array(); // internal scheduler representation of system transcribers. Gets published to broker on init as /transcribers/status
      this.sessions = new Array(); // internal scheduler representation of system sessions
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init(); // binds controllers, those will handle messages
    this.registerActiveSessions();
  }

  // Called on startup to fetch active sessions from database
  async registerActiveSessions() {
    const sessions = await Model.Session.findAll({
      where: {
        [Op.or]: [
          { status: 'active' },
          { status: 'ready' },
        ],
      }
    });
    for (const session of sessions) {
      this.sessions.push(session);
    }
  }

  // Called on creation_ask from broker
  async createSession(requestBody, sessionId) {
    requestBody = JSON.parse(requestBody);
    const channels = requestBody.channels;
    let session;
    //start Model transaction 
    const t = await Model.sequelize.transaction();
    try {
      // Create a new session with the specified session ID and status
      session = await Model.Session.create({
        id: sessionId,
        status: 'pending_creation',
        name: requestBody.name || 'New session',
        start_time: null,
        end_time: null,
        errorred_on: null
      }, { transaction: t });
      // Create a new channel for each channel in the request body
      let createdChannels = [];
      for (const channel of channels) {
        // Find the transcriber profile for the channel
        let transcriberProfile = await Model.TranscriberProfile.findByPk(channel.transcriber_profile_id, { transaction: t });
        if (!transcriberProfile) {
          throw new Error(`Transcriber profile with id ${channel.transcriber_profile_id} not found`);
        }
        //if channel.language is not specified, or not supported by transcriber profile, throw error
        if (!channel.language || !transcriberProfile.config.languages.includes(channel.language)) {
          throw new Error(`Unsupported language ${channel.language}, check transcriber profile config`);
        }
        // Enroll a running transcriber into the session channel
        let transcriber = await this.enrollTranscriber(transcriberProfile, session, channel);
        let createdChannel = await Model.Channel.create({
          transcriber_id: transcriber.uniqueId,
          transcriber_profile_id: transcriberProfile.id,
          language: channel.language,
          name: channel.name,
          stream_endpoint: transcriber.stream_endpoint,
          stream_status: 'inactive',
          transcriber_status: transcriber.streamingServerStatus,
          closed_captions: null,
          closed_caption_live_delivery: null,
          closed_captions_file_delivery: null,
          sessionId: session.id
        }, { transaction: t });
        createdChannels.push(createdChannel);
      }
      session = await session.update({ status: 'ready' }, { transaction: t });
      await t.commit();
      return session.id;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }

  async enrollTranscriber(transcriberProfile, session, channel) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Transcriber enrollment timeout`));
        this.removeListener(`transcriber_updated`, onTranscriberUpdated);
      }, 10000);
      const onTranscriberUpdated = (transcriber) => {
        if (transcriber.bound_session === session.id) {
          clearTimeout(timeout);
          this.removeListener(`transcriber_updated`, onTranscriberUpdated);
          resolve(transcriber);
        }
      }
      this.on(`transcriber_updated`, onTranscriberUpdated);
      //filter transcribers not enrolled in any session
      const availableTranscribers = this.transcribers.filter(t => !t.bound_session);
      if (availableTranscribers.length === 0) {
        reject(new Error(`No available transcribers to enroll into session - ${this.transcribers.length} transcriber known by scheduler`));
      }
      const transcriber = availableTranscribers[0];
      // Enroll the first available transcriber into the session
      this.client.publish(`transcriber/in/${transcriber.uniqueId}/enroll`, { sessionId: session.id, channel, transcriberProfile });
    });
  }


  // Called on message from broker
  registerTranscriber(transcriber) {
    const existingTranscriberIndex = this.transcribers.findIndex(t => t.uniqueId === transcriber.uniqueId);
    if (existingTranscriberIndex !== -1) {
      // merge the new transcriber with the existing one
      const existingTranscriber = this.transcribers[existingTranscriberIndex];
      const mergedTranscriber = { ...existingTranscriber, ...transcriber };
      this.transcribers[existingTranscriberIndex] = mergedTranscriber;
      const changedProperties = Object.keys(transcriber).reduce((acc, key) => {
        if (existingTranscriber[key] !== transcriber[key]) {
          acc[key] = mergedTranscriber[key];
        }
        return acc;
      }, {});
      // TODO : check if transcriber status is wrong, if so, enroll new transcriber into session (replace) and update session status for channels
      debug(`updating transcriber ${transcriber.uniqueId} --> ${JSON.stringify(changedProperties)}`);
      // emit event to notify local listeners in method enrollTranscriber. 
      this.emit('transcriber_updated', mergedTranscriber);
    } else {
      // add the new transcriber to the list
      this.transcribers.push(transcriber);
      debug(`registering transcriber ${transcriber.uniqueId}`);
    }
    // publishes to broker
    this.publishTranscribers();
  }

  unregisterTranscriber(transcriber) {
    //remove transcriber from list of transcribers, using transcriber.uniqueId
    debug(`unregistering transcriber ${transcriber.uniqueId}`)
    this.transcribers = this.transcribers.filter(t => t.uniqueId !== transcriber.uniqueId);
  }


  publishTranscribers() {
    // publish transcribers to broker as a retained message on topic scheduler/transcribers
    // this is VERY IMPORTANT as it keeps a state of running transcribers in the broker
    // broker NEEDS to use persistent storage for retained messages !
    this.client.publish(`transcribers`, this.transcribers, 2, true, true);
  }

}

module.exports = app => new BrokerClient(app);