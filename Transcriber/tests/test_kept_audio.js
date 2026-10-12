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
const { setupMocks, fromTranscriber, mockLogger } = require('./helpers/asr_mocks');

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
        original = { wav: ASR.prototype.transcodeToWav, concat: ASR.prototype.concatAudioFiles, hasAudio: ASR.prototype.hasAudio };
    });

    after(() => {
        ASR.prototype.transcodeToWav = original.wav;
        ASR.prototype.concatAudioFiles = original.concat;
        ASR.prototype.hasAudio = original.hasAudio;
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
        // These stub outputs hold audio as soon as they hold bytes (ffprobe is
        // exercised by test_kept_audio_ffmpeg.js).
        ASR.prototype.hasAudio = async (file) => fs.statSync(file).size > 0;
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
        send([5, 6]); // before the new ASR's init(): buffered
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

    // Session-end drains end on the channel deactivation, after which
    // studio-api reads the kept audio file (converts and deletes the WAV).
    describe('channel deactivation', () => {
        const ORIG_TIMEOUT = process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS;
        let warns, origWarn;
        beforeEach(() => {
            warns = [];
            origWarn = mockLogger.warn;
            mockLogger.warn = (msg) => warns.push(msg);
        });
        afterEach(() => {
            mockLogger.warn = origWarn;
            if (ORIG_TIMEOUT === undefined) delete process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS;
            else process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS = ORIG_TIMEOUT;
        });

        it('is reported only once the kept audio file is saved', async () => {
            transcodeDelayMs = 60;
            await start();
            send([1, 2]);
            ws.emit('session-stop', session, channel.id);
            await wait(200);
            assert.deepStrictEqual(events, ['transcode start 1,2', 'transcode end', 'inactive']);
            assert.deepStrictEqual(keptAudio(), [1, 2]);
        });

        it('waits for both streams of an immediate reconnect to be saved', async () => {
            transcodeDelayMs = 50;
            await start();
            send([1, 2]);
            ws.emit('session-stop', session, channel.id);
            ws.emit('session-start', session, channel);
            await wait(60);
            send([3, 4]);
            ws.emit('session-stop', session, channel.id);
            await wait(300);
            assert.deepStrictEqual(events, [
                'transcode start 1,2', 'transcode end', 'transcode start 3,4', 'transcode end',
                'inactive', // the second stream's: the first one's is skipped (newer stream)
            ]);
        });

        it('does not wait longer than ASR_STOP_AUDIO_SAVE_TIMEOUT_MS, and warns', async () => {
            process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS = '50';
            transcodeDelayMs = 400;
            await start();
            send([1, 2]);
            ws.emit('session-stop', session, channel.id);
            await wait(150);
            assert.deepStrictEqual(events, ['transcode start 1,2', 'inactive'], 'inactive while still transcoding');
            assert.strictEqual(warns.length, 1);
            assert.ok(/kept audio still being saved after 50ms/.test(warns[0]), warns[0]);
            await wait(350);
            assert.deepStrictEqual(keptAudio(), [1, 2], 'the save still completes');
        });

        it('does not wait for dispose without kept audio', async () => {
            ws.emit('session-start', session, { ...channel, keepAudio: false });
            const asr = streaming.ASRs.get('sess_7');
            await asr._transitionLock;
            asr.dispose = () => new Promise(() => {}); // would hang
            ws.emit('session-stop', session, channel.id);
            await wait(100);
            assert.deepStrictEqual(events, ['inactive']);
        });
    });
});
