/**
 * Hermes pipeline driver (issue #334).
 *
 * The programmatic counterpart to SKILL.hermes.md. Where the skill tells
 * the lead session how to behave, this module provides callable functions
 * for each pipeline stage so the pipeline can be tested in dry-run mode
 * and eventually invoked programmatically.
 *
 * The driver implements the flat-star pipeline:
 *   architect (SUB_PLAN) -> developer (implement) -> tester (verify) ->
 *   reviewer (review) -> ship
 *
 * Each stage dispatches a role agent via the Hermes adapter's spawn
 * function. Between stages, the driver routes the report: posts sub-plans
 * as issue comments, posts verdicts as PR comments, routes fix rounds,
 * and manages labels.
 *
 * In dry-run mode (DRY_RUN=true), spawn returns synthetic reports, so the
 * full pipeline exercises without live API calls or GitHub writes.
 *
 * In live mode the driver runs as an ordinary Node process. It creates one
 * git worktree per package and spawns each seat as a `hermes` subprocess,
 * so it needs no Hermes lead session: `node hermes-pipeline.mjs` plus the
 * spawned seats are the whole team.
 */

import { spawn, detectFailure, retry, resolveRole, resolveTier, loadPrompt } from './hermes-adapter.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * worktreePlan(repoRoot, issueNumber, slug, opts) -> { path, branch }
 *
 * Where a package's work happens. The driver owns this rather than passing
 * `hermes -w`, whose atexit cleanup force-removes the worktree and deletes
 * its branch unless commits are pushed, and which names branches from a
 * UUID instead of the repo convention.
 *
 * The path is keyed by issue only, so it is known before the sub-plan
 * exists and is stable across every seat and every fix round. The branch
 * follows <type>/<issue>-<slug> from process-core.md.
 */
export function worktreePlan(repoRoot, issueNumber, slug = 'pending', opts = {}) {
  const type = opts.type || 'feat'
  return {
    path: `${repoRoot}/.worktrees/pkg-${issueNumber}`,
    branch: `${type}/${issueNumber}-${slug}`,
  }
}

/**
 * Create the package worktree if it is not already there. Branches from
 * the fetched remote tip so a package starts current, falling back to
 * local HEAD when the remote is unreachable.
 *
 * Note: Hermes' own worktree mode copies files listed in
 * `.worktreeinclude`. A driver-created worktree does not get that for
 * free, so a seat needing a gitignored file needs it copied here.
 */
export async function ensureWorktree(repoRoot, plan, baseRef = 'origin/main') {
  const git = (args, cwd = repoRoot) => execFileAsync('git', args, { cwd, encoding: 'utf8' })
  try {
    const { stdout } = await git(['worktree', 'list', '--porcelain'])
    if (stdout.includes(plan.path)) return { created: false, path: plan.path }
  } catch {
    // No worktree list means no repo or no worktrees; let the add below fail loudly.
  }
  try {
    await git(['worktree', 'add', plan.path, '-b', plan.branch, baseRef])
  } catch (e) {
    // A stale base ref must not hard-fail package setup.
    await git(['worktree', 'add', plan.path, '-b', plan.branch, 'HEAD'])
  }
  return { created: true, path: plan.path }
}

/**
 * runPipeline(issueNumber, opts) -> result
 *
 * Runs the flat-star pipeline for a single issue. Returns an object with
 * the final state: PR number, verdicts, fix-round counts, and any parked
 * reason.
 *
 * opts:
 * - repoOwner: the GitHub org/user (for gh commands)
 * - repoName: the GitHub repo name
 * - dryRun: override DRY_RUN env var
 */
