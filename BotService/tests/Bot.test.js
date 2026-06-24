const assert = require('assert')
const { describe, it, beforeEach } = require('mocha')
const Bot = require('../bot')

const MANIFESTS = ['jitsi', 'bigbluebutton', 'teams', 'visio']

function makeFakeMixer () {
  return {
    added: [], removed: [], stopped: false,
    addAudio (id, pcm, ts, name) { this.added.push({ id, name, len: pcm.length }) },
    removeParticipant (id) { this.removed.push(id) },
    on () {}, start () {}, stop () { this.stopped = true }
  }
}

function makeBot (botType, overrides = {}) {
  const bot = new Bot({
    session: { id: 's' },
    channel: { id: 'c' },
    address: 'https://example.com/room',
    botType,
    browserPool: { createContext: async () => ({ page: {} }), destroyContext: async () => {} },
    audioServer: { getPort: () => 1, registerBot () {}, unregisterBot () {} },
    ...overrides
  })
  return bot
}

describe('Bot manifests', () => {
  MANIFESTS.forEach((name) => {
    it(`${name}.json is valid and Playwright-only (no captions-back in v1)`, () => {
      const m = require(`../bot/manifests/${name}.json`)
      assert.ok(['sfu', 'mcu', 'teams'].includes(m.platformType))
      assert.ok(['native', 'asr'].includes(m.diarizationMode))
      assert.ok(Array.isArray(m.loginRules) && m.loginRules.length > 0)
      assert.equal(m.subtitleRules, undefined, 'captions-back-into-meeting is dropped for v1')
      assert.ok(Array.isArray(m.leaveRules))
      for (const rule of m.loginRules) {
        assert.notEqual(rule.action, 'type', 'use Playwright "fill", not Puppeteer "type"')
        if (rule.selector) assert.ok(!rule.selector.includes('::-p-text'), 'no Puppeteer ::-p-text selector')
      }
    })
  })

  it('jitsi/visio are SFU+native; bbb is MCU+asr; teams is teams+native', () => {
    assert.equal(require('../bot/manifests/jitsi.json').platformType, 'sfu')
    assert.equal(require('../bot/manifests/visio.json').platformType, 'sfu')
    assert.equal(require('../bot/manifests/bigbluebutton.json').platformType, 'mcu')
    assert.equal(require('../bot/manifests/bigbluebutton.json').diarizationMode, 'asr')
    assert.equal(require('../bot/manifests/teams.json').platformType, 'teams')
  })
})

