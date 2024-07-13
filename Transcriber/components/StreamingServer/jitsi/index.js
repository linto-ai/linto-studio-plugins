const debug = require('debug')(`transcriber:JitsiBot`);
const { chromium } = require('playwright');
const EventEmitter = require('events');
const { Buffer } = require('buffer');

class JitsiBot extends EventEmitter {
  constructor(session, channelIndex, address) {
    super();
    this.session = session;
    this.channelIndex = channelIndex;
    this.address = address;
    this.browser = null;
    this.page = null;
    debug('JitsiBot instance created');
  }

  async init() {
    debug('Initializing JitsiBot...');
    this.browser = await chromium.launch({ headless: false });
    debug('Browser launched');

    const context = await this.browser.newContext({
      permissions: ['microphone', 'camera'],
    });
    debug('Browser context created with microphone permissions');

    this.page = await context.newPage();
    this.page.on('console', msg => {
      if (msg.type() === 'log') {
        debug(`PAGE LOG: ${msg.text()}`);
      }
    });
    debug(`Navigating to ${this.address}`);

    await this.page.goto(this.address);
    debug('Page loaded');

    await this.page.waitForSelector('input.css-hh0z88-input');
    await this.page.fill('input.css-hh0z88-input', 'LinTO Bot');
    debug('Name input filled');

    await this.page.waitForSelector('div.css-1hbmoh1-actionButton.primary');
    await this.page.click('div.css-1hbmoh1-actionButton.primary');
    debug('Join button clicked');

    await this.page.waitForTimeout(5000);
    debug('Setup complete');

    this.emit('session-start', this.session, this.channelIndex);
    debug('Session start event emitted');

    await this.page.exposeFunction('sendAudioBuffer', (buffer) => {
      const base64String = Buffer.from(buffer).toString('base64');
      debug('Audio buffer received', base64String.length);
      if (base64String.length > 0) {
        this.emit('data', base64String, this.session.id, this.channelIndex);
      } else {
        debug('Received empty or zero audio buffer');
      }
    });
    debug('Audio recording started');

    await this.page.evaluate(async () => {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioDest = audioCtx.createMediaStreamDestination();

      const processAudio = (stream) => {
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(audioDest);

        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          const inputBuffer = event.inputBuffer.getChannelData(0);
          const int8Array = new Int8Array(inputBuffer.length);
          for (let i = 0; i < inputBuffer.length; i++) {
            int8Array[i] = inputBuffer[i] * 127; // Scale to 8-bit PCM
          }
          if (int8Array.some(val => val !== 0)) {
            console.log('Sending non-empty audio buffer with length:', int8Array.length);
            window.sendAudioBuffer(int8Array.buffer);
          } else {
            console.log('Empty audio buffer, not sending');
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      const interceptWebRTC = () => {
        const origAddTrack = RTCPeerConnection.prototype.addTrack;
        RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
          if (track.kind === 'audio') {
            console.log('Audio track added:', track);
            processAudio(new MediaStream([track]));
          }
          return origAddTrack.apply(this, [track, ...streams]);
        };

        const origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
        RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
          if (trackOrKind === 'audio' || (typeof trackOrKind === 'object' && trackOrKind.kind === 'audio')) {
            const transceiver = origAddTransceiver.apply(this, arguments);
            console.log('Audio transceiver added:', transceiver.receiver.track);
            processAudio(new MediaStream([transceiver.receiver.track]));
            return transceiver;
          }
          return origAddTransceiver.apply(this, arguments);
        };
      };

      interceptWebRTC();

      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        console.log('User media stream obtained:', stream);
        processAudio(stream);
      }).catch((err) => {
        console.error('Failed to get user media:', err);
      });
    });
    debug('Audio processing setup complete');
  }

  async dispose() {
    if (this.browser) {
      await this.browser.close();
      debug('Browser closed');
    }
  }
}

module.exports = JitsiBot;
