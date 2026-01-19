const { Component, MqttClient, logger } = require('live-srt-lib');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const LivekitBotInstance = require('../../bot');

class BrokerClient extends Component {
  constructor(app) {
    super(app);
    this.id = this.constructor.name;
    this.uniqueId = `livekitbot-${uuidv4()}`;
    this.pub = `botservice/out/${this.uniqueId}`;
    this.subs = [
      'botservice/in/#',
      `botservice-${this.uniqueId}/in/#`
    ];

    this.bots = new Map();  // key: sessionId_channelId, value: { bot, ws }
    this.botSubscriptions = new Map(); // Track subscriptions for each bot
    this.capabilities = ['livekit'];
    this.lastPublishedBotCount = -1;

    this.client = new MqttClient({
      uniqueId: this.uniqueId,
      pub: this.pub,
      subs: this.subs,
      retain: true
    });

    this.init();
  }

  init() {
    this.client.on('ready', () => {
      this.client.publishStatus({
        activeBots: this.bots.size,
        capabilities: this.capabilities
      });
      this.lastPublishedBotCount = this.bots.size;
      logger.info(`LivekitBot ${this.uniqueId} ready with ${this.bots.size} active bots, capabilities: ${this.capabilities.join(', ')}`);

      // Heartbeat every 15 seconds to avoid being marked as stale by the Scheduler
      this.heartbeatInterval = setInterval(() => {
        this.client.publishStatus({
          activeBots: this.bots.size,
          capabilities: this.capabilities
        });
      }, 15000);
    });

    this.client.on('message', (topic, message) => {
      const parts = topic.split('/');

      // Handle transcription messages for captions
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
          this.startBot(data).catch(err => logger.error('startBot error:', err));
        } else if (action === 'stopbot') {
          logger.info(`Stopping bot for session ${data.sessionId}, channel ${data.channelId}`);
          this.stopBot(data.sessionId, data.channelId).catch(err => logger.error('stopBot error:', err));
        }
      } catch (e) {
        logger.error('Invalid message:', e);
      }
    });

    this.client.on('error', (error) => {
      logger.error('MQTT error:', error);
    });
  }

  async startBot({ session, channel, address, botType, enableDisplaySub, subSource, websocketUrl }) {
    const key = `${session.id}_${channel.id}`;
    logger.info(`Starting bot with key: ${key}, subSource: ${subSource || '(none, using original text)'}`);

    // Cleanup if existing
    await this.stopBot(session.id, channel.id);

    // Parse LiveKit configuration from environment
    const livekitUrl = process.env.LIVEKIT_URL;
    const livekitApiKey = process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitMeetUrl = process.env.LIVEKIT_MEET_URL;

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      logger.error('Missing LiveKit configuration (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)');
      return;
    }

    // Check if Meet instance has native subtitles enabled
    // If enabled, we don't need virtual camera for captions
    const meetSubtitleEnabled = await this.checkMeetSubtitleEnabled(livekitMeetUrl);

    // Resolve room name from address (calls API to get LiveKit room UUID)
    const roomName = await this.resolveRoomName(address);

    // Create bot instance
    // Virtual camera is disabled if Meet has native subtitles OR if enableDisplaySub is false
    const bot = new LivekitBotInstance({
      session,
      channel,
      roomName,
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      enableDisplaySub,
      meetSubtitleEnabled,
      subSource
    });

    // Create WebSocket connection to Transcriber
    const ws = new WebSocket(websocketUrl);

    let audioBuffer = [];
    let websocketReady = false;

    this.bots.set(key, { bot, ws });

    // WebSocket handlers
    ws.on('open', () => {
      logger.debug(`WebSocket opened for bot ${key}, sending init message`);
      // Send init message with PCM encoding (native LiveKit audio format)
      ws.send(JSON.stringify({
        type: 'init',
        encoding: 'pcm',
        sampleRate: 16000
      }));
    });

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'ack') {
          logger.debug(`Received ACK from Transcriber for bot ${key}`);
          websocketReady = true;

          // Flush buffered audio
          if (audioBuffer.length > 0) {
            logger.debug(`Sending ${audioBuffer.length} buffered audio chunks`);
            audioBuffer.forEach(buffer => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(buffer);
              }
            });
            audioBuffer = [];
          }
        }
      } catch (e) {
        logger.error(`Error parsing WebSocket message:`, e);
      }
    });

    ws.on('close', () => {
      logger.info(`WebSocket closed for bot ${key}`);
      this.stopBot(session.id, channel.id);
    });

    ws.on('error', (err) => {
      logger.error(`WebSocket error for bot ${key}:`, err);
      this.stopBot(session.id, channel.id);
    });

    // Bot audio handler
    bot.on('audio', (buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (websocketReady) {
          ws.send(buffer);
        } else {
          audioBuffer.push(buffer);
        }
      }
    });

    bot.on('error', (error) => {
      logger.error(`Bot error for ${key}:`, error);
      this.stopBot(session.id, channel.id);
    });

    bot.on('disconnected', () => {
      logger.info(`Bot disconnected for ${key}`);
      this.stopBot(session.id, channel.id);
    });

    // Start the bot
    try {
      await bot.connect();

      // Subscribe to transcriptions for captions
      await this.subscribeToBotTranscriptions(session.id, channel.id);

      this.publishBotServiceStatus();
      logger.info(`Bot started successfully for ${key}`);
    } catch (error) {
      logger.error(`Failed to start bot for ${key}:`, error);
      await this.stopBot(session.id, channel.id);
    }
  }

  async stopBot(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`;
    logger.info(`Stopping bot: ${key}`);

    const record = this.bots.get(key);
    if (!record) {
      logger.debug(`No bot found for key ${key}`);
      return;
    }

    try {
      // Unsubscribe from transcriptions
      await this.unsubscribeFromBotTranscriptions(sessionId, channelId);

      // Close WebSocket
      if (record.ws && record.ws.readyState === WebSocket.OPEN) {
        record.ws.close();
      }

      // Disconnect bot
      if (record.bot) {
        await record.bot.disconnect();
      }
    } catch (e) {
      logger.error(`Error stopping bot ${key}:`, e);
    } finally {
      this.bots.delete(key);
      this.publishBotServiceStatus();
    }
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
      logger.debug(`Subscribed to transcriptions for ${key}`);
    } catch (error) {
      logger.error(`Failed to subscribe to transcriptions for ${key}:`, error);
    }
  }

  async unsubscribeFromBotTranscriptions(sessionId, channelId) {
    const key = `${sessionId}_${channelId}`;
    const topics = this.botSubscriptions.get(key);

    if (topics) {
      try {
        await this.client.unsubscribe(topics);
        this.botSubscriptions.delete(key);
        logger.debug(`Unsubscribed from transcriptions for ${key}`);
      } catch (error) {
        logger.error(`Failed to unsubscribe from transcriptions for ${key}:`, error);
      }
    }
  }

  handleTranscription(topic, message) {
    const parts = topic.split('/');
    const sessionId = parts[2];
    const channelId = parts[3];
    const type = parts[4]; // 'partial' or 'final'

    const key = `${sessionId}_${channelId}`;
    const record = this.bots.get(key);

    if (!record || !record.bot) {
      return;
    }

    try {
      const transcription = JSON.parse(message.toString());
      const isFinal = type === 'final';

      // Select subtitle text based on subSource (translation language)
      // If subSource is set and translation exists, use translation
      // Otherwise, use original transcription text
      const subSource = record.bot.subSource;
      let subtitle = transcription.text;
      if (subSource && transcription.translations && subSource in transcription.translations) {
        subtitle = transcription.translations[subSource];
        logger.debug(`Using translation for '${subSource}': ${subtitle.substring(0, 50)}...`);
      }

      // Display captions in the LiveKit room via publishTranscription()
      // Language is extracted from transcription message or uses channel config
      const language = transcription.lang || record.bot.channel?.languages?.[0] || 'fr-FR';
      record.bot.displayCaption(subtitle, isFinal, language);
    } catch (e) {
      logger.error(`Error handling transcription:`, e);
    }
  }

  publishBotServiceStatus() {
    const currentBotCount = this.bots.size;

    if (currentBotCount === this.lastPublishedBotCount) {
      return;
    }

    this.client.publishStatus({
      activeBots: currentBotCount,
      capabilities: this.capabilities
    });
    logger.info(`LivekitBot ${this.uniqueId} now has ${currentBotCount} active bots`);
    this.lastPublishedBotCount = currentBotCount;
  }

  /**
   * Check if the Meet instance has native subtitles enabled.
   * Calls /api/config/ endpoint to check subtitle.enabled flag.
   *
   * @param {string} meetUrl - Meet instance URL (e.g., https://dev-meet.linagora.com)
   * @returns {Promise<boolean>} - true if subtitles are enabled on the Meet instance
   */
  async checkMeetSubtitleEnabled(meetUrl) {
    if (!meetUrl) {
      logger.debug('No LIVEKIT_MEET_URL configured, assuming subtitles disabled');
      return false;
    }

    try {
      const configUrl = `${meetUrl.replace(/\/$/, '')}/api/config/`;
      logger.debug(`Checking Meet subtitle config: ${configUrl}`);

      const response = await fetch(configUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const config = await response.json();
        const subtitleEnabled = config?.subtitle?.enabled === true;
        logger.info(`Meet instance subtitle support: ${subtitleEnabled ? 'ENABLED' : 'DISABLED'}`);
        return subtitleEnabled;
      } else {
        logger.warn(`Failed to fetch Meet config (HTTP ${response.status}), assuming subtitles disabled`);
        return false;
      }
    } catch (e) {
      logger.warn(`Error checking Meet subtitle config: ${e.message}, assuming subtitles disabled`);
      return false;
    }
  }

  /**
   * Resolve room name from meeting URL.
   * Supports both La Suite Meet (DINUM) and LiveKit Meet (official).
   *
   * - La Suite Meet (DINUM): slug → UUID via /api/v1.0/rooms/{slug}/
   * - LiveKit Meet (official): slug → slug via /api/connection-details?roomName={slug}
   *
   * @param {string} address - Meeting URL (e.g., https://meet.linagora.com/dac-vlev-oeq)
   * @returns {Promise<string>} - LiveKit room name (UUID or slug)
   */
  async resolveRoomName(address) {
    let url;
    let slug;

    try {
      url = new URL(address);
      const pathParts = url.pathname.split('/').filter(p => p);
      slug = pathParts[pathParts.length - 1] || 'default-room';
    } catch (e) {
      logger.warn(`Invalid URL "${address}", using as room name directly`);
      return address;
    }

    const meetHost = `${url.protocol}//${url.host}`;

    // Strategy 1: Try La Suite Meet (DINUM) API
    // Returns UUID as livekit.room
    try {
      const dinumApiUrl = `${meetHost}/api/v1.0/rooms/${slug}/`;
      logger.debug(`Trying La Suite Meet API: ${dinumApiUrl}`);

      const response = await fetch(dinumApiUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.livekit && data.livekit.room) {
          logger.info(`[La Suite Meet] Resolved slug "${slug}" → LiveKit room "${data.livekit.room}"`);
          return data.livekit.room;
        }
      }
    } catch (e) {
      logger.debug(`La Suite Meet API failed: ${e.message}`);
    }

    // Strategy 2: Try LiveKit Meet (official) API
    // Returns slug as roomName (confirms the room exists)
    try {
      const officialApiUrl = `${meetHost}/api/connection-details?roomName=${encodeURIComponent(slug)}`;
      logger.debug(`Trying LiveKit Meet official API: ${officialApiUrl}`);

      const response = await fetch(officialApiUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.roomName) {
          logger.info(`[LiveKit Meet] Using room name: "${data.roomName}"`);
          return data.roomName;
        }
      }
    } catch (e) {
      logger.debug(`LiveKit Meet official API failed: ${e.message}`);
    }

    // Strategy 3: Fallback to slug
    logger.info(`No API responded, using slug directly: "${slug}"`);
    return slug;
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
