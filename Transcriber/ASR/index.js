const eventEmitter = require('eventemitter3');
const path = require('path');
const fs = require('fs');
const { CircularBuffer } = require("live-srt-lib");
const logger = require('../logger')
const ffmpeg = require('fluent-ffmpeg');
const ASR_ERROR = require('./error.js');
const FakeTranscriber = require('./fake/index.js');


function loadAsr(provider) {
  const asrPath = path.join(__dirname, provider, 'index.js');
  if (!fs.existsSync(asrPath)) {
    throw new Error(`No ASR named '${provider}' in '${asrPath}'`);
  }
  const AsrClass = require(asrPath);
  return AsrClass;
}


class ASR extends eventEmitter {
  static states = {
    CONNECTING: 'connecting',
    READY: 'ready',
    ERROR: 'error',
    CLOSED: 'closed',
    TRANSCRIBING: 'transcribing'
  };

  constructor(session, channel, options = {}) {
    super();
    this.session = session;
    this.channel = channel;
    this.logger = logger.getChannelLogger(this.session.id, this.channel.id);
    this.provider = null;
    this.state = ASR.states.CLOSED;
    this.segmentId = options.initialSegmentId || 1;
    // Segment the most recent primary final/partial was assigned to. Used to
    // align dual-mode secondary (translation-only) results onto the same
    // segment as the primary that produced the source text. Before any primary
    // result, secondary results fall back to the current segmentId.
    this._lastPrimarySegmentId = this.segmentId;
    // Native diarization (bot streams): when a SpeakerTracker is provided, the
    // speaker label comes from the meeting (per-participant SFU tracks / Teams
    // page state) instead of the ASR provider. null for ordinary streams.
    this.speakerTracker = options.speakerTracker || null;
    this.diarizationMode = options.diarizationMode || 'asr';
    // Previous PRIMARY final's segment, cleared one final late so a lagging
    // dual-recognizer secondary (translation) can still read the segment's speaker.
    this._prevFinalSegmentId = null;
    this.paused = false;
    this._flushed = false;
    this._transitionLock = Promise.resolve();
    // Chain init() into the transition lock so any pause()/resume() queued
    // right after construction runs *after* init() has set up provider/state.
    this._chainTransition(() => this.init());
  }

  // Append `fn` to the serialized transition chain. The .catch(()=>{}) guard
  // ensures a previous transition's rejection (sync throw, missed error in fn)
  // never breaks the chain — every queued pause()/resume()/dispose() still runs.
  _chainTransition(fn) {
    this._transitionLock = this._transitionLock.catch(() => {}).then(fn);
    return this._transitionLock;
  }

  async pause() {
    return this._chainTransition(async () => {
      if (this.paused) return;
      this.paused = true;
      if (this.audioBuffer) {
        this.audioBuffer.flush();
      }
      if (this.provider && (this.state === ASR.states.READY || this.state === ASR.states.TRANSCRIBING || this.state === ASR.states.CONNECTING)) {
        try {
          await this.provider.stop();
        } catch (e) {
          this.logger.warn(`ASR pause: provider.stop() error: ${e.message}`);
        }
      }
      // Set state synchronously after stop() so external readers don't see
      // state=READY during the (potentially long, on Amazon) interval between
      // provider.stop() returning and the asynchronous 'closed' event firing.
      // The provider's own 'closed' handler will still set state=CLOSED later;
      // this is a no-op convergence for the live path and a safety net for
      // providers whose stop() does not emit closed (or emits it racily).
      this.state = ASR.states.CLOSED;
      this.logger.info(`ASR paused for session=${this.session?.id} channel=${this.channel?.id}`);
    });
  }

  async resume() {
    return this._chainTransition(async () => {
      if (!this.paused) return;
      this.paused = false;
      if (this.audioBuffer) {
        this.audioBuffer.flush();
      }
      this.state = ASR.states.CONNECTING;
      if (this.provider) {
        try {
          await this.provider.start();
        } catch (e) {
          this.logger.error(`ASR resume: provider.start() error: ${e.message}`);
          this.state = ASR.states.ERROR;
        }
      }
      this.logger.info(`ASR resumed for session=${this.session?.id} channel=${this.channel?.id}`);
    });
  }

  async init() {
    // identifies the transcriber profile for the channel channel.id in the session channels array
    try {
      const channel = this.channel

      if (channel.keepAudio) {
        const audioFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
        this.audioFile = fs.createWriteStream(audioFilePath);
      }
      this.audioBuffer = new CircularBuffer();

      // FakeTranscriber when live transcripts are off or no profile is set (audio-only).
      const hasProfile = !!(channel.transcriberProfile && channel.transcriberProfile.config);
      if (!this.channel.enableLiveTranscripts || !hasProfile) {
        this.provider = new FakeTranscriber(this.session, channel);
        this.logger.info("ASR started with FakeTranscriber");
      }
      else {
        this.logger.info(`Starting ${channel.transcriberProfile.config.type} ASR`);
        const backend = loadAsr(channel.transcriberProfile.config.type);
        this.provider = new backend(this.session, this.channel);
      }
      this.state = ASR.states.CONNECTING;
      this.handleASREvents();
      await this.provider.start();
    } catch (error) {
      this.logger.error(error);
      this.state = ASR.states.ERROR;
      this.emit('error', error);
    }
  }

