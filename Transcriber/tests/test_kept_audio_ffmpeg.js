/**
 * Kept audio saved with the REAL ffmpeg/ffprobe of the Transcriber image.
 *
 * A stream that received no audio used to be transcoded too: for MP3 that
 * yields a file of headers only, with no audio frame. As the first stream of a
 * channel it became the channel's file, and every later concat onto it failed
 * (ffprobe exit 1); appended to an existing file, the concat failed as well,
 * leaving its raw and temporary files behind. Empty streams are now skipped,
 * and a channel file holding no audio is replaced instead of concatenated to.
 * A WAV channel still gets a file, empty, when its streams received no audio:
 * studio-api waits for one. Whether a file holds audio is decided on evidence
 * only: when ffprobe cannot tell, the save fails and nothing is deleted.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const ffmpeg = require('fluent-ffmpeg');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

// One second of 16 kHz mono S16LE noise.
function oneSecond() {
    const buf = Buffer.alloc(32000);
    for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE((Math.random() * 8000 | 0) - 4000, i);
    return buf;
}

function duration(file) {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
}

describe('Kept audio with the real ffmpeg', function () {
    this.timeout(30000);
    let ASR;
    let teardown;
    let storage;

    before(() => {
        teardown = setupMocks({
            invalidate: [fromTranscriber('ASR/index.js'), fromTranscriber('ASR/fake/index.js')],
            mockWs: false,
            circularBuffer: true,
        });
        ASR = require('../ASR/index.js');
    });
    after(() => { if (teardown) teardown(); });

    beforeEach(() => {
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-audio-ffmpeg-'));
        process.env.AUDIO_STORAGE_PATH = storage;
    });
    afterEach(() => {
        fs.rmSync(storage, { recursive: true, force: true });
        delete process.env.AUDIO_STORAGE_PATH;
    });

    // One stream of the channel: keeps `audio`, then stops (dispose saves it).
    async function stream(compressAudio, audio, saved = true) {
        const asr = new ASR({ id: 's' }, {
            id: 'c', enableLiveTranscripts: false, keepAudio: true, compressAudio,
            transcriberProfile: { config: { type: 'fake', languages: [] } }, translations: [],
        });
        asr.on('error', () => {}); // a failed save is reported as an 'error' event
        await asr._transitionLock;
        if (audio) asr.audioFile.write(audio);
        assert.strictEqual(await asr.dispose(), saved, saved ? 'saved without error' : 'the save fails');
        return asr;
    }

    // ffprobe failing as when it cannot run or read the file.
    async function withBrokenFfprobe(fn) {
        const ffprobe = ffmpeg.ffprobe;
        ffmpeg.ffprobe = (file, cb) => cb(new Error('spawn ffprobe EAGAIN'));
        try {
            return await fn();
        } finally {
            ffmpeg.ffprobe = ffprobe;
        }
    }

    const leftovers = () => fs.readdirSync(storage).filter((f) => !/^s-c\.(wav|mp3)$/.test(f));

    for (const [format, compressAudio] of [['wav', false], ['mp3', true]]) {
        describe(format, () => {
            const kept = () => path.join(storage, `s-c.${format}`);

            it('saves a stream into the channel file', async () => {
                await stream(compressAudio, oneSecond());
                assert.ok(Math.abs(duration(kept()) - 1) < 0.15, `duration ${duration(kept())}`);
                assert.deepStrictEqual(leftovers(), []);
            });

            it('appends the next stream', async () => {
                await stream(compressAudio, oneSecond());
                await stream(compressAudio, oneSecond());
                assert.ok(Math.abs(duration(kept()) - 2) < 0.2, `duration ${duration(kept())}`);
                assert.deepStrictEqual(leftovers(), []);
            });

            if (format === 'wav') {
                it('saves an empty WAV for a channel whose stream received no audio', async () => {
                    await stream(compressAudio, null);
                    assert.deepStrictEqual(fs.readdirSync(storage), ['s-c.wav'], 'no raw file');
                    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', kept()]).toString().trim();
                    assert.strictEqual(probe, 'pcm_s16le', 'a valid WAV');
                });
            } else {
                it('saves nothing for a stream that received no audio', async () => {
                    await stream(compressAudio, null);
                    assert.deepStrictEqual(fs.readdirSync(storage), [], 'no channel file, no raw file');
                });
            }

            it('appends the audio of a stream that follows streams with no audio', async () => {
                await stream(compressAudio, null);
                await stream(compressAudio, null);
                await stream(compressAudio, oneSecond());
                assert.ok(Math.abs(duration(kept()) - 1) < 0.15, `duration ${duration(kept())}`);
                assert.deepStrictEqual(leftovers(), []);
            });

            it('keeps the channel file and the stream\'s raw audio when ffprobe cannot tell', async () => {
                await stream(compressAudio, oneSecond());
                const before = fs.readFileSync(kept());
                const asr = await withBrokenFfprobe(() => stream(compressAudio, oneSecond(), false));
                assert.ok(fs.readFileSync(kept()).equals(before), 'the channel file is unchanged');
                assert.deepStrictEqual(leftovers(), [path.basename(asr.audioPcmPath)], 'the raw audio is kept, no temporary file');
                assert.strictEqual(fs.statSync(asr.audioPcmPath).size, 32000);
            });

            it('leaves the channel file intact after a stream that received no audio', async () => {
                await stream(compressAudio, oneSecond());
                const size = fs.statSync(kept()).size;
                await stream(compressAudio, null);
                assert.strictEqual(fs.statSync(kept()).size, size);
                assert.deepStrictEqual(leftovers(), []);
            });

            it('replaces a channel file holding no audio (as saved from an empty stream before)', async () => {
                const empty = path.join(storage, 'empty.pcm');
                fs.writeFileSync(empty, Buffer.alloc(0));
                const codec = compressAudio ? 'libmp3lame' : 'pcm_s16le';
                execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', empty, '-c:a', codec, kept()]);
                fs.unlinkSync(empty);
                await stream(compressAudio, oneSecond());
                assert.ok(Math.abs(duration(kept()) - 1) < 0.15, `duration ${duration(kept())}`);
                assert.deepStrictEqual(leftovers(), []);
            });
        });
    }

    describe('hasAudio()', () => {
        const asr = () => new ASR({ id: 's' }, {
            id: 'c', enableLiveTranscripts: false, keepAudio: false,
            transcriberProfile: { config: { type: 'fake', languages: [] } }, translations: [],
        });
        const encode = (name, codec, audio) => {
            const raw = path.join(storage, `${name}.pcm`);
            fs.writeFileSync(raw, audio);
            const out = path.join(storage, name);
            execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', raw, '-c:a', codec, out]);
            return out;
        };

        it('is true for a file holding audio', async () => {
            assert.strictEqual(await asr().hasAudio(encode('a.mp3', 'libmp3lame', oneSecond())), true);
            assert.strictEqual(await asr().hasAudio(encode('a.wav', 'pcm_s16le', oneSecond())), true);
        });

        it('is false for a file encoded from no audio', async () => {
            assert.strictEqual(await asr().hasAudio(encode('e.mp3', 'libmp3lame', Buffer.alloc(0))), false);
            assert.strictEqual(await asr().hasAudio(encode('e.wav', 'pcm_s16le', Buffer.alloc(0))), false);
        });

        it('is unknown (null) when the file or ffprobe cannot be read', async () => {
            assert.strictEqual(await asr().hasAudio(path.join(storage, 'missing.mp3')), null);
            const file = encode('a.mp3', 'libmp3lame', oneSecond());
            assert.strictEqual(await withBrokenFfprobe(() => asr().hasAudio(file)), null);
        });

        it('is unknown (null) for an unreadable file larger than headers only', async () => {
            const file = path.join(storage, 'corrupt.mp3');
            fs.writeFileSync(file, Buffer.alloc(8192, 7));
            assert.strictEqual(await asr().hasAudio(file), null);
        });
    });
});
