const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { describe, it, beforeEach, afterEach } = require('mocha')
const { readCgroupMemory, memoryBudget, DEFAULT_LIMIT_SHARE, LEGACY_CEILING_MB } = require('../components/BrokerClient/memory')

const MB = 1024 * 1024
const GiB = 1024 * MB

describe('readCgroupMemory', () => {
  // A fake /proc and /sys/fs/cgroup: files { 'relative/path': content }.
  let root, procDir, cgroupRoot
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-'))
    procDir = path.join(root, 'proc')
    cgroupRoot = path.join(root, 'cgroup')
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })
  function files (tree) {
    for (const [rel, content] of Object.entries(tree)) {
      const file = path.join(root, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  }
  const read = () => readCgroupMemory({ procDir, cgroupRoot })
  const v2Stat = (inactiveFile) => `anon 100\nfile 5000\nactive_file 900\ninactive_file ${inactiveFile}\nshmem 300\n`

  describe('cgroup v2', () => {
    it('a container (private cgroup namespace): usage minus the inactive file cache, against memory.max', () => {
      files({
        'proc/self/cgroup': '0::/\n',
        'cgroup/memory.current': `${3 * GiB}\n`,
        'cgroup/memory.max': `${4 * GiB}\n`,
        'cgroup/memory.stat': v2Stat(GiB)
      })
      assert.deepEqual(read(), { version: 2, used: 2 * GiB, limit: 4 * GiB })
    })

    it('"max" means no limit', () => {
      files({ 'proc/self/cgroup': '0::/\n', 'cgroup/memory.current': '1000\n', 'cgroup/memory.max': 'max\n', 'cgroup/memory.stat': v2Stat(0) })
      assert.deepEqual(read(), { version: 2, used: 1000, limit: null })
    })

    it('a host cgroup namespace: the cgroup under the mount at its path', () => {
      files({
        'proc/self/cgroup': '0::/system.slice/docker-abc.scope\n',
        'cgroup/memory.current': '999\n', // the host root, not ours
        'cgroup/system.slice/docker-abc.scope/memory.current': `${2 * GiB}\n`,
        'cgroup/system.slice/docker-abc.scope/memory.max': `${3 * GiB}\n`,
        'cgroup/system.slice/docker-abc.scope/memory.stat': v2Stat(512 * MB)
      })
      assert.deepEqual(read(), { version: 2, used: 1536 * MB, limit: 3 * GiB })
    })

    it('falls back to the mount itself when the path is not under it', () => {
      files({ 'proc/self/cgroup': '0::/kubepods/pod1/c1\n', 'cgroup/memory.current': '5000\n', 'cgroup/memory.max': '8000\n' })
      assert.deepEqual(read(), { version: 2, used: 5000, limit: 8000 }, 'no memory.stat: nothing subtracted')
    })

    it('never reports a negative working set', () => {
      files({ 'proc/self/cgroup': '0::/\n', 'cgroup/memory.current': '100\n', 'cgroup/memory.max': 'max\n', 'cgroup/memory.stat': v2Stat(500) })
      assert.equal(read().used, 0)
    })

    it('ignores a malformed limit', () => {
      files({ 'proc/self/cgroup': '0::/\n', 'cgroup/memory.current': '100\n', 'cgroup/memory.max': 'garbage\n' })
      assert.deepEqual(read(), { version: 2, used: 100, limit: null })
    })
  })

  describe('cgroup v1', () => {
    it('usage minus total_inactive_file, against memory.limit_in_bytes', () => {
      files({
        'proc/self/cgroup': '12:pids:/docker/abc\n11:cpu,cpuacct:/docker/abc\n4:memory:/docker/abc\n',
        'cgroup/memory/docker/abc/memory.usage_in_bytes': `${3 * GiB}\n`,
        'cgroup/memory/docker/abc/memory.limit_in_bytes': `${4 * GiB}\n`,
        'cgroup/memory/docker/abc/memory.stat': `cache 100\ninactive_file 1\ntotal_inactive_file ${GiB}\n`
      })
      assert.deepEqual(read(), { version: 1, used: 2 * GiB, limit: 4 * GiB })
    })

    it('a co-mounted controller, the container cgroup mounted at the root, no limit', () => {
      files({
        'proc/self/cgroup': '5:memory,hugetlb:/kubepods/burstable/pod1/c1\n',
        'cgroup/memory/memory.usage_in_bytes': '7000\n',
        'cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
        'cgroup/memory/memory.stat': 'inactive_file 2000\n'
      })
      assert.deepEqual(read(), { version: 1, used: 5000, limit: null })
    })

    it('a hybrid host: the v2 hierarchy has no memory controller, v1 has', () => {
      files({
        'proc/self/cgroup': '0::/user.slice\n4:memory:/user.slice\n',
        'cgroup/memory/user.slice/memory.usage_in_bytes': '4000\n',
        'cgroup/memory/user.slice/memory.limit_in_bytes': '6000\n'
      })
      assert.deepEqual(read(), { version: 1, used: 4000, limit: 6000 })
    })
  })

  it('returns null outside a readable cgroup', () => {
    assert.equal(read(), null, 'no /proc/self/cgroup')
    files({ 'proc/self/cgroup': '0::/\n' })
    assert.equal(read(), null, 'no memory files')
    files({ 'cgroup/memory.current': 'garbage\n' })
    assert.equal(read(), null, 'malformed usage')
  })

  if (process.platform === 'linux') {
    it('reads the cgroup of this container', () => {
      const cgroup = readCgroupMemory()
      assert.ok(cgroup && cgroup.used > 0, JSON.stringify(cgroup))
    })
  }
})