  // Resolve the segmentId a result belongs to. Primary (or untagged) results
  // own the current segmentId and update _lastPrimarySegmentId so the dual-mode
  // secondary can rejoin them: a secondary (isPrimary===false) result is pinned
  // to the segment the latest primary produced, never the next one. This keeps
  // a translation aligned with its source even though the primary final
  // advances segmentId immediately after emitting.
  _segmentIdFor(transcription) {
    if (transcription.isPrimary === false) {
      return this._lastPrimarySegmentId;
    }
    this._lastPrimarySegmentId = this.segmentId;
    return this.segmentId;
  }

  // Native diarization: stamp the segment's speaker from the bot-fed
  // SpeakerTracker, overriding any provider-supplied locutor. The display name
  // is preferred (real meeting participant) and falls back to the id. No-op for
  // ordinary (non-bot) streams where speakerTracker is null.
  _applyNativeSpeaker(transcription) {
    if (this.diarizationMode !== 'native' || !this.speakerTracker) return;
    // Only the canonical PRIMARY result owns the assignment; a dual-recognizer
    // secondary (isPrimary===false) reads it read-only so it inherits the
    // primary's speaker instead of re-deriving it from the (possibly changed)
    // current speaker.
    if (transcription.isPrimary !== false) {
      this.speakerTracker.assignSpeakerToSegment(transcription.segmentId);
    }
    const speaker = this.speakerTracker.getSpeakerForSegment(transcription.segmentId);
    if (speaker) {
      transcription.locutor = speaker.name || speaker.id;
    }
  }

