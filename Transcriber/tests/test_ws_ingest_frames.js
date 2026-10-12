const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('mocha');
const WS = require('ws');
const MultiplexedWebsocketServer = require('../components/StreamingServer/websocket/WebsocketServer');
const SpeakerTracker = require('../components/StreamingServer/SpeakerTracker');
// Same singleton logger instance the WebsocketServer requires.
const logger = require('../logger');

// WS ingest frame contract (after `init`): only audio reaches the ASR. A text
// frame is never audio; a JSON control message is applied in native
// diarization mode and dropped in any other mode; PCM stays aligned on 2-byte
// S16LE samples whatever the frame lengths.

const speakerChanged = JSON.stringify({ type: 'speakerChanged', position: 0, speaker: { id: 'u1', name: 'Alice' } });
const participantJoin = JSON.stringify({ type: 'participant', action: 'join', participant: { id: 'u2', name: 'Bob' } });

function stubLogger() {
  const saved = { warn: logger.warn, debug: logger.debug, info: logger.info };
  const warns = [];
  logger.warn = (msg) => warns.push(msg);
  logger.debug = () => {};
  logger.info = () => {};
  return { warns, restore: () => Object.assign(logger, saved) };
}

describe('WebsocketServer frame classification (text vs binary)', () => {
  let server, tracker, log;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    tracker = new SpeakerTracker();
    server.speakerTrackers.set('s_c', tracker);
    log = stubLogger();
  });
  afterEach(() => log.restore());

  const fdFor = (diarizationMode) => ({ session: { id: 's' }, channel: { id: 'c' }, diarizationMode });

  it('applies a speakerChanged text frame in native mode', () => {
    assert.equal(server.handleControlMessage(fdFor('native'), Buffer.from(speakerChanged), false), true);
    assert.equal(tracker.currentSpeaker.id, 'u1');
    assert.equal(log.warns.length, 0);
  });

  it('applies a participant text frame in native mode', () => {
    assert.equal(server.handleControlMessage(fdFor('native'), Buffer.from(participantJoin), false), true);
    assert.ok(tracker.participants.has('u2'));
  });

  it('drops a control text frame on a stream that is not in native mode, with a warning', () => {
    assert.equal(server.handleControlMessage(fdFor('asr'), Buffer.from(speakerChanged), false), true);
    assert.equal(tracker.currentSpeaker, null, 'never applied outside native mode');
    assert.equal(log.warns.length, 1);
    assert.ok(/not in native diarization mode/.test(log.warns[0]), log.warns[0]);
    assert.ok(/session s, channel c/.test(log.warns[0]), log.warns[0]);
  });

  it('drops a binary JSON control frame on a stream that is not in native mode', () => {
    assert.equal(server.handleControlMessage(fdFor('asr'), Buffer.from(participantJoin), true), true);
    assert.equal(tracker.participants.size, 0);
  });

  for (const mode of ['native', 'asr']) {
    it(`drops a text frame that is not JSON (${mode} mode)`, () => {
      assert.equal(server.handleControlMessage(fdFor(mode), Buffer.from('hello'), false), true);
      assert.ok(/text frame that is not JSON/.test(log.warns[0]), log.warns[0]);
    });

    it(`never treats a text frame as audio, even one that looks like PCM (${mode} mode)`, () => {
      // Two '{"'-free bytes: as a binary frame this is PCM, as a text frame it is not.
      const frame = Buffer.from([0x30, 0x31]);
      assert.equal(server.handleControlMessage(fdFor(mode), frame, true), false, 'binary: audio');
      assert.equal(server.handleControlMessage(fdFor(mode), frame, false), true, 'text: never audio');
    });

    it(`keeps a binary '{"' frame that fails to parse as audio (${mode} mode)`, () => {
      const pcm = Buffer.from([0x7B, 0x22, 0x10, 0xF0, 0x55, 0xAA]);
      assert.equal(server.handleControlMessage(fdFor(mode), pcm, true), false);
      assert.equal(log.warns.length, 0);
    });
  }

  it('treats a frame as binary when ws gives no flag (default)', () => {
    assert.equal(server.handleControlMessage(fdFor('asr'), Buffer.from([0x01, 0x02])), false);
  });
});

