const debug = require('debug')(`scheduler:BrokerClient`);
const { MqttClient, Component, Model } = require('live-srt-lib')

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
    this.subs = [`transcriber/out/+/status`, `transcriber/out/+/final`, `transcriber/out/+/session`, `scheduler/in/#`]
    this.state = CONNECTING;
    this.timeoutId = null
    this.emit("connecting");
    this.transcribers = new Array(); // internal scheduler representation of system transcribers.
    //Note specific retain status for last will and testament cause we wanna ALWAYS know when scheduler is offline
    //Scheduler online status is required for other components to publish their status, ensuing synchronization of the system
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true });
    this.client.on("ready", async () => {
      this.state = READY
      this.client.publishStatus(); // scheduler status (online)
      await this.resetSessions(); // reset all active sessions / channels (streamStatus) to ready/inactive state
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init(); // binds controllers, those will handle messages
  }


  // ###### Asked to schedule things ######

  // Choose the least used transcriber to start a bot
  // we do this cause bot handling needs to be scheduled on the instance with the least load
  async startBot(session, channelIndex, address, botType) {
    // search all channels with active streamStatus
    // count the number of active channels for each transcriberId, choose the one with the least active channels
    // ignore channels with transcriberId = null or set to an id that is not in the transcribers array
    // if no transcriber is found, use the first transcriber in the transcribers array
    // publish the startbot command to the chosen transcriber

    try {
      // Fetch active channels and count them by transcriberId
      const activeChannelsCount = await Model.Channel.findAll({
        where: {
          streamStatus: 'active',
          transcriberId: {
            [Model.Op.not]: null, // Exclude channels with null transcriberId
          }
        },
        attributes: [
          'transcriberId',
          [Model.sequelize.fn('COUNT', Model.sequelize.col('transcriberId')), 'activeCount']
        ],
        group: 'transcriberId',
        raw: true
      });

      // Filter to include only those transcribers currently registered and online
      const validTranscriberCounts = activeChannelsCount.filter(c =>
        this.transcribers.find(t => t.uniqueId === c.transcriberId && t.online)
      );

      // Sort to find the least used transcriber that is online
      let chosenTranscriber = null;
      let leastActiveCount = Infinity;
      validTranscriberCounts.forEach(c => {
        const transcriber = this.transcribers.find(t => t.uniqueId === c.transcriberId && t.online);
        if (transcriber && c.activeCount < leastActiveCount) {
          chosenTranscriber = transcriber;
          leastActiveCount = c.activeCount;
        }
      });

      // Use the first online transcriber if none found by active channel count
      if (!chosenTranscriber) {
        chosenTranscriber = this.transcribers.find(t => t.online);
      }

      if (chosenTranscriber) {
        this.client.publish(`transcriber/in/${chosenTranscriber.uniqueId}/startbot`, { session, channelIndex, address, botType }, 2, false, true);
        debug(`Bot scheduled on transcriber ${chosenTranscriber.uniqueId} for session ${session.id}, channel ${channelIndex}`);
      } else {
        console.error('No transcriber available to start bot.');
      }
    } catch (error) {
      console.error('Failed to start bot:', error);
    }
  }

  async stopBot(sessionId, channelIndex) {
    // find the transcriberId for the channel
    // publish the stopbot command to the transcriber
    try {
      const channel = await Model.Channel.findOne({ where: { sessionId: sessionId, index: channelIndex } });
      if (!channel?.transcriberId) {
        return;
      }
      this.client.publish(`transcriber/in/${channel.transcriberId}/stopbot`, { sessionId, channelIndex }, 2, false, true);
    } catch (error) {
      console.error('Failed to stop bot:', error);
    }
  }

  // ###### TRANSCRIPTION ######

  async saveTranscription(transcription, sessionId, channelIndex) {
    try {
      const channel = await Model.Channel.findOne({ where: { sessionId: sessionId, index: channelIndex } });
      if (!channel) {
        throw new Error(`Channel with session ${sessionId} and index ${channelIndex} not found`)
      }
      const closedCaptions = Array.isArray(channel.closedCaptions) ? channel.closedCaptions : [];
      await channel.update({
        closedCaptions: [...closedCaptions, transcription]
      });
    } catch (err) {
      console.error(`${new Date().toISOString()} [TRANSCRIPTION_SAVE_ERROR]: ${err.message}`, JSON.stringify(transcription));
    }
  }

  // ###### SYSTEM STATUS ######

  // A transcriber has connected.
  async registerTranscriber(transcriber) {
    this.transcribers.push(transcriber);
    // new transcriber registered, publish the current list of sessions to broker
    debug(`Transcriber ${transcriber.uniqueId} UP`);
    await this.publishSessions();
    debug(`Transcriber replicas: ${this.transcribers.length}`);
  }

  // A transcriber goes offline. Cleanup channels associated with the transcriber. If a session has no active channels, set it to ready.
  async unregisterTranscriber(transcriber) {
    this.transcribers = this.transcribers.filter(t => t.uniqueId !== transcriber.uniqueId);
    try {
      // Update channels associated with the transcriber to set streamStatus to 'inactive'
      await Model.Channel.update(
        { streamStatus: 'inactive', transcriberId: null },
        { where: { transcriberId: transcriber.uniqueId } }
      );

      // Fetch sessions that had channels associated with the transcriber
      const affectedSessions = await Model.Session.findAll({
        include: [{
          model: Model.Channel,
          where: { transcriberId: transcriber.uniqueId },
          required: false
        }]
      });

      // Check each session for active channels and update status if necessary
      for (const session of affectedSessions) {
        const activeChannelsCount = await Model.Channel.count({
          where: {
            sessionId: session.id,
            streamStatus: 'active'
          }
        });

        if (activeChannelsCount === 0) {
          session.status = 'ready';
          await session.save();
        }
      }

      debug(`Transcriber ${transcriber.uniqueId} DOWN`);
      this.publishSessions();
    } catch (error) {
      console.error(`Error updating channels for transcriber ${transcriber.uniqueId}:`, error);
    }
  }

  async updateSession(transcriberId, sessionId, channelIndex, newStreamStatus) {
    debug(`Updating session activity: ${sessionId} --> channel index: ${channelIndex} streamStatus ${newStreamStatus}`);
    try {
      // Fetch the session with its channels
      const session = await Model.Session.findByPk(sessionId, {
        include: [{ model: Model.Channel }]
      });

      if (!session) {
        console.error(`Session with ID ${sessionId} not found.`);
        return;
      }

      // Map through channels and prepare promises for updating them
      const channelsUpdates = session.channels.map(channel => {
        if (channel.index === channelIndex) {
          channel.streamStatus = newStreamStatus; // Update the specific channel's streamStatus
          if (newStreamStatus === 'active') {
            channel.transcriberId = transcriberId; // Set the transcriberId for the channel
          } else {
            channel.transcriberId = null; // Reset the transcriberId for the channel
          }
          return channel.save(); // Return promise for async operation
        }
      });

      // Wait for all channel updates to complete
      await Promise.all(channelsUpdates);

      let hasActiveStream = session.channels.some(channel => channel.streamStatus === 'active');

      // Update session status based on channels' stream statuses
      if (hasActiveStream && session.status !== 'active') {
        session.status = 'active';
        if (!session.startTime) {
          session.startTime = new Date();
        }
      } else if (!hasActiveStream && session.status !== 'ready') {
        session.status = 'ready';
      }

      await session.save();
      await this.publishSessions();
    } catch (error) {
      console.error(`Error updating session ${sessionId}:`, error);
    }
  }

  async resetSessions() {
    const sessions = await Model.Session.findAll({
      where: { status: 'active' }, // Only select active sessions
      attributes: ['id', 'status'],
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          attributes: ['id', 'streamStatus'],
        }
      ]
    });
    await Promise.all(sessions.map(async session => {
      await Promise.all(session.channels.map(async channel => {
        if (channel.streamStatus === 'active') {
          await channel.update({ streamStatus: 'inactive' });
        }
      }));
      session.status = 'ready'; // Update session status to inactive
      await session.save();
    }));
  }

  async publishSessions() {
    const sessions = await Model.Session.findAll({
      attributes: ['id', 'status'],
      where: { status: ['active', 'ready'] },
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          attributes: ['index', 'translations', 'streamEndpoints', 'streamStatus', 'diarization', 'keepAudio'],
          include: [{
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriber_profile' // Use the correct alias as defined in your association
          }]
        }
      ]
    });
    debug('Publishing all ACTIVE and READY sessions on broker: ', sessions.length);
    // Publish the sessions to the broker
    this.client.publish('system/out/sessions/statuses', sessions, 1, true, true);
  }

}

module.exports = app => new BrokerClient(app);
