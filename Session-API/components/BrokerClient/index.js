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
      attributes: ['id', 'status'],
      where: { status: ['active', 'ready'] },
      include: [
        {
          model: Model.Channel,
          as: 'channels', // Correct relation name
          attributes: ['translations', 'stream_endpoints', 'stream_status'],
          include: [{ // Correct the alias to match the association definition
            model: Model.TranscriberProfile,
            attributes: ['config'],
            as: 'transcriber_profile' // Use the correct alias as defined in your association
          }]
        }
      ]
    });
    debug('Session API update --> Publishing non terminated sessions on broker:  2: ', sessions.length);
    this.client.publish('statuses', sessions, 1, true, true);
  }
}

module.exports = app => new BrokerClient(app);