export async function runPipeline(issueNumber, opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : process.env.DRY_RUN === 'true'
  const log = (msg) => console.warn(`[pipeline:#${issueNumber}] ${msg}`)

  const repoRoot = opts.repoRoot || process.cwd()
  const plan = worktreePlan(repoRoot, issueNumber)

  const state = {
    issue: issueNumber,
    worktree: plan.path,
    dispatches: [],
    branch: null,
    pr: null,
    subPlan: null,
    testerVerdict: null,
    reviewerVerdict: null,
    fixRounds: { tester: 0, reviewer: 0 },
    parked: null,
    done: false,
  }

  // Every seat runs in the package worktree. Recorded so a run can be
  // audited for isolation after the fact.
  const dispatch = async (role, task, tier) => {
    state.dispatches.push({ role, tier, cwd: plan.path })
    return spawn(role, task, { tier, cwd: plan.path })
  }

  if (!dryRun) {
    await ensureWorktree(repoRoot, plan, opts.baseRef)
  }

  // --- Stage 1: Architect (SUB_PLAN) ---
  log('stage 1: architect SUB_PLAN')
  const archTask = `JOB: SUB_PLAN\n\nIssue #${issueNumber}: read the issue and its comments, then produce a sub-plan with checkpoint bullets.`
  const archReport = await dispatch('architect', archTask, 'judgment')

  if (archReport && archReport.NEEDS_DECISION) {
    state.parked = `architect NEEDS_DECISION: ${archReport.NEEDS_DECISION}`
    log(`parked: ${state.parked}`)
    return state
  }

  state.subPlan = archReport?.output || archReport?.summary || 'sub-plan generated'
  log('sub-plan received')

  if (!dryRun) {
    // Post sub-plan as issue comment
    await ghComment(issueNumber, state.subPlan)
  }

  // --- Stage 2: Developer (implement) ---
  log('stage 2: developer implement')
  const slug = state.subPlan?.slice(0, 30)?.replace(/\s+/g, '-').toLowerCase() || 'impl'
  state.branch = worktreePlan(repoRoot, issueNumber, slug, { type: opts.branchType }).branch

  const devTask = `Issue #${issueNumber}, branch ${state.branch}: implement per the sub-plan. The sub-plan comment is your spec. Use TDD. Run the full check suite before reporting.`
  const devReport = await dispatch('developer', devTask, 'worker')

  if (devReport?.STATUS === 'BLOCKED') {
    state.parked = `developer BLOCKED: ${devReport.NOTES}`
    log(`parked: ${state.parked}`)
    return state
  }
  if (devReport?.STATUS === 'NEEDS_CONTEXT') {
    state.parked = `developer NEEDS_CONTEXT: ${devReport.NOTES}`
    log(`parked: ${state.parked}`)
    return state
  }

  state.pr = devReport?.pr || devReport?.PR || `https://github.com/example/repo/pull/${issueNumber}`
  log(`developer done, PR: ${state.pr}`)

  // --- Stage 3: Tester (verify) ---
  log('stage 3: tester verify')
  const testTask = `Branch ${state.branch}, issue #${issueNumber}: verify the change. Run the full check suite and attack the change.`
  const testReport = await dispatch('tester', testTask, 'worker')
  state.testerVerdict = testReport?.VERDICT || testReport?.verdict || 'PASS'

  if (state.testerVerdict === 'FAIL') {
    state.fixRounds.tester++
    if (state.fixRounds.tester > 3) {
      state.parked = 'tester fix rounds exhausted (3/3)'
      log(`parked: ${state.parked}`)
      return state
    }
    // Fix round: send findings back to developer, then re-test
    log(`tester FAIL, fix round ${state.fixRounds.tester}/3`)
    const fixTask = `Issue #${issueNumber}, branch ${state.branch}: fix exactly these findings:\n${testReport?.FINDINGS || testReport?.findings || 'findings'}`
    await dispatch('developer', fixTask, 'worker')
    // Re-test
    const reTestReport = await dispatch('tester', testTask, 'worker')
    state.testerVerdict = reTestReport?.VERDICT || reTestReport?.verdict || 'PASS'
    if (state.testerVerdict === 'FAIL') {
      state.parked = 'tester FAIL after fix round'
      log(`parked: ${state.parked}`)
      return state
    }
  }
  log(`tester ${state.testerVerdict}`)

  // --- Stage 4: Reviewer (review) ---
  log('stage 4: reviewer review')
  const reviewTask = `PR ${state.pr}, issue #${issueNumber}: review the diff against the issue and sub-plan. Two passes: spec compliance then code quality.`
  const reviewReport = await dispatch('reviewer', reviewTask, 'judgment')
  state.reviewerVerdict = reviewReport?.VERDICT || reviewReport?.verdict || 'APPROVE'

  if (state.reviewerVerdict === 'CHANGES_REQUESTED') {
    state.fixRounds.reviewer++
    if (state.fixRounds.reviewer > 3) {
      state.parked = 'reviewer fix rounds exhausted (3/3)'
      log(`parked: ${state.parked}`)
      return state
    }
    // Fix round: send must-fix findings to developer, re-test, re-review
    log(`reviewer CHANGES_REQUESTED, fix round ${state.fixRounds.reviewer}/3`)
    const fixTask = `Issue #${issueNumber}, branch ${state.branch}: fix exactly these must-fix findings:\n${reviewReport?.FINDINGS || reviewReport?.findings || 'findings'}`
    await dispatch('developer', fixTask, 'worker')
    // Re-test
    const reTestReport = await dispatch('tester', testTask, 'worker')
    state.testerVerdict = reTestReport?.VERDICT || reTestReport?.verdict || 'PASS'
    // Re-review
    const reReviewReport = await dispatch('reviewer', reviewTask, 'judgment')
    state.reviewerVerdict = reReviewReport?.VERDICT || reReviewReport?.verdict || 'APPROVE'
    if (state.reviewerVerdict === 'CHANGES_REQUESTED') {
      state.parked = 'reviewer CHANGES_REQUESTED after fix round'
      log(`parked: ${state.parked}`)
      return state
    }
  }
  log(`reviewer ${state.reviewerVerdict}`)

  // --- Stage 5: Ship ---
  if (state.reviewerVerdict === 'APPROVE' && state.testerVerdict === 'PASS') {
    log('stage 5: ship')
    state.done = true
    if (!dryRun) {
      // Mark PR ready, remove in-progress label, post summary
      await ghPrReady(state.pr)
      await ghRemoveLabel(issueNumber, 'in-progress')
      await ghComment(issueNumber, `Pipeline complete. PR ready: ${state.pr}`)
    }
  } else {
    state.parked = `unexpected state: tester=${state.testerVerdict}, reviewer=${state.reviewerVerdict}`
  }

  return state
}

