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
    this.subs = [`transcriber/out/+/status`, `transcriber/out/+/+/final`, `transcriber/out/+/+/final/translations`, `transcriber/out/+/session`, `scheduler/in/#`, `translator/out/+/status`, `botservice/out/+/status`, `botservice/out/+/bot-error`]
    this.state = CONNECTING;
    this.timeoutId = null
    this.emit("connecting");
    this.transcribers = new Array(); // internal scheduler representation of system transcribers.
    this.botservices = new Array(); // registered BotService replicas {uniqueId, online, activeBots, capabilities}
    this.botOwnership = new Map(); // `${sessionId}_${channelId}` -> botservice uniqueId, for targeted stopbot
    // Per-channel persistence chains: serialize caption/translation/status
    // writes so the Postgres commit order matches the MQTT arrival order.
    // The end-of-stream bot marker (published by the Transcriber after its
    // provider flush) and the 'inactive' deactivate (published after the
    // marker) then become true barriers: a reader that sees them committed is
    // guaranteed to see every earlier final of the channel.
    this.channelPersistChains = new Map();
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
    let endedSessionIds = [];

    await Model.sequelize.transaction(async (transaction) => {
      // Fetch sessions about to be auto-ended so we can log per-session context
      // (notably warn for paused sessions) before mutating their status.
      const sessionsToEnd = await Model.Session.findAll({
        where: {
          status: { [Model.Op.in]: ['ready', 'paused'] },
          autoEnd: true,
          endOn: {
            [Model.Op.lt]: new Date()
          }
        },
        attributes: ['id', 'status'],
        transaction
      });

      for (const session of sessionsToEnd) {
        if (session.status === 'paused') {
          logger.warn(`Auto-ending paused session ${session.id} due to endOn expiry`);
        }
      }

      const [updatedCount, updatedSessions] = await Model.Session.update(
        {
          status: 'terminated',
          endTime: new Date()
        },
        {
          where: {
            status: { [Model.Op.in]: ['ready', 'paused'] },
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
        endedSessionIds = sessionIds;
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

    // Publish one terminal notification per auto-ended session so consumers
    // (e.g. studio-api) can react via a load-balanced shared subscription
    // without having to diff the statuses snapshot. The payload is kept
    // intentionally minimal — consumers re-fetch the full session from the
    // Session API when they need the details.
    for (const sessionId of endedSessionIds) {
      try {
        const endedSession = await Model.Session.findByPk(sessionId, {
          attributes: ['id', 'organizationId']
        });
        if (endedSession) {
          this.client.publish(
            'system/out/sessions/ended',
            { id: endedSession.id, organizationId: endedSession.organizationId },
            1,
            false,
            true
          );
        }
      } catch (err) {
        logger.error(`Failed to publish sessions/ended for ${sessionId}: ${err?.message || err}`);
      }
    }

    return isUpdated;
  }

  // ###### BOT ROUTING (to the dedicated BotService) ######

  // Pick a BotService that supports the requested provider, preferring more
  // specialized replicas (fewest advertised capabilities), then the least
  // loaded. Load is primarily activeBots, but ties are broken by reported memory
  // (rss) so a 30-participant Visio replica is preferred-against vs a 1-track
  // Teams replica with the same bot count (T4). Replicas advertising no
  // capabilities (e.g. under memory backpressure, T13) are excluded by the
  // capability filter.
  selectBotService(provider) {
    const candidates = this.botservices.filter(bs =>
      bs.online && Array.isArray(bs.capabilities) && bs.capabilities.includes(provider));
    if (candidates.length === 0) return null;
    const minCaps = Math.min(...candidates.map(bs => bs.capabilities.length));
    const specialists = candidates.filter(bs => bs.capabilities.length === minCaps);
    return specialists.reduce((best, bs) =>
      (best === null || this._botLoadScore(bs) < this._botLoadScore(best)) ? bs : best, null);
  }

  // Composite load score for routing: activeBots dominates, rss (in MB) is a
  // sub-unit tiebreaker so it only matters when bot counts are equal. Missing
  // metrics fall back to 0 (treated as idle), preserving the prior least-loaded
  // behavior for replicas that don't report memory.
  _botLoadScore(bs) {
    const activeBots = bs.activeBots || 0;
    const rssMb = (bs.rss || 0) / (1024 * 1024);
    return activeBots + Math.min(rssMb / 1e6, 0.999);
  }

  // Transcriber WS ingest URL a bot connects to. Any transcriber accepts any
  // session (sessions are broadcast on system/out/sessions/statuses), so we
  // target the transcriber service by name (load-balanced) rather than a
  // specific replica's hostname.
  buildTranscriberWsUrl(sessionId, channelIndex) {
    const host = process.env.STREAMING_WS_BOT_HOST || 'transcriber';
    const port = process.env.STREAMING_WS_TCP_PORT || '8080';
    const endpoint = process.env.STREAMING_WS_ENDPOINT || 'transcriber-ws';
    const proto = (process.env.STREAMING_WS_SECURE && process.env.STREAMING_WS_SECURE !== 'false') ? 'wss' : 'ws';
    return `${proto}://${host}:${port}/${endpoint}/${sessionId},${channelIndex}`;
  }

  async startBot(botId) {
    try {
      const botData = await this.getStartBotData(botId);
      if (!botData) return;
      const botservice = this.selectBotService(botData.botType);
      if (!botservice) {
        logger.error(`No BotService available with capability '${botData.botType}' to start bot ${botId}.`);
        return;
      }
      this.botOwnership.set(`${botData.session.id}_${botData.channel.id}`, botservice.uniqueId);
      // Persist ownership so a stopbot can still be routed (and orphans reaped)
      // after a Scheduler restart, when the in-memory map is gone.
      await Model.Bot.update({ botservice: botservice.uniqueId }, { where: { id: botId } });
      this.client.publish(`botservice/in/${botservice.uniqueId}/startbot`, botData, 2, false, true);
      logger.debug(`Bot ${botId} scheduled on BotService ${botservice.uniqueId} (${botData.botType}) for session ${botData.session.id}, channel ${botData.channel.id}`);
    } catch (error) {
      logger.error('Failed to start bot:', error);
    }
  }

  async getStartBotData(botId) {
    const bot = await Model.Bot.findByPk(botId);
    if (!bot) { logger.error(`Bot ${botId} not found`); return null; }

    // Load the session with ALL its channels (sorted by id) so the channel index
    // matches the Transcriber's stream validation (which sorts channels by id).
    const ownChannel = await Model.Channel.findByPk(bot.channelId);
    if (!ownChannel) { logger.error(`Channel ${bot.channelId} not found for bot ${botId}`); return null; }
    const session = ownChannel.sessionId ? await Model.Session.findByPk(ownChannel.sessionId, {
      include: [{ model: Model.Channel, as: 'channels', include: [Model.TranscriberProfile] }],
      order: [[{ model: Model.Channel, as: 'channels' }, 'id', 'ASC']]
    }) : null;
    if (!session) { logger.error(`Session for bot ${botId} (channel ${bot.channelId}) not found`); return null; }
    const channels = session.channels || [];
    const channelIndex = channels.findIndex(c => c.id === bot.channelId);
    if (channelIndex < 0) { logger.error(`Channel ${bot.channelId} not in session ${session.id} for bot ${botId}`); return null; }
    const channel = channels[channelIndex];

    return {
      session,
      channel,
      address: bot.url,
      botType: bot.provider,
      enableDisplaySub: bot.enableDisplaySub,
      subSource: bot.subSource,
      botId: bot.id,
      websocketUrl: this.buildTranscriberWsUrl(session.id, channelIndex)
    };
  }

  async stopBot(botId) {
    try {
      logger.debug(`Stopping bot ${botId}`);
      const bot = await Model.Bot.findByPk(botId, { include: Model.Channel });
      if (!bot) { logger.error(`Bot ${botId} not found`); return; }
      const channel = bot.channel;

      await Model.Bot.destroy({ where: { id: bot.id } });

      if (!channel) {
        logger.warn(`Bot ${botId} had no channel; nothing to route`);
        return;
      }
      const key = `${channel.sessionId}_${channel.id}`;
      // Prefer the in-memory map; fall back to the persisted owner so a stop
      // survives a Scheduler restart that lost the map.
      const owner = this.botOwnership.get(key) || bot.botservice;
      this.botOwnership.delete(key);
      if (owner) {
        this.client.publish(`botservice/in/${owner}/stopbot`, { sessionId: channel.sessionId, channelId: channel.id }, 2, false, true);
      } else {
        logger.warn(`No BotService owner tracked for ${key}; stop not routed (bot may have already left)`);
      }
    } catch (error) {
      logger.error('Failed to stop bot:', error);
    }
  }

  // ###### BOTSERVICE STATUS ######

  // T10: a bot failed fatally on a BotService (page crash, join timeout, manifest
  // load failure, browser disconnect). Record the reason on the Bot row IF the
  // model has an error_reason column; otherwise just log + emit (no migration
  // added here). Always re-emit on system/out so consumers can react.
  async recordBotError(botId, reason) {
    if (botId === undefined || botId === null) return;
    reason = reason || 'unknown';
    logger.warn(`Bot ${botId} failed fatally on BotService: ${reason}`);
    // Only attempt a persisted write when the column actually exists, so we don't
    // throw on installations without the (intentionally not-added) migration.
    const hasErrorReasonColumn = !!(Model.Bot.rawAttributes && Model.Bot.rawAttributes.error_reason);
    if (hasErrorReasonColumn) {
      try {
        await Model.Bot.update({ error_reason: reason }, { where: { id: botId } });
      } catch (error) {
        logger.error(`Failed to record bot error for ${botId}: ${error.message}`);
      }
    }
    this.client.publish('system/out/bots/error', { botId, reason }, 1, false, true);
  }

  registerBotService(botservice) {
    const existing = this.botservices.find(b => b.uniqueId === botservice.uniqueId);
    if (existing) {
      existing.online = true;
      if (botservice.activeBots !== undefined) existing.activeBots = botservice.activeBots;
      if (botservice.capabilities !== undefined) existing.capabilities = botservice.capabilities;
      // T4: track reported memory/load so routing can weight by it.
      if (botservice.rss !== undefined) existing.rss = botservice.rss;
      if (botservice.heapUsed !== undefined) existing.heapUsed = botservice.heapUsed;
      if (botservice.metrics !== undefined) existing.metrics = botservice.metrics;
      return;
    }
    this.botservices.push({
      uniqueId: botservice.uniqueId,
      online: true,
      activeBots: botservice.activeBots || 0,
      capabilities: botservice.capabilities || [],
      rss: botservice.rss || 0,
      heapUsed: botservice.heapUsed || 0,
      metrics: botservice.metrics || null
    });
    logger.debug(`BotService ${botservice.uniqueId} UP (capabilities: ${(botservice.capabilities || []).join(', ')})`);
  }

  async unregisterBotService(botservice) {
    this.botservices = this.botservices.filter(b => b.uniqueId !== botservice.uniqueId);
    for (const [key, owner] of this.botOwnership) {
      if (owner === botservice.uniqueId) this.botOwnership.delete(key);
    }
    // The replica is gone: its bots died with it. Reap their now-orphaned rows so
    // they don't linger (the channels deactivate via the Transcriber WS close).
    try {
      const reaped = await Model.Bot.destroy({ where: { botservice: botservice.uniqueId } });
      if (reaped) logger.debug(`BotService ${botservice.uniqueId} DOWN — reaped ${reaped} orphaned bot row(s)`);
      else logger.debug(`BotService ${botservice.uniqueId} DOWN`);
    } catch (error) {
      logger.error(`Error reaping bots for ${botservice.uniqueId}: ${error.message}`);
    }
  }

  // Append a persistence task to the channel's serialized chain. The
  // .catch(() => {}) guards keep one failed write from breaking the chain —
  // saveTranscription/saveTranslation/updateSession already log their own
  // errors. The map entry is pruned once the chain settles and is still the
  // tail, so the map stays bounded.
  chainChannelPersist(sessionId, channelId, fn) {
    const key = `${sessionId}_${channelId}`;
    const next = (this.channelPersistChains.get(key) || Promise.resolve())
      .catch(() => {})
      .then(fn)
      .catch(() => {});
    this.channelPersistChains.set(key, next);
    next.then(() => {
      if (this.channelPersistChains.get(key) === next) {
        this.channelPersistChains.delete(key);
      }
    });
    return next;
  }

  // ###### TRANSCRIPTION ######

  async saveTranscription(transcription, sessionId, channelId) {
    try {
      const captionData = {
        channelId: channelId,
        segmentId: transcription.segmentId,
        start: transcription.start,
        end: transcription.end,
        text: transcription.text,
        astart: transcription.astart,
        aend: transcription.aend,
        lang: transcription.lang,
        locutor: transcription.locutor,
      };
      if (transcription.segmentId !== undefined) {
        await Model.sequelize.transaction(async (transaction) => {
          await Model.Caption.create(captionData, { transaction });
          await Model.Channel.update(
            { lastSegmentId: Model.sequelize.literal(
                `GREATEST(COALESCE("lastSegmentId", 0), ${parseInt(transcription.segmentId, 10) || 0})`
              )
            },
            { where: { sessionId, id: channelId }, transaction }
          );
        });
      } else {
        await Model.Caption.create(captionData);
      }
    } catch (err) {
      logger.error(`[TRANSCRIPTION_SAVE_ERROR]: ${err.message}`, JSON.stringify(transcription));
    }
  }

  // ###### TRANSLATIONS ######

  async saveTranslation(translation, sessionId, channelId) {
    try {
      await Model.TranslatedCaption.create({
        channelId: channelId,
        segmentId: translation.segmentId,
        targetLang: translation.targetLang,
        text: translation.text,
      });
    } catch (err) {
      logger.error(`[TRANSLATION_SAVE_ERROR]: ${err.message}`, JSON.stringify(translation));
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
          if (session.status === 'paused') {
            logger.warn(`Paused session ${session.id} downgraded to 'ready': transcriber ${transcriber.uniqueId} disconnected`);
            // pausedAt only has meaning while status='paused'; clear it on
            // downgrade so REST consumers don't see the ambiguous combination
            // (status='ready', pausedAt=<date>).
            session.pausedAt = null;
          }
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

  async updateSession(transcriberId, sessionId, channelId, newStreamStatus) {
    logger.debug(`Updating session activity: ${sessionId} --> channel id: ${channelId} streamStatus ${newStreamStatus}`);
    const transaction = await Model.sequelize.transaction();

    try {
      let newTranscriberId = null;
      if (newStreamStatus === 'active') {
        newTranscriberId = transcriberId;
      }

      const whereClause = { id: channelId };
      // Only deactivate if the requesting transcriber still owns this channel.
      // Prevents a stale deactivation from a former transcriber from overriding
      // a new activation by a different transcriber (race condition on reconnection).
      if (newStreamStatus === 'inactive') {
        whereClause.transcriberId = transcriberId;
      }

      await Model.Channel.update(
        { streamStatus: newStreamStatus, transcriberId: newTranscriberId },
        { where: whereClause, transaction }
      );

      const escapedSessionId = Model.sequelize.escape(sessionId);

      // Subquery to detect hasActiveStream
      await Model.Session.update(
        {
          status: Model.sequelize.literal(`
            CASE
              WHEN "status" = 'paused' THEN "status"
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
    // Note: paused sessions intentionally preserved across scheduler restart
    await Model.Session.update(
      { status: 'ready' },
      {
        where: { status: 'active' }
      }
    );
  }

  async publishSessions() {
    const sessions = await Model.Session.findAll({
      attributes: ['id', 'status', 'scheduleOn', 'endOn', 'autoStart', 'autoEnd', 'name', 'organizationId', 'visibility'],
      where: { status: ['active', 'ready', 'paused'] },
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          attributes: ['id', 'translations', 'streamEndpoints', 'streamStatus', 'diarization', 'keepAudio', 'compressAudio', 'enableLiveTranscripts', 'lastSegmentId'],
          include: [{
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriberProfile' // Use the correct alias as defined in your association
          }]
        }
      ],
      order: [[Model.Channel, 'id', 'ASC']]
    });
    logger.debug('Publishing all ACTIVE, READY and PAUSED sessions on broker: ', sessions.length);
    // Publish the sessions to the broker
    this.client.publish('system/out/sessions/statuses', sessions, 1, true, true);
  }

}

module.exports = app => new BrokerClient(app);
