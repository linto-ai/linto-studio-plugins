const { Component, MqttClient, logger } = require('live-srt-lib');
const WebSocket = require('ws');
const Bot = require('../../bot');
const { v4: uuidv4 } = require('uuid');

class BrokerClient extends Component {
  constructor(app) {
    super(app);
    this.id = this.constructor.name;
    this.uniqueId = `botservice-${uuidv4()}`;
    this.pub = 'botservice/out';
    this.subs = ['botservice/in/#', `botservice-${this.uniqueId}/in/#`];
    this.bots = new Map();
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs });
    this.statusInterval = null;
    this.init();
  }

  init() {
    this.client.on('ready', () => {
      this.client.publishStatus();
      this.publishBotServiceStatus();
      
      // Publish status every 10 seconds
      this.statusInterval = setInterval(() => {
        this.publishBotServiceStatus();
      }, 10000);
    });

    this.client.on('message', (topic, message) => {
      const parts = topic.split('/');
      const direction = parts[1];
      const action = parts[2];
      
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

  publishBotServiceStatus() {
    const status = {
      uniqueId: this.uniqueId,
      activeBots: this.bots.size,
      timestamp: Date.now()
    };
    this.client.publish('scheduler/in/botservice/status', status, 1, false, true);
    logger.debug(`Published BotService status: ${this.uniqueId} with ${this.bots.size} active bots`);
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
    } else {
      this.publishBotServiceStatus();
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
    this.publishBotServiceStatus();
  }

  destroy() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }
    // Stop all bots
    for (const [key] of this.bots) {
      const [sessionId, channelId] = key.split('_');
      this.stopBot(sessionId, channelId);
    }
  }
}

module.exports = app => new BrokerClient(app);
