const { MqttClient, Component, Model, logger } = require('live-srt-lib')

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
    this.subs = [`transcriber/out/+/status`, `transcriber/out/+/+/final`, `transcriber/out/+/session`, `scheduler/in/#`]
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

    setInterval(async () => {
      const autoStartUpdated = await this.autoStart();
      const autoEndUpdated = await this.autoEnd();
      if (autoStartUpdated || autoEndUpdated) {
        await this.publishSessions();
      }
    }, 60 * 1000);
  }


  // ###### Asked to schedule things ######
  async autoStart() {
    const [updatedCount, updatedSessions] = await Model.Session.update(
      { status: 'ready' },
      {
        where: {
          status: 'on_schedule',
          autoStart: true,
          scheduleOn: {
            [Model.Op.gt]: new Date()
          }
        },
        returning: true
      }
    );

    const sessionIds = updatedSessions.map(session => session.id);
    if (sessionIds.length > 0) {
      logger.debug(`Auto start sessions ${sessionIds}`);
    }

    return sessionIds.length > 0;
  }

  async autoEnd() {
    let isUpdated = false;

    await Model.sequelize.transaction(async (transaction) => {
      const [updatedCount, updatedSessions] = await Model.Session.update(
        {
          status: 'terminated',
          endTime: new Date()
        },
        {
          where: {
            status: 'ready',
            autoEnd: true,
            endOn: {
              [Model.Op.lt]: new Date()
            }
          },
          returning: true,
          transaction
        }
      );

      const sessionIds = updatedSessions.map(session => session.id);

      if (sessionIds.length > 0) {
        logger.debug(`Auto end sessions ${sessionIds}`);
        isUpdated = true;
        await Model.Channel.update(
          { streamStatus: 'inactive' },
          {
            where: {
              sessionId: {
                [Model.Op.in]: sessionIds
              }
            },
            transaction
          }
        );
      }
    });

    return isUpdated;
  }

  // Choose the least used transcriber to start a bot
  // we do this cause bot handling needs to be scheduled on the instance with the least load
  async startBot(botId) {
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
        // retrieve bot data
        const botData = await this.getStartBotData(botId);
        this.client.publish(`transcriber/in/${chosenTranscriber.uniqueId}/startbot`, botData, 2, false, true);
        logger.debug(`Bot scheduled on transcriber ${chosenTranscriber.uniqueId} for session ${botData.session.id}, channel ${botData.channelId}`);
      } else {
        logger.error('No transcriber available to start bot.');
      }
    } catch (error) {
      logger.error('Failed to start bot:', error);
    }
  }

  async getStartBotData(botId) {
    const bot = await Model.Bot.findByPk(botId);
    const session = await Model.Session.findOne({
      include: [
        {
          model: Model.Channel,
          where: {id: bot.channelId},
          include: [Model.TranscriberProfile]
        }
      ]
    });

    return {
      session, channel: session.channels[0], address: bot.url,
      botType: bot.provider,
      enableLiveTranscripts: bot.enableLiveTranscripts,
      enableDisplaySub: bot.enableDisplaySub, subSource: bot.subSource
    }
  }

  async stopBot(botId) {
    // find the transcriberId for the channel
    // publish the stopbot command to the transcriber
    try {
      logger.debug(`Stopping bot ${botId}`)
      const bot = await Model.Bot.findByPk(botId, {include: Model.Channel});
      const channel = bot.channel;

      await Model.Bot.destroy({
        where: {id: bot.id}
      });

      if (!channel?.transcriberId) {
        logger.warn(`No transcriberId in channel ${channel.id}`);
        return;
      }

      this.client.publish(`transcriber/in/${channel.transcriberId}/stopbot`, { sessionId: channel.sessionId, channelId: channel.id }, 2, false, true);
    } catch (error) {
      logger.error('Failed to stop bot:', error);
    }
  }

  // ###### TRANSCRIPTION ######

  async saveTranscription(transcription, sessionId, channelId) {
    try {
      const newTranscription = JSON.stringify([transcription]);
      await Model.Channel.update(
        {
          closedCaptions: Model.sequelize.literal(
            `COALESCE("closedCaptions"::jsonb, '[]'::jsonb) || ${Model.sequelize.escape(newTranscription)}::jsonb`
          )
        },
        {
          where: {
            sessionId: sessionId,
            id: channelId
          }
        }
      );
    } catch (err) {
      logger.error(
        `${new Date().toISOString()} [TRANSCRIPTION_SAVE_ERROR]: ${err.message}`,
        JSON.stringify(transcription)
      );
    }
  }

  // ###### SYSTEM STATUS ######

  // A transcriber has connected.
  async registerTranscriber(transcriber) {
    this.transcribers.push(transcriber);
    // new transcriber registered, publish the current list of sessions to broker
    logger.debug(`Transcriber ${transcriber.uniqueId} UP`);
    await this.publishSessions();
    logger.debug(`Transcriber replicas: ${this.transcribers.length}`);
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

      logger.debug(`Transcriber ${transcriber.uniqueId} DOWN`);
      this.publishSessions();
    } catch (error) {
      logger.error(`Error updating channels for transcriber ${transcriber.uniqueId}:`, error);
    }
  }

  async updateSession(transcriberId, sessionId, channelId, newStreamStatus) {
    logger.debug(`Updating session activity: ${sessionId} --> channel id: ${channelId} streamStatus ${newStreamStatus}`);
    const transaction = await Model.sequelize.transaction();

    try {
      let newTranscriberId = null;
      if (newStreamStatus === 'active') {
        newTranscriberId = transcriberId; // Set the transcriberId for the channel
      }

      await Model.Channel.update(
        { streamStatus: newStreamStatus, transcriberId: newTranscriberId },
        { where: { id: channelId }, transaction }
      );

      // Subquery to detect hasActiveStream
      await Model.Session.update(
        {
          status: Model.sequelize.literal(`
            CASE
              WHEN (SELECT COUNT(*)
                    FROM "channels"
                    WHERE "sessionId" = '${sessionId}'
                      AND "streamStatus" = 'active') > 0
                THEN 'active'::enum_sessions_status
              ELSE 'ready'::enum_sessions_status
            END
          `),
          startTime: Model.sequelize.literal(`
            CASE
              WHEN (SELECT COUNT(*)
                    FROM "channels"
                    WHERE "sessionId" = '${sessionId}'
                      AND "streamStatus" = 'active') > 0
                AND "startTime" IS NULL
                THEN NOW()
              ELSE "startTime"
            END
          `)
        },
        { where: { id: sessionId }, transaction }
      );

      await transaction.commit();
      await this.publishSessions();
    } catch (error) {
      await transaction.rollback();
      logger.error(`Error updating session ${sessionId}:`, error);
    }
  }

  async resetSessions() {
    await Model.Channel.update(
      { streamStatus: 'inactive' },
      {
        where: { streamStatus: 'active' },
        include: [{
          model: Model.Session,
          as: 'session',
          where: { status: 'active' }
        }]
      }
    );
    await Model.Session.update(
      { status: 'ready' },
      {
        where: { status: 'active' }
      }
    );
  }

  async publishSessions() {
    const sessions = await Model.Session.findAll({
      attributes: ['id', 'status', 'scheduleOn', 'endOn', 'autoStart', 'autoEnd'],
      where: { status: ['active', 'ready'] },
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          attributes: ['id', 'translations', 'streamEndpoints', 'streamStatus', 'diarization', 'keepAudio', 'async'],
          include: [{
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriberProfile' // Use the correct alias as defined in your association
          }]
        }
      ]
    });
    logger.debug('Publishing all ACTIVE and READY sessions on broker: ', sessions.length);
    // Publish the sessions to the broker
    this.client.publish('system/out/sessions/statuses', sessions, 1, true, true);
  }

}

module.exports = app => new BrokerClient(app);
