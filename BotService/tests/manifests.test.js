const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { describe, it } = require('mocha')

// Runtime contract guard for the per-platform bot manifests. These JSON files
// drive the headless-browser join/leave automation (Bot.execRules) and the
// in-page WebRTC interceptor (platformType) and the Transcriber diarization mode
// (diarizationMode). A silent edit — a renamed selector key, a typo'd
// {{botName}} placeholder, an unknown action, an out-of-range platformType —
// would break a bot join in production with no unit-test signal. This suite
// asserts the structural invariants the source code relies on.

const MANIFEST_DIR = path.join(__dirname, '..', 'bot', 'manifests')

// Must match KNOWN_BOT_TYPES in bot/index.js (the allowlist gating the require).
const KNOWN_BOT_TYPES = ['jitsi', 'bigbluebutton', 'teams', 'visio']

// platformType drives BrowserPool/Bot SFU mixing and webrtc-intercept block
// selection (sfu | mcu | teams). diarizationMode is read by TranscriberStream.
const VALID_PLATFORM_TYPES = ['sfu', 'mcu', 'teams']
const VALID_DIARIZATION_MODES = ['native', 'asr']

// Action vocabulary understood by Bot.execRule()'s switch. An action outside this
// set hits the no-op default branch and silently fails to drive the page.
const VALID_ACTIONS = [
  'fill', 'click', 'waitForSelector', 'waitForTimeout', 'evaluate',
  'press', 'goto', 'select', 'hover', 'focus', 'clearInput'
]

// Actions that target a DOM element and therefore require a `selector`.
const SELECTOR_ACTIONS = ['fill', 'click', 'waitForSelector', 'select', 'hover', 'focus', 'clearInput']

function loadManifest (botType) {
  return JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, `${botType}.json`), 'utf8'))
}

function assertRuleWellFormed (rule, ctx) {
  assert.equal(typeof rule, 'object', `${ctx}: rule must be an object`)
  assert.ok(VALID_ACTIONS.includes(rule.action), `${ctx}: unknown action '${rule.action}'`)

  if (SELECTOR_ACTIONS.includes(rule.action)) {
    assert.equal(typeof rule.selector, 'string', `${ctx}: '${rule.action}' needs a string selector`)
    assert.ok(rule.selector.length > 0, `${ctx}: '${rule.action}' selector is empty`)
  }
  if (rule.action === 'goto') {
    assert.equal(typeof rule.url, 'string', `${ctx}: 'goto' needs a url`)
    assert.ok(rule.url.length > 0, `${ctx}: 'goto' url is empty`)
  }
  if (rule.action === 'press') {
    assert.equal(typeof rule.key, 'string', `${ctx}: 'press' needs a key`)
  }
  // Every rule should carry a positive timeout (execRule defaults to 30000 but the
  // manifests set it explicitly per platform; a non-number is a typo).
  assert.equal(typeof rule.timeout, 'number', `${ctx}: timeout must be a number`)
  assert.ok(rule.timeout > 0, `${ctx}: timeout must be positive`)
  if ('optional' in rule) {
    assert.equal(typeof rule.optional, 'boolean', `${ctx}: optional must be a boolean`)
  }
}

describe('bot manifests', () => {
  it('ships exactly one manifest file per known bot type', () => {
    const files = fs.readdirSync(MANIFEST_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort()
    assert.deepEqual(files, [...KNOWN_BOT_TYPES].sort())
  })

  for (const botType of KNOWN_BOT_TYPES) {
    describe(`${botType}.json`, () => {
      const manifest = loadManifest(botType)

      it('declares a valid platformType', () => {
        assert.ok(VALID_PLATFORM_TYPES.includes(manifest.platformType),
          `platformType '${manifest.platformType}' not in ${VALID_PLATFORM_TYPES.join('|')}`)
      })

      it('declares a valid diarizationMode', () => {
        assert.ok(VALID_DIARIZATION_MODES.includes(manifest.diarizationMode),
          `diarizationMode '${manifest.diarizationMode}' not in ${VALID_DIARIZATION_MODES.join('|')}`)
      })

      it('has a non-empty leaveRules array of well-formed rules', () => {
        assert.ok(Array.isArray(manifest.leaveRules), 'leaveRules must be an array')
        assert.ok(manifest.leaveRules.length > 0, 'leaveRules must not be empty')
        manifest.leaveRules.forEach((r, i) => assertRuleWellFormed(r, `${botType}.leaveRules[${i}]`))
      })

      it('has a non-empty loginRules array of well-formed rules', () => {
        assert.ok(Array.isArray(manifest.loginRules), 'loginRules must be an array')
        assert.ok(manifest.loginRules.length > 0, 'loginRules must not be empty')
        manifest.loginRules.forEach((r, i) => assertRuleWellFormed(r, `${botType}.loginRules[${i}]`))
      })

      it('uses the {{botName}} placeholder exactly where the name is filled', () => {
        // Bot._template only substitutes {{botName}} (exact spelling) into a fill
        // value. Each platform enters the display name once via a `fill` rule, so
        // the placeholder must appear in exactly one rule's value — verbatim.
        const fillsWithPlaceholder = manifest.loginRules.filter(
          r => r.action === 'fill' && typeof r.value === 'string' && r.value.includes('{{botName}}')
        )
        assert.equal(fillsWithPlaceholder.length, 1,
          `${botType}: expected exactly one fill rule using {{botName}}, found ${fillsWithPlaceholder.length}`)

        // Guard against a near-miss typo (e.g. {{ botName }}, {{botname}}, {botName})
        // that _template would NOT substitute, leaving a literal placeholder in the name.
        const raw = JSON.stringify(manifest)
        const placeholderLike = raw.match(/\{\{?\s*bot[ _]?name\s*\}?\}/gi) || []
        for (const token of placeholderLike) {
          assert.equal(token, '{{botName}}',
            `${botType}: malformed placeholder '${token}' will not be substituted (expected '{{botName}}')`)
        }
      })
    })
  }

  it('SFU manifests use native diarization, the MCU manifest uses asr', () => {
    // Cross-check the platform/diarization pairing the pipeline assumes: SFU bots
    // mix per-participant tracks and emit native speaker labels; the MCU (BBB,
    // single mixed stream) cannot, so it falls back to ASR diarization.
    for (const botType of KNOWN_BOT_TYPES) {
      const m = loadManifest(botType)
      if (m.platformType === 'sfu') {
        assert.equal(m.diarizationMode, 'native', `${botType} (sfu) should diarize natively`)
      }
      if (m.platformType === 'mcu') {
        assert.equal(m.diarizationMode, 'asr', `${botType} (mcu) should diarize via asr`)
      }
    }
  })
})
