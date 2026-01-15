const { Room, RoomEvent, TrackKind } = require('@livekit/rtc-node');
const { AccessToken } = require('livekit-server-sdk');
const EventEmitter = require('events');
const { logger } = require('live-srt-lib');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;  // S16LE

class LivekitBotInstance extends EventEmitter {
  constructor({ session, channel, roomName, livekitUrl, livekitApiKey, livekitApiSecret, enableDisplaySub }) {
    super();

    this.session = session;
    this.channel = channel;
    this.roomName = roomName;
    this.livekitUrl = livekitUrl;
    this.livekitApiKey = livekitApiKey;
    this.livekitApiSecret = livekitApiSecret;
    this.enableDisplaySub = enableDisplaySub;

    this.room = null;
    this.connected = false;
    this.audioMixer = new Map();  // participantId -> audioBuffer

    // Transcription segment management (partials/finals)
    // Same ID for consecutive partials, new ID after each final
    this.currentSegmentId = null;
  }

  /**
   * Generate unique ID for a new transcription segment
   */
  generateSegmentId() {
    return `seg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async connect() {
    logger.info(`Connecting to LiveKit room: ${this.roomName}`);

    // Generate access token
    const token = await this.generateToken();

    // Create and connect to room
    this.room = new Room();

    // Setup event handlers
    this.setupRoomHandlers();

    // Connect to room
    await this.room.connect(this.livekitUrl, token, {
      autoSubscribe: true
    });

    this.connected = true;
    logger.info(`Connected to LiveKit room: ${this.roomName}`);
  }

  async generateToken() {
    const at = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
      identity: `transcription-bot-${this.session.id}`,
      name: process.env.BOT_DISPLAY_NAME || 'Transcription Bot'
    });

    at.addGrant({
      roomJoin: true,
      room: this.roomName,
      canPublish: this.enableDisplaySub,  // To send data messages
      canPublishData: this.enableDisplaySub,
      canSubscribe: true
    });

    return await at.toJwt();
  }

  setupRoomHandlers() {
    // Participant connected
    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      logger.debug(`Participant connected: ${participant.identity}`);
    });

    // Participant disconnected
    this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      logger.debug(`Participant disconnected: ${participant.identity}`);
      this.audioMixer.delete(participant.sid);
    });

    // Track subscribed (participant audio)
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        logger.debug(`Subscribed to audio track from: ${participant.identity}`);
        this.handleAudioTrack(track, participant);
      }
    });

    // Track unsubscribed
    this.room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        logger.debug(`Unsubscribed from audio track: ${participant.identity}`);
      }
    });

    // Room disconnection
    this.room.on(RoomEvent.Disconnected, (reason) => {
      logger.info(`Disconnected from room: ${reason}`);
      this.connected = false;
      this.emit('disconnected');
    });

    // Reconnecting
    this.room.on(RoomEvent.Reconnecting, () => {
      logger.info('Reconnecting to room...');
    });

    this.room.on(RoomEvent.Reconnected, () => {
      logger.info('Reconnected to room');
    });
  }

  handleAudioTrack(track, participant) {
    // Listen to audio frames from the track
    track.on('audioFrame', (frame) => {
      this.processAudioFrame(frame, participant);
    });
  }

  processAudioFrame(frame, participant) {
    // LiveKit provides audio in PCM format
    // Convert to S16LE 16kHz mono if necessary

    let pcmBuffer;

    // Check format and convert if necessary
    if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== CHANNELS) {
      pcmBuffer = this.resampleAudio(frame);
    } else {
      // Audio already in correct format
      pcmBuffer = Buffer.from(frame.data);
    }

    // Emit audio buffer
    this.emit('audio', pcmBuffer);
  }

  resampleAudio(frame) {
    // Simple conversion if necessary
    // For production, consider using a library like 'audio-resampler'

    const inputSamples = frame.samplesPerChannel;
    const inputData = new Int16Array(frame.data.buffer);

    // If stereo, mix to mono
    let monoData;
    if (frame.channels === 2) {
      monoData = new Int16Array(inputSamples);
      for (let i = 0; i < inputSamples; i++) {
        monoData[i] = Math.floor((inputData[i * 2] + inputData[i * 2 + 1]) / 2);
      }
    } else {
      monoData = inputData;
    }

    // Simple resampling (linear interpolation)
    if (frame.sampleRate !== SAMPLE_RATE) {
      const ratio = SAMPLE_RATE / frame.sampleRate;
      const outputSamples = Math.floor(inputSamples * ratio);
      const outputData = new Int16Array(outputSamples);

      for (let i = 0; i < outputSamples; i++) {
        const srcIndex = i / ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(srcIndexFloor + 1, monoData.length - 1);
        const fraction = srcIndex - srcIndexFloor;

        outputData[i] = Math.floor(
          monoData[srcIndexFloor] * (1 - fraction) +
          monoData[srcIndexCeil] * fraction
        );
      }

      return Buffer.from(outputData.buffer);
    }

    return Buffer.from(monoData.buffer);
  }

  /**
   * Display transcription in the LiveKit room via native publishTranscription API.
   *
   * Partial/Final management:
   * - Consecutive partials use the SAME segment ID
   * - When a final arrives, use the same ID then reset it
   * - Next partial will have a new ID
   *
   * This allows the client (livekit-meet) to:
   * - Update text in real-time for partials (same ID = replacement)
   * - Freeze text when final=true
   * - Start a new sentence with a new ID
   *
   * @param {string} text - Transcription text
   * @param {boolean} isFinal - true if definitive transcription
   * @param {string} language - BCP47 language code (ex: 'fr-FR')
   */
  async displayCaption(text, isFinal, language = 'fr-FR') {
    if (!this.enableDisplaySub || !this.room || !this.connected) {
      return;
    }

    try {
      // If no current ID, create a new one (start of sentence)
      if (!this.currentSegmentId) {
        this.currentSegmentId = this.generateSegmentId();
      }

      // Create transcription segment
      // Same ID for all partials of the same sentence
      const segment = {
        id: this.currentSegmentId,
        text: text,
        final: isFinal,
        startTime: BigInt(Date.now()),
        endTime: BigInt(Date.now() + 1000),
        language: language
      };

      // Publish via native LiveKit Transcription API
      // livekit-meet clients display automatically via useTranscriptions()
      await this.room.localParticipant.publishTranscription({
        segments: [segment],
        participantIdentity: this.room.localParticipant.identity,
        trackSid: ''  // No specific track
      });

      logger.debug(`Transcription published [${isFinal ? 'FINAL' : 'PARTIAL'}] (id=${this.currentSegmentId}): ${text.substring(0, 50)}...`);

      // If it was a final, reset ID for next segment
      // Next partial will start a new sentence with a new ID
      if (isFinal) {
        this.currentSegmentId = null;
      }
    } catch (e) {
      logger.error('Error publishing transcription:', e);
    }
  }

  async disconnect() {
    if (this.room) {
      logger.info(`Disconnecting from room: ${this.roomName}`);
      await this.room.disconnect();
      this.room = null;
    }
    this.connected = false;
  }
}

module.exports = LivekitBotInstance;
