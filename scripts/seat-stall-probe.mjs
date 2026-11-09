#!/usr/bin/env node
/**
 * Seat-stall probe harness (issue #467).
 *
 * Drives a real `claude -p` developer seat through the adapter's own
 * dispatchSeat, exactly as the tm-kickoff SKILL.md one-liner does, with a
 * /proc watcher logging pid/ppid, fd/0 target, wchan, and timestamps for
 * every claude/gh/node process in the seat's tree. The probe task is the
 * stall shape from the four recorded occurrences, compressed: branch off
 * origin/main in a scratch worktree under /tmp, empty commit, push, then
 * `gh pr create --dry-run` (dry-run only; a real PR is not authorized on
 * this repo). stdin state at gh-write time is observable even without a
 * stall, so every run yields evidence.
 *
 * Two arms, run one at a time (box constraint: one seat at a time):
 *
 *   - pre:  run before the adapter fix lands (execFileAsync, open stdin pipe)
 *   - post: run after the adapter fix lands (stdin closed)
 *
 * Both arms drive the adapter's real code; the arm argument only labels
 * the run and gives the scratch instance its own branch. The fix itself is
 * a module-side change, so the post arm needs no patching here: run it
 * from a checkout that already carries the fix.
 *
 * Usage:
 *   node scripts/seat-stall-probe.mjs <pre|post> [timeoutMinutes]
 *
 * Environment (same as a tm-kickoff seat dispatch):
 *   CLAUDE_CODE_ADAPTER_TABLE, TM_SEAT_ROLE (default developer),
 *   TM_SEAT_TASK (probe task when unset), CLAUDE_CODE_NORIS_SETTINGS,
 *   plus whatever the seat binding needs (model, effort come from the
 *   adapter table's role binding).
 *
 * Logs go to /tmp/seat-stall-probe-<arm>-<timestamp>.log and are never
 * committed to the repo.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dir, '..')

// Where the probe's scratch worktrees live: under /tmp, never inside the
// repo's .worktrees (the pipeline owns those).
const SCRATCH_ROOT = process.env.SEAT_STALL_SCRATCH_ROOT || '/tmp/seat-stall-probe'

const arm = process.argv[2]
if (arm !== 'pre' && arm !== 'post') {
  console.error('usage: node scripts/seat-stall-probe.mjs <pre|post> [timeoutMinutes]')
  process.exit(2)
}
const timeoutMinutes = Number(process.argv[3] || 6)
const timeoutMs = timeoutMinutes * 60 * 1000

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logPath = `/tmp/seat-stall-probe-${arm}-${stamp}.log`

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`
  appendFileSync(logPath, entry + '\n')
  console.log(entry)
}

log(`arm=${arm} timeoutMs=${timeoutMs} log=${logPath}`)

// ---------------------------------------------------------------------------
// 1. Scratch worktree for the seat: branch off origin/main, empty commit,
//    push. The seat then gh-creates a draft PR against it (dry-run).
// ---------------------------------------------------------------------------
const slug = `probe-${arm}-${randomBytes(3).toString('hex')}`
const branch = `probe/${slug}`
const worktree = join(SCRATCH_ROOT, slug)

log(`creating scratch worktree ${worktree} on branch ${branch}`)
mkdirSync(SCRATCH_ROOT, { recursive: true })
execFileSync('git', ['-C', repoRoot, 'fetch', 'origin'], { stdio: 'inherit' })
execFileSync('git', ['worktree', 'add', '--detach', worktree, 'origin/main'], { stdio: 'inherit' })
execFileSync('git', ['-C', worktree, 'checkout', '-b', branch], { stdio: 'inherit' })
execFileSync('git', ['-C', worktree, 'commit', '--allow-empty', '-m', `chore: seat-stall probe baseline ${slug}`], { stdio: 'inherit' })
execFileSync('git', ['-C', worktree, 'push', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'inherit' })
log(`scratch worktree ready: branch=${branch}`)

// ---------------------------------------------------------------------------
// 2. The probe task: exactly the recorded stall shape, compressed. The
//    seat must do its file work (an empty commit), push, then make a
//    GitHub-write call (`gh pr create --dry-run`). DRY-RUN ONLY: opening a
//    real PR on this repo is not authorized (lead decision on the issue's
//    sub-plan).
// ---------------------------------------------------------------------------
const probeTask = `Probe task for issue #467 (seat-stall diagnosis). Work in your
working directory; it is a scratch clone on branch ${branch}.

1. Create an empty commit on the current branch: git commit --allow-empty -m "chore: probe commit from seat"
2. Push it: git push origin HEAD
3. Then create a DRAFT pull request WITHOUT opening a real PR. Use exactly this
   command (it validates without creating anything):
   gh pr create --draft --title "chore: seat-stall probe" --body "probe" --dry-run
   The --dry-run flag is mandatory. Never run gh pr create without --dry-run.

When done, print exactly this report and nothing else:
STATUS: DONE
BRANCH: ${branch}
PR: dry-run
CHECKS: probe`

process.env.TM_SEAT_TASK = process.env.TM_SEAT_TASK || probeTask
process.env.TM_SEAT_ROLE = process.env.TM_SEAT_ROLE || 'developer'
process.env.TM_SEAT_CWD = worktree

log(`probe task ready (${probeTask.length} chars); dispatching seat in ${worktree}`)

// ---------------------------------------------------------------------------
// 3. /proc watcher: every few seconds, walk the seat's process tree and
//    record pid/ppid, fd/0 target, wchan for every process.
// ---------------------------------------------------------------------------
function fd0Target(pid) {
  try {
    // readlinkSync resolves the fd symlink to its target: a pipe fd as
    // "pipe:[12345]" (the pipe inode), a character device as "/dev/null",
    // a tty as "/dev/pts/N".
    return readlinkSync(`/proc/${pid}/fd/0`)
  } catch {
    return null
  }
}

function wchan(pid) {
  try {
    return readFileSync(`/proc/${pid}/wchan`, 'utf8').trim()
  } catch {
    return null
  }
}

function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 160)
  } catch {
    return null
  }
}

function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.split(') ')[1]?.split(' ')[0] || null
  } catch {
    return null
  }
}

// Enumerate all pids once per poll, record interesting ones (the seat's
// tree and any gh/git process), and keep a ppid map so the tree is
// derivable from the log.
import { readdirSync } from 'node:fs'

function pollProcs() {
  let pids
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    return
  }
  const seen = []
  for (const pid of pids) {
    let ppid, cmd
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const after = stat.split(') ')[1]
      ppid = after.split(' ')[1]
    } catch {
      continue
    }
    cmd = procCmdline(pid)
    if (!cmd) continue
    // Interesting: the seat tree (claude, gh, git) and the watcher's own
    // node processes inside the worktree. Everything else is noise.
    if (!/\b(claude|gh|git|node)\b/.test(cmd.split(' ')[0]?.split('/').pop() || '')) continue
    seen.push({
      pid,
      ppid,
      state: procState(pid),
      fd0: fd0Target(pid),
      wchan: wchan(pid),
      cmd,
    })
  }
  for (const p of seen) {
    log(`proc pid=${p.pid} ppid=${p.ppid} state=${p.state} fd0=${p.fd0} wchan=${p.wchan} cmd=${p.cmd}`)
  }
  return seen
}

// ---------------------------------------------------------------------------
// 4. The seat dispatch: the adapter's own dispatchSeat, run in a child node
//    process (same shape as the SKILL.md one-liner) so the pre arm's
//    execFileAsync spawn is exactly what production runs. The arm argument
//    only labels the run and gives the scratch instance its own branch; the
//    fix itself is a module-side change, so the post arm needs no patching
//    here (lines 20-23).
// ---------------------------------------------------------------------------
const dispatchWrapper = `
// Same import and call shape as the tm-kickoff SKILL.md one-liner.
const p = (process.env.CLAUDE_PLUGIN_ROOT || ${(JSON.stringify(join(repoRoot, '.claude')))}) + "/adapters/claude-code-subprocess.mjs";
import { pathToFileURL } from "node:url";
const { dispatchSeat } = await import(pathToFileURL(p).href);
const e = process.env;
const opts = { cwd: e.TM_SEAT_CWD };
for (const k of ["tier", "model", "effort", "settings"]) { const v = e["TM_SEAT_" + k.toUpperCase()]; if (v) opts[k] = v; }
if (e.TM_SEAT_TIMEOUT_MS) opts.timeoutMs = Number(e.TM_SEAT_TIMEOUT_MS);
console.log(JSON.stringify(await dispatchSeat(e.TM_SEAT_ROLE, e.TM_SEAT_TASK, opts)));
`

const wrapperFile = join(SCRATCH_ROOT, `dispatch-${slug}.mjs`)
appendFileSync(wrapperFile, dispatchWrapper)
process.env.TM_SEAT_TIMEOUT_MS = String(timeoutMs)
process.env.CLAUDE_PLUGIN_ROOT = join(repoRoot, '.claude')

const seat = spawn('node', ['--input-type=module', wrapperFile], {
  cwd: repoRoot,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
log(`seat dispatch spawned: pid=${seat.pid} wrapper=${wrapperFile}`)

let seatOut = ''
let seatErr = ''
seat.stdout.on('data', (d) => { seatOut += d })
seat.stderr.on('data', (d) => { seatErr += d })

let stdoutTail = ''
seat.stdout.on('data', (d) => {
  stdoutTail = (stdoutTail + d).slice(-2000)
})

// The watcher polls the /proc tree while the seat runs.
const watcher = setInterval(() => {
  try {
    pollProcs()
  } catch (e) {
    log(`watcher error: ${e.message}`)
  }
}, 3000)

// The harness's own timeout: hard-kill the seat tree if it outlives the
// narrowed budget. A real stall costs minutes, not 30.
const hardKill = setTimeout(() => {
  log(`HARD KILL: seat exceeded ${timeoutMs}ms; killing pid=${seat.pid} and descendants`)
  killTree(seat.pid)
}, timeoutMs + 30000)

function killTree(pid) {
  // SIGTERM the pid and every descendant, then SIGKILL after a grace
  // period. Uses /proc ppid mapping, no ps dependency.
  const pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  const childrenOf = new Map()
  for (const p of pids) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8')
      const ppid = stat.split(') ')[1].split(' ')[1]
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, [])
      childrenOf.get(ppid).push(p)
    } catch {}
  }
  const toKill = [pid]
  const stack = [pid]
  while (stack.length) {
    const cur = stack.pop()
    for (const c of childrenOf.get(cur) || []) {
      toKill.push(c)
      stack.push(c)
    }
  }
  for (const p of toKill) {
    try { process.kill(Number(p), 'SIGTERM') } catch {}
  }
  setTimeout(() => {
    for (const p of toKill) {
      try { process.kill(Number(p), 'SIGKILL') } catch {}
    }
  }, 2000)
}

const exitInfo = await new Promise((resolve) => {
  seat.on('close', (code, signal) => resolve({ code, signal }))
})

clearInterval(watcher)
clearTimeout(hardKill)
log(`seat dispatch exited: code=${exitInfo.code} signal=${exitInfo.signal}`)
if (seatErr.trim()) {
  log(`seat stderr (last 3000 chars):\n${seatErr.trim().slice(-3000)}`)
}
log(`seat stdout (last 3000 chars):\n${stdoutTail.trim().slice(-3000)}`)

// A final /proc sweep after the seat is gone, for the record.
pollProcs()

// ---------------------------------------------------------------------------
// 5. Verdict: did the seat finish inside the budget, and what did the
//    watcher capture at gh-write time?
// ---------------------------------------------------------------------------
const finished = exitInfo.code === 0
const stalled = !finished && exitInfo.signal === 'SIGKILL'
log(`VERDICT arm=${arm} finished=${finished} stalled=${stalled} code=${exitInfo.code} signal=${exitInfo.signal}`)
log(`log file: ${logPath}`)

// Clean up the scratch worktree and its remote branch: the probe's remote
// branch is disposable evidence, not a deliverable.
try {
  execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree])
  log(`scratch worktree removed: ${worktree}`)
} catch (e) {
  log(`scratch worktree removal failed: ${e.message}`)
}
try {
  execFileSync('git', ['push', 'origin', '--delete', branch])
  log(`remote probe branch deleted: ${branch}`)
} catch (e) {
  log(`remote branch delete failed: ${e.message}`)
}
try { rmSync(wrapperFile, { force: true }) } catch {}

console.log(`\nprobe ${arm} complete: ${finished ? 'FINISHED' : stalled ? 'STALLED' : 'FAILED'}`)
console.log(`log: ${logPath}`)
process.exit(finished ? 0 : 1)
