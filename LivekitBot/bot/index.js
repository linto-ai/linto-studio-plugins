const { Room, RoomEvent, TrackKind, AudioStream, VideoSource, LocalVideoTrack, VideoFrame, VideoBufferType, TrackSource } = require('@livekit/rtc-node');
const { AccessToken } = require('livekit-server-sdk');
const EventEmitter = require('events');
const { logger } = require('live-srt-lib');
const { createCanvas } = require('canvas');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;  // S16LE

// Video caption configuration
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
const VIDEO_FPS = 5;  // Low FPS for captions (text doesn't need high refresh)
const FONT_SIZE = 32;
const LINE_HEIGHT = 40;
const PADDING = 20;
const MAX_LINES = 6;  // Maximum lines of captions visible

class LivekitBotInstance extends EventEmitter {
  constructor({ session, channel, roomName, livekitUrl, livekitApiKey, livekitApiSecret, enableDisplaySub, meetSubtitleEnabled, subSource }) {
    super();

    this.session = session;
    this.channel = channel;
    this.roomName = roomName;
    this.livekitUrl = livekitUrl;
    this.livekitApiKey = livekitApiKey;
    this.livekitApiSecret = livekitApiSecret;
    this.enableDisplaySub = enableDisplaySub;
    this.meetSubtitleEnabled = meetSubtitleEnabled;
    // subSource: language code for translation display (e.g., 'fr', 'en')
    // If null/undefined, display original transcription
    this.subSource = subSource;

    // Virtual camera is enabled only if:
    // - enableDisplaySub is true (bot configured to display subtitles)
    // - AND meetSubtitleEnabled is false (Meet instance doesn't have native subtitles)
    this.useVirtualCamera = enableDisplaySub && !meetSubtitleEnabled;

    this.room = null;
    this.connected = false;
    this.audioMixer = new Map();  // participantId -> audioBuffer

    // Transcription segment management (partials/finals)
    // Same ID for consecutive partials, new ID after each final
    this.currentSegmentId = null;

    // Video caption components
    this.videoSource = null;
    this.videoTrack = null;
    this.captionCanvas = null;
    this.captionCtx = null;
    this.captionLines = [];  // Array of caption lines to display
    this.videoFrameInterval = null;
  }

