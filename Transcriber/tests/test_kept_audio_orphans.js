/**
 * Kept-audio files left behind, and Transcribers sharing the audio storage.
 *
 * A crash or a failed save leaves a stream's raw file (.pcm) or a save's
 * temporary files in AUDIO_STORAGE_PATH, where nothing removed them. And a
 * save's temporary files had fixed names (<session>-<channel>-temp/-output),
 * shared by two Transcribers saving the same channel at once on a shared
 * storage (saves are serialized per process only).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('eventemitter3');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const STREAMING_SERVER = fromTranscriber('components/StreamingServer/index.js');
const LIVE = '11111111-1111-4111-8111-111111111111';
const ENDED = '22222222-2222-4222-8222-222222222222';
const STREAM = '33333333-3333-4333-8333-333333333333';
const HOUR = 60 * 60 * 1000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeComponent extends EventEmitter {
    constructor(app) {
        super();
        this.app = app;
    }
    async init() {}
}

describe('Kept-audio orphans and shared storage', () => {
    let ASR;
    let createStreamingServer;
    let teardown;
    let storage;
    const ORIG_PROTOCOLS = process.env.STREAMING_PROTOCOLS;

    before(() => {
        process.env.STREAMING_PROTOCOLS = 'WS';
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js'), STREAMING_SERVER],
            mockWs: false,
            circularBuffer: true,
        });
        require.cache[require.resolve('live-srt-lib')].exports.Component = FakeComponent;
        createStreamingServer = require(STREAMING_SERVER);
        ASR = require('../ASR/index.js');
    });
    after(() => {
        if (teardown) teardown();
        if (ORIG_PROTOCOLS === undefined) delete process.env.STREAMING_PROTOCOLS; else process.env.STREAMING_PROTOCOLS = ORIG_PROTOCOLS;
    });

    beforeEach(() => {
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-audio-orphans-'));
        process.env.AUDIO_STORAGE_PATH = storage;
    });
    afterEach(() => {
        fs.rmSync(storage, { recursive: true, force: true });
        delete process.env.AUDIO_STORAGE_PATH;
    });

    // Creates `name` in the storage, last modified `ageMs` ago.
    function file(name, ageMs) {
        const target = path.join(storage, name);
        fs.writeFileSync(target, 'x');
        const at = new Date(Date.now() - ageMs);
        fs.utimesSync(target, at, at);
        return name;
    }
    const present = () => fs.readdirSync(storage).sort();

    describe('ASR.sweepOrphanAudio()', () => {
        it('deletes old transient files of ended sessions only', async () => {
            const orphans = [
                file(`${ENDED}-7-${STREAM}.pcm`, 2 * HOUR), // a stream's raw file
                file(`${ENDED}-7.pcm`, 2 * HOUR), // former raw file name
                file(`${ENDED}-7-temp-${STREAM}.mp3`, 2 * HOUR),
                file(`${ENDED}-7-output-${STREAM}.wav`, 2 * HOUR),
                file(`${ENDED}-7-temp.wav`, 2 * HOUR), // former temporary names
                file(`${ENDED}-7-output.mp3`, 2 * HOUR),
            ];
            const kept = [
                file(`${LIVE}-7-${STREAM}.pcm`, 2 * HOUR), // live session (e.g. paused for long)
                file(`${LIVE}-7-temp-${STREAM}.mp3`, 2 * HOUR),
                file(`${ENDED}-8-${STREAM}.pcm`, 10 * 60 * 1000), // recent: maybe a save in progress elsewhere
                file(`${ENDED}-7.wav`, 2 * HOUR), // the channel's audio files
                file(`${ENDED}-7.mp3`, 2 * HOUR),
                file('notes.txt', 2 * HOUR), // anything else
            ];
            const removed = await ASR.sweepOrphanAudio(storage, new Set([LIVE]), HOUR);
            assert.deepStrictEqual(removed.sort(), orphans.sort());
            assert.deepStrictEqual(present(), kept.sort());
        });
    });

    describe('StreamingServer', () => {
        it('sweeps on a statuses snapshot, at most once per interval', async () => {
            const streaming = createStreamingServer({ components: {} });
            await wait(0);
            const first = file(`${ENDED}-7-${STREAM}.pcm`, 2 * HOUR);
            const live = file(`${LIVE}-7-${STREAM}.pcm`, 2 * HOUR);
            streaming.setSessions([{ id: LIVE, channels: [] }]);
            await wait(50);
            assert.deepStrictEqual(present(), [live], `${first} swept, the live session's file kept`);

            const second = file(`${ENDED}-8-${STREAM}.pcm`, 2 * HOUR);
            streaming.setSessions([{ id: LIVE, channels: [] }]);
            await wait(50);
            assert.deepStrictEqual(present(), [live, second].sort(), 'not swept again within the interval');
        });
    });

    describe('saves of the same channel on two Transcribers at once', () => {
        it('do not share temporary files', async () => {
            const channel = {
                id: 7, enableLiveTranscripts: false, keepAudio: true, compressAudio: false,
                transcriberProfile: { config: { type: 'fake', languages: [] } }, translations: [],
            };
            fs.writeFileSync(path.join(storage, `${LIVE}-7.wav`), 'existing');
            const used = [];
            const instances = [new ASR({ id: LIVE }, channel), new ASR({ id: LIVE }, channel)];
            for (const asr of instances) {
                await asr._transitionLock;
                asr.audioFile.write(Buffer.from([1, 2]));
                await new Promise((resolve) => asr.audioFile.close(resolve));
                asr.hasAudio = async () => true;
                asr.transcodeToWav = async (input, output) => {
                    used.push(output);
                    fs.writeFileSync(output, 'temp');
                    await wait(30);
                };
                asr.concatAudioFiles = async (first, second, output) => {
                    used.push(output);
                    fs.writeFileSync(output, 'merged');
                    await wait(30);
                };
            }
            // Each in its own process: no shared per-process save queue.
            await Promise.all(instances.map((asr) => asr._saveAudio()));
            assert.strictEqual(used.length, 4);
            assert.strictEqual(new Set(used).size, 4, `temporary files shared: ${used.map((p) => path.basename(p))}`);
        });
    });
});
