const fs = require('fs')

const MB = 1024 * 1024

// Default ceiling, as a share of the memory limit, when BOTSERVICE_MAX_RSS_MB is
// unset. The ceiling only stops NEW bots: the running ones keep growing (meeting
// SPAs grow along a call), and the last bot accepted under the ceiling still has
// to fit its join peak (roughly half a gigabyte for a Teams renderer), so 15% is
// left: ~600 MB of the 4 GiB the Helm chart gives the BotService.
const DEFAULT_LIMIT_SHARE = 0.85
// Former default, against the Node process alone, kept where there is no memory
// limit to derive one from (no change for those deployments).
const LEGACY_CEILING_MB = 2048
// cgroup v1 reports "no limit" as the largest page-aligned 64-bit counter.
const V1_UNLIMITED = 2 ** 60

function read (file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    return null
  }
}

// A file holding a byte count, or null if unreadable or malformed.
function readBytes (file) {
  const raw = read(file)
  const value = raw === null || raw === '' ? NaN : Number(raw)
  return Number.isFinite(value) ? value : null
}

function statField (stat, key) {
  const m = stat && new RegExp(`^${key} (\\d+)$`, 'm').exec(stat)
  return m ? Number(m[1]) : null
}

// Directories where the cgroup at `path` may be: under the mount (host cgroup
// namespace), or the mount itself (a container's private namespace, or a v1
// container whose own cgroup is mounted there).
function cgroupDirs (mount, path) {
  return path && path !== '/' ? [mount + path, mount] : [mount]
}

/**
 * Memory of the cgroup this process runs in, as the OOM killer weighs it: the
 * usage minus the inactive file cache, which the kernel reclaims first (the
 * "working set" the kubelet also uses), and the cgroup's memory limit. cgroup v2,
 * with a v1 fallback. Only the process' own cgroup is read, not its ancestors.
 * @param {object} [paths] { procDir, cgroupRoot } (overridable for tests)
 * @returns {{version:number, used:number, limit:number|null}|null} bytes (limit
 *   null when there is none); null outside a readable cgroup
 */
function readCgroupMemory ({ procDir = '/proc', cgroupRoot = '/sys/fs/cgroup' } = {}) {
  const membership = read(`${procDir}/self/cgroup`)
  if (!membership) return null
  const lines = membership.split('\n')

  const v2 = lines.find((l) => l.startsWith('0::'))
  if (v2) {
    for (const dir of cgroupDirs(cgroupRoot, v2.slice(3))) {
      const current = readBytes(`${dir}/memory.current`)
      if (current === null) continue
      const inactiveFile = statField(read(`${dir}/memory.stat`), 'inactive_file') || 0
      const limit = readBytes(`${dir}/memory.max`) // null for "max"
      return { version: 2, used: Math.max(0, current - inactiveFile), limit: limit > 0 ? limit : null }
    }
  }

  // v1: "<id>:<controllers>:<path>", the memory controller possibly co-mounted.
  const v1 = lines.map((l) => l.split(':')).find((f) => f.length >= 3 && f[1].split(',').includes('memory'))
  if (v1) {
    for (const dir of cgroupDirs(`${cgroupRoot}/memory`, v1.slice(2).join(':'))) {
      const usage = readBytes(`${dir}/memory.usage_in_bytes`)
      if (usage === null) continue
      const stat = read(`${dir}/memory.stat`)
      const inactiveFile = statField(stat, 'total_inactive_file') ?? statField(stat, 'inactive_file') ?? 0
      const limit = readBytes(`${dir}/memory.limit_in_bytes`)
      return { version: 1, used: Math.max(0, usage - inactiveFile), limit: limit > 0 && limit < V1_UNLIMITED ? limit : null }
    }
  }
  return null
}

/**
 * What the memory ceiling compares, and the ceiling itself.
 * - Under a cgroup memory limit: the cgroup's working set, against
 *   BOTSERVICE_MAX_RSS_MB when set, else DEFAULT_LIMIT_SHARE of the limit.
 * - Without a limit and BOTSERVICE_MAX_RSS_MB set: the PSS of the process tree
 *   (Node and its Chromium processes, shared pages split between them), or the
 *   Node RSS where /proc cannot be read.
 * - Without a limit nor BOTSERVICE_MAX_RSS_MB: the former behaviour, the Node
 *   process' RSS against LEGACY_CEILING_MB.
 * @param {number|null} maxMb BOTSERVICE_MAX_RSS_MB: null when unset, 0 disables
 * @param {object} readings { cgroup: readCgroupMemory() result, readTree: () =>
 *   processTreeMemory() result (only called when needed), nodeRss: bytes }
 * @returns {{used:number, source:'cgroup'|'pss'|'rss', limit:number|null, ceiling:number|null}}
 *   bytes; ceiling null when disabled
 */
function memoryBudget (maxMb, { cgroup, readTree, nodeRss }) {
  const explicit = maxMb === null ? null : (maxMb > 0 ? maxMb * MB : 0)
  if (cgroup && cgroup.limit) {
    const ceiling = explicit === null ? Math.round(cgroup.limit * DEFAULT_LIMIT_SHARE) : explicit
    return { used: cgroup.used, source: 'cgroup', limit: cgroup.limit, ceiling: ceiling || null }
  }
  if (explicit) {
    const tree = readTree()
    return tree
      ? { used: tree.pss, source: 'pss', limit: null, ceiling: explicit }
      : { used: nodeRss, source: 'rss', limit: null, ceiling: explicit }
  }
  return { used: nodeRss, source: 'rss', limit: null, ceiling: explicit === 0 ? null : LEGACY_CEILING_MB * MB }
}

module.exports = { readCgroupMemory, memoryBudget, DEFAULT_LIMIT_SHARE, LEGACY_CEILING_MB }
