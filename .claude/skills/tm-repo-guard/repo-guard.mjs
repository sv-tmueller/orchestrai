#!/usr/bin/env node
/**
 * tm-repo-guard (issues #472 and #481, batches #470 and #480).
 *
 * Check reads the GitHub state of every repo the user owns and prints one
 * state per repo: set up, not set up, or blocked. It only reads. Every read
 * goes through `guarded()`, which refuses anything outside a small allowlist,
 * so a future edit cannot quietly add a write.
 *
 * Check also prints one line per Claude Code config dir (issue #502): whether
 * the plugin is installed, whether auto update is on, and whether the installed
 * copy is the newest commit. The dir facts come from each dir's plugin files;
 * the newest commit is one more read through `guarded()`. Nothing is written.
 *
 * Apply changes one repo, and only after the owner confirms. Its writes go
 * through `writeGuarded()`, a separate fence that accepts exactly the branch
 * protection PUT, the repo PATCH, the create or update of the six workflow
 * labels and, on a repo that needs CI, the five CI setup writes (create the
 * `orchestrai/ci-setup` branch, put the workflow file, open the PR, merge it,
 * delete the branch), with bodies it validates. The read guard is never
 * loosened for them.
 *
 * Statuses (issue #501) prints the commands that record both verdict statuses
 * on a PR head and queue its merge, for the owner to run in their own shell.
 * It makes four reads through `guarded()` and never writes.
 *
 * Usage: node repo-guard.mjs                           Check
 *        node repo-guard.mjs apply <repo>              plan: prints changes and a token
 *        node repo-guard.mjs apply <repo> --confirm T  writes, when T matches the plan
 *        node repo-guard.mjs apply <repo> --install C --test C
 *                                                      plan with given CI commands (repo needs CI)
 *        node repo-guard.mjs statuses <repo> <pr>      prints the commands
 * Exit:  Check: 0 when every repo and config dir was read, 1 when any could not be.
 *        Apply: 0 done or nothing to change, 1 read or write failed, or on the
 *        CI path a check failed or 20 minutes passed without a result,
 *        2 usage error, refusal or token mismatch, or on the CI path a stop
 *        after writes that needs the owner to look again (the PR holds more
 *        than the planned file, or the merged PR ran other checks than the
 *        plan expected; the output then names what happened and, when there
 *        is something left to write, carries a new token).
 *        Statuses: 0 commands printed, 1 a read failed, 2 usage error or refusal.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
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

  // A local call: no network, no login, so it gives no extra GitHub access.
  if (args.length === 1 && args[0] === '--version') return true

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

// `gh api --slurp` came in gh 2.48, and the labels read uses it. Raise this
// if a read ever needs a newer flag.
const MIN_GH = { major: 2, minor: 48 }

// Check and Apply call this first, so an old gh fails with one line instead
// of a usage dump from the first read that needs a newer flag.
export function requireGh(call) {
  const res = call(['--version'])
  const m = res.code === 0 ? /^gh version (\d+)\.(\d+)\.(\d+)/.exec(res.stdout.split('\n')[0]) : null
  const need = `gh ${MIN_GH.major}.${MIN_GH.minor} or newer needed`
  if (m === null) throw new Error(`gh version unknown, ${need}`)
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major < MIN_GH.major || (major === MIN_GH.major && minor < MIN_GH.minor)) {
    throw new Error(`gh ${m[1]}.${m[2]}.${m[3]} found, ${need}`)
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

// The six workflow labels, with the values tm-new-project used. The fence
// accepts exactly these names, colors and descriptions, nothing else.
const LABELS = [
  { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
  { name: 'size:M', color: 'BFD4F2', description: '1 to 3 hours. Write a sub-plan first.' },
  { name: 'size:L', color: 'F9D0C4', description: '4 to 6 hours. Split or checkpoint.' },
  { name: 'size:XL', color: 'D93F0B', description: 'About 8 hours. Too big. Split it.' },
  { name: 'in-progress', color: 'FBCA04', description: 'Package dispatched by /kickoff; resume, do not restart.' },
  { name: 'needs-human', color: 'B60205', description: 'Agent loop exhausted or blocked; human decision needed.' },
]

// The CI setup PR (issue #561, spec sections 3.3 and 6). The commit message,
// the PR title and the PR body are fixed texts, so the fence can match them.
const CI_BRANCH = 'orchestrai/ci-setup'
const CI_FILE = '.github/workflows/ci.yml'
const CI_CHECK = 'tests'
const CI_MESSAGE = 'ci: add the tests workflow'
const CI_TITLE = 'ci: add the tests workflow'
const CI_BODY =
  'Added by /tm-repo-guard apply. The guard merges this PR once the tests check passes, then makes tests a required check.'
const HEAD_SHA = /^[0-9a-f]{40}$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hasExactKeys = (obj, keys) => {
  const have = Object.keys(obj).sort()
  return have.length === keys.length && [...keys].sort().every((k, i) => k === have[i])
}

function protectionPath(target) {
  return `repos/${target.repo}/branches/${encodeURIComponent(target.branch)}/protection`
}

const labelsPath = (target) => `repos/${target.repo}/labels`
const labelPath = (target, name) => `${labelsPath(target)}/${encodeURIComponent(name)}`

function validLabelCreate(b) {
  return (
    isObject(b) &&
    hasExactKeys(b, ['name', 'color', 'description']) &&
    LABELS.some((l) => l.name === b.name && l.color === b.color && l.description === b.description)
  )
}

// No `new_name` key, so an update can never rename a label.
function validLabelUpdate(b, target, path) {
  return (
    isObject(b) &&
    hasExactKeys(b, ['color', 'description']) &&
    LABELS.some((l) => path === labelPath(target, l.name) && l.color === b.color && l.description === b.description)
  )
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

// The CI setup context: `{ text, pr }`. Apply builds it on the CI path only;
// the normal path passes none, so every CI write is refused there. The fence
// checks the shape itself and never throws on a bad one.
const ciValid = (ci) => isObject(ci) && typeof ci.text === 'string'
const ciPrValid = (ci) =>
  ciValid(ci) &&
  isObject(ci.pr) &&
  Number.isSafeInteger(ci.pr.number) &&
  ci.pr.number > 0 &&
  typeof ci.pr.sha === 'string' &&
  HEAD_SHA.test(ci.pr.sha)

const ciRefsPath = (target) => `repos/${target.repo}/git/refs`
const ciBranchRefPath = (target) => `${ciRefsPath(target)}/heads/${CI_BRANCH}`
const ciFilePath = (target) => `repos/${target.repo}/contents/${CI_FILE}`
const pullsPath = (target) => `repos/${target.repo}/pulls`

function validCiRef(b) {
  return (
    isObject(b) &&
    hasExactKeys(b, ['ref', 'sha']) &&
    b.ref === `refs/heads/${CI_BRANCH}` &&
    typeof b.sha === 'string' &&
    HEAD_SHA.test(b.sha)
  )
}

// No `sha` key, so an existing file can never be overwritten.
function validCiFile(b, ci) {
  return (
    isObject(b) &&
    hasExactKeys(b, ['message', 'content', 'branch']) &&
    b.message === CI_MESSAGE &&
    b.branch === CI_BRANCH &&
    b.content === Buffer.from(ci.text, 'utf8').toString('base64')
  )
}

function validCiPull(b, target) {
  return (
    isObject(b) &&
    hasExactKeys(b, ['title', 'head', 'base', 'body', 'draft']) &&
    b.title === CI_TITLE &&
    b.head === CI_BRANCH &&
    b.base === target.branch &&
    b.body === CI_BODY &&
    b.draft === false
  )
}

function validCiMerge(b, ci) {
  return isObject(b) && hasExactKeys(b, ['merge_method', 'sha']) && b.merge_method === 'squash' && b.sha === ci.pr.sha
}

export function writeArgs(op) {
  // A DELETE has no body, so it uses the 4-argument form with no --input.
  if (op.method === 'DELETE') return ['api', '-X', 'DELETE', op.path]
  return ['api', '-X', op.method, op.path, '--input', '-']
}

// An allowlist: the protection PUT, the repo PATCH, the label create and
// update, and the five CI setup writes (ref, file, PR, merge, ref delete).
// Everything else is refused.
export function isAllowedWrite(args, input, target, ci) {
  if (!Array.isArray(args)) return false
  // Only the CI branch delete has no body.
  if (args.length === 4) {
    const [cmd, flag, method, path] = args
    return (
      cmd === 'api' &&
      flag === '-X' &&
      method === 'DELETE' &&
      input === undefined &&
      ciPrValid(ci) &&
      path === ciBranchRefPath(target)
    )
  }
  if (args.length !== 6) return false
  const [cmd, flag, method, path, inputFlag, dash] = args
  if (cmd !== 'api' || flag !== '-X' || inputFlag !== '--input' || dash !== '-') return false
  if (method === 'PUT') {
    if (path === protectionPath(target)) return validProtectionBody(input)
    if (ciValid(ci) && path === ciFilePath(target)) return validCiFile(input, ci)
    if (ciPrValid(ci) && path === `${pullsPath(target)}/${ci.pr.number}/merge`) return validCiMerge(input, ci)
    return false
  }
  if (method === 'PATCH') {
    if (path === `repos/${target.repo}`) return validRepoPatch(input)
    return validLabelUpdate(input, target, path)
  }
  if (method === 'POST') {
    if (path === labelsPath(target)) return validLabelCreate(input)
    if (ciValid(ci) && path === ciRefsPath(target)) return validCiRef(input)
    if (ciValid(ci) && path === pullsPath(target)) return validCiPull(input, target)
    return false
  }
  return false
}

export function writeGuarded(run, target, ci) {
  return (args, input) => {
    if (!isAllowedWrite(args, input, target, ci)) {
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

// The names of the checks that ran: skipped ones did not, and a check that
// shows up twice counts once. Shared so the two readers cannot drift apart.
function ranNames(items) {
  return [...new Set(items.filter((i) => i.conclusion !== 'SKIPPED').map((i) => (isStatusContext(i) ? i.context : i.name)))].sort()
}

// The checks the newest finished PR ran. That PR, not the last ten together,
// says what runs today, so a retired check does not stay required for good.
export function newestChecks(prs) {
  const byNumber = [...prs].sort((a, b) => b.number - a.number)
  for (const pr of byNumber) {
    if (pr.isDraft === true) continue
    // The CI setup PR says what runs only once its workflow file is on the
    // default branch. Before that, a finished run on it must not read as CI.
    if (pr.headRefName === CI_BRANCH && pr.state !== 'MERGED') continue
    const ci = (pr.statusCheckRollup ?? []).filter((item) => !isVerdict(item))
    if (ci.length === 0 || !ci.every(isCompleted)) continue
    const names = ranNames(ci)
    if (names.length > 0) return { pr: pr.number, names }
  }
  return { pr: null, names: [] }
}

const PASSING_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

// Where the CI setup PR's checks stand: 'red' (a finished check failed),
// 'pending' (one has not finished), 'missing' (`tests` has not run) or 'green'.
// Pending comes before missing because both mean wait.
export function ciCheckState(rollup) {
  const ci = (rollup ?? []).filter((item) => !isVerdict(item))
  const passed = (i) => (isStatusContext(i) ? i.state === 'SUCCESS' : PASSING_CONCLUSIONS.includes(i.conclusion))
  if (ci.some((i) => isCompleted(i) && !passed(i))) return 'red'
  if (ci.some((i) => !isCompleted(i))) return 'pending'
  if (!ranNames(ci).includes(CI_CHECK)) return 'missing'
  return 'green'
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

// ---------------------------------------------------------------------------
// CI setup (issue #551): detect the stack, build the ci.yml
// ---------------------------------------------------------------------------

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod']
const NODE_LOCKFILES = [
  ['package-lock.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
]

// npm's default script is `echo "Error: no test specified" && exit 1`.
function hasRealTestScript(pkg) {
  const script = pkg?.scripts?.test
  return typeof script === 'string' && script.trim() !== '' && !/no test specified/i.test(script)
}

// A test file whose nearest manifest is in a subfolder is not run by a command
// at the root. Only when every test file is like that is detection unsafe.
function subfolderOnlyTests(paths) {
  const manifestDirs = paths
    .filter((p) => p.includes('/') && MANIFESTS.includes(p.slice(p.lastIndexOf('/') + 1)))
    .map((p) => p.slice(0, p.lastIndexOf('/')))
  const tests = paths.filter((p) => countTestFiles([p]) === 1)
  if (tests.length === 0) return []
  const owners = tests.map((t) => manifestDirs.filter((d) => t.startsWith(`${d}/`)).sort((a, b) => a.length - b.length)[0])
  return owners.every((o) => o !== undefined) ? [...new Set(owners)].sort() : []
}

const setup = (uses, withInputs) => ({ uses, with: withInputs })

// Reads the root of the tree (`paths`, every blob path) and the parsed root
// package.json (or null). The runtime comes from the repo's own version file
// when there is one, so the YAML copies no text out of the repo.
export function detectStack(paths, pkg) {
  const root = new Set(paths.filter((p) => !p.includes('/')))
  const subfolders = subfolderOnlyTests(paths)
  if (subfolders.length > 0) {
    return { ok: false, found: `test files only under subfolders with their own manifest: ${subfolders.map((d) => `${d}/`).join(', ')}` }
  }

  const rows = []
  if (root.has('package.json') && hasRealTestScript(pkg)) rows.push('node')
  if (root.has('requirements.txt') || root.has('pyproject.toml')) rows.push('python')
  if (root.has('go.mod')) rows.push('go')

  if (rows.length === 0) {
    return {
      ok: false,
      found: root.has('package.json')
        ? 'package.json has no real test script, and no requirements.txt, pyproject.toml or go.mod at the root'
        : 'no package.json with a test script, requirements.txt, pyproject.toml or go.mod at the root',
    }
  }
  if (rows.length > 1) {
    const names = { node: 'package.json', python: root.has('requirements.txt') ? 'requirements.txt' : 'pyproject.toml', go: 'go.mod' }
    return { ok: false, found: `more than one stack at the root: ${rows.map((r) => names[r]).join(', ')}` }
  }

  if (rows[0] === 'go') {
    return { ok: true, install: null, test: 'go test ./...', runtime: [setup('actions/setup-go@v7', { 'go-version-file': 'go.mod' })] }
  }
  if (rows[0] === 'python') {
    const pip = root.has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .'
    const version = root.has('.python-version') ? { 'python-version-file': '.python-version' } : { 'python-version': '3.12' }
    return { ok: true, install: pip, test: 'pytest', runtime: [setup('actions/setup-python@v7', version)] }
  }

  const locks = NODE_LOCKFILES.filter(([file]) => root.has(file))
  if (locks.length > 1) return { ok: false, found: `more than one lockfile: ${locks.map(([f]) => f).join(', ')}` }
  const lock = locks[0]?.[0]
  const manager = lock === 'pnpm-lock.yaml' ? 'pnpm' : lock === 'yarn.lock' ? 'yarn' : 'npm'
  const node = setup('actions/setup-node@v7', root.has('.nvmrc') ? { 'node-version-file': '.nvmrc' } : { 'node-version': 'lts/*' })
  // pnpm is not preinstalled on ubuntu-latest. The action needs a version unless package.json pins one.
  const pinned = typeof pkg?.packageManager === 'string' && pkg.packageManager.startsWith('pnpm@')
  const runtime = manager === 'pnpm' ? [setup('pnpm/action-setup@v6', pinned ? {} : { version: 'latest' }), node] : [node]
  return {
    ok: true,
    install: locks[0]?.[1] ?? 'npm install',
    test: `${manager} test`,
    runtime,
  }
}

const yamlString = (value) => JSON.stringify(value)

// The job id is `tests` and it has no `name:`, so the required check is called
// `tests`. No paths-ignore: a required check it skips never completes. Every
// value from outside is JSON-quoted, which is valid YAML.
export function buildCiYaml({ branch, install, test, runtime }) {
  const lines = [
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened, ready_for_review]',
    '  push:',
    `    branches: [${yamlString(branch)}]`,
    '',
    'concurrency:',
    '  group: ${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  tests:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ]
  for (const step of runtime) {
    lines.push(`      - uses: ${step.uses}`)
    const inputs = Object.entries(step.with)
    if (inputs.length > 0) {
      lines.push('        with:')
      for (const [key, value] of inputs) lines.push(`          ${key}: ${yamlString(value)}`)
    }
  }
  if (install !== null) lines.push('      - name: Install dependencies', `        run: ${yamlString(install)}`)
  lines.push('      - name: Test', `        run: ${yamlString(test)}`)
  return lines.join('\n') + '\n'
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

// GitHub keeps the color in the case it was given, and a missing description
// comes back as null.
const sameLabel = (have, want) =>
  have.color.toLowerCase() === want.color.toLowerCase() && (have.description ?? '') === want.description

// The label writes: a create for a label that is absent, an update for one that
// differs, nothing for one that matches. POST on an existing label fails with
// 422 and PATCH on a missing one with 404, so the choice cannot be left to GitHub.
function labelWrites(target, facts) {
  const ops = []
  for (const want of LABELS) {
    const have = facts.labels.find((l) => l.name === want.name)
    if (!have) {
      ops.push({ method: 'POST', path: labelsPath(target), body: { name: want.name, color: want.color, description: want.description } })
    } else if (!sameLabel(have, want)) {
      ops.push({ method: 'PATCH', path: labelPath(target, want.name), body: { color: want.color, description: want.description } })
    }
  }
  return ops
}

// On the CI setup path Apply adds the pipeline labels and the tests check in
// the same run, so the protection is built as if both already exist.
export function factsAfterApply(facts) {
  if (!planChanges(facts).needsCi) return facts
  return { ...facts, ciChecks: ['tests'], pipelineLabels: true }
}

// The writes that bring a repo to the plan: the labels (CI setup path only),
// then protection, then the repo settings. If the PATCH fails the repo is
// protected with auto merge still off, which the ship decision already treats as
// not set up. Always takes the facts as read, before anything is written.
// The CI path writes in another order: it moves the PATCH before the CI PR and
// the PUT after its merge (see `splitCiOps`). The ops here do not change.
export function buildWrites(target, facts) {
  const plan = planChanges(factsAfterApply(facts))
  const protectionChanges = plan.changes.filter((c) => !REPO_CHANGES.includes(c))
  const ops = planChanges(facts).needsCi ? labelWrites(target, facts) : []

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
export function confirmToken(target, ops, ci) {
  // Left out when absent: canonical(undefined) is the string "undefined", which
  // would change every token for a plan without CI.
  const body = { repo: target.repo, branch: target.branch, ops, ...(ci ? { ci } : {}) }
  const text = canonical(body)
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
    call(['pr', 'list', '--repo', fullName, '--state', 'all', '--limit', '10', '--json', 'number,isDraft,state,headRefName,statusCheckRollup']),
    'pull requests'
  )

  const treeRes = call(['api', `repos/${fullName}/git/trees/${branch}?recursive=1`])
  let testFileCount = 0
  let testFilesTruncated = false
  let treePaths = []
  if (treeRes.code === 0) {
    const tree = JSON.parse(treeRes.stdout)
    treePaths = (tree.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path)
    testFileCount = countTestFiles(treePaths)
    testFilesTruncated = tree.truncated === true
  } else if (parseError(treeRes).status !== 409) {
    // 409 is an empty repo, which has no files to count.
    throw new Error(`file tree: ${parseError(treeRes).message}`)
  }

  const labelPages = parseOk(
    call(['api', '--paginate', '--slurp', `repos/${fullName}/labels?per_page=100`]),
    'labels'
  )

  const labels = labelPages.flat()

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
    treePaths,
    pipelineLabels: hasPipelineLabels(labels.map((l) => l.name)),
    // Only the six workflow labels, with the fields Apply compares.
    labels: labels
      .filter((l) => LABELS.some((w) => w.name === l.name))
      .map((l) => ({ name: l.name, color: l.color, description: l.description })),
  }
}

export function collect(run) {
  const call = guarded(run)
  requireGh(call)

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

const USAGE = 'usage: repo-guard.mjs apply <repo> [--install <cmd> --test <cmd>] [--confirm <token>]'

// Line breaks and the characters YAML does not allow at all (the C0 and C1
// controls, U+FFFE, U+FFFF, a lone surrogate) would break the one-line `run:`
// value in the generated YAML. The u flag makes a surrogate pair one character,
// so only a lone surrogate matches.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff\ud800-\udfff]/u

function parseApplyArgs(argv) {
  let confirm = null
  const commands = { '--install': null, '--test': null }
  const repos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--confirm') {
      const value = argv[i + 1]
      if (confirm !== null || value === undefined || value.startsWith('-')) return { error: `${USAGE} (--confirm needs one token)` }
      confirm = value
      i++
    } else if (Object.hasOwn(commands, a)) {
      const value = argv[i + 1]
      if (commands[a] !== null || value === undefined || value.startsWith('-') || value.trim() === '') {
        return { error: `${USAGE} (${a} needs one command)` }
      }
      if (CONTROL_CHARS.test(value)) return { error: `${USAGE} (${a} must not contain a control character or line break)` }
      commands[a] = value
      i++
    } else if (a.startsWith('-')) {
      return { error: `${USAGE} (unknown option ${a})` }
    } else {
      repos.push(a)
    }
  }
  if (repos.length !== 1) return { error: `${USAGE} (name exactly one repo)` }
  if ((commands['--install'] === null) !== (commands['--test'] === null)) {
    return { error: `${USAGE} (give --install and --test together, or neither)` }
  }

  const parts = repos[0].split('/')
  if (parts.length > 2 || !parts.every(validPart)) return { error: `refusing: invalid repo name: ${repos[0]}` }
  return {
    confirm,
    install: commands['--install'],
    test: commands['--test'],
    owner: parts.length === 2 ? parts[0] : null,
    name: parts[parts.length - 1],
  }
}

const refusal = (message) => ({ code: 2, text: `refusing: ${message}\nnothing written\n` })
const readFailure = (message) => ({ code: 1, text: `could not read: ${message}\nnothing written\n` })

function ciText(ci) {
  const lines = [
    'CI setup: no finished, non-draft PR has run a check, so apply would add a CI workflow',
    `  install: ${ci.install ?? 'none'}`,
    `  test: ${ci.test}`,
    `  expected check: ${ci.check}`,
    '  file: .github/workflows/ci.yml',
  ]
  for (const line of ci.text.trimEnd().split('\n')) lines.push(line === '' ? '' : `    ${line}`)
  const resume = resumeLine(ci.existing)
  if (resume !== null) lines.push(`  ${resume}`)
  return lines
}

// What a leftover from an earlier run changes. A fresh run says nothing.
function resumeLine(existing) {
  if (existing.pr !== null) return `resume: PR #${existing.pr} is open and holds the planned workflow file`
  if (existing.file) return `resume: branch ${CI_BRANCH} holds the planned workflow file`
  if (existing.branch) return `resume: branch ${CI_BRANCH} exists without the workflow file`
  return null
}

const LABEL_POST_PATH = /^repos\/[^/]+\/[^/]+\/labels$/
const LABEL_PATCH_PATH = /^repos\/[^/]+\/[^/]+\/labels\/([^/]+)$/

// The label a write is about, or null. All six creates share one path, so the
// plan and the output name the label as well.
function labelOpName(op) {
  if (op.method === 'POST' && LABEL_POST_PATH.test(op.path)) return op.body.name
  const m = op.method === 'PATCH' ? LABEL_PATCH_PATH.exec(op.path) : null
  return m ? decodeURIComponent(m[1]) : null
}

export function opText(op) {
  const name = labelOpName(op)
  return `${op.method} ${op.path}${name === null ? '' : ` (${name})`}`
}

export function planText(target, plan, ops, token, ci) {
  const lines = [`${target.repo}: not set up (default branch ${target.branch})`]
  if (ci) lines.push(...ciText(ci))
  const labelOps = ops.filter((op) => labelOpName(op) !== null)
  if (labelOps.length > 0) {
    lines.push('labels:')
    for (const op of labelOps) {
      lines.push(`  ${op.method === 'POST' ? 'create' : 'update'} ${labelOpName(op)}, color ${op.body.color}: ${op.body.description}`)
    }
  }
  lines.push('changes:')
  for (const c of plan.changes) lines.push(`  ${c}`)
  lines.push(`required checks after apply: ${plan.requiredChecks.length > 0 ? plan.requiredChecks.join(', ') : 'none'}`)
  if (plan.notRequired.length > 0) lines.push(`not required: no longer runs: ${plan.notRequired.join(', ')}`)
  lines.push('writes:')
  for (const op of ops) lines.push(`  ${opText(op)}`)
  lines.push(`confirm token: ${token}`)
  return lines.join('\n') + '\n'
}

// The contents API answers with the file as base64 in `content`.
function decodeJsonFile(stdout) {
  try {
    return JSON.parse(Buffer.from(JSON.parse(stdout).content, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function decodeTextFile(stdout) {
  try {
    return Buffer.from(JSON.parse(stdout).content, 'base64').toString('utf8')
  } catch {
    return null
  }
}

const signedCommitsRefusal = (target, facts, ops) =>
  facts.protection.signaturesRequired && ops.some((o) => o.method === 'PUT')
    ? refusal(`${target.repo} requires signed commits, and the protection PUT may reset that`)
    : null

// ---------------------------------------------------------------------------
// CI setup: resume and the PR check (issue #554)
// ---------------------------------------------------------------------------

const OPEN_PR_FIELDS = 'number,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,statusCheckRollup'

// The open PRs from the CI branch of this repo. A fork's PR with the same head
// name is not ours. `--head` is not on the read allowlist, so this filters.
function readOpenCiPrs(call, target) {
  const prs = parseOk(
    call(['pr', 'list', '--repo', target.repo, '--state', 'open', '--limit', '100', '--json', OPEN_PR_FIELDS]),
    'open pull requests'
  )
  return prs.filter((p) => p.headRefName === CI_BRANCH && p.isCrossRepository !== true)
}

const ciPrProblem = (pr, target) =>
  pr.isDraft === true
    ? `PR #${pr.number} is a draft`
    : pr.baseRefName !== target.branch
      ? `PR #${pr.number} has base ${pr.baseRefName}, not ${target.branch}`
      : null

// What the owner said yes to is one new file with the planned text. The branch
// may hold more than that on a resume, so look before the merge. Returns the
// problem, or null. A failed read throws.
function ciPrContentsProblem(call, target, text, number, sha) {
  const files = parseOk(call(['api', `${pullsPath(target)}/${number}/files`]), `files of PR #${number}`)
  if (!Array.isArray(files) || files.length !== 1 || files[0].filename !== CI_FILE) {
    return `PR #${number} does not change exactly one file, ${CI_FILE}`
  }
  if (files[0].status !== 'added') return `PR #${number} does not add ${CI_FILE} (status: ${files[0].status})`
  const res = call(['api', `${ciFilePath(target)}?ref=${encodeURIComponent(sha)}`])
  if (res.code !== 0) throw new Error(`${CI_FILE} at the head of PR #${number}: ${parseError(res).message}`)
  if (decodeTextFile(res.stdout) !== text) return `the ${CI_FILE} at the head of PR #${number} is not the planned file`
  return null
}

const noCiLeftover = { branch: false, file: false, pr: null }

// What an earlier run left: an open PR, or the branch with or without the file.
// Returns `{ existing }` or `{ refuse }`; a failed read throws.
function findCiResume(call, target, text) {
  const open = readOpenCiPrs(call, target)
  if (open.length > 1) {
    return { refuse: `more than one open PR from ${CI_BRANCH}: ${open.map((p) => `#${p.number}`).join(', ')}. Close the extra ones and run apply again` }
  }
  if (open.length === 1) {
    const pr = open[0]
    const problem = ciPrProblem(pr, target) ?? ciPrContentsProblem(call, target, text, pr.number, pr.headRefOid)
    if (problem !== null) return { refuse: `${problem}. Close the PR, delete the ${CI_BRANCH} branch, then run apply again` }
    return { existing: { branch: true, file: true, pr: pr.number } }
  }

  const ref = call(['api', `repos/${target.repo}/git/ref/heads/${CI_BRANCH}`])
  if (ref.code !== 0) {
    if (parseError(ref).status === 404) return { existing: noCiLeftover }
    throw new Error(`branch ${CI_BRANCH}: ${parseError(ref).message}`)
  }
  const file = call(['api', `${ciFilePath(target)}?ref=${encodeURIComponent(CI_BRANCH)}`])
  if (file.code !== 0) {
    if (parseError(file).status === 404) return { existing: { branch: true, file: false, pr: null } }
    throw new Error(`${CI_FILE} on ${CI_BRANCH}: ${parseError(file).message}`)
  }
  if (decodeTextFile(file.stdout) !== text) {
    return { refuse: `the ${CI_BRANCH} branch already holds a different ${CI_FILE}. Delete the branch and run apply again` }
  }
  return { existing: { branch: true, file: true, pr: null } }
}

// The order the CI run writes in (spec section 3.2): everything but the
// protection PUT first, then the CI PR, then the PUT. The PUT waits because it
// requires `tests`, which no PR can pass until the workflow is on the default
// branch. The PATCH goes first because GitHub refuses a squash merge while
// that setting is off.
function splitCiOps(target, ops) {
  const isPut = (op) => op.path === protectionPath(target)
  return { before: ops.filter((op) => !isPut(op)), after: ops.filter(isPut) }
}

// The CI writes a run still has to make, for the plan to list. The merge line
// has no PR number until the PR exists.
function ciStepOps(target, existing) {
  const steps = []
  if (!existing.branch) steps.push({ method: 'POST', path: ciRefsPath(target) })
  if (!existing.file) steps.push({ method: 'PUT', path: ciFilePath(target) })
  if (existing.pr === null) steps.push({ method: 'POST', path: pullsPath(target) })
  steps.push({ method: 'PUT', path: `${pullsPath(target)}/${existing.pr ?? '<new PR>'}/merge` })
  steps.push({ method: 'DELETE', path: ciBranchRefPath(target) })
  return steps
}

// The plan for a repo with test files and no finished PR check. Reads only
// until --confirm has a token that matches.
function planCiSetup(env, args, facts, target) {
  const { call } = env
  if (facts.testFilesTruncated) {
    return refusal(`the file tree of ${target.repo} is truncated, so its root files and workflows cannot be trusted`)
  }
  if (facts.treePaths.some((p) => p.startsWith('.github/workflows/'))) {
    return refusal(
      `${target.repo} already has a workflow under .github/workflows/ but no finished, non-draft PR has run it. ` +
        'It does not add a second CI next to it. Open or finish a PR so the existing workflow runs, then run apply again'
    )
  }

  const undetected = (why) =>
    refusal(
      `${target.repo} needs CI, but the guard could not detect the install and test commands: ${why}. ` +
        'Give them with --install "<cmd>" --test "<cmd>"'
    )

  let found = { ok: true, install: args.install, test: args.test, runtime: [] }
  if (args.install === null) {
    let pkg = null
    if (facts.treePaths.includes('package.json')) {
      const res = call(['api', `repos/${facts.fullName}/contents/package.json?ref=${encodeURIComponent(target.branch)}`])
      if (res.code !== 0) return readFailure(`package.json: ${parseError(res).message}`)
      pkg = decodeJsonFile(res.stdout)
      if (!isObject(pkg)) return undetected('package.json is not valid JSON')
    }
    found = detectStack(facts.treePaths, pkg)
    if (!found.ok) return undetected(found.found)
  }

  const text = buildCiYaml({ branch: target.branch, install: found.install, test: found.test, runtime: found.runtime })
  const ops = buildWrites(target, facts)
  const signed = signedCommitsRefusal(target, facts, ops)
  if (signed) return signed

  let resume
  try {
    resume = findCiResume(call, target, text)
  } catch (err) {
    return readFailure(err.message)
  }
  if (resume.refuse) return refusal(resume.refuse)

  // `existing` is in the token: a PR opened or closed between plan and confirm
  // changes what the run writes, so it must change the token. The PR head sha
  // is left out, so a push alone does not make a token stale.
  const ci = { install: found.install, test: found.test, text, check: CI_CHECK, existing: resume.existing }
  const token = confirmToken(target, ops, ci)
  if (args.confirm !== null) {
    if (args.confirm !== token) return { code: 2, text: 'plan changed since it was shown, nothing written\n' }
    return runCiSetup(env, target, ops, ci)
  }
  const { before, after } = splitCiOps(target, ops)
  const runOrder = [...before, ...ciStepOps(target, ci.existing), ...after]
  return { code: 0, text: planText(target, planChanges(factsAfterApply(facts)), runOrder, token, ci) }
}

const CI_POLL_MS = 30 * 1000
const CI_WAIT_MS = 20 * 60 * 1000

function readDefaultBranchHead(call, target) {
  const body = parseOk(call(['api', `repos/${target.repo}/branches/${encodeURIComponent(target.branch)}`]), `head of the default branch ${target.branch}`)
  return body.commit?.sha
}

// The CI setup run (spec section 3.2, deltas D2 to D4). The token matched, so
// `ops` and `ci` are the plan the owner saw. The order: everything but the
// protection PUT, the branch, the file, the PR, then wait for `tests`, check the
// PR, merge, delete the branch, and last the PUT. Nothing is written after a stop.
function runCiSetup({ run, call, clock, login }, target, ops, ci) {
  const { existing } = ci
  const { before, after: plannedAfter } = splitCiOps(target, ops)
  const lines = []
  const output = (code) => ({ code, text: lines.join('\n') + '\n' })
  // Only a stop before the first write may say nothing was written.
  const stop = (code, ...why) => {
    lines.push(...why)
    lines.push(lines.some((l) => l.startsWith('wrote: ')) ? 'stopped here, no further writes were attempted' : 'nothing written')
    return output(code)
  }
  const prName = (n) => `PR #${n} (https://github.com/${target.repo}/pull/${n})`

  // The fence context is its own object. `pr` stays null until the PR passed
  // the check below, so the merge and the delete cannot be sent before that.
  const earlyWrite = writeGuarded(run, target, { text: ci.text, pr: null })
  if (writeOps(earlyWrite, before, lines)) return output(1)

  const creates = []
  if (!existing.branch) {
    let head
    try {
      head = readDefaultBranchHead(call, target)
    } catch (err) {
      return stop(1, `could not read: ${err.message}`)
    }
    creates.push({ method: 'POST', path: ciRefsPath(target), body: { ref: `refs/heads/${CI_BRANCH}`, sha: head } })
  }
  if (!existing.file) {
    creates.push({
      method: 'PUT',
      path: ciFilePath(target),
      body: { message: CI_MESSAGE, content: Buffer.from(ci.text, 'utf8').toString('base64'), branch: CI_BRANCH },
    })
  }
  if (existing.pr === null) {
    creates.push({
      method: 'POST',
      path: pullsPath(target),
      body: { title: CI_TITLE, head: CI_BRANCH, base: target.branch, body: CI_BODY, draft: false },
    })
  }
  if (writeOps(earlyWrite, creates, lines)) return output(1)

  // Poll until `tests` is green. The sha the merge pins and the contents check
  // both come from the poll that read green, so a push after that poll makes
  // the merge fail instead of landing a commit whose checks never ran.
  const deadline = clock.now() + CI_WAIT_MS
  let pr
  for (;;) {
    let open
    try {
      open = readOpenCiPrs(call, target)
    } catch (err) {
      return stop(1, `could not read: ${err.message}`, `the PR from ${CI_BRANCH} may still be open`)
    }
    if (open.length === 0) return stop(1, `the PR from ${CI_BRANCH} is no longer open`)
    if (open.length > 1) return stop(2, `refusing: more than one open PR from ${CI_BRANCH}: ${open.map((p) => `#${p.number}`).join(', ')}`)
    pr = open[0]
    const problem = ciPrProblem(pr, target)
    if (problem !== null) return stop(2, `refusing: ${problem}. The PR stays open`)
    const state = ciCheckState(pr.statusCheckRollup)
    if (state === 'green') break
    if (state === 'red') {
      return stop(1, `a check failed on ${prName(pr.number)}. The PR stays open; fix it or close it, then run apply again`)
    }
    const now = clock.now()
    if (now >= deadline) {
      const why = state === 'missing' ? 'the tests check has not run' : 'a check is still running'
      return stop(1, `no result after 20 minutes: ${why} on ${prName(pr.number)}. The PR stays open; run apply again to keep waiting`)
    }
    clock.sleep(Math.min(CI_POLL_MS, deadline - now))
  }

  const stays = `${prName(pr.number)} stays open`
  let problem
  try {
    problem = ciPrContentsProblem(call, target, ci.text, pr.number, pr.headRefOid)
  } catch (err) {
    return stop(1, `could not read: ${err.message}`, stays)
  }
  if (problem !== null) return stop(2, `refusing: ${problem}`, stays)

  const lateWrite = writeGuarded(run, target, { text: ci.text, pr: { number: pr.number, sha: pr.headRefOid } })
  const merge = { method: 'PUT', path: `${pullsPath(target)}/${pr.number}/merge`, body: { merge_method: 'squash', sha: pr.headRefOid } }
  if (writeOps(lateWrite, [merge], lines)) {
    lines.push(stays)
    return output(1)
  }
  if (writeOps(lateWrite, [{ method: 'DELETE', path: ciBranchRefPath(target) }], lines)) {
    lines.push(`${prName(pr.number)} is merged; the next apply takes the normal path`)
    return output(1)
  }

  // The PR is merged, so the facts now include its checks. Plan the protection
  // from them and write it only when it is what the owner was shown.
  let facts
  try {
    facts = gatherFacts(call, readRepo(call, target.repo), target.repo)
  } catch (err) {
    return stop(1, `could not re-read the repo: ${err.message}`)
  }
  if (planChanges(facts).needsCi) {
    return stop(1, `the repo still needs CI: no finished check on the merged ${prName(pr.number)}`)
  }
  const left = buildWrites(target, facts)
  if (canonical(left) !== canonical(plannedAfter)) {
    const ran = facts.ciChecks
    const why =
      canonical(ran) !== canonical([CI_CHECK])
        ? `checks that ran on PR #${pr.number}: ${ran.join(', ') || 'none'}; the plan expected: ${CI_CHECK}`
        : 'the repo changed during the wait'
    if (left.length === 0) {
      lines.push(`${why}; nothing is left to write`)
      return rereadAndReport(call, login, target, lines, false)
    }
    // A plan for the normal path, with its own token: the owner decides again.
    lines.push(`refusing: ${why}`, 'stopped here, no further writes were attempted')
    lines.push(planText(target, planChanges(facts), left, confirmToken(target, left)).trimEnd())
    return output(2)
  }

  const failed = writeOps(lateWrite, plannedAfter, lines)
  return rereadAndReport(call, login, target, lines, failed)
}

// The CI run waits for a check. A synchronous sleep keeps `runApply`
// synchronous, and tests pass a fake clock so none of them waits.
export const SYSTEM_CLOCK = {
  now: () => Date.now(),
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  },
}

export function runApply(run, argv, clock = SYSTEM_CLOCK) {
  const args = parseApplyArgs(argv)
  if (args.error) return { code: 2, text: `${args.error}\n` }

  const call = guarded(run)
  let login
  try {
    requireGh(call)
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
  if (plan.needsCi) return planCiSetup({ run, call, clock, login }, args, facts, target)
  if (args.install !== null) {
    return { code: 2, text: `${USAGE} (--install and --test apply only to a repo that needs CI)\n` }
  }
  if (plan.changes.length === 0) return { code: 0, text: `${target.repo}: set up, nothing to change\n` }

  const ops = buildWrites(target, facts)
  const signed = signedCommitsRefusal(target, facts, ops)
  if (signed) return signed
  const token = confirmToken(target, ops)
  if (args.confirm === null) return { code: 0, text: planText(target, plan, ops, token) }
  if (args.confirm !== token) return { code: 2, text: 'plan changed since it was shown, nothing written\n' }

  const lines = []
  const failed = writeOps(writeGuarded(run, target), ops, lines)
  return rereadAndReport(call, login, target, lines, failed)
}

// Writes the ops in order and stops at the first failure. Returns whether it
// stopped. A refusal by the fence counts as a failure, like a failed write.
function writeOps(write, ops, lines) {
  for (const op of ops) {
    let res
    try {
      res = write(writeArgs(op), op.body)
    } catch (err) {
      res = { code: 1, stdout: '', stderr: err.message }
    }
    if (res.code !== 0) {
      lines.push(`write failed: ${opText(op)}: ${parseError(res).message}`)
      lines.push('stopped here, no further writes were attempted')
      return true
    }
    lines.push(`wrote: ${opText(op)}`)
  }
  return false
}

// Re-reads through the read guard so the printed state is what GitHub holds.
// The exit code is 0 only when no write failed and the repo reads as set up.
function rereadAndReport(call, login, target, lines, failed) {
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
// A nonzero exit is always one visible line: gh and API text can carry line
// breaks and terminal escapes. Every C0 control, DEL, every C1 control and the
// two Unicode separators (\p{Zl}, \p{Zp}) collapse to one space.
const CONTROL_RUN = /\s*[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]+\s*/gu

