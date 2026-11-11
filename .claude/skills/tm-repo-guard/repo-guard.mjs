#!/usr/bin/env node
/**
 * tm-repo-guard (issues #472 and #481, batches #470 and #480).
 *
 * Check reads the GitHub state of every repo the user owns and prints one
 * state per repo: set up, not set up, or blocked. It only reads. Every read
 * goes through `guarded()`, which refuses anything outside a small allowlist,
 * so a future edit cannot quietly add a write.
 *
 * Apply changes one repo, and only after the owner confirms. Its two writes
 * go through `writeGuarded()`, a separate fence that accepts exactly the
 * branch protection PUT and the repo PATCH, with bodies it validates. The read
 * guard is never loosened for them.
 *
 * Statuses (issue #501) prints the commands that record both verdict statuses
 * on a PR head and queue its merge, for the owner to run in their own shell.
 * It makes four reads through `guarded()` and never writes.
 *
 * Usage: node repo-guard.mjs                           Check
 *        node repo-guard.mjs apply <repo>              plan: prints changes and a token
 *        node repo-guard.mjs apply <repo> --confirm T  writes, when T matches the plan
 *        node repo-guard.mjs statuses <repo> <pr>      prints the commands
 * Exit:  Check: 0 when every repo was read, 1 when any repo could not be read.
 *        Apply: 0 done or nothing to change, 1 read or write failed,
 *        2 usage error, refusal or token mismatch.
 *        Statuses: 0 commands printed, 1 a read failed, 2 usage error or refusal.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

const API_FLAGS = new Set(['--paginate', '--slurp'])
const PR_LIST_FLAGS = new Set(['--repo', '--state', '--limit', '--json'])

// An allowlist, not a denylist: `gh api` turns into a POST when it is given
// -f or -F, so blocking `-X` alone would miss writes.
export function isReadOnly(args) {
  if (!Array.isArray(args)) return false

  if (args[0] === 'api') {
    const rest = args.slice(1)
    const positional = rest.filter((a) => !a.startsWith('-'))
    const flags = rest.filter((a) => a.startsWith('-'))
    if (!flags.every((f) => API_FLAGS.has(f))) return false
    if (positional.length !== 1) return false
    return !/^\/?graphql\b/.test(positional[0])
  }

  if (args[0] === 'pr' && args[1] === 'list') {
    const rest = args.slice(2)
    if (rest.length === 0 || rest.length % 2 !== 0) return false
    for (let i = 0; i < rest.length; i += 2) {
      if (!PR_LIST_FLAGS.has(rest[i])) return false
      if (rest[i + 1].startsWith('-')) return false
    }
    return true
  }

  return false
}

// The guard sits above the injected runner, so a fake runner in a test still
// goes through it.
export function guarded(run) {
  return (args) => {
    if (!isReadOnly(args)) throw new Error(`refusing a call that is not read-only: gh ${args.join(' ')}`)
    return run(args)
  }
}

function ghRunner(args, input) {
  const res = spawnSync('gh', args, {
    encoding: 'utf8',
    // Stdin is closed so gh cannot stall waiting on it (#467). Only a write
    // passes input, and node closes the pipe once it has written it.
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  })
  if (res.error) throw new Error(`could not run gh: ${res.error.message}`)
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// Write fence (Apply only)
// ---------------------------------------------------------------------------

const CARRIED = [
  'required_linear_history',
  'required_conversation_resolution',
  'block_creations',
  'lock_branch',
  'allow_fork_syncing',
]
const PUT_KEYS = [
  'required_status_checks',
  'enforce_admins',
  'required_pull_request_reviews',
  'restrictions',
  'allow_force_pushes',
  'allow_deletions',
  ...CARRIED,
]
const REVIEW_KEYS = [
  'required_approving_review_count',
  'require_code_owner_reviews',
  'require_last_push_approval',
  'dismiss_stale_reviews',
]
const PATCH_KEYS = ['allow_auto_merge', 'allow_squash_merge']

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hasExactKeys = (obj, keys) => {
  const have = Object.keys(obj).sort()
  return have.length === keys.length && [...keys].sort().every((k, i) => k === have[i])
}

function protectionPath(target) {
  return `repos/${target.repo}/branches/${encodeURIComponent(target.branch)}/protection`
}

function validProtectionBody(b) {
  if (!isObject(b) || !hasExactKeys(b, PUT_KEYS)) return false
  const rsc = b.required_status_checks
  const rpr = b.required_pull_request_reviews
  return (
    isObject(rsc) &&
    hasExactKeys(rsc, ['strict', 'contexts']) &&
    rsc.strict === true &&
    Array.isArray(rsc.contexts) &&
    rsc.contexts.every((c) => typeof c === 'string' && c !== '') &&
    b.enforce_admins === true &&
    isObject(rpr) &&
    hasExactKeys(rpr, REVIEW_KEYS) &&
    rpr.required_approving_review_count === 0 &&
    rpr.require_code_owner_reviews === false &&
    rpr.require_last_push_approval === false &&
    typeof rpr.dismiss_stale_reviews === 'boolean' &&
    b.restrictions === null &&
    b.allow_force_pushes === false &&
    b.allow_deletions === false &&
    CARRIED.every((k) => typeof b[k] === 'boolean')
  )
}

// The repo PATCH endpoint can also rename, archive and change visibility, so
// the body is what is checked here, not just the path.
function validRepoPatch(b) {
  if (!isObject(b)) return false
  const keys = Object.keys(b)
  return keys.length > 0 && keys.every((k) => PATCH_KEYS.includes(k) && b[k] === true)
}

export function writeArgs(op) {
  return ['api', '-X', op.method, op.path, '--input', '-']
}

// An allowlist of exactly two calls. Everything else is refused.
export function isAllowedWrite(args, input, target) {
  if (!Array.isArray(args) || args.length !== 6) return false
  const [cmd, flag, method, path, inputFlag, dash] = args
  if (cmd !== 'api' || flag !== '-X' || inputFlag !== '--input' || dash !== '-') return false
  if (method === 'PUT') return path === protectionPath(target) && validProtectionBody(input)
  if (method === 'PATCH') return path === `repos/${target.repo}` && validRepoPatch(input)
  return false
}

export function writeGuarded(run, target) {
  return (args, input) => {
    if (!isAllowedWrite(args, input, target)) {
      throw new Error(`refusing a call that is not an allowed write: gh ${args.join(' ')}`)
    }
    return run(args, JSON.stringify(input))
  }
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function selectRepos(repos, login) {
  return repos.filter((r) => r.owner?.login === login && !r.archived)
}

export function prCheckNames(prs) {
  const names = new Set()
  for (const pr of prs) {
    for (const item of pr.statusCheckRollup ?? []) {
      if (item.__typename === 'StatusContext' || (item.context && !item.name)) {
        // orchestrai/* contexts are agent verdicts, not CI.
        if (item.context && !item.context.startsWith('orchestrai/')) names.add(item.context)
      } else if (item.name && item.conclusion !== 'SKIPPED') {
        names.add(item.name)
      }
    }
  }
  return [...names].sort()
}

const isStatusContext = (item) => item.__typename === 'StatusContext' || (item.context && !item.name)
const isVerdict = (item) => typeof item.context === 'string' && item.context.startsWith('orchestrai/')

// A check that has finished, pass or fail. A run still going, or a status that
// is pending, says nothing yet about whether the check really runs.
function isCompleted(item) {
  if (isStatusContext(item)) return ['SUCCESS', 'FAILURE', 'ERROR'].includes(item.state)
  return item.status === 'COMPLETED'
}

// The checks the newest finished PR ran. That PR, not the last ten together,
// says what runs today, so a retired check does not stay required for good.
export function newestChecks(prs) {
  const byNumber = [...prs].sort((a, b) => b.number - a.number)
  for (const pr of byNumber) {
    if (pr.isDraft === true) continue
    const ci = (pr.statusCheckRollup ?? []).filter((item) => !isVerdict(item))
    if (ci.length === 0 || !ci.every(isCompleted)) continue
    const names = [
      ...new Set(ci.filter((i) => i.conclusion !== 'SKIPPED').map((i) => (isStatusContext(i) ? i.context : i.name))),
    ].sort()
    if (names.length > 0) return { pr: pr.number, names }
  }
  return { pr: null, names: [] }
}

// gh exits 1 on an HTTP error but still writes the JSON body to stdout.
function parseError({ stdout, stderr }) {
  let body = null
  try {
    body = JSON.parse(stdout)
  } catch {
    // fall through to stderr
  }
  const status = body && body.status != null ? Number(body.status) : null
  const message =
    (body && typeof body.message === 'string' && body.message) ||
    (stderr ?? '').trim() ||
    (stdout ?? '').trim() ||
    'unknown error'
  return { status, message }
}

export function classifyProtection({ code, stdout, stderr }) {
  if (code === 0) {
    const body = JSON.parse(stdout)
    const rsc = body.required_status_checks ?? {}
    const requiredChecks = [
      ...new Set([...(rsc.contexts ?? []), ...(rsc.checks ?? []).map((c) => c.context)]),
    ].sort()
    const rpr = body.required_pull_request_reviews
    const on = (key) => body[key]?.enabled === true
    return {
      kind: 'present',
      requiredChecks,
      prRequired: rpr != null,
      forcePushesOff: body.allow_force_pushes?.enabled !== true,
      enforceAdmins: body.enforce_admins?.enabled === true,
      // Comes back in the GET but cannot go in the PUT body.
      signaturesRequired: body.required_signatures?.enabled === true,
      strict: body.required_status_checks?.strict === true,
      deletionsOff: body.allow_deletions?.enabled !== true,
      noApprovalNeeded:
        (rpr?.required_approving_review_count ?? 0) === 0 &&
        rpr?.require_code_owner_reviews !== true &&
        rpr?.require_last_push_approval !== true,
      // The PUT replaces the whole rule, so Apply copies what it does not manage.
      carry: {
        required_linear_history: on('required_linear_history'),
        required_conversation_resolution: on('required_conversation_resolution'),
        block_creations: on('block_creations'),
        lock_branch: on('lock_branch'),
        allow_fork_syncing: on('allow_fork_syncing'),
        dismiss_stale_reviews: rpr?.dismiss_stale_reviews === true,
      },
    }
  }
  const { status, message } = parseError({ stdout, stderr })
  if (status === 404 && /^Branch not (protected|found)$/i.test(message)) return { kind: 'none' }
  if (status === 403 && /upgrade to github pro|make this repository public/i.test(message)) {
    return { kind: 'unavailable', message }
  }
  return { kind: 'error', message }
}

const TEST_FILE_PATTERNS = [
  /^.+\.test\..+$/,
  /^.+\.spec\..+$/,
  /^test_.+\.py$/,
  /^.+_test\.py$/,
  /^.+_test\.go$/,
  // Some repos name Swift tests FooTests.swift, so the plural matters.
  /^.+Tests?\.(swift|kt|java|cs)$/,
  /^.+_spec\.rb$/,
]

export function countTestFiles(paths) {
  let n = 0
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (TEST_FILE_PATTERNS.some((re) => re.test(name))) n++
  }
  return n
}

export function hasPipelineLabels(names) {
  return names.includes('in-progress') && names.includes('needs-human')
}

const VERDICT_CHECKS = ['orchestrai/review', 'orchestrai/test']

const BLOCKED_REASON = 'branch protection is not available on the current plan'

// Decides for both Check and Apply: one rule, so Check can never call a repo
// set up while Apply would still change it.
export function planChanges(facts) {
  const { protection } = facts
  const ci = facts.ciChecks.length > 0
  const verdicts = facts.pipelineLabels === true
  const layers = ['base', ...(ci ? ['ci'] : []), ...(verdicts ? ['verdicts'] : [])]
  const requiredChecks = [...new Set([...facts.ciChecks, ...(verdicts ? VERDICT_CHECKS : [])])].sort()
  // Only names from PRs older than the deciding one: a name on a newer PR that is
  // still running or a draft has not stopped running, it has not finished yet.
  const notRequired = facts.olderCheckNames.filter((n) => !facts.ciChecks.includes(n)).sort()

  const blocked = protection.kind === 'unavailable' ? BLOCKED_REASON : null
  const needsCi = facts.testFileCount > 0 && !ci

  const changes = []
  if (protection.kind === 'none' || protection.kind === 'present') {
    // No protection reads as every item off.
    const p = protection.kind === 'present' ? protection : null
    const have = p?.requiredChecks ?? []
    if (!p) changes.push('branch protection')
    if (!p || !p.prRequired) changes.push('PR required')
    if (p?.prRequired && !p.noApprovalNeeded) changes.push('no approving review required')
    if (!p || !p.forcePushesOff) changes.push('force pushes off')
    if (!p || !p.deletionsOff) changes.push('deletion off')
    if (!p || !p.enforceAdmins) changes.push('applies to admins')
    if (!p || !p.strict) changes.push('up to date required')
    for (const name of requiredChecks) if (!have.includes(name)) changes.push(`required check: ${name}`)
    for (const name of have) if (!requiredChecks.includes(name)) changes.push(`stop requiring: ${name}`)
  }
  if (!facts.allowAutoMerge) changes.push('auto merge on')
  if (!facts.allowSquashMerge) changes.push('squash merge allowed')

  const flags = []
  if (facts.testFileCount === 0 && !facts.testFilesTruncated) {
    flags.push(ci ? 'no tests, short track off' : 'agent verdicts only, short track off')
  }

  return { blocked, needsCi, changes, requiredChecks, notRequired, layers, flags }
}

export function evaluate(facts) {
  const plan = planChanges(facts)
  const missing = plan.needsCi ? [...plan.changes, 'needs CI first'] : plan.changes
  const base = { missing, flags: plan.flags, layers: plan.layers, notRequired: plan.notRequired }
  if (plan.blocked) return { state: 'blocked', reason: plan.blocked, ...base }
  return { state: missing.length > 0 ? 'not set up' : 'set up', ...base }
}

const CARRY_OFF = Object.fromEntries([...CARRIED, 'dismiss_stale_reviews'].map((k) => [k, false]))
const REPO_CHANGES = ['auto merge on', 'squash merge allowed']

// The writes that bring a repo to the plan: 0, 1 or 2, protection first. If the
// PATCH fails the repo is protected with auto merge still off, which the ship
// decision already treats as not set up.
export function buildWrites(target, facts) {
  const plan = planChanges(facts)
  const protectionChanges = plan.changes.filter((c) => !REPO_CHANGES.includes(c))
  const ops = []

  if (protectionChanges.length > 0) {
    const carry = (facts.protection.kind === 'present' && facts.protection.carry) || CARRY_OFF
    ops.push({
      method: 'PUT',
      path: protectionPath(target),
      body: {
        required_status_checks: { strict: true, contexts: plan.requiredChecks },
        enforce_admins: true,
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          require_code_owner_reviews: false,
          require_last_push_approval: false,
          dismiss_stale_reviews: carry.dismiss_stale_reviews === true,
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
        ...Object.fromEntries(CARRIED.map((k) => [k, carry[k] === true])),
      },
    })
  }

  const patch = {}
  if (!facts.allowAutoMerge) patch.allow_auto_merge = true
  if (!facts.allowSquashMerge) patch.allow_squash_merge = true
  if (Object.keys(patch).length > 0) ops.push({ method: 'PATCH', path: `repos/${target.repo}`, body: patch })

  return ops
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// Covers the exact bodies, so a confirm run can only write the plan that was
// shown. Any change in between (a new PR, a setting flipped by hand) changes it.
export function confirmToken(target, ops) {
  const text = canonical({ repo: target.repo, branch: target.branch, ops })
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function parseOk(res, what) {
  if (res.code !== 0) throw new Error(`${what}: ${parseError(res).message}`)
  return JSON.parse(res.stdout)
}

function readRepo(call, fullName) {
  return parseOk(call(['api', `repos/${fullName}`]), 'repo')
}

function gatherFacts(call, info, requested) {
  // The response's own name is the one later calls and writes use.
  const fullName = info.full_name ?? requested
  const branch = encodeURIComponent(info.default_branch)

  const protection = classifyProtection(call(['api', `repos/${fullName}/branches/${branch}/protection`]))
  if (protection.kind === 'error') throw new Error(`branch protection: ${protection.message}`)

  const prs = parseOk(
    call(['pr', 'list', '--repo', fullName, '--state', 'all', '--limit', '10', '--json', 'number,isDraft,statusCheckRollup']),
    'pull requests'
  )

  const treeRes = call(['api', `repos/${fullName}/git/trees/${branch}?recursive=1`])
  let testFileCount = 0
  let testFilesTruncated = false
  if (treeRes.code === 0) {
    const tree = JSON.parse(treeRes.stdout)
    testFileCount = countTestFiles((tree.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path))
    testFilesTruncated = tree.truncated === true
  } else if (parseError(treeRes).status !== 409) {
    // 409 is an empty repo, which has no files to count.
    throw new Error(`file tree: ${parseError(treeRes).message}`)
  }

  const labelPages = parseOk(
    call(['api', '--paginate', '--slurp', `repos/${fullName}/labels?per_page=100`]),
    'labels'
  )

  const deciding = newestChecks(prs)
  const older = deciding.pr === null ? [] : prs.filter((p) => p.number < deciding.pr)

  return {
    fullName,
    defaultBranch: info.default_branch,
    visibility: info.private ? 'private' : 'public',
    allowAutoMerge: info.allow_auto_merge === true,
    allowSquashMerge: info.allow_squash_merge === true,
    protection,
    prCount: prs.length,
    prCheckNames: prCheckNames(prs),
    olderCheckNames: prCheckNames(older),
    ciChecks: deciding.names,
    testFileCount,
    testFilesTruncated,
    pipelineLabels: hasPipelineLabels(labelPages.flat().map((l) => l.name)),
  }
}

export function collect(run) {
  const call = guarded(run)

  const login = parseOk(call(['api', 'user']), 'user').login
  const pages = parseOk(
    call(['api', '--paginate', '--slurp', 'user/repos?affiliation=owner&per_page=100']),
    'repo list'
  )
  const repos = selectRepos(pages.flat(), login)

  const entries = repos.map((r) => {
    try {
      const facts = gatherFacts(call, readRepo(call, r.full_name), r.full_name)
      return { repo: r.full_name, facts, result: evaluate(facts) }
    } catch (err) {
      return { repo: r.full_name, error: err.message }
    }
  })
  return { login, entries }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const PROTECTION_LABELS = {
  present: 'present',
  none: 'none',
  unavailable: 'not available on the current plan',
}

export function render({ login, entries }) {
  const count = (state) => entries.filter((e) => e.result?.state === state).length
  const unreadable = entries.filter((e) => e.error !== undefined).length
  const lines = [
    `repo-guard for ${login}: ${entries.length} repos (${count('set up')} set up, ${count('not set up')} not set up, ${count('blocked')} blocked, ${unreadable} could not read)`,
  ]

  for (const e of entries) {
    lines.push('')
    if (e.error !== undefined) {
      lines.push(`${e.repo}: could not read: ${e.error}`)
      continue
    }
    const { facts, result } = e
    lines.push(`${e.repo}: ${result.state}`)
    lines.push(`  visibility: ${facts.visibility}`)
    lines.push(`  protection: ${PROTECTION_LABELS[facts.protection.kind]}`)
    lines.push(`  auto merge: ${facts.allowAutoMerge ? 'on' : 'off'}`)
    lines.push(`  squash merge: ${facts.allowSquashMerge ? 'allowed' : 'not allowed'}`)
    if (facts.protection.kind !== 'unavailable') {
      const p = facts.protection.kind === 'present' ? facts.protection : {}
      lines.push(`  applies to admins: ${p.enforceAdmins ? 'yes' : 'no'}`)
      lines.push(`  up to date required: ${p.strict ? 'yes' : 'no'}`)
    }
    const required = facts.protection.kind === 'present' ? facts.protection.requiredChecks : []
    lines.push(`  required checks: ${required.length > 0 ? required.join(', ') : 'none'}`)
    lines.push(`  pipeline labels: ${facts.pipelineLabels ? 'yes' : 'no'}`)
    lines.push(`  layers: ${result.layers.join(', ')}`)
    if (result.reason) lines.push(`  blocked: ${result.reason}`)
    if (result.missing.length > 0) lines.push(`  missing: ${result.missing.join(', ')}`)
    if (result.notRequired?.length > 0) lines.push(`  not required: no longer runs: ${result.notRequired.join(', ')}`)
    const names = facts.prCheckNames.length > 0 ? facts.prCheckNames.join(', ') : 'none'
    lines.push(`  PR checks (${facts.prCount} PR${facts.prCount === 1 ? '' : 's'} read): ${names}`)
    lines.push(`  test files: ${facts.testFilesTruncated ? 'at least ' : ''}${facts.testFileCount}`)
    for (const flag of result.flags) lines.push(`  flag: ${flag}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const NAME_PART = /^[A-Za-z0-9_.-]+$/
const validPart = (p) => NAME_PART.test(p) && !p.startsWith('-') && !p.startsWith('.')

const USAGE = 'usage: repo-guard.mjs apply <repo> [--confirm <token>]'

function parseApplyArgs(argv) {
  let confirm = null
  const repos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--confirm') {
      const value = argv[i + 1]
      if (confirm !== null || value === undefined || value.startsWith('-')) return { error: `${USAGE} (--confirm needs one token)` }
      confirm = value
      i++
    } else if (a.startsWith('-')) {
      return { error: `${USAGE} (unknown option ${a})` }
    } else {
      repos.push(a)
    }
  }
  if (repos.length !== 1) return { error: `${USAGE} (name exactly one repo)` }

  const parts = repos[0].split('/')
  if (parts.length > 2 || !parts.every(validPart)) return { error: `refusing: invalid repo name: ${repos[0]}` }
  return { confirm, owner: parts.length === 2 ? parts[0] : null, name: parts[parts.length - 1] }
}

const refusal = (message) => ({ code: 2, text: `refusing: ${message}\nnothing written\n` })
const readFailure = (message) => ({ code: 1, text: `could not read: ${message}\nnothing written\n` })

function planText(target, plan, ops, token) {
  const lines = [`${target.repo}: not set up (default branch ${target.branch})`, 'changes:']
  for (const c of plan.changes) lines.push(`  ${c}`)
  lines.push(`required checks after apply: ${plan.requiredChecks.length > 0 ? plan.requiredChecks.join(', ') : 'none'}`)
  if (plan.notRequired.length > 0) lines.push(`not required: no longer runs: ${plan.notRequired.join(', ')}`)
  lines.push('writes:')
  for (const op of ops) lines.push(`  ${op.method} ${op.path}`)
  lines.push(`confirm token: ${token}`)
  return lines.join('\n') + '\n'
}

export function runApply(run, argv) {
  const args = parseApplyArgs(argv)
  if (args.error) return { code: 2, text: `${args.error}\n` }

  const call = guarded(run)
  let login
  try {
    login = parseOk(call(['api', 'user']), 'user').login
  } catch (err) {
    return readFailure(err.message)
  }
  if (args.owner !== null && args.owner.toLowerCase() !== login.toLowerCase()) {
    return refusal(`owner ${args.owner} is not your own account (${login})`)
  }

  const requested = `${login}/${args.name}`
  let facts
  try {
    const info = readRepo(call, requested)
    if (info.owner?.type !== 'User') return refusal(`${requested} is owned by an organization or an unknown owner type, not a user`)
    if (info.owner?.login?.toLowerCase() !== login.toLowerCase()) return refusal(`the repo owner is ${info.owner?.login}, not ${login}`)
    if (info.archived === true) return refusal(`${requested} is archived`)
    facts = gatherFacts(call, info, requested)
  } catch (err) {
    return readFailure(err.message)
  }

  const target = { repo: facts.fullName, branch: facts.defaultBranch }
  const plan = planChanges(facts)
  if (plan.blocked) return refusal(`${target.repo} is blocked: ${plan.blocked}`)
  if (plan.needsCi) return refusal(`${target.repo} needs CI first: it has test files but no finished, non-draft PR has run a check`)
  if (plan.changes.length === 0) return { code: 0, text: `${target.repo}: set up, nothing to change\n` }

  const ops = buildWrites(target, facts)
  if (facts.protection.signaturesRequired && ops.some((o) => o.method === 'PUT')) {
    return refusal(`${target.repo} requires signed commits, and the protection PUT may reset that`)
  }
  const token = confirmToken(target, ops)
  if (args.confirm === null) return { code: 0, text: planText(target, plan, ops, token) }
  if (args.confirm !== token) return { code: 2, text: 'plan changed since it was shown, nothing written\n' }

  const write = writeGuarded(run, target)
  const lines = []
  let failed = false
  for (const op of ops) {
    let res
    try {
      res = write(writeArgs(op), op.body)
    } catch (err) {
      res = { code: 1, stdout: '', stderr: err.message }
    }
    if (res.code !== 0) {
      lines.push(`write failed: ${op.method} ${op.path}: ${parseError(res).message}`)
      lines.push('stopped here, no further writes were attempted')
      failed = true
      break
    }
    lines.push(`wrote: ${op.method} ${op.path}`)
  }

  // Re-read through the read guard so the printed state is what GitHub holds.
  try {
    const after = gatherFacts(call, readRepo(call, target.repo), target.repo)
    const result = evaluate(after)
    lines.push(render({ login, entries: [{ repo: target.repo, facts: after, result }] }).trimEnd())
    return { code: !failed && result.state === 'set up' ? 0 : 1, text: lines.join('\n') + '\n' }
  } catch (err) {
    lines.push(`could not re-read the repo: ${err.message}`)
    return { code: 1, text: lines.join('\n') + '\n' }
  }
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

const STATUSES_USAGE = 'usage: repo-guard.mjs statuses <repo> <pr>'
const PR_NUMBER = /^[1-9][0-9]*$/
const HEAD_SHA = /^[0-9a-f]{40}$/

// Start with "by hand: " so a status the owner posted is plain on the commit.
// None of them matches a description the pipeline writes.
const HAND_TEST = 'by hand: owner verified'
const HAND_REVIEW = 'by hand: owner reviewed'

function parseStatusesArgs(argv) {
  if (argv.length !== 2 || argv.some((a) => a.startsWith('-')) || !PR_NUMBER.test(argv[1])) {
    return { error: STATUSES_USAGE }
  }
  const parts = argv[0].split('/')
  if (parts.length > 2 || !parts.every(validPart)) return { error: `refusing: invalid repo name: ${argv[0]}` }
  return { typed: argv[0], owner: parts.length === 2 ? parts[0] : null, name: parts[parts.length - 1], pr: argv[1] }
}

// Prints the commands that record both verdicts and queue the merge. It only
// reads, and the owner runs what it prints. It never builds `writeGuarded`.
export function runStatuses(run, argv) {
  const args = parseStatusesArgs(argv)
  if (args.error) return { code: 2, text: `${args.error}\n` }

  const refuse = (message) => ({ code: 2, text: `refusing: ${message}\n` })
  const notOwn = (repo, login) => refuse(`${repo} is not a repo of your own account (${login})`)
  const call = guarded(run)

  let login
  try {
    login = parseOk(call(['api', 'user']), 'user').login
  } catch (err) {
    return { code: 1, text: `could not read: ${err.message}\n` }
  }
  if (args.owner !== null && args.owner.toLowerCase() !== login.toLowerCase()) return notOwn(args.typed, login)

  const requested = `${login}/${args.name}`
  let full
  let pr
  let protection
  try {
    const info = readRepo(call, requested)
    if (info.owner?.type !== 'User' || info.owner?.login?.toLowerCase() !== login.toLowerCase()) {
      return notOwn(requested, login)
    }
    full = info.full_name ?? requested
    if (!full.split('/').every(validPart)) throw new Error(`repo: unexpected name ${full}`)

    pr = parseOk(call(['api', `repos/${full}/pulls/${args.pr}`]), 'pull request')
    // The head goes into the owner's shell, so it must be a plain 40-hex value.
    if (typeof pr.head?.sha !== 'string' || !HEAD_SHA.test(pr.head.sha)) {
      throw new Error('pull request: head is not a 40-character lowercase hex commit')
    }
    if (typeof pr.base?.ref !== 'string' || pr.base.ref === '') throw new Error('pull request: no base branch')
    if (pr.state !== 'open') return refuse(`${full} PR #${args.pr} is not open (${pr.merged === true ? 'merged' : 'closed'})`)

    protection = classifyProtection(call(['api', `repos/${full}/branches/${encodeURIComponent(pr.base.ref)}/protection`]))
    if (protection.kind === 'error') throw new Error(`protection: ${protection.message}`)
  } catch (err) {
    return { code: 1, text: `could not read: ${err.message}\n` }
  }

  if (protection.kind !== 'present' || !VERDICT_CHECKS.every((c) => protection.requiredChecks.includes(c))) {
    return refuse(`${full} does not require ${VERDICT_CHECKS.join(' and ')} on ${pr.base.ref}`)
  }

  const sha = pr.head.sha
  const status = (context, description) =>
    `gh api -X POST 'repos/${full}/statuses/${sha}' -f state=success -f context=${context} -f description='${description}'`
  const out = [
    `${full} PR #${args.pr}: head ${sha}`,
    'run these in your own shell:',
    status('orchestrai/test', HAND_TEST),
    status('orchestrai/review', HAND_REVIEW),
  ]
  if (pr.draft === true) out.push(`gh pr ready ${args.pr} --repo ${full}`)
  out.push(`gh pr merge ${args.pr} --repo ${full} --squash --auto --match-head-commit ${sha}`)
  return { code: 0, text: out.join('\n') + '\n' }
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 0) {
      const result = collect(ghRunner)
      process.stdout.write(render(result))
      if (result.entries.some((e) => e.error !== undefined)) process.exitCode = 1
    } else if (argv[0] === 'apply') {
      const out = runApply(ghRunner, argv.slice(1))
      process.stdout.write(out.text)
      process.exitCode = out.code
    } else if (argv[0] === 'statuses') {
      const out = runStatuses(ghRunner, argv.slice(1))
      process.stdout.write(out.text)
      process.exitCode = out.code
    } else {
      process.stderr.write(`repo-guard: unknown argument ${argv[0]}\n${USAGE}\n${STATUSES_USAGE}\n`)
      process.exitCode = 2
    }
  } catch (err) {
    process.stderr.write(`repo-guard: ${err.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main()
}
