const debug = require('debug')(`transcriber:StreamingServer`);
const { Component, CustomErrors } = require("live-srt-lib");
const ASR = require('../../ASR');
const MultiplexedSRTServer = require('./srt/SRTServer.js');
const Bot = require('./bot');

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
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  // Launch servers defined in prcess.env STREAMING_PROTOCOLS
  //@TODO: reimplemented SRT. Still need to reimplement other protocols
  async initialize() {
    try {
      this.srtServer = new MultiplexedSRTServer(this.app);
      this.srtServer.on('session-start', (session, channelIndex) => {
        try {
          const asr = new ASR(session, channelIndex);
          this.ASRs.set(`${session.id}_${channelIndex}`, asr);
          this.emit('session-start', session, channelIndex);
          debug(`Session ${session.id}, channel ${channelIndex} started`);
        } catch (error) {
          debug(`Error starting session ${session.id}, channel ${channelIndex}: ${error}`);
        }
      });

      this.srtServer.on('session-stop', (session, channelIndex) => {
        try {
          debug(`Session ${session.id}, channel ${channelIndex} stopped`);
          const asr = this.ASRs.get(`${session.id}_${channelIndex}`);
          asr.dispose();
          this.ASRs.delete(`${session.id}_${channelIndex}`);
          // pass to controllers/StreamingServer.js to forward to broker and mark the session as "ready"" / set channel status in database
          this.emit('session-stop', session, channelIndex);
        } catch (error) {
          debug(`Error stopping session ${session.id}, channel ${channelIndex}: ${error}`);
        }
      });

      this.srtServer.on('data', (audio, sessionId, channelIndex) => {
        try {
          const buffer = Buffer.from(audio.data);
          const asr = this.ASRs.get(`${sessionId}_${channelIndex}`);
          if (asr) {
            asr.transcribe(buffer);
          } else {
            debug(`No ASR found for session ${sessionId}, channel ${channelIndex}`);
          }
        } catch (error) {
          debug(`Error processing data for session ${sessionId}, channel ${channelIndex}: ${error}`);
        }
      });
    } catch (error) {
      debug(`Error initializing SRT server: ${error}`);
    }
  }


  // Create a bot for a channel and store it in the bots map
  async startBot(session, channelIndex, address, botType) {
    debug(`Starting ${botType} bot for session ${session.id}, channel ${channelIndex}`);
    try {
      const bot = new Bot(session, channelIndex, address, botType);
      bot.session = session;
      // Bot events
      bot.on('session-start', (session, channelIndex) => {
        debug(`Session ${session.id}, channel ${channelIndex} started`);
        const asr = new ASR(session, channelIndex);
        this.ASRs.set(`${session.id}_${channelIndex}`, asr);
        // pass to controllers/StreamingServer.js to forward to broker and mark the session as active / set channel status in database
        this.emit('session-start', session, channelIndex);
        debug(`Session ${session.id}, channel ${channelIndex} started`);
      })

      bot.on('data', (audio, sessionId, channelIndex) => {
        const buffer = Buffer.from(audio.data);
        const asr = this.ASRs.get(`${sessionId}_${channelIndex}`);
        if (asr) {
          asr.transcribe(buffer);
        } else {
          //debug(`No ASR found for session ${message.sessionId}, channel ${message.channelIndex}`);
        }
      })
      // can return false or true. If false, bot is not started
      await bot.init();
      this.bots.set(`${session.id}_${channelIndex}`, bot);

    } catch (error) {
      console.error(`Error starting bot: ${error.message}`);
    }
  }

  // Stop a bot for a given session and channel
  async stopBot(sessionId, channelIndex) {
    debug(`Stopping bot for session ${sessionId}, channel ${channelIndex}`);
    try {
      const botKey = `${sessionId}_${channelIndex}`;
      const bot = this.bots.get(botKey);
      this.emit('session-stop', bot.session, channelIndex);
      if (!bot) {
        debug(`No bot found for session ${sessionId}, channel ${channelIndex}`);
        return;
      }
      await bot.dispose();
      this.bots.delete(botKey);

      // Also stop and remove the associated ASR instance if it exists
      const asr = this.ASRs.get(botKey);
      if (asr) {
        asr.dispose();
        this.ASRs.delete(botKey);
      }

      // pass to controllers/StreamingServer.js to forward to broker and mark the session as inactive / set channel status in database
      debug(`Session ${sessionId}, channel ${channelIndex} stopped`);
    } catch (error) {
      console.error(`Error stopping bot: ${error.message}`);
    }
  }

  async startServers() {
    if (!this.srtServer) {
      return
    }
    this.srtServer.start();
  }

  async stopServers() {
    if (!this.srtServer) {
      return
    }
    this.srtServer.stop();
  }

  // called by controllers/BrokerClient.js uppon receiving system/out/sessions/statuses message
  //@TODO: reimplement this method for other protocols
  setSessions(sessions) {
    this.srtServer.setSessions(sessions);
  }

}


module.exports = app => new StreamingServer(app);
