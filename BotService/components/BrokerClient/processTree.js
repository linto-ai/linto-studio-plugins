const fs = require('fs')

/**
 * Resident memory of a process and all its descendants, read from Linux /proc.
 * The BotService's Chromium (browser, GPU and utility processes, one renderer per
 * meeting page) runs in child processes, which the Node process' own RSS leaves
 * out. Pages shared between processes (libraries, shared memory) count once per
 * process that maps them, so the sum errs on the high side: the safe side for a
 * memory ceiling.
 *
 * @param {number} [rootPid] root of the tree (default: this process)
 * @param {string} [procDir] procfs mount point (overridable for tests)
 * @returns {{rss:number, processes:number}|null} RSS in bytes and process count,
 *   or null where /proc cannot be read (not Linux, restricted sandbox)
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

  let kb = 0
  const seen = new Set() // a pid reused during the scan must not loop
  const pending = [rootPid]
  while (pending.length > 0) {
    const pid = pending.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    kb += rssKb.get(pid) || 0
    for (const child of children.get(pid) || []) pending.push(child)
  }
  return { rss: kb * 1024, processes: seen.size }
}

module.exports = { processTreeMemory }