  /**
   * Generate unique ID for a new transcription segment
   */
  generateSegmentId() {
    return `seg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Initialize caption video track with canvas rendering.
   * Only initializes if virtual camera is needed (Meet doesn't have native subtitles).
   */
  async initCaptionVideo() {
    if (!this.useVirtualCamera) {
      if (this.meetSubtitleEnabled) {
        logger.info('Virtual camera disabled: Meet instance has native subtitles enabled');
      } else {
        logger.debug('Caption video disabled (enableDisplaySub=false)');
      }
      return;
    }

    logger.info('Initializing caption video track (Meet has no native subtitles)...');

    // Create canvas for rendering captions
    this.captionCanvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
    this.captionCtx = this.captionCanvas.getContext('2d');

    // Create video source
    this.videoSource = new VideoSource(VIDEO_WIDTH, VIDEO_HEIGHT);

    // Create local video track from source
    this.videoTrack = LocalVideoTrack.createVideoTrack('captions', this.videoSource);

    // Publish the video track
    await this.room.localParticipant.publishTrack(this.videoTrack, {
      name: 'Captions',
      source: TrackSource.SOURCE_CAMERA
    });

    logger.info('Caption video track published');

    // Render initial empty frame
    this.renderCaptionFrame();

    // Start frame rendering loop
    this.videoFrameInterval = setInterval(() => {
      this.renderCaptionFrame();
    }, 1000 / VIDEO_FPS);
  }

  /**
   * Render caption text onto canvas and send as video frame
   */
  renderCaptionFrame() {
    if (!this.captionCtx || !this.videoSource) return;

    const ctx = this.captionCtx;

    // Clear canvas with semi-transparent black background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

    // Configure text style
    ctx.font = `${FONT_SIZE}px Arial, sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Draw title
    ctx.font = `bold 24px Arial, sans-serif`;
    ctx.fillStyle = '#888888';
    ctx.fillText('📝 Live Transcription', VIDEO_WIDTH / 2, 40);

    // Draw caption lines
    ctx.font = `${FONT_SIZE}px Arial, sans-serif`;
    ctx.fillStyle = '#FFFFFF';

    const startY = VIDEO_HEIGHT / 2 - ((this.captionLines.length - 1) * LINE_HEIGHT) / 2;

    this.captionLines.forEach((line, index) => {
      const y = startY + index * LINE_HEIGHT;

      // Highlight the most recent line (partial)
      if (index === this.captionLines.length - 1 && line.isPartial) {
        ctx.fillStyle = '#FFFF00';  // Yellow for partial
      } else {
        ctx.fillStyle = '#FFFFFF';  // White for final
      }

      ctx.fillText(line.text, VIDEO_WIDTH / 2, y);
    });

    // Draw timestamp
    ctx.font = '16px Arial, sans-serif';
    ctx.fillStyle = '#666666';
    ctx.fillText(new Date().toLocaleTimeString(), VIDEO_WIDTH / 2, VIDEO_HEIGHT - 30);

    // Convert canvas to RGBA buffer
    const imageData = ctx.getImageData(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    const rgbaBuffer = new Uint8Array(imageData.data.buffer);

    // Create video frame and send to source
    // VideoFrame constructor: (data: Uint8Array, width: number, height: number, type: VideoBufferType)
    const frame = new VideoFrame(
      rgbaBuffer,
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      VideoBufferType.RGBA
    );

    this.videoSource.captureFrame(frame);
  }

  /**
   * Update caption lines with new transcription text
   * @param {string} text - Caption text
   * @param {boolean} isFinal - Whether this is a final transcription
   */
  updateCaptionLines(text, isFinal) {
    // Word wrap text to fit canvas width
    const wrappedLines = this.wrapText(text, VIDEO_WIDTH - PADDING * 2);

    if (isFinal) {
      // For final: replace last partial line(s) with final text, then add to history
      // Remove any existing partial lines
      this.captionLines = this.captionLines.filter(l => !l.isPartial);

      // Add final lines
      wrappedLines.forEach(lineText => {
        this.captionLines.push({ text: lineText, isPartial: false });
      });

      // Keep only last MAX_LINES
      if (this.captionLines.length > MAX_LINES) {
        this.captionLines = this.captionLines.slice(-MAX_LINES);
      }
    } else {
      // For partial: replace existing partial with new partial
      // Remove old partial lines
      this.captionLines = this.captionLines.filter(l => !l.isPartial);

      // Add new partial lines
      wrappedLines.forEach(lineText => {
        this.captionLines.push({ text: lineText, isPartial: true });
      });

      // Keep only last MAX_LINES
      if (this.captionLines.length > MAX_LINES) {
        this.captionLines = this.captionLines.slice(-MAX_LINES);
      }
    }
  }

  /**
   * Word wrap text to fit within maxWidth pixels
   */
  wrapText(text, maxWidth) {
    if (!this.captionCtx) return [text];

    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    this.captionCtx.font = `${FONT_SIZE}px Arial, sans-serif`;

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = this.captionCtx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [''];
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

    // Initialize caption video track
    await this.initCaptionVideo();

    // Process participants already in the room
    await this.processExistingParticipants();
  }

  /**
   * Process participants that were already in the room when we connected
   */
  async processExistingParticipants() {
    const participants = this.room.remoteParticipants;
    logger.info(`Processing ${participants.size} existing participants in room`);

    for (const [sid, participant] of participants) {
      logger.debug(`Found existing participant: ${participant.identity} (sid: ${sid})`);

      // Check for published audio tracks
      for (const [trackSid, publication] of participant.trackPublications) {
        logger.debug(`  - Track: ${trackSid}, kind: ${publication.kind}, subscribed: ${publication.subscribed}`);

        if (publication.kind === TrackKind.KIND_AUDIO && publication.track) {
          logger.info(`Found existing audio track from: ${participant.identity}`);
          this.handleAudioTrack(publication.track, participant);
        }
      }
    }
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

  async handleAudioTrack(track, participant) {
    // Create AudioStream to receive audio frames from the track
    const audioStream = new AudioStream(track);
    logger.info(`Started AudioStream for participant: ${participant.identity}`);

    try {
      // Node.js SDK: AudioStream extends ReadableStream<AudioFrame>
      // It yields AudioFrame objects directly (not AudioFrameEvent like Python SDK)
      for await (const frame of audioStream) {
        this.processAudioFrame(frame, participant);
      }
    } catch (error) {
      logger.error(`AudioStream error for ${participant.identity}:`, error);
    } finally {
      logger.info(`AudioStream ended for participant: ${participant.identity}`);
    }
  }

  processAudioFrame(frame, participant) {
    // Log first frame to debug format
    if (!this._firstFrameLogged) {
      logger.info(`First audio frame received from ${participant.identity}:`, {
        sampleRate: frame.sampleRate,
        channels: frame.numChannels,
        samplesPerChannel: frame.samplesPerChannel,
        dataLength: frame.data?.byteLength || frame.data?.length
      });
      this._firstFrameLogged = true;
    }

    // LiveKit provides audio in PCM format
    // Convert to S16LE 16kHz mono if necessary
    let pcmBuffer;

    // Check format and convert if necessary (use numChannels instead of channels)
    if (frame.sampleRate !== SAMPLE_RATE || frame.numChannels !== CHANNELS) {
      pcmBuffer = this.resampleAudio(frame);
    } else {
      // Audio already in correct format
      pcmBuffer = Buffer.from(frame.data.buffer);
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
    if (frame.numChannels === 2) {
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
      // Update video caption overlay only if virtual camera is enabled
      if (this.useVirtualCamera) {
        this.updateCaptionLines(text, isFinal);
      }

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
    // Stop video frame rendering
    if (this.videoFrameInterval) {
      clearInterval(this.videoFrameInterval);
      this.videoFrameInterval = null;
    }

    if (this.room) {
      logger.info(`Disconnecting from room: ${this.roomName}`);
      await this.room.disconnect();
      this.room = null;
    }

    this.connected = false;
    this.videoSource = null;
    this.videoTrack = null;
    this.captionCanvas = null;
    this.captionCtx = null;
    this.captionLines = [];
  }
}

module.exports = LivekitBotInstance;
