/**
 * K2 — the per-stream RECORDING split, end to end on a real filesystem.
 *
 * In per-stream mode N sub-ASR share ONE channel, hence ONE
 * `${session}-${channel}.pcm` path. Letting each of them own a write stream
 * interleaved their audio and — far worse — made EVERY participant teardown run
 * saveAudio(): transcode, concat, rename and finally `unlinkSync(pcm)`. The
 * first participant to leave therefore destroyed the channel's archive
 * mid-call, and every sibling's next write hit a deleted inode (ENOENT).
 *
 * The split: the archive is owned by ONE dedicated recorder ASR (`${ck}#rec`,
 * built {recordOnly:true, record:true}) fed with the bot's mixed 0x02 flow; the
 * participant sub-ASR are built {record:false} and never touch the file.
 *
 * Covered here:
 *   - the whole recording lifecycle: one .pcm, one output file, no participant
 *     write stream, no 'error' event;
 *   - the K2 scenario itself: a mid-call leave (and two simultaneous leaves)
 *     leave the channel .pcm byte-for-byte intact and the siblings streaming;
 *   - cap accounting: the recorder is not a cap slot;
 *   - teardown ordering: the recorder is never flushed, the end-of-stream
 *     marker is emitted exactly once by a PARTICIPANT, the recorder is disposed
 *     LAST and saveAudio() runs exactly once (and not at all when nobody spoke);
 *   - K1 / C4 / C8 / C9 teardown races driven through the REAL server wiring;
 *   - LEGACY non-regression: a keepAudio non-per-stream channel keeps its exact
 *     file lifecycle, including the reconnect concat branch.
 *
 * Plumbing: same as test_perstream_hardening.js (SRT/RTMP mocked in
 * require.cache, StreamingServer hand-built via Object.create) PLUS a
 * fluent-ffmpeg stub that really reads its inputs and writes its output, so the
 * assertions are made against actual files rather than against a spy.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, before, after, beforeEach } = require('mocha');
const EventEmitter = require('eventemitter3');
const { setupMocks, fromTranscriber } = require('./helpers/asr_mocks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fluent-ffmpeg stub: honours the exact chains ASR/index.js builds
//   transcodeToWav : ffmpeg(in).inputFormat().inputOptions().audioCodec().output(out).on().run()
//   transcodeToMp3 : ffmpeg(in).inputFormat().inputOptions().audioCodec().audioBitrate().on().save(out)
//   concatAudioFiles: ffmpeg(in1).input(in2).on().mergeToFile(out, '/tmp')
// It concatenates its inputs into the output so the produced file's CONTENT is
// assertable (e.g. "the archive holds the mixed flow only").
// ---------------------------------------------------------------------------
const ffmpegCalls = [];
function ffmpegMock(input) {
  const state = { inputs: [input], output: null, handlers: {} };
  const api = {
    inputFormat() { return api; },
    inputOptions() { return api; },
    audioCodec() { return api; },
    audioBitrate() { return api; },
    input(p) { state.inputs.push(p); return api; },
    output(p) { state.output = p; return api; },
    on(event, fn) { state.handlers[event] = fn; return api; },
    save(p) { finish('transcode', p); return api; },
    run() { finish('transcode', state.output); return api; },
    mergeToFile(p) { finish('concat', p); return api; },
  };
  function finish(op, out) {
    // Asynchronous like the real thing, so an await is genuinely required.
    setImmediate(() => {
      try {
        const data = Buffer.concat(state.inputs.map(i => fs.readFileSync(i)));
        fs.writeFileSync(out, data);
        ffmpegCalls.push({ op, inputs: [...state.inputs], output: out });
        if (state.handlers.end) state.handlers.end();
      } catch (error) {
        if (state.handlers.error) state.handlers.error(error);
      }
    });
  }
  return api;
}

// A streaming server stand-in: the per-stream participant map is opt-in so the
// same class covers the legacy (null map) path.
class DummyServer extends EventEmitter {
  constructor(app) { super(); this.app = app; this.participants = null; }
  start() {} stop() {} setSessions() {}
  getStreamParticipants() { return this.participants; }
}

describe('K2 per-stream recording split', () => {
  let StreamingServer, ASR, teardown, srtCache, rtmpCache, ffmpegCache, storageDir;
  const ORIG = {};

  before(() => {
    const srtPath = fromTranscriber('components/StreamingServer/srt/SRTServer.js');
    const rtmpPath = fromTranscriber('components/StreamingServer/rtmp/RTMPServer.js');
    srtCache = require.cache[srtPath];
    rtmpCache = require.cache[rtmpPath];
    require.cache[srtPath] = { id: srtPath, filename: srtPath, loaded: true, exports: DummyServer };
    require.cache[rtmpPath] = { id: rtmpPath, filename: rtmpPath, loaded: true, exports: DummyServer };

    const ffmpegPath = require.resolve('fluent-ffmpeg');
    ffmpegCache = require.cache[ffmpegPath];
    require.cache[ffmpegPath] = { id: ffmpegPath, filename: ffmpegPath, loaded: true, exports: ffmpegMock };

    teardown = setupMocks({
      invalidate: [
        fromTranscriber('ASR/index.js'),
        fromTranscriber('ASR/fake/index.js'),
        fromTranscriber('components/StreamingServer/index.js'),
      ],
      mockWs: false,
      circularBuffer: true,
    });
    const liveSrtPath = require.resolve('live-srt-lib');
    require.cache[liveSrtPath].exports.Component = require(fromTranscriber('../lib/component.js'));
    StreamingServer = require('../components/StreamingServer/index.js').StreamingServer;
    ASR = require('../ASR/index.js');

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linto-k2-'));
    for (const k of ['AUDIO_STORAGE_PATH', 'MIN_AUDIO_BUFFER', 'ASR_STOP_SETTLE_MS', 'ASR_STOP_FLUSH_TIMEOUT_MS']) {
      ORIG[k] = process.env[k];
    }
    process.env.AUDIO_STORAGE_PATH = storageDir;
    // 1 ms => 0-byte threshold with the SAMPLE_RATE/BYTES_PER_SAMPLE of tests.js:
    // every transcribe() forwards (and, for the recorder, writes) immediately.
    process.env.MIN_AUDIO_BUFFER = '1';
    process.env.ASR_STOP_SETTLE_MS = '1';
    process.env.ASR_STOP_FLUSH_TIMEOUT_MS = '50';
  });

  after(() => {
    if (teardown) teardown();
    const srtPath = fromTranscriber('components/StreamingServer/srt/SRTServer.js');
    const rtmpPath = fromTranscriber('components/StreamingServer/rtmp/RTMPServer.js');
    if (srtCache) require.cache[srtPath] = srtCache; else delete require.cache[srtPath];
    if (rtmpCache) require.cache[rtmpPath] = rtmpCache; else delete require.cache[rtmpPath];
    const ffmpegPath = require.resolve('fluent-ffmpeg');
    if (ffmpegCache) require.cache[ffmpegPath] = ffmpegCache; else delete require.cache[ffmpegPath];
    delete require.cache[fromTranscriber('components/StreamingServer/index.js')];
    delete require.cache[fromTranscriber('ASR/index.js')];
    for (const [k, v] of Object.entries(ORIG)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  });

  beforeEach(() => {
    for (const f of fs.readdirSync(storageDir)) fs.unlinkSync(path.join(storageDir, f));
    ffmpegCalls.length = 0;
  });

  // --- helpers -------------------------------------------------------------

  let seq = 0;
  function makeSession() { return { id: `sess${seq++}` }; }
  function makeChannel(over = {}) {
    return {
      id: 'chan',
      enableLiveTranscripts: true,
      keepAudio: true,
      compressAudio: false,
      transcriberProfile: { config: { type: 'fake', languages: [] } },
      translations: [],
      lastSegmentId: 0,
      ...over,
    };
  }

  function makeServer() {
    const inst = Object.create(StreamingServer.prototype);
    inst.app = {};
    inst.ASRs = new Map();
    inst.lastSegmentIds = new Map();
    inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
    inst.channels = new Map();
    inst.pendingLeaves = new Map();
    inst.servers = [];
    inst.channelReaperInterval = null;
    inst.channelReaperIntervalMs = 60000;
    inst.emitted = [];
    inst.emit = (...args) => { inst.emitted.push(args); return true; };
    return inst;
  }

  // Wire a real StreamingServer against a DummyServer through the REAL
  // initServer() handlers, so the tests drive the production event plumbing.
  async function wire(participants) {
    const inst = makeServer();
    await inst.initServer('SRT');
    const server = inst.servers[0];
    if (participants) server.participants = new Map(participants.map(p => [p.tag, p]));
    return { inst, server };
  }

  async function settleAll(inst) {
    await new Promise(r => setImmediate(r));
    for (const asr of inst.ASRs.values()) {
      if (asr && asr._transitionLock) await asr._transitionLock;
      // The transition lock only proves init() RAN. init() creates the archive
      // with fs.createWriteStream(), whose inode appears on the stream's
      // ASYNCHRONOUS 'open' — so an assertion on listFiles() made right after
      // settleAll() raced that open and intermittently saw an empty directory
      // (~8% of full runs). Wait for the file to actually exist.
      const file = asr && asr.audioFile;
      if (file && file.pending) {
        await new Promise(resolve => {
          file.once('open', resolve);
          file.once('error', resolve); // a failed open must not hang the suite
        });
      }
    }
  }

  async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(5);
    }
    return false;
  }

  const listFiles = () => fs.readdirSync(storageDir).sort();
  const pcmOf = (session) => path.join(storageDir, `${session.id}-chan.pcm`);
  const wavOf = (session) => path.join(storageDir, `${session.id}-chan.wav`);

  // 'error' is emitted by ASR.dispose() on failure, but _stopAsr detaches every
  // listener BEFORE disposing, so a plain .on('error') would never see it (and
  // eventemitter3 does not throw on an unhandled 'error'). Patch emit instead:
  // it survives removeAllListeners().
  function watchErrors(asr, sink) {
    if (!asr || asr.__errorWatched) return asr;
    asr.__errorWatched = true;
    const origEmit = asr.emit.bind(asr);
    asr.emit = (event, ...args) => {
      if (event === 'error') sink.push(args[0]);
      return origEmit(event, ...args);
    };
    return asr;
  }
  function watchAll(inst, sink) {
    for (const asr of inst.ASRs.values()) watchErrors(asr, sink);
    return sink;
  }

  const subKeysOf = (inst, ck) => [...inst.ASRs.keys()].filter(k => k.startsWith(`${ck}#`) && !k.endsWith('#rec'));

  // -------------------------------------------------------------------------
  // 1. Recording lifecycle
  // -------------------------------------------------------------------------

  describe('recording lifecycle', () => {
    it('keeps ONE .pcm, ONE output file, and no participant ever opens a write stream', async () => {
      const { inst, server } = await wire([
        { id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }, { id: 'u2', name: 'P2', tag: 2 },
      ]);
      const session = makeSession();
      const channel = makeChannel();
      const ck = `${session.id}_chan`;
      const errors = [];

      server.emit('session-start', session, channel);
      const recorder = watchErrors(inst.ASRs.get(`${ck}#rec`), errors);
      assert.ok(recorder, 'a dedicated recorder ASR owns the archive');
      assert.strictEqual(recorder.recordOnly, true);
      assert.strictEqual(recorder.record, true);
      await settleAll(inst);
      assert.ok(recorder.audioFile, 'the recorder opened the single channel .pcm');
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.pcm`], 'exactly one file so far');

      // N tagged participant flows, then the bot's mixed flow.
      for (const tag of [0, 1, 2]) {
        server.emit('data', Buffer.from([tag, 1, 2, 3]), session.id, 'chan', tag, tag * 100);
      }
      await settleAll(inst);
      watchAll(inst, errors);
      for (const tag of [0, 1, 2]) {
        server.emit('data', Buffer.from([tag, 4, 5, 6]), session.id, 'chan', tag, 400 + tag * 100);
      }
      for (let i = 0; i < 4; i++) {
        server.emit('record-data', Buffer.from([9, 9, 9, 9]), session.id, 'chan');
      }
      await settleAll(inst);

      // Not one participant sub-ASR owns a write stream.
      const tagKeys = subKeysOf(inst, ck);
      assert.deepStrictEqual(tagKeys.sort(), [`${ck}#0`, `${ck}#1`, `${ck}#2`]);
      for (const key of tagKeys) {
        assert.strictEqual(inst.ASRs.get(key).audioFile, undefined,
          `${key} must never open the channel archive`);
        assert.strictEqual(inst.ASRs.get(key).record, false);
      }
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.pcm`], 'still exactly one .pcm');

      await inst._stopAsr(session, 'chan');
      assert.ok(await waitFor(() => fs.existsSync(wavOf(session)) && !fs.existsSync(pcmOf(session))),
        'the archive is transcoded and the .pcm removed');

      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.wav`], 'exactly one output file remains');
      assert.deepStrictEqual(ffmpegCalls.map(c => c.op), ['transcode'], 'saveAudio ran exactly once');
      assert.deepStrictEqual(ffmpegCalls[0].inputs, [pcmOf(session)]);
      // The archive holds the MIXED flow only — no participant audio leaked in.
      const archived = fs.readFileSync(wavOf(session));
      assert.strictEqual(archived.length, 16, '4 mixed frames of 4 bytes');
      assert.ok(archived.every(b => b === 9), 'only the bot mix reached the archive');
      assert.deepStrictEqual(errors, [], "no ASR emitted 'error'");
    });

    it('drops the mixed flow with a single warning when the channel keeps no audio', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      assert.strictEqual(inst.ASRs.has(`${session.id}_chan#rec`), false, 'no recorder without keepAudio');

      // The bot ships a mix anyway: it must be dropped, never routed to a sub-ASR.
      for (let i = 0; i < 3; i++) server.emit('record-data', Buffer.from([9, 9]), session.id, 'chan');
      await settleAll(inst);
      assert.strictEqual(inst.ASRs.size, 0, 'the mix created no ASR at all');
      assert.deepStrictEqual(listFiles(), [], 'nothing was written');
    });
  });

  // -------------------------------------------------------------------------
  // 2. The K2 scenario: a mid-call leave must not destroy the archive
  // -------------------------------------------------------------------------

  describe('a participant leave never touches the channel archive', () => {
    const MIXED_FRAMES = 3, MIXED_FRAME_BYTES = 4;

    async function startChannel(inst, server, session, channel, tags) {
      server.emit('session-start', session, channel);
      await settleAll(inst);
      for (const tag of tags) server.emit('data', Buffer.from([tag, 1, 2, 3]), session.id, 'chan', tag, 0);
      await settleAll(inst);
      for (let i = 0; i < MIXED_FRAMES; i++) {
        server.emit('record-data', Buffer.alloc(MIXED_FRAME_BYTES, 9), session.id, 'chan');
      }
      await settleAll(inst);
      // The write stream flushes asynchronously: settle on the archive size
      // before any test snapshots it.
      const expected = MIXED_FRAMES * MIXED_FRAME_BYTES;
      assert.ok(await waitFor(() => fs.statSync(pcmOf(session)).size === expected),
        'the mixed flow landed in the .pcm');
    }

    it('one leave mid-call: the .pcm is untouched, no ENOENT, siblings keep transcribing', async () => {
      const parts = [{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }, { id: 'u2', name: 'P2', tag: 2 }];
      const { inst, server } = await wire(parts);
      const session = makeSession();
      const ck = `${session.id}_chan`;
      await startChannel(inst, server, session, makeChannel(), [0, 1, 2]);
      const errors = watchAll(inst, []);
      assert.strictEqual(subKeysOf(inst, ck).length, 3);

      const sizeBefore = fs.statSync(pcmOf(session)).size;
      assert.ok(sizeBefore > 0, 'the mixed flow really landed in the .pcm');
      const leaver = inst.ASRs.get(`${ck}#1`);

      server.emit('participant-leave', session.id, 'chan', 1);
      assert.ok(await waitFor(() => leaver.provider === null), 'the leaver was disposed');

      assert.ok(fs.existsSync(pcmOf(session)), 'the channel archive still exists (no unlink)');
      assert.strictEqual(fs.statSync(pcmOf(session)).size, sizeBefore, 'the archive is byte-for-byte intact');
      assert.deepStrictEqual(ffmpegCalls, [], 'a participant leave runs no transcode/concat');
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.pcm`], 'no stray output file');

      // Siblings keep streaming, and the recorder keeps appending.
      const sibling = inst.ASRs.get(`${ck}#0`);
      const beforeBytes = sibling.provider.byteCount;
      server.emit('data', Buffer.from([0, 7, 7, 7]), session.id, 'chan', 0, 500);
      server.emit('record-data', Buffer.from([9, 9, 9, 9]), session.id, 'chan');
      await settleAll(inst);
      assert.ok(sibling.provider.byteCount > beforeBytes, 'a sibling still transcribes');
      assert.ok(await waitFor(() => fs.statSync(pcmOf(session)).size > sizeBefore),
        'the recorder still appends to a live file (no ENOENT)');
      assert.deepStrictEqual(errors, [], "no ASR emitted 'error' (an unlinked .pcm would)");
    });

    it('two simultaneous leaves are equally harmless', async () => {
      const parts = [{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }, { id: 'u2', name: 'P2', tag: 2 }];
      const { inst, server } = await wire(parts);
      const session = makeSession();
      const ck = `${session.id}_chan`;
      await startChannel(inst, server, session, makeChannel(), [0, 1, 2]);
      const errors = watchAll(inst, []);

      const sizeBefore = fs.statSync(pcmOf(session)).size;
      const first = inst.ASRs.get(`${ck}#1`);
      const second = inst.ASRs.get(`${ck}#2`);

      server.emit('participant-leave', session.id, 'chan', 1);
      server.emit('participant-leave', session.id, 'chan', 2);
      assert.ok(await waitFor(() => first.provider === null && second.provider === null));

      assert.ok(fs.existsSync(pcmOf(session)));
      assert.strictEqual(fs.statSync(pcmOf(session)).size, sizeBefore);
      assert.deepStrictEqual(subKeysOf(inst, ck), [`${ck}#0`], 'only the leavers were removed');
      assert.ok(inst.ASRs.has(`${ck}#rec`), 'the recorder survived both leaves');
      assert.deepStrictEqual(errors, []);

      // The channel still stops cleanly and produces exactly one output file.
      await inst._stopAsr(session, 'chan');
      assert.ok(await waitFor(() => fs.existsSync(wavOf(session)) && !fs.existsSync(pcmOf(session))));
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.wav`]);
      assert.deepStrictEqual(ffmpegCalls.map(c => c.op), ['transcode'], 'still exactly one saveAudio');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cap accounting: the recorder is not a cap slot
  // -------------------------------------------------------------------------

  describe('cap accounting with a recorder present', () => {
    it('the 6th distinct tag still gets its OWN sub-ASR; only the 7th collapses onto 255', async () => {
      const orig = process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
      process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = '6';
      try {
        const parts = [];
        for (let t = 0; t < 8; t++) parts.push({ id: `u${t}`, name: `P${t}`, tag: t });
        const { inst, server } = await wire(parts);
        inst.maxAsrPerChannel = StreamingServer._resolveCap(process.env.MAX_CONCURRENT_ASR_PER_CHANNEL);
        const session = makeSession();
        const ck = `${session.id}_chan`;

        server.emit('session-start', session, makeChannel());
        await settleAll(inst);
        assert.ok(inst.ASRs.has(`${ck}#rec`), 'precondition: a recorder is present');

        for (let t = 0; t < 6; t++) {
          server.emit('data', Buffer.from([t]), session.id, 'chan', t, t * 10);
        }
        await settleAll(inst);
        assert.deepStrictEqual(subKeysOf(inst, ck).sort(),
          [0, 1, 2, 3, 4, 5].map(t => `${ck}#${t}`).sort(),
          'the recorder consumed none of the 6 cap slots');
        assert.strictEqual(inst.ASRs.has(`${ck}#255`), false, 'no overflow yet');
        assert.strictEqual(inst.ASRs.size, 7, '6 dedicated + the recorder');

        // Only the 7th distinct tag exceeds the cap.
        server.emit('data', Buffer.from([6]), session.id, 'chan', 6, 100);
        await settleAll(inst);
        assert.ok(inst.ASRs.has(`${ck}#255`), 'the 7th tag collapses onto the shared overflow ASR');
        assert.strictEqual(inst.ASRs.has(`${ck}#6`), false);
        assert.strictEqual(inst.ASRs.size, 8, '6 dedicated + overflow + the recorder');

        await inst._stopAsr(session, 'chan');
        await waitFor(() => !fs.existsSync(pcmOf(session)));
      } finally {
        if (orig === undefined) delete process.env.MAX_CONCURRENT_ASR_PER_CHANNEL;
        else process.env.MAX_CONCURRENT_ASR_PER_CHANNEL = orig;
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. Teardown ordering
  // -------------------------------------------------------------------------

  describe('channel teardown ordering', () => {
    // Stand-ins: the ordering assertions need a controllable, instant flush.
    function fakeAsr(name, log) {
      return {
        name, flushCount: 0, markerCount: 0, detached: false, disposed: false,
        async flushFinals() { this.flushCount += 1; log.push(`flush:${name}`); },
        streamStopped() { this.markerCount += 1; log.push(`marker:${name}`); },
        removeAllListeners() { this.detached = true; },
        dispose() { this.disposed = true; log.push(`dispose:${name}`); },
      };
    }

    it('never flushes the recorder, marks once on a PARTICIPANT, disposes the recorder LAST', async () => {
      const log = [];
      const inst = makeServer();
      const session = makeSession();
      const ck = `${session.id}_chan`;
      inst.channels.set(ck, { session, channel: makeChannel(), allocator: { next: 1 }, registeredAt: Date.now() });
      const p0 = fakeAsr('p0', log), p1 = fakeAsr('p1', log), rec = fakeAsr('rec', log);
      inst.ASRs.set(`${ck}#0`, p0);
      inst.ASRs.set(`${ck}#1`, p1);
      inst.ASRs.set(`${ck}#rec`, rec);

      await inst._stopAsr(session, 'chan');

      assert.strictEqual(rec.flushCount, 0,
        'flushing the recorder only costs ASR_STOP_SETTLE_MS on every channel stop');
      assert.strictEqual(p0.flushCount, 1);
      assert.strictEqual(p1.flushCount, 1);
      assert.strictEqual(rec.markerCount, 0, 'the recorder has no captions, so no end-of-stream marker');
      assert.strictEqual(p0.markerCount + p1.markerCount, 1, 'exactly ONE marker for the channel');
      const markerIndex = log.findIndex(e => e.startsWith('marker:'));
      assert.ok(log.indexOf('flush:p0') < markerIndex && log.indexOf('flush:p1') < markerIndex,
        'the marker stays the provably-last final');
      assert.strictEqual(log[log.length - 1], 'dispose:rec',
        'the recorder is disposed LAST, once everything else is quiesced');
      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1);
    });

    it('saveAudio() runs exactly once, on the recorder, after the participants are gone', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel());
      await settleAll(inst);
      const recorder = inst.ASRs.get(`${session.id}_chan#rec`);
      let saveCount = 0;
      const origSave = recorder.saveAudio.bind(recorder);
      recorder.saveAudio = async () => { saveCount += 1; return origSave(); };

      server.emit('data', Buffer.from([0, 1, 2, 3]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      server.emit('record-data', Buffer.from([9, 9, 9, 9]), session.id, 'chan');
      await settleAll(inst);

      await inst._stopAsr(session, 'chan');
      assert.ok(await waitFor(() => fs.existsSync(wavOf(session))));
      await sleep(20); // leave room for a spurious second call to show up
      assert.strictEqual(saveCount, 1, 'exactly one saveAudio for the whole channel');
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.wav`]);
    });

    it('nobody spoke: no marker, no transcode, the empty .pcm is removed, session-stop still fires', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel());
      await settleAll(inst);
      const errors = watchAll(inst, []);
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.pcm`], 'the recorder opened its file');
      // No tagged frame and no mixed frame: only the recorder exists.
      assert.strictEqual(inst.ASRs.size, 1);

      const ret = await inst._stopAsr(session, 'chan');

      assert.strictEqual(ret, true);
      const blankFinals = inst.emitted.filter(e => e[0] === 'final' && e[1] && e[1].text === '');
      assert.strictEqual(blankFinals.length, 0, 'no blank caption row for a channel nobody spoke on');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'the deactivate is still published, the session is not stuck');
      assert.ok(await waitFor(() => !fs.existsSync(pcmOf(session))), 'the 0-byte .pcm is dropped');
      assert.deepStrictEqual(listFiles(), [], 'ffmpeg is never run on an empty input');
      assert.deepStrictEqual(ffmpegCalls, []);
      assert.deepStrictEqual(errors, []);
    });
  });

  // -------------------------------------------------------------------------
  // 4b. Failure paths around the archive owner
  // -------------------------------------------------------------------------

  describe('archive failure paths', () => {
    it('dispose() settles when the archive stream errors instead of hanging forever', async () => {
      const session = makeSession();
      const asr = new ASR(session, makeChannel(), { recordOnly: true, record: true });
      await settleAll({ ASRs: new Map([['x', asr]]) });
      const realStream = asr.audioFile;

      // Node documents writable.end(cb) as "if an error occurs, the callback MAY
      // OR MAY NOT be called with the error": model the MAY-NOT case of a stream
      // that errored (ENOSPC / EACCES on AUDIO_STORAGE_PATH). Before the fix the
      // end() promise never settled and dispose() held the ASR, its provider and
      // its listeners for the process lifetime.
      const stuck = new EventEmitter();
      stuck.bytesWritten = 0;
      stuck.end = () => { /* never calls back */ };
      asr.audioFile = stuck;

      const disposed = asr.dispose();
      // dispose() first awaits the transition lock, so the stream's error can
      // land before or after end() is called: keep raising it until it is heard.
      const raising = setInterval(() => stuck.emit('error', new Error('ENOSPC: no space left on device')), 5);
      const outcome = await Promise.race([disposed, sleep(500).then(() => 'HUNG')]);
      clearInterval(raising);

      assert.notStrictEqual(outcome, 'HUNG', 'dispose() must not hang on an errored write stream');
      assert.strictEqual(asr.provider, null, 'the provider and its listeners were released');
      realStream.destroy();
    });

    it("every ASR the server creates carries an 'error' listener", async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel());
      await settleAll(inst);
      server.emit('data', Buffer.from([0, 1, 2, 3]), session.id, 'chan', 0, 0);
      await settleAll(inst);

      // ASR emits 'error' on an init failure and on a dispose/saveAudio failure
      // — a failed ffmpeg transcode of the archive being the likeliest one, and
      // K2 puts a second, transcode-owning ASR (the recorder) on that path.
      // eventemitter3's emit() returns true only when a listener is attached.
      for (const key of [`${session.id}_chan#rec`, `${session.id}_chan#0`]) {
        const asr = inst.ASRs.get(key);
        assert.ok(asr, `precondition: ${key} exists`);
        assert.strictEqual(asr.emit('error', new Error('ffmpeg exited 1')), true,
          `${key} must have an 'error' listener`);
      }

      await inst._stopAsr(session, 'chan');
      await waitFor(() => !fs.existsSync(pcmOf(session)));
    });

    // _wireAsrErrors exists precisely for this: ASR.dispose() emits 'error' when
    // saveAudio() fails (a failed ffmpeg transcode of the archive being the
    // likeliest production cause), and the listener names the failure by its ASR
    // key. Detaching the recorder BEFORE disposing it threw that listener away
    // one line before the emit, so the only ASR-key-qualified log line naming
    // which channel's archive died was never produced. Unlike a participant
    // sub-ASR — where the pre-detach is load-bearing, it stops a late
    // partial/final escaping after the end-of-stream marker — the recorder has
    // no partial/final wiring at all, and dispose() detaches on its way out.
    it("the recorder's archive failure still reaches its 'error' listener on stop", async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      const ck = `${session.id}_chan`;
      server.emit('session-start', session, makeChannel());
      await settleAll(inst);
      server.emit('data', Buffer.from([1]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      server.emit('record-data', Buffer.from([9, 9, 9, 9]), session.id, 'chan');
      await settleAll(inst);

      const recorder = inst.ASRs.get(`${ck}#rec`);
      assert.ok(recorder, 'precondition: the channel has its archive owner');
      recorder.saveAudio = async () => { throw new Error('ffmpeg exited 1'); };

      // eventemitter3's emit() returns true ONLY when a listener is attached, so
      // this records whether _wireAsrErrors' handler was still there at the emit.
      let heardByAListener = null;
      const origEmit = recorder.emit.bind(recorder);
      recorder.emit = (event, ...args) => {
        const had = origEmit(event, ...args);
        if (event === 'error') heardByAListener = had;
        return had;
      };

      await inst._stopAsr(session, 'chan');
      assert.ok(await waitFor(() => heardByAListener !== null),
        "the archive failure was reported as an 'error'");
      assert.strictEqual(heardByAListener, true,
        `${ck}#rec must still carry its 'error' listener when dispose() reports the failure`);
    });

    it('a mixed frame for an unknown channel warns once, and the entry is reaped', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      // A stale bot still shipping the 0x02 flow after its channel was torn
      // down: the ck never had a channel context, so neither _cleanupPerStream
      // nor the channel loop of the reaper can reach its throttle entry.
      for (let i = 0; i < 3; i++) server.emit('record-data', Buffer.from([9, 9]), 'ghost', 'chan');
      assert.deepStrictEqual([...inst._noRecorderWarned], ['ghost_chan'], 'warned exactly once');
      assert.strictEqual(inst.ASRs.size, 0, 'the stray mix created no ASR');
      assert.deepStrictEqual(listFiles(), [], 'and wrote nothing');

      inst.reapOrphanChannels();
      assert.strictEqual(inst._noRecorderWarned.has('ghost_chan'), false,
        'the throttle entry is not kept for the process lifetime');
    });
  });

  // -------------------------------------------------------------------------
  // 5. K1 / C4 / C8 / C9 through the real wiring, with real ASR
  // -------------------------------------------------------------------------

  describe('teardown races (K1, C4, C8, C9) on the real event path', () => {
    // Hold a channel inside _stopAsr's flush window: FakeTranscriber.stop()
    // returns synchronously, which would close the window before a test can use it.
    function slowStop(asr, ms, onStop) {
      asr.provider.stop = () => new Promise(resolve => setTimeout(() => {
        if (onStop) onStop();
        asr.provider.emit('closed');
        resolve();
      }, ms));
    }

    it('C8 the FIRST frame of a new participant reaches the provider', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      await settleAll(inst);

      // Exactly the production sequence: the 'data' handler creates the sub-ASR
      // and transcribes into it in the SAME tick, before the async init().
      server.emit('data', Buffer.from([1, 2]), session.id, 'chan', 0, 0);
      const asr = inst.ASRs.get(`${session.id}_chan#0`);
      assert.ok(asr, 'the first frame created the sub-ASR');
      await settleAll(inst);
      server.emit('data', Buffer.from([3]), session.id, 'chan', 0, 100);

      assert.deepStrictEqual(Buffer.from(asr.provider.lastTranscribedBuffer), Buffer.from([1, 2, 3]),
        'the very first frame reached the provider with the rest');
    });

    it('C4 a tagged frame during teardown leaks no ASR and publishes nothing after the marker', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u5', name: 'P5', tag: 5 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      await settleAll(inst);
      server.emit('data', Buffer.from([1]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      slowStop(inst.ASRs.get(`${session.id}_chan#0`), 40);

      const stopP = inst._stopAsr(session, 'chan');
      // A frame for a participant who has no ASR yet lands mid-flush.
      server.emit('data', Buffer.from([2]), session.id, 'chan', 5, 10);
      assert.strictEqual(inst.ASRs.has(`${session.id}_chan#5`), false,
        'no sub-ASR is created for a stopping channel');
      await stopP;

      assert.strictEqual(inst.ASRs.size, 0, '0 orphans');
      const finals = inst.emitted.filter(e => e[0] === 'final');
      assert.strictEqual(finals.length, 1, 'only the end-of-stream marker was published');
      assert.strictEqual(finals[0][1].text, '');
    });

    it('C9 a leaving participant\'s trailing final precedes the end-of-stream marker', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }, { id: 'u1', name: 'P1', tag: 1 }]);
      const session = makeSession();
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      await settleAll(inst);
      server.emit('data', Buffer.from([1]), session.id, 'chan', 0, 0);
      server.emit('data', Buffer.from([1]), session.id, 'chan', 1, 0);
      await settleAll(inst);

      const leaver = inst.ASRs.get(`${session.id}_chan#0`);
      // The provider delivers one last recognized result while stopping.
      slowStop(leaver, 30, () => leaver.provider.emit('transcribed', { text: 'trailing', isPrimary: true }));

      server.emit('participant-leave', session.id, 'chan', 0);
      await inst._stopAsr(session, 'chan');

      const finals = inst.emitted.filter(e => e[0] === 'final').map(e => e[1].text);
      assert.ok(finals.includes('trailing'), "the leaver's trailing final was published");
      assert.strictEqual(finals[finals.length - 1], '',
        'the end-of-stream marker is the provably-LAST final of the channel');
      assert.ok(finals.indexOf('trailing') < finals.length - 1);
      const stopIndex = inst.emitted.findIndex(e => e[0] === 'session-stop');
      const markerIndex = inst.emitted.map(e => e[0] === 'final' && e[1].text === '').lastIndexOf(true);
      assert.ok(markerIndex < stopIndex, 'the deactivate is published after the marker');
    });

    it('K1 a reconnect during teardown keeps the successor context and its captions', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      const ck = `${session.id}_chan`;
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      await settleAll(inst);
      server.emit('data', Buffer.from([1]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      slowStop(inst.ASRs.get(`${ck}#0`), 40);
      const outgoingCtx = inst.channels.get(ck);

      const stopP = inst._stopAsr(session, 'chan');
      // The bot reconnects: cleanupWebsocket's session-stop is synchronous, so
      // the successor's session-start lands inside the outgoing flush window.
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      const successorCtx = inst.channels.get(ck);
      assert.notStrictEqual(successorCtx, outgoingCtx, 'a fresh context was registered');
      await stopP;

      assert.strictEqual(inst.channels.get(ck), successorCtx, "the successor's context survived the stop");
      // And the successor is not stranded: its frames still create sub-ASR.
      server.emit('data', Buffer.from([7]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      assert.ok(inst.ASRs.has(`${ck}#0`), 'the reconnected channel still produces captions');
    });

    // The K1 guard stopped one line short of the only externally-visible side
    // effect: 'session-stop' is wired to BrokerClient.deactivate(), which
    // publishes streamStatus 'inactive' for the CHANNEL. The outgoing stop's
    // flush awaits outlast the successor's session-start, so the deactivate
    // landed AFTER the successor's activate; the Scheduler's stale-owner guard
    // matches on transcriberId, which is identical for both connections of the
    // same process, so the channel went inactive and the session dropped back to
    // 'ready' while the successor was still streaming and publishing captions.
    it('K1 a superseded stop publishes no deactivate for the successor', async () => {
      const { inst, server } = await wire([{ id: 'u0', name: 'P0', tag: 0 }]);
      const session = makeSession();
      const ck = `${session.id}_chan`;
      server.emit('session-start', session, makeChannel({ keepAudio: false }));
      await settleAll(inst);
      server.emit('data', Buffer.from([1]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      slowStop(inst.ASRs.get(`${ck}#0`), 40);

      const stopP = inst._stopAsr(session, 'chan');
      server.emit('session-start', session, makeChannel({ keepAudio: false }));  // the reconnect
      await stopP;

      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-start').length, 2,
        'both connections activated the channel');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 0,
        "the superseded stop must not deactivate the successor's channel");

      // And the ordinary stop of the SUCCESSOR still deactivates normally.
      server.emit('data', Buffer.from([7]), session.id, 'chan', 0, 0);
      await settleAll(inst);
      await inst._stopAsr(session, 'chan');
      assert.strictEqual(inst.emitted.filter(e => e[0] === 'session-stop').length, 1,
        'the successor is deactivated by its own stop');
    });
  });

  // -------------------------------------------------------------------------
  // 6. LEGACY non-regression
  // -------------------------------------------------------------------------

  describe('LEGACY (non-per-stream) keepAudio channel', () => {
    it('keeps the exact .pcm -> .wav lifecycle (single ASR owning its own archive)', async () => {
      const { inst, server } = await wire(null); // getStreamParticipants -> null: legacy
      const session = makeSession();
      const channel = makeChannel();

      server.emit('session-start', session, channel);
      const asr = inst.ASRs.get(`${session.id}_chan`);
      assert.ok(asr, 'legacy registers ONE ASR under the bare channel key');
      assert.strictEqual(inst.channels.has(`${session.id}_chan`), false, 'no per-stream marker');
      assert.strictEqual(asr.record, true, 'the legacy ASR still owns the recording');
      assert.strictEqual(asr.recordOnly, false);
      const errors = watchAll(inst, []);
      await settleAll(inst);
      assert.ok(asr.audioFile, 'it opened the .pcm itself, exactly as before');

      // Legacy 3-arg data emits (SRT/RTMP/mixed WS all use this shape).
      for (let i = 0; i < 3; i++) server.emit('data', Buffer.from([1, 2, 3, 4]), session.id, 'chan');
      await settleAll(inst);
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.pcm`]);

      const ret = await inst._stopAsr(session, 'chan');
      assert.strictEqual(ret, true);
      assert.ok(await waitFor(() => fs.existsSync(wavOf(session)) && !fs.existsSync(pcmOf(session))));

      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.wav`]);
      assert.deepStrictEqual(ffmpegCalls.map(c => c.op), ['transcode'], 'first run: a plain transcode');
      assert.deepStrictEqual(ffmpegCalls[0].inputs, [pcmOf(session)]);
      assert.deepStrictEqual(ffmpegCalls[0].output, wavOf(session));
      const blankFinals = inst.emitted.filter(e => e[0] === 'final' && e[1].text === '');
      assert.strictEqual(blankFinals.length, 1, 'the legacy end-of-stream marker is unchanged');
      assert.deepStrictEqual(errors, []);
    });

    it('takes the reconnect CONCAT branch when an output file already exists', async () => {
      const { inst, server } = await wire(null);
      const session = makeSession();
      const wav = wavOf(session);
      const pcm = pcmOf(session);
      // A first stream of this channel already produced an archive.
      fs.writeFileSync(wav, Buffer.from([1, 1, 1, 1]));

      server.emit('session-start', session, makeChannel());
      const asr = inst.ASRs.get(`${session.id}_chan`);
      await settleAll(inst);
      for (let i = 0; i < 2; i++) server.emit('data', Buffer.from([2, 2]), session.id, 'chan');
      await settleAll(inst);

      await inst._stopAsr(session, 'chan');
      assert.ok(await waitFor(() => ffmpegCalls.length >= 2 && !fs.existsSync(pcm)));

      const tempOut = path.join(storageDir, `${session.id}-chan-temp.wav`);
      const tempOutput = path.join(storageDir, `${session.id}-chan-output.wav`);
      assert.deepStrictEqual(ffmpegCalls.map(c => c.op), ['transcode', 'concat']);
      assert.deepStrictEqual(ffmpegCalls[0], { op: 'transcode', inputs: [pcm], output: tempOut });
      assert.deepStrictEqual(ffmpegCalls[1], { op: 'concat', inputs: [wav, tempOut], output: tempOutput });
      // unlink(temp) + rename(output -> out) leave exactly one archive behind.
      assert.deepStrictEqual(listFiles(), [`${session.id}-chan.wav`]);
      const merged = fs.readFileSync(wav);
      assert.strictEqual(merged[0], 1, 'the previous archive comes first');
      assert.ok(merged.length > 4, 'the new segment was appended');
      assert.ok(asr.provider === null, 'the ASR was disposed');
    });
  });
});
