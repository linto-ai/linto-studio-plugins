#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * ws-stream.js
 *
 * Reads raw s16le mono 16kHz PCM from stdin and forwards it to the
 * Transcriber WebSocket endpoint as 200ms binary chunks, after sending
 * the required init frame.
 *
 * Usage:
 *   ffmpeg -i input.wav -f s16le -ar 16000 -ac 1 - | node ws-stream.js ws://host:port/transcriber-ws/<sessionId>,<channelIndex>
 */

const url = process.argv[2];
if (!url) {
    console.error('usage: ws-stream.js <ws-url>');
    process.exit(2);
}

let WebSocket;
try {
    // Try the project-wide install (Transcriber depends on `ws`).
    WebSocket = require('ws');
} catch (e) {
    try {
        WebSocket = require(require('path').join(process.cwd(), 'Transcriber/node_modules/ws'));
    } catch (e2) {
        console.error('Cannot find the `ws` module. Run `npm install` in Transcriber first.');
        process.exit(3);
    }
}

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_MS = 200;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

let queue = Buffer.alloc(0);
let stdinEnded = false;
let serverReady = false;

function flushTimerLoop() {
    const interval = setInterval(() => {
        if (!serverReady) return;
        if (queue.length >= CHUNK_BYTES) {
            const chunk = queue.subarray(0, CHUNK_BYTES);
            queue = queue.subarray(CHUNK_BYTES);
            ws.send(chunk);
        } else if (stdinEnded && queue.length === 0) {
            clearInterval(interval);
            ws.close();
        }
    }, CHUNK_MS);
}

ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'init', sampleRate: SAMPLE_RATE, encoding: 'pcm' }));
});

ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg && msg.type === 'ack') {
        serverReady = true;
        flushTimerLoop();
    }
});

ws.on('close', () => process.exit(0));
ws.on('error', (err) => { console.error('ws error', err.message); process.exit(4); });

process.stdin.on('data', (chunk) => {
    queue = Buffer.concat([queue, chunk]);
});
process.stdin.on('end', () => { stdinEnded = true; });