describe('Bot', () => {
  it('refuses an unknown botType (no manifest, init returns false)', async () => {
    const bot = makeBot('evil/../../etc/passwd')
    assert.equal(bot.manifest, null)
    assert.equal(await bot.init(), false)
  })

  describe('SFU audio routing + native diarization', () => {
    let bot, mixer
    beforeEach(() => { bot = makeBot('visio'); mixer = makeFakeMixer(); bot.audioMixer = mixer })

    it('routes mapped-track audio to the mixer under the participant id', () => {
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(mixer.added.length, 1)
      assert.equal(mixer.added[0].id, 'u1')
      assert.equal(mixer.added[0].name, 'Alice')
    })

    it('buffers early (unmapped) audio and flushes it once the mapping arrives', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(mixer.added.length, 0, 'nothing mixed before mapping')
      assert.equal(bot.earlyAudio.get(0).length, 2)

      let joined = null
      bot.on('participant-joined', (p) => { joined = p })
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })

      assert.equal(mixer.added.length, 2, 'buffered frames flushed to the mixer')
      assert.deepEqual(joined, { identity: 'u1', name: 'Alice' })
      assert.equal(bot.earlyAudio.has(0), false)
    })

    it('emits participant-left and arms the empty-meeting timer when the last one leaves', (done) => {
      bot.emptyMeetingTimeoutMs = 10
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      let left = null
      bot.on('participant-left', (p) => { left = p })
      bot.on('meeting-empty', () => {
        assert.deepEqual(left, { identity: 'u1', name: 'Alice' })
        assert.deepEqual(mixer.removed, ['u1'])
        done()
      })
      bot._onParticipantLeft({ id: 'u1', name: 'Alice' })
    })

    it('cleans the early-audio buffer when its track is removed before any mapping', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(bot.earlyAudio.get(0).length, 2)
      assert.equal(bot.earlyAudioFirstSeen.has(0), true, 'age marker recorded')
      bot._onTrackRemoved(0)
      assert.equal(bot.earlyAudio.has(0), false, 'early-audio dropped on track removal')
      assert.equal(bot.earlyAudioFirstSeen.has(0), false, 'age marker dropped too (maps stay in sync)')
    })

    it('the reaper drops stale early-audio whose track was never mapped', () => {
      bot.handleAudioData(0, Buffer.alloc(640)) // stale: first seen "long ago"
      bot.handleAudioData(1, Buffer.alloc(640)) // fresh: first seen "now"
      // Backdate track 0 past the max age, leave track 1 fresh.
      bot.earlyAudioFirstSeen.set(0, Date.now() - 60000)
      assert.notEqual(bot.earlyAudioReaper, null, 'reaper armed while early-audio is buffered')
      bot._reapEarlyAudio() // runs the reaper body deterministically (no wall-clock wait)
      assert.equal(bot.earlyAudio.has(0), false, 'stale track 0 reaped')
      assert.equal(bot.earlyAudio.has(1), true, 'fresh track 1 kept')
    })

    it('the reaper stops itself once nothing is buffered', () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      bot.earlyAudioFirstSeen.set(0, Date.now() - 60000)
      assert.notEqual(bot.earlyAudioReaper, null)
      bot._reapEarlyAudio()
      assert.equal(bot.earlyAudio.size, 0)
      assert.equal(bot.earlyAudioReaper, null, 'reaper interval cleared when empty (no leak)')
    })

    it('dispose clears early-audio state and the reaper timer', async () => {
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.notEqual(bot.earlyAudioReaper, null)
      await bot.dispose()
      assert.equal(bot.earlyAudioReaper, null, 'reaper cleared on dispose')
      assert.equal(bot.earlyAudio.size, 0)
      assert.equal(bot.earlyAudioFirstSeen.size, 0)
    })

    it('cancels the empty-meeting timer when a new participant joins', () => {
      bot.emptyMeetingTimeoutMs = 10000
      bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
      bot._onParticipantLeft({ id: 'u1', name: 'Alice' })
      assert.notEqual(bot.emptyMeetingTimer, null)
      bot._onParticipantMapping(1, { id: 'u2', name: 'Bob' })
      assert.equal(bot.emptyMeetingTimer, null)
    })
  })

  describe('MCU/Teams pass-through audio', () => {
    it('forwards server-mixed audio as-is (no mixer)', () => {
      const bot = makeBot('bigbluebutton')
      assert.equal(bot.isSfu, false)
      let got = null
      bot.on('audio', (buf) => { got = buf })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.ok(got && got.length === 640)
    })

    it('holds Teams audio until admitted (no streaming from the lobby)', () => {
      const bot = makeBot('teams')
      let got = null
      bot.on('audio', (buf) => { got = buf })
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(got, null, 'no audio while still in the Teams lobby (not admitted)')
      bot.hasSeenParticipant = true // admitted: a participant was detected
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.ok(got && got.length === 640, 'audio flows once admitted')
    })

    it('forwards Teams page-polled speakerChanged', () => {
      const bot = makeBot('teams')
      let ev = null
      bot.on('speakerChanged', (e) => { ev = e })
      bot.handleJsonMessage({ type: 'speakerChanged', position: 100, speaker: { id: 'm1', name: 'Carol' } })
      assert.equal(ev.speaker.name, 'Carol')
    })

    it('falls back to ASR diarization on a diarizationDegraded signal', () => {
      const bot = makeBot('teams')
      assert.equal(bot.manifest.diarizationMode, 'native')
      let degraded = null
      bot.on('diarization-degraded', (e) => { degraded = e })
      bot.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'absent' })
      assert.equal(bot.manifest.diarizationMode, 'asr', 'manifest flipped to asr so reconnect-init advertises it')
      assert.equal(bot.diarizationDegraded, true)
      assert.deepEqual(degraded, { mode: 'asr', reason: 'absent' })
    })

    it('the diarizationDegraded handler is idempotent', () => {
      const bot = makeBot('teams')
      let count = 0
      bot.on('diarization-degraded', () => { count++ })
      bot.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'absent' })
      bot.handleJsonMessage({ type: 'diarizationDegraded', mode: 'asr', reason: 'threw' })
      assert.equal(count, 1, 'only the first degrade is acted on')
    })
  })

  it('auto-leaves via the join watchdog (join-timeout) when no participant is ever seen', (done) => {
    // A never-admitted leave is a FAILURE, emitted as a distinct 'join-timeout'
    // event (not the clean 'meeting-empty') so it is not counted as success.
    const bot = makeBot('visio')
    bot.joinTimeoutMs = 10
    bot.on('join-timeout', () => done())
    bot._armJoinWatchdog()
  })

  it('cancels the join watchdog once a participant is mapped', () => {
    const bot = makeBot('visio')
    bot.joinTimeoutMs = 10000
    bot._armJoinWatchdog()
    assert.notEqual(bot.joinWatchdog, null)
    bot._onParticipantMapping(0, { id: 'u1', name: 'Alice' })
    assert.equal(bot.joinWatchdog, null)
  })

  it('dispose() is idempotent', async () => {
    const bot = makeBot('visio')
    await bot.dispose()
    assert.equal(bot.disposed, true)
    await bot.dispose() // must not throw / double-run
  })

  it('substitutes {{botName}} in fill rule values', () => {
    const bot = makeBot('visio')
    bot.botName = 'Acme Bot'
    assert.equal(bot._template('{{botName}}'), 'Acme Bot')
    assert.equal(bot._template('static'), 'static')
  })

  // Audio-silence watchdog — once admitted the bot expects a steady PCM flow;
  // a prolonged gap means the capture pipe died, so emit a fatal 'error'.
  describe('audio-silence watchdog', () => {
    it('emits error when no audio arrives within the silence timeout after admission', () => {
      const bot = makeBot('visio')
      let err = null
      bot.on('error', (e) => { err = e })
      // Force a tiny timeout and arm the watchdog as admission would.
      const realNow = Date.now()
      bot.lastAudioAt = realNow - 60000 // long ago
      bot._checkAudioSilence(realNow) // direct check (deterministic, no timers)
      // The watchdog only fires when AUDIO_SILENCE_TIMEOUT_MS > 0 (default 30s).
      assert.ok(err instanceof Error, 'a fatal error is emitted on prolonged silence')
      assert.equal(err.message, 'audio-capture-dead')
    })

    it('does NOT emit error while audio is flowing', () => {
      const bot = makeBot('visio')
      let err = null
      bot.on('error', (e) => { err = e })
      bot.handleAudioData(0, Buffer.alloc(640)) // updates lastAudioAt to now
      bot._checkAudioSilence(Date.now())
      assert.equal(err, null, 'no error while audio is recent')
    })

    it('logs the first audio frame once (latched) and updates lastAudioAt', () => {
      const bot = makeBot('visio')
      assert.equal(bot.hasSeenAudio, false)
      bot.handleAudioData(0, Buffer.alloc(640))
      assert.equal(bot.hasSeenAudio, true)
      assert.ok(bot.lastAudioAt > 0)
    })

    it('cancels the silence watchdog on dispose', async () => {
      const bot = makeBot('visio')
      bot._armAudioSilenceWatchdog()
      // The watchdog only arms when the timeout is enabled (default on).
      await bot.dispose()
      assert.equal(bot.audioSilenceWatchdog, null)
    })
  })
})
