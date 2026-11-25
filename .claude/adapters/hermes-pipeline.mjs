/**
 * Hermes pipeline driver (issues #334, #631): the code form of
 * docs/architecture/light-flow.md. A developer, a reviewer only when the review
 * gate says so, at most 2 fix rounds, then ship. The Hermes kickoff skill runs
 * this module and holds no pipeline rule of its own. With DRY_RUN=true seats
 * return synthetic reports and every write is logged, not run. Details:
 * docs/architecture/hermes-adapter.md.
 */

import { spawn } from './hermes-adapter.mjs'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The driver owns the worktree (never `hermes -w`, whose cleanup deletes unpushed branches).
export function worktreePlan(repoRoot, issueNumber, slug = 'pending', opts = {}) {
  return { path: `${repoRoot}/.worktrees/pkg-${issueNumber}`, branch: `${opts.type || 'feat'}/${issueNumber}-${slug}` }
}

// Creates the worktree unless it exists: on resumeBranch from origin, else on a new branch from baseRef.
export async function ensureWorktree(repoRoot, plan, baseRef = 'origin/main', { run = defaultRun, resumeBranch } = {}) {
  const git = async (args) => {
    const r = await run('git', args, { cwd: repoRoot })
    if (r.code !== 0) throw commandError('git', args, r)
    return r.stdout
  }
  // Whole entries only: pkg-35 must not match an existing pkg-355.
  const listed = await git(['worktree', 'list', '--porcelain']).catch(() => '')
  if (linesOf(listed).includes(`worktree ${plan.path}`)) return { created: false, path: plan.path }
  if (resumeBranch) {
    await git(['fetch', 'origin', resumeBranch])
    await git(['worktree', 'add', plan.path, '-B', resumeBranch, `origin/${resumeBranch}`])
    return { created: true, path: plan.path }
  }
  try {
    await git(['worktree', 'add', plan.path, '-b', plan.branch, baseRef])
  } catch {
    await git(['worktree', 'add', plan.path, '-b', plan.branch, 'HEAD'])
  }
  return { created: true, path: plan.path }
}

// The branch slug from the issue title: at most 40 chars, `pending` when empty.
export const slugOf = (title) =>
  String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'pending'

export const MAX_FIX_ROUNDS = 2

// The review gate's risky paths: prefixes, and manifest or lockfile names at any depth.
export const RISKY_PATHS = [
  '.claude/agents', '.claude/skills', '.claude/workflows', '.github/workflows',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pyproject.toml', 'poetry.lock',
  'requirements.txt', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock',
]

// Does the light flow require a reviewer? size is `S` or `size:S`; an unknown size needs one.
export function needsReview({ size, paths = [], status } = {}) {
  if (String(size).replace(/^size:/, '') !== 'S') return true
  if (status === 'DONE_WITH_CONCERNS') return true
  return paths.some((p) => RISKY_PATHS.some((r) => p === r || p.startsWith(`${r}/`) || p.endsWith(`/${r}`)))
}

// The lead's own check for a skipped review: every command on CHECKS exited 0.
const checksPass = (report) => {
  const codes = [...textOf(report?.CHECKS ?? report?.checks).matchAll(/->\s*(\d+)/g)]
  return codes.length > 0 && codes.every((m) => m[1] === '0')
}

