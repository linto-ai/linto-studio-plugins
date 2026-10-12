/**
 * WebRTC interception script generator.
 *
 * Produces a self-contained JavaScript string injected into the meeting page via
 * page.addInitScript(). It runs entirely in the browser and:
 *   1. patches RTCPeerConnection to capture every inbound audio track;
 *   2. captures each track at 16 kHz S16LE in-page (AudioWorklet, ScriptProcessor
 *      fallback) and streams it as binary frames to the loopback LocalAudioServer;
 *   3. maps tracks to participants per platform so the Node side can do native
 *      diarization (SFU) or forward server-side speaker info (Teams).
 *
 * Binary frame: [uint16BE trackIndex][uint16BE reserved=0][...PCM]. Control
 * messages are sent as JSON text frames.
 *
 * The script runs in every document of the page (addInitScript injects it into
 * each frame). Only the top-level document runs the platform pollers and connects
 * at once; a sub-frame connects only if it captures a track.
 *
 * Only the block for the requested platform is emitted, so a Visio bot never
 * ships Teams introspection and vice-versa. The participant-mapping pollers
 * depend on each platform's (undocumented) client internals — Jitsi's
 * `window.APP.conference`, LiveKit's React Room object, Teams' `window.callingDebug`
 * — and fail soft (a missing internal just means "not ready yet").
 *
 * @param {string} localWsUrl  ws://127.0.0.1:PORT/bot-<sessionId>_<channelId>
 * @param {object} platformConfig  manifest: { platformType: 'sfu'|'mcu'|'teams', debug? }
 * @returns {string} JavaScript source to inject
 */
