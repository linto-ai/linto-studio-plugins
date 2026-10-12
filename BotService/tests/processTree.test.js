const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { describe, it, beforeEach, afterEach } = require('mocha')
const { processTreeMemory } = require('../components/BrokerClient/processTree')

describe('processTreeMemory', () => {
  // A fake procfs: { pid: { ppid, rssKb, pssKb } }, rssKb null for a kernel thread,
  // no smaps_rollup without pssKb.
  let procDir
  beforeEach(() => { procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-')) })
  afterEach(() => { fs.rmSync(procDir, { recursive: true, force: true }) })
  function fakeProc (processes) {
    for (const [pid, { ppid, rssKb, pssKb }] of Object.entries(processes)) {
      fs.mkdirSync(path.join(procDir, pid))
      const lines = [`Name:\tp${pid}`, `Pid:\t${pid}`, `PPid:\t${ppid}`]
      if (rssKb != null) lines.push(`VmRSS:\t  ${rssKb} kB`)
      fs.writeFileSync(path.join(procDir, pid, 'status'), lines.join('\n') + '\n')
      if (pssKb != null) {
        fs.writeFileSync(path.join(procDir, pid, 'smaps_rollup'),
          `55d0-7ffd ---p 00000000 00:00 0  [rollup]\nRss:  ${rssKb} kB\nPss:  ${pssKb} kB\nPss_Anon:  1 kB\n`)
      }
    }
    fs.mkdirSync(path.join(procDir, 'self'))
    fs.writeFileSync(path.join(procDir, 'meminfo'), 'MemTotal: 1 kB\n')
  }

  it('sums the RSS and the PSS of the root and all its descendants, nothing else', () => {
    fakeProc({
      1: { ppid: 0, rssKb: 1000, pssKb: 900 },
      10: { ppid: 1, rssKb: 100, pssKb: 80 }, // node (root)
      11: { ppid: 10, rssKb: 200, pssKb: 120 }, // chromium browser
      12: { ppid: 11, rssKb: 300, pssKb: 150 }, // renderer: shared pages split
      13: { ppid: 11, rssKb: 400, pssKb: 250 }, // renderer
      20: { ppid: 1, rssKb: 5000, pssKb: 5000 } // unrelated
    })
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 1000 * 1024, pss: 600 * 1024, processes: 4 })
  })

  it('counts the RSS of a process whose smaps_rollup cannot be read', () => {
    fakeProc({ 10: { ppid: 1, rssKb: 100, pssKb: 60 }, 11: { ppid: 10, rssKb: 50 } })
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 150 * 1024, pss: 110 * 1024, processes: 2 })
  })

  it('counts a process without VmRSS (kernel thread, zombie) as 0', () => {
    fakeProc({ 10: { ppid: 1, rssKb: 100, pssKb: 100 }, 11: { ppid: 10, rssKb: null } })
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 100 * 1024, pss: 100 * 1024, processes: 2 })
  })

  it('skips a process that exited during the scan', () => {
    fakeProc({ 10: { ppid: 1, rssKb: 100, pssKb: 100 }, 11: { ppid: 10, rssKb: 50, pssKb: 50 } })
    fs.mkdirSync(path.join(procDir, '12')) // listed, but its status is gone
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 150 * 1024, pss: 150 * 1024, processes: 2 })
  })

  it('returns null when the root is not found or /proc cannot be read', () => {
    fakeProc({ 10: { ppid: 1, rssKb: 100 } })
    assert.equal(processTreeMemory(99, procDir), null)
    assert.equal(processTreeMemory(10, path.join(procDir, 'missing')), null)
  })

  if (process.platform === 'linux') {
    it('measures this process and its children from the real /proc', async () => {
      const own = processTreeMemory(process.pid)
      assert.ok(own.rss > 10 * 1024 * 1024 && own.processes >= 1)
      assert.ok(own.pss > 0 && own.pss <= own.rss, `pss ${own.pss} rss ${own.rss}`)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
      try {
        await new Promise((resolve) => setTimeout(resolve, 300))
        const alone = processTreeMemory(child.pid)
        assert.ok(alone && alone.rss > 0 && alone.processes === 1)
        const withChild = processTreeMemory(process.pid)
        assert.equal(withChild.processes, own.processes + 1)
        assert.ok(withChild.rss >= alone.rss)
      } finally {
        child.kill()
      }
    })
  }
})
