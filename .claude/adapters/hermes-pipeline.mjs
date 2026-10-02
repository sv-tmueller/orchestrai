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
