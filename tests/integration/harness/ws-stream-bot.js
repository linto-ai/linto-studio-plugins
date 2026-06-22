#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * ws-stream-bot.js
 *
 * Simulates a decoupled BotService stream to the Transcriber: like ws-stream.js
 * it forwards s16le/16k mono PCM from stdin in 200ms chunks, but it opens the
 * session in NATIVE diarization mode and interleaves the control messages a real
 * bot sends (participant join + speakerChanged), alternating between the given
 * participants so the Transcriber's SpeakerTracker stamps each ASR segment with a
 * speaker. This exercises the native-diarization ingest path without a browser.
 *
 * Usage:
 *   ffmpeg -i in.wav -f s16le -ar 16000 -ac 1 - \
 *     | node ws-stream-bot.js ws://host:port/transcriber-ws/<sessionId>,<chIdx> "u1:Alice,u2:Bob" 1500
 */
const url = process.argv[2];
const participantsArg = process.argv[3] || 'u1:Alice,u2:Bob';
const toggleMs = parseInt(process.argv[4] || '1500', 10);
if (!url) { console.error('usage: ws-stream-bot.js <ws-url> [participants] [toggleMs]'); process.exit(2); }

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) {
  try { WebSocket = require(require('path').join(process.cwd(), 'Transcriber/node_modules/ws')); }
  catch (e2) { console.error('Cannot find the `ws` module.'); process.exit(3); }
}

const participants = participantsArg.split(',').map((p) => {
  const [id, name] = p.split(':');
  return { id, name: name || id };
});

const SAMPLE_RATE = 16000, BYTES_PER_SAMPLE = 2, CHUNK_MS = 200;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
let queue = Buffer.alloc(0);
let stdinEnded = false;
let serverReady = false;
let startedAt = 0;
let speakerIdx = 0;
let toggleTimer = null;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'init', sampleRate: SAMPLE_RATE, encoding: 'pcm', diarizationMode: 'native', participants }));
});

ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
  if (msg && msg.type === 'ack') onAck();
});

function onAck() {
  serverReady = true;
  startedAt = Date.now();
  for (const p of participants) ws.send(JSON.stringify({ type: 'participant', action: 'join', participant: p }));
  sendSpeaker(); // initial speaker
  toggleTimer = setInterval(() => { speakerIdx = (speakerIdx + 1) % participants.length; sendSpeaker(); }, toggleMs);
  flushLoop();
}

function sendSpeaker() {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'speakerChanged', position: Date.now() - startedAt, speaker: participants[speakerIdx] }));
}

function flushLoop() {
  const interval = setInterval(() => {
    if (!serverReady) return;
    if (queue.length >= CHUNK_BYTES) {
      const chunk = queue.subarray(0, CHUNK_BYTES);
      queue = queue.subarray(CHUNK_BYTES);
      ws.send(chunk);
    } else if (stdinEnded && queue.length === 0) {
      clearInterval(interval);
      if (toggleTimer) clearInterval(toggleTimer);
      ws.close();
    }
  }, CHUNK_MS);
}

ws.on('close', () => process.exit(0));
ws.on('error', (err) => { console.error('ws error', err.message); process.exit(4); });
process.stdin.on('data', (chunk) => { queue = Buffer.concat([queue, chunk]); });
process.stdin.on('end', () => { stdinEnded = true; });
