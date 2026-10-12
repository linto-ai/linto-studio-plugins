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

        it('keeps stream order when the older stream\'s flush is the slower one', async () => {
            // The session ends right after a reconnect: both streams stop, the
            // older one's provider taking longer to flush (e.g. Azure).
            streaming.on('final', (t) => events.push(t.locutor === 'bot' && t.aend ? 'marker' : `final ${t.text}`));
            await start();
            const older = streaming.ASRs.get('sess_7');
            send([1, 2]);
            older.provider.stop = function () {
                return new Promise((resolve) => setTimeout(() => {
                    this.emit('transcribed', { text: 'older flushed', astart: 0 });
                    resolve();
                }, 150));
            };
            ws.emit('session-stop', session, channel.id);
            await start(); // reconnects at once
            send([3, 4]);
            ws.emit('session-stop', session, channel.id);
            await wait(400);
            // The older stream's last final and marker, then the newer one's
            // marker, the channel's deactivation last.
            assert.deepStrictEqual(events.filter((e) => !e.startsWith('transcode')), [
                'final older flushed', 'marker', 'marker', 'inactive',
            ]);
            // The audio in stream order, both saved before the deactivation.
            assert.deepStrictEqual(events.filter((e) => e.startsWith('transcode')), [
                'transcode start 1,2', 'transcode end', 'transcode start 3,4', 'transcode end',
            ]);
            assert.strictEqual(events[events.length - 1], 'inactive');
            assert.ok(events.indexOf('transcode start 1,2') > events.indexOf('final older flushed'), 'the older raw file saved once flushed');
            assert.deepStrictEqual(keptAudio(), [1, 2, 3, 4]);
        });

        it('stops each stream\'s own ASR when streams of two servers feed one channel', async () => {
            // e.g. an SRT stream, then a WS stream on the same channel: each
            // server stops its own stream, in any order.
            const srt = {}, wsStream = {};
            ws.emit('session-start', session, channel, srt);
            const first = streaming.ASRs.get('sess_7');
            await first._transitionLock;
            send([1, 2]);
            ws.emit('session-start', session, channel, wsStream);
            const second = streaming.ASRs.get('sess_7');
            await second._transitionLock;
            send([3, 4]);
            ws.emit('session-stop', session, channel.id, srt);
            await wait(150);
            assert.strictEqual(first.provider, null, 'the first stream\'s ASR is disposed');
            assert.strictEqual(streaming.ASRs.get('sess_7'), second, 'the second stream still feeds the channel');
            assert.deepStrictEqual(events, ['transcode start 1,2', 'transcode end'], 'no deactivation: the second stream is the latest');
            ws.emit('session-stop', session, channel.id, wsStream);
            await wait(150);
            assert.deepStrictEqual(events.slice(2), ['transcode start 3,4', 'transcode end', 'inactive']);
            assert.deepStrictEqual(keptAudio(), [1, 2, 3, 4]);
        });

        it('drops the audio of a stream of another server once a newer one feeds the channel', async () => {
            const srt = {}, wsStream = {};
            // The stream object comes last, after the per-stream tag and meeting clock.
            const sendFrom = (stream, bytes) => ws.emit('data', Buffer.from(bytes), session.id, channel.id, undefined, undefined, stream);
            ws.emit('session-start', session, channel, srt);
            const first = streaming.ASRs.get('sess_7');
            await first._transitionLock;
            sendFrom(srt, [1, 2]);
            ws.emit('session-start', session, channel, wsStream);
            const second = streaming.ASRs.get('sess_7');
            await second._transitionLock;
            sendFrom(wsStream, [3, 4]);
            sendFrom(srt, [9, 9]); // the older stream is still open
            sendFrom(wsStream, [5, 6]);
            sendFrom(srt, [9, 9]);
            ws.emit('session-stop', session, channel.id, srt);
            await wait(150);
            ws.emit('session-stop', session, channel.id, wsStream);
            await wait(150);
            assert.deepStrictEqual(keptAudio(), [1, 2, 3, 4, 5, 6], 'nothing of the older stream interleaved');
            const dropped = warns.filter((w) => /audio of an older stream of the channel dropped/.test(w));
            assert.strictEqual(dropped.length, 1, 'reported once per interval');
            assert.ok(/\(1 chunk/.test(dropped[0]), dropped[0]);
        });

        // The ASR wrapper logs through its channel logger.
        function channelLogs(logs) {
            const origChannelLogger = mockLogger.getChannelLogger;
            mockLogger.getChannelLogger = () => ({
                info() {}, debug() {}, log() {},
                warn: (msg) => logs.push(String(msg)),
                error: (msg) => logs.push(String(msg)),
            });
            return () => { mockLogger.getChannelLogger = origChannelLogger; };
        }

        it('is not held by a provider whose stop never settles, paused before the stop', async () => {
            const ORIG_FLUSH = process.env.ASR_STOP_FLUSH_TIMEOUT_MS;
            process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '100';
            const asrLogs = [];
            const restoreLogger = channelLogs(asrLogs);
            try {
                await start();
                const stuck = streaming.ASRs.get('sess_7');
                send([1, 2]);
                stuck.provider.stop = () => new Promise(() => {}); // e.g. Microsoft's stop, no error callback
                stuck.pause(); // the session is paused
                ws.emit('session-stop', session, channel.id);
                await start(); // the client reconnects
                send([3, 4]);
                ws.emit('session-stop', session, channel.id);
                await wait(600);
                await start(); // and once more, later
                send([5, 6]);
                ws.emit('session-stop', session, channel.id);
                await wait(300);
                assert.deepStrictEqual(keptAudio(), [1, 2, 3, 4, 5, 6]);
                assert.deepStrictEqual(events.filter((e) => e === 'inactive'), ['inactive', 'inactive']);
                assert.ok(asrLogs.some((w) => /ASR pause: provider.stop\(\) did not settle within 100 ms/.test(w)), asrLogs.join(' | '));
            } finally {
                restoreLogger();
                if (ORIG_FLUSH === undefined) delete process.env.ASR_STOP_FLUSH_TIMEOUT_MS; else process.env.ASR_STOP_FLUSH_TIMEOUT_MS = ORIG_FLUSH;
            }
        });

        it('is not held by a provider whose start never settles on resume', async () => {
            const ORIG_START = process.env.ASR_PROVIDER_START_TIMEOUT_MS;
            process.env.ASR_PROVIDER_START_TIMEOUT_MS = '100';
            try {
                await start();
                const asr = streaming.ASRs.get('sess_7');
                send([1, 2]);
                await asr.pause();
                asr.provider.start = () => new Promise(() => {});
                asr.resume();
                ws.emit('session-stop', session, channel.id);
                await wait(400);
                assert.deepStrictEqual(events.filter((e) => e === 'inactive'), ['inactive']);
                assert.deepStrictEqual(keptAudio(), [1, 2]);
            } finally {
                if (ORIG_START === undefined) delete process.env.ASR_PROVIDER_START_TIMEOUT_MS; else process.env.ASR_PROVIDER_START_TIMEOUT_MS = ORIG_START;
            }
        });

        it('gives up the save of a stream whose stop is stuck at its deadline: only its own audio is lost', async () => {
            const ORIG_FLUSH = process.env.ASR_STOP_FLUSH_TIMEOUT_MS;
            process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '100';
            process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS = '100'; // budget: 100 + 20 + 100 ms
            const errors = [];
            const restoreLogger = channelLogs(errors);
            try {
                await start();
                const stuck = streaming.ASRs.get('sess_7');
                send([1, 2]);
                stuck.flushFinals = () => new Promise(() => {}); // its stop never gets past the flush
                ws.emit('session-stop', session, channel.id);
                await start();
                send([3, 4]);
                ws.emit('session-stop', session, channel.id);
                await wait(500);
                await start();
                send([5, 6]);
                ws.emit('session-stop', session, channel.id);
                await wait(300);
                assert.deepStrictEqual(keptAudio(), [3, 4, 5, 6], 'the later streams are saved');
                assert.strictEqual(rawFiles().length, 1, 'the stuck stream\'s raw audio is left');
                assert.ok(errors.some((e) => /Kept audio of this stream not saved/.test(e)), errors.join(' | '));
            } finally {
                restoreLogger();
                if (ORIG_FLUSH === undefined) delete process.env.ASR_STOP_FLUSH_TIMEOUT_MS; else process.env.ASR_STOP_FLUSH_TIMEOUT_MS = ORIG_FLUSH;
            }
        });

        it('does not wait for an earlier stop past the stop budget, and warns', async () => {
            const ORIG_FLUSH = process.env.ASR_STOP_FLUSH_TIMEOUT_MS;
            process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '100';
            process.env.ASR_STOP_AUDIO_SAVE_TIMEOUT_MS = '50'; // budget: 100 + 20 + 50 ms
            try {
                await start();
                send([1, 2]);
                streaming.channelStops.set('sess_7', new Promise(() => {})); // an earlier stop that never ends
                const stoppedAt = Date.now();
                ws.emit('session-stop', session, channel.id);
                await wait(300);
                const inactive = events.indexOf('inactive');
                assert.ok(inactive >= 0, events.join(' | '));
                assert.ok(warns.some((w) => /earlier stream of the channel is still being stopped/.test(w)), warns.join(' | '));
                assert.ok(Date.now() - stoppedAt >= 170);
            } finally {
                if (ORIG_FLUSH === undefined) delete process.env.ASR_STOP_FLUSH_TIMEOUT_MS; else process.env.ASR_STOP_FLUSH_TIMEOUT_MS = ORIG_FLUSH;
            }
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
