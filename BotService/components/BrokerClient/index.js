const { Component, MqttClient, logger } = require('live-srt-lib');
const WebSocket = require('ws');
const Bot = require('../../bot');

class BrokerClient extends Component {
  constructor(app) {
    super(app);
    this.id = this.constructor.name;
    this.uniqueId = 'botservice';
    this.pub = 'botservice/out';
    this.subs = ['botservice/in/#'];
    this.bots = new Map();
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs });
    this.init();
  }

  init() {
    this.client.on('ready', () => {
      this.client.publishStatus();
    });

    this.client.on('message', (topic, message) => {
      const [, direction, action] = topic.split('/');
      if (direction !== 'in') return;
      try {
        const data = JSON.parse(message.toString());
        if (action === 'startbot') {
          this.startBot(data).catch(err => logger.error('startBot error', err));
        } else if (action === 'stopbot') {
          this.stopBot(data.sessionId, data.channelId).catch(err => logger.error('stopBot error', err));
        }
      } catch (e) {
        logger.error('Invalid message', e);
      }
    });
  }

  async startBot({ session, channel, address, botType, enableDisplaySub }) {
    const key = `${session.id}_${channel.id}`;
    await this.stopBot(session.id, channel.id); // cleanup if existing
    const bot = new Bot(session, channel, address, botType, enableDisplaySub);
    const ws = new WebSocket(channel.streamEndpoints.ws);
    this.bots.set(key, { bot, ws });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'init', encoding: 'pcm', sampleRate: 16000 }));
    });
    ws.on('close', () => this.stopBot(session.id, channel.id));
    ws.on('error', err => {
      logger.error('WebSocket error', err);
      this.stopBot(session.id, channel.id);
    });

    bot.on('data', (buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
      }
    });
    bot.on('session-end', () => this.stopBot(session.id, channel.id));

    const ok = await bot.init();
    if (!ok) {
      await this.stopBot(session.id, channel.id);
    }
  }

  async stopBot(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`;
    const record = this.bots.get(key);
    if (!record) return;
    if (record.ws) {
      try { record.ws.close(); } catch (e) {}
    }
    if (record.bot) {
      try { await record.bot.dispose(); } catch (e) {}
    }
    this.bots.delete(key);
  }
}

module.exports = app => new BrokerClient(app);