describe('WebsocketServer dropped-frame report throttling', () => {
  let server, log, realNow, now;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    log = stubLogger();
    realNow = Date.now;
    now = 1000000;
    Date.now = () => now;
  });
  afterEach(() => {
    Date.now = realNow;
    log.restore();
  });

  it('reports the first drop at once, then at most once a minute with the count', () => {
    const fd = { session: { id: 's' }, channel: { id: 'c' }, diarizationMode: 'asr' };
    const drop = () => server.handleControlMessage(fd, Buffer.from(speakerChanged), false);
    drop();
    assert.equal(log.warns.length, 1);
    assert.ok(/1 frame\(s\) dropped/.test(log.warns[0]), log.warns[0]);
    now += 30000;
    drop();
    drop();
    assert.equal(log.warns.length, 1, 'suppressed within the interval');
    now += 30000;
    drop();
    assert.equal(log.warns.length, 2);
    assert.ok(/3 frame\(s\) dropped/.test(log.warns[1]), 'counts the suppressed drops: ' + log.warns[1]);
  });

  it('throttles per connection', () => {
    const fdA = { session: { id: 's' }, channel: { id: 'a' }, diarizationMode: 'asr' };
    const fdB = { session: { id: 's' }, channel: { id: 'b' }, diarizationMode: 'asr' };
    server.handleControlMessage(fdA, Buffer.from('x'), false);
    server.handleControlMessage(fdB, Buffer.from('x'), false);
    assert.equal(log.warns.length, 2, 'each connection reports its first drop');
  });
});

