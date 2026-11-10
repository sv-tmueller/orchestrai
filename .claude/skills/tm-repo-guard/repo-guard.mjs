#!/usr/bin/env node
/**
 * tm-repo-guard check (issue #472, batch #470).
 *
 * Reads the GitHub state of every repo the user owns and prints one state per
 * repo: set up, not set up, or blocked. It only reads. Every gh call goes
 * through `guarded()`, which refuses anything outside a small allowlist, so a
 * future edit cannot quietly add a write.
 *
 * Usage: node repo-guard.mjs        (no arguments)
 * Exit:  0 when every repo was read, 1 when any repo could not be read.
 */

import { spawnSync } from 'node:child_process'
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

function ghRunner(args) {
  const res = spawnSync('gh', args, {
    encoding: 'utf8',
    // Stdin is closed so gh cannot stall waiting on it (#467).
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  })
  if (res.error) throw new Error(`could not run gh: ${res.error.message}`)
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
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
    return {
      kind: 'present',
      requiredChecks,
      prRequired: body.required_pull_request_reviews != null,
      forcePushesOff: body.allow_force_pushes?.enabled !== true,
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

export function evaluate(facts) {
  const { protection, prCheckNames: prChecks } = facts
  const ci = prChecks.length > 0
  const verdicts = facts.pipelineLabels === true
  const layers = ['base', ...(ci ? ['ci'] : []), ...(verdicts ? ['verdicts'] : [])]

  const missing = []
  const readable = protection.kind === 'present' || protection.kind === 'none'
  const requiredChecks = protection.kind === 'present' ? protection.requiredChecks : []

  if (protection.kind === 'none') missing.push('branch protection')
  if (readable) {
    if (protection.kind === 'none' || !protection.prRequired) missing.push('PR required')
    if (protection.kind === 'none' || !protection.forcePushesOff) missing.push('force pushes off')
  }
  if (!facts.allowAutoMerge) missing.push('auto merge on')
  if (facts.testFileCount > 0 && !ci) missing.push('needs CI first')
  if (readable) {
    for (const name of prChecks) {
      if (!requiredChecks.includes(name)) missing.push(`required check: ${name}`)
    }
    if (verdicts) {
      for (const name of VERDICT_CHECKS) {
        if (!requiredChecks.includes(name)) missing.push(`required check: ${name}`)
      }
    }
  }

  const flags = []
  if (facts.testFileCount === 0 && !facts.testFilesTruncated) {
    flags.push(ci ? 'no tests, short track off' : 'agent verdicts only, short track off')
  }

  if (protection.kind === 'unavailable') {
    return {
      state: 'blocked',
      reason: 'branch protection is not available on the current plan',
      missing,
      flags,
      layers,
    }
  }
  return { state: missing.length > 0 ? 'not set up' : 'set up', missing, flags, layers }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function parseOk(res, what) {
  if (res.code !== 0) throw new Error(`${what}: ${parseError(res).message}`)
  return JSON.parse(res.stdout)
}

function gatherFacts(call, fullName) {
  const info = parseOk(call(['api', `repos/${fullName}`]), 'repo')
  const branch = encodeURIComponent(info.default_branch)

  const protection = classifyProtection(call(['api', `repos/${fullName}/branches/${branch}/protection`]))
  if (protection.kind === 'error') throw new Error(`branch protection: ${protection.message}`)

  const prs = parseOk(
    call(['pr', 'list', '--repo', fullName, '--state', 'all', '--limit', '10', '--json', 'statusCheckRollup']),
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

  return {
    visibility: info.private ? 'private' : 'public',
    allowAutoMerge: info.allow_auto_merge === true,
    protection,
    prCount: prs.length,
    prCheckNames: prCheckNames(prs),
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
      const facts = gatherFacts(call, r.full_name)
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
    lines.push(`  layers: ${result.layers.join(', ')}`)
    if (result.reason) lines.push(`  blocked: ${result.reason}`)
    if (result.missing.length > 0) lines.push(`  missing: ${result.missing.join(', ')}`)
    const names = facts.prCheckNames.length > 0 ? facts.prCheckNames.join(', ') : 'none'
    lines.push(`  PR checks (${facts.prCount} PR${facts.prCount === 1 ? '' : 's'} read): ${names}`)
    lines.push(`  test files: ${facts.testFilesTruncated ? 'at least ' : ''}${facts.testFileCount}`)
    for (const flag of result.flags) lines.push(`  flag: ${flag}`)
  }
  return lines.join('\n') + '\n'
}

export function main() {
  let result
  try {
    result = collect(ghRunner)
  } catch (err) {
    process.stderr.write(`repo-guard: ${err.message}\n`)
    process.exit(1)
  }
  process.stdout.write(render(result))
  if (result.entries.some((e) => e.error !== undefined)) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main()
}
