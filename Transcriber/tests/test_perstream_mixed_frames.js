/**
 * K2 — mixed-recording frame demux + the per-stream negotiation matrix.
 *
 *   1. WebsocketServer._parseMixedFrame / _parseTaggedFrame: the two decoders
 *      share one 8-byte header shape but must never cross-talk (a 0x02 frame is
 *      not a tagged frame and vice-versa), and both still reject a JSON control
 *      frame (0x7B) and anything shorter than the header.
 *   2. The initPcm callback routing: 0x02 -> 'record-data' (NEVER 'data', which
 *      would push the mix through the tag/cap/lazy-create logic and hand the
 *      whole meeting to one participant's sub-ASR), 0x01 -> the 5-arg tagged
 *      'data' WITH meetingTimeMs (C2), and the LEGACY (non-per-stream) callback
 *      forwarding every frame verbatim as the 3-arg 'data'.
 *   3. The full negotiation matrix
 *      (init.perStream x env flag x channel.keepAudio x init.mixedRecording)
 *      -> fd.perStream / fd.mixedRecording / the ACK the bot honours. The
 *      load-bearing cell is FAIL-CLOSED: keepAudio with a bot that cannot ship
 *      the mixed flow is DEMOTED to the legacy mixed path (a correct archive
 *      with degraded attribution) instead of N sub-ASR racing on one .pcm.
 *
 * The WebsocketServer needs no mocks (plain EventEmitter, real logger).
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('mocha');
const MultiplexedWebsocketServer = require('../components/StreamingServer/websocket/WebsocketServer');
// Captured HERE, at the same moment WebsocketServer captured its own reference,
// so the spy below patches the very object the server logs through (other suites
// swap the logger in require.cache from their before() hooks, which all run
// after this file is loaded).
const logger = require('../logger');

const MAGIC_TAGGED = 0x01;
const MAGIC_MIXED = 0x02;

function taggedFrame(tag, tMs, pcm) {
  const header = Buffer.alloc(8);
  header[0] = MAGIC_TAGGED;
  header[1] = tag & 0xff;
  header.writeUInt16LE(0, 2);
  header.writeUInt32LE(tMs >>> 0, 4);
  return Buffer.concat([header, pcm]);
}

function mixedFrame(tMs, pcm) {
  const header = Buffer.alloc(8);
  header[0] = MAGIC_MIXED;
  header[1] = 0; // no participant: this IS the mix
  header.writeUInt16LE(0, 2);
  header.writeUInt32LE(tMs >>> 0, 4);
  return Buffer.concat([header, pcm]);
}

function fakeWs() {
  return { sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on() {}, close() {} };
}

// ----------------------------------------------------------------------------
// 1. Frame decoding
// ----------------------------------------------------------------------------

describe('WebsocketServer mixed-recording framing (K2)', () => {
  let server;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
  });

  describe('_parseMixedFrame', () => {
    it('decodes a well-formed mixed frame', () => {
      const pcm = Buffer.from([0x11, 0x22, 0x33, 0x44]);
      const parsed = server._parseMixedFrame(mixedFrame(987654, pcm));
      assert.ok(parsed);
      assert.strictEqual(parsed.tMs, 987654);
      assert.deepStrictEqual(Buffer.from(parsed.pcm), pcm);
      assert.strictEqual('tag' in parsed, false, 'the mix carries no participant tag');
    });

    it('decodes a zero-length PCM payload (header only)', () => {
      const parsed = server._parseMixedFrame(mixedFrame(0, Buffer.alloc(0)));
      assert.ok(parsed);
      assert.strictEqual(parsed.pcm.length, 0);
    });

    it('returns null for a frame shorter than the 8-byte header', () => {
      assert.strictEqual(server._parseMixedFrame(Buffer.from([0x02, 0x00, 0x00])), null);
      assert.strictEqual(server._parseMixedFrame(Buffer.alloc(0)), null);
    });

    it('returns null for a JSON control frame (0x7B) and for non-Buffer input', () => {
      assert.strictEqual(server._parseMixedFrame(Buffer.from('{"type":"participant"}')), null);
      assert.strictEqual(server._parseMixedFrame('not a buffer'), null);
      assert.strictEqual(server._parseMixedFrame(null), null);
    });
  });

  describe('the two decoders never cross-talk', () => {
    it('_parseTaggedFrame rejects a mixed (0x02) frame', () => {
      assert.strictEqual(server._parseTaggedFrame(mixedFrame(1, Buffer.from([1, 2]))), null);
    });

    it('_parseMixedFrame rejects a tagged (0x01) frame', () => {
      assert.strictEqual(server._parseMixedFrame(taggedFrame(3, 1, Buffer.from([1, 2]))), null);
    });

    it('_parseTaggedFrame still rejects 0x7B and short frames (unchanged)', () => {
      assert.strictEqual(server._parseTaggedFrame(Buffer.from('{"type":"speakerChanged"}')), null);
      assert.strictEqual(server._parseTaggedFrame(Buffer.from([0x01, 0x02, 0x03])), null);
    });
  });
});

// ----------------------------------------------------------------------------
// 2. initPcm callback routing
// ----------------------------------------------------------------------------

describe('WebsocketServer per-stream frame routing', () => {
  const ORIG_FLAG = process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
  after(() => {
    if (ORIG_FLAG === undefined) delete process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
    else process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = ORIG_FLAG;
  });

  // Build a live per-stream callback through the REAL negotiation, so the test
  // exercises exactly what a bot's socket gets.
  function perStreamCallback(events, { keepAudio = false, mixedRecording = true } = {}) {
    process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = 'true';
    const server = new MultiplexedWebsocketServer({});
    server.on('data', (...args) => events.push(['data', ...args]));
    server.on('record-data', (...args) => events.push(['record-data', ...args]));
    const fd = { session: { id: 's' }, channel: { id: 'c', keepAudio } };
    const msg = Buffer.from(JSON.stringify({
      type: 'init', encoding: 'pcm', sampleRate: 16000,
      perStream: true, mixedRecording,
      participants: [{ id: 'u0', name: 'P0', tag: 0 }],
    }));
    const cb = server.handleInitMessage(fakeWs(), msg, fd);
    assert.strictEqual(fd.perStream, true, 'precondition: per-stream was granted');
    return { server, cb, fd };
  }

  it('routes a 0x02 frame to record-data and NEVER to data', () => {
    const events = [];
    const { cb } = perStreamCallback(events, { keepAudio: true });
    const pcm = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

    cb(mixedFrame(4242, pcm));

    assert.strictEqual(events.length, 1);
    const [type, audio, sessionId, channelId, ...rest] = events[0];
    assert.strictEqual(type, 'record-data');
    assert.deepStrictEqual(Buffer.from(audio), pcm, 'the PCM payload is forwarded, header stripped');
    assert.strictEqual(sessionId, 's');
    assert.strictEqual(channelId, 'c');
    assert.deepStrictEqual(rest, [], 'record-data carries no tag and no meeting clock');
    assert.strictEqual(events.filter(e => e[0] === 'data').length, 0,
      'the mix must never enter the tag/cap/lazy-create path');
  });

  it('routes a 0x01 frame to a tagged data emit WITH meetingTimeMs (C2)', () => {
    const events = [];
    const { cb } = perStreamCallback(events);
    const pcm = Buffer.from([1, 2, 3, 4]);

    cb(taggedFrame(7, 123456, pcm));

    assert.strictEqual(events.length, 1);
    const [type, audio, sessionId, channelId, tag, tMs] = events[0];
    assert.strictEqual(type, 'data');
    assert.deepStrictEqual(Buffer.from(audio), pcm);
    assert.strictEqual(sessionId, 's');
    assert.strictEqual(channelId, 'c');
    assert.strictEqual(tag, 7);
    assert.strictEqual(tMs, 123456, 'the per-frame meeting clock reaches the ASR timeline map');
  });

  it('drops short/invalid binary frames without emitting anything', () => {
    const events = [];
    const { cb } = perStreamCallback(events);
    cb(Buffer.from([MAGIC_TAGGED, 0x00, 0x00]));   // tagged, too short
    cb(Buffer.from([MAGIC_MIXED, 0x00, 0x00]));    // mixed, too short
    cb(Buffer.from([0x03, 0, 0, 0, 0, 0, 0, 0, 9])); // unknown magic
    assert.deepStrictEqual(events, []);
  });

  it('consumes a JSON control frame without emitting audio', () => {
    const events = [];
    const { cb } = perStreamCallback(events);
    cb(Buffer.from(JSON.stringify({
      type: 'participant', action: 'join', participant: { id: 'u1', name: 'Alice', tag: 1 },
    })));
    assert.deepStrictEqual(events, []);
  });

  // LEGACY non-regression: without per-stream, the callback forwards the frame
  // VERBATIM as the 3-arg 'data' — including a frame that happens to start with
  // 0x02, which must stay audio and never be re-read as a mixed header.
  it('the legacy (non-per-stream) callback forwards every frame verbatim as 3-arg data', () => {
    delete process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
    const server = new MultiplexedWebsocketServer({});
    const events = [];
    server.on('data', (...args) => events.push(['data', ...args]));
    server.on('record-data', (...args) => events.push(['record-data', ...args]));
    const fd = { session: { id: 's' }, channel: { id: 'c', keepAudio: true } };
    const msg = Buffer.from(JSON.stringify({
      type: 'init', encoding: 'pcm', sampleRate: 16000, perStream: true, mixedRecording: true,
    }));
    const cb = server.handleInitMessage(fakeWs(), msg, fd);
    assert.strictEqual(fd.perStream, false, 'precondition: the env flag is off');

    const looksMixed = mixedFrame(1, Buffer.from([5, 6]));
    cb(looksMixed);
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], ['data', looksMixed, 's', 'c'],
      'legacy stays a 3-arg emit of the untouched frame');
  });
});

// ----------------------------------------------------------------------------
// 3. Negotiation matrix
// ----------------------------------------------------------------------------

describe('per-stream / mixed-recording negotiation matrix', () => {
  const ORIG_FLAG = process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
  after(() => {
    if (ORIG_FLAG === undefined) delete process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
    else process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = ORIG_FLAG;
  });

  let seq = 0;
  function negotiate({ perStreamReq, envFlag, keepAudio, botCanMix }) {
    if (envFlag) process.env.TRANSCRIBER_PERSTREAM_DIARIZATION = 'true';
    else delete process.env.TRANSCRIBER_PERSTREAM_DIARIZATION;
    const server = new MultiplexedWebsocketServer({});
    const ws = fakeWs();
    const id = `n${seq++}`;
    const fd = { session: { id: `s${id}` }, channel: { id: `c${id}`, keepAudio } };
    const init = { type: 'init', encoding: 'pcm', sampleRate: 16000, participants: [{ id: 'u0', name: 'P0', tag: 0 }] };
    if (perStreamReq) init.perStream = true;
    if (botCanMix) init.mixedRecording = true;
    const cb = server.handleInitMessage(ws, Buffer.from(JSON.stringify(init)), fd);
    return { server, fd, cb, ack: ws.sent.find(m => m.type === 'ack'), sid: fd.session.id, cid: fd.channel.id };
  }

  const BOOLS = [false, true];
  for (const perStreamReq of BOOLS) {
    for (const envFlag of BOOLS) {
      for (const keepAudio of BOOLS) {
        for (const botCanMix of BOOLS) {
          const expPerStream = perStreamReq && envFlag && (!keepAudio || botCanMix);
          const expMixed = expPerStream && keepAudio;
          const label = `req=${perStreamReq} env=${envFlag} keepAudio=${keepAudio} botCanMix=${botCanMix}`
            + ` -> perStream=${expPerStream} mixedRecording=${expMixed}`;
          it(label, () => {
            const { server, fd, cb, ack, sid, cid } = negotiate({ perStreamReq, envFlag, keepAudio, botCanMix });
            assert.ok(typeof cb === 'function', 'init always succeeds');
            assert.strictEqual(fd.perStream, expPerStream);
            assert.strictEqual(fd.mixedRecording, expMixed);
            assert.ok(ack, 'an ACK is always sent');
            assert.strictEqual(ack.perStream, expPerStream, 'the bot honours the GRANT, not its request');
            assert.strictEqual(ack.mixedRecording, expMixed);
            // The participant map exists exactly when per-stream was granted.
            assert.strictEqual(server.getStreamParticipants(sid, cid) != null, expPerStream);
          });
        }
      }
    }
  }

  // The two cells the K2 fail-closed rule turns on, asserted by name so a
  // regression names itself.
  it('keepAudio=true with a bot that cannot mix FAILS CLOSED (perStream:false)', () => {
    const { fd, ack, server, sid, cid } = negotiate({
      perStreamReq: true, envFlag: true, keepAudio: true, botCanMix: false,
    });
    assert.strictEqual(fd.perStream, false, 'demoted to the legacy mixed path');
    assert.strictEqual(fd.mixedRecording, false);
    assert.strictEqual(ack.perStream, false, 'the bot is told to keep mixing');
    assert.strictEqual(ack.mixedRecording, false);
    assert.strictEqual(server.getStreamParticipants(sid, cid), null,
      'no participant map: N sub-ASR must never share the single channel .pcm');
  });

  // doc/streaming-protocols.md makes the demotion LOG part of the contract:
  // "Both sides log a loud WARN on that demotion; without it the demotion gets
  // diagnosed as 'per-stream broke'". The bot side pins it
  // (test_negotiation_end_to_end.py); pin the Transcriber side too, so
  // deleting or downgrading the WARN cannot pass with a green suite.
  it('the fail-closed demotion is logged LOUDLY (the log is part of the contract)', () => {
    const warns = [];
    const origWarn = logger.warn;
    logger.warn = (msg) => { warns.push(String(msg)); };
    try {
      negotiate({ perStreamReq: true, envFlag: true, keepAudio: true, botCanMix: false });
    } finally {
      logger.warn = origWarn;
    }
    const demotions = warns.filter(m => /DEMOTED/.test(m));
    assert.strictEqual(demotions.length, 1,
      `exactly one demotion WARN expected, saw: ${warns.join(' | ') || '(none)'}`);
    assert.ok(/mixedRecording/.test(demotions[0]), 'it names the capability the bot lacks');
    assert.ok(/keepAudio/.test(demotions[0]), 'and why the archive forces the demotion');
  });

  it('a granted per-stream negotiation logs no demotion WARN', () => {
    const warns = [];
    const origWarn = logger.warn;
    logger.warn = (msg) => { warns.push(String(msg)); };
    try {
      negotiate({ perStreamReq: true, envFlag: true, keepAudio: true, botCanMix: true });
    } finally {
      logger.warn = origWarn;
    }
    assert.deepStrictEqual(warns.filter(m => /DEMOTED/.test(m)), []);
  });

  it('keepAudio=false grants perStream:true with mixedRecording:false', () => {
    const { fd, ack, server, sid, cid } = negotiate({
      perStreamReq: true, envFlag: true, keepAudio: false, botCanMix: false,
    });
    assert.strictEqual(fd.perStream, true);
    assert.strictEqual(fd.mixedRecording, false, 'nothing to archive -> no mixed flow asked for');
    assert.strictEqual(ack.perStream, true);
    assert.strictEqual(ack.mixedRecording, false);
    assert.ok(server.getStreamParticipants(sid, cid));
  });

  it('keepAudio=true with a mixing bot grants both', () => {
    const { fd, ack } = negotiate({
      perStreamReq: true, envFlag: true, keepAudio: true, botCanMix: true,
    });
    assert.strictEqual(fd.perStream, true);
    assert.strictEqual(fd.mixedRecording, true, 'the bot must ship the 0x02 flow for the archive');
    assert.strictEqual(ack.perStream, true);
    assert.strictEqual(ack.mixedRecording, true);
  });

  // A bot advertising mixedRecording without asking for per-stream must not be
  // granted anything: the 0x02 flow only exists to feed the recorder ASR that
  // per-stream mode creates.
  it('mixedRecording alone (no perStream request) grants nothing', () => {
    const { fd, ack } = negotiate({
      perStreamReq: false, envFlag: true, keepAudio: true, botCanMix: true,
    });
    assert.strictEqual(fd.perStream, false);
    assert.strictEqual(fd.mixedRecording, false);
    assert.strictEqual(ack.perStream, false);
    assert.strictEqual(ack.mixedRecording, false);
  });
});
