const debug = require('debug')(`transcriber:StreamingServer`);
const { AudioConfig, PropertyId, AudioInputStream, SpeechConfig, SpeechRecognizer, ResultReason, AutoDetectSourceLanguageConfig, AutoDetectSourceLanguageResult, SourceLanguageConfig } = require('microsoft-cognitiveservices-speech-sdk');
const { Component, CustomErrors } = require("live-srt-lib");
const MultiplexedSRTServer = require('./srt/SRTServer.js');

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
    this.init().then(async () => {
      // intialize the streaming servers
      this.initialize();
    })
  }

  async initialize() {
    this.srtServer = new MultiplexedSRTServer(this.app)



    this.srtServer.on('session-start', (session, channel) => {
      debug(`Session ${session.id}, channel ${channel} started`);
      //log the full expanded session object to console
      console.log(JSON.stringify(session.channels[0], null, 2));
      this.emit('session-start', session, channel);

      //pick transcriber profile in session.channels where channel "index" key matches channel (which is the channel index here)
      const transcriberProfile = session.channels.find(c => c.index === channel).transcriber_profile;
      // transcriberProfile {
      //   config: {
      //     type: 'microsoft',
      //     name: 'DG SCIC Custom Model EN-FR',
      //     description: 'DG SCIC Custom Model EN-FR',
      //     languages: [ [Object], [Object] ],
      //     region: 'westeurope',
      //     key: '4612cd17f7774661a481205178bb686a'
      //   }
      // }
      debug(`Starting Microsoft ASR with profile ${transcriberProfile.config.name}`);
      // Initialize Speech SDK components here
      this.audioStream = AudioInputStream.createPushStream();
      this.speechConfig = SpeechConfig.fromSubscription(transcriberProfile.config.key, transcriberProfile.config.region);
      this.speechConfig.endpointId = transcriberProfile.config.languages[0]?.endpoint
      this.audioConfig = AudioConfig.fromStreamInput(this.audioStream);
      this.recognizer = new SpeechRecognizer(this.speechConfig, this.audioConfig);

      this.recognizer.recognizing = (s, e) => {
        console.log(`RECOGNIZING: Text=${e.result.text}`);
      };

      this.recognizer.recognized = (s, e) => {
        if (e.result.reason == ResultReason.RecognizedSpeech) {
          console.log(`RECOGNIZED: Text=${e.result.text}`);
        }
      };

      this.recognizer.canceled = (s, e) => {
        debug(`Microsoft ASR canceled: ${e.errorDetails}`);
        const error = MicrosoftTranscriber.ERROR_MAP[e.errorCode]
        this.emit('error', error)
        this.stop()
      };
      this.recognizer.sessionStopped = (s, e) => {
        debug(`Microsoft ASR session stopped: ${e.reason}`);
        this.emit('closed', e.reason);
      };

      this.recognizer.startContinuousRecognitionAsync(() => {
        debug("Microsoft ASR recognition started");
        this.emit('ready');
    });
    })

    this.srtServer.on('session-stop', (session, channel) => {
      debug(`Session ${session.id}, channel ${channel} stopped`);
      // pass to controllers/StreamingServer.js
      this.emit('session-stop', session, channel);
    })

    this.srtServer.on('data', (data) => {
      const buffer = Buffer.from(data.data);
      try {
        this.audioStream.write(buffer);
      } catch (error) {
        debug(`Error writing to audio stream: ${error}`);
      }

    });
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
  setSessions(sessions) {
    this.srtServer.setSessions(sessions);
  }

}


module.exports = app => new StreamingServer(app);