function getInterceptScript (localWsUrl, platformConfig) {
  const debug = !!platformConfig.debug
  const platformType = platformConfig.platformType || 'unknown'
  const platformBlock = platformType === 'sfu'
    ? SFU_MAPPING_BLOCK
    : platformType === 'teams' ? TEAMS_SPEAKER_BLOCK : ''

  return `
(function () {
  'use strict';
  const LOCAL_WS_URL = ${JSON.stringify(localWsUrl)};
  const PLATFORM_TYPE = ${JSON.stringify(platformType)};
  const DEBUG = ${JSON.stringify(debug)};
  // The top-level document, where the meeting client runs; false in a sub-frame.
  const IS_TOP = (function () { try { return window === window.top; } catch (e) { return false; } })();

  // getUserMedia shim. Headless Chromium has no real capture device, so the
  // meeting SPA's getUserMedia throws NotFoundError and the join never finalizes
  // (the bot connects the signaling WS but is never admitted as a participant and
  // receives no remote tracks). Return synthetic SILENT audio + a blank video
  // track so the join completes; the bot only subscribes to others' tracks, it
  // never needs to publish real media.
  //
  // EXCEPT Teams: its MediaAgent/DeviceManager validates that the published track's
  // deviceId resolves to an enumerated capture device. A track minted from a
  // MediaStreamDestination has an EMPTY deviceId, so Teams logs "Active device not
  // found" and the lobby→meeting transition never completes (the bot is admitted by
  // the host but stays stuck on "Admission…" until the join watchdog gives up). For
  // Teams we therefore leave getUserMedia/enumerateDevices ALONE and rely on
  // Chromium's native fake capture device (--use-fake-device-for-media-capture in
  // BrowserPool), whose track carries a valid deviceId the DeviceManager accepts.
  try {
    if (PLATFORM_TYPE !== 'teams' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const _gumAC = new (window.AudioContext || window.webkitAudioContext)();
      navigator.mediaDevices.getUserMedia = function (constraints) {
        try {
          const tracks = [];
          if (constraints && constraints.audio) {
            const osc = _gumAC.createOscillator();
            const gain = _gumAC.createGain(); gain.gain.value = 0; // silent
            const dest = _gumAC.createMediaStreamDestination();
            osc.connect(gain); gain.connect(dest); osc.start();
            tracks.push(dest.stream.getAudioTracks()[0]);
          }
          if (constraints && constraints.video) {
            const cv = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
            cv.getContext('2d').fillRect(0, 0, 320, 240);
            tracks.push(cv.captureStream(5).getVideoTracks()[0]);
          }
          return Promise.resolve(new MediaStream(tracks));
        } catch (e) { return Promise.reject(e); }
      };
      if (navigator.mediaDevices.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices = function () {
          return Promise.resolve([
            { deviceId: 'default', kind: 'audioinput', label: 'Bot Mic', groupId: 'bot', toJSON() { return this; } },
            { deviceId: 'default', kind: 'videoinput', label: 'Bot Cam', groupId: 'bot', toJSON() { return this; } }
          ]);
        };
      }
    }
  } catch (e) {}
  const TARGET_SAMPLE_RATE = 16000;
  // Cut-off of the anti-aliasing low-pass of the JS resampler: below the 8 kHz
  // Nyquist of the output, above the band that matters to speech recognition.
  const ANTI_ALIAS_HZ = 7000;
  const MAX_RECONNECT_RETRIES = 10;
  const RECONNECT_DELAY_MS = 1000;
  // At most one capture-failure warning per this period (see warnCaptureFailure).
  const CAPTURE_WARN_INTERVAL_MS = 10000;
  const intervals = [];

  function log() { if (DEBUG) console.log.apply(console, ['[WebRTC-Intercept]'].concat([].slice.call(arguments))); }
  // Critical in-page faults must reach the Node logs regardless of DEBUG.
  // console.warn is bridged to logger.warn by the page-console handler in
  // bot/index.js, so an otherwise-invisible failure (capture pipe dead, worklet
  // fallback, Room never found) becomes greppable. Call sites latch to avoid flooding.
  function warn() { try { console.warn.apply(console, ['[WebRTC-Intercept]'].concat([].slice.call(arguments))); } catch (e) {} }

  // ── Sanitization ───────────────────────────────────────────────────────────
  // Participant id/name come from the meeting page and flow into control
  // messages → Node logs and the caption DB. Strip control/non-printable chars
  // (defeats ANSI/newline log injection) and length-cap before sending.
  var SANITIZE_MAX_LEN = 256;
  function sanitizeText(value) {
    if (value == null) return value;
    var s = String(value);
    // Drop C0/C1 control characters (incl. \\n \\r \\t and the ESC that starts
    // ANSI sequences) and the DEL char; collapse to a single space.
    s = s.replace(/[\\u0000-\\u001F\\u007F-\\u009F]/g, ' ').trim();
    if (s.length > SANITIZE_MAX_LEN) s = s.slice(0, SANITIZE_MAX_LEN);
    return s;
  }
  function sanitizeParticipant(p) {
    if (!p || typeof p !== 'object') return p;
    var out = {};
    for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k]; }
    if ('id' in out) out.id = sanitizeText(out.id);
    if ('name' in out) out.name = sanitizeText(out.name);
    return out;
  }

  // ── Loopback WebSocket to the Node LocalAudioServer ───────────────────────
  let ws = null, wsReady = false, reconnectAttempts = 0, reconnectTimer = null, disposed = false;
  // Mappings already made (trackIndex -> participant), re-announced on every
  // connect along with the live tracks: control messages are not queued while the
  // socket is down, and after a reconnect (Node side restarted) the Node state is
  // keyed by the new connection.
  const sentMappings = new Map(); // trackIndex -> participant (sanitized)
  const headerBuf = new ArrayBuffer(4);
  const headerView = new DataView(headerBuf);
  const headerBytes = new Uint8Array(headerBuf);

  function connectWs() {
    if (disposed) return;
    try {
      ws = new WebSocket(LOCAL_WS_URL);
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () {
        wsReady = true; reconnectAttempts = 0; log('ws connected');
        // Announce what this document captures (control only, no audio replay).
        captures.forEach(function (capture) {
          sendJson({ type: 'trackAdded', trackId: capture.trackId, trackIndex: capture.index });
        });
        sentMappings.forEach(function (participant, trackIndex) {
          sendJson({ type: 'participantMapping', trackIndex: trackIndex, participant: participant });
        });
      };
      ws.onclose = function () {
        wsReady = false;
        if (disposed) return;
        if (reconnectAttempts < MAX_RECONNECT_RETRIES) {
          reconnectAttempts++;
          reconnectTimer = setTimeout(connectWs, RECONNECT_DELAY_MS);
        } else {
          // Giving up here permanently kills audio capture (disposed=true stops
          // every reconnect). Warn so the Node-side silence watchdog and
          // operators learn the pipe is dead.
          warn('loopback ws gave up after ' + MAX_RECONNECT_RETRIES + ' retries — audio capture permanently stopped');
          disposed = true;
        }
      };
      ws.onerror = function () { log('ws error'); };
    } catch (e) { log('ws connect failed', e && e.message); }
  }

  function wsIsOpen() {
    return wsReady && ws && ws.readyState === WebSocket.OPEN;
  }

  function sendBinary(trackIdx, pcmInt16) {
    if (!wsIsOpen()) return;
    headerView.setUint16(0, trackIdx, false); // trackIndex, big-endian
    headerView.setUint16(2, 0, false);        // reserved
    const payload = new Uint8Array(4 + pcmInt16.byteLength);
    payload.set(headerBytes, 0);
    payload.set(new Uint8Array(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength), 4);
    ws.send(payload.buffer);
  }

  function sendJson(obj) {
    if (!wsIsOpen()) return;
    ws.send(JSON.stringify(obj));
  }

  // ── PCM conversion ────────────────────────────────────────────────────────
  // Resampler from 'sourceRate' to 16 kHz for one track, only used when the
  // AudioContext could not be created at 16 kHz. It is stateful, fed the track's
  // chunks in order: filter state, the last sample and the read position carry
  // over from one chunk to the next, so the output does not depend on how the
  // input was chunked. The position is an exact integer phase (input sample +
  // remainder in 1/16000ths), so 'sourceRate' input samples always yield exactly
  // 16000 output samples: no drift, whatever the chunk lengths. Downsampling first
  // runs an 8th-order Butterworth low-pass at ANTI_ALIAS_HZ (four biquads) so what
  // lies above the output Nyquist does not alias into the speech band; output
  // samples are then linearly interpolated.
  function createResampler(sourceRate) {
    const sections = [];
    if (sourceRate > TARGET_SAMPLE_RATE) {
      const w0 = 2 * Math.PI * ANTI_ALIAS_HZ / sourceRate, cosW0 = Math.cos(w0);
      for (let k = 1; k <= 4; k++) {
        const q = 1 / (2 * Math.sin((2 * k - 1) * Math.PI / 16)); // Butterworth poles
        const alpha = Math.sin(w0) / (2 * q), a0 = 1 + alpha;
        sections.push({
          b0: (1 - cosW0) / 2 / a0, b1: (1 - cosW0) / a0, b2: (1 - cosW0) / 2 / a0,
          a1: -2 * cosW0 / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0
        });
      }
    }
    let prev = 0; // last (filtered) input sample of the previous chunk
    let pos = 0; // input index of the next output sample, -1 meaning 'prev'
    let rem = 0; // and its fraction, in 1/TARGET_SAMPLE_RATE of an input sample
    return function (input) {
      const n = input.length;
      const x = sections.length > 0 ? new Float32Array(n) : input;
      for (let s = 0; s < sections.length; s++) {
        const f = sections[s], from = s === 0 ? input : x;
        for (let i = 0; i < n; i++) {
          const v = from[i];
          const y = f.b0 * v + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
          f.x2 = f.x1; f.x1 = v; f.y2 = f.y1; f.y1 = y;
          x[i] = y;
        }
      }
      const out = new Float32Array(Math.ceil(n * TARGET_SAMPLE_RATE / sourceRate) + 1);
      let count = 0;
      while (pos < n - 1) {
        const a = pos < 0 ? prev : x[pos];
        out[count++] = a + (x[pos + 1] - a) * (rem / TARGET_SAMPLE_RATE);
        rem += sourceRate;
        pos += Math.floor(rem / TARGET_SAMPLE_RATE);
        rem %= TARGET_SAMPLE_RATE;
      }
      pos -= n;
      if (n > 0) prev = x[n - 1];
      return out.subarray(0, count);
    };
  }

  function float32ToInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i];
      s = s < -1 ? -1 : (s > 1 ? 1 : s);
      out[i] = s < 0 ? Math.max(-32768, s * 32768) : Math.min(32767, s * 32767);
    }
    return out;
  }

  // ── Track capture ─────────────────────────────────────────────────────────
  let trackIndexSeq = 0;
  const tracks = new Map(); // trackId -> { index, participantId }
  const processedTracks = new Set();
  // trackIndex -> capture graph of a live track: { index, trackId, ended, sink, source, node, resample },
  // filled in as setupTrackCapture() progresses. Also what keeps the sink element
  // referenced (and playing) for as long as the track is captured.
  const captures = new Map();
  let sharedCtx = null, workletLoad = null, transport = null;

  // AudioWorklet module. All the processors of a context share one
  // AudioWorkletGlobalScope: each capture processor appends its track's render
  // quantum to one queue there, and a single transport processor posts that queue
  // to the page once per quantum. Posting from every capture node's own port would
  // reorder the tracks: after a main-thread stall the page drains each port's
  // backlog in one go, so one track's whole backlog reaches the Node mixer before
  // the other's (measured in Chromium: ~600 ms of one track, then the other, after
  // a 600 ms stall). Through one port the quanta stay in render order, interleaved
  // across tracks. (ScriptProcessor callbacks share the main-thread task queue and
  // stay interleaved on their own.)
  const WORKLET_MODULE = [
    'const queue = [];',
    'class PCMCapture extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    this.trackIndex = options.processorOptions.trackIndex;',
    '    this.live = true;',
    '    this.port.onmessage = () => { this.live = false; };',
    '  }',
    '  process(inputs) {',
    '    const c = inputs[0][0];',
    '    if (this.live && c && c.length > 0) queue.push(this.trackIndex, new Float32Array(c));',
    '    return this.live;',
    '  }',
    '}',
    'class PCMTransport extends AudioWorkletProcessor {',
    '  process() {',
    '    if (queue.length > 0) this.port.postMessage(queue.splice(0, queue.length));',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("pcm-capture", PCMCapture);',
    'registerProcessor("pcm-transport", PCMTransport);'
  ].join('\\n');

  // One AudioContext for every track of the document, created at 16 kHz: Chromium
  // then resamples each MediaStream source itself (band-limited sinc resampler)
  // and the context clock yields exactly 16000 samples per second. Should that
  // rate be refused, capture at the default rate and resample in JS.
  function getSharedContext() {
    if (sharedCtx) return sharedCtx;
    try {
      sharedCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch (e) {
      warn('16 kHz AudioContext unavailable, resampling in JS: ' + (e && e.message ? e.message : 'unknown'));
      sharedCtx = new AudioContext();
    }
    return sharedCtx;
  }

  // Convert and send a chunk of a track's audio, at the context rate.
  function sendPcm(capture, samples) {
    const pcm = capture.resample ? capture.resample(samples) : samples;
    if (pcm.length > 0) sendBinary(capture.index, float32ToInt16(pcm));
  }

  // Transport message: [trackIndex, samples, trackIndex, samples, ...] in render
  // order. Quanta of a track torn down in the meantime are dropped, so nothing of
  // a track is sent after its trackRemoved. A quantum that fails to convert or
  // send only costs its own track.
  function onTransportMessage(e) {
    const queue = e.data;
    for (let i = 0; i < queue.length; i += 2) {
      const capture = captures.get(queue[i]);
      if (!capture) continue;
      try { sendPcm(capture, queue[i + 1]); } catch (err) { warnCaptureFailure('capture of track ' + capture.index + ' failed', err); }
    }
  }

  // A track that cannot be captured is lost to the transcript: say so in the
  // Node logs (warn, whatever DEBUG), at most once per CAPTURE_WARN_INTERVAL_MS,
  // with the count of the failures not reported in between.
  let lastCaptureWarnAt = -Infinity, unreportedCaptureFailures = 0;
  function warnCaptureFailure(what, e) {
    const now = Date.now();
    if (now - lastCaptureWarnAt < CAPTURE_WARN_INTERVAL_MS) { unreportedCaptureFailures++; return; }
    lastCaptureWarnAt = now;
    warn(what + ': ' + (e && e.message ? e.message : 'unknown error') +
      (unreportedCaptureFailures ? ' (and ' + unreportedCaptureFailures + ' other failure(s) since the last report)' : ''));
    unreportedCaptureFailures = 0;
  }

  // Load the module and start the transport, once per context: tracks set up
  // concurrently share the load, and a failure is kept so that every track falls
  // back the same way.
  function loadWorklet(ctx) {
    if (!workletLoad) {
      workletLoad = Promise.resolve().then(function () {
        const url = URL.createObjectURL(new Blob([WORKLET_MODULE], { type: 'application/javascript' }));
        return ctx.audioWorklet.addModule(url).finally(function () { URL.revokeObjectURL(url); });
      }).then(function () {
        transport = new AudioWorkletNode(ctx, 'pcm-transport');
        transport.port.onmessage = onTransportMessage;
        transport.connect(ctx.destination); // keeps it processing
      });
    }
    return workletLoad;
  }

  async function setupTrackCapture(track, capture) {
    const ctx = getSharedContext();
    // Headless Chromium starts the AudioContext suspended (no audio output to
    // drive it); without resuming, the AudioWorklet never pulls samples and no
    // PCM is ever captured.
    try { if (ctx.state !== 'running') await ctx.resume(); } catch (e) {}
    // The track may have ended while we waited: build nothing for it.
    if (capture.ended) return;
    if (ctx.sampleRate !== TARGET_SAMPLE_RATE) capture.resample = createResampler(ctx.sampleRate);
    const ms = new MediaStream([track]);
    // Chrome quirk: a remote WebRTC audio track does NOT feed a
    // MediaStreamAudioSourceNode unless it is ALSO attached to a playing
    // HTMLMediaElement. Without this sink, process() receives only silence.
    try {
      const sink = document.createElement('audio');
      sink.srcObject = ms; sink.muted = true; sink.autoplay = true;
      sink.play().catch(function () {});
      capture.sink = sink;
    } catch (e) {}
    capture.source = ctx.createMediaStreamSource(ms);

    try {
      await loadWorklet(ctx);
      // Same check after the module load: tear down the source and sink built above.
      if (capture.ended) { teardownCapture(capture); return; }
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { processorOptions: { trackIndex: capture.index } });
      capture.node = node;
      capture.source.connect(node);
      node.connect(ctx.destination); // keeps the graph pulling
      log('AudioWorklet capture for track', capture.index);
    } catch (e) {
      if (capture.ended) { teardownCapture(capture); return; }
      // The ScriptProcessor path is deprecated and degraded — surface the
      // fallback at warn (independent of DEBUG) so it is visible in the Node logs.
      warn('AudioWorklet unavailable, falling back to ScriptProcessor (track ' + capture.index + '): ' + (e && e.message ? e.message : 'unknown'));
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      capture.node = proc;
      capture.source.connect(proc);
      proc.connect(ctx.destination);
      proc.onaudioprocess = function (ev) { sendPcm(capture, ev.inputBuffer.getChannelData(0)); };
    }
  }

  // Dismantle a track's capture graph. An ended track keeps feeding its source
  // node (Chromium renders it as silence, at the full rate), so its PCM only stops
  // once the processing node, the source and the sink element are all released.
  function teardownCapture(capture) {
    capture.ended = true;
    captures.delete(capture.index);
    const node = capture.node, source = capture.source, sink = capture.sink;
    capture.node = capture.source = capture.sink = null;
    if (node) {
      // Stop the processor (it no longer queues quanta), or the ScriptProcessor callback.
      if (node.port) node.port.postMessage('stop'); else node.onaudioprocess = null;
      try { node.disconnect(); } catch (e) {}
    }
    if (source) { try { source.disconnect(); } catch (e) {} }
    if (sink) { try { sink.pause(); sink.srcObject = null; } catch (e) {} }
  }

  function handleNewTrack(track) {
    if (!track || track.kind !== 'audio' || track.readyState === 'ended') return;
    if (processedTracks.has(track.id)) {
      // The SFU reused the receiver for another subscription: Chromium fires
      // 'track' again with the same MediaStreamTrack (its capture goes on), which
      // now carries somebody else, or the same participant back: find out again.
      forgetMapping(tracks.get(track.id));
      return;
    }
    processedTracks.add(track.id);
    const capture = { index: trackIndexSeq++, trackId: track.id, ended: false, sink: null, source: null, node: null, resample: null };
    captures.set(capture.index, capture);
    tracks.set(track.id, { index: capture.index, participantId: null });
    // A sub-frame connects on its first track (announced once the socket opens).
    if (!ws) connectWs();
    sendJson({ type: 'trackAdded', trackId: track.id, trackIndex: capture.index });
    setupTrackCapture(track, capture).catch(function (e) {
      // This track is not captured (the others are not affected): release what
      // was built for it, and report it.
      teardownCapture(capture);
      warnCaptureFailure('capture setup failed for track ' + capture.index, e);
    });
    track.addEventListener('ended', function () {
      // Tear down first: nothing of this track is sent after its trackRemoved.
      teardownCapture(capture);
      sendJson({ type: 'trackRemoved', trackId: track.id, trackIndex: capture.index });
      tracks.delete(track.id);
      processedTracks.delete(track.id);
      sentMappings.delete(capture.index); // never replay the mapping of a dead track
    });
  }

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  function PatchedRTCPeerConnection(config, constraints) {
    const pc = new OriginalRTCPeerConnection(config, constraints);
    pc.addEventListener('track', function (event) { if (event.track) handleNewTrack(event.track); });
    log('RTCPeerConnection intercepted');
    return pc;
  }
  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  if (OriginalRTCPeerConnection.generateCertificate) {
    PatchedRTCPeerConnection.generateCertificate = OriginalRTCPeerConnection.generateCertificate.bind(OriginalRTCPeerConnection);
  }
  window.RTCPeerConnection = PatchedRTCPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedRTCPeerConnection;

  function hasUnmappedTrack() {
    for (const info of tracks.values()) if (!info.participantId) return true;
    return false;
  }
  // Map a track to the participant publishing it. A track already mapped to
  // someone else has been reused for another subscription (SFUs recycle their
  // receivers, MediaStreamTrack included): it is mapped again.
  function mapTrack(trackId, participant) {
    const info = tracks.get(trackId);
    if (!info) return;
    const clean = sanitizeParticipant(participant); // strip control chars + cap length
    if (info.participantId === clean.id) return;
    info.participantId = clean.id;
    sentMappings.set(info.index, clean); // remember for reconnect replay
    sendJson({ type: 'participantMapping', trackIndex: info.index, participant: clean });
    log('mapped track', info.index, '->', clean.name);
  }
  // Map the tracks found in one poll: claims is trackId -> [participant, ...]. A
  // track claimed by exactly one participant is theirs; one claimed by several
  // (two publications on the same MediaStreamTrack, e.g. halfway through a
  // handover) keeps its current mapping, rather than flipping between them at
  // every poll. Reported once per track.
  const ambiguousTracks = new Set();
  function mapClaims(claims) {
    claims.forEach(function (owners, trackId) {
      const ids = owners.map(function (o) { return o.id; }).filter(function (id, i, all) { return all.indexOf(id) === i; });
      if (ids.length === 1) { mapTrack(trackId, owners[0]); return; }
      if (!tracks.has(trackId) || ambiguousTracks.has(trackId)) return;
      ambiguousTracks.add(trackId);
      warn('track ' + trackId + ' claimed by ' + ids.length + ' participants (' + ids.map(sanitizeText).join(', ') + '): its mapping is left as it is');
    });
  }
  function claim(claims, trackId, participant) {
    const owners = claims.get(trackId);
    if (owners) owners.push(participant); else claims.set(trackId, [participant]);
  }

  // The track no longer carries the participant it was mapped to: unmapped (so
  // polled for fast), never re-announced on a reconnect, and the Node side stops
  // attributing it at once (its participant may still be in the meeting, e.g.
  // after unpublishing, while the receiver already carries somebody else).
  function forgetMapping(info) {
    if (!info || !info.participantId) return;
    info.participantId = null;
    sentMappings.delete(info.index);
    sendJson({ type: 'trackUnmapped', trackIndex: info.index });
  }
  // A participant left: their tracks may be reused for someone else (or for them,
  // back), and must be mapped again.
  function forgetParticipant(participantId) {
    tracks.forEach(function (info) { if (info.participantId === participantId) forgetMapping(info); });
  }

  // The pollers read the meeting client's state, which lives in the top-level
  // document: in a sub-frame they would only find "no call / no room" and report
  // it (participantLeft, a native-diarization degrade) as if the meeting were gone.
  if (IS_TOP) {
  ${platformBlock}
  }

  window.addEventListener('beforeunload', function () {
    disposed = true;
    intervals.forEach(clearInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  // The top-level document connects at once (its pollers report participants); a
  // sub-frame only when it captures a track, so the many frames of a meeting SPA
  // that never carry media do not each open a loopback socket.
  if (IS_TOP) connectWs();
  log('initialised for platform', PLATFORM_TYPE, IS_TOP ? 'in the top frame' : 'in a sub-frame');
})();
`
}

