const { MqttClient, Component, Model, logger, Utils } = require('live-srt-lib')

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
    this.subs = [`transcriber/out/+/status`, `transcriber/out/+/+/final`, `transcriber/out/+/+/final/translations`, `transcriber/out/+/session`, `botservice/out/+/status`, `scheduler/in/#`, `translator/out/+/status`]
    this.state = CONNECTING;
    this.timeoutId = null
    this.emit("connecting");
    this.transcribers = new Array(); // internal scheduler representation of system transcribers.
    this.botservices = new Map(); // internal scheduler representation of available BotServices
    //Note specific retain status for last will and testament cause we wanna ALWAYS know when scheduler is offline
    //Scheduler online status is required for other components to publish their status, ensuing synchronization of the system
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true });
    this.client.on("ready", async () => {
      this.state = READY
      this.client.publishStatus(); // scheduler status (online)
      await this.resetSessions(); // reset all active sessions / channels (streamStatus) to ready/inactive state
      await Model.Translator.update({ online: false }, { where: {} }); // mark all translators offline on startup
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
            [Model.Op.lte]: new Date()
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
    try {
      // Select the BotService with the least active bots
      const selectedBotService = this.selectBotService();
      
      if (!selectedBotService) {
        logger.error('No BotService available to start bot.');
        return;
      }

      // Retrieve bot data
      const botData = await this.getStartBotData(botId);
      
      // Forward the start command to the selected BotService
      this.client.publish(`botservice-${selectedBotService.uniqueId}/in/startbot`, botData, 2, false, true);
      logger.debug(`Bot scheduled via BotService ${selectedBotService.uniqueId} for session ${botData.session.id}, channel ${botData.channel.id}`);
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

    // Select the optimal Transcriber for this bot
    const selectedTranscriber = await this.selectTranscriber();
    if (!selectedTranscriber) {
      throw new Error('No Transcriber available for bot');
    }

    const channel = session.channels[0];
    // Calculate the channel index using the same logic as setChannelsEndpoints and streaming servers
    const channelIndex = Utils.getChannelIndex(session.channels, channel.id);
    const websocketUrl = `ws://${selectedTranscriber.hostname}:${process.env.STREAMING_WS_TCP_PORT || 8890}/${process.env.STREAMING_WS_ENDPOINT || 'transcriber-ws'}/${session.id},${channelIndex}`;

    return {
      session, 
      channel, 
      address: bot.url,
      botType: bot.provider,
      enableDisplaySub: bot.enableDisplaySub, 
      subSource: bot.subSource,
      websocketUrl
    }
  }

  async stopBot(botId) {
    // forward the stop command to the botservice
    try {
      logger.debug(`Stopping bot ${botId}`)
      const bot = await Model.Bot.findByPk(botId, {include: Model.Channel});
      
      if (!bot) {
        logger.error(`Bot ${botId} not found in database`);
        return;
      }
      
      logger.debug(`Found bot ${botId}: url=${bot.url}, provider=${bot.provider}, channelId=${bot.channelId}`);
      
      const channel = bot.channel;
      if (!channel) {
        logger.error(`Channel not found for bot ${botId}`);
        return;
      }
      
      logger.debug(`Bot ${botId} channel: id=${channel.id}, sessionId=${channel.sessionId}`);
      logger.debug(`Sending stopbot command with sessionId=${channel.sessionId}, channelId=${channel.id}`);

      await Model.Bot.destroy({
        where: {id: bot.id}
      });

      this.client.publish('botservice/in/stopbot', { sessionId: channel.sessionId, channelId: channel.id }, 2, false, true);
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

  // ###### TRANSLATIONS ######

  async saveTranslation(translation, sessionId, channelId) {
    try {
      const newTranslation = JSON.stringify([translation]);
      await Model.Channel.update(
        {
          translatedCaptions: Model.sequelize.literal(
            `COALESCE("translatedCaptions"::jsonb, '[]'::jsonb) || ${Model.sequelize.escape(newTranslation)}::jsonb`
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
        `${new Date().toISOString()} [TRANSLATION_SAVE_ERROR]: ${err.message}`,
        JSON.stringify(translation)
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

  // ###### TRANSLATOR STATUS ######

  async registerTranslator(translator) {
    await Model.Translator.upsert({
      name: translator.name,
      languages: translator.languages,
      online: true
    });
    logger.debug(`Translator ${translator.name} registered (${translator.languages.length} languages)`);
  }

  async unregisterTranslator(translator) {
    await Model.Translator.update(
      { online: false, languages: [] },
      { where: { name: translator.name } }
    );
    logger.debug(`Translator ${translator.name} offline`);
  }

  // Handle BotService status updates
  async updateBotServiceStatus(botServiceStatus) {
    const { uniqueId, activeBots, timestamp } = botServiceStatus;

    const previousService = this.botservices.get(uniqueId);
    const isNewService = !previousService;
    const botCountChanged = previousService && previousService.activeBots !== activeBots;

    // Update or add the BotService in our map
    this.botservices.set(uniqueId, {
      uniqueId,
      activeBots,
      timestamp,
      lastSeen: Date.now()
    });

    // Clean up stale BotServices (not seen for more than 30 seconds)
    const staleTimeout = 30000;
    for (const [id, service] of this.botservices.entries()) {
      if (Date.now() - service.lastSeen > staleTimeout) {
        this.botservices.delete(id);
        logger.info(`BotService ${id} disconnected (stale)`);
      }
    }

    // Log only meaningful changes
    if (isNewService) {
      logger.info(`BotService ${uniqueId} connected with ${activeBots} active bots`);
    } else if (botCountChanged) {
      logger.info(`BotService ${uniqueId} now has ${activeBots} active bots`);
    }
  }

  // Select the BotService with the least active bots
  selectBotService() {
    if (this.botservices.size === 0) {
      return null;
    }

    let selectedService = null;
    let minActiveBots = Infinity;

    for (const service of this.botservices.values()) {
      if (service.activeBots < minActiveBots) {
        minActiveBots = service.activeBots;
        selectedService = service;
      }
    }

    return selectedService;
  }

  // Select the Transcriber with the least active channels
  async selectTranscriber() {
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

      return chosenTranscriber;
    } catch (error) {
      logger.error('Failed to select transcriber:', error);
      return null;
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

      const escapedSessionId = Model.sequelize.escape(sessionId);

      // Subquery to detect hasActiveStream
      await Model.Session.update(
        {
          status: Model.sequelize.literal(`
            CASE
              WHEN "status" = 'terminated' THEN "status"
              WHEN (SELECT COUNT(*)
                    FROM "channels"
                    WHERE "sessionId" = ${escapedSessionId}
                      AND "streamStatus" = 'active') > 0
                THEN 'active'::enum_sessions_status
              ELSE 'ready'::enum_sessions_status
            END
          `),
          startTime: Model.sequelize.literal(`
            CASE
              WHEN (SELECT COUNT(*)
                    FROM "channels"
                    WHERE "sessionId" = ${escapedSessionId}
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
      attributes: ['id', 'status', 'scheduleOn', 'endOn', 'autoStart', 'autoEnd', 'name'],
      where: { status: ['active', 'ready'] },
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          attributes: ['id', 'translations', 'streamEndpoints', 'streamStatus', 'diarization', 'keepAudio', 'compressAudio', 'enableLiveTranscripts'],
          include: [{
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriberProfile' // Use the correct alias as defined in your association
          }]
        }
      ]
    });
    logger.debug(`Publishing ${sessions.length} ACTIVE and READY sessions on broker`);
    
    // Log session details for debugging
    sessions.forEach(session => {
      const channelIds = session.channels.map(c => c.id);
      logger.debug(`Session ${session.id} (status: ${session.status}) has channels: [${channelIds.join(', ')}]`);
    });
    
    // Publish the sessions to the broker
    this.client.publish('system/out/sessions/statuses', sessions, 1, true, true);
  }

}

module.exports = app => new BrokerClient(app);
