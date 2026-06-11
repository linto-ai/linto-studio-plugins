const { Component } = require("live-srt-lib");
const logger = require('../../logger')
const ASR = require('../../ASR');
const MultiplexedSRTServer = require('./srt/SRTServer.js');
const MultiplexedWebsocketServer = require('./websocket/WebsocketServer.js');
const MultiplexedRTMPServer = require('./rtmp/RTMPServer.js');
const Bot = require('./bot');


const SERVER_MAPPING = {
  "SRT": MultiplexedSRTServer,
  "WS": MultiplexedWebsocketServer,
  "RTMP": MultiplexedRTMPServer,
}

class StreamingServer extends Component {
  static states = {
    INITIALIZED: 'initialized',
    READY: 'ready',
    ERROR: 'errored',
    STREAMING: 'streaming',
    CLOSED: 'closed'
  };

  constructor(app) {
    super(app);
    this.id = this.constructor.name; //singleton ID within transcriber app
    this.state = StreamingServer.states.CLOSED;
    this.ASRs = new Map();
    this.bots = new Map();
    this.lastSegmentIds = new Map();
    this.servers = [];
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  // Launch servers defined in prcess.env STREAMING_PROTOCOLS
  //@TODO: reimplemented SRT. Still need to reimplement other protocols
  async initialize() {
    const protocols = process.env.STREAMING_PROTOCOLS.split(',').map(protocol => protocol.trim());
    for (const protocol of protocols) {
      await this.initServer(protocol);
    }
  }

  async initServer(protocol) {
    try {
      const serverClass = SERVER_MAPPING[protocol]
      const server = new serverClass(this.app);
      this.servers.push(server);

      server.on('session-start', (session, channel) => {
        try {
          const initialSegmentId = this.resolveInitialSegmentId(session.id, channel.id, channel);
          const asr = new ASR(session, channel, { initialSegmentId });
          asr.on('partial', (transcription) => {
            this.emit('partial', transcription, session.id, channel.id, channel);
          });
          asr.on('final', (transcription) => {
            this.emit('final', transcription, session.id, channel.id, channel);
          });
          this.ASRs.set(`${session.id}_${channel.id}`, asr);
          this.emit('session-start', session, channel);
          logger.info(`Session ${session.id}, channel ${channel.id} started`);
        } catch (error) {
          logger.error(`Error starting session ${session.id}, channel ${channel.id}: ${error}`);
        }
      });

      server.on('session-stop', async (session, channelId) => {
        try {
          logger.info(`Session ${session.id}, channel ${channelId} stopped`);
          await this._stopAsr(session, channelId);
        } catch (error) {
          logger.error(`Error stopping session ${session.id}, channel ${channelId}: ${error}`);
        }
      });

      server.on('data', (audio, sessionId, channelId) => {
        try {
          const buffer = Buffer.from(audio);
          const asr = this.ASRs.get(`${sessionId}_${channelId}`);
          if (asr) {
            asr.transcribe(buffer);
          } else {
            logger.warn(`No ASR found for session ${sessionId}, channel ${channelId}`);
          }
        } catch (error) {
          logger.error(`Error processing data for session ${sessionId}, channel ${channelId}: ${error}`);
        }
      });
    } catch (error) {
      logger.error(`Error initializing ${protocol} server: ${error}`);
    }
  }


  // Tear down the ASR of a channel so the end-of-stream bot marker is provably
  // the LAST final published for the stream, and the deactivate (streamStatus
  // 'inactive') is published strictly after it:
  //   1. remove the ASR from the map synchronously (double session-stop guard)
  //   2. flush in-flight provider finals with listeners still attached
  //   3. publish the bot end-of-stream marker
  //   4. preserve the segment-id cursor (it now includes the flushed finals)
  //   5. detach listeners and dispose (audio save stays fire-and-forget)
  //   6. emit 'session-stop' -> controllers -> deactivate published last
  // Returns false when no ASR was registered for the channel.
  async _stopAsr(session, channelId) {
    const key = `${session.id}_${channelId}`;
    const asr = this.ASRs.get(key);
    if (!asr) {
      return false;
    }
    this.ASRs.delete(key);
    await asr.flushFinals();
    asr.streamStopped();
    this.preserveSegmentId(session.id, channelId, asr);
    asr.removeAllListeners();
    asr.dispose();
    this.emit('session-stop', session, channelId);
    return true;
  }

  // Create a bot for a channel and store it in the bots map
  async startBot(session, channel, address, botType, enableDisplaySub, subSource) {
    logger.info(`Starting ${botType} bot for session ${session.id}, channel ${channel.id}`);
    try {
      const bot = new Bot(session, channel, address, botType, enableDisplaySub);
      bot.session = session;
      // Bot events
      bot.on('session-start', (session, channel) => {
        logger.info(`Session ${session.id}, channel ${channel.id} started`);

        const initialSegmentId = this.resolveInitialSegmentId(session.id, channel.id, channel);
        const asr = new ASR(session, channel, { initialSegmentId });
        asr.on('partial', (transcription) => {
          let subtitle = transcription.text;
          if (subSource && transcription.translations) {
            subtitle = transcription.translations[subSource];
            if (subtitle === undefined) {
              const shortSource = subSource.split('-')[0];
              const matchingKey = Object.keys(transcription.translations)
                .find(k => k.split('-')[0] === shortSource);
              if (matchingKey) subtitle = transcription.translations[matchingKey];
            }
          }

          if (enableDisplaySub) {
            bot.updateCaptions(subtitle, false);
          }

          this.emit('partial', transcription, session.id, channel.id, channel);
        });
        asr.on('final', (transcription) => {
          let subtitle = transcription.text;
          if (subSource && transcription.translations) {
            subtitle = transcription.translations[subSource];
            if (subtitle === undefined) {
              const shortSource = subSource.split('-')[0];
              const matchingKey = Object.keys(transcription.translations)
                .find(k => k.split('-')[0] === shortSource);
              if (matchingKey) subtitle = transcription.translations[matchingKey];
            }
          }

          if (enableDisplaySub) {
            bot.updateCaptions(subtitle, true);
          }

          this.emit('final', transcription, session.id, channel.id, channel);
        });
        this.ASRs.set(`${session.id}_${channel.id}`, asr);
        // pass to controllers/StreamingServer.js to forward to broker and mark the session as active / set channel status in database
        this.emit('session-start', session, channel);
        logger.info(`Session ${session.id}, channel ${channel.id} started`);
      })

      bot.on('data', (audio, sessionId, channelId) => {
        const buffer = Buffer.from(audio.data);
        const asr = this.ASRs.get(`${sessionId}_${channelId}`);
        if (asr) {
          asr.transcribe(buffer);
        }
      })
      // can return false or true. If false, bot is not started
      await bot.init();
      this.bots.set(`${session.id}_${channel.id}`, bot);

      // Subscribe to external translations for bot subtitles
      if (subSource && enableDisplaySub) {
        const translationTopic = `transcriber/out/${session.id}/${channel.id}/final/translations`
        const mqttClient = this.app.components['BrokerClient']?.client
        if (mqttClient) {
          mqttClient.subscribe(translationTopic)
          const translationHandler = (topic, message) => {
            if (topic !== translationTopic) return
            try {
              const translation = JSON.parse(message.toString())
              if (translation.targetLang === subSource ||
                  translation.targetLang.split('-')[0] === subSource.split('-')[0]) {
                bot.updateCaptions(translation.text, true)
              }
            } catch (err) {
              logger.error(`Error handling bot translation: ${err.message}`)
            }
          }
          mqttClient.on('message', translationHandler)
          // Store handler for cleanup
          bot._translationHandler = translationHandler
          bot._translationTopic = translationTopic
          bot._translationMqttClient = mqttClient
        }
      }

    } catch (error) {
      logger.error(`Error starting bot: ${error.message}`);
    }
  }

  // Stop a bot for a given session and channel
  async stopBot(sessionId, channelId) {
    logger.info(`Stopping bot for session ${sessionId}, channel ${channelId}`);
    try {
      const botKey = `${sessionId}_${channelId}`;
      const bot = this.bots.get(botKey);
      if (!bot) {
        logger.warn(`No bot found for session ${sessionId}, channel ${channelId}`);
        return;
      }
      // Clean up translation subscription
      if (bot._translationHandler && bot._translationTopic) {
        const mqttClient = bot._translationMqttClient
        if (mqttClient) {
          mqttClient.removeListener('message', bot._translationHandler)
          mqttClient.unsubscribe(bot._translationTopic)
        }
      }
      // Flush + stop the associated ASR first so the end-of-stream marker and
      // the deactivate are published in order, then dispose the bot itself.
      const hadAsr = await this._stopAsr(bot.session, channelId);
      if (!hadAsr) {
        this.emit('session-stop', bot.session, channelId);
      }
      await bot.dispose();
      this.bots.delete(botKey);

      // pass to controllers/StreamingServer.js to forward to broker and mark the session as inactive / set channel status in database
      logger.info(`Session ${sessionId}, channel ${channelId} stopped`);
    } catch (error) {
      logger.error(`Error stopping bot: ${error.message}`);
    }
  }

  async _applyToSessionASRs(sessionId, action) {
    const promises = [];
    for (const [key, asr] of this.ASRs) {
      if (key.startsWith(`${sessionId}_`)) {
        promises.push(
          asr[action]().catch(e => logger.error(`Error ${action}ing ASR ${key}: ${e.message}`))
        );
      }
    }
    if (promises.length === 0) {
      logger.debug(`${action}Session(${sessionId}): no active ASR`);
      return;
    }
    await Promise.allSettled(promises);
    const verb = action === 'pause' ? 'Paused' : 'Resumed';
    logger.info(`${verb} ${promises.length} ASR(s) for session ${sessionId}`);
  }

  pauseSession(sessionId) {
    return this._applyToSessionASRs(sessionId, 'pause');
  }

  resumeSession(sessionId) {
    return this._applyToSessionASRs(sessionId, 'resume');
  }

  // Drop cached segment-id cursors for the given channels. The Session-API
  // has just reset channel.lastSegmentId to 0 in the DB; without purging this
  // map, a later ASR restart would resume from a stale in-memory cursor and
  // produce a discontinuous sequence. Any currently-running ASR keeps its
  // own counter and will continue from where it is — that's the best-effort
  // contract documented on the /clear endpoint.
  clearSession(sessionId, channelIds) {
    let purged = 0;
    for (const channelId of channelIds) {
      const key = `${sessionId}_${channelId}`;
      if (this.lastSegmentIds.delete(key)) purged += 1;
    }
    logger.info(`clearSession ${sessionId}: purged ${purged}/${channelIds.length} cached segmentId(s)`);
  }

  resolveInitialSegmentId(sessionId, channelId, channel) {
    const key = `${sessionId}_${channelId}`;
    const memorySegmentId = this.lastSegmentIds.get(key);
    this.lastSegmentIds.delete(key);
    const mqttSegmentId = channel.lastSegmentId;
    return memorySegmentId || (mqttSegmentId ? mqttSegmentId + 1 : 1);
  }

  preserveSegmentId(sessionId, channelId, asr) {
    const key = `${sessionId}_${channelId}`;
    this.lastSegmentIds.set(key, asr.segmentId + 1);
  }

  async startServers() {
    for(const server of this.servers) {
      server.start();
    }
  }

  // called by controllers/BrokerClient.js uppon receiving system/out/sessions/statuses message
  setSessions(sessions) {
    for(const server of this.servers) {
      server.setSessions(sessions);
    }
  }

}


module.exports = app => new StreamingServer(app);
