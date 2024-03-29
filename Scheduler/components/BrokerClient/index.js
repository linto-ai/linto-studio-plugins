const debug = require('debug')(`scheduler:BrokerClient`);
const { MqttClient, Component, Model } = require('live-srt-lib')
const { v4: uuidv4 } = require('uuid');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    this.timeoutId = null
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

  async updateChannel(transcriber) {
    if (!transcriber.uniqueId) {
      return
    }

    await Model.Channel.update({
      stream_endpoint: transcriber.stream_endpoint,
      transcriber_status: transcriber.streamingServerStatus
      }, {
      where: {
        transcriber_id: transcriber.uniqueId
      }
    })
  }

  async debounceSyncSystem() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
    }

    this.timeoutId = setTimeout(async () => {
      await this.syncSystem()
      this.timeoutId = null
    }, 3000)
  }

  async syncSystem() {
    await this.detectErroredChannels()

    // update channel in database
    for (const transcriber of this.transcribers) {
      await this.updateChannel(transcriber)
    }

    // try to bind transcriber to errored channel
    await this.bindErroredChannels()
  }

  async detectErroredChannels() {
    // stop channel with unexisting transcriber and add an entry in the erroredOn Session
    const existingTranscriberIds = this.transcribers.map(transcriber => transcriber.uniqueId)
    const where = {
      transcriber_id: {
        [Model.Op.notIn]: existingTranscriberIds
      },
      transcriber_status: {
        [Model.Op.in]: ['initialized', 'ready', 'streaming']
      }
    }

    // Update erroredOn
    const erroredChannels = await Model.Channel.findAll({
      include: [{
        model: Model.Session
      }],
      where: where
    })
    for (const channel of erroredChannels) {
      const erroredOn = Array.isArray(channel.session.errored_on) ? channel.session.errored_on : []
      const newError = {
        date: new Date(),
        channel_id: channel.id,
        error: { code: 1, msg: "Transcriber unavailable" } // currently, there is only 1 error
      }
      await channel.session.update({errored_on: [...erroredOn, newError]})
    }

    // Update the channels
    await Model.Channel.update({
      transcriber_id: null,
      stream_endpoint: null,
      transcriber_status: 'errored'
    }, { where: where })
  }

  async bindErroredChannels() {
    const erroredChannels = await Model.Channel.findAll({
      where: {
        transcriber_status: 'errored'
      },
      include: [
        { model: Model.Session },
        { model: Model.TranscriberProfile }
      ]
    })

    for (const channel of erroredChannels) {
      try {
        const transcriber = await this.enrollTranscriber(channel.transcriber_profile, channel.session)
        channel.transcriber_id = transcriber.uniqueId
        channel.stream_endpoint = transcriber.stream_endpoint
        channel.transcriber_status = transcriber.streamingServerStatus
        await channel.save()

        // if session is active, start the transcriber
        if (channel.session.status == 'active') {
          // let some time to the transcriber to init before starting it
          setTimeout(() => {
            this.client.publish(`transcriber/in/${channel.transcriber_id}/start`)
          }, 3000)
        }
      } catch (error) {
        debug(`No transcriber available for session ${channel.session.id}.`)
      }
    }
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
      const channels = await Model.Channel.findAll({
        where: { sessionId: sessionId },
        include: [
          { model: Model.Session }
        ]
      })
      for (const channel of channels) {
        await callback(channel)
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
    const error = await this.execOnChannels(sessionId, async (channel) => {
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

  async resetSession(sessionId) {
    // This function free all the session transcriber and enroll new transcribers
    // In order to follow the good process, the channel are put in errored and will be automatically
    // reaffected to others transcribers
    const error = await this.execOnChannels(sessionId, async (channel) => {
      debug(`Resetting channel ${channel.name} in session ${channel.session.id}`);
      this.client.publish(`transcriber/in/${channel.transcriber_id}/reset`);

      // let 2 seconds to the reset message to come back to the scheduler in order to be saved in the database
      // then the channel.trancriber_id can be set to null
      await sleep(2000);
      const erroredOn = Array.isArray(channel.session.errored_on) ? channel.session.errored_on : []
      const newError = {
        date: new Date(),
        channel_id: channel.id,
        error: { code: 2, msg: "Transcriber reset" }
      }
      await channel.session.update({errored_on: [...erroredOn, newError]})
      await channel.update({
        transcriber_id: null,
        stream_endpoint: null,
        transcriber_status: 'errored'
      })
    })

    if (error) {
      return error
    }

    await this.debounceSyncSystem()
  }

  async stopSession(sessionId) {
    const error = await this.execOnChannels(sessionId, async (channel) => {
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
        transcriber_id: null,
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
    await this.debounceSyncSystem()
  }

  async unregisterTranscriber(transcriber) {
    //remove transcriber from list of transcribers, using transcriber.uniqueId
    debug(`unregistering transcriber ${transcriber.uniqueId}`)
    this.transcribers = this.transcribers.filter(t => t.uniqueId !== transcriber.uniqueId)
    await this.debounceSyncSystem()
  }
}

module.exports = app => new BrokerClient(app);