describe('memoryBudget', () => {
  const tree = { rss: 900 * MB, pss: 600 * MB, processes: 8 }
  const unread = () => { throw new Error('the process tree must not be read') }

  describe('under a cgroup memory limit', () => {
    const cgroup = { version: 2, used: 3 * GiB, limit: 4 * GiB }

    it('defaults to 85% of the limit, against the container working set', () => {
      assert.equal(DEFAULT_LIMIT_SHARE, 0.85)
      assert.deepEqual(memoryBudget(null, { cgroup, readTree: unread, nodeRss: 100 * MB }),
        { used: 3 * GiB, source: 'cgroup', limit: 4 * GiB, ceiling: Math.round(4 * GiB * 0.85) })
    })

    it('an explicit BOTSERVICE_MAX_RSS_MB is MB of the container working set', () => {
      assert.deepEqual(memoryBudget(2048, { cgroup, readTree: unread, nodeRss: 100 * MB }),
        { used: 3 * GiB, source: 'cgroup', limit: 4 * GiB, ceiling: 2 * GiB })
    })

    it('0 disables the ceiling, the working set is still reported', () => {
      assert.deepEqual(memoryBudget(0, { cgroup, readTree: unread, nodeRss: 100 * MB }),
        { used: 3 * GiB, source: 'cgroup', limit: 4 * GiB, ceiling: null })
    })
  })

  describe('without a memory limit', () => {
    for (const cgroup of [null, { version: 2, used: 3 * GiB, limit: null }]) {
      const where = cgroup ? 'in a cgroup without limit' : 'outside a cgroup'
      it(`${where}: an explicit BOTSERVICE_MAX_RSS_MB is MB of the process tree's PSS`, () => {
        assert.deepEqual(memoryBudget(1500, { cgroup, readTree: () => tree, nodeRss: 100 * MB }),
          { used: 600 * MB, source: 'pss', limit: null, ceiling: 1500 * MB })
      })

      it(`${where}: the Node rss stands in when /proc cannot be read`, () => {
        assert.deepEqual(memoryBudget(1500, { cgroup, readTree: () => null, nodeRss: 100 * MB }),
          { used: 100 * MB, source: 'rss', limit: null, ceiling: 1500 * MB })
      })

      it(`${where}: unset keeps the former ${LEGACY_CEILING_MB} MB against the Node rss`, () => {
        assert.deepEqual(memoryBudget(null, { cgroup, readTree: unread, nodeRss: 100 * MB }),
          { used: 100 * MB, source: 'rss', limit: null, ceiling: 2048 * MB })
      })

      it(`${where}: 0 disables the ceiling`, () => {
        assert.deepEqual(memoryBudget(0, { cgroup, readTree: unread, nodeRss: 100 * MB }),
          { used: 100 * MB, source: 'rss', limit: null, ceiling: null })
      })
    }
  })
})
