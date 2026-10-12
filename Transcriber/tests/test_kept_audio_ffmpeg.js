/**
 * Kept audio saved with the REAL ffmpeg/ffprobe of the Transcriber image.
 *
 * A stream that received no audio used to be transcoded too: for MP3 that
 * yields a file of headers only, with no audio frame. As the first stream of a
 * channel it became the channel's file, and every later concat onto it failed
 * (ffprobe exit 1); appended to an existing file, the concat failed as well,
 * leaving its raw and temporary files behind. Empty streams are now skipped,
 * and a channel file holding no audio is replaced instead of concatenated to.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
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
    async function stream(compressAudio, audio) {
        const asr = new ASR({ id: 's' }, {
            id: 'c', enableLiveTranscripts: false, keepAudio: true, compressAudio,
            transcriberProfile: { config: { type: 'fake', languages: [] } }, translations: [],
        });
        await asr._transitionLock;
        if (audio) asr.audioFile.write(audio);
        assert.strictEqual(await asr.dispose(), true, 'saved without error');
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

            it('saves nothing for a stream that received no audio', async () => {
                await stream(compressAudio, null);
                assert.deepStrictEqual(fs.readdirSync(storage), [], 'no channel file, no raw file');
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
});
