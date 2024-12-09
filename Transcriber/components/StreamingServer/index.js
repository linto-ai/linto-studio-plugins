const debug = require('debug')(`transcriber:StreamingServer`);
const { Component, CustomErrors } = require("live-srt-lib");
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

      server.on('session-start', (session, channelId) => {
        try {
          const asr = new ASR(session, channelId);
          asr.on('partial', (transcription) => {
            this.emit('partial', transcription, session.id, channelId);
          });
          asr.on('final', (transcription) => {
            this.emit('final', transcription, session.id, channelId);
          });
          this.ASRs.set(`${session.id}_${channelId}`, asr);
          this.emit('session-start', session, channelId);
          debug(`Session ${session.id}, channel ${channelId} started`);
        } catch (error) {
          debug(`Error starting session ${session.id}, channel ${channelId}: ${error}`);
        }
      });

      server.on('session-stop', (session, channelId) => {
        try {
          debug(`Session ${session.id}, channel ${channelId} stopped`);
          const asr = this.ASRs.get(`${session.id}_${channelId}`);
          if (!asr) {
            return;
          }

          asr.removeAllListeners();
          asr.dispose();
          this.ASRs.delete(`${session.id}_${channelId}`);
          // pass to controllers/StreamingServer.js to forward to broker and mark the session as "ready"" / set channel status in database
          this.emit('session-stop', session, channelId);
        } catch (error) {
          debug(`Error stopping session ${session.id}, channel ${channelId}: ${error}`);
        }
      });

      server.on('data', (audio, sessionId, channelId) => {
        try {
          const buffer = Buffer.from(audio);
          const asr = this.ASRs.get(`${sessionId}_${channelId}`);
          if (asr) {
            asr.transcribe(buffer);
          } else {
            debug(`No ASR found for session ${sessionId}, channel ${channelId}`);
          }
        } catch (error) {
          debug(`Error processing data for session ${sessionId}, channel ${channelId}: ${error}`);
        }
      });
    } catch (error) {
      debug(`Error initializing ${protocol} server: ${error}`);
    }
  }


  // Create a bot for a channel and store it in the bots map
  async startBot(session, channelId, address, botType) {
    debug(`Starting ${botType} bot for session ${session.id}, channel ${channelId}`);
    try {
      const bot = new Bot(session, channelId, address, botType);
      bot.session = session;
      // Bot events
      bot.on('session-start', (session, channelId) => {
        debug(`Session ${session.id}, channel ${channelId} started`);
        const asr = new ASR(session, channelId);
        asr.on('partial', (transcription) => {
          bot.updateCaptions(transcription.text, false);
          this.emit('partial', transcription, session.id, channelId);
        });
        asr.on('final', (transcription) => {
          bot.updateCaptions(transcription.text, true);
          this.emit('final', transcription, session.id, channelId);
        });
        this.ASRs.set(`${session.id}_${channelId}`, asr);
        // pass to controllers/StreamingServer.js to forward to broker and mark the session as active / set channel status in database
        this.emit('session-start', session, channelId);
        debug(`Session ${session.id}, channel ${channelId} started`);
      })

      bot.on('data', (audio, sessionId, channelId) => {
        const buffer = Buffer.from(audio.data);
        const asr = this.ASRs.get(`${sessionId}_${channelId}`);
        if (asr) {
          asr.transcribe(buffer);
        } else {
          //debug(`No ASR found for session ${message.sessionId}, channel ${message.channelId}`);
        }
      })
      // can return false or true. If false, bot is not started
      await bot.init();
      this.bots.set(`${session.id}_${channelId}`, bot);

    } catch (error) {
      console.error(`Error starting bot: ${error.message}`);
    }
  }

  // Stop a bot for a given session and channel
  async stopBot(sessionId, channelId) {
    debug(`Stopping bot for session ${sessionId}, channel ${channelId}`);
    try {
      const botKey = `${sessionId}_${channelId}`;
      const bot = this.bots.get(botKey);
      this.emit('session-stop', bot.session, channelId);
      if (!bot) {
        debug(`No bot found for session ${sessionId}, channel ${channelId}`);
        return;
      }
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
      debug(`Session ${sessionId}, channel ${channelId} stopped`);
    } catch (error) {
      console.error(`Error stopping bot: ${error.message}`);
    }
  }

  async startServers() {
    for(const server of this.servers) {
      server.start();
    }
  }

  async stopServers() {
    for(const server of this.servers) {
      server.stop();
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
