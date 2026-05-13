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
    this.state = CONNECTING;
    this.pub = `system/out/sessions`;
    this.subs = [`system/in/sessions/#`]

    this.state = CONNECTING;
    this.client = new MqttClient({ pub: this.pub, subs: this.subs, retain: false, uniqueId: 'session-api' });
    this.client.on("ready", async () => {
      this.state = READY

      this.client.publishStatus(); // session-api status
    });
    this.client.on("error", (err) => {
      this.state = ERROR;
    });
    this.init(); // binds controllers, those will handle messages
  }

  async publishSessions() {
    const sessions = await Model.Session.findAll({
      attributes: ['id', 'status', 'scheduleOn', 'endOn', 'autoStart', 'autoEnd', 'name'],
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
      ]
    });
    logger.debug('Session API update --> Publishing non terminated sessions on broker:  2: ', sessions.length);
    this.client.publish('statuses', sessions, 1, true, true);
  }

  /**
   * Initializes and starts a bot for a specific session and channel, publishing its start command to the MQTT broker.
   * This command will get picked up by the sheduler to select and feed a Transcriber/streamingServer instance, which will finally start the bot.
   *
   * @param {number} botId - The id of the bot to start.
   */
  async scheduleStartBot(botId) {
    this.client.publish('scheduler/in/schedule/startbot', { botId }, 1, false, true);
  }

  /**
   * Publishes a stop bot command to the MQTT broker, which will be picked up by the scheduler to stop the bot for a specific session and channel.
   * 
   * @param {string} sessionId - The UUID of the session for which the bot is stopped.
   * @param {number} channelId - The id of the channel within the session.
   */
  async scheduleStopBot(botId) {
    this.client.publish('scheduler/in/schedule/stopbot', { botId }, 1, false, true);
  }

  /**
   * Publishes a session lifecycle notification on the broker (e.g. paused, resumed, cleared).
   * Payload defaults to {id, organizationId} — consumers (e.g. studio-api) re-fetch the full
   * session via the Session API when they need the details. Wrapped in try/catch so a broker
   * hiccup never breaks the main HTTP flow that emitted the internal event.
   *
   * @param {string} action - Lifecycle action ('paused', 'resumed', 'cleared'). Used as topic suffix.
   * @param {object} session - Sequelize session instance (must expose id and organizationId).
   * @param {object} [extraPayload] - Additional fields merged into the payload (e.g. channelIds for 'cleared').
   */
  async publishSessionLifecycle(action, session, extraPayload = {}) {
    try {
      this.client.publish(
        `system/out/sessions/${action}`,
        { id: session.id, organizationId: session.organizationId, ...extraPayload },
        1,
        false,
        true
      );
      logger.debug(`Published sessions/${action} for ${session.id}`);
    } catch (err) {
      logger.error(`Failed to publish sessions/${action}: ${err?.message || err}`);
    }
  }

  publishSessionPaused(session) {
    return this.publishSessionLifecycle('paused', session);
  }

  publishSessionResumed(session) {
    return this.publishSessionLifecycle('resumed', session);
  }

  publishSessionCleared(session, channelIds) {
    return this.publishSessionLifecycle('cleared', session, { channelIds });
  }
}

module.exports = app => new BrokerClient(app);