// The head sha a reviewer says it tested: the first token of its CHECKS line.
const testedSha = (report) => /^[\s`]*([0-9a-f]{7,40})\b/i.exec(textOf(report?.CHECKS))?.[1].toLowerCase()

// A developer disputes a finding with `pushback: finding <k>: <why>` on its own line.
const PUSHBACK_LINE = /^[ \t]*(?:(?:DEVIATIONS|NOTES):[ \t]*)?(?:[-*][ \t]+|\d+\.[ \t]+)?pushback: finding \d+:/
const disputes = (report) => linesOf(textOf(report?.raw)).some((line) => PUSHBACK_LINE.test(line))
const PUSHBACK_SUFFIX = '\n\nIf a finding is wrong, do not fix it. Under DEVIATIONS, write one line per such finding: `pushback: finding <k>: <why it is wrong>`.'

/**
 * runPipeline(issueNumber, opts) -> state
 *
 * opts: repoRoot, dryRun, run, spawn, log, title (names the branch), size,
 * inProgress, baseRef, resume: { stage: 'develop' | 'gate' | 'fix' | 'done',
 * branch, pr, fixRounds, findings }. Each CHANGES_REQUESTED is one fix round.
 */
export async function runPipeline(issueNumber, opts = {}) {
  const dryRun = opts.dryRun ?? process.env.DRY_RUN === 'true'
  const log = (msg) => (opts.log || console.warn)(`[pipeline:#${issueNumber}] ${msg}`)
  const run = opts.run || defaultRun
  const spawnSeat = opts.spawn || spawn
  const repoRoot = opts.repoRoot || process.cwd()
  const plan = worktreePlan(repoRoot, issueNumber, slugOf(opts.title), { type: opts.branchType })
  const gh = createGitHub({ run, dryRun, log, cwd: repoRoot })
  const resume = opts.resume
  const state = {
    issue: issueNumber, worktree: plan.path, dispatches: [], branch: resume?.branch || plan.branch, pr: resume?.pr || null,
    prNumber: null, reviewerVerdict: null, fixRounds: resume?.fixRounds ?? 0, parked: null, done: false,
  }

  let labeled = false
  const ensureInProgress = () => (labeled ? undefined : ((labeled = true), gh.addLabel(issueNumber, 'in-progress')))
  // Every stop ends here: the reason on the issue, needs-human on, in-progress off.
  const stop = async (reason, details) => {
    state.parked = reason
    log(`parked: ${reason}`)
    await gh.park(issueNumber, reason, { inProgress: labeled || opts.inProgress === true, details: textOf(details).trim() })
    return state
  }
  const fail = async (...args) => (await stop(...args), false)
  const noReport = (role) => fail(`${role} seat returned no usable report`)

  // Every seat runs in the package worktree; state.dispatches records it for audit.
  const dispatch = (role, task, tier) => {
    state.dispatches.push({ role, tier, cwd: plan.path })
    return spawnSeat(role, task, { tier, cwd: plan.path })
  }

  // One developer dispatch. False when the run stops.
  let devReport = null
  const develop = async (task, { fix = false } = {}) => {
    await ensureInProgress()
    devReport = await dispatch('developer', task, 'worker')
    const status = textOf(devReport?.STATUS)
    if (status === 'BLOCKED' || status === 'NEEDS_CONTEXT') {
      const notes = oneLine(devReport.NOTES)
      return fail(notes ? `developer ${status}: ${notes}` : `developer ${status}`, devReport.raw)
    }
    if (!dryRun && status !== 'DONE' && status !== 'DONE_WITH_CONCERNS') return noReport('developer')
    const reported = oneLine(devReport?.PR ?? devReport?.pr)
    if (!dryRun && reported && !isPullRequest(reported)) return noReport('developer')
    state.pr = reported || state.pr || (dryRun ? `https://github.com/example/repo/pull/${issueNumber}` : null)
    if (!state.pr) return noReport('developer')
    log(`developer done, PR: ${state.pr}`)
    if (fix && disputes(devReport)) return fail('developer disputes a finding of the review', devReport.raw)
    return true
  }

  const exhausted = () => fail(`fix rounds exhausted (${MAX_FIX_ROUNDS}/${MAX_FIX_ROUNDS})`)
  const fixTask = (body) =>
    `Issue #${issueNumber}, branch ${state.branch}, fix round ${state.fixRounds}/${MAX_FIX_ROUNDS}: fix exactly the must-fix findings of this review:\n${body}${PUSHBACK_SUFFIX}`

  // Reviews until APPROVE, with a fix round after each CHANGES_REQUESTED. False when the run stops.
  let lastReview = null
  let staleReviews = 0
  const review = async () => {
    for (;;) {
      const after = state.fixRounds ? ` after fix round ${state.fixRounds}/${MAX_FIX_ROUNDS}` : ''
      const moved = staleReviews ? ' The PR head moved since the last review: review the current head.' : ''
      lastReview = await dispatch(
        'reviewer',
        `PR ${state.pr}, issue #${issueNumber}: review the diff against the issue, whose ## Approach section is the plan${after}. Two passes: spec compliance, then code quality.${moved}`,
        'judgment'
      )
      const word = textOf(lastReview?.VERDICT)
      const verdict = ['APPROVE', 'CHANGES_REQUESTED'].includes(word) ? word : dryRun ? 'APPROVE' : null
      if (!verdict) return noReport('reviewer')
      state.reviewerVerdict = verdict
      // A later run reads the verdict back from this comment, so it always has a readable VERDICT line.
      const top = `**Reviewer report: ${verdict} (issue #${issueNumber})**\n\n`
      const text = textOf(lastReview?.raw).trim() || `VERDICT: ${verdict}\nFINDINGS: ${textOf(lastReview?.FINDINGS)}`
      const body = `${top}${readVerdict(text) === verdict ? '' : `VERDICT: ${verdict}\n\n`}${text}`
      await gh.prComment(state.pr, body)
      if (verdict === 'APPROVE') return true
      if (++state.fixRounds > MAX_FIX_ROUNDS) return exhausted()
      log(`fix round ${state.fixRounds}/${MAX_FIX_ROUNDS}`)
      if (!(await develop(fixTask(body), { fix: true }))) return false
    }
  }

  if (!dryRun) await ensureWorktree(repoRoot, plan, opts.baseRef, { run, resumeBranch: resume?.branch })
  const stage = resume?.stage ?? 'develop'
  if (stage === 'develop') {
    const task = resume?.branch
      ? `Issue #${issueNumber}, branch ${state.branch}: the branch is on origin and has no PR. Fetch it, finish the work per the issue's ## Approach section, open the draft PR, and run the full check suite before reporting.`
      : `Issue #${issueNumber}, branch ${state.branch}: implement per the issue body, whose ## Approach section is the plan. Use TDD. Run the full check suite, push, open the draft PR with Closes #${issueNumber}, and report.`
    if (!(await develop(task))) return state
  } else if (stage === 'fix') {
    if (state.fixRounds > MAX_FIX_ROUNDS) return (await exhausted(), state)
    if (!(await develop(fixTask(resume.findings), { fix: true }))) return state
  }

  // The review gate. With no developer report (a resume at the gate) there is no CHECKS line to trust.
  const reviewing =
    stage === 'fix' ||
    (stage !== 'done' &&
      (!devReport || !checksPass(devReport) || needsReview({ size: opts.size, paths: dryRun ? [] : await gh.prPaths(state.pr), status: textOf(devReport.STATUS) })))
  state.reviewed = reviewing || stage === 'done'
  log(state.reviewed ? 'review gate: reviewer required' : 'review gate: not required (size S)')

  let head = null
  for (;;) {
    if (reviewing && !(await review())) return state
    if (!dryRun) {
      const view = await gh.prView(state.pr)
      state.prNumber = view.number
      if (!view.closingIssuesReferences.some((ref) => ref?.number === issueNumber)) return stop(`PR #${view.number} does not close #${issueNumber}`)
      head = view.headRefOid
    }
    // A review that tested another commit does not cover the head: review again, once.
    const sha = testedSha(lastReview)
    if (!sha || !head || head.toLowerCase().startsWith(sha)) break
    if (staleReviews++) return stop('the PR head moved after two reviews, so no review covers it')
    log('the reviewed commit is not the PR head, reviewing again')
  }

  await ensureInProgress() // a resume past the developer has not added it, and removing a missing label is an error
  await gh.postStatus(head || 'dry-run', state.reviewed ? 'approved by the reviewer' : 'not required (size S)')
  await gh.prReady(state.pr)
  await gh.removeLabel(issueNumber, 'in-progress')
  await gh.comment(
    issueNumber,
    `Pipeline complete: PR ${state.pr} is ready for review.\n\nReviewer: ${state.reviewed ? 'APPROVE' : 'not required (size S)'}. Fix rounds used: ${state.fixRounds}/${MAX_FIX_ROUNDS}.`
  )
  state.done = true
  return state
}

// Runs up to 3 packages at once: an issue number or { issue, resume, title, inProgress, size }.
// One that throws gets an error entry and does not hide the others.
export async function runWave(packages, opts = {}) {
  const results = []
  for (let i = 0; i < packages.length; i += 3) {
    const batch = packages.slice(i, i + 3).map((p) => (typeof p === 'number' ? { issue: p } : p))
    const settled = await Promise.allSettled(batch.map(({ issue, ...own }) => runPipeline(issue, { ...opts, ...own })))
    settled.forEach((s, k) =>
      results.push(s.status === 'fulfilled' ? s.value : { issue: batch[k].issue, done: false, parked: null, error: s.reason?.reason ?? firstLine(s.reason?.message || s.reason) })
    )
  }
  return results
}

// Command line, resume and wave planning.

export const USAGE = 'usage: node "${ORCHESTRAI_ROOT:-.claude}/adapters/hermes-pipeline.mjs" <issue-number | label:<name>>...'

/** parseArgs(argv) -> { items } | { error }. An argument is digits or `label:<name>`. */
export function parseArgs(argv) {
  if (argv.length === 0) return { error: 'no packages given' }
  const items = new Map()
  for (const arg of argv) {
    if (/^\d+$/.test(arg)) items.set(arg, { issue: Number(arg) })
    else if (arg.startsWith('label:') && arg.length > 'label:'.length) items.set(arg, { label: arg.slice('label:'.length) })
    else return { error: `bad argument: ${JSON.stringify(arg)}` }
  }
  return { items: [...items.values()] }
}

/** parseBlockers(body) -> number[]. Whole lines `Blocked by: #N` only. */
export const parseBlockers = (body) => [...new Set(linesOf(body).map((l) => /^Blocked by: #(\d+)\s*$/.exec(l)?.[1]).filter(Boolean).map(Number))]

// The readers split a comment at a line feed only, and drop a CR before it.
const linesOf = (body) => String(body || '').split('\n').map((line) => line.replace(/\r$/, ''))

const readVerdict = (body) => linesOf(body).map((l) => /^VERDICT:[ \t]*(APPROVE|CHANGES_REQUESTED)\b/.exec(l)).find(Boolean)?.[1] ?? null

// The latest comment (by createdAt) that carries a reviewer verdict line.
const latestReview = (comments) =>
  [...comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).findLast((c) => readVerdict(c.body))

/** resumeStage(comments, { hasPr }) -> 'develop' | 'gate' | 'fix' | 'done', from GitHub state only. */
export function resumeStage(comments, { hasPr }) {
  if (!hasPr) return 'develop'
  const last = latestReview(comments)
  return !last ? 'gate' : readVerdict(last.body) === 'APPROVE' ? 'done' : 'fix'
}

/** countFixRounds(comments) -> number of reviewer CHANGES_REQUESTED comments. */
export const countFixRounds = (comments) => comments.filter((c) => readVerdict(c.body) === 'CHANGES_REQUESTED').length

// Wave 1 is every run and resume entry; wave k holds the waiters whose blockers all sit in earlier waves.
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

// The one function every gh and git call goes through. It never rejects on a nonzero exit.
export const defaultRun = (cmd, args, { cwd } = {}) =>
  execFileAsync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e) => ({ code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message || e) })
  )

// Created by main before the gate.
export const LABELS = [
  { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
  { name: 'size:M', color: 'BFD4F2', description: '1 to 3 hours. Write a sub-plan first.' },
  { name: 'size:L', color: 'F9D0C4', description: '4 to 6 hours. Split or checkpoint.' },
  { name: 'size:XL', color: 'D93F0B', description: 'About 8 hours. Too big. Split it.' },
  { name: 'in-progress', color: 'FBCA04', description: 'Package dispatched; resume, do not restart.' },
  { name: 'needs-human', color: 'B60205', description: 'Agent loop exhausted or blocked; human decision needed.' },
]

// A seat field read as text: a string, or a json number as its digits, else absent.
const textOf = (value) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

// What the driver writes ends a line at any of these (CRLF is one end).
const LINE_END = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

// Seat text goes into a comment as a quoted block (no line of it starts with VERDICT:), or as one line.
const quote = (text) => text.split(LINE_END).map((line) => `> ${line}`).join('\n')
const oneLine = (value) => textOf(value).split(LINE_END).map((line) => line.trim()).find(Boolean) ?? ''
const firstLine = (text) => oneLine(String(text || ''))

// The error for a gh or git call that exited nonzero. `reason` is the first stderr line.
function commandError(cmd, args, r) {
  const reason = firstLine(r.stderr) || `exit ${r.code}`
  return Object.assign(new Error(`${[cmd, ...args].join(' ').replace(/\r?\n/g, ' ')}: ${reason}`), { reason })
}

const isPullRequest = (value) => /\/pull\/\d+/.test(value) || /^\d+$/.test(value)
const shorten = (arg) => (arg.length > 60 ? `${arg.slice(0, 57)}...` : arg)

// Reads and writes throw on a nonzero exit, naming the command. Under dryRun a write only logs.
export function createGitHub({ run = defaultRun, dryRun = false, log = () => {}, cwd } = {}) {
  const exec = async (cmd, args) => {
    const r = await run(cmd, args, { cwd })
    if (r.code !== 0) throw commandError(cmd, args, r)
    return r.stdout
  }
  const readJson = async (cmd, args) => {
    const out = await exec(cmd, args)
    try { return JSON.parse(out) } catch (e) { throw new Error(`${cmd} ${args.join(' ')}: output is not valid JSON (${e.message})`) }
  }
  const write = async (cmd, args) => {
    if (dryRun) return log(`dry run, skipped: ${[cmd, ...args.map(shorten)].join(' ')}`)
    await exec(cmd, args)
  }
  // A number from GitHub reaches reasons and result lines: a read refuses an answer with a bad one.
  const isNumber = (n) => Number.isInteger(n) && n > 0
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  const malformed = (command) => { throw new Error(`${command} returned a malformed answer`) }

  // gh pr list and git ls-remote are read at most once per run.
  let prs
  let heads

  const gh = {
    async issueView(n) {
      const v = await readJson('gh', ['issue', 'view', String(n), '--json', 'body,comments,labels,number,state,stateReason,title'])
      return isObject(v) && isNumber(v.number) && Array.isArray(v.labels) && Array.isArray(v.comments) ? v : malformed('gh issue view')
    },
    async issueList(label) {
      const rows = await readJson('gh', ['issue', 'list', '--state', 'open', '--label', label, '--limit', '100', '--json', 'number'])
      return (Array.isArray(rows) && rows.every((r) => isNumber(r?.number)) ? rows : malformed('gh issue list')).map((r) => r.number).sort((a, b) => a - b)
    },
    prList() {
      const ok = (p) => isObject(p) && isNumber(p.number) && Array.isArray(p.closingIssuesReferences)
      prs ??= readJson('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'closingIssuesReferences,headRefName,isDraft,number,url']).then((list) =>
        Array.isArray(list) && list.every(ok) ? list : malformed('gh pr list')
      )
      return prs
    },
    async prComments(pr) {
      const v = await readJson('gh', ['pr', 'view', String(pr), '--json', 'comments'])
      return isObject(v) && Array.isArray(v.comments) ? v.comments : malformed('gh pr view')
    },
    // The PR's number, its head commit and the issues it closes, as GitHub lists them.
    async prView(pr) {
      const v = await readJson('gh', ['pr', 'view', String(pr), '--json', 'closingIssuesReferences,headRefOid,number'])
      return isObject(v) && isNumber(v.number) && typeof v.headRefOid === 'string' && Array.isArray(v.closingIssuesReferences) ? v : malformed('gh pr view')
    },
    async prPaths(pr) {
      return (await exec('gh', ['pr', 'diff', String(pr), '--name-only'])).split('\n').filter(Boolean)
    },
    remoteHeads() {
      heads ??= exec('git', ['ls-remote', '--heads', 'origin']).then((out) => out.split('\n').map((l) => l.split('\t')[1]).filter(Boolean))
      return heads
    },

    createLabel: ({ name, color, description }) => write('gh', ['label', 'create', name, '--color', color, '--description', description, '--force']),
    comment: (n, body) => write('gh', ['issue', 'comment', String(n), '--body', body]),
    addLabel: (n, label) => write('gh', ['issue', 'edit', String(n), '--add-label', label]),
    removeLabel: (n, label) => write('gh', ['issue', 'edit', String(n), '--remove-label', label]),
    prComment: (pr, body) => write('gh', ['pr', 'comment', String(pr), '--body', body]),
    prReady: (pr) => write('gh', ['pr', 'ready', String(pr)]),
    // The merge gate: orchestrai/review is the one status the driver posts. gh fills {owner}/{repo}.
    postStatus: (sha, description) =>
      write('gh', ['api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`, '-f', 'state=success', '-f', 'context=orchestrai/review', '-f', `description=${description}`]),

    // The reason on the issue, needs-human on, in-progress off only when it is set.
    async park(n, reason, { inProgress = false, details } = {}) {
      await gh.comment(n, `Parked: ${reason}${details ? `\n\n${quote(details)}` : ''}`)
      await gh.addLabel(n, 'needs-human')
      if (inProgress) await gh.removeLabel(n, 'in-progress')
    },
  }
  return gh
}

const SIZES = ['size:XL', 'size:L', 'size:M', 'size:S']

// The plan is the issue's Approach section, in the body or in a lead's comment.
const hasApproach = (issue) => [issue.body, ...issue.comments.map((c) => c.body)].some((b) => /^##[ \t]+Approach\b/m.test(String(b || '')))

// One gate entry per issue: { issue, size, outcome, detail, blockers, inProgress, title, resume? }.
// The first matching rule decides the outcome; unmerged blockers turn a run or resume into a wait. Reads only.
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
  const names = issue.labels.map((l) => l.name)
  const size = SIZES.find((s) => names.includes(s)) || 'unsized'
  const inProgress = names.includes('in-progress')
  const entry = (outcome, detail, extra = {}) => ({ issue: n, size, outcome, detail, blockers: [], inProgress, title: issue.title, ...extra })

  if (issue.state === 'CLOSED') return entry('skip', 'closed')
  if (names.includes('needs-human')) return entry('skip', "labeled needs-human, resuming it is the user's call")
  if (size === 'size:L' || size === 'size:XL') return entry('stop', `${size}, split it first`)
  if (size === 'unsized') return entry('park', 'no size label, not guessing a size')

  const prs = (await gh.prList()).filter((p) => p.closingIssuesReferences.some((r) => r?.number === n))
  const highest = (list) => list.reduce((best, p) => (!best || p.number > best.number ? p : best), null)
  const ready = highest(prs.filter((p) => !p.isDraft))
  if (ready) return entry('complete', `PR #${ready.number} is ready, awaiting merge`, { pr: ready.number })

  let result
  const draft = highest(prs.filter((p) => p.isDraft))
  if (draft) {
    const comments = await gh.prComments(draft.number)
    const stage = resumeStage(comments, { hasPr: true })
    const resume = { stage, branch: draft.headRefName, pr: draft.number, fixRounds: countFixRounds(comments) }
    if (stage === 'fix') resume.findings = String(latestReview(comments).body)
    result = entry('resume', `draft PR #${draft.number}, resuming at ${stage}`, { resume })
  } else {
    const branchRef = inProgress && (await gh.remoteHeads()).find((r) => new RegExp(`^refs/heads/[^/]+/${n}-`).test(r))
    if (branchRef) {
      const branch = branchRef.slice('refs/heads/'.length)
      result = entry('resume', `branch ${branch} on origin, no PR, resuming at the developer`, { resume: { stage: 'develop', branch } })
    } else if (!hasApproach(issue)) {
      return entry('park', 'no ## Approach section in the issue or its comments, add one and remove needs-human')
    } else {
      result = entry('run', inProgress ? 'in-progress but no PR and no branch, starting at the developer' : 'no PR yet, starting at the developer')
    }
  }

  const unmerged = []
  for (const b of parseBlockers(issue.body)) {
    const blocker = await view(b)
    if (!(blocker.state === 'CLOSED' && blocker.stateReason === 'COMPLETED')) unmerged.push(b)
  }
  return unmerged.length > 0
    ? { ...result, outcome: 'wait', detail: `blocked by ${unmerged.map((b) => `#${b}`).join(', ')}`, blockers: unmerged }
    : result
}

// The detail can hold a branch name from origin, which is free text, so it is one line.
export const formatGateLine = (e) => `#${e.issue} ${e.size} ${e.outcome}: ${oneLine(e.detail)}`

// What happened to each gate entry, in gate order, and the next steps. Text is one line after a fixed prefix.
export function formatReport(entries, results = []) {
  const byIssue = new Map(results.map((r) => [r.issue, r]))
  const happened = []
  const merge = []
  const decide = []
  let deferred = false
  const pr = (n, title) => (merge.push(`#${n}`), `PR #${n} ready  - ${oneLine(title)}`)
  const bad = (n, text) => (decide.push(`#${n}`), `#${n} ${text}`)
  for (const e of entries) {
    const r = e.outcome === 'run' || e.outcome === 'resume' ? byIssue.get(e.issue) : undefined
    const d = oneLine(e.detail)
    if (e.outcome === 'complete') happened.push(pr(e.pr, e.title))
    else if (e.outcome === 'park') happened.push(bad(e.issue, `parked (needs-human): ${d}`))
    else if (e.outcome === 'stop') happened.push(`#${e.issue} stopped: ${d}`)
    else if (e.outcome === 'skip') happened.push(`#${e.issue} skipped: ${d}`)
    else if (e.outcome === 'wait') (deferred = true), happened.push(`#${e.issue} deferred: ${d}`)
    else if (r?.error !== undefined) happened.push(bad(e.issue, `error: ${oneLine(r.error)}`))
    else if (r) happened.push(r.done ? pr(r.prNumber, e.title) : bad(e.issue, `parked (needs-human): ${oneLine(r.parked)}`))
  }
  const steps = []
  if (merge.length > 0) steps.push(`Review & merge: ${merge.join(', ')}`)
  if (decide.length > 0) steps.push(`Decide on ${decide.join(', ')} (retry or close)`)
  if (deferred) steps.push('Run the driver again to start the next wave')
  if (steps.length === 0) steps.push('Nothing to do')
  return ['## What happened', ...happened.map((h) => `- ${h}`), '', '## Next steps', ...steps.map((step, k) => `${k + 1}. ${step}`)]
}

/**
 * main(argv, { env, run, spawn, out, err, cwd }) -> exit code. 0: the run
 * finished, whatever the outcomes. 1: a gh or git call failed at the gate, or a
 * package threw. 2: a usage error, before any GitHub call. stdout carries the
 * gate, the wave plan and the results; the rest goes to stderr.
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
    for (const item of parsed.items) numbers.push(...(item.issue !== undefined ? [item.issue] : await gh.issueList(item.label)))
    const entries = await runGate([...new Set(numbers)], gh)
    for (const e of entries) if (e.outcome === 'park') await gh.park(e.issue, e.detail, { inProgress: e.inProgress })

    const { waves, waiting } = planWaves(entries)
    entries.forEach((e) => out(formatGateLine(e)))
    waves.forEach((w, k) => out(`wave ${k + 1}: ${w.map((n) => `#${n}`).join(' ')}`))
    for (const w of waiting) out(`waiting: #${w.issue} (blocked by ${w.blockers.map((b) => `#${b}`).join(', ')})`)

    if (dryRun) return 0

    // Only wave 1 runs: the driver never merges, so a later wave's blocker stays open this run.
    const packages = entries
      .filter((e) => waves[0]?.includes(e.issue))
      .map(({ issue, resume, title, inProgress, size }) => ({ issue, resume, title, inProgress, size }))
    const results = packages.length > 0 ? await runWave(packages, { dryRun: false, run, spawn: spawnSeat, log: err, repoRoot: cwd }) : []
    for (const r of results) {
      out(r.error !== undefined ? `#${r.issue} error: ${r.error}` : r.done ? `#${r.issue} done: PR ${r.pr}` : `#${r.issue} parked: ${r.parked}`)
    }
    if (entries.length > 0) formatReport(entries, results).forEach((line) => out(line))
    return results.some((r) => r.error !== undefined) ? 1 : 0
  } catch (e) {
    err(firstLine(e?.message || e))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
