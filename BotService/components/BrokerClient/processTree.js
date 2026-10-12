const fs = require('fs')

/**
 * Memory of a process and all its descendants, read from Linux /proc. The
 * BotService's Chromium (browser, GPU and utility processes, one renderer per
 * meeting page) runs in child processes, which the Node process' own RSS leaves
 * out. RSS counts the pages shared between processes (libraries, shared memory)
 * once per process that maps them, which overstates Chromium a lot; PSS
 * (smaps_rollup) splits them between the sharers, so its sum is what the tree
 * actually uses. A process whose smaps_rollup cannot be read counts its RSS.
 *
 * @param {number} [rootPid] root of the tree (default: this process)
 * @param {string} [procDir] procfs mount point (overridable for tests)
 * @returns {{rss:number, pss:number, processes:number}|null} bytes and process
 *   count, or null where /proc cannot be read (not Linux, restricted sandbox)
 */
function processTreeMemory (rootPid = process.pid, procDir = '/proc') {
  let entries
  try {
    entries = fs.readdirSync(procDir)
  } catch (e) {
    return null
  }
  const children = new Map() // ppid -> [pid]
  const rssKb = new Map() // pid -> VmRSS in kB
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let status
    try {
      status = fs.readFileSync(`${procDir}/${entry}/status`, 'utf8')
    } catch (e) {
      continue // exited since the listing
    }
    const pid = Number(entry)
    const ppid = /^PPid:\s*(\d+)/m.exec(status)
    const rss = /^VmRSS:\s*(\d+) kB/m.exec(status) // none for kernel threads and zombies
    rssKb.set(pid, rss ? Number(rss[1]) : 0)
    if (!ppid) continue
    const siblings = children.get(Number(ppid[1]))
    if (siblings) siblings.push(pid)
    else children.set(Number(ppid[1]), [pid])
  }
  if (!rssKb.has(rootPid)) return null

  let rss = 0
  let pss = 0
  const seen = new Set() // a pid reused during the scan must not loop
  const pending = [rootPid]
  while (pending.length > 0) {
    const pid = pending.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const kb = rssKb.get(pid) || 0
    rss += kb
    pss += pssKb(`${procDir}/${pid}/smaps_rollup`) ?? kb
    for (const child of children.get(pid) || []) pending.push(child)
  }
  return { rss: rss * 1024, pss: pss * 1024, processes: seen.size }
}

// Pss of a process in kB, from its smaps_rollup (Linux >= 4.14), or null.
function pssKb (file) {
  let rollup
  try {
    rollup = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return null
  }
  const pss = /^Pss:\s*(\d+) kB/m.exec(rollup)
  return pss ? Number(pss[1]) : null
}

module.exports = { processTreeMemory }
