const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { describe, it, beforeEach, afterEach } = require('mocha')
const { processTreeMemory } = require('../components/BrokerClient/processTree')

describe('processTreeMemory', () => {
  // A fake procfs: { pid: { ppid, rssKb } }, rssKb null for a kernel thread.
  let procDir
  beforeEach(() => { procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-')) })
  afterEach(() => { fs.rmSync(procDir, { recursive: true, force: true }) })
  function fakeProc (processes) {
    for (const [pid, { ppid, rssKb }] of Object.entries(processes)) {
      fs.mkdirSync(path.join(procDir, pid))
      const lines = [`Name:\tp${pid}`, `Pid:\t${pid}`, `PPid:\t${ppid}`]
      if (rssKb != null) lines.push(`VmRSS:\t  ${rssKb} kB`)
      fs.writeFileSync(path.join(procDir, pid, 'status'), lines.join('\n') + '\n')
    }
    fs.mkdirSync(path.join(procDir, 'self'))
    fs.writeFileSync(path.join(procDir, 'meminfo'), 'MemTotal: 1 kB\n')
  }

  it('sums the RSS of the root and all its descendants, nothing else', () => {
    fakeProc({
      1: { ppid: 0, rssKb: 1000 },
      10: { ppid: 1, rssKb: 100 }, // node (root)
      11: { ppid: 10, rssKb: 200 }, // chromium browser
      12: { ppid: 11, rssKb: 300 }, // renderer
      13: { ppid: 11, rssKb: 400 }, // renderer
      20: { ppid: 1, rssKb: 5000 } // unrelated
    })
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 1000 * 1024, processes: 4 })
  })

  it('counts a process without VmRSS (kernel thread, zombie) as 0', () => {
    fakeProc({ 10: { ppid: 1, rssKb: 100 }, 11: { ppid: 10, rssKb: null } })
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 100 * 1024, processes: 2 })
  })

  it('skips a process that exited during the scan', () => {
    fakeProc({ 10: { ppid: 1, rssKb: 100 }, 11: { ppid: 10, rssKb: 50 } })
    fs.mkdirSync(path.join(procDir, '12')) // listed, but its status is gone
    assert.deepEqual(processTreeMemory(10, procDir), { rss: 150 * 1024, processes: 2 })
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
