/**
 * WebRTC interception script generator.
 *
 * Produces a self-contained JavaScript string injected into the meeting page via
 * page.addInitScript(). It runs entirely in the browser and:
 *   1. patches RTCPeerConnection to capture every inbound audio track;
 *   2. resamples each track to 16 kHz S16LE in-page (AudioWorklet, ScriptProcessor
 *      fallback) and streams it as binary frames to the loopback LocalAudioServer;
 *   3. maps tracks to participants per platform so the Node side can do native
 *      diarization (SFU) or forward server-side speaker info (Teams).
 *
 * Binary frame: [uint16BE trackIndex][uint16BE reserved=0][...PCM]. Control
 * messages are sent as JSON text frames.
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

  // getUserMedia shim. Headless Chromium has no real capture device, so the
  // meeting SPA's getUserMedia throws NotFoundError and the join never finalizes
  // (the bot connects the signaling WS but is never admitted as a participant and
  // receives no remote tracks). Return synthetic SILENT audio + a blank video
  // track so the join completes; the bot only subscribes to others' tracks, it
  // never needs to publish real media.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
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
  const MAX_RECONNECT_RETRIES = 10;
  const RECONNECT_DELAY_MS = 1000;
  const intervals = [];

  function log() { if (DEBUG) console.log.apply(console, ['[WebRTC-Intercept]'].concat([].slice.call(arguments))); }
  // 1b/E8: critical in-page faults must reach the Node logs regardless of DEBUG.
  // console.warn is bridged to logger.warn by the page-console handler in
  // bot/index.js (it surfaces '[WebRTC-Intercept]' warnings at warn level), so an
  // otherwise-invisible failure (capture pipe permanently dead, worklet fallback,
  // Room never found) becomes greppable. Each call site latches to avoid flooding.
  function warn() { try { console.warn.apply(console, ['[WebRTC-Intercept]'].concat([].slice.call(arguments))); } catch (e) {} }

  // ── Sanitization (T15) ────────────────────────────────────────────────────
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
  // T6: remember mappings already announced (trackIndex -> participant) so that
  // after a Node-side LocalAudioServer crash/restart we can re-emit them on
  // reconnect (the browser kept its mappings; the Node AudioMixer lost them).
  let hasConnectedOnce = false;
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
        // T6: on a RE-open (Node side restarted), replay mappings ONLY — no
        // audio — so already-mapped tracks are re-announced to the new mixer.
        if (hasConnectedOnce && sentMappings.size > 0) {
          log('ws reconnected, replaying', sentMappings.size, 'participant mappings');
          sentMappings.forEach(function (participant, trackIndex) {
            sendJson({ type: 'participantMapping', trackIndex: trackIndex, participant: participant });
          });
        }
        hasConnectedOnce = true;
      };
      ws.onclose = function () {
        wsReady = false;
        if (disposed) return;
        if (reconnectAttempts < MAX_RECONNECT_RETRIES) {
          reconnectAttempts++;
          reconnectTimer = setTimeout(connectWs, RECONNECT_DELAY_MS);
        } else {
          // 1b/E8: giving up here permanently kills audio capture (disposed=true
          // stops every reconnect) — this was invisible at non-DEBUG. Warn so the
          // Node side (E8 silence watchdog) and operators learn the pipe is dead.
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
  // Linear-interpolation resample (no anti-alias filter). Adequate for speech
  // ASR at v1; revisit if downsampling artefacts hurt accuracy.
  function resample(input, sourceRate) {
    if (sourceRate === TARGET_SAMPLE_RATE) return input;
    const ratio = sourceRate / TARGET_SAMPLE_RATE;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = idx - lo;
      out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return out;
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
  let sharedCtx = null, workletReady = false, audioSinks = [];

  async function setupTrackCapture(track, tIdx) {
    if (!sharedCtx) sharedCtx = new AudioContext();
    const ctx = sharedCtx;
    // Headless Chromium starts the AudioContext suspended (no audio output to
    // drive it); without resuming, the AudioWorklet never pulls samples and no
    // PCM is ever captured.
    try { if (ctx.state !== 'running') await ctx.resume(); } catch (e) {}
    const sourceRate = ctx.sampleRate;
    const ms = new MediaStream([track]);
    // Chrome quirk: a remote WebRTC audio track does NOT feed a
    // MediaStreamAudioSourceNode unless it is ALSO attached to a playing
    // HTMLMediaElement. Without this sink, process() receives only silence.
    try {
      const sink = document.createElement('audio');
      sink.srcObject = ms; sink.muted = true; sink.autoplay = true;
      sink.play().catch(function () {});
      (audioSinks = audioSinks || []).push(sink);
    } catch (e) {}
    const source = ctx.createMediaStreamSource(ms);

    try {
      if (!workletReady) {
        const code = 'class PCMCapture extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c&&c.length>0)this.port.postMessage(new Float32Array(c));return true;}}registerProcessor("pcm-capture",PCMCapture);';
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        workletReady = true;
      }
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      source.connect(node);
      node.connect(ctx.destination); // keeps the graph pulling
      node.port.onmessage = function (e) { sendBinary(tIdx, float32ToInt16(resample(e.data, sourceRate))); };
      log('AudioWorklet capture for track', tIdx);
    } catch (e) {
      // 1b: the ScriptProcessor path is deprecated and degraded — surface the
      // fallback at warn (independent of DEBUG) so it is visible in the Node logs.
      warn('AudioWorklet unavailable, falling back to ScriptProcessor (track ' + tIdx + '): ' + (e && e.message ? e.message : 'unknown'));
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      source.connect(proc);
      proc.connect(ctx.destination);
      proc.onaudioprocess = function (ev) {
        sendBinary(tIdx, float32ToInt16(resample(ev.inputBuffer.getChannelData(0), sourceRate)));
      };
    }
  }

  function handleNewTrack(track) {
    if (!track || track.kind !== 'audio' || processedTracks.has(track.id)) return;
    processedTracks.add(track.id);
    const tIdx = trackIndexSeq++;
    tracks.set(track.id, { index: tIdx, participantId: null });
    sendJson({ type: 'trackAdded', trackId: track.id, trackIndex: tIdx });
    setupTrackCapture(track, tIdx).catch(function (e) { log('capture setup failed', e && e.message); });
    track.addEventListener('ended', function () {
      sendJson({ type: 'trackRemoved', trackId: track.id, trackIndex: tIdx });
      tracks.delete(track.id);
      processedTracks.delete(track.id);
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
  function mapTrack(trackId, participant) {
    const info = tracks.get(trackId);
    if (!info || info.participantId) return;
    const clean = sanitizeParticipant(participant); // T15: strip control chars + cap length
    info.participantId = clean.id;
    sentMappings.set(info.index, clean); // T6: remember for reconnect replay
    sendJson({ type: 'participantMapping', trackIndex: info.index, participant: clean });
    log('mapped track', info.index, '->', clean.name);
  }

  ${platformBlock}

  window.addEventListener('beforeunload', function () {
    disposed = true;
    intervals.forEach(clearInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });

  connectWs();
  log('initialised for platform', PLATFORM_TYPE);
})();
`
}

// ── SFU participant mapping (Jitsi + LiveKit/Visio) ─────────────────────────
// Emitted only for platformType === 'sfu'. Relies on shared helpers
// (tracks, hasUnmappedTrack, mapTrack, sendJson, intervals, log).
const SFU_MAPPING_BLOCK = `
  // 1b/E8: if neither the Jitsi conference nor the LiveKit Room internal is ever
  // found, no track is ever subscribed/mapped and the bot captures nothing. That
  // was silent at non-DEBUG; count consecutive polls with no Room/conference and
  // warn once after the limit so the failure (page structure changed / never
  // joined) is visible. ~N polls of the 1.5s LiveKit interval.
  var sfuNotFoundPolls = 0, sfuNotFoundWarned = false;
  var SFU_NOT_FOUND_LIMIT = 20;
  function noteSfuInternal(found) {
    if (found) { sfuNotFoundPolls = 0; return; }
    if (sfuNotFoundWarned) return;
    sfuNotFoundPolls++;
    if (sfuNotFoundPolls >= SFU_NOT_FOUND_LIMIT) {
      sfuNotFoundWarned = true;
      warn('SFU Room/conference internal never found after ' + sfuNotFoundPolls + ' polls — no audio tracks will be captured');
    }
  }

  // Jitsi: tracks live on window.APP.conference._room participants.
  function pollJitsi() {
    if (tracks.size === 0 || !hasUnmappedTrack()) return;
    try {
      const room = window.APP && window.APP.conference && window.APP.conference._room;
      if (!room || !room.getParticipants) return;
      for (const p of room.getParticipants()) {
        for (const pt of (p.getTracks() || [])) {
          if (pt.getType && pt.getType() !== 'audio') continue;
          const id = pt.track && pt.track.id;
          if (id) mapTrack(id, { id: p.getId(), name: p.getDisplayName() || p.getId() });
        }
      }
    } catch (e) { /* jitsi API not ready */ }
  }

  // LiveKit/Visio: find the Room object by walking the React fiber tree for the
  // characteristic { remoteParticipants, localParticipant } shape. Walk every
  // element's fiber (memoizedProps + memoizedState) up the return chain — this is
  // robust across Meet's component structure.
  let livekitRoom = null;
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
  function pollLivekit() {
    // Runs unconditionally (NOT gated on tracks) so it can find the Room and
    // FORCE subscription: a headless bot has no UI, so adaptive-stream never
    // subscribes on its own and no inbound tracks would ever arrive.
    if (window.APP && window.APP.conference) { noteSfuInternal(true); return; } // Jitsi handles its own mapping
    if (!livekitRoom) { livekitRoom = findLivekitRoom(); if (!livekitRoom) { noteSfuInternal(false); return; } log('LiveKit Room found'); }
    noteSfuInternal(true);
    if (livekitRoom.state && livekitRoom.state !== 'connected') { livekitRoom = null; return; }
    try {
      const remotes = livekitRoom.remoteParticipants || livekitRoom.participants;
      remotes.forEach(function (p) {
        p.trackPublications.forEach(function (pub) {
          if (pub.kind !== 'audio') return;
          // Force subscription to every remote audio track (adaptive-stream off).
          if (!pub.isSubscribed && typeof pub.setSubscribed === 'function') {
            try { pub.setSubscribed(true); } catch (e) { /* ignore */ }
          }
          if (pub.track && pub.track.mediaStreamTrack) {
            mapTrack(pub.track.mediaStreamTrack.id, { id: p.identity, name: p.name || p.identity });
          }
        });
      });
    } catch (e) { /* ignore */ }
  }
  setTimeout(function () { intervals.push(setInterval(pollJitsi, 2000)); intervals.push(setInterval(pollLivekit, 1500)); }, 3000);
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
  // T14: detect a prolonged disappearance of the (undocumented) callingDebug API
  // and signal a degrade so the Node side can fall back to ASR diarization.
  // 200ms poll → 25 consecutive misses ≈ 5s. Warnings are throttled (surfaced via
  // the page-console bridge) so a missing API does not flood the logs, and the
  // degrade is signalled once.
  let missCount = 0, degradeSignalled = false, lastWarnAt = 0;
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
      noteCallingDebugMissing('threw: ' + (e && e.message ? e.message : 'unknown error'));
      return;
    }
    try {
      if (!call || !call.participants) {
        // No live call yet OR the API surface vanished. Tear down known
        // participants; count it toward the degrade detector.
        known.forEach(function (v, mri) { sendJson({ type: 'participantLeft', participant: sanitizeParticipant({ id: mri, name: v.name }) }); });
        known.clear();
        noteCallingDebugMissing(window.callingDebug ? 'present but no observable call' : 'absent');
        return;
      }
      // API is back / available again: reset the degrade detector.
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
