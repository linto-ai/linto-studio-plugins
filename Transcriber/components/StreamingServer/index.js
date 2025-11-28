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
          const asr = new ASR(session, channel);
          asr.on('partial', (transcription) => {
            this.emit('partial', transcription, session.id, channel.id);
          });
          asr.on('final', (transcription) => {
            this.emit('final', transcription, session.id, channel.id);
          });
          this.ASRs.set(`${session.id}_${channel.id}`, asr);
          this.emit('session-start', session, channel);
          logger.info(`Session ${session.id}, channel ${channel.id} started`);
        } catch (error) {
          logger.error(`Error starting session ${session.id}, channel ${channel.id}: ${error}`);
        }
      });

      server.on('session-stop', (session, channelId) => {
        try {
          logger.info(`Session ${session.id}, channel ${channelId} stopped`);
          const asr = this.ASRs.get(`${session.id}_${channelId}`);
          if (!asr) {
            return;
          }

          // store in a final with the bot the session-stop
          asr.streamStopped();

          // clean asr
          asr.removeAllListeners();
          asr.dispose();
          this.ASRs.delete(`${session.id}_${channelId}`);
          // pass to controllers/StreamingServer.js to forward to broker and mark the session as "ready"" / set channel status in database
          this.emit('session-stop', session, channelId);
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


  // Create a bot for a channel and store it in the bots map
  async startBot(session, channel, address, botType, enableDisplaySub, subSource) {
    logger.info(`Starting ${botType} bot for session ${session.id}, channel ${channel.id}`);
    try {
      const bot = new Bot(session, channel, address, botType, enableDisplaySub);
      bot.session = session;
      // Bot events
      bot.on('session-start', (session, channel) => {
        logger.info(`Session ${session.id}, channel ${channel.id} started`);

        const asr = new ASR(session, channel);
        asr.on('partial', (transcription) => {
          let subtitle = transcription.text;
          if (subSource && transcription.translations && subSource in transcription.translations) {
            subtitle = transcription.translations[subSource];
          }

          if (enableDisplaySub) {
            bot.updateCaptions(subtitle, false);
          }

          this.emit('partial', transcription, session.id, channel.id);
        });
        asr.on('final', (transcription) => {
          let subtitle = transcription.text;
          if (subSource && transcription.translations && subSource in transcription.translations) {
            subtitle = transcription.translations[subSource];
          }

          if (enableDisplaySub) {
            bot.updateCaptions(subtitle, true);
          }

          this.emit('final', transcription, session.id, channel.id);
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
      this.emit('session-stop', bot.session, channelId);
      await bot.dispose();
      this.bots.delete(botKey);

      // Also stop and remove the associated ASR instance if it exists
      const asr = this.ASRs.get(botKey);
      if (asr) {
        asr.removeAllListeners();
        asr.dispose();
        this.ASRs.delete(botKey);
      }

      // pass to controllers/StreamingServer.js to forward to broker and mark the session as inactive / set channel status in database
      logger.info(`Session ${sessionId}, channel ${channelId} stopped`);
    } catch (error) {
      logger.error(`Error stopping bot: ${error.message}`);
    }
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