export function runStatuses(run, argv) {
  const out = statusesResult(run, argv)
  if (out.code === 0) return out
  return { code: out.code, text: out.text.replace(CONTROL_RUN, ' ').trim() + '\n' }
}

function statusesResult(run, argv) {
  const args = parseStatusesArgs(argv)
  if (args.error) return { code: 2, text: `${args.error}\n` }

  const refuse = (message) => ({ code: 2, text: `refusing: ${message}\n` })
  const notOwn = (repo, login) => refuse(`${repo} is not a repo of your own account (${login})`)
  const call = guarded(run)

  let login
  try {
    login = parseOk(call(['api', 'user']), 'user').login
    if (typeof login !== 'string' || login === '') throw new Error('user: no login in the answer')
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
    const fullParts = typeof full === 'string' ? full.split('/') : []
    if (fullParts.length !== 2 || !fullParts.every(validPart)) throw new Error(`repo: unexpected name ${full}`)

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

// ---------------------------------------------------------------------------
// Config dirs (Check, issue #502)
// ---------------------------------------------------------------------------

// Fixed here, not read from .claude-plugin/marketplace.json: the script runs
// from the plugin cache, where that file is not present.
const PLUGIN_KEY = 'orchestrai@orchestrai'
const MARKETPLACE_KEY = 'orchestrai'

// Everything about the disk goes through `local`, so a test can hand in a fake
// home. `read` returns null for a missing file and throws on any other error.
// `isDir` is false only when the path is not there; it throws when the path
// cannot be looked at, or is a link with no target. `real` resolves links.
export function nodeLocal() {
  return {
    home: homedir(),
    envDir: process.env.CLAUDE_CONFIG_DIR || null,
    names: (path) => readdirSync(path),
    isDir: (path) => {
      try {
        return statSync(path).isDirectory()
      } catch (err) {
        if (err.code === 'ENOTDIR') return false
        if (err.code !== 'ENOENT') throw err
        try {
          lstatSync(path)
        } catch {
          return false
        }
        throw new Error('broken link: its target does not exist')
      }
    },
    real: (path) => realpathSync(path),
    read: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },
  }
}

const oneLine = (message) => String(message).replace(CONTROL_RUN, ' ').trim()

// A `projects` folder is written by every session. A `plugins` folder is not a
// safe marker: other tools keep `.claude-<something>` dirs with one.
// A candidate that is not there, or has no marker, is skipped. One that cannot
// be looked at (or is a dangling link) is kept with an `error`, so it is
// reported instead of vanishing.
export function findConfigDirs(local) {
  const found = []
  let error = null
  try {
    for (const name of local.names(local.home)) {
      if (name !== '.claude' && !name.startsWith('.claude-')) continue
      const path = resolve(local.home, name)
      try {
        if (local.isDir(path) && local.isDir(join(path, 'projects'))) found.push({ path, fromEnv: false })
      } catch (err) {
        found.push({ path, fromEnv: false, error: oneLine(err.message) })
      }
    }
  } catch (err) {
    error = oneLine(err.message)
  }
  if (local.envDir) found.push({ path: resolve(local.envDir), fromEnv: true })
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // Two names for one dir (a link) are one dir; the first name in sort order is
  // shown. A path that cannot be resolved keeps its own resolved path as key.
  const real = (path) => {
    try {
      return local.real(path)
    } catch {
      return path
    }
  }
  const seen = new Set()
  const dirs = found.filter(({ path }) => {
    const key = real(path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { dirs, error }
}

function readJsonFile(local, dir, file) {
  let data
  try {
    const text = local.read(join(dir, 'plugins', file))
    if (text === null) return undefined
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file}: ${oneLine(err.message)}`)
  }
  return data
}

function readInstalled(local, dir) {
  const file = 'installed_plugins.json'
  const data = readJsonFile(local, dir, file)
  if (data === undefined) return { installed: false, sha: null }
  if (!isObject(data) || !isObject(data.plugins)) throw new Error(`${file}: unexpected shape`)
  const entries = data.plugins[PLUGIN_KEY]
  if (entries === undefined) return { installed: false, sha: null }
  if (!Array.isArray(entries) || !entries.every(isObject)) throw new Error(`${file}: unexpected shape`)
  const user = entries.find((e) => e.scope === 'user')
  if (user === undefined) return { installed: false, sha: null }
  const sha = typeof user.gitCommitSha === 'string' && HEAD_SHA.test(user.gitCommitSha) ? user.gitCommitSha : null
  return { installed: true, sha }
}

function readMarketplace(local, dir) {
  const file = 'known_marketplaces.json'
  const data = readJsonFile(local, dir, file)
  if (data === undefined) return { autoUpdate: null, repo: null }
  if (!isObject(data)) throw new Error(`${file}: unexpected shape`)
  const entry = isObject(data[MARKETPLACE_KEY]) ? data[MARKETPLACE_KEY] : {}
  const autoUpdate = typeof entry.autoUpdate === 'boolean' ? entry.autoUpdate : null
  const source = isObject(entry.source) ? entry.source : {}
  const parts = source.source === 'github' && typeof source.repo === 'string' ? source.repo.split('/') : []
  const repo = parts.length === 2 && parts.every(validPart) ? parts.join('/') : null
  return { autoUpdate, repo }
}

// Never throws: the caller prints every dir whatever happens to one of them.
export function collectConfigDirs(run, local) {
  const call = guarded(run)
  const { dirs: found, error } = findConfigDirs(local)
  let failed = error !== null

  // One read per repo; the answer is the same for every dir that names it.
  const newestByRepo = new Map()
  const newestOf = (repo) => {
    if (!newestByRepo.has(repo)) {
      let answer
      try {
        const res = call(['api', `repos/${repo}/commits/HEAD`])
        if (res.code !== 0) throw new Error(parseError(res).message)
        const sha = JSON.parse(res.stdout)?.sha
        if (typeof sha !== 'string' || !HEAD_SHA.test(sha)) throw new Error('the answer has no 40-character commit')
        answer = { sha }
      } catch (err) {
        answer = { error: oneLine(err.message) }
      }
      newestByRepo.set(repo, answer)
    }
    return newestByRepo.get(repo)
  }

  const dirs = found.map(({ path, fromEnv, error: lookError }) => {
    // The name comes from the disk or the environment: one line, whatever it holds.
    const name = oneLine(displayPath(path, local.home))
    try {
      if (lookError !== undefined) throw new Error(lookError)
      if (fromEnv && !local.isDir(path)) throw new Error('not a directory')
      const { installed, sha } = readInstalled(local, path)
      const { autoUpdate, repo } = readMarketplace(local, path)
      let commit = { kind: 'none' }
      if (installed && sha === null) commit = { kind: 'unrecorded' }
      else if (installed && repo === null) commit = { kind: 'nosource' }
      else if (installed) {
        const newest = newestOf(repo)
        if (newest.error !== undefined) {
          failed = true
          commit = { kind: 'unreadable', message: newest.error }
        } else if (newest.sha === sha) {
          commit = { kind: 'current' }
        } else {
          commit = { kind: 'behind', installed: sha.slice(0, 7), newest: newest.sha.slice(0, 7) }
        }
      }
      return { name, installed, autoUpdate, commit }
    } catch (err) {
      failed = true
      return { name, error: oneLine(err.message) }
    }
  })
  return { failed, error, dirs }
}

function displayPath(path, home) {
  const base = resolve(home)
  if (path === base) return '~'
  return path.startsWith(base + sep) ? `~${path.slice(base.length)}` : path
}

const COMMIT_FACTS = {
  none: () => 'no installed copy',
  current: () => 'at the newest commit',
  behind: (c) => `not at the newest commit (installed ${c.installed}, newest ${c.newest})`,
  unrecorded: () => 'commit not recorded',
  nosource: () => 'newest commit unknown (no GitHub source recorded)',
  unreadable: (c) => `newest commit unknown (could not read: ${c.message})`,
}

export function renderConfigDirs({ error, dirs }) {
  const lines = []
  if (error !== null) {
    lines.push(`config dirs: could not list the home folder: ${error}`)
  } else {
    const count = (pick) => dirs.filter((d) => d.error === undefined && pick(d)).length
    lines.push(
      `config dirs: ${dirs.length} (${count((d) => d.installed)} with the plugin, ${count((d) => d.autoUpdate === true)} auto update on, ${count((d) => d.commit.kind === 'current')} at the newest commit, ${dirs.filter((d) => d.error !== undefined).length} could not read)`
    )
  }
  for (const d of dirs) {
    if (d.error !== undefined) {
      lines.push(`${d.name}: could not read: ${d.error}`)
      continue
    }
    const auto = d.autoUpdate === null ? 'not recorded' : d.autoUpdate ? 'on' : 'off'
    lines.push(
      `${d.name}: plugin ${d.installed ? 'installed' : 'not installed'}, auto update ${auto}, ${COMMIT_FACTS[d.commit.kind](d.commit)}`
    )
  }
  return lines.join('\n') + '\n'
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 0) {
      let failed = false
      let printed = false
      try {
        const result = collect(ghRunner)
        process.stdout.write(render(result))
        printed = true
        if (result.entries.some((e) => e.error !== undefined)) failed = true
      } catch (err) {
        process.stderr.write(`repo-guard: ${err.message}\n`)
        failed = true
      }
      // Local reads, so this part runs even when the repo list failed.
      const config = collectConfigDirs(ghRunner, nodeLocal())
      process.stdout.write((printed ? '\n' : '') + renderConfigDirs(config))
      if (failed || config.failed) process.exitCode = 1
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
