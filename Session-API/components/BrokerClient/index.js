const debug = require('debug')(`session-api:BrokerClient`);
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
      attributes: ['id', 'status', 'startTime', 'endTime'],
      where: { status: ['active', 'ready'] },
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          attributes: ['index', 'translations', 'streamEndpoints', 'streamStatus', 'diarization', 'keepAudio'],
          include: [{
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriberProfile' // Use the correct alias as defined in your association
          }]
        }
      ]
    });
    debug('Session API update --> Publishing non terminated sessions on broker:  2: ', sessions.length);
    this.client.publish('statuses', sessions, 1, true, true);
  }

  /**
   * Initializes and starts a bot for a specific session and channel, publishing its start command to the MQTT broker.
   * This command will get picked up by the sheduler to select and feed a Transcriber/streamingServer instance, which will finally start the bot.
   * 
   * @param {string} sessionId - The UUID of the session for which the bot is started.
   * @param {number} channelIndex - The index of the channel within the session.
   * @param {string} address - The URL address where the bot should operate.
   * @param {string} botType - The type of bot to start. (jitsi... see manifests in Transcriber/streamingServer)
   */
  async scheduleStartBot(sessionId, channelIndex, address, botType) {
    // get the session
    const session = await Model.Session.findOne({
      where: { id: sessionId },
      include: [
        {
          model: Model.Channel,
          as: 'channels',
          where: { index: channelIndex },
          include: [{
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriberProfile' // Use the correct alias as defined in your association
          }]
        }
      ]
    });
    this.client.publish('scheduler/in/schedule/startbot', { session, channelIndex, address, botType }, 1, false, true);
  }

  /**
   * Publishes a stop bot command to the MQTT broker, which will be picked up by the scheduler to stop the bot for a specific session and channel.
   * 
   * @param {string} sessionId - The UUID of the session for which the bot is stopped.
   * @param {number} channelIndex - The index of the channel within the session.
   */
  async scheduleStopBot(sessionId, channelIndex) {
    this.client.publish('scheduler/in/schedule/stopbot', { sessionId, channelIndex }, 1, false, true);
  }
}

module.exports = app => new BrokerClient(app);