describe('WebsocketServer initPcm audio path', () => {
  let server, ws, data, log;
  beforeEach(() => {
    server = new MultiplexedWebsocketServer({});
    ws = { send: () => {}, on: () => {}, close: () => {} };
    data = [];
    server.on('data', (buf, sid, cid) => data.push({ buf: Buffer.from(buf), sid, cid }));
    log = stubLogger();
  });
  afterEach(() => log.restore());

  const assertSampleAligned = () => {
    for (const { buf } of data) assert.equal(buf.length % 2, 0, `emitted an odd-length chunk: ${buf.length}`);
  };

  function open(diarizationMode, channelId = 'c') {
    const fd = { session: { id: 's' }, channel: { id: channelId }, diarizationMode };
    if (diarizationMode === 'native') server.speakerTrackers.set(`s_${channelId}`, new SpeakerTracker());
    return { fd, send: server.initPcm(ws, fd) };
  }

  for (const mode of ['native', 'asr']) {
    it(`never emits a text frame as audio (${mode} mode)`, () => {
      const { send } = open(mode);
      send(Buffer.from(speakerChanged), false);
      send(Buffer.from(participantJoin), false);
      send(Buffer.from('not json at all'), false);
      assert.equal(data.length, 0);
    });
  }

  it('keeps S16LE alignment across odd-length frames by carrying the dangling byte', () => {
    const { send } = open('asr');
    const frames = [[1, 2, 3], [4, 5, 6], [7], [8, 9], [10, 11, 12, 13, 14]].map((b) => Buffer.from(b));
    for (const frame of frames) send(frame, true);
    assertSampleAligned();
    assert.deepEqual([...Buffer.concat(data.map((d) => d.buf))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      'the byte stream is preserved, in order, without loss or duplication');
  });

  it('holds the last byte back until the next frame and emits nothing for a lone byte', () => {
    const { fd, send } = open('asr');
    send(Buffer.from([1, 2, 3]), true);
    assert.deepEqual([...data[0].buf], [1, 2]);
    assert.deepEqual([...fd.pcmRemainder], [3]);
    send(Buffer.from([4, 5]), true);
    assert.deepEqual([...data[1].buf], [3, 4]);
    assert.deepEqual([...fd.pcmRemainder], [5]);
    send(Buffer.from([6]), true);
    assert.deepEqual([...data[2].buf], [5, 6]);
    assert.equal(fd.pcmRemainder, null);
    send(Buffer.from([7]), true);
    assert.equal(data.length, 3, 'a lone byte is held back, not emitted');
  });

  it('does not let a control frame between odd-length audio frames break alignment', () => {
    const { send } = open('native');
    send(Buffer.from([1, 2, 3]), true);
    send(Buffer.from(speakerChanged), false);
    send(Buffer.from(speakerChanged), true); // binary control frame (older senders)
    send(Buffer.from([4]), true);
    assertSampleAligned();
    assert.deepEqual([...Buffer.concat(data.map((d) => d.buf))], [1, 2, 3, 4]);
    assert.equal(server.getSpeakerTracker('s', 'c').currentSpeaker.id, 'u1');
  });

  it('keeps the carried byte per connection', () => {
    const a = open('asr', 'a');
    const b = open('asr', 'b');
    a.send(Buffer.from([1, 2, 3]), true);
    b.send(Buffer.from([10, 20, 30]), true);
    a.send(Buffer.from([4]), true);
    b.send(Buffer.from([40]), true);
    assertSampleAligned();
    const bytesOf = (cid) => [...Buffer.concat(data.filter((d) => d.cid === cid).map((d) => d.buf))];
    assert.deepEqual(bytesOf('a'), [1, 2, 3, 4]);
    assert.deepEqual(bytesOf('b'), [10, 20, 30, 40]);
  });

  it('emits even-length frames unchanged', () => {
    const { send } = open('asr');
    const pcm = Buffer.from([1, 2, 3, 4]);
    send(pcm, true);
    assert.equal(data.length, 1);
    assert.ok(data[0].buf.equals(pcm));
    assert.equal(data[0].sid, 's');
    assert.equal(data[0].cid, 'c');
  });
});

// End to end through the real `ws` library: proves that the text/binary flag
// actually reaches the frame classification, and that the init handshake
// (sent as a text frame, like every client does) still works.
describe('WebsocketServer ingest over a real WebSocket connection', () => {
  let wss, server, client, log;

  beforeEach(async () => {
    log = stubLogger();
    server = new MultiplexedWebsocketServer({});
    // Streams are addressed by the session's private id, never the public one.
    server.sessions = [{ id: 'sess', privateId: 'priv-sess', channels: [{ id: 7 }] }];
    wss = new WS.Server({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws, req) => server.onConnection(ws, req));
    await new Promise((resolve) => wss.once('listening', resolve));
  });

  afterEach(async () => {
    if (client) client.terminate();
    client = null;
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    log.restore();
  });

  async function connect(diarizationMode) {
    client = new WS(`ws://127.0.0.1:${wss.address().port}/priv-sess,0`);
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const reply = new Promise((resolve) => client.once('message', (m) => resolve(JSON.parse(m.toString()))));
    client.send(JSON.stringify({ type: 'init', encoding: 'pcm', sampleRate: 16000, diarizationMode, participants: [] }));
    return reply;
  }

  function collectAudio(expectedBytes) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only ${Buffer.concat(chunks).length}/${expectedBytes} audio bytes received`)), 2000);
      server.on('data', (buf) => {
        chunks.push(Buffer.from(buf));
        if (Buffer.concat(chunks).length >= expectedBytes) {
          clearTimeout(timer);
          // Let any frame wrongly emitted after the last audio byte surface.
          setTimeout(() => resolve(chunks), 50);
        }
      });
    });
  }

  for (const mode of ['asr', 'native']) {
    it(`acks a text init and feeds only binary PCM to the ASR, aligned (${mode} mode)`, async () => {
      const ack = await connect(mode);
      assert.deepEqual(ack, { type: 'ack', message: 'Init done', perStream: false, mixedRecording: false });
      const audio = collectAudio(8);
      client.send(Buffer.from([1, 2, 3]));                 // odd length
      client.send(speakerChanged);                          // text control frame
      client.send(Buffer.from(participantJoin));            // binary control frame
      client.send(Buffer.from([4, 5, 6, 7, 8]));            // odd length again
      client.send('{"type":"speakerChanged","speaker":null}');
      const chunks = await audio;
      for (const chunk of chunks) assert.equal(chunk.length % 2, 0, `odd-length chunk ${chunk.length}`);
      assert.deepEqual([...Buffer.concat(chunks)], [1, 2, 3, 4, 5, 6, 7, 8]);
      if (mode === 'native') {
        const tracker = server.getSpeakerTracker('sess', 7);
        assert.ok(tracker.participants.has('u2'), 'binary control frame applied');
        assert.equal(tracker.currentSpeaker, null, 'last text control frame applied');
        assert.equal(log.warns.length, 0);
      } else {
        assert.equal(log.warns.length, 1, 'drops reported once (throttled)');
        assert.ok(/not in native diarization mode/.test(log.warns[0]), log.warns[0]);
      }
    });
  }
});