// ── SFU participant mapping (Jitsi + LiveKit/Visio) ─────────────────────────
// Emitted only for platformType === 'sfu'. Relies on shared helpers
// (tracks, hasUnmappedTrack, mapTrack, sendJson, intervals, log).
const SFU_MAPPING_BLOCK = `
  // Polling starts with the page. Jitsi's state is read directly (cheap): at
  // every tick. LiveKit's: while a captured track waits for its participant,
  // poll fast, since its words are only attributed from the mapping on; otherwise
  // at the normal cadence, for subscriptions and leaves. Finding the LiveKit Room
  // walks the React fiber tree of the whole DOM, which is expensive: at most once
  // per SFU_POLL_MS, and no more once found (the Room object is kept).
  var SFU_FAST_POLL_MS = 250, SFU_POLL_MS = 1500;
  var lastSfuPoll = -Infinity, lastRoomSearch = -Infinity; // the first ones run at once

  // If neither the Jitsi conference nor the LiveKit Room internal is ever found,
  // no track is subscribed/mapped and the bot captures nothing. Count consecutive
  // searches with no Room/conference and warn once after the limit so the failure
  // (page structure changed / never joined) is visible.
  var sfuNotFoundPolls = 0, sfuNotFoundWarned = false;
  var SFU_NOT_FOUND_LIMIT = 20;
  function noteSfuInternal(found) {
    if (found) { sfuNotFoundPolls = 0; return; }
    if (sfuNotFoundWarned) return;
    sfuNotFoundPolls++;
    if (sfuNotFoundPolls >= SFU_NOT_FOUND_LIMIT) {
      sfuNotFoundWarned = true;
      warn('SFU Room/conference internal never found after ' + sfuNotFoundPolls + ' searches — no audio tracks will be captured');
    }
  }

  // Jitsi: tracks live on window.APP.conference._room participants.
  // Polled whatever the mappings: a receiver reused for another participant
  // (JVB rewrites its sources onto a pool of receivers) is mapped again. And,
  // since such a receiver does not end when its participant leaves, the roster
  // is diffed as for LiveKit: anyone in the previous poll's roster but gone now
  // has left (the Node side no-ops ids it never mapped). A conference that cannot
  // be read is no roster at all, not an empty one: nobody is reported as left.
  const jitsiRoster = new Map(); // id -> name, at the previous poll
  function pollJitsi() {
    try {
      const room = window.APP && window.APP.conference && window.APP.conference._room;
      if (!room || !room.getParticipants) return;
      const seen = new Map();
      const claims = new Map();
      for (const p of room.getParticipants()) {
        seen.set(p.getId(), p.getDisplayName() || p.getId());
        if (tracks.size === 0) continue;
        for (const pt of (p.getTracks() || [])) {
          if (pt.getType && pt.getType() !== 'audio') continue;
          const id = pt.track && pt.track.id;
          if (id) claim(claims, id, { id: p.getId(), name: p.getDisplayName() || p.getId() });
        }
      }
      mapClaims(claims);
      jitsiRoster.forEach(function (name, id) {
        if (seen.has(id)) return;
        const left = sanitizeParticipant({ id: id, name: name });
        log('Jitsi participant left:', left.name, '(' + left.id + ')');
        sendJson({ type: 'participantLeft', participant: left });
        forgetParticipant(left.id);
      });
      jitsiRoster.clear();
      seen.forEach(function (name, id) { jitsiRoster.set(id, name); });
    } catch (e) { /* jitsi API not ready */ }
  }

  // LiveKit/Visio: find the Room object by walking the React fiber tree for the
  // characteristic { remoteParticipants, localParticipant } shape. Walk every
  // element's fiber (memoizedProps + memoizedState) up the return chain — this is
  // robust across Meet's component structure.
  let livekitRoom = null;
  // Roster of remote participants seen at the PREVIOUS poll (identity -> name).
  // LiveKit/Visio gives us no leave signal we can rely on: when a remote leaves,
  // its subscriber transceiver is reused and the MediaStreamTrack fires 'mute',
  // not 'ended' — so 'trackRemoved' never comes and the participant would stay
  // "present" forever, blocking the empty-meeting auto-leave. Mirror the Teams
  // roster-diff: every poll, anyone in the previous roster but absent now has
  // left, so emit 'participantLeft' for them (the Node side no-ops ids it never
  // mapped, so this is safe even for participants who never published audio).
  const livekitRoster = new Map();
  // setSubscribed(true) sends the SFU a subscription update: once, then again for
  // a publication that stays unsubscribed only after SUBSCRIBE_RETRY_MS, doubling
  // up to SUBSCRIBE_RETRY_MAX_MS (the fast poll must not flood the signalling).
  var SUBSCRIBE_RETRY_MS = 2000, SUBSCRIBE_RETRY_MAX_MS = 30000;
  const subscribeRequests = new WeakMap(); // publication -> { next, delay }
  function requestSubscription(pub, now) {
    if (pub.isSubscribed) { subscribeRequests.delete(pub); return; }
    if (typeof pub.setSubscribed !== 'function') return;
    const previous = subscribeRequests.get(pub);
    if (previous && now < previous.next) return;
    const delay = previous ? Math.min(previous.delay * 2, SUBSCRIBE_RETRY_MAX_MS) : SUBSCRIBE_RETRY_MS;
    subscribeRequests.set(pub, { next: now + delay, delay: delay });
    try { pub.setSubscribed(true); } catch (e) { /* ignore */ }
  }
  function findLivekitRoom() {
    try {
      const els = document.querySelectorAll('*');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        let fk = null;
        for (const k in el) { if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) { fk = k; break; } }
        if (!fk) continue;
        let f = el[fk], depth = 0;
        while (f && depth < 60) {
          const objs = [f.memoizedProps, f.memoizedState];
          for (let oi = 0; oi < objs.length; oi++) {
            const o = objs[oi];
            if (o && typeof o === 'object') {
              for (const key in o) {
                try {
                  const v = o[key];
                  if (v && typeof v === 'object' && v.localParticipant && (v.remoteParticipants || v.participants)) return v;
                } catch (e) { /* getter threw */ }
              }
            }
          }
          f = f.return; depth++;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function pollLivekit(now) {
    // Runs unconditionally (NOT gated on tracks) so it can find the Room and
    // FORCE subscription: a headless bot has no UI, so adaptive-stream never
    // subscribes on its own and no inbound tracks would ever arrive.
    if (window.APP && window.APP.conference) { noteSfuInternal(true); return; } // Jitsi handles its own mapping
    // A disconnected Room was left, or is not connected yet, or was replaced by a
    // new one: search again. A connecting / reconnecting one is kept.
    if (livekitRoom && livekitRoom.state === 'disconnected') livekitRoom = null;
    if (!livekitRoom) {
      if (now - lastRoomSearch < SFU_POLL_MS) return;
      lastRoomSearch = now;
      livekitRoom = findLivekitRoom();
      if (!livekitRoom) { noteSfuInternal(false); return; }
      log('LiveKit Room found');
    }
    noteSfuInternal(true);
    if (livekitRoom.state && livekitRoom.state !== 'connected') return;
    try {
      const remotes = livekitRoom.remoteParticipants || livekitRoom.participants;
      const seen = new Set();
      const claims = new Map();
      remotes.forEach(function (p) {
        seen.add(p.identity);
        p.trackPublications.forEach(function (pub) {
          if (pub.kind !== 'audio') return;
          // Force subscription to every remote audio track (adaptive-stream off).
          requestSubscription(pub, now);
          if (pub.track && pub.track.mediaStreamTrack) {
            claim(claims, pub.track.mediaStreamTrack.id, { id: p.identity, name: p.name || p.identity });
          }
        });
      });
      mapClaims(claims);
      // Roster diff: anyone present last poll but gone now has left the meeting.
      livekitRoster.forEach(function (name, identity) {
        if (!seen.has(identity)) {
          log('LiveKit participant left:', name, '(' + identity + ')');
          const left = sanitizeParticipant({ id: identity, name: name });
          sendJson({ type: 'participantLeft', participant: left });
          forgetParticipant(left.id);
          livekitRoster.delete(identity);
        }
      });
      remotes.forEach(function (p) { livekitRoster.set(p.identity, p.name || p.identity); });
    } catch (e) { /* ignore */ }
  }
  function pollSfu() {
    const now = Date.now();
    pollJitsi();
    if (!hasUnmappedTrack() && now - lastSfuPoll < SFU_POLL_MS) return;
    lastSfuPoll = now;
    pollLivekit(now);
  }
  intervals.push(setInterval(pollSfu, SFU_FAST_POLL_MS));
`

