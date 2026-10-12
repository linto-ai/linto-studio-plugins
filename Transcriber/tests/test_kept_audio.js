/**
 * Kept audio (channel.keepAudio) across stream stops and immediate reconnects.
 *
 * Each stream writes its raw PCM to a file, transcoded at stop into the
 * channel's audio file (<session>-<channel>.wav|.mp3, appended to when it
 * exists). A client that reconnects at once to the same Transcriber starts a
 * new stream while the previous one is still being stopped and saved: the
 * streams must not share a raw file (the new one would truncate the previous
 * stream's audio, whose save would then delete the new one's file), and the
 * saves must not overlap (same output and temporary files).
 *
 * Drives the real StreamingServer, WebsocketServer (no socket opened) and ASR
 * wrapper with the FakeTranscriber provider. ffmpeg is stubbed: the transcode
 * records the raw file it reads, the concat appends.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const STREAMING_SERVER = fromTranscriber('components/StreamingServer/index.js');

class FakeComponent extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
    }
    async init() {}
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Kept audio across stream stops and reconnects', () => {
    let teardown;
    let createStreamingServer;
    let ASR;
    let original;
    const ORIG_ENV = {};
    // MIN_AUDIO_BUFFER 1000 ms at SAMPLE_RATE=1 / BYTES_PER_SAMPLE=1 (tests.js):
    // every chunk goes to the provider, hence to the raw file, at once.
    const ENV = { STREAMING_PROTOCOLS: 'WS', ASR_STOP_SETTLE_MS: '20', TRANSCRIBER_BOT_NAME: 'bot', MIN_AUDIO_BUFFER: '1000' };

    before(() => {
        for (const [k, v] of Object.entries(ENV)) {
            ORIG_ENV[k] = process.env[k];
            process.env[k] = v;
        }
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js'), STREAMING_SERVER],
            mockWs: false,
            circularBuffer: true,
        });
        require.cache[require.resolve('live-srt-lib')].exports.Component = FakeComponent;
        createStreamingServer = require(STREAMING_SERVER);
        ASR = require('../ASR/index.js');
        original = { wav: ASR.prototype.transcodeToWav, concat: ASR.prototype.concatAudioFiles };
    });

    after(() => {
        ASR.prototype.transcodeToWav = original.wav;
        ASR.prototype.concatAudioFiles = original.concat;
        if (teardown) teardown();
        for (const [k, v] of Object.entries(ORIG_ENV)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    const session = { id: 'sess' };
    const channel = {
        id: 7, enableLiveTranscripts: false, keepAudio: true, compressAudio: false, translations: [], lastSegmentId: 0,
    };

    let storage, streaming, ws, events, transcodeDelayMs;
    beforeEach(async () => {
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-audio-'));
        process.env.AUDIO_STORAGE_PATH = storage;
        events = [];
        transcodeDelayMs = 0;
        // Transcode: record the raw audio it reads; output = that audio.
        ASR.prototype.transcodeToWav = async function (input, output) {
            const raw = [...fs.readFileSync(input)];
            events.push(`transcode start ${raw.join(',')}`);
            await wait(transcodeDelayMs);
            fs.writeFileSync(output, Buffer.from(raw));
            events.push('transcode end');
        };
        // Concat: append the second file to the first.
        ASR.prototype.concatAudioFiles = async function (first, second, output) {
            fs.writeFileSync(output, Buffer.concat([fs.readFileSync(first), fs.readFileSync(second)]));
        };
        streaming = createStreamingServer({ components: {} });
        await wait(0);
        ws = streaming.servers[0];
        streaming.on('session-stop', () => events.push('inactive'));
    });

    afterEach(() => {
        fs.rmSync(storage, { recursive: true, force: true });
        delete process.env.AUDIO_STORAGE_PATH;
    });

    const send = (bytes) => ws.emit('data', Buffer.from(bytes), session.id, channel.id);
    const keptAudio = () => [...fs.readFileSync(path.join(storage, 'sess-7.wav'))];
    const rawFiles = () => fs.readdirSync(storage).filter((f) => f.endsWith('.pcm'));

    async function start() {
        ws.emit('session-start', session, channel);
        await streaming.ASRs.get('sess_7')._transitionLock;
    }

    it('saves a stream into the channel audio file and removes its raw file', async () => {
        await start();
        send([1, 2]);
        send([3, 4]);
        ws.emit('session-stop', session, channel.id);
        await wait(150);
        assert.deepStrictEqual(keptAudio(), [1, 2, 3, 4]);
        assert.deepStrictEqual(rawFiles(), []);
    });

    it('keeps both streams of an immediate reconnect, in order, in the channel audio file', async () => {
        transcodeDelayMs = 50; // the first save is still running when the second stream stops
        await start();
        send([1, 2]);
        send([3, 4]);
        ws.emit('session-stop', session, channel.id);
        ws.emit('session-start', session, channel); // reconnects at once
        send([5, 6]); // held until the first stream's cursor is final
        await wait(60);
        send([7, 8]);
        ws.emit('session-stop', session, channel.id);
        await wait(300);

        const transcodes = events.filter((e) => e.startsWith('transcode'));
        assert.deepStrictEqual(transcodes, [
            'transcode start 1,2,3,4', 'transcode end',  // the first stream's audio, intact
            'transcode start 5,6,7,8', 'transcode end',  // then the second's, not overlapping
        ]);
        assert.deepStrictEqual(keptAudio(), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.deepStrictEqual(rawFiles(), [], 'both raw files removed');
    });

    it('transcodes the raw file only once it is closed', async () => {
        await start();
        const asr = streaming.ASRs.get('sess_7');
        send([1, 2]);
        const close = asr.audioFile.close.bind(asr.audioFile);
        asr.audioFile.close = (cb) => setTimeout(() => close(() => { events.push('raw file closed'); if (cb) cb(); }), 30);
        ws.emit('session-stop', session, channel.id);
        await wait(150);
        const closed = events.indexOf('raw file closed');
        assert.ok(closed >= 0 && closed < events.indexOf('transcode start 1,2'), events.join(' | '));
    });
});
