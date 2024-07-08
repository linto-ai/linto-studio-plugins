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
    this.subs = [`transcriber/out/+/status`, `transcriber/out/+/final`, `transcriber/out/+/session`]
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
      await this.resetSessions(); // reset all active sessions / channels (stream_status) to ready/inactive state
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init(); // binds controllers, those will handle messages
  }

  // ###### TRANSCRIPTION ######

  async saveTranscription(transcription, uniqueId) {
    try {
      const channel = await Model.Channel.findOne({ where: { transcriber_id: uniqueId } })
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
      // Update channels associated with the transcriber to set stream_status to 'inactive'
      await Model.Channel.update(
        { stream_status: 'inactive', transcriber_id: null },
        { where: { transcriber_id: transcriber.uniqueId } }
      );
  
      // Fetch sessions that had channels associated with the transcriber
      const affectedSessions = await Model.Session.findAll({
        include: [{
          model: Model.Channel,
          where: { transcriber_id: transcriber.uniqueId },
          required: false
        }]
      });
  
      // Check each session for active channels and update status if necessary
      for (const session of affectedSessions) {
        const activeChannelsCount = await Model.Channel.count({
          where: {
            session_id: session.id,
            stream_status: 'active'
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

  async updateSession(transcriber_id, sessionId, channelIndex, newStreamStatus) {
    debug(`Updating session activity: ${sessionId} --> channel index: ${channelIndex} stream_status ${newStreamStatus}`);
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
          channel.stream_status = newStreamStatus; // Update the specific channel's stream_status
          if (newStreamStatus === 'active') {
            channel.transcriber_id = transcriber_id; // Set the transcriber_id for the channel
          } else {
            channel.transcriber_id = null; // Reset the transcriber_id for the channel
          }
          return channel.save(); // Return promise for async operation
        }
      });
  
      // Wait for all channel updates to complete
      await Promise.all(channelsUpdates);
  
      let hasActiveStream = session.channels.some(channel => channel.stream_status === 'active');
  
      // Update session status based on channels' stream statuses
      if (hasActiveStream && session.status !== 'active') {
        session.status = 'active';
        if (!session.start_time) {
          session.start_time = new Date();
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
          attributes: ['id', 'stream_status'],
        }
      ]
    });
    await Promise.all(sessions.map(async session => {
      await Promise.all(session.channels.map(async channel => {
        if (channel.stream_status === 'active') {
          await channel.update({ stream_status: 'inactive' });
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
          attributes: ['index', 'translations', 'stream_endpoints', 'stream_status', 'diarization', 'keepAudio'],
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
