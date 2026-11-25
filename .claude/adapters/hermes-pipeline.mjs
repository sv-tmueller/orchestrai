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
 * Run as a script, `main` is the command line (issue #355): it takes issue
 * numbers or `label:<name>`, gates them, and runs wave 1. `DRY_RUN=true`
 * prints the gate and the wave plan and writes nothing. See
 * docs/architecture/hermes-adapter.md, "Driver command line".
 *
 * In live mode the driver runs as an ordinary Node process. It creates one
 * git worktree per package and spawns each seat as a `hermes` subprocess,
 * so it needs no Hermes lead session: `node hermes-pipeline.mjs` plus the
 * spawned seats are the whole team.
 */

import { spawn, detectFailure, retry, resolveRole, resolveTier, loadPrompt } from './hermes-adapter.mjs'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
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
 * local HEAD when the remote is unreachable. With resumeBranch, it checks
 * out that branch from origin instead.
 *
 * Note: Hermes' own worktree mode copies files listed in
 * `.worktreeinclude`. A driver-created worktree does not get that for
 * free, so a seat needing a gitignored file needs it copied here.
 */
export async function ensureWorktree(repoRoot, plan, baseRef = 'origin/main', { run = defaultRun, resumeBranch } = {}) {
  const git = async (args) => {
    const r = await run('git', args, { cwd: repoRoot })
    if (r.code !== 0) throw commandError('git', args, r)
    return r.stdout
  }
  try {
    // Whole entries only: pkg-35 must not match an existing pkg-355.
    const listed = (await git(['worktree', 'list', '--porcelain'])).split('\n')
    if (listed.some((line) => line.replace(/\r$/, '') === `worktree ${plan.path}`)) {
      return { created: false, path: plan.path }
    }
  } catch {
    // No worktree list means no repo or no worktrees; let the add below fail loudly.
  }
  if (resumeBranch) {
    // A resume continues the branch the PR already has. Without this it
    // would branch off origin/main under a new name, or fail on a local
    // branch that exists. A failed fetch is an error: there is no sane fallback.
    await git(['fetch', 'origin', resumeBranch])
    await git(['worktree', 'add', plan.path, '-B', resumeBranch, `origin/${resumeBranch}`])
    return { created: true, path: plan.path }
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
 * slugOf(title) -> string
 *
 * The slug of a branch name, from the issue title: lowercase words joined by
 * single hyphens, at most 40 characters, `pending` when nothing is left. It
 * never holds a `:` or a `#`, which a push refspec cannot take.
 */
export function slugOf(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'pending'
}

const STAGES = ['architect', 'developer', 'tester', 'reviewer', 'ship']

// Fix rounds each seat may have, counted by the reports posted on the PR.
const MAX_ROUNDS = 3

// Added to the first seat of a resumed run. The run that stopped may have sent
// the very same prompt as its last dispatch, and a seat is never sent one prompt twice.
const PICKUP = '\n\nThis run picks the package up at this stage. Check the branch and the PR for work an earlier run may have left, and build on it.'

/**
 * runPipeline(issueNumber, opts) -> result
 *
 * Runs the flat-star pipeline for a single issue. Returns an object with
 * the final state: PR number, verdicts, fix-round counts, and any parked
 * reason.
 *
 * Each tester FAIL and each reviewer CHANGES_REQUESTED is one fix round, up
 * to 3 per seat. The report is posted on the PR, then the developer fixes it
 * and the tester runs again. After a reviewer round the re-test comes first,
 * and a FAIL there is an ordinary tester round. The 4th FAIL or CHANGES_REQUESTED
 * parks the package.
 *
 * opts:
 * - repoOwner: the GitHub org/user (for gh commands)
 * - repoName: the GitHub repo name
 * - dryRun: override DRY_RUN env var
 * - run: the gh and git runner (default: defaultRun)
 * - spawn: the seat dispatcher (default: the adapter's spawn)
 * - log: sink for progress lines (default: console.warn)
 * - title: the issue title, which names the branch (see slugOf)
 * - inProgress: the issue already carries in-progress, so a stop removes it
 * - resume: { stage, branch, pr, findings, fixRounds }. Stages before
 *   resume.stage are skipped. The order is architect, developer, tester,
 *   reviewer, ship. findings, when set, is the body of the posted report whose
 *   fixes the developer is to make. fixRounds is the count read from the PR
 *   (see countFixRounds), and it already includes that report.
 */
export async function runPipeline(issueNumber, opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : process.env.DRY_RUN === 'true'
  const sink = opts.log || ((line) => console.warn(line))
  const log = (msg) => sink(`[pipeline:#${issueNumber}] ${msg}`)
  const run = opts.run || defaultRun
  const spawnSeat = opts.spawn || spawn

  const repoRoot = opts.repoRoot || process.cwd()
  // One branch name for the worktree and for the developer prompt.
  const plan = worktreePlan(repoRoot, issueNumber, slugOf(opts.title), { type: opts.branchType })
  const gh = createGitHub({ run, dryRun, log, cwd: repoRoot })

  const resume = opts.resume
  const state = {
    issue: issueNumber,
    worktree: plan.path,
    dispatches: [],
    branch: null,
    pr: null,
    subPlan: null,
    testerVerdict: null,
    reviewerVerdict: null,
    fixRounds: { tester: resume?.fixRounds?.tester ?? 0, reviewer: resume?.fixRounds?.reviewer ?? 0 },
    parked: null,
    done: false,
  }

  const start = resume ? STAGES.indexOf(resume.stage) : 0
  const runs = (stage) => STAGES.indexOf(stage) >= start
  if (resume) {
    state.branch = resume.branch || null
    state.pr = resume.pr || null
    // A stage that was skipped passed before: the tester before the reviewer, both before ship.
    if (start > STAGES.indexOf('tester')) state.testerVerdict = 'PASS'
    if (start > STAGES.indexOf('reviewer')) state.reviewerVerdict = 'APPROVE'
  }

  // The label goes on before the first seat from the developer on, once.
  // Adding is idempotent, and ship removes it, so a resume past the
  // developer sets it too.
  let labeled = false
  const ensureInProgress = async () => {
    if (labeled) return
    labeled = true
    await gh.addLabel(issueNumber, 'in-progress')
  }

  // Every stop of the package ends here, so none is silent: the reason goes on
  // the issue with needs-human, and in-progress comes off when this run or the
  // gate put it on. details is the seat's own text, quoted under the reason.
  const stop = async (reason, details) => {
    state.parked = reason
    log(`parked: ${state.parked}`)
    await gh.park(issueNumber, reason, { inProgress: labeled || opts.inProgress === true, details: details?.trim() })
    return state
  }
  // A live run never turns a missing report into success: the package stops.
  // A dry run has no real seats, so the placeholders below stand in.
  const noReport = (role) => stop(`${role} seat returned no usable report`)
  // Each seat is read as its contract prescribes. A live run accepts the exact
  // words only; a dry run keeps the old lenient read and the placeholders.
  const verdictOf = (report, valid, dryFallback) => {
    if (dryRun) return report?.VERDICT || report?.verdict || dryFallback
    return valid.includes(report?.VERDICT) ? report.VERDICT : null
  }
  const testerVerdict = (report) => verdictOf(report, ['PASS', 'FAIL'], 'PASS')
  const reviewerVerdict = (report) => verdictOf(report, ['APPROVE', 'CHANGES_REQUESTED'], 'APPROVE')

  // True when a developer report lets the run go on. BLOCKED and NEEDS_CONTEXT
  // park: no seat contract has a job that answers a question. In a live run any
  // status but DONE and DONE_WITH_CONCERNS stops.
  const developerOk = async (report) => {
    const status = report?.STATUS
    if (status === 'BLOCKED' || status === 'NEEDS_CONTEXT') {
      await stop(`developer ${status}: ${report.NOTES}`, report.raw)
      return false
    }
    if (!dryRun && status !== 'DONE' && status !== 'DONE_WITH_CONCERNS') {
      await noReport('developer')
      return false
    }
    return true
  }

  // Every seat runs in the package worktree. Recorded so a run can be
  // audited for isolation after the fact. exact keeps a prompt as it is,
  // for the one the no-PR ruling on #355 fixed word for word.
  let pickUp = Boolean(resume)
  const dispatch = async (role, task, tier, { exact = false } = {}) => {
    const prompt = pickUp && !exact ? `${task}${PICKUP}` : task
    pickUp = false
    state.dispatches.push({ role, tier, cwd: plan.path })
    return spawnSeat(role, prompt, { tier, cwd: plan.path })
  }

  // The latest fix round of this run, named in every re-test and review prompt.
  // A repeat dispatch always follows a newer round, so no prompt goes out twice.
  let lastFix = null
  const after = () => (lastFix ? ` after ${lastFix.kind} fix round ${lastFix.round}/${MAX_ROUNDS}` : '')
  const testTask = () => `Branch ${state.branch}, issue #${issueNumber}: verify the change${after()}. Run the full check suite and attack the change.`
  // The reviewer rates the tester's untested claims, so it gets the report that carries them.
  let testerBody = null
  const reviewTask = () => {
    const claims = testerBody
      ? `\n\nUntested claims to rate under CLAIMS, by their number in this tester report:\n${testerBody}`
      : `\n\nUntested claims to rate under CLAIMS: take them from the latest tester report comment on PR ${state.pr}.`
    return `PR ${state.pr}, issue #${issueNumber}: review the diff against the issue and sub-plan${after()}. Two passes: spec compliance then code quality.${claims}`
  }
  // The fix prompt carries the whole posted report: the parser keeps only the
  // first line of a multi-line FINDINGS.
  const fixTask = (kind, round, body) =>
    `Issue #${issueNumber}, branch ${state.branch}, ${kind} fix round ${round}/${MAX_ROUNDS}: ` +
    `${kind === 'tester' ? 'fix exactly these findings:' : 'fix exactly the must-fix findings of this review:'}\n${body}`
  const exhausted = (kind) => stop(`${kind} fix rounds exhausted (${MAX_ROUNDS}/${MAX_ROUNDS})`)

  // Posts one seat's report on the PR and returns the comment body. The seat's
  // own text follows the header unchanged, so its VERDICT line starts a line
  // and a later run reads it back (resumeStage, countFixRounds).
  const postReport = async (seat, verdict, report) => {
    const text = report?.raw?.trim() || [`VERDICT: ${verdict}`, report?.FINDINGS ? `FINDINGS: ${report.FINDINGS}` : null].filter(Boolean).join('\n')
    const name = seat === 'tester' ? 'Tester' : 'Reviewer'
    const body = `**${name} report: ${verdict} (issue #${issueNumber}, ${seat} fix rounds ${state.fixRounds[seat]}/${MAX_ROUNDS})**\n\n${text}`
    await gh.prComment(state.pr, body)
    if (seat === 'tester') testerBody = body
    return body
  }

  // The developer fixes the findings of a posted report. False when the run stops.
  const fixRound = async (kind, body) => {
    lastFix = { kind, round: state.fixRounds[kind] }
    log(`${kind} fix round ${lastFix.round}/${MAX_ROUNDS}`)
    return developerOk(await dispatch('developer', fixTask(kind, lastFix.round, body), 'worker'))
  }

  // Tests until PASS. Each FAIL is a tester fix round. False when the run stops.
  const testUntilPass = async () => {
    for (;;) {
      const report = await dispatch('tester', testTask(), 'worker')
      state.testerVerdict = testerVerdict(report)
      if (!state.testerVerdict) {
        await noReport('tester')
        return false
      }
      if (state.testerVerdict === 'FAIL') state.fixRounds.tester++
      const body = await postReport('tester', state.testerVerdict, report)
      if (state.testerVerdict === 'PASS') return true
      if (state.fixRounds.tester > MAX_ROUNDS) {
        await exhausted('tester')
        return false
      }
      if (!(await fixRound('tester', body))) return false
    }
  }

  if (!dryRun) {
    await ensureWorktree(repoRoot, plan, opts.baseRef, { run, resumeBranch: resume?.branch })
  }

  // --- Stage 1: Architect (SUB_PLAN) ---
  if (runs('architect')) {
    log('stage 1: architect SUB_PLAN')
    const archTask = `JOB: SUB_PLAN\n\nIssue #${issueNumber}: read the issue and its comments, then produce a sub-plan with checkpoint bullets.`
    const archReport = await dispatch('architect', archTask, 'judgment')

    if (archReport?.KIND === 'NEEDS_DECISION') {
      const question = decisionQuestion(archReport)
      return stop(question ? `architect NEEDS_DECISION: ${question}` : 'architect NEEDS_DECISION', archReport.raw)
    }
    // Only a SUB_PLAN with a body is a sub-plan. A SPLIT_PROPOSAL, an
    // ARBITRATION, text with no header and a bare header are not posted as one.
    if (!dryRun && (archReport?.KIND !== 'SUB_PLAN' || !hasBody(archReport.raw, 'SUB_PLAN'))) return noReport('architect')

    // A live seat comes back from parseReport(), with its text in `raw`.
    // `output` and `summary` are the dry-run shape.
    state.subPlan = archReport?.raw?.trim() || archReport?.output || archReport?.summary || 'sub-plan generated'
    log('sub-plan received')

    // The gate finds a sub-plan by a line that is exactly SUB_PLAN, so the
    // posted comment always carries one.
    await gh.comment(issueNumber, hasSubPlan([{ body: state.subPlan }]) ? state.subPlan : `SUB_PLAN\n\n${state.subPlan}`)
  }

  // --- Stage 2: Developer (implement, or fix the findings of a resume) ---
  if (runs('developer')) {
    log('stage 2: developer implement')
    state.branch = resume?.branch || plan.branch

    // A branch with no PR and no findings: the work stopped before the draft PR.
    const noPrResume = resume?.stage === 'developer' && resume.branch && !resume.pr && resume.findings === undefined
    let devTask
    if (resume?.findings !== undefined) {
      // The findings are a posted report, and the count already includes it.
      const kind = /^VERDICT:[ \t]*CHANGES_REQUESTED\b/m.test(resume.findings.replace(/\r/g, '')) ? 'reviewer' : 'tester'
      const round = state.fixRounds[kind] || 1
      if (round > MAX_ROUNDS) return exhausted(kind)
      state.fixRounds[kind] = round
      lastFix = { kind, round }
      devTask = fixTask(kind, round, resume.findings)
    } else if (noPrResume) {
      devTask = `Issue #${issueNumber}, branch ${state.branch}: the branch is on origin and has no PR. Fetch it, finish the work per the sub-plan, open the draft PR, and run the full check suite before reporting.`
    } else {
      devTask = `Issue #${issueNumber}, branch ${state.branch}: implement per the sub-plan. The sub-plan comment is your spec. Use TDD. Run the full check suite before reporting.`
    }
    await ensureInProgress()
    const devReport = await dispatch('developer', devTask, 'worker', { exact: noPrResume })

    if (!(await developerOk(devReport))) return state

    // A PR the report names must be a pull request URL or a number. An empty
    // or missing one falls back to the gate's.
    const reported = devReport?.pr || devReport?.PR
    if (!dryRun && reported && !isPullRequest(reported)) return noReport('developer')
    state.pr = reported || resume?.pr || (dryRun ? `https://github.com/example/repo/pull/${issueNumber}` : null)
    if (!state.pr && !dryRun) return noReport('developer')
    log(`developer done, PR: ${state.pr}`)
  }

  // No seat prompt is built with a null PR, and a package with no PR cannot ship.
  if (!state.pr) return stop('no PR to mark ready')

  // --- Stage 3: Tester (verify) ---
  if (runs('tester')) {
    log('stage 3: tester verify')
    await ensureInProgress()
    if (!(await testUntilPass())) return state
    log(`tester ${state.testerVerdict}`)
  }

  // --- Stage 4: Reviewer (review) ---
  if (runs('reviewer')) {
    log('stage 4: reviewer review')
    for (;;) {
      const report = await dispatch('reviewer', reviewTask(), 'judgment')
      state.reviewerVerdict = reviewerVerdict(report)
      if (!state.reviewerVerdict) return noReport('reviewer')
      if (state.reviewerVerdict === 'CHANGES_REQUESTED') state.fixRounds.reviewer++
      const body = await postReport('reviewer', state.reviewerVerdict, report)
      if (state.reviewerVerdict === 'APPROVE') break
      if (state.fixRounds.reviewer > MAX_ROUNDS) return exhausted('reviewer')
      // Fix round: the must-fix findings go to the developer, then the re-test, then the re-review.
      if (!(await fixRound('reviewer', body))) return state
      if (!(await testUntilPass())) return state
    }
    log(`reviewer ${state.reviewerVerdict}`)
  }

  // --- Stage 5: Ship ---
  if (state.reviewerVerdict === 'APPROVE' && state.testerVerdict === 'PASS') {
    log('stage 5: ship')
    state.done = true
    await ensureInProgress()
    await gh.prReady(state.pr)
    await gh.removeLabel(issueNumber, 'in-progress')
    await gh.comment(issueNumber, `Pipeline complete. PR ready: ${state.pr}`)
  } else {
    return stop(`unexpected state: tester=${state.testerVerdict}, reviewer=${state.reviewerVerdict}`)
  }

  return state
}

/**
 * runWave(packages, opts) -> results[]
 *
 * Runs the pipeline for multiple issues concurrently (up to 3 at a time).
 * A package is an issue number, or { issue, resume } for a gate outcome
 * that does not start at the architect. Returns an array of state objects,
 * one per package.
 */
export async function runWave(packages, opts = {}) {
  const MAX_CONCURRENT = 3
  const results = []

  for (let i = 0; i < packages.length; i += MAX_CONCURRENT) {
    const batch = packages.slice(i, i + MAX_CONCURRENT)
    // One package throwing (a failed git or gh call) must not hide the
    // others, so each is settled on its own.
    const settled = await Promise.allSettled(
      batch.map((p) => {
        const { issue, resume, title, inProgress } = typeof p === 'number' ? { issue: p } : p
        return runPipeline(issue, { ...opts, resume, title, inProgress })
      })
    )
    settled.forEach((s, k) => {
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        const p = batch[k]
        const issue = typeof p === 'number' ? p : p.issue
        results.push({ issue, done: false, parked: null, error: s.reason?.reason ?? firstLine(s.reason?.message || s.reason) })
      }
    })
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

// The parser accepts any spacing after the colon, so the reader does too.
const VERDICT_LINE = /^VERDICT:[ \t]*(PASS|FAIL|APPROVE|CHANGES_REQUESTED)\b/m

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
 * countFixRounds(comments) -> { tester, reviewer }
 *
 * The fix rounds a PR has used, read from the same verdict lines as
 * resumeStage: each FAIL is a tester round, each CHANGES_REQUESTED a reviewer
 * round. Every posted report counts, so the number a fresh run reads is the
 * number the run that stopped had.
 */
export function countFixRounds(comments) {
  const counts = { tester: 0, reviewer: 0 }
  for (const comment of comments) {
    const m = String(comment.body || '').replace(/\r/g, '').match(VERDICT_LINE)
    if (m?.[1] === 'FAIL') counts.tester++
    if (m?.[1] === 'CHANGES_REQUESTED') counts.reviewer++
  }
  return counts
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

// The canonical label set. SKILL.hermes.md carries the same list in its Gate
// block today. #605 removes it there, and this becomes the only copy.
export const LABELS = [
  { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
  { name: 'size:M', color: 'BFD4F2', description: '1 to 3 hours. Write a sub-plan first.' },
  { name: 'size:L', color: 'F9D0C4', description: '4 to 6 hours. Split or checkpoint.' },
  { name: 'size:XL', color: 'D93F0B', description: 'About 8 hours. Too big. Split it.' },
  { name: 'in-progress', color: 'FBCA04', description: 'Package dispatched; resume, do not restart.' },
  { name: 'needs-human', color: 'B60205', description: 'Agent loop exhausted or blocked; human decision needed.' },
]

const firstLine = (text) => String(text || '').trim().split('\n')[0]

/**
 * The error for a gh or git call that exited nonzero. The message names the
 * command on one line (a newline in an argument shows as a space) and ends
 * with the first line of its stderr. `reason` is that stderr line alone, which
 * is what a package's error line prints.
 */
function commandError(cmd, args, r) {
  const reason = firstLine(r.stderr) || `exit ${r.code}`
  const command = [cmd, ...args].join(' ').replace(/\r?\n/g, ' ')
  return Object.assign(new Error(`${command}: ${reason}`), { reason })
}

// A pull request URL (it holds /pull/<digits>) or a bare number.
const isPullRequest = (value) => /\/pull\/\d+/.test(String(value)) || /^\d+$/.test(String(value).trim())

// Does a report have a body after its header? Text after `<header>:` on the
// header line counts, and so does any non-empty line after it.
function hasBody(raw, header) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  if (lines.length > 1) return true
  return lines[0].startsWith(`${header}:`) && lines[0].slice(header.length + 1).trim() !== ''
}

// The question of an architect NEEDS_DECISION report: the field when it has
// text, else the first non-empty line after the header line.
function decisionQuestion(report) {
  if (report.NEEDS_DECISION) return report.NEEDS_DECISION
  const lines = String(report.raw || '').split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[1] || ''
}
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
    if (r.code !== 0) throw commandError(cmd, args, r)
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
    prComment: (pr, body) => write('gh', ['pr', 'comment', String(pr), '--body', body]),
    prReady: (pr) => write('gh', ['pr', 'ready', String(pr)]),

    // Parking: the reason on the issue, needs-human on, in-progress off only
    // when the issue has it (removing a missing label is an error). details is
    // seat text. It is quoted line by line, so no line of it starts with
    // SUB_PLAN or VERDICT: where the gate reads comments.
    async park(n, reason, { inProgress = false, details } = {}) {
      const quoted = details ? `\n\n${details.replace(/\r/g, '').split('\n').map((l) => `> ${l}`).join('\n')}` : ''
      await gh.comment(n, `Parked: ${reason}${quoted}`)
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
 * { issue, size, outcome, detail, blockers, inProgress, title, resume? }.
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
  const entry = (outcome, detail, extra = {}) => ({ issue: n, size, outcome, detail, blockers: [], inProgress, title: issue.title, ...extra })

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
    const comments = await gh.prComments(draft.number)
    const { stage, findings } = resumeStage(comments)
    const resume = { stage, branch: draft.headRefName, pr: draft.number, fixRounds: countFixRounds(comments) }
    if (findings !== undefined) resume.findings = findings
    result = entry('resume', `draft PR #${draft.number}, resuming at the ${stage}`, { resume })
  } else if (inProgress) {
    const branchRef = (await gh.remoteHeads()).find((r) => new RegExp(`^refs/heads/[^/]+/${n}-`).test(r))
    result = branchRef
      ? entry('resume', `branch ${branchRef.slice('refs/heads/'.length)} on origin, no PR, resuming at the developer`, {
          resume: { stage: 'developer', branch: branchRef.slice('refs/heads/'.length) },
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
// The command line.
// ---------------------------------------------------------------------------

/**
 * main(argv, { env, run, spawn, out, err, cwd }) -> exit code
 *
 * Exit 0: the run finished, whatever the packages' parked outcomes. Exit 1: a
 * gh or git call failed at the gate, or a package threw (its line reads
 * `#n error: <reason>`, see commandError, and the other packages still finish and report).
 * Exit 2: a usage error, before any GitHub call. stdout (out) carries the gate, the wave plan and the results;
 * progress, dry-run notes and errors go to stderr (err).
 */
export async function main(argv, { env = process.env, run = defaultRun, spawn: spawnSeat, out = console.log, err = console.warn, cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv)
  if (parsed.error) {
    err(parsed.error)
    err(USAGE)
    return 2
  }
  const dryRun = env.DRY_RUN === 'true'
  const gh = createGitHub({ run, dryRun, log: err, cwd })

  try {
    for (const label of LABELS) await gh.createLabel(label)

    const numbers = []
    for (const item of parsed.items) {
      const found = item.issue !== undefined ? [item.issue] : await gh.issueList(item.label)
      for (const n of found) if (!numbers.includes(n)) numbers.push(n)
    }

    const entries = await runGate(numbers, gh)
    for (const e of entries) {
      if (e.outcome === 'park') await gh.park(e.issue, e.detail, { inProgress: e.inProgress })
    }

    const { waves, waiting } = planWaves(entries)
    entries.forEach((e) => out(formatGateLine(e)))
    waves.forEach((w, k) => out(`wave ${k + 1}: ${w.map((n) => `#${n}`).join(' ')}`))
    for (const w of waiting) out(`waiting: #${w.issue} (blocked by ${w.blockers.map((b) => `#${b}`).join(', ')})`)

    // The dry run stands in for a confirmation step: it shows the plan and stops.
    if (dryRun || waves.length === 0) return 0

    // Only wave 1 runs. The driver never merges, so a later wave's blocker
    // cannot be merged during this run; the next run picks the later waves up.
    const packages = waves[0].map((n) => {
      const e = entries.find((x) => x.issue === n)
      return { issue: n, resume: e.resume, title: e.title, inProgress: e.inProgress }
    })
    const results = await runWave(packages, { dryRun: false, run, spawn: spawnSeat, log: err, repoRoot: cwd })
    for (const r of results) {
      out(r.error !== undefined ? `#${r.issue} error: ${r.error}` : r.done ? `#${r.issue} done: PR ${r.pr}` : `#${r.issue} parked: ${r.parked}`)
    }
    return results.some((r) => r.error !== undefined) ? 1 : 0
  } catch (e) {
    err(firstLine(e?.message || e))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
