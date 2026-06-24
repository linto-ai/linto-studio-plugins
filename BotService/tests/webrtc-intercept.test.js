const assert = require('assert')
const { describe, it } = require('mocha')
const { getInterceptScript } = require('../bot/webrtc-intercept')

const WS = 'ws://127.0.0.1:12345/bot-sess_1'

describe('webrtc-intercept getInterceptScript()', () => {
  it('produces syntactically valid JavaScript', () => {
    const script = getInterceptScript(WS, { platformType: 'sfu' })
    assert.doesNotThrow(() => new Function(script)) // compiles (parses) without executing
  })

  it('intercepts RTCPeerConnection and captures PCM at 16kHz', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(s.includes('RTCPeerConnection'))
    assert.ok(s.includes('pcm-capture'))
    assert.ok(s.includes('createScriptProcessor')) // AudioWorklet fallback
    assert.ok(s.includes('TARGET_SAMPLE_RATE = 16000'))
    assert.ok(s.includes('float32ToInt16'))
  })

  it('embeds the loopback WS URL as a safely-escaped string literal', () => {
    const tricky = 'ws://127.0.0.1:1/bot-"; alert(1);//'
    const s = getInterceptScript(tricky, { platformType: 'mcu' })
    assert.ok(s.includes(JSON.stringify(tricky)))
    assert.doesNotThrow(() => new Function(s))
  })

  it('enables SFU participant mapping (Jitsi + LiveKit) only for sfu', () => {
    const sfu = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(sfu.includes('findLivekitRoom'))
    assert.ok(sfu.includes('window.APP'))
    assert.ok(!sfu.includes('callingDebug'))

    const mcu = getInterceptScript(WS, { platformType: 'mcu' })
    assert.ok(!mcu.includes('findLivekitRoom'))
    assert.ok(!mcu.includes('callingDebug'))
  })

  it('enables Teams speaker polling only for teams', () => {
    const teams = getInterceptScript(WS, { platformType: 'teams' })
    assert.ok(teams.includes('callingDebug'))
    assert.ok(teams.includes('voiceLevel'))
    assert.ok(!teams.includes('findLivekitRoom'))
  })

  it('threads the debug flag through', () => {
    assert.ok(getInterceptScript(WS, { platformType: 'sfu', debug: true }).includes('const DEBUG = true'))
    assert.ok(getInterceptScript(WS, { platformType: 'sfu' }).includes('const DEBUG = false'))
  })

  // Loopback WS resync after LocalAudioServer restart.
  it('remembers sent mappings and replays them only on a reconnect (not first connect)', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(s.includes('sentMappings'), 'records mappings already sent')
    assert.ok(s.includes('hasConnectedOnce'), 'gates replay behind the first connect')
    assert.ok(/hasConnectedOnce\s*&&\s*sentMappings\.size/.test(s), 'replays only after first connect')
    assert.ok(s.includes('replaying'))
    assert.ok(s.includes('hasConnectedOnce = true'))
    assert.doesNotThrow(() => new Function(s))
  })

  // Teams native-diar fallback + logging.
  it('logs and signals a degrade when Teams callingDebug disappears', () => {
    const teams = getInterceptScript(WS, { platformType: 'teams' })
    assert.ok(teams.includes('console.warn'), 'warns via the page-console bridge')
    assert.ok(teams.includes('diarizationDegraded'), 'signals a degrade control message')
    assert.ok(teams.includes('NATIVE_DIAR_MISS_LIMIT'), 'detects prolonged unavailability')
    assert.ok(teams.includes("mode: 'asr'") || teams.includes('mode: "asr"'), 'fallback to ASR')
    assert.ok(teams.includes('noteCallingDebugMissing'), 'a throwing callingDebug is handled, not swallowed')
    assert.doesNotThrow(() => new Function(teams))
    // SFU build never ships the Teams degrade logic.
    const sfu = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(!sfu.includes('diarizationDegraded'))
  })

  // Sanitize participant id/name before sending.
  it('sanitizes participant id/name (control chars + length cap) before sending', () => {
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    assert.ok(s.includes('sanitizeParticipant'), 'sanitizes participants')
    assert.ok(s.includes('SANITIZE_MAX_LEN'), 'length-caps the values')
    assert.ok(/const clean = sanitizeParticipant/.test(s), 'mapTrack routes through the sanitizer')
    const teams = getInterceptScript(WS, { platformType: 'teams' })
    assert.ok(teams.includes('sanitizeParticipant'), 'Teams mappings go through the sanitizer')
  })

  it('the sanitizer strips control chars and caps length (behavioral)', () => {
    // Extract and evaluate the sanitizeText implementation in isolation to prove
    // the generated regex/logic actually scrubs ANSI/newline injection.
    const s = getInterceptScript(WS, { platformType: 'sfu' })
    const start = s.indexOf('function sanitizeText')
    assert.ok(start > -1, 'sanitizeText present')
    const constLine = s.match(/var SANITIZE_MAX_LEN = \d+;/)[0]
    const fnEnd = s.indexOf('function sanitizeParticipant')
    const fnSrc = s.slice(start, fnEnd)
    const sanitizeText = new Function(constLine + '\n' + fnSrc + '\nreturn sanitizeText;')()

    const ESC = String.fromCharCode(27) // ANSI escape introducer
    const NL = String.fromCharCode(10)
    const CR = String.fromCharCode(13)
    const out = sanitizeText('Alice' + ESC + '[31m' + CR + NL + 'Bob')
    assert.ok(out.indexOf(ESC) === -1, 'ESC stripped')
    assert.ok(out.indexOf(NL) === -1 && out.indexOf(CR) === -1, 'newlines stripped')
    const controlRe = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]')
    assert.ok(!controlRe.test(out), 'no control chars remain')
    assert.equal(sanitizeText('x'.repeat(5000)).length, 256, 'length capped to 256')
    assert.equal(sanitizeText(null), null, 'null passes through')
    assert.equal(sanitizeText('  plain  '), 'plain', 'trims surrounding whitespace')
  })
})