  handleASREvents() {
    this.provider.on('connecting', () => {
      this.state = ASR.states.CONNECTING;
    });
    this.provider.on('ready', () => {
      this.state = ASR.states.READY;
    });
    this.provider.on('error', error => {
      this.logger.error(error);
      const msg = ASR_ERROR[error] || ASR_ERROR['RUNTIME_ERROR'];
      const final = {
        "segmentId": this.segmentId,
        "astart": this.provider.startedAt,
        "text": msg,
        "start": 0,
        "end": 0,
        "lang": 'EN-en',
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
      this.segmentId++;
      this.logger.error(msg);
      this.state = ASR.states.ERROR
    })
    this.provider.on('closed', (code, reason) => {
      let msg = 'ASR connexion closed';
      if (code) {
        msg = `${msg} - Code: ${code}`;
      }
      if (reason) {
        msg = `${msg} - Reason: ${reason}`;
      }
      this.logger.info(msg);
      this.state = ASR.states.CLOSED;
    });
    this.provider.on('transcribing', (transcription) => {
      this.state = ASR.states.TRANSCRIBING;
      if (transcription.text.trim().length > 0) {
        transcription.segmentId = this._segmentIdFor(transcription);
        this._applyNativeSpeaker(transcription);
        this.emit('partial', transcription);
      }
    });
    this.provider.on('transcribed', (transcription) => {
      if (transcription.text.trim().length > 0) {
        transcription.segmentId = this._segmentIdFor(transcription);
        this._applyNativeSpeaker(transcription);
        this.emit('final', transcription);
        // Origin-tagging for the Microsoft dual recognizer (diarization +
        // translation). The primary (ConversationTranscriber) is the canonical
        // source of segments and speaker; only its finals advance segmentId.
        // The secondary (TranslationRecognizer, isPrimary===false) only carries
        // translations attached to the segment the primary just produced
        // (_lastPrimarySegmentId, set by _segmentIdFor) and must NOT advance
        // segmentId nor create a second canonical caption line (ASREvents.js
        // drops its canonical `final`). Any provider that does not tag isPrimary
        // (amazon, linto, openai, fake, and every single-recognizer Microsoft
        // mode) is treated as primary, so their behaviour is unchanged.
        if (transcription.isPrimary !== false) {
          // Native diarization: free the PREVIOUS segment now (bounded memory)
          // while keeping the just-emitted one available for a lagging secondary.
          if (this.speakerTracker && this._prevFinalSegmentId != null) {
            this.speakerTracker.clearSegment(this._prevFinalSegmentId);
          }
          this._prevFinalSegmentId = transcription.segmentId;
          this.segmentId++;
        }
      }
    });
  }

  // Stop the provider WITH listeners still attached so any finals it flushes
  // during stop() (e.g. Azure stopContinuousRecognitionAsync delivering the
  // pending recognized result) are still emitted as 'final' and published to
  // the broker BEFORE the end-of-stream bot marker (streamStopped). Chained on
  // the transition lock so it never interleaves with pause()/resume(), and
  // bounded so a hung provider can never delay the marker indefinitely.
  async flushFinals() {
    return this._chainTransition(async () => {
      if (this._flushed || !this.provider || this.paused) return;
      this._flushed = true;
      const flushTimeoutMs = parseInt(process.env.ASR_STOP_FLUSH_TIMEOUT_MS, 10) || 3000;
      let flushTimer;
      try {
        await Promise.race([
          this.provider.stop(),
          new Promise((resolve) => { flushTimer = setTimeout(resolve, flushTimeoutMs); }),
        ]);
      } catch (error) {
        this.logger.warn(`flushFinals: provider.stop() error: ${error.message}`);
      } finally {
        clearTimeout(flushTimer);
      }
      // Some SDKs keep delivering callbacks shortly after stop() acks (see the
      // epoch comment in ASR/microsoft/index.js). Give stragglers a beat
      // before the end-of-stream marker is emitted.
      const settleMs = parseInt(process.env.ASR_STOP_SETTLE_MS, 10) || 300;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      this.state = ASR.states.CLOSED;
    });
  }

  streamStopped() {
      if (!this.provider) {
        this.logger.warn('streamStopped called but provider is null');
        return;
      }
      const final = {
        "astart": this.provider.startedAt,
        "aend": new Date().toISOString(),
        "text": "",
        "locutor": process.env.TRANSCRIBER_BOT_NAME
      }
      this.emit('final', final)
  }

  async transcodeToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
        .inputOptions(['-ar 16000', '-ac 1'])
        .audioCodec('libmp3lame')
        .audioBitrate('64k')
        .on('end', () => {
          this.logger.info(`Transcoding to MP3 completed: ${outputPath}`);
          resolve();
        })
        .on('error', (err) => {
          this.logger.error(`Error during transcoding: ${err.message}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  async transcodeToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputFormat('s16le')      // Specify the input format as signed 16-bit little-endian PCM
        .inputOptions(["-ar 16000", "-ac 1"])
        .audioCodec("pcm_s16le")
        .output(outputPath)
        .on("end", resolve)
        .on("error", (err) => {
          this.logger.error(`Error transcoding to WAV: ${err.message}`);
          reject(err);
        })
        .run();
    });
  }

  async concatAudioFiles(input1, input2, output) {
    return new Promise((resolve, reject) => {
      ffmpeg(input1)
        .input(input2)
        .on('end', () => {
          this.logger.info(`Concat completed: ${output}`);
          resolve()
        })
        .on('error', (err) => {
          this.logger.error(`Error during concat: ${err.message}`)
          reject(err)
        })
        .mergeToFile(output, '/tmp');
    });
  }

  async saveAudio() {
    const fileExtension = this.channel.compressAudio ? '.mp3' : '.wav';
    const transcodeFn = this.channel.compressAudio ? this.transcodeToMp3.bind(this) : this.transcodeToWav.bind(this);
    const pcmFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}.pcm`);
    let outFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}`) + fileExtension;

    if (fs.existsSync(outFilePath)) {
      const tempOutFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}-temp`) + fileExtension;
      const tempOutputFilePath = path.join(process.env.AUDIO_STORAGE_PATH, `${this.session.id}-${this.channel.id}-output`) + fileExtension;
      await transcodeFn(pcmFilePath, tempOutFilePath);
      await this.concatAudioFiles(outFilePath, tempOutFilePath, tempOutputFilePath);
      fs.unlinkSync(tempOutFilePath);
      fs.renameSync(tempOutputFilePath, outFilePath);
    } else {
      await transcodeFn(pcmFilePath, outFilePath);
    }

    this.logger.info(`Audio file saved as ${outFilePath}`);
    fs.unlinkSync(pcmFilePath);
  }

  async dispose() {
    try {
      await this._transitionLock;
      if (this.audioFile) {
        this.audioFile.close();
        await this.saveAudio();
      }
      if (this.provider) {
        this.provider.removeAllListeners();
        // flushFinals() already stopped the provider (with listeners attached,
        // so its in-flight finals were published); skip the redundant stop.
        if (!this._flushed) {
          await this.provider.stop();
        }
      }
    } catch (error) {
      this.logger.error(`Error when saving the audio file: ${error}`)
      this.emit('error', error);
      return false;
    }
    this.audioBuffer = null;
    this.provider = null;
    this.removeAllListeners();
    return true;
  }

  transcribe(buffer) {
    // While paused, drop audio synchronously so the GStreamer pipeline keeps flowing.
    // The buffer was already flushed by pause(), no need to flush again per packet.
    if (this.paused) return;
    this.audioBuffer.add(buffer);
    if (!(this.state === ASR.states.READY || this.state === ASR.states.TRANSCRIBING)) return;
    const audioBuffer = this.audioBuffer.getAudioBuffer();
    if (audioBuffer.length >= Math.floor(process.env.MIN_AUDIO_BUFFER / 1000 * process.env.SAMPLE_RATE * process.env.BYTES_PER_SAMPLE)) {
      if (this.channel.keepAudio) {
        this.audioFile.write(audioBuffer);
      }
      this.provider.transcribe(audioBuffer);
      this.audioBuffer.flush();
    }
  }
}

module.exports = ASR;
