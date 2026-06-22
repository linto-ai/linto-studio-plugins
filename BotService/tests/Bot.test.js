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

    it('forwards Teams page-polled speakerChanged', () => {
      const bot = makeBot('teams')
      let ev = null
      bot.on('speakerChanged', (e) => { ev = e })
      bot.handleJsonMessage({ type: 'speakerChanged', position: 100, speaker: { id: 'm1', name: 'Carol' } })
      assert.equal(ev.speaker.name, 'Carol')
    })
  })

  it('substitutes {{botName}} in fill rule values', () => {
    const bot = makeBot('visio')
    bot.botName = 'Acme Bot'
    assert.equal(bot._template('{{botName}}'), 'Acme Bot')
    assert.equal(bot._template('static'), 'static')
  })
})