// ── Teams speaker detection (MCU: one mixed track, speaker from page state) ──
// Emitted only for platformType === 'teams'.
const TEAMS_SPEAKER_BLOCK = `
  const known = new Map(); // mri -> { id, name }
  let currentSpeakerId = null, startTime = 0;
  // Silence debounce for the active-speaker transition to "nobody speaking".
  // Teams' MCU is a single mixed track and the page-polled voiceLevel drops to 0
  // in the brief gaps BETWEEN words/turns. Emitting speakerChanged:null on every
  // such gap thrashes the Transcriber's currentSpeaker (a segment whose first ASR
  // partial happens to land in a gap would be pinned to null). The SFU path
  // already debounces this in AudioMixer (_silenceMs/silenceGraceMs); mirror it
  // here so a momentary lull does not wipe attribution. Only a sustained silence
  // (no voiceLevel>0 for SILENCE_GRACE_MS) actually clears the speaker.
  const SILENCE_GRACE_MS = 800;
  let silentSince = 0;
  // Detect a prolonged disappearance of the (undocumented) callingDebug API and
  // signal a degrade so the Node side can fall back to ASR diarization. 200ms
  // poll → 25 consecutive misses ≈ 5s. Warnings are throttled and the degrade is
  // signalled once. Misses only count once the call has been seen: before that
  // the bot is on the prejoin screen or in the lobby, where there is no call yet,
  // and a slow admission must not degrade the whole session. (If the API is gone
  // from the start, no participant is ever seen and the join watchdog fires.)
  let missCount = 0, degradeSignalled = false, lastWarnAt = 0, callSeen = false;
  const NATIVE_DIAR_MISS_LIMIT = 25;
  const WARN_THROTTLE_MS = 5000;
  function warnTeams(message) {
    const now = Date.now();
    if (now - lastWarnAt < WARN_THROTTLE_MS) return;
    lastWarnAt = now;
    try { console.warn('[WebRTC-Intercept] Teams native diarization: ' + message); } catch (e) {}
  }
  function signalNativeDiarDegrade(reason) {
    if (degradeSignalled) return;
    degradeSignalled = true;
    warnTeams('callingDebug unavailable after ' + missCount + ' polls (' + reason + '); falling back to ASR diarization');
    sendJson({ type: 'diarizationDegraded', mode: 'asr', reason: reason });
  }
  function noteCallingDebugMissing(reason) {
    missCount++;
    warnTeams('callingDebug ' + reason + ' (miss ' + missCount + '/' + NATIVE_DIAR_MISS_LIMIT + ')');
    if (missCount >= NATIVE_DIAR_MISS_LIMIT) signalNativeDiarDegrade(reason);
  }
  function pollTeams() {
    if (!startTime) startTime = Date.now();
    const position = Date.now() - startTime;
    let call;
    try {
      call = window.callingDebug && window.callingDebug.observableCall;
    } catch (e) {
      // The undocumented API threw (e.g. it was replaced/removed by an update).
      if (callSeen) noteCallingDebugMissing('threw: ' + (e && e.message ? e.message : 'unknown error'));
      return;
    }
    try {
      if (!call || !call.participants) {
        // Not in the call yet: nobody is known, nothing is missing.
        if (!callSeen) return;
        // The call or the API surface vanished. Tear down known participants;
        // count it toward the degrade detector.
        known.forEach(function (v, mri) { sendJson({ type: 'participantLeft', participant: sanitizeParticipant({ id: mri, name: v.name }) }); });
        known.clear();
        noteCallingDebugMissing(window.callingDebug ? 'present but no observable call' : 'absent');
        return;
      }
      // In the call, or the API is back: reset the degrade detector.
      callSeen = true;
      missCount = 0;
      const seen = new Set();
      // Pick the LOUDEST speaker, not the first one in iteration order. With
      // alternating speakers a just-stopped participant can still report a
      // residual voiceLevel before it decays to 0, and a silent ghost/duplicate
      // participant can sort ahead of the real one — "first with voiceLevel>0"
      // then attributes the wrong guest. Max voiceLevel is stable against both.
      let domId = null, domName = null, domLevel = 0;
      call.participants.forEach(function (p) {
        if (!p.mri || !p.displayName) return;
        seen.add(p.mri);
        const prev = known.get(p.mri);
        if (!prev || prev.name !== p.displayName) {
          known.set(p.mri, { id: p.mri, name: p.displayName });
          sendJson({ type: 'participantMapping', trackIndex: 0, participant: sanitizeParticipant({ id: p.mri, name: p.displayName }) });
        }
        const level = typeof p.voiceLevel === 'number' ? p.voiceLevel : 0;
        if (level > 0 && level > domLevel) { domLevel = level; domId = p.mri; domName = p.displayName; }
      });
      known.forEach(function (v, mri) {
        if (!seen.has(mri)) { known.delete(mri); sendJson({ type: 'participantLeft', participant: sanitizeParticipant({ id: mri, name: v.name }) }); }
      });
      // Debounce the transition to "nobody speaking": a momentary lull (one or a
      // few polls with no voiceLevel>0) must NOT emit speakerChanged:null, only a
      // sustained silence does. Switching directly between two speakers is still
      // reported immediately. While debouncing we hold the previous speaker.
      if (domId) {
        silentSince = 0;
        if (domId !== currentSpeakerId) {
          currentSpeakerId = domId;
          sendJson({ type: 'speakerChanged', position: position, speaker: sanitizeParticipant({ id: domId, name: domName }) });
        }
      } else if (currentSpeakerId !== null) {
        if (!silentSince) silentSince = Date.now();
        if (Date.now() - silentSince >= SILENCE_GRACE_MS) {
          silentSince = 0;
          currentSpeakerId = null;
          sendJson({ type: 'speakerChanged', position: position, speaker: null });
        }
      }
    } catch (e) {
      warnTeams('poll error: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }
  setTimeout(function () { intervals.push(setInterval(pollTeams, 200)); }, 3000);
`

module.exports = { getInterceptScript }