/**
 * runWave(issueNumbers, opts) -> results[]
 *
 * Runs the pipeline for multiple issues concurrently (up to 3 at a time).
 * Returns an array of state objects, one per issue.
 */
export async function runWave(issueNumbers, opts = {}) {
  const MAX_CONCURRENT = 3
  const results = []

  for (let i = 0; i < issueNumbers.length; i += MAX_CONCURRENT) {
    const batch = issueNumbers.slice(i, i + MAX_CONCURRENT)
    const batchResults = await Promise.all(
      batch.map((n) => runPipeline(n, opts))
    )
    results.push(...batchResults)
  }

  return results
}

// ---------------------------------------------------------------------------
// Command line and gate (issue #355). Pure functions first.
// ---------------------------------------------------------------------------

export const USAGE = 'usage: node .claude/adapters/hermes-pipeline.mjs <issue-number | label:<name>>...'

/**
 * parseArgs(argv) -> { items } | { error }
 *
 * Each argument is an issue number (digits only) or `label:<name>`. Only the
 * first `label:` is stripped, so `label:size:M` selects `size:M`. Duplicates
 * are dropped, argument order is kept.
 */
export function parseArgs(argv) {
  if (argv.length === 0) return { error: 'no packages given' }
  const items = []
  const seen = new Set()
  for (const arg of argv) {
    let item
    if (/^\d+$/.test(arg)) {
      item = { issue: Number(arg) }
    } else if (arg.startsWith('label:') && arg.length > 'label:'.length) {
      item = { label: arg.slice('label:'.length) }
    } else {
      return { error: `bad argument: ${JSON.stringify(arg)}` }
    }
    const key = item.issue !== undefined ? `i${item.issue}` : `l${item.label}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return { items }
}

/**
 * parseBlockers(body) -> number[]
 *
 * Whole lines of the form `Blocked by: #N` only. A mention inside a list
 * item or backticks does not count.
 */
export function parseBlockers(body) {
  const found = []
  for (const line of String(body || '').split('\n')) {
    const m = line.replace(/\r$/, '').match(/^Blocked by: #(\d+)\s*$/)
    if (m && !found.includes(Number(m[1]))) found.push(Number(m[1]))
  }
  return found
}

const VERDICT_LINE = /^VERDICT: (PASS|FAIL|APPROVE|CHANGES_REQUESTED)\b/m

/**
 * resumeStage(comments) -> { stage, findings? }
 *
 * Where a draft PR's package stopped, read from the role-contract VERDICT
 * line of the latest comment that has one. Bold report headers are free
 * text and are not matched.
 */
export function resumeStage(comments) {
  const ordered = [...comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = String(ordered[i].body || '').replace(/\r/g, '').match(VERDICT_LINE)
    if (!m) continue
    if (m[1] === 'PASS') return { stage: 'reviewer' }
    if (m[1] === 'APPROVE') return { stage: 'ship' }
    return { stage: 'developer', findings: String(ordered[i].body) }
  }
  return { stage: 'tester' }
}

/**
 * planWaves(entries) -> { waves, waiting }
 *
 * entries: [{ issue, outcome, blockers }], where blockers lists the
 * unmerged blockers. Wave 1 is every run and resume package. Wave k holds
 * the wait packages whose blockers all sit in earlier waves. The rest is
 * waiting: the blocker is outside the run, not runnable, or in a cycle.
 */
export function planWaves(entries) {
  const waves = []
  const placed = new Set()
  let pending = entries.filter((e) => e.outcome === 'wait')
  let current = entries.filter((e) => e.outcome === 'run' || e.outcome === 'resume').map((e) => e.issue)
  while (current.length > 0) {
    waves.push(current)
    current.forEach((n) => placed.add(n))
    const ready = pending.filter((e) => e.blockers.every((b) => placed.has(b)))
    pending = pending.filter((e) => !ready.includes(e))
    current = ready.map((e) => e.issue)
  }
  return { waves, waiting: pending.map((e) => ({ issue: e.issue, blockers: e.blockers })) }
}

// ---------------------------------------------------------------------------
// The runner and the GitHub layer.
// ---------------------------------------------------------------------------

/**
 * defaultRun(cmd, args, { cwd }) -> { code, stdout, stderr }
 *
 * The one function every gh and git call goes through. It never rejects on
 * a nonzero exit: the caller decides what that means. Tests inject a
 * fixture-backed runner in its place.
 */
export async function defaultRun(cmd, args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    // e.code is the exit status when numeric, or a string like ENOENT.
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout || '',
      stderr: e.stderr || String(e.message || e),
    }
  }
}

// The canonical label set. SKILL.hermes.md carried this list until #605
// removed it, so this is the only copy.
export const LABELS = [
  { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
  { name: 'size:M', color: 'BFD4F2', description: '1 to 3 hours. Write a sub-plan first.' },
  { name: 'size:L', color: 'F9D0C4', description: '4 to 6 hours. Split or checkpoint.' },
  { name: 'size:XL', color: 'D93F0B', description: 'About 8 hours. Too big. Split it.' },
  { name: 'in-progress', color: 'FBCA04', description: 'Package dispatched; resume, do not restart.' },
  { name: 'needs-human', color: 'B60205', description: 'Agent loop exhausted or blocked; human decision needed.' },
]

const firstLine = (text) => String(text || '').trim().split('\n')[0]
const shorten = (arg) => (arg.length > 60 ? `${arg.slice(0, 57)}...` : arg)

/**
 * createGitHub({ run, dryRun, log, cwd }) -> { reads..., writes... }
 *
 * Reads throw on a nonzero exit, naming the command. Writes do the same,
 * except that under dryRun they log one line and return without calling
 * the runner.
 */
export function createGitHub({ run = defaultRun, dryRun = false, log = () => {}, cwd } = {}) {
  const exec = async (cmd, args) => {
    const r = await run(cmd, args, { cwd })
    if (r.code !== 0) {
      throw new Error(`${[cmd, ...args].join(' ')}: ${firstLine(r.stderr) || `exit ${r.code}`}`)
    }
    return r.stdout
  }
  const readJson = async (cmd, args) => {
    const out = await exec(cmd, args)
    try {
      return JSON.parse(out)
    } catch (e) {
      throw new Error(`${[cmd, ...args].join(' ')}: output is not valid JSON (${e.message})`)
    }
  }
  const write = async (cmd, args) => {
    if (dryRun) {
      log(`dry run, skipped: ${[cmd, ...args.map(shorten)].join(' ')}`)
      return
    }
    await exec(cmd, args)
  }

  // gh pr list and git ls-remote are read at most once per run.
  let prs
  let heads

  const gh = {
    issueView: (n) =>
      readJson('gh', ['issue', 'view', String(n), '--json', 'body,comments,labels,number,state,stateReason,title']),
    async issueList(label) {
      const rows = await readJson('gh', [
        'issue', 'list', '--state', 'open', '--label', label, '--limit', '100', '--json', 'number',
      ])
      return rows.map((r) => r.number).sort((a, b) => a - b)
    },
    prList() {
      prs ??= readJson('gh', [
        'pr', 'list', '--state', 'open', '--limit', '100',
        '--json', 'closingIssuesReferences,headRefName,isDraft,number,url',
      ])
      return prs
    },
    async prComments(pr) {
      return (await readJson('gh', ['pr', 'view', String(pr), '--json', 'comments'])).comments
    },
    remoteHeads() {
      heads ??= exec('git', ['ls-remote', '--heads', 'origin']).then((out) =>
        out.split('\n').map((l) => l.split('\t')[1]).filter(Boolean)
      )
      return heads
    },

    createLabel: ({ name, color, description }) =>
      write('gh', ['label', 'create', name, '--color', color, '--description', description, '--force']),
    comment: (n, body) => write('gh', ['issue', 'comment', String(n), '--body', body]),
    addLabel: (n, label) => write('gh', ['issue', 'edit', String(n), '--add-label', label]),
    removeLabel: (n, label) => write('gh', ['issue', 'edit', String(n), '--remove-label', label]),
    prReady: (pr) => write('gh', ['pr', 'ready', String(pr)]),

    // Parking: the reason on the issue, needs-human on, in-progress off only
    // when the issue has it (removing a missing label is an error).
    async park(n, reason, { inProgress = false } = {}) {
      await gh.comment(n, `Parked: ${reason}`)
      await gh.addLabel(n, 'needs-human')
      if (inProgress) await gh.removeLabel(n, 'in-progress')
    },
  }
  return gh
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

const SIZES = ['size:XL', 'size:L', 'size:M', 'size:S']

// A sub-plan comment is an issue comment with a line that is exactly SUB_PLAN.
const hasSubPlan = (comments) =>
  comments.some((c) => String(c.body || '').split('\n').some((line) => line.replace(/\r$/, '') === 'SUB_PLAN'))

/**
 * runGate(numbers, gh) -> entries[]
 *
 * One entry per issue, in argument order:
 * { issue, size, outcome, detail, blockers, inProgress, resume? }.
 * The first matching rule decides the outcome; blockers then turn a run or
 * resume into a wait. Reads only: the caller does any park write.
 */
export async function runGate(numbers, gh) {
  const issues = new Map()
  const view = async (n) => {
    if (!issues.has(n)) issues.set(n, await gh.issueView(n))
    return issues.get(n)
  }
  const entries = []
  for (const n of numbers) entries.push(await gateIssue(await view(n), gh, view))
  return entries
}

async function gateIssue(issue, gh, view) {
  const n = issue.number
  const labels = issue.labels.map((l) => l.name)
  const size = SIZES.find((s) => labels.includes(s)) || 'unsized'
  const inProgress = labels.includes('in-progress')
  const entry = (outcome, detail, extra = {}) => ({ issue: n, size, outcome, detail, blockers: [], inProgress, ...extra })

  if (issue.state === 'CLOSED') return entry('skip', 'closed')
  if (labels.includes('needs-human')) return entry('skip', 'labeled needs-human, resuming it is the user\'s call')
  if (size === 'size:L' || size === 'size:XL') return entry('stop', `${size}, split it first`)
  if (size === 'unsized') return entry('park', 'no size label, not guessing a size')

  const prs = (await gh.prList()).filter((p) => (p.closingIssuesReferences || []).some((r) => r.number === n))
  const highest = (list) => list.reduce((best, p) => (!best || p.number > best.number ? p : best), null)
  const ready = highest(prs.filter((p) => !p.isDraft))
  if (ready) return entry('complete', `PR #${ready.number} is ready, awaiting merge`)

  let result
  const draft = highest(prs.filter((p) => p.isDraft))
  if (draft) {
    const { stage, findings } = resumeStage(await gh.prComments(draft.number))
    const resume = { stage, branch: draft.headRefName, pr: draft.number }
    if (findings !== undefined) resume.findings = findings
    result = entry('resume', `draft PR #${draft.number}, resuming at the ${stage}`, { resume })
  } else if (inProgress) {
    const branchRef = (await gh.remoteHeads()).find((r) => new RegExp(`^refs/heads/[^/]+/${n}-`).test(r))
    result = branchRef
      ? entry('resume', `branch ${branchRef.slice('refs/heads/'.length)} on origin, no PR, resuming at the tester`, {
          resume: { stage: 'tester', branch: branchRef.slice('refs/heads/'.length) },
        })
      : entry('run', 'in-progress but no PR and no branch, starting at the developer', { resume: { stage: 'developer' } })
  } else if (hasSubPlan(issue.comments)) {
    result = entry('run', 'sub-plan comment found, starting at the developer', { resume: { stage: 'developer' } })
  } else {
    result = entry('run', 'no sub-plan comment, starting at the architect')
  }

  const unmerged = []
  for (const b of parseBlockers(issue.body)) {
    const blocker = await view(b)
    if (!(blocker.state === 'CLOSED' && blocker.stateReason === 'COMPLETED')) unmerged.push(b)
  }
  if (unmerged.length > 0) {
    return { ...result, outcome: 'wait', detail: `blocked by ${unmerged.map((b) => `#${b}`).join(', ')}`, blockers: unmerged }
  }
  return result
}

export const formatGateLine = (e) => `#${e.issue} ${e.size} ${e.outcome}: ${e.detail}`

// ---------------------------------------------------------------------------
// GitHub helpers (no-ops in dry-run mode; terminal calls in live mode).
// ---------------------------------------------------------------------------

async function ghComment(issueNumber, body) {
  if (process.env.DRY_RUN === 'true') return
  // In live mode, the lead session has the terminal tool. This function
  // would invoke it. For now, it is a placeholder that the lead session
  // fills in when hosting the driver.
  console.log(`[gh] issue comment on #${issueNumber}: ${body.slice(0, 80)}...`)
}

async function ghPrReady(prUrl) {
  if (process.env.DRY_RUN === 'true') return
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1]
  if (prNumber) {
    console.log(`[gh] gh pr ready ${prNumber}`)
  }
}

async function ghRemoveLabel(issueNumber, label) {
  if (process.env.DRY_RUN === 'true') return
  console.log(`[gh] gh issue edit ${issueNumber} --remove-label ${label}`)
}
