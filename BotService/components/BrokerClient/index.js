const { Component, MqttClient, logger } = require('live-srt-lib');
const WebSocket = require('ws');
const Bot = require('../../bot');
const { v4: uuidv4 } = require('uuid');

class BrokerClient extends Component {
  constructor(app) {
    super(app);
    this.id = this.constructor.name;
    this.uniqueId = `botservice-${uuidv4()}`;
    this.pub = `botservice/out/${this.uniqueId}`;
    this.subs = ['botservice/in/#', `botservice-${this.uniqueId}/in/#`];
    this.bots = new Map();
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true });
    this.lastPublishedBotCount = -1; // Track last published count to avoid spam
    this.init();
  }

  init() {
    this.client.on('ready', () => {
      // Publish initial status with bot count as additional payload
      this.client.publishStatus({ activeBots: this.bots.size });
      this.lastPublishedBotCount = this.bots.size;
      logger.info(`BotService ${this.uniqueId} ready with ${this.bots.size} active bots`);
    });

    this.client.on('message', (topic, message) => {
      const parts = topic.split('/');
      const direction = parts[1];
      const action = parts[2];

      if (direction !== 'in') return;
      try {
        const data = JSON.parse(message.toString());
        if (action === 'startbot') {
          logger.info(`Starting bot for session ${data.session.id}, channel ${data.channel.id}`);
          this.startBot(data).catch(err => logger.error('startBot error', err));
        } else if (action === 'stopbot') {
          logger.info(`Stopping bot for session ${data.sessionId}, channel ${data.channelId}`);
          this.stopBot(data.sessionId, data.channelId).catch(err => logger.error('stopBot error', err));
        }
      } catch (e) {
        logger.error('Invalid message', e);
      }
    });
  }

  publishBotServiceStatus() {
    const currentBotCount = this.bots.size;
    
    // Only publish if bot count changed
    if (currentBotCount === this.lastPublishedBotCount) {
      return;
    }
    
    // Use the standard publishStatus method which includes LWT
    this.client.publishStatus({ activeBots: currentBotCount });
    logger.info(`BotService ${this.uniqueId} now has ${currentBotCount} active bots`);
    this.lastPublishedBotCount = currentBotCount;
  }

  async startBot({ session, channel, address, botType, enableDisplaySub, websocketUrl }) {
    const key = `${session.id}_${channel.id}`;
    logger.info(`Starting bot with key: ${key} (session: ${session.id}, channel: ${channel.id})`);
    await this.stopBot(session.id, channel.id); // cleanup if existing
    const bot = new Bot(session, channel, address, botType, enableDisplaySub);
    const ws = new WebSocket(websocketUrl);
    
    // Buffer for audio data until WebSocket is ready
    let audioBuffer = [];
    let websocketReady = false;
    
    this.bots.set(key, { bot, ws });
    logger.info(`Bot stored with key: ${key}`);  

    ws.on('open', () => {
      logger.debug(`WebSocket opened for bot ${key}, sending init message`);
      ws.send(JSON.stringify({ type: 'init', encoding: 'webm', sampleRate: 16000 }));
    });

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'ack') {
          logger.debug(`Received ACK from Transcriber for bot ${key}, starting audio stream`);
          websocketReady = true;
          
          // Send buffered audio data
          if (audioBuffer.length > 0) {
            logger.debug(`Sending ${audioBuffer.length} buffered audio chunks for bot ${key}`);
            audioBuffer.forEach(buffer => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(buffer);
              }
            });
            audioBuffer = []; // Clear buffer
          }
        } else {
          logger.debug(`Received message from Transcriber for bot ${key}:`, msg);
        }
      } catch (e) {
        logger.error(`Error parsing WebSocket message for bot ${key}:`, e);
      }
    });

    ws.on('close', () => this.stopBot(session.id, channel.id));
    ws.on('error', err => {
      logger.error('WebSocket error', err);
      this.stopBot(session.id, channel.id);
    });

    bot.on('data', (buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (websocketReady) {
          // WebSocket is ready, send audio directly
          ws.send(buffer);
        } else {
          // Buffer audio until we receive ACK
          audioBuffer.push(buffer);
          if (audioBuffer.length === 1) {
            logger.debug(`Buffering audio for bot ${key} until ACK received`);
          }
        }
      }
    });
    bot.on('session-end', () => this.stopBot(session.id, channel.id));

    const ok = await bot.init();
    if (!ok) {
      await this.stopBot(session.id, channel.id);
    } else {
      this.publishBotServiceStatus(); // Publication on bot start
    }
  }

  async stopBot(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`;
    logger.info(`BotService ${this.uniqueId} attempting to stop bot ${key}`);
    logger.info(`Current active bots: ${JSON.stringify([...this.bots.keys()])}`);
    
    const record = this.bots.get(key);
    if (!record) {
      logger.info(`No bot found for key ${key}, ignoring stop request`);
      return;
    }
    
    logger.info(`Stopping bot ${key} - closing WebSocket and disposing bot`);
    if (record.ws) {
      try { record.ws.close(); } catch (e) {}
    }
    if (record.bot) {
      try { await record.bot.dispose(); } catch (e) {}
    }
    this.bots.delete(key);
    this.publishBotServiceStatus(); // Publication on bot stop
    logger.info(`Bot ${key} stopped successfully`);
  }

  destroy() {
    // Stop all bots
    for (const [key] of this.bots) {
      const [sessionId, channelId] = key.split('_');
      this.stopBot(sessionId, channelId);
    }
  }
}

module.exports = app => new BrokerClient(app);
