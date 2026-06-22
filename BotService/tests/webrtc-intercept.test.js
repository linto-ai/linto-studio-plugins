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
})
