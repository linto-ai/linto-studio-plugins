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
    this.botSubscriptions = new Map(); // Track subscriptions for each bot
    this.capabilities = ['jitsi', 'bigbluebutton']; // Supported bot providers
    this.client = new MqttClient({ uniqueId: this.uniqueId, pub: this.pub, subs: this.subs, retain: true });
    this.lastPublishedBotCount = -1; // Track last published count to avoid spam
    this.init();
  }

  init() {
    this.client.on('ready', () => {
      // Publish initial status with bot count and capabilities as additional payload
      this.client.publishStatus({ activeBots: this.bots.size, capabilities: this.capabilities });
      this.lastPublishedBotCount = this.bots.size;
      logger.info(`BotService ${this.uniqueId} ready with ${this.bots.size} active bots, capabilities: ${this.capabilities.join(', ')}`);

      // Heartbeat every 15 seconds to avoid being marked as stale by the Scheduler
      this.heartbeatInterval = setInterval(() => {
        this.client.publishStatus({ activeBots: this.bots.size, capabilities: this.capabilities });
      }, 15000);
    });

    this.client.on('message', (topic, message) => {
      const parts = topic.split('/');
      
      // Handle transcription messages
      if (parts[0] === 'transcriber' && parts[1] === 'out') {
        this.handleTranscription(topic, message);
        return;
      }
      
      // Handle bot commands
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

    // Use the standard publishStatus method which includes LWT and capabilities
    this.client.publishStatus({ activeBots: currentBotCount, capabilities: this.capabilities });
    logger.info(`BotService ${this.uniqueId} now has ${currentBotCount} active bots`);
    this.lastPublishedBotCount = currentBotCount;
  }

  async subscribeToBotTranscriptions(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`;
    const topics = [
      `transcriber/out/${sessionId}/${channelId}/partial`,
      `transcriber/out/${sessionId}/${channelId}/final`
    ];
    
    try {
      await this.client.subscribe(topics);
      this.botSubscriptions.set(key, topics);
      logger.debug(`Subscribed to transcriptions for bot ${key}`);
    } catch (error) {
      logger.error(`Failed to subscribe to transcriptions for bot ${key}:`, error);
    }
  }

  async unsubscribeFromBotTranscriptions(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`;
    const topics = this.botSubscriptions.get(key);
    
    if (topics) {
      try {
        await this.client.unsubscribe(topics);
        this.botSubscriptions.delete(key);
        logger.debug(`Unsubscribed from transcriptions for bot ${key}`);
      } catch (error) {
        logger.error(`Failed to unsubscribe from transcriptions for bot ${key}:`, error);
      }
    }
  }

  handleTranscription(topic, message) {
    // Parse: transcriber/out/sessionId/channelId/type
    const parts = topic.split('/');
    const [, , sessionId, channelId, type] = parts;
    
    const key = `${sessionId}_${channelId}`;
    const botRecord = this.bots.get(key);
    
    if (!botRecord) {
      logger.debug(`Received transcription for unknown bot ${key}, ignoring`);
      return;
    }
    
    try {
      const transcription = JSON.parse(message.toString());
      const isPartial = type === 'partial';
      const isFinal = type === 'final';
      
      if (isPartial || isFinal) {
        // Afficher les captions sur le bot
        if (botRecord.bot && typeof botRecord.bot.updateCaptions === 'function') {
          botRecord.bot.updateCaptions(transcription.text, isFinal);
          logger.debug(`Updated captions for bot ${key}: "${transcription.text}" (final: ${isFinal})`);
        } else {
          logger.warn(`Bot ${key} does not support updateCaptions method`);
        }
      }
    } catch (e) {
      logger.error(`Error parsing transcription for bot ${key}:`, e);
    }
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
      // Subscribe to transcriptions after successful bot initialization
      await this.subscribeToBotTranscriptions(session.id, channel.id);
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
    
    // Unsubscribe from transcriptions BEFORE cleaning up the bot
    await this.unsubscribeFromBotTranscriptions(sessionId, channelId);
    
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

  async destroy() {
    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Stop all bots (this will also unsubscribe from transcriptions)
    const stopPromises = [];
    for (const [key] of this.bots) {
      const [sessionId, channelId] = key.split('_');
      stopPromises.push(this.stopBot(sessionId, channelId));
    }
    await Promise.all(stopPromises);
  }
}

module.exports = app => new BrokerClient(app);
