const debug = require('debug')(`scheduler:BrokerClient`);
const { MqttClient, Component, Model } = require('live-srt-lib')
const { v4: uuidv4 } = require('uuid');

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
    this.subs = [`transcriber/out/+/status`, `session/out/+/#`, `transcriber/out/+/final`]
    this.state = CONNECTING;
    this.emit("connecting");
    //Note specific retain status for last will and testament cause we wanna ALWAYS know when scheduler is offline
    //Scheduler online status is required for other components to publish their status, ensuing synchronization of the system
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true });
    this.client.on("ready", () => {
      this.state = READY
      this.client.publishStatus();
      this.transcribers = new Array(); // internal scheduler representation of system transcribers. Gets published to broker on init as /transcribers/status
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init(); // binds controllers, those will handle messages
  }

  async saveTranscription(transcription, uniqueId) {
    try {
      const channel = await Model.Channel.findOne({where: {transcriber_id: uniqueId}})
      if (!channel) {
        throw new Error(`Channel with transcriber_id ${uniqueId} not found`)
      }
      const closedCaptions = Array.isArray(channel.closed_captions) ? channel.closed_captions : [];
      await channel.update({
        closed_captions: [...closedCaptions, transcription]
      });
    } catch (err) {
      console.error(`${new Date().toISOString()} [TRANSCRIPTION_SAVE_ERROR]: ${err.message}`, JSON.stringify(transcription));
    }
  }

  async createSession(requestBody) {
    const sessionId = uuidv4()
    const channels = requestBody.channels;
    let session;
    //start Model transaction
    const t = await Model.sequelize.transaction();
    let enrolledTranscribers = [];
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
        let transcriberProfile = await Model.TranscriberProfile.findByPk(channel.transcriberProfileId, { transaction: t });
        if (!transcriberProfile) {
          throw new Error(`Transcriber profile with id ${channel.transcriberProfileId} not found`);
        }
        // Enroll a running transcriber into the session channel
        let transcriber = await this.enrollTranscriber(transcriberProfile, session);
        let createdChannel = await Model.Channel.create({
          transcriber_id: transcriber.uniqueId,
          transcriberProfileId: transcriberProfile.id,
          languages: transcriberProfile.config.languages.map(language => language.candidate), //array of BCP47 language tags from transcriber profile
          name: channel.name,
          stream_endpoint: transcriber.stream_endpoint,
          stream_status: 'inactive',
          transcriber_status: transcriber.streamingServerStatus,
          closed_captions: null,
          closed_caption_live_delivery: uuidv4(),
          closed_captions_file_delivery: null,
          sessionId: session.id
        }, { transaction: t });
        createdChannels.push(createdChannel);
        enrolledTranscribers.push(transcriber);
      }
      session = await session.update({ status: 'ready' }, { transaction: t });
      await t.commit();
      return session.id;
    } catch (error) {
      await t.rollback();
      // free all enrolled transcribers
      for (const transcriber of enrolledTranscribers) {
        this.client.publish(`transcriber/in/${transcriber.uniqueId}/free`);
      }
      throw error;
    }
  }

  async execOnChannels(sessionId, callback) {
    try {
      const channels = await Model.Channel.findAll({where: { sessionId: sessionId }})
      for (const channel of channels) {
        callback(channel)
        this.client.publish(`transcriber/in/${channel.transcriber_id}/start`);
      }
    }
    catch (error) {
      const msg = `Error when retrieving channels: ${error}`
      console.error(msg)
      return msg
    }
  }

  async startSession(sessionId) {
    const error = await this.execOnChannels(sessionId, channel => {
        this.client.publish(`transcriber/in/${channel.transcriber_id}/start`)
    })
    if (error) {
      return error
    }

    try {
      await Model.Session.update({
        status: 'active',
        start_time: new Date()
      }, {
          where: {
            'id': sessionId
          }
      })
      await Model.Channel.update({
        stream_status: 'active',
        transcriber_status: 'streaming'
      }, {
          where: {
            'sessionId': sessionId
          }
      })
    } catch (err) {
      const msg = `Error when updating sessions and channels: ${err}`
      console.error(msg)
      return msg
    }
  }

  async stopSession(sessionId) {
    const error = await this.execOnChannels(sessionId, channel => {
        this.client.publish(`transcriber/in/${channel.transcriber_id}/free`);
    })
    if (error) {
      return error
    }

    try {
      await Model.Session.update({
        status: 'terminated',
        end_time: new Date()
      }, {
          where: {
            'id': sessionId
          }
      })
      await Model.Channel.update({
        stream_status: 'inactive',
        transcriber_status: 'closed'
      }, {
          where: {
            'sessionId': sessionId
          }
      })
    } catch (err) {
      const msg = `Error when updating sessions and channels: ${err}`
      console.error(msg)
      return msg
    }
  }

  async deleteSession(sessionId) {
    const error = await this.stopSession(sessionId)
    if (error) {
      return error
    }

    try {
      await Model.Session.destroy({where: {id: sessionId}})
    }
    catch (error) {
      const msg = `Error when deleting session: ${error}`
      console.error(msg)
      return msg
    }
  }

  async enrollTranscriber(transcriberProfile, session) {
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
      this.client.publish(`transcriber/in/${transcriber.uniqueId}/enroll`, { sessionId: session.id, transcriberProfile });
    });
  }


  // Called on message from broker
  async registerTranscriber(transcriber) {
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
      debug(`updating transcriber ${transcriber.uniqueId} --> ${JSON.stringify(transcriber)}`);
      // emit event to notify local listeners in method enrollTranscriber. 
      this.emit('transcriber_updated', mergedTranscriber);
    } else {
      // add the new transcriber to the list
      this.transcribers.push(transcriber);
      debug(`registering transcriber ${transcriber.uniqueId}`);
    }
    // publishes to broker
    this.publishTranscribers();
    // update channel associated to this transcriber
    await this.updateChannel(transcriber)
  }

  async updateChannel(transcriber) {
    if (!transcriber.id) {
      return
    }

    await Model.Channel.update({
      stream_endpoint: transcriber.stream_endpoint,
      transcriber_status: transcriber.streamingServerStatus
      }, {
      where: {
        transcriber_id: transcriber.id
      }
    })
  }

  async unregisterTranscriber(transcriber) {
    //remove transcriber from list of transcribers, using transcriber.uniqueId
    debug(`unregistering transcriber ${transcriber.uniqueId}`)

    // remove transcriber from channel in db
    const channel = await Model.Channel.findOne({
      where: {
        transcriber_id: transcriber.uniqueId
      }
    })

    if (channel) {
      channel.transcriber_id = null
      await channel.save()
    }

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
