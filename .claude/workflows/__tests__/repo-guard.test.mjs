/**
 * Tests for tm-repo-guard: the read-only check (issue #472, batch #470),
 * apply (issue #481), the statuses mode (issue #501) and the config dirs
 * part of Check (issue #502).
 *
 * `repo-guard.mjs` ships with the plugin at
 * `.claude/skills/tm-repo-guard/repo-guard.mjs`. It reads the GitHub state of
 * every repo the user owns and prints one state per repo: set up, not set up,
 * or blocked. These tests cover the pure rule functions, the read-only guard
 * on every gh call, and a full collect() run over a made-up fixture with a
 * fake runner. Apply is tested the same way, against a stateful fake that
 * answers every read and write; no test spawns gh or touches a real repo.
 * Repo and owner names are invented.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { basename, dirname } from 'node:path'

import {
  isReadOnly,
  guarded,
  selectRepos,
  prCheckNames,
  newestChecks,
  ciCheckState,
  classifyProtection,
  countTestFiles,
  hasPipelineLabels,
  detectStack,
  buildCiYaml,
  factsAfterApply,
  planChanges,
  evaluate,
  collect,
  render,
  buildWrites,
  confirmToken,
  planText,
  opText,
  isAllowedWrite,
  writeGuarded,
  writeArgs,
  runApply,
  SYSTEM_CLOCK,
  runStatuses,
  findConfigDirs,
  collectConfigDirs,
  renderConfigDirs,
  main,
} from '../../skills/tm-repo-guard/repo-guard.mjs'
import { decide } from '../../skills/tm-kickoff/ship-decision.mjs'

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------
// Every read call Check makes. The write fence is tested against the same list.
const ACCEPTED_READS = [
  ['--version'],
  ['api', 'user'],
  ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner&per_page=100'],
  ['api', 'repos/acme/widget'],
  ['api', 'repos/acme/widget/branches/main/protection'],
  ['api', 'repos/acme/widget/git/trees/main?recursive=1'],
  ['api', '--paginate', '--slurp', 'repos/acme/widget/labels?per_page=100'],
  ['pr', 'list', '--repo', 'acme/widget', '--state', 'all', '--limit', '10', '--json', 'number,isDraft,state,headRefName,statusCheckRollup'],
]

describe('isReadOnly', () => {
  for (const args of ACCEPTED_READS) {
    test(`accepts: gh ${args.join(' ')}`, () => {
      assert.equal(isReadOnly(args), true)
    })
  }

  const rejected = [
    ['api', '-X', 'POST', 'repos/acme/widget/labels'],
    ['api', '-XPUT', 'repos/acme/widget/topics'],
    ['api', '--method=PATCH', 'repos/acme/widget'],
    ['api', '--method', 'DELETE', 'repos/acme/widget'],
    // gh api switches to POST when given a field, with no -X at all.
    ['api', 'repos/acme/widget/labels', '-f', 'name=x'],
    ['api', 'repos/acme/widget/labels', '-F', 'name=x'],
    ['api', 'repos/acme/widget/labels', '--field', 'name=x'],
    ['api', 'repos/acme/widget/labels', '--raw-field', 'name=x'],
    ['api', 'repos/acme/widget/labels', '--input', 'body.json'],
    ['api', 'graphql'],
    ['api', 'graphql', '--paginate'],
    ['api'],
    ['api', 'user', 'repos/acme/widget'],
    ['pr', 'merge', '12'],
    ['pr', 'list', '--repo', 'acme/widget', '--web'],
    ['pr', 'list', '--repo', 'acme/widget', '--search', 'x'],
    ['repo', 'edit', 'acme/widget', '--enable-auto-merge'],
    ['label', 'create', 'x'],
    ['issue', 'list'],
    ['--version', 'extra'],
    ['version'],
    ['api', '--version'],
    [],
  ]
  for (const args of rejected) {
    test(`rejects: gh ${args.join(' ') || '(no args)'}`, () => {
      assert.equal(isReadOnly(args), false)
    })
  }
})

// ---------------------------------------------------------------------------
// gh version (issue #553)
// ---------------------------------------------------------------------------
// Check and Apply read the labels with `gh api --slurp`, which needs gh 2.48.
// On an older gh they now fail first with one line that names the version.
describe('gh version', () => {
  const ubuntu245 = 'gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)\nhttps://github.com/cli/cli/releases/tag/v2.45.0\n'
  const out = (stdout, code = 0) => ({ code, stdout, stderr: '' })

  // Answers --version with `version` and every other call with an error, and
  // records what it was asked.
  function runnerFor(version) {
    const calls = []
    const run = (args) => {
      calls.push(args)
      if (args.join(' ') === '--version') return version
      return { code: 1, stdout: '', stderr: 'gh: stop here' }
    }
    return { run, calls }
  }
  const keys = (calls) => calls.map((a) => a.join(' '))

  const tooOld = [
    ['2.45.0 from Ubuntu', ubuntu245, 'gh 2.45.0 found, gh 2.48 or newer needed'],
    ['2.47.9', out('gh version 2.47.9 (2024-04-10)\n'), 'gh 2.47.9 found, gh 2.48 or newer needed'],
    ['1.99.0', out('gh version 1.99.0 (2022-01-01)\n'), 'gh 1.99.0 found, gh 2.48 or newer needed'],
  ]
  for (const [name, answer, line] of tooOld) {
    const version = typeof answer === 'string' ? out(answer) : answer
    test(`${name}: Check throws one line and makes no other call`, () => {
      const { run, calls } = runnerFor(version)
      assert.throws(() => collect(run), (err) => err.message === line)
      assert.deepEqual(keys(calls), ['--version'])
    })
    test(`${name}: Apply exits 1 with the line and makes no other call`, () => {
      const { run, calls } = runnerFor(version)
      const { code, text } = runApply(run, ['widget'])
      assert.equal(code, 1)
      assert.equal(text, `could not read: ${line}\nnothing written\n`)
      assert.deepEqual(keys(calls), ['--version'])
    })
  }

  const newEnough = [
    ['2.48.0', 'gh version 2.48.0 (2024-04-24)\n'],
    ['2.103.3, where a float compare would refuse', 'gh version 2.103.3 (2026-10-26)\n'],
    ['3.0.0', 'gh version 3.0.0 (2027-01-01)\n'],
  ]
  for (const [name, stdout] of newEnough) {
    test(`${name}: Check goes on to api user`, () => {
      const { run, calls } = runnerFor(out(stdout))
      assert.throws(() => collect(run), /user/)
      assert.deepEqual(keys(calls), ['--version', 'api user'])
    })
    test(`${name}: Apply goes on to api user`, () => {
      const { run, calls } = runnerFor(out(stdout))
      runApply(run, ['widget'])
      assert.deepEqual(keys(calls), ['--version', 'api user'])
    })
  }

  const unreadable = [
    ['a non-zero exit', out('gh version 2.60.0 (2025-01-01)\n', 1)],
    ['empty output', out('')],
    ['a dev build', out('gh version DEV (unknown)\n')],
    ['text that is not a version line', out('something else\n')],
    ['a version line on the second line only', out('\ngh version 2.60.0 (2025-01-01)\n')],
  ]
  for (const [name, version] of unreadable) {
    const line = 'gh version unknown, gh 2.48 or newer needed'
    test(`${name}: Check fails closed with the unknown line`, () => {
      const { run, calls } = runnerFor(version)
      assert.throws(() => collect(run), (err) => err.message === line)
      assert.deepEqual(keys(calls), ['--version'])
    })
    test(`${name}: Apply fails closed with the unknown line`, () => {
      const { run, calls } = runnerFor(version)
      const { code, text } = runApply(run, ['widget'])
      assert.equal(code, 1)
      assert.equal(text, `could not read: ${line}\nnothing written\n`)
      assert.deepEqual(keys(calls), ['--version'])
    })
  }

  test('a usage error in Apply still exits 2 with no gh call', () => {
    const { run, calls } = runnerFor(out(ubuntu245))
    assert.equal(runApply(run, []).code, 2)
    assert.deepEqual(calls, [])
  })

  test('Statuses makes no version call', () => {
    const { run, calls } = runnerFor(out(ubuntu245))
    runStatuses(run, ['widget', '42'])
    assert.equal(keys(calls).includes('--version'), false)
  })
})

// ---------------------------------------------------------------------------
// selectRepos
// ---------------------------------------------------------------------------
describe('selectRepos', () => {
  const repos = [
    { full_name: 'octo/mine', owner: { login: 'octo' }, archived: false },
    { full_name: 'octo/old', owner: { login: 'octo' }, archived: true },
    { full_name: 'some-org/shared', owner: { login: 'some-org' }, archived: false },
    { full_name: 'octo/forked', owner: { login: 'octo' }, archived: false, fork: true },
  ]

  test('keeps owned, unarchived repos only, forks included', () => {
    assert.deepEqual(
      selectRepos(repos, 'octo').map((r) => r.full_name),
      ['octo/mine', 'octo/forked']
    )
  })

  test('drops an organization repo even when the endpoint returned it', () => {
    assert.deepEqual(selectRepos(repos, 'some-org').map((r) => r.full_name), ['some-org/shared'])
    assert.deepEqual(selectRepos(repos, 'nobody'), [])
  })
})

// ---------------------------------------------------------------------------
// prCheckNames
// ---------------------------------------------------------------------------
describe('prCheckNames', () => {
  const run = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, conclusion })
  const ctx = (context) => ({ __typename: 'StatusContext', context, state: 'SUCCESS' })

  test('takes check run names, deduplicated and sorted, across PRs', () => {
    const prs = [
      { statusCheckRollup: [run('Unit tests'), run('Version bump guard')] },
      { statusCheckRollup: [run('Unit tests')] },
    ]
    assert.deepEqual(prCheckNames(prs), ['Unit tests', 'Version bump guard'])
  })

  test('skips runs whose conclusion is SKIPPED', () => {
    const prs = [{ statusCheckRollup: [run('e2e', 'SKIPPED'), run('Unit tests')] }]
    assert.deepEqual(prCheckNames(prs), ['Unit tests'])
  })

  test('only SKIPPED runs means no checks', () => {
    assert.deepEqual(prCheckNames([{ statusCheckRollup: [run('e2e', 'SKIPPED')] }]), [])
  })

  test('takes status contexts but not the orchestrai/ agent verdicts', () => {
    const prs = [{ statusCheckRollup: [ctx('ci/legacy'), ctx('orchestrai/review'), ctx('orchestrai/test')] }]
    assert.deepEqual(prCheckNames(prs), ['ci/legacy'])
  })

  test('empty, missing and null rollups give no names', () => {
    assert.deepEqual(prCheckNames([]), [])
    assert.deepEqual(prCheckNames([{ statusCheckRollup: [] }, { statusCheckRollup: null }, {}]), [])
  })
})

// ---------------------------------------------------------------------------
// newestChecks
// ---------------------------------------------------------------------------
describe('newestChecks', () => {
  const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion })
  const running = (name) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '' })
  const ctx = (context, state = 'SUCCESS') => ({ __typename: 'StatusContext', context, state })
  const pr = (number, statusCheckRollup, isDraft = false) => ({ number, isDraft, statusCheckRollup })

  test('picks the highest number in any input order', () => {
    const prs = [pr(7, [done('old')]), pr(9, [done('new')]), pr(8, [done('mid')])]
    assert.deepEqual(newestChecks(prs), { pr: 9, names: ['new'] })
    assert.deepEqual(newestChecks([...prs].reverse()), { pr: 9, names: ['new'] })
  })

  test('skips a draft and uses the next older PR', () => {
    const prs = [pr(9, [done('fast')], true), pr(8, [done('Unit tests'), done('lint')])]
    assert.deepEqual(newestChecks(prs), { pr: 8, names: ['Unit tests', 'lint'] })
  })

  test('skips a PR with a check still running', () => {
    const prs = [pr(9, [done('Unit tests'), running('e2e')]), pr(8, [done('Unit tests')])]
    assert.deepEqual(newestChecks(prs), { pr: 8, names: ['Unit tests'] })
  })

  test('skips a PR with a status context that is still pending', () => {
    const prs = [pr(9, [ctx('ci/legacy', 'PENDING')]), pr(8, [ctx('ci/legacy', 'SUCCESS')])]
    assert.deepEqual(newestChecks(prs), { pr: 8, names: ['ci/legacy'] })
  })

  test('skips a PR with only skipped checks', () => {
    const prs = [pr(9, [done('e2e', 'SKIPPED')]), pr(8, [done('Unit tests')])]
    assert.deepEqual(newestChecks(prs), { pr: 8, names: ['Unit tests'] })
  })

  test('skips a PR with only orchestrai/ statuses, and never names them', () => {
    const prs = [pr(9, [ctx('orchestrai/review'), ctx('orchestrai/test')]), pr(8, [done('Unit tests'), ctx('orchestrai/review')])]
    assert.deepEqual(newestChecks(prs), { pr: 8, names: ['Unit tests'] })
  })

  test('skips an empty or null rollup', () => {
    const prs = [pr(9, []), pr(8, null), pr(7, undefined), pr(6, [done('Unit tests')])]
    assert.deepEqual(newestChecks(prs), { pr: 6, names: ['Unit tests'] })
  })

  test('no PRs, or none that qualify, gives no PR and no names', () => {
    assert.deepEqual(newestChecks([]), { pr: null, names: [] })
    assert.deepEqual(newestChecks([pr(3, [running('x')]), pr(2, [], true)]), { pr: null, names: [] })
  })

  test('a failed check still counts as having run', () => {
    const prs = [pr(5, [done('Unit tests', 'FAILURE'), ctx('ci/legacy', 'ERROR')])]
    assert.deepEqual(newestChecks(prs), { pr: 5, names: ['Unit tests', 'ci/legacy'] })
  })

  test('names are deduplicated and sorted', () => {
    const prs = [pr(5, [done('b'), done('a'), done('b')])]
    assert.deepEqual(newestChecks(prs).names, ['a', 'b'])
  })

  describe('the CI setup PR counts only once it is merged', () => {
    const setup = (number, state, rollup = [done('tests')]) => ({
      number,
      isDraft: false,
      state,
      headRefName: 'orchestrai/ci-setup',
      statusCheckRollup: rollup,
    })
    const older = pr(4, [done('Unit tests')])

    test('an open CI PR with finished red checks is skipped', () => {
      const prs = [setup(9, 'OPEN', [done('tests', 'FAILURE')]), older]
      assert.deepEqual(newestChecks(prs), { pr: 4, names: ['Unit tests'] })
    })

    test('an open CI PR with finished green checks is skipped too', () => {
      assert.deepEqual(newestChecks([setup(9, 'OPEN'), older]), { pr: 4, names: ['Unit tests'] })
    })

    test('a closed CI PR is skipped', () => {
      assert.deepEqual(newestChecks([setup(9, 'CLOSED'), older]), { pr: 4, names: ['Unit tests'] })
    })

    test('a merged CI PR counts when ci.yml is on the default branch', () => {
      assert.deepEqual(newestChecks([setup(9, 'MERGED'), older], true), { pr: 9, names: ['tests'] })
    })

    test('a merged CI PR is skipped when ci.yml is not on the default branch', () => {
      assert.deepEqual(newestChecks([setup(9, 'MERGED'), older], false), { pr: 4, names: ['Unit tests'] })
    })

    test('a merged CI PR is skipped when the flag is omitted', () => {
      assert.deepEqual(newestChecks([setup(9, 'MERGED'), older]), { pr: 4, names: ['Unit tests'] })
    })

    test('the flag does not let an open CI PR count', () => {
      assert.deepEqual(newestChecks([setup(9, 'OPEN'), older], true), { pr: 4, names: ['Unit tests'] })
    })

    test('the flag changes nothing for a PR from another branch', () => {
      const other = { ...setup(9, 'MERGED'), headRefName: 'feat/x' }
      assert.deepEqual(newestChecks([other, older], false), { pr: 9, names: ['tests'] })
    })

    test('a PR from another branch counts whatever its state', () => {
      const other = { ...setup(9, 'OPEN'), headRefName: 'feat/x' }
      assert.deepEqual(newestChecks([other, older]), { pr: 9, names: ['tests'] })
      const noHead = { ...setup(9, 'OPEN'), headRefName: undefined, state: undefined }
      assert.deepEqual(newestChecks([noHead, older]), { pr: 9, names: ['tests'] })
    })

    test('only the exact branch name is skipped', () => {
      const near = { ...setup(9, 'OPEN'), headRefName: 'orchestrai/ci-setup-2' }
      assert.deepEqual(newestChecks([near, older]), { pr: 9, names: ['tests'] })
    })
  })
})

// ---------------------------------------------------------------------------
// ciCheckState
// ---------------------------------------------------------------------------
describe('ciCheckState', () => {
  const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion })
  const running = (name) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '' })
  const ctx = (context, state = 'SUCCESS') => ({ __typename: 'StatusContext', context, state })

  test('green: tests passed and nothing else is red or pending', () => {
    assert.equal(ciCheckState([done('tests')]), 'green')
    assert.equal(ciCheckState([done('tests'), done('lint'), ctx('ci/legacy')]), 'green')
  })

  test('NEUTRAL and SKIPPED are passes, but a SKIPPED tests did not run', () => {
    assert.equal(ciCheckState([done('tests'), done('lint', 'NEUTRAL'), done('e2e', 'SKIPPED')]), 'green')
    assert.equal(ciCheckState([done('tests', 'SKIPPED')]), 'missing')
  })

  test('missing: an empty, null or undefined rollup, or no tests among the names', () => {
    assert.equal(ciCheckState([]), 'missing')
    assert.equal(ciCheckState(null), 'missing')
    assert.equal(ciCheckState(undefined), 'missing')
    assert.equal(ciCheckState([done('lint')]), 'missing')
  })

  test('a status context named tests counts as tests having run', () => {
    assert.equal(ciCheckState([ctx('tests')]), 'green')
  })

  test('pending: a check run or a status that is not finished', () => {
    assert.equal(ciCheckState([running('tests')]), 'pending')
    assert.equal(ciCheckState([done('tests'), running('lint')]), 'pending')
    assert.equal(ciCheckState([done('tests'), ctx('ci/legacy', 'PENDING')]), 'pending')
  })

  test('red: any finished item that is not a pass', () => {
    for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE', null]) {
      assert.equal(ciCheckState([done('tests', conclusion)]), 'red', String(conclusion))
    }
    assert.equal(ciCheckState([done('tests'), ctx('ci/legacy', 'FAILURE')]), 'red')
    assert.equal(ciCheckState([done('tests'), ctx('ci/legacy', 'ERROR')]), 'red')
  })

  test('red beats pending, and pending beats missing', () => {
    assert.equal(ciCheckState([done('lint', 'FAILURE'), running('tests')]), 'red')
    assert.equal(ciCheckState([done('tests', 'FAILURE'), running('lint')]), 'red')
    assert.equal(ciCheckState([running('lint')]), 'pending')
  })

  test('orchestrai/* items are ignored, whatever their state', () => {
    assert.equal(ciCheckState([done('tests'), ctx('orchestrai/review', 'FAILURE'), ctx('orchestrai/test', 'PENDING')]), 'green')
    assert.equal(ciCheckState([ctx('orchestrai/review')]), 'missing')
  })

  test('returns a plain string', () => {
    assert.equal(typeof ciCheckState([done('tests')]), 'string')
  })
})

// ---------------------------------------------------------------------------
// classifyProtection
// ---------------------------------------------------------------------------
describe('classifyProtection', () => {
  const CARRY_OFF = {
    required_linear_history: false,
    required_conversation_resolution: false,
    block_creations: false,
    lock_branch: false,
    allow_fork_syncing: false,
    dismiss_stale_reviews: false,
  }

  test('exit 0 is present, with the union of both required-check shapes', () => {
    const body = {
      required_status_checks: {
        strict: true,
        contexts: ['Unit tests', 'lint'],
        checks: [{ context: 'lint' }, { context: 'Version bump guard' }],
      },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      allow_force_pushes: { enabled: false },
      enforce_admins: { enabled: true },
    }
    assert.deepEqual(classifyProtection({ code: 0, stdout: JSON.stringify(body) }), {
      kind: 'present',
      requiredChecks: ['Unit tests', 'Version bump guard', 'lint'],
      prRequired: true,
      forcePushesOff: true,
      enforceAdmins: true,
      signaturesRequired: false,
      strict: true,
      deletionsOff: true,
      noApprovalNeeded: true,
      carry: CARRY_OFF,
    })
  })

  test('signaturesRequired is true only when required_signatures.enabled is true', () => {
    const read = (body) => classifyProtection({ code: 0, stdout: JSON.stringify(body) }).signaturesRequired
    assert.deepEqual(
      [read({ required_signatures: { enabled: true } }), read({ required_signatures: { enabled: false } }), read({})],
      [true, false, false]
    )
  })

  test('enforce_admins counts only when enabled is true', () => {
    const off = classifyProtection({ code: 0, stdout: JSON.stringify({ enforce_admins: { enabled: false } }) })
    const absent = classifyProtection({ code: 0, stdout: '{}' })
    assert.equal(off.enforceAdmins, false)
    assert.equal(absent.enforceAdmins, false)
  })

  test('strict is true only when required_status_checks.strict is true, and a null block is false', () => {
    const on = classifyProtection({ code: 0, stdout: JSON.stringify({ required_status_checks: { strict: true } }) })
    const off = classifyProtection({ code: 0, stdout: JSON.stringify({ required_status_checks: { strict: false } }) })
    const nul = classifyProtection({ code: 0, stdout: JSON.stringify({ required_status_checks: null }) })
    assert.deepEqual([on.strict, off.strict, nul.strict], [true, false, false])
  })

  test('deletions are on only when allow_deletions.enabled is true', () => {
    const on = classifyProtection({ code: 0, stdout: JSON.stringify({ allow_deletions: { enabled: true } }) })
    const absent = classifyProtection({ code: 0, stdout: '{}' })
    assert.deepEqual([on.deletionsOff, absent.deletionsOff], [false, true])
  })

  test('no approval is needed only at count 0 with no code-owner review and no last-push approval', () => {
    const body = (rpr) => JSON.stringify({ required_pull_request_reviews: rpr })
    const at = (rpr) => classifyProtection({ code: 0, stdout: body(rpr) }).noApprovalNeeded
    assert.equal(at({ required_approving_review_count: 0 }), true)
    assert.equal(at({}), true)
    assert.equal(at({ required_approving_review_count: 1 }), false)
    assert.equal(at({ required_approving_review_count: 0, require_code_owner_reviews: true }), false)
    assert.equal(at({ required_approving_review_count: 0, require_last_push_approval: true }), false)
  })

  test('carry holds the six values Apply copies over', () => {
    const body = {
      required_pull_request_reviews: { dismiss_stale_reviews: true },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      block_creations: { enabled: true },
      lock_branch: { enabled: true },
      allow_fork_syncing: { enabled: true },
    }
    const got = classifyProtection({ code: 0, stdout: JSON.stringify(body) })
    assert.deepEqual(got.carry, {
      required_linear_history: true,
      required_conversation_resolution: true,
      block_creations: true,
      lock_branch: true,
      allow_fork_syncing: true,
      dismiss_stale_reviews: true,
    })
  })

  test('a PR is not required when required_pull_request_reviews is null or absent', () => {
    for (const body of [{ required_pull_request_reviews: null }, {}]) {
      const got = classifyProtection({ code: 0, stdout: JSON.stringify(body) })
      assert.equal(got.prRequired, false)
      assert.deepEqual(got.requiredChecks, [])
    }
  })

  test('force pushes are on only when allow_force_pushes.enabled is true', () => {
    const on = classifyProtection({ code: 0, stdout: JSON.stringify({ allow_force_pushes: { enabled: true } }) })
    const absent = classifyProtection({ code: 0, stdout: '{}' })
    assert.equal(on.forcePushesOff, false)
    assert.equal(absent.forcePushesOff, true)
  })

  test('404 Branch not protected is none', () => {
    const stdout = JSON.stringify({ message: 'Branch not protected', status: '404' })
    assert.deepEqual(classifyProtection({ code: 1, stdout }), { kind: 'none' })
  })

  test('404 Branch not found (an empty repo) is none', () => {
    const stdout = JSON.stringify({ message: 'Branch not found', status: '404' })
    assert.deepEqual(classifyProtection({ code: 1, stdout }), { kind: 'none' })
  })

  test('403 asking for a plan upgrade is not available on the current plan', () => {
    const upgrade = JSON.stringify({
      message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
      status: '403',
    })
    assert.equal(classifyProtection({ code: 1, stdout: upgrade }).kind, 'unavailable')
  })

  test('any other failure is an error that carries the message, never none or blocked', () => {
    for (const [status, message] of [
      ['404', 'Not Found'],
      ['403', 'Resource not accessible by integration'],
      ['500', 'Server Error'],
    ]) {
      const got = classifyProtection({ code: 1, stdout: JSON.stringify({ message, status }) })
      assert.equal(got.kind, 'error')
      assert.match(got.message, new RegExp(message))
    }
  })

  test('unparseable output on failure is an error, not a crash', () => {
    const got = classifyProtection({ code: 1, stdout: '', stderr: 'gh: network down' })
    assert.equal(got.kind, 'error')
    assert.match(got.message, /network down/)
  })
})

// ---------------------------------------------------------------------------
// countTestFiles / hasPipelineLabels
// ---------------------------------------------------------------------------
describe('countTestFiles', () => {
  test('matches each documented file name pattern', () => {
    const paths = [
      'src/a.test.js',
      'src/b.spec.ts',
      'tests/test_c.py',
      'pkg/d_test.py',
      'pkg/e_test.go',
      'Tests/AppTests/ModelTests.swift',
      'app/src/test/FooTest.kt',
      'app/src/test/BarTests.java',
      'Lib/BazTest.cs',
      'spec/models/user_spec.rb',
    ]
    assert.equal(countTestFiles(paths), 10)
  })

  test('counts file names, not folders, so fixtures under __tests__ are skipped', () => {
    const paths = ['__tests__/fixtures/data.json', 'tests/helpers.py', 'src/index.js', 'spec/README.md']
    assert.equal(countTestFiles(paths), 0)
  })

  test('does not count a workflow file or a bare Test name', () => {
    assert.equal(countTestFiles(['.github/workflows/ci.yml', 'Test.swift', 'contest.py']), 0)
  })
})

describe('hasPipelineLabels', () => {
  test('needs both in-progress and needs-human', () => {
    assert.equal(hasPipelineLabels(['in-progress', 'needs-human', 'bug']), true)
    assert.equal(hasPipelineLabels(['in-progress', 'phase:developer']), false)
    assert.equal(hasPipelineLabels(['needs-human']), false)
    assert.equal(hasPipelineLabels([]), false)
  })
})

// ---------------------------------------------------------------------------
// detectStack / buildCiYaml (issue #551)
// ---------------------------------------------------------------------------
describe('detectStack', () => {
  const REAL = { scripts: { test: 'vitest run' } }
  const NODE_SETUP = { uses: 'actions/setup-node@v7', with: { 'node-version-file': '.nvmrc' } }
  const NODE_LTS = { uses: 'actions/setup-node@v7', with: { 'node-version': 'lts/*' } }

  const rows = [
    ['package-lock.json', ['package.json', 'package-lock.json', 'a.test.js'], 'npm ci', 'npm test'],
    ['pnpm-lock.yaml', ['package.json', 'pnpm-lock.yaml', 'a.test.js'], 'pnpm install --frozen-lockfile', 'pnpm test'],
    ['yarn.lock', ['package.json', 'yarn.lock', 'a.test.js'], 'yarn install --frozen-lockfile', 'yarn test'],
    ['no lockfile', ['package.json', 'a.test.js'], 'npm install', 'npm test'],
  ]
  for (const [name, paths, install, test_] of rows) {
    test(`a package.json with a real test script and ${name}: ${install}, then ${test_}`, () => {
      const got = detectStack(paths, REAL)
      assert.equal(got.ok, true)
      assert.equal(got.install, install)
      assert.equal(got.test, test_)
    })
  }

  test('requirements.txt: pip install -r requirements.txt, then pytest', () => {
    const got = detectStack(['requirements.txt', 'test_a.py'], null)
    assert.deepEqual([got.ok, got.install, got.test], [true, 'pip install -r requirements.txt', 'pytest'])
  })

  test('pyproject.toml without requirements.txt: pip install -e ., then pytest', () => {
    const got = detectStack(['pyproject.toml', 'test_a.py'], null)
    assert.deepEqual([got.ok, got.install, got.test], [true, 'pip install -e .', 'pytest'])
  })

  test('both requirements.txt and pyproject.toml fit only the requirements row', () => {
    const got = detectStack(['requirements.txt', 'pyproject.toml', 'test_a.py'], null)
    assert.deepEqual([got.ok, got.install], [true, 'pip install -r requirements.txt'])
  })

  test('go.mod: no install, go test ./...', () => {
    const got = detectStack(['go.mod', 'a_test.go'], null)
    assert.deepEqual([got.ok, got.install, got.test], [true, null, 'go test ./...'])
  })

  test('the node runtime follows .nvmrc when it is at the root, else the current LTS', () => {
    assert.deepEqual(detectStack(['package.json', 'a.test.js', '.nvmrc'], REAL).runtime, [NODE_SETUP])
    assert.deepEqual(detectStack(['package.json', 'a.test.js'], REAL).runtime, [NODE_LTS])
    assert.deepEqual(detectStack(['package.json', 'a.test.js', 'app/.nvmrc'], REAL).runtime, [NODE_LTS])
  })

  test('the python runtime follows .python-version, else 3.12 as a string', () => {
    const withFile = detectStack(['requirements.txt', 'test_a.py', '.python-version'], null).runtime
    assert.deepEqual(withFile, [{ uses: 'actions/setup-python@v7', with: { 'python-version-file': '.python-version' } }])
    const without = detectStack(['requirements.txt', 'test_a.py'], null).runtime
    assert.deepEqual(without, [{ uses: 'actions/setup-python@v7', with: { 'python-version': '3.12' } }])
  })

  test('the go runtime follows go.mod', () => {
    const got = detectStack(['go.mod', 'a_test.go'], null).runtime
    assert.deepEqual(got, [{ uses: 'actions/setup-go@v7', with: { 'go-version-file': 'go.mod' } }])
  })

  test('pnpm is not on ubuntu-latest, so its runtime installs pnpm first', () => {
    const paths = ['package.json', 'pnpm-lock.yaml', 'a.test.js']
    const pinned = detectStack(paths, { ...REAL, packageManager: 'pnpm@9.1.0' }).runtime
    assert.deepEqual(pinned, [{ uses: 'pnpm/action-setup@v6', with: {} }, NODE_LTS])
    const unpinned = detectStack(paths, REAL).runtime
    assert.deepEqual(unpinned, [{ uses: 'pnpm/action-setup@v6', with: { version: 'latest' } }, NODE_LTS])
  })

  test('npm and yarn need no extra install step for the package manager', () => {
    assert.deepEqual(detectStack(['package.json', 'yarn.lock', 'a.test.js'], REAL).runtime, [NODE_LTS])
    assert.deepEqual(detectStack(['package.json', 'package-lock.json', 'a.test.js'], REAL).runtime, [NODE_LTS])
  })

  const fails = (name, paths, pkg, pattern) => {
    test(`fails on ${name} and names what it found`, () => {
      const got = detectStack(paths, pkg)
      assert.equal(got.ok, false)
      assert.match(got.found, pattern)
    })
  }
  fails('no file that fits a row', ['src/a.test.js'], null, /no package\.json with a test script, requirements\.txt, pyproject\.toml or go\.mod at the root/)
  fails('npm\'s default test script', ['package.json', 'a.test.js'], { scripts: { test: 'echo "Error: no test specified" && exit 1' } }, /package\.json has no real test script/)
  fails('a package.json with no scripts', ['package.json', 'a.test.js'], {}, /package\.json has no real test script/)
  fails('a blank test script', ['package.json', 'a.test.js'], { scripts: { test: '  ' } }, /no real test script/)
  fails('two stacks at the root', ['package.json', 'requirements.txt', 'a.test.js'], REAL, /more than one.*package\.json.*requirements\.txt/)
  fails('node and go at the root', ['package.json', 'go.mod', 'a.test.js'], REAL, /more than one/)
  fails('two lockfiles', ['package.json', 'package-lock.json', 'yarn.lock', 'a.test.js'], REAL, /more than one lockfile: package-lock\.json, yarn\.lock/)
  fails(
    'test files only under a subfolder with its own manifest',
    ['package.json', 'package-lock.json', 'dashboard/package.json', 'dashboard/a.test.js'],
    REAL,
    /only under.*dashboard\//
  )
  fails(
    'test files only under a nested folder below a subfolder manifest',
    ['go.mod', 'svc/pyproject.toml', 'svc/tests/test_a.py'],
    null,
    /only under.*svc\//
  )

  test('test files in a subfolder with a manifest do not matter when others sit outside one', () => {
    const paths = ['package.json', 'a.test.js', 'dashboard/package.json', 'dashboard/b.test.js']
    assert.equal(detectStack(paths, REAL).ok, true)
  })

  test('test files in a subfolder with no manifest of its own are fine', () => {
    assert.equal(detectStack(['package.json', 'src/a.test.js'], REAL).ok, true)
  })
})

describe('buildCiYaml', () => {
  const NPM = {
    branch: 'main',
    install: 'npm ci',
    test: 'npm test',
    runtime: [{ uses: 'actions/setup-node@v7', with: { 'node-version-file': '.nvmrc' } }],
  }

  test('writes the whole workflow for a detected npm repo', () => {
    assert.equal(
      buildCiYaml(NPM),
      [
        'name: CI',
        '',
        'on:',
        '  pull_request:',
        '    types: [opened, synchronize, reopened, ready_for_review]',
        '  push:',
        '    branches: ["main"]',
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
        '      - uses: actions/checkout@v7',
        '      - uses: actions/setup-node@v7',
        '        with:',
        '          node-version-file: ".nvmrc"',
        '      - name: Install dependencies',
        '        run: "npm ci"',
        '      - name: Test',
        '        run: "npm test"',
        '',
      ].join('\n')
    )
  })

  test('the one job has the id tests and no name, so the check is called tests', () => {
    const text = buildCiYaml(NPM)
    assert.match(text, /^jobs:\n {2}tests:\n/m)
    assert.equal((text.match(/^ {2}[A-Za-z_-]+:$/gm) ?? []).length, 3, 'pull_request, push and the one job')
    assert.doesNotMatch(text, /^ {4}name:/m)
    assert.doesNotMatch(text, /matrix|strategy/)
  })

  test('keeps the cost rules: timeout, concurrency, no paths-ignore, no placeholders', () => {
    const text = buildCiYaml(NPM)
    assert.match(text, /^ {4}timeout-minutes: 10$/m)
    assert.match(text, /^ {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}$/m)
    assert.match(text, /^ {2}cancel-in-progress: true$/m)
    assert.doesNotMatch(text, /paths-ignore|echo|\bif:/)
  })

  test('quotes the default branch, so an odd name stays one YAML string', () => {
    assert.match(buildCiYaml({ ...NPM, branch: 'release/1.0' }), /^ {4}branches: \["release\/1\.0"\]$/m)
    assert.match(buildCiYaml({ ...NPM, branch: 'a"b' }), /^ {4}branches: \["a\\"b"\]$/m)
  })

  test('quotes version strings, so 3.10 does not read as 3.1', () => {
    const runtime = [{ uses: 'actions/setup-python@v7', with: { 'python-version': '3.10' } }]
    assert.match(buildCiYaml({ ...NPM, runtime }), /^ {10}python-version: "3\.10"$/m)
  })

  test('quotes given commands with JSON quoting', () => {
    const text = buildCiYaml({ branch: 'main', install: 'npm run "setup": all', test: 'make test # fast', runtime: [] })
    assert.match(text, /^ {8}run: "npm run \\"setup\\": all"$/m)
    assert.match(text, /^ {8}run: "make test # fast"$/m)
  })

  test('given commands have no runtime setup step and rely on ubuntu-latest', () => {
    const text = buildCiYaml({ branch: 'main', install: 'make deps', test: 'make test', runtime: [] })
    assert.doesNotMatch(text, /setup-/)
    assert.match(text, /- uses: actions\/checkout@v7\n {6}- name: Install dependencies\n/)
  })

  test('a null install leaves out the install step', () => {
    const runtime = [{ uses: 'actions/setup-go@v7', with: { 'go-version-file': 'go.mod' } }]
    const text = buildCiYaml({ branch: 'main', install: null, test: 'go test ./...', runtime })
    assert.doesNotMatch(text, /Install dependencies/)
    assert.match(text, /^ {8}run: "go test \.\/\.\.\."$/m)
  })

  test('a setup action with no inputs has no with key', () => {
    const runtime = [{ uses: 'pnpm/action-setup@v6', with: {} }]
    const text = buildCiYaml({ ...NPM, runtime })
    assert.match(text, /- uses: pnpm\/action-setup@v6\n {6}- name: Install dependencies/)
  })

  test('uses no em dashes', () => {
    assert.equal(buildCiYaml(NPM).includes('—'), false)
  })
})

// ---------------------------------------------------------------------------
// planChanges / evaluate
// ---------------------------------------------------------------------------
const CARRY_FALSE = {
  required_linear_history: false,
  required_conversation_resolution: false,
  block_creations: false,
  lock_branch: false,
  allow_fork_syncing: false,
  dismiss_stale_reviews: false,
}
const PROTECTED = {
  kind: 'present',
  requiredChecks: ['Unit tests'],
  prRequired: true,
  forcePushesOff: true,
  enforceAdmins: true,
  strict: true,
  deletionsOff: true,
  noApprovalNeeded: true,
  carry: CARRY_FALSE,
}
const baseFacts = (over = {}) => ({
  visibility: 'public',
  allowAutoMerge: true,
  allowSquashMerge: true,
  protection: PROTECTED,
  prCheckNames: ['Unit tests'],
  olderCheckNames: [],
  ciChecks: ['Unit tests'],
  testFileCount: 5,
  pipelineLabels: false,
  labels: [],
  ...over,
})
const NO_CI = { ciChecks: [], prCheckNames: [], olderCheckNames: [], protection: { ...PROTECTED, requiredChecks: [] } }

// One entry per case that the plan must tell apart.
const FIXTURES = {
  'fully set up': baseFacts(),
  'no protection': baseFacts({ protection: { kind: 'none' } }),
  'PR not required': baseFacts({ protection: { ...PROTECTED, prRequired: false } }),
  'approving count above 0': baseFacts({ protection: { ...PROTECTED, noApprovalNeeded: false } }),
  'force pushes on': baseFacts({ protection: { ...PROTECTED, forcePushesOff: false } }),
  'deletion on': baseFacts({ protection: { ...PROTECTED, deletionsOff: false } }),
  'not applied to admins': baseFacts({ protection: { ...PROTECTED, enforceAdmins: false } }),
  'not strict': baseFacts({ protection: { ...PROTECTED, strict: false } }),
  'auto merge off': baseFacts({ allowAutoMerge: false }),
  'squash off': baseFacts({ allowSquashMerge: false }),
  'check not required': baseFacts({ ciChecks: ['Unit tests', 'lint'], prCheckNames: ['Unit tests', 'lint'] }),
  'required check no longer runs': baseFacts({
    ...NO_CI,
    testFileCount: 0,
    protection: { ...PROTECTED, requiredChecks: ['Gone'] },
  }),
  'needs CI first': baseFacts(NO_CI),
  blocked: baseFacts({ protection: { kind: 'unavailable', message: 'Upgrade to GitHub Pro' }, allowAutoMerge: false }),
  'verdicts on, not required': baseFacts({ pipelineLabels: true }),
  'verdicts on, required': baseFacts({
    pipelineLabels: true,
    protection: { ...PROTECTED, requiredChecks: ['Unit tests', 'orchestrai/review', 'orchestrai/test'] },
  }),
  'copied fields set': baseFacts({
    protection: {
      ...PROTECTED,
      carry: {
        required_linear_history: true,
        required_conversation_resolution: true,
        block_creations: true,
        lock_branch: true,
        allow_fork_syncing: true,
        dismiss_stale_reviews: true,
      },
    },
  }),
}

describe('planChanges', () => {
  test('fully set up has no changes', () => {
    const got = planChanges(baseFacts())
    assert.equal(got.blocked, null)
    assert.equal(got.needsCi, false)
    assert.deepEqual(got.changes, [])
    assert.deepEqual(got.requiredChecks, ['Unit tests'])
    assert.deepEqual(got.notRequired, [])
    assert.deepEqual(got.layers, ['base', 'ci'])
  })

  test('no protection lists every protection item, in order, then the settings', () => {
    const got = planChanges(baseFacts({ protection: { kind: 'none' }, allowAutoMerge: false, allowSquashMerge: false }))
    assert.deepEqual(got.changes, [
      'branch protection',
      'PR required',
      'force pushes off',
      'deletion off',
      'applies to admins',
      'up to date required',
      'required check: Unit tests',
      'auto merge on',
      'squash merge allowed',
    ])
  })

  test('PR not required', () => {
    assert.deepEqual(planChanges(FIXTURES['PR not required']).changes, ['PR required'])
  })

  test('approving count above 0 is listed only when a PR is already required', () => {
    assert.deepEqual(planChanges(FIXTURES['approving count above 0']).changes, ['no approving review required'])
    const notRequired = baseFacts({ protection: { ...PROTECTED, prRequired: false, noApprovalNeeded: false } })
    assert.deepEqual(planChanges(notRequired).changes, ['PR required'])
  })

  test('code-owner review on counts as an approval still needed', () => {
    const protection = classifyProtection({
      code: 0,
      stdout: JSON.stringify({
        required_status_checks: { strict: true, contexts: ['Unit tests'] },
        required_pull_request_reviews: { required_approving_review_count: 0, require_code_owner_reviews: true },
        allow_force_pushes: { enabled: false },
        enforce_admins: { enabled: true },
      }),
    })
    assert.deepEqual(planChanges(baseFacts({ protection })).changes, ['no approving review required'])
  })

  test('force pushes on', () => {
    assert.deepEqual(planChanges(FIXTURES['force pushes on']).changes, ['force pushes off'])
  })

  test('deletion on', () => {
    assert.deepEqual(planChanges(FIXTURES['deletion on']).changes, ['deletion off'])
  })

  test('rule not applied to admins', () => {
    assert.deepEqual(planChanges(FIXTURES['not applied to admins']).changes, ['applies to admins'])
  })

  test('not strict', () => {
    assert.deepEqual(planChanges(FIXTURES['not strict']).changes, ['up to date required'])
  })

  test('a null required_status_checks block reads as not strict and no checks required', () => {
    const protection = classifyProtection({
      code: 0,
      stdout: JSON.stringify({
        required_status_checks: null,
        required_pull_request_reviews: {},
        allow_force_pushes: { enabled: false },
        enforce_admins: { enabled: true },
      }),
    })
    assert.deepEqual(planChanges(baseFacts({ protection })).changes, ['up to date required', 'required check: Unit tests'])
  })

  test('auto merge off', () => {
    assert.deepEqual(planChanges(FIXTURES['auto merge off']).changes, ['auto merge on'])
  })

  test('squash off', () => {
    assert.deepEqual(planChanges(FIXTURES['squash off']).changes, ['squash merge allowed'])
  })

  test('a current check that is not required', () => {
    const got = planChanges(FIXTURES['check not required'])
    assert.deepEqual(got.changes, ['required check: lint'])
    assert.deepEqual(got.requiredChecks, ['Unit tests', 'lint'])
  })

  test('a required check that no longer runs is dropped, and named when older PRs show it', () => {
    const facts = baseFacts({
      ciChecks: ['Unit tests'],
      prCheckNames: ['Unit tests', 'Version bump guard'],
      olderCheckNames: ['Unit tests', 'Version bump guard'],
      protection: { ...PROTECTED, requiredChecks: ['Unit tests', 'Version bump guard'] },
    })
    const got = planChanges(facts)
    assert.deepEqual(got.changes, ['stop requiring: Version bump guard'])
    assert.deepEqual(got.requiredChecks, ['Unit tests'])
    assert.deepEqual(got.notRequired, ['Version bump guard'])
  })

  test('a name seen only on older PRs that is not required is no change, but is named', () => {
    const got = planChanges(baseFacts({ olderCheckNames: ['Unit tests', 'Zeta', 'Alpha'] }))
    assert.deepEqual(got.changes, [])
    assert.deepEqual(got.notRequired, ['Alpha', 'Zeta'])
  })

  test('notRequired comes from the older PRs only, not from the display list of every PR', () => {
    const got = planChanges(baseFacts({ prCheckNames: ['Unit tests', 'Newer only'], olderCheckNames: [] }))
    assert.deepEqual(got.notRequired, [])
  })

  test('test files with no current checks need CI first', () => {
    const got = planChanges(FIXTURES['needs CI first'])
    assert.equal(got.needsCi, true)
    assert.deepEqual(got.changes, [])
    assert.deepEqual(got.layers, ['base'])
  })

  test('protection not available is blocked, even with other gaps, and leaves protection items out', () => {
    const got = planChanges(FIXTURES.blocked)
    assert.match(got.blocked, /not available on the current plan/)
    assert.deepEqual(got.changes, ['auto merge on'])
  })

  test('the verdicts layer follows the pipeline labels', () => {
    const off = planChanges(baseFacts({ pipelineLabels: false }))
    assert.equal(off.layers.includes('verdicts'), false)
    const on = planChanges(FIXTURES['verdicts on, not required'])
    assert.deepEqual(on.layers, ['base', 'ci', 'verdicts'])
    assert.deepEqual(on.requiredChecks, ['Unit tests', 'orchestrai/review', 'orchestrai/test'])
    assert.deepEqual(on.changes, ['required check: orchestrai/review', 'required check: orchestrai/test'])
  })

  test('no tests and no checks sets the verdicts-only flag and the base layer', () => {
    const got = planChanges(baseFacts({ ...NO_CI, testFileCount: 0 }))
    assert.deepEqual(got.flags, ['agent verdicts only, short track off'])
    assert.deepEqual(got.layers, ['base'])
    assert.deepEqual(got.changes, [])
  })

  test('no PRs at all asks for no checks and does not need CI when there are no tests', () => {
    const got = planChanges(baseFacts({ ...NO_CI, testFileCount: 0, prCount: 0 }))
    assert.equal(got.needsCi, false)
    assert.deepEqual(got.requiredChecks, [])
  })

  test('copied fields set cause no change', () => {
    assert.deepEqual(planChanges(FIXTURES['copied fields set']).changes, [])
  })
})

describe('evaluate', () => {
  test('fully set up', () => {
    const got = evaluate(baseFacts())
    assert.equal(got.state, 'set up')
    assert.deepEqual(got.missing, [])
    assert.deepEqual(got.flags, [])
    assert.deepEqual(got.layers, ['base', 'ci'])
    assert.deepEqual(got.notRequired, [])
  })

  test('no protection: not set up, with the base items missing', () => {
    const got = evaluate(baseFacts({ ...NO_CI, protection: { kind: 'none' } }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing.slice(0, 3), ['branch protection', 'PR required', 'force pushes off'])
  })

  test('the missing list is the change list, plus needs CI first when it applies', () => {
    for (const [name, facts] of Object.entries(FIXTURES)) {
      const plan = planChanges(facts)
      const expected = plan.needsCi ? [...plan.changes, 'needs CI first'] : plan.changes
      assert.deepEqual(evaluate(facts).missing, expected, name)
    }
  })

  test('set up exactly when not blocked, no CI is needed and there are no writes', () => {
    for (const [name, facts] of Object.entries(FIXTURES)) {
      const plan = planChanges(facts)
      const nothingToDo = plan.blocked === null && !plan.needsCi && buildWrites(TARGET, facts).length === 0
      assert.equal(evaluate(facts).state === 'set up', nothingToDo, name)
    }
  })

  test('the new items show as missing', () => {
    assert.deepEqual(evaluate(FIXTURES['not applied to admins']).missing, ['applies to admins'])
    assert.deepEqual(evaluate(FIXTURES['not strict']).missing, ['up to date required'])
    assert.deepEqual(evaluate(FIXTURES['squash off']).missing, ['squash merge allowed'])
    assert.deepEqual(evaluate(FIXTURES['deletion on']).missing, ['deletion off'])
    assert.deepEqual(evaluate(FIXTURES['approving count above 0']).missing, ['no approving review required'])
  })

  test('test files but no PR checks: not set up, needs CI first', () => {
    const got = evaluate(FIXTURES['needs CI first'])
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing, ['needs CI first'])
    assert.deepEqual(got.layers, ['base'])
  })

  test('no tests and no PR checks prints the agent-verdicts flag', () => {
    const got = evaluate(baseFacts({ ...NO_CI, testFileCount: 0 }))
    assert.equal(got.state, 'set up')
    assert.deepEqual(got.flags, ['agent verdicts only, short track off'])
  })

  test('no tests but PR checks present prints the second flag and keeps the CI layer', () => {
    const got = evaluate(baseFacts({ testFileCount: 0 }))
    assert.deepEqual(got.flags, ['no tests, short track off'])
    assert.deepEqual(got.layers, ['base', 'ci'])
    assert.equal(got.state, 'set up')
  })

  test('a truncated tree with zero matches so far prints no no-tests flag', () => {
    const got = evaluate(baseFacts({ testFileCount: 0, testFilesTruncated: true }))
    assert.deepEqual(got.flags, [])
  })

  test('protection not available on the plan is blocked, even when other things are missing', () => {
    const got = evaluate(
      baseFacts({
        visibility: 'private',
        protection: { kind: 'unavailable', message: 'Upgrade to GitHub Pro' },
        allowAutoMerge: false,
        ciChecks: [],
        prCheckNames: [],
      })
    )
    assert.equal(got.state, 'blocked')
    assert.match(got.reason, /not available on the current plan/)
    assert.deepEqual(got.missing, ['auto merge on', 'needs CI first'])
  })

  test('the verdicts layer applies only when the pipeline labels exist', () => {
    const off = evaluate(baseFacts({ pipelineLabels: false }))
    assert.equal(off.layers.includes('verdicts'), false)
    assert.equal(off.state, 'set up')

    const on = evaluate(FIXTURES['verdicts on, not required'])
    assert.deepEqual(on.layers, ['base', 'ci', 'verdicts'])
    assert.equal(on.state, 'not set up')
    assert.deepEqual(on.missing, ['required check: orchestrai/review', 'required check: orchestrai/test'])
  })

  test('verdicts layer is met when both verdict contexts are required', () => {
    assert.equal(evaluate(FIXTURES['verdicts on, required']).state, 'set up')
  })

  test('carries notRequired through for the renderer', () => {
    assert.deepEqual(evaluate(baseFacts({ olderCheckNames: ['Unit tests', 'Old'] })).notRequired, ['Old'])
  })
})

// ---------------------------------------------------------------------------
// collect: the whole run against a fake runner, with the guard in the path
// ---------------------------------------------------------------------------
describe('collect', () => {
  const json = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const fail = (status, message) => ({
    code: 1,
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
  })

  const repo = (owner, name, extra = {}) => ({
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    archived: false,
    ...extra,
  })

  const tree = (paths, extra = {}) => json({ tree: paths.map((path) => ({ path, type: 'blob' })), ...extra })

  const check = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })
  const pr = (number, rollup, isDraft = false) => ({ number, isDraft, statusCheckRollup: rollup })

  // Keyed by the joined args, so any call outside this set fails loudly.
  const responses = {
    '--version': { code: 0, stdout: 'gh version 2.103.3 (2026-10-26)\n', stderr: '' },
    'api user': json({ login: 'octo' }),
    'api --paginate --slurp user/repos?affiliation=owner&per_page=100': json([
      [repo('octo', 'widget-api'), repo('octo', 'private-notes')],
      [repo('octo', 'blank-repo'), repo('octo', 'old-stuff', { archived: true }), repo('some-org', 'shared')],
    ]),

    // A tidy public repo, fully set up.
    'api repos/octo/widget-api': json({ private: false, allow_auto_merge: true, allow_squash_merge: true, default_branch: 'main' }),
    'api repos/octo/widget-api/branches/main/protection': json({
      required_status_checks: { strict: true, contexts: ['Unit tests'] },
      required_pull_request_reviews: {},
      allow_force_pushes: { enabled: false },
      enforce_admins: { enabled: true },
    }),
    'pr list --repo octo/widget-api --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup': json([
      pr(12, [check('Unit tests')]),
      pr(11, [check('Unit tests'), check('Version bump guard')]),
    ]),
    'api repos/octo/widget-api/git/trees/main?recursive=1': tree(['src/a.js', 'src/a.test.js']),
    'api --paginate --slurp repos/octo/widget-api/labels?per_page=100': json([[{ name: 'bug' }]]),

    // A private repo on a plan with no protection. It has a workflow file but
    // its PRs show no checks, so the CI layer must not apply.
    'api repos/octo/private-notes': json({ private: true, allow_auto_merge: false, allow_squash_merge: true, default_branch: 'main' }),
    'api repos/octo/private-notes/branches/main/protection': fail(
      403,
      'Upgrade to GitHub Pro or make this repository public to enable this feature.'
    ),
    'pr list --repo octo/private-notes --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup': json([
      pr(3, []),
    ]),
    'api repos/octo/private-notes/git/trees/main?recursive=1': tree(['.github/workflows/ci.yml', 'notes.md']),
    'api --paginate --slurp repos/octo/private-notes/labels?per_page=100': json([
      [{ name: 'in-progress' }],
      [{ name: 'needs-human' }],
    ]),

    // An empty repo: no branch yet, and the tree endpoint answers 409.
    'api repos/octo/blank-repo': json({ private: false, allow_auto_merge: false, allow_squash_merge: false, default_branch: 'main' }),
    'api repos/octo/blank-repo/branches/main/protection': fail(404, 'Branch not found'),
    'pr list --repo octo/blank-repo --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup': json([]),
    'api repos/octo/blank-repo/git/trees/main?recursive=1': fail(409, 'Git Repository is empty.'),
    'api --paginate --slurp repos/octo/blank-repo/labels?per_page=100': json([[]]),
  }

  const expectedPerRepo = (name) => [
    `api repos/octo/${name}`,
    `api repos/octo/${name}/branches/main/protection`,
    `pr list --repo octo/${name} --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup`,
    `api repos/octo/${name}/git/trees/main?recursive=1`,
    `api --paginate --slurp repos/octo/${name}/labels?per_page=100`,
  ]

  function recordingRunner(table = responses) {
    const calls = []
    const inputs = []
    const run = (args, input) => {
      calls.push(args)
      inputs.push(input)
      const key = args.join(' ')
      if (!(key in table)) throw new Error(`unexpected gh call: ${key}`)
      return table[key]
    }
    return { run, calls, inputs }
  }

  test('every call passes the read-only guard and the call set is exactly the expected one', () => {
    const { run, calls, inputs } = recordingRunner()
    collect(run)
    assert.deepEqual(inputs.filter((i) => i !== undefined), [], 'a read carried an input body')
    for (const args of calls) assert.equal(isReadOnly(args), true, `not read-only: ${args.join(' ')}`)
    assert.deepEqual(
      calls.map((a) => a.join(' ')).sort(),
      [
        '--version',
        'api user',
        'api --paginate --slurp user/repos?affiliation=owner&per_page=100',
        ...expectedPerRepo('widget-api'),
        ...expectedPerRepo('private-notes'),
        ...expectedPerRepo('blank-repo'),
      ].sort()
    )
  })

  test('the guard wraps the runner and stops a write before the runner sees it', () => {
    const seen = []
    const call = guarded((args) => {
      seen.push(args)
      return json({})
    })
    call(['api', 'user'])
    assert.throws(() => call(['api', '-X', 'POST', 'repos/octo/widget-api/labels']), /not read-only/)
    assert.throws(() => call(['api', 'repos/octo/widget-api', '-f', 'name=x']), /not read-only/)
    assert.deepEqual(seen, [['api', 'user']])
  })

  test('collect sends calls through the guard: a rejected call never reaches the runner', () => {
    // A repo whose full_name is `--web` makes the pull request call `pr list --repo --web ...`,
    // which the guard refuses because a flag value starts with a dash.
    const table = {
      ...responses,
      'api --paginate --slurp user/repos?affiliation=owner&per_page=100': json([[repo('octo', '--web', { full_name: '--web' })]]),
      'api repos/--web': json({ private: false, allow_auto_merge: true, default_branch: 'main' }),
      'api repos/--web/branches/main/protection': fail(404, 'Branch not protected'),
    }
    const { run, calls } = recordingRunner(table)
    const result = collect(run)
    assert.equal(
      calls.some((args) => args[0] === 'pr'),
      false,
      'the runner received the rejected pr list call'
    )
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].repo, '--web')
    assert.equal(result.entries[0].result, undefined)
    assert.match(result.entries[0].error, /not read-only/)
    assert.match(render(result), /^--web: could not read: refusing a call that is not read-only/m)
  })

  test('one entry per owned, unarchived repo, with the expected states', () => {
    const { run } = recordingRunner()
    const result = collect(run)
    assert.equal(result.login, 'octo')
    assert.deepEqual(
      result.entries.map((e) => [e.repo, e.result.state]),
      [
        ['octo/widget-api', 'set up'],
        ['octo/private-notes', 'blocked'],
        ['octo/blank-repo', 'not set up'],
      ]
    )
  })

  test('the newest PR decides the checks, and a name only on an older PR is named but not an error', () => {
    const widget = collect(recordingRunner().run).entries.find((e) => e.repo === 'octo/widget-api')
    assert.deepEqual(widget.facts.ciChecks, ['Unit tests'])
    assert.deepEqual(widget.facts.prCheckNames, ['Unit tests', 'Version bump guard'])
    assert.deepEqual(widget.result.notRequired, ['Version bump guard'])
    assert.equal(widget.result.state, 'set up')
    assert.equal(widget.facts.allowSquashMerge, true)
  })

  describe('not required: only names from PRs older than the deciding PR', () => {
    const running = (name) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: null })
    const widgetWith = (prs, treeOverride) => {
      const key = 'pr list --repo octo/widget-api --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup'
      const table = { ...responses, [key]: json(prs), ...treeOverride }
      return collect(recordingRunner(table).run).entries.find((e) => e.repo === 'octo/widget-api')
    }

    test('a name only on a newer PR that is still running is not listed', () => {
      const widget = widgetWith([pr(13, [check('Unit tests'), running('lint')]), pr(12, [check('Unit tests')])])
      assert.deepEqual(widget.facts.ciChecks, ['Unit tests'])
      assert.deepEqual(widget.facts.prCheckNames, ['Unit tests', 'lint'])
      assert.deepEqual(widget.result.notRequired, [])
    })

    test('a name only on a newer draft PR is not listed', () => {
      const widget = widgetWith([pr(13, [check('Unit tests'), check('lint')], true), pr(12, [check('Unit tests')])])
      assert.deepEqual(widget.result.notRequired, [])
    })

    describe('the CI setup PR', () => {
      const setup = (state, rollup) => ({ ...pr(13, rollup), state, headRefName: 'orchestrai/ci-setup' })

      test('an open CI PR whose tests failed still reads as needs CI first', () => {
        const widget = widgetWith([setup('OPEN', [{ ...check('tests'), conclusion: 'FAILURE' }])])
        assert.deepEqual(widget.facts.ciChecks, [])
        assert.ok(evaluate(widget.facts).missing.includes('needs CI first'))
      })

      const widgetTree = (paths, opts) => ({ 'api repos/octo/widget-api/git/trees/main?recursive=1': tree(paths, opts) })
      const CI_YML = '.github/workflows/ci.yml'

      test('a merged CI PR is the deciding PR', () => {
        const widget = widgetWith([setup('MERGED', [check('tests')])], widgetTree(['src/a.js', 'src/a.test.js', CI_YML]))
        assert.deepEqual(widget.facts.ciChecks, ['tests'])
      })

      test('a merged CI PR with no ci.yml on the default branch reads as needs CI first', () => {
        const widget = widgetWith([setup('MERGED', [check('tests')])])
        assert.deepEqual(widget.facts.ciChecks, [])
        assert.ok(evaluate(widget.facts).missing.includes('needs CI first'))
        assert.equal(widget.result.state, 'not set up')
      })

      test('a merged CI PR is not counted when the tree is truncated, even with ci.yml listed', () => {
        const widget = widgetWith(
          [setup('MERGED', [check('tests')])],
          widgetTree(['src/a.test.js', CI_YML], { truncated: true })
        )
        assert.deepEqual(widget.facts.ciChecks, [])
      })
    })

    test('a name only on an older PR is listed', () => {
      const widget = widgetWith([pr(13, [check('Unit tests')]), pr(12, [check('Unit tests'), check('Old')])])
      assert.deepEqual(widget.result.notRequired, ['Old'])
    })

    test('unsorted PRs: only names older than the deciding PR are listed, wherever they sit in the list', () => {
      const widget = widgetWith([
        pr(12, [check('Unit tests')]),
        pr(14, [check('lint')], true),
        pr(13, [check('Unit tests'), running('e2e')]),
        pr(11, [check('Old')]),
      ])
      assert.deepEqual(widget.result.notRequired, ['Old'])
    })

    test('with no deciding PR nothing is listed', () => {
      const widget = widgetWith([pr(13, [running('lint')]), pr(12, [check('Old')], true)])
      assert.deepEqual(widget.facts.ciChecks, [])
      assert.deepEqual(widget.result.notRequired, [])
    })
  })

  test('a workflow file with empty PR rollups means no CI layer', () => {
    const { run } = recordingRunner()
    const notes = collect(run).entries.find((e) => e.repo === 'octo/private-notes')
    assert.deepEqual(notes.facts.prCheckNames, [])
    assert.equal(notes.facts.prCount, 1)
    assert.equal(notes.result.layers.includes('ci'), false)
    assert.equal(notes.result.layers.includes('verdicts'), true)
  })

  test('an empty repo counts as zero test files and none for protection', () => {
    const { run } = recordingRunner()
    const blank = collect(run).entries.find((e) => e.repo === 'octo/blank-repo')
    assert.equal(blank.facts.testFileCount, 0)
    assert.deepEqual(blank.facts.protection, { kind: 'none' })
    assert.deepEqual(blank.result.flags, ['agent verdicts only, short track off'])
  })

  test('a truncated tree is reported as a lower bound', () => {
    const table = {
      ...responses,
      'api repos/octo/widget-api/git/trees/main?recursive=1': tree(['a.test.js', 'b.test.js'], { truncated: true }),
    }
    const widget = collect(recordingRunner(table).run).entries.find((e) => e.repo === 'octo/widget-api')
    assert.equal(widget.facts.testFileCount, 2)
    assert.equal(widget.facts.testFilesTruncated, true)
  })

  test('facts.labels keeps only the six workflow labels, as name, color and description', () => {
    const table = {
      ...responses,
      'api --paginate --slurp repos/octo/widget-api/labels?per_page=100': json([
        [{ id: 1, name: 'bug', color: 'd73a4a', description: 'Something is broken' }],
        [
          { id: 2, name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.', default: false },
          { id: 3, name: 'in-progress', color: 'FBCA04', description: null },
          { id: 4, name: 'SIZE:M', color: '000000', description: '' },
        ],
      ]),
    }
    const widget = collect(recordingRunner(table).run).entries.find((e) => e.repo === 'octo/widget-api')
    assert.deepEqual(widget.facts.labels, [
      { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
      { name: 'in-progress', color: 'FBCA04', description: null },
    ])
    assert.equal(widget.facts.pipelineLabels, false)
  })

  test('an unreadable protection response becomes an error entry, not a state', () => {
    const table = {
      ...responses,
      'api repos/octo/widget-api/branches/main/protection': fail(500, 'Server Error'),
    }
    const result = collect(recordingRunner(table).run)
    const widget = result.entries.find((e) => e.repo === 'octo/widget-api')
    assert.match(widget.error, /Server Error/)
    assert.equal(widget.result, undefined)
    assert.equal(result.entries.length, 3)
  })
})

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
describe('render', () => {
  const entry = (repo, result, facts = {}) => ({
    repo,
    facts: {
      visibility: 'public',
      allowAutoMerge: true,
      allowSquashMerge: true,
      protection: {
        kind: 'present',
        requiredChecks: ['Unit tests'],
        prRequired: true,
        forcePushesOff: true,
        enforceAdmins: true,
        strict: true,
      },
      pipelineLabels: false,
      prCount: 3,
      prCheckNames: ['Unit tests'],
      testFileCount: 4,
      ...facts,
    },
    result,
  })
  const setUp = { state: 'set up', missing: [], flags: [], layers: ['base', 'ci'] }

  test('prints a summary of counts per state and one block per repo', () => {
    const text = render({
      login: 'octo',
      entries: [
        entry('octo/a', { state: 'set up', missing: [], flags: [], layers: ['base', 'ci'] }),
        entry('octo/b', { state: 'not set up', missing: ['auto merge on'], flags: [], layers: ['base'] }),
        entry('octo/c', { state: 'blocked', reason: 'branch protection is not available on the current plan', missing: [], flags: [], layers: ['base'] }),
        { repo: 'octo/d', error: 'Server Error' },
      ],
    })
    assert.match(text, /4 repos/)
    assert.match(text, /1 set up, 1 not set up, 1 blocked, 1 could not read/)
    assert.match(text, /octo\/b: not set up/)
    assert.match(text, /missing: auto merge on/)
    assert.match(text, /octo\/c: blocked/)
    assert.match(text, /not available on the current plan/)
    assert.match(text, /octo\/d: could not read: Server Error/)
  })

  test('shows how many PRs were read next to the check names', () => {
    const text = render({
      login: 'octo',
      entries: [entry('octo/a', { state: 'set up', missing: [], flags: [], layers: ['base', 'ci'] })],
    })
    assert.match(text, /PR checks \(3 PRs read\): Unit tests/)
  })

  test('says none when PRs exist without checks, and shows the PR count for no PRs', () => {
    const result = { state: 'set up', missing: [], flags: [], layers: ['base'] }
    const some = render({ login: 'o', entries: [entry('o/a', result, { prCheckNames: [], prCount: 2 })] })
    const zero = render({ login: 'o', entries: [entry('o/a', result, { prCheckNames: [], prCount: 0 })] })
    assert.match(some, /PR checks \(2 PRs read\): none/)
    assert.match(zero, /PR checks \(0 PRs read\): none/)
  })

  test('prints "at least N" for a truncated tree and prints each flag', () => {
    const text = render({
      login: 'o',
      entries: [
        entry(
          'o/a',
          { state: 'set up', missing: [], flags: ['no tests, short track off'], layers: ['base'] },
          { testFileCount: 7, testFilesTruncated: true }
        ),
      ],
    })
    assert.match(text, /test files: at least 7/)
    assert.match(text, /flag: no tests, short track off/)
  })

  test('prints protection, auto merge, required checks and pipeline labels for a set-up repo', () => {
    const text = render({ login: 'o', entries: [entry('o/a', setUp)] })
    assert.match(text, /^ {2}protection: present$/m)
    assert.match(text, /^ {2}auto merge: on$/m)
    assert.match(text, /^ {2}required checks: Unit tests$/m)
    assert.match(text, /^ {2}pipeline labels: no$/m)
  })

  test('lists every required check, including one that never runs on PRs', () => {
    const protection = { kind: 'present', requiredChecks: ['Unit tests', 'stale-check'], prRequired: true, forcePushesOff: true, enforceAdmins: true, strict: true }
    const text = render({ login: 'o', entries: [entry('o/a', setUp, { protection })] })
    assert.match(text, /^ {2}required checks: Unit tests, stale-check$/m)
  })

  test('says none for required checks when protection has none', () => {
    const protection = { kind: 'present', requiredChecks: [], prRequired: true, forcePushesOff: true }
    const text = render({ login: 'o', entries: [entry('o/a', setUp, { protection })] })
    assert.match(text, /^ {2}protection: present$/m)
    assert.match(text, /^ {2}required checks: none$/m)
  })

  test('prints protection none, auto merge off and pipeline labels yes', () => {
    const text = render({
      login: 'o',
      entries: [
        entry('o/a', { state: 'not set up', missing: ['branch protection'], flags: [], layers: ['base'] }, {
          protection: { kind: 'none' },
          allowAutoMerge: false,
          pipelineLabels: true,
        }),
      ],
    })
    assert.match(text, /^ {2}protection: none$/m)
    assert.match(text, /^ {2}auto merge: off$/m)
    assert.match(text, /^ {2}required checks: none$/m)
    assert.match(text, /^ {2}pipeline labels: yes$/m)
  })

  test('prints protection as not available on the current plan', () => {
    const text = render({
      login: 'o',
      entries: [
        entry(
          'o/a',
          { state: 'blocked', reason: 'branch protection is not available on the current plan', missing: [], flags: [], layers: ['base'] },
          { protection: { kind: 'unavailable', message: 'Upgrade to GitHub Pro' } }
        ),
      ],
    })
    assert.match(text, /^ {2}protection: not available on the current plan$/m)
    assert.match(text, /^ {2}required checks: none$/m)
  })

  test('prints applies to admins, up to date required and squash merge', () => {
    const on = render({ login: 'o', entries: [entry('o/a', setUp)] })
    assert.match(on, /^ {2}applies to admins: yes$/m)
    assert.match(on, /^ {2}up to date required: yes$/m)
    assert.match(on, /^ {2}squash merge: allowed$/m)

    const protection = { kind: 'present', requiredChecks: [], prRequired: true, forcePushesOff: true, enforceAdmins: false, strict: false }
    const off = render({ login: 'o', entries: [entry('o/a', setUp, { protection, allowSquashMerge: false })] })
    assert.match(off, /^ {2}applies to admins: no$/m)
    assert.match(off, /^ {2}up to date required: no$/m)
    assert.match(off, /^ {2}squash merge: not allowed$/m)

    const none = render({ login: 'o', entries: [entry('o/a', setUp, { protection: { kind: 'none' } })] })
    assert.match(none, /^ {2}applies to admins: no$/m)
    assert.match(none, /^ {2}up to date required: no$/m)
  })

  test('leaves out the two protection lines when protection is not available', () => {
    const text = render({
      login: 'o',
      entries: [entry('o/a', { state: 'blocked', reason: 'x', missing: [], flags: [], layers: ['base'] }, { protection: { kind: 'unavailable' } })],
    })
    assert.doesNotMatch(text, /applies to admins/)
    assert.doesNotMatch(text, /up to date required/)
    assert.match(text, /^ {2}squash merge: allowed$/m)
  })

  test('prints the not-required line only when names exist', () => {
    const some = render({ login: 'o', entries: [entry('o/a', { ...setUp, notRequired: ['A', 'B'] })] })
    assert.match(some, /^ {2}not required: no longer runs: A, B$/m)
    const none = render({ login: 'o', entries: [entry('o/a', { ...setUp, notRequired: [] })] })
    assert.doesNotMatch(none, /not required:/)
    assert.doesNotMatch(render({ login: 'o', entries: [entry('o/a', setUp)] }), /not required:/)
  })

  test('uses no em dashes', () => {
    const text = render({
      login: 'o',
      entries: [entry('o/a', { state: 'set up', missing: [], flags: [], layers: ['base'] })],
    })
    assert.equal(text.includes('—'), false)
  })
})

// ===========================================================================
// Apply (issue #481). Nothing below spawns gh: every call goes to a fake.
// ===========================================================================

const TARGET = { repo: 'octo/widget', branch: 'main' }

// The six labels tm-kickoff and tm-advisor also create. The values are copied here on
// purpose: a change to the script's table has to show up as a test failure.
const LABELS = [
  { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
  { name: 'size:M', color: 'BFD4F2', description: '1 to 3 hours. Write a sub-plan first.' },
  { name: 'size:L', color: 'F9D0C4', description: '4 to 6 hours. Split or checkpoint.' },
  { name: 'size:XL', color: 'D93F0B', description: 'About 8 hours. Too big. Split it.' },
  { name: 'in-progress', color: 'FBCA04', description: 'Package dispatched by /kickoff; resume, do not restart.' },
  { name: 'needs-human', color: 'B60205', description: 'Agent loop exhausted or blocked; human decision needed.' },
]
const labelPost = (l) => ({ method: 'POST', path: 'repos/octo/widget/labels', body: { name: l.name, color: l.color, description: l.description } })
const labelPatch = (l) => ({
  method: 'PATCH',
  path: `repos/octo/widget/labels/${encodeURIComponent(l.name)}`,
  body: { color: l.color, description: l.description },
})

// The PUT body Apply sends for a repo with no protection and one current check.
const noProtection = baseFacts({ protection: { kind: 'none' }, allowAutoMerge: false, allowSquashMerge: false })

// ---------------------------------------------------------------------------
// buildWrites
// ---------------------------------------------------------------------------
describe('buildWrites', () => {
  const putBody = (over = {}) => ({
    required_status_checks: { strict: true, contexts: ['Unit tests'] },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      dismiss_stale_reviews: false,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: false,
    required_conversation_resolution: false,
    block_creations: false,
    lock_branch: false,
    allow_fork_syncing: false,
    ...over,
  })

  test('protection only: one PUT to the branch protection path', () => {
    const facts = { ...noProtection, allowAutoMerge: true, allowSquashMerge: true }
    assert.deepEqual(buildWrites(TARGET, facts), [
      { method: 'PUT', path: 'repos/octo/widget/branches/main/protection', body: putBody() },
    ])
  })

  test('repo only: one PATCH with just the settings that are off', () => {
    assert.deepEqual(buildWrites(TARGET, baseFacts({ allowAutoMerge: false })), [
      { method: 'PATCH', path: 'repos/octo/widget', body: { allow_auto_merge: true } },
    ])
    assert.deepEqual(buildWrites(TARGET, baseFacts({ allowSquashMerge: false })), [
      { method: 'PATCH', path: 'repos/octo/widget', body: { allow_squash_merge: true } },
    ])
  })

  test('both: protection first, then the repo settings', () => {
    const ops = buildWrites(TARGET, noProtection)
    assert.deepEqual(
      ops.map((o) => o.method),
      ['PUT', 'PATCH']
    )
    assert.deepEqual(ops[1].body, { allow_auto_merge: true, allow_squash_merge: true })
  })

  test('nothing to change gives no writes', () => {
    assert.deepEqual(buildWrites(TARGET, baseFacts()), [])
  })

  test('copied values pass through into the PUT', () => {
    const facts = baseFacts({
      protection: {
        ...PROTECTED,
        prRequired: false,
        carry: {
          required_linear_history: true,
          required_conversation_resolution: true,
          block_creations: true,
          lock_branch: true,
          allow_fork_syncing: true,
          dismiss_stale_reviews: true,
        },
      },
    })
    const [put] = buildWrites(TARGET, facts)
    assert.equal(put.body.required_linear_history, true)
    assert.equal(put.body.required_conversation_resolution, true)
    assert.equal(put.body.block_creations, true)
    assert.equal(put.body.lock_branch, true)
    assert.equal(put.body.allow_fork_syncing, true)
    assert.equal(put.body.required_pull_request_reviews.dismiss_stale_reviews, true)
  })

  test('required contexts are the desired set, sorted', () => {
    const facts = baseFacts({
      pipelineLabels: true,
      ciChecks: ['zz', 'Unit tests'],
      protection: { ...PROTECTED, requiredChecks: ['Gone'] },
    })
    const [put] = buildWrites(TARGET, facts)
    assert.deepEqual(put.body.required_status_checks, {
      strict: true,
      contexts: ['Unit tests', 'orchestrai/review', 'orchestrai/test', 'zz'],
    })
  })

  test('the branch name is encoded in the path', () => {
    const [put] = buildWrites({ repo: 'octo/widget', branch: 'release/1' }, noProtection)
    assert.equal(put.path, 'repos/octo/widget/branches/release%2F1/protection')
  })

  test('returns no writes exactly when there is nothing to change', () => {
    // The CI setup path writes the labels and the tests check, so what is left
    // to change is judged on the facts after Apply, as buildWrites does.
    for (const [name, facts] of Object.entries(FIXTURES)) {
      assert.equal(buildWrites(TARGET, facts).length === 0, planChanges(factsAfterApply(facts)).changes.length === 0, name)
    }
  })

  describe('labels on the CI setup path', () => {
    // Test files and no finished PR check: where Apply refuses today.
    const ciPath = (over = {}) => baseFacts({ ...NO_CI, ...over })
    const labelOps = (ops) => ops.filter((o) => o.path.includes('/labels'))
    const have = (l, over = {}) => ({ name: l.name, color: l.color, description: l.description, ...over })

    test('no labels yet: six creates in table order, then the PUT, then the repo PATCH', () => {
      const ops = buildWrites(TARGET, ciPath({ protection: { kind: 'none' }, allowAutoMerge: false }))
      assert.deepEqual(ops.slice(0, 6), LABELS.map(labelPost))
      assert.deepEqual(
        ops.slice(6).map((o) => o.method),
        ['PUT', 'PATCH']
      )
      assert.equal(ops.length, 8)
    })

    test('the PUT requires the tests check and both verdict checks', () => {
      const ops = buildWrites(TARGET, ciPath())
      const put = ops.find((o) => o.method === 'PUT')
      assert.deepEqual(put.body.required_status_checks.contexts, ['orchestrai/review', 'orchestrai/test', 'tests'])
    })

    test('labels that already match are not written, and the PUT still requires the verdicts', () => {
      const ops = buildWrites(TARGET, ciPath({ labels: LABELS.map((l) => have(l)), pipelineLabels: true }))
      assert.deepEqual(labelOps(ops), [])
      assert.deepEqual(ops[0].body.required_status_checks.contexts, ['orchestrai/review', 'orchestrai/test', 'tests'])
    })

    test('a color that differs only in case is not a difference', () => {
      const labels = LABELS.map((l) => have(l, { color: l.color.toLowerCase() === l.color ? l.color.toUpperCase() : l.color.toLowerCase() }))
      assert.deepEqual(labelOps(buildWrites(TARGET, ciPath({ labels }))), [])
    })

    test('one label with another color: one PATCH on its encoded path, the other five are not written', () => {
      const labels = LABELS.map((l) => have(l, l.name === 'size:S' ? { color: '000000' } : {}))
      const ops = labelOps(buildWrites(TARGET, ciPath({ labels })))
      assert.deepEqual(ops, [
        { method: 'PATCH', path: 'repos/octo/widget/labels/size%3AS', body: { color: 'c2e0c6', description: 'Under 1 hour. One focused change.' } },
      ])
    })

    test('a missing description counts as an empty one, so the label is updated', () => {
      const labels = LABELS.map((l) => have(l, l.name === 'needs-human' ? { description: null } : {}))
      const ops = labelOps(buildWrites(TARGET, ciPath({ labels })))
      assert.deepEqual(ops.map((o) => [o.method, o.path]), [['PATCH', 'repos/octo/widget/labels/needs-human']])
    })

    test('a label with the same name in another case is created, not updated', () => {
      const labels = [have(LABELS[0], { name: 'SIZE:S' })]
      const ops = labelOps(buildWrites(TARGET, ciPath({ labels })))
      assert.deepEqual(ops, LABELS.map(labelPost))
    })

    test('a repo that already has CI gets no label writes', () => {
      assert.deepEqual(labelOps(buildWrites(TARGET, baseFacts({ protection: { kind: 'none' } }))), [])
    })

    test('a repo with no test files gets no label writes', () => {
      assert.deepEqual(labelOps(buildWrites(TARGET, ciPath({ testFileCount: 0, protection: { kind: 'none' } }))), [])
    })

    test('every label write passes the write fence and fails the read guard', () => {
      const labels = LABELS.map((l, i) => (i === 0 ? have(l, { color: '000000' }) : i === 1 ? have(l) : null)).filter(Boolean)
      const ops = labelOps(buildWrites(TARGET, ciPath({ labels })))
      assert.equal(ops.length, 5)
      for (const op of ops) {
        assert.equal(isAllowedWrite(writeArgs(op), op.body, TARGET), true, op.path)
        assert.equal(isReadOnly(writeArgs(op)), false, op.path)
      }
    })
  })

  describe('factsAfterApply', () => {
    test('on the CI setup path it adds the tests check and the pipeline labels', () => {
      const facts = baseFacts(NO_CI)
      const after = factsAfterApply(facts)
      assert.deepEqual(after.ciChecks, ['tests'])
      assert.equal(after.pipelineLabels, true)
      assert.equal(after.testFileCount, facts.testFileCount)
      assert.deepEqual(facts.ciChecks, [], 'the input is not changed')
      assert.equal(facts.pipelineLabels, false)
    })

    test('anywhere else it returns the facts as they are', () => {
      const withCi = baseFacts()
      const noTests = baseFacts({ ...NO_CI, testFileCount: 0 })
      assert.equal(factsAfterApply(withCi), withCi)
      assert.equal(factsAfterApply(noTests), noTests)
    })

    test('the plan after Apply is one the read after the writes calls set up', () => {
      const after = factsAfterApply(baseFacts({ ...NO_CI, protection: { kind: 'none' } }))
      assert.equal(planChanges(after).needsCi, false)
      assert.deepEqual(planChanges(after).requiredChecks, ['orchestrai/review', 'orchestrai/test', 'tests'])
    })
  })

  test('every write passes the write fence and fails the read guard', () => {
    for (const [name, facts] of Object.entries(FIXTURES)) {
      for (const op of buildWrites(TARGET, facts)) {
        const args = writeArgs(op)
        assert.equal(isAllowedWrite(args, op.body, TARGET), true, `${name}: ${args.join(' ')}`)
        assert.equal(isReadOnly(args), false, `${name}: ${args.join(' ')}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// confirmToken
// ---------------------------------------------------------------------------
describe('confirmToken', () => {
  const ops = buildWrites(TARGET, noProtection)

  test('is 12 hex characters and stable', () => {
    assert.match(confirmToken(TARGET, ops), /^[0-9a-f]{12}$/)
    assert.equal(confirmToken(TARGET, ops), confirmToken(TARGET, buildWrites(TARGET, noProtection)))
  })

  test('does not depend on key order', () => {
    const shuffled = ops.map((o) => ({ body: o.body, path: o.path, method: o.method }))
    assert.equal(confirmToken({ branch: 'main', repo: 'octo/widget' }, shuffled), confirmToken(TARGET, ops))
  })

  test('changes with the repo, the branch and the exact bodies', () => {
    const base = confirmToken(TARGET, ops)
    assert.notEqual(confirmToken({ ...TARGET, repo: 'octo/other' }, ops), base)
    assert.notEqual(confirmToken({ ...TARGET, branch: 'dev' }, ops), base)
    const more = buildWrites(TARGET, { ...noProtection, ciChecks: ['Unit tests', 'lint'] })
    assert.notEqual(confirmToken(TARGET, more), base)
  })

  test('a token for a plan without CI is the same as before the ci argument existed', () => {
    // Pinned from the code as it stood before #551, so a change here breaks every shown token.
    assert.equal(confirmToken(TARGET, ops), '1b334b7c4fd6')
    assert.equal(confirmToken(TARGET, ops, undefined), '1b334b7c4fd6')
    assert.equal(confirmToken(TARGET, ops, null), '1b334b7c4fd6')
  })

  test('covers the ci object, the file text included', () => {
    const ci = { install: 'npm ci', test: 'npm test', text: 'name: CI\n', check: 'tests' }
    const base = confirmToken(TARGET, ops)
    const withCi = confirmToken(TARGET, ops, ci)
    assert.notEqual(withCi, base)
    assert.equal(withCi, confirmToken(TARGET, ops, { ...ci }))
    assert.notEqual(confirmToken(TARGET, ops, { ...ci, text: 'name: CI \n' }), withCi)
    assert.notEqual(confirmToken(TARGET, ops, { ...ci, test: 'npm run t' }), withCi)
    assert.notEqual(confirmToken(TARGET, ops, { ...ci, install: null }), withCi)
  })
})

describe('buildWrites on the CI setup path', () => {
  const needsCi = baseFacts({ ...NO_CI, protection: { kind: 'none' }, allowAutoMerge: false, allowSquashMerge: false })

  test('buildWrites on a repo that needs CI requires tests and both verdict checks', () => {
    const put = buildWrites(TARGET, needsCi).find((op) => op.method === 'PUT')
    assert.deepEqual(put.body.required_status_checks, {
      strict: true,
      contexts: ['orchestrai/review', 'orchestrai/test', 'tests'],
    })
  })
})

// ---------------------------------------------------------------------------
// planText and opText
// ---------------------------------------------------------------------------
describe('planText', () => {
  const ciFacts = baseFacts({ ...NO_CI, protection: { kind: 'none' }, allowAutoMerge: false })
  const plan = planChanges(factsAfterApply(ciFacts))
  const ops = buildWrites(TARGET, ciFacts)
  const text = planText(TARGET, plan, ops, confirmToken(TARGET, ops))
  const lines = text.trimEnd().split('\n')

  test('prints a labels block straight after the header line', () => {
    assert.match(lines[0], /^octo\/widget: not set up/)
    assert.equal(lines[1], 'labels:')
    assert.equal(lines[2], '  create size:S, color c2e0c6: Under 1 hour. One focused change.')
    assert.equal(lines[7], '  create needs-human, color B60205: Agent loop exhausted or blocked; human decision needed.')
    assert.equal(lines[8], 'changes:')
  })

  test('prints an update line for a label that differs', () => {
    const labels = LABELS.map((l) => ({ ...l, color: l.name === 'size:M' ? '000000' : l.color }))
    const withUpdate = buildWrites(TARGET, { ...ciFacts, labels })
    const got = planText(TARGET, plan, withUpdate, 'abc').split('\n')
    assert.equal(got[1], 'labels:')
    assert.equal(got[2], '  update size:M, color BFD4F2: 1 to 3 hours. Write a sub-plan first.')
    assert.equal(got[3], 'changes:')
  })

  test('names the label on each write line, because the six creates share one path', () => {
    assert.ok(lines.includes('  POST repos/octo/widget/labels (size:S)'))
    assert.ok(lines.includes('  POST repos/octo/widget/labels (needs-human)'))
    assert.ok(lines.includes('  PUT repos/octo/widget/branches/main/protection'))
    assert.ok(lines.includes('  PATCH repos/octo/widget'))
  })

  test('prints no labels block when no label is written', () => {
    const noLabels = buildWrites(TARGET, noProtection)
    const got = planText(TARGET, planChanges(noProtection), noLabels, 'abc')
    assert.equal(got.includes('labels:'), false)
    assert.match(got, /^octo\/widget: not set up \(default branch main\)\nchanges:\n/)
  })

  test('the token is the last line and the required checks include the verdicts', () => {
    assert.match(lines.at(-1), /^confirm token: [0-9a-f]{12}$/)
    assert.ok(lines.includes('required checks after apply: orchestrai/review, orchestrai/test, tests'))
  })

  test('the token changes when a label body changes', () => {
    const other = ops.map((o) => (o.path.endsWith('/labels') && o.body.name === 'size:S' ? { ...o, body: { ...o.body, color: '000000' } } : o))
    assert.notEqual(confirmToken(TARGET, other), confirmToken(TARGET, ops))
  })
})

describe('opText', () => {
  test('is the method and path, plus the label name for a label write', () => {
    assert.equal(opText({ method: 'PUT', path: 'repos/octo/widget/branches/main/protection', body: {} }), 'PUT repos/octo/widget/branches/main/protection')
    assert.equal(opText({ method: 'PATCH', path: 'repos/octo/widget', body: {} }), 'PATCH repos/octo/widget')
    assert.equal(opText(labelPost(LABELS[0])), 'POST repos/octo/widget/labels (size:S)')
    assert.equal(opText(labelPatch(LABELS[0])), 'PATCH repos/octo/widget/labels/size%3AS (size:S)')
  })

  test('a repo whose owner is named labels is still a plain repo write', () => {
    assert.equal(opText({ method: 'PATCH', path: 'repos/labels/widget', body: {} }), 'PATCH repos/labels/widget')
  })
})

// ---------------------------------------------------------------------------
// The CI setup writes (issue #561). The texts are copied here on purpose, the
// same way LABELS is: a change to the script's constants has to fail a test.
// ---------------------------------------------------------------------------
const CI_BRANCH = 'orchestrai/ci-setup'
const CI_FILE = '.github/workflows/ci.yml'
const CI_MESSAGE = 'ci: add the tests workflow'
const CI_TITLE = 'ci: add the tests workflow'
const CI_BODY =
  'Added by /tm-repo-guard apply. The guard merges this PR once the tests check passes, then makes tests a required check.'
const CI_TEXT = 'name: tests\non: [pull_request]\njobs:\n  tests:\n    runs-on: ubuntu-latest\n'
const BASE_SHA = 'a'.repeat(40)
const PR_SHA = 'b'.repeat(40)
const STALE_SHA = '1'.repeat(40)
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

const CI_NO_PR = { text: CI_TEXT, pr: null }
const CI_WITH_PR = { text: CI_TEXT, pr: { number: 12, sha: PR_SHA } }

// One accepted call per CI write: the args, the input, and the context that must accept it.
const ciRef = {
  args: ['api', '-X', 'POST', 'repos/octo/widget/git/refs', '--input', '-'],
  body: { ref: `refs/heads/${CI_BRANCH}`, sha: BASE_SHA },
}
const ciFile = {
  args: ['api', '-X', 'PUT', `repos/octo/widget/contents/${CI_FILE}`, '--input', '-'],
  body: { message: CI_MESSAGE, content: b64(CI_TEXT), branch: CI_BRANCH },
}
const ciPull = {
  args: ['api', '-X', 'POST', 'repos/octo/widget/pulls', '--input', '-'],
  body: { title: CI_TITLE, head: CI_BRANCH, base: 'main', body: CI_BODY, draft: false },
}
const ciMerge = {
  args: ['api', '-X', 'PUT', 'repos/octo/widget/pulls/12/merge', '--input', '-'],
  body: { merge_method: 'squash', sha: PR_SHA },
}
const ciDelete = {
  args: ['api', '-X', 'DELETE', `repos/octo/widget/git/refs/heads/${CI_BRANCH}`],
  body: undefined,
}
const CI_WRITES = { ref: ciRef, file: ciFile, pull: ciPull, merge: ciMerge, delete: ciDelete }

// ---------------------------------------------------------------------------
// Write fence
// ---------------------------------------------------------------------------
describe('isAllowedWrite', () => {
  const [put, patch] = buildWrites(TARGET, noProtection)
  const putArgs = writeArgs(put)
  const patchArgs = writeArgs(patch)
  const okPut = (over) => ({ ...put.body, ...over })

  test('accepts the exact protection PUT and the exact repo PATCH', () => {
    assert.equal(isAllowedWrite(putArgs, put.body, TARGET), true)
    assert.equal(isAllowedWrite(patchArgs, patch.body, TARGET), true)
    assert.equal(isAllowedWrite(patchArgs, { allow_auto_merge: true }, TARGET), true)
    assert.equal(isAllowedWrite(patchArgs, { allow_squash_merge: true }, TARGET), true)
  })

  test('encodes the branch the same way the path builder does', () => {
    const target = { repo: 'octo/widget', branch: 'release/1' }
    const args = ['api', '-X', 'PUT', 'repos/octo/widget/branches/release%2F1/protection', '--input', '-']
    assert.equal(isAllowedWrite(args, put.body, target), true)
    assert.equal(isAllowedWrite(putArgs, put.body, target), false)
  })

  const refusedCalls = [
    ['another repo', ['api', '-X', 'PUT', 'repos/octo/other/branches/main/protection', '--input', '-']],
    ['another branch', ['api', '-X', 'PUT', 'repos/octo/widget/branches/dev/protection', '--input', '-']],
    ['DELETE on the protection path', ['api', '-X', 'DELETE', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    ['POST on the protection path', ['api', '-X', 'POST', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    ['--method= form', ['api', '--method=PUT', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    ['-XPUT form', ['api', '-XPUT', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    ['-f field', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection', '-f', 'a=b']],
    ['-F field', ['api', '-X', 'PATCH', 'repos/octo/widget', '-F', 'archived=true']],
    ['no --input', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection']],
    ['input from a file', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection', '--input', 'body.json']],
    ['an extra flag', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection', '--input', '-', '--paginate']],
    ['PATCH on another repo', ['api', '-X', 'PATCH', 'repos/octo/other', '--input', '-']],
    ['DELETE on the repo', ['api', '-X', 'DELETE', 'repos/octo/widget', '--input', '-']],
    ['PUT on the repo path', ['api', '-X', 'PUT', 'repos/octo/widget', '--input', '-']],
    // The path must match exactly: a longer path, a query string or a longer repo name is not the fenced path.
    ['PUT on a longer protection path', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection/required_status_checks/contexts', '--input', '-']],
    ['PUT with a query string', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection?x=1', '--input', '-']],
    ['PATCH on a longer repo name', ['api', '-X', 'PATCH', 'repos/octo/widget-x', '--input', '-']],
    ['PATCH on the protection path', ['api', '-X', 'PATCH', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    // Each of these has the right shape except for one of the three fixed
    // tokens (command, method flag, input flag), so dropping that check passes.
    ['another command, PATCH path', ['repo', '-X', 'PATCH', 'repos/octo/widget', '--input', '-']],
    ['another method flag, PATCH path', ['api', '-H', 'PATCH', 'repos/octo/widget', '--input', '-']],
    ['another input flag, PATCH path', ['api', '-X', 'PATCH', 'repos/octo/widget', '--jq', '-']],
    ['another command, PUT path', ['repo', '-X', 'PUT', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    ['another method flag, PUT path', ['api', '-H', 'PUT', 'repos/octo/widget/branches/main/protection', '--input', '-']],
    ['another input flag, PUT path', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection', '--jq', '-']],
    ['graphql', ['api', 'graphql', '--input', '-']],
    ['a status post', ['api', '-X', 'POST', 'repos/octo/widget/statuses/abc123', '--input', '-']],
    ['a labels post', ['api', '-X', 'POST', 'repos/octo/widget/labels', '--input', '-']],
    ['pr merge', ['pr', 'merge', '12', '--auto', '--squash']],
    ['repo edit', ['repo', 'edit', 'octo/widget', '--enable-auto-merge']],
    ['a plain read', ['api', 'repos/octo/widget']],
    ['no args', []],
  ]
  for (const [name, args] of refusedCalls) {
    test(`refuses ${name}`, () => {
      assert.equal(isAllowedWrite(args, put.body, TARGET), false)
      assert.equal(isAllowedWrite(args, { allow_auto_merge: true }, TARGET), false)
    })

    // The CI routes must not reopen anything the table above covers.
    test(`refuses ${name}, with a full CI context too`, () => {
      const bodies = [put.body, { allow_auto_merge: true }, ...Object.values(CI_WRITES).map((w) => w.body)]
      for (const body of bodies) assert.equal(isAllowedWrite(args, body, TARGET, CI_WITH_PR), false)
    })
  }

  const badPut = [
    ['an extra key', okPut({ name: 'renamed' })],
    ['a missing key', (({ lock_branch, ...rest }) => rest)(put.body)],
    ['enforce_admins off', okPut({ enforce_admins: false })],
    ['force pushes on', okPut({ allow_force_pushes: true })],
    ['deletions on', okPut({ allow_deletions: true })],
    ['restrictions set', okPut({ restrictions: { users: [], teams: [] } })],
    ['one approval', okPut({ required_pull_request_reviews: { ...put.body.required_pull_request_reviews, required_approving_review_count: 1 } })],
    ['code-owner review', okPut({ required_pull_request_reviews: { ...put.body.required_pull_request_reviews, require_code_owner_reviews: true } })],
    ['last-push approval', okPut({ required_pull_request_reviews: { ...put.body.required_pull_request_reviews, require_last_push_approval: true } })],
    ['an extra review key', okPut({ required_pull_request_reviews: { ...put.body.required_pull_request_reviews, bypass_pull_request_allowances: {} } })],
    ['no review block', okPut({ required_pull_request_reviews: null })],
    ['not strict', okPut({ required_status_checks: { strict: false, contexts: [] } })],
    ['checks next to contexts', okPut({ required_status_checks: { strict: true, contexts: [], checks: [] } })],
    ['an empty context name', okPut({ required_status_checks: { strict: true, contexts: [''] } })],
    ['contexts not an array', okPut({ required_status_checks: { strict: true, contexts: 'Unit tests' } })],
    ['a null status block', okPut({ required_status_checks: null })],
    ['a copied value that is not a boolean', okPut({ lock_branch: 'false' })],
    ['a non-boolean dismiss_stale_reviews', okPut({ required_pull_request_reviews: { ...put.body.required_pull_request_reviews, dismiss_stale_reviews: 'true' } })],
    ['a null body', null],
    ['an array body', []],
    ['a string body', '{}'],
  ]
  for (const [name, body] of badPut) {
    test(`refuses a PUT with ${name}`, () => {
      assert.equal(isAllowedWrite(putArgs, body, TARGET), false)
    })
  }

  const badPatch = [
    ['an empty object', {}],
    ['a rename', { name: 'renamed' }],
    ['archive', { archived: true }],
    ['visibility', { private: false }],
    ['a new default branch', { default_branch: 'dev' }],
    ['a field next to the allowed one', { allow_auto_merge: true, archived: true }],
    ['auto merge turned off', { allow_auto_merge: false }],
    ['squash turned off', { allow_squash_merge: false }],
    ['a string true', { allow_auto_merge: 'true' }],
    ['merge commits turned off', { allow_merge_commit: false }],
    ['a null body', null],
    ['an array body', [{ allow_auto_merge: true }]],
  ]
  for (const [name, body] of badPatch) {
    test(`refuses a PATCH with ${name}`, () => {
      assert.equal(isAllowedWrite(patchArgs, body, TARGET), false)
    })
  }
})

describe('isAllowedWrite: labels', () => {
  for (const l of LABELS) {
    test(`accepts the create for ${l.name}`, () => {
      const op = labelPost(l)
      assert.equal(isAllowedWrite(writeArgs(op), op.body, TARGET), true)
    })
    test(`accepts the update for ${l.name} on its own encoded path`, () => {
      const op = labelPatch(l)
      assert.equal(isAllowedWrite(writeArgs(op), op.body, TARGET), true)
    })
  }

  const [s, m] = LABELS
  const postArgs = writeArgs(labelPost(s))
  const patchArgs = writeArgs(labelPatch(s))
  const post = (body) => isAllowedWrite(postArgs, body, TARGET)
  const patch = (body) => isAllowedWrite(patchArgs, body, TARGET)

  const badCreate = [
    ['a seventh name', { ...labelPost(s).body, name: 'size:XXL' }],
    ['a name in another case', { ...labelPost(s).body, name: 'SIZE:S' }],
    ['a wrong color', { ...labelPost(s).body, color: '000000' }],
    ['the right color in another case', { ...labelPost(s).body, color: 'C2E0C6' }],
    ['a wrong description', { ...labelPost(s).body, description: 'Something else.' }],
    ['no description', { name: s.name, color: s.color }],
    ['an extra key', { ...labelPost(s).body, new_name: 'size:Z' }],
    ['the color and description of another label', { name: s.name, color: m.color, description: m.description }],
    ['a null body', null],
    ['an array body', [labelPost(s).body]],
    ['a string body', '{}'],
  ]
  for (const [name, body] of badCreate) {
    test(`refuses a create with ${name}`, () => assert.equal(post(body), false))
  }

  const badUpdate = [
    ['a name key', { name: s.name, color: s.color, description: s.description }],
    ['an extra new_name key', { ...labelPatch(s).body, new_name: 'size:Z' }],
    ['a missing description', { color: s.color }],
    ['a missing color', { description: s.description }],
    ['a wrong color', { ...labelPatch(s).body, color: '000000' }],
    ['the right color in another case', { ...labelPatch(s).body, color: 'C2E0C6' }],
    ['a wrong description', { ...labelPatch(s).body, description: 'Something else.' }],
    ["another label's body on this path", labelPatch(m).body],
    ['a null body', null],
    ['an array body', [labelPatch(s).body]],
    ['a string body', '{}'],
  ]
  for (const [name, body] of badUpdate) {
    test(`refuses an update with ${name}`, () => assert.equal(patch(body), false))
  }

  const refused = [
    ['an update on a path that is not encoded', ['api', '-X', 'PATCH', 'repos/octo/widget/labels/size:S', '--input', '-'], labelPatch(s).body],
    ['an update on a seventh name', ['api', '-X', 'PATCH', 'repos/octo/widget/labels/bug', '--input', '-'], labelPatch(s).body],
    ['an update on a name in another case', ['api', '-X', 'PATCH', 'repos/octo/widget/labels/SIZE%3AS', '--input', '-'], labelPatch(s).body],
    ['an update on a path with a query string', ['api', '-X', 'PATCH', 'repos/octo/widget/labels/size%3AS?x=1', '--input', '-'], labelPatch(s).body],
    ['a create on another repo', ['api', '-X', 'POST', 'repos/octo/other/labels', '--input', '-'], labelPost(s).body],
    ['an update on another repo', ['api', '-X', 'PATCH', 'repos/octo/other/labels/size%3AS', '--input', '-'], labelPatch(s).body],
    ['a create on a longer path', ['api', '-X', 'POST', 'repos/octo/widget/labels/size%3AS', '--input', '-'], labelPost(s).body],
    ['a delete on the labels path', ['api', '-X', 'DELETE', 'repos/octo/widget/labels', '--input', '-'], labelPost(s).body],
    ['a delete on a label path', ['api', '-X', 'DELETE', 'repos/octo/widget/labels/size%3AS', '--input', '-'], labelPatch(s).body],
    ['a PUT on a label path', ['api', '-X', 'PUT', 'repos/octo/widget/labels/size%3AS', '--input', '-'], labelPatch(s).body],
    ['a POST on the repo path', ['api', '-X', 'POST', 'repos/octo/widget', '--input', '-'], labelPost(s).body],
    ['a create with -f fields', ['api', '-X', 'POST', 'repos/octo/widget/labels', '-f', 'name=size:S'], labelPost(s).body],
  ]
  for (const [name, args, body] of refused) {
    test(`refuses ${name}`, () => assert.equal(isAllowedWrite(args, body, TARGET), false))
  }

  test('refuses the label read when given a label body', () => {
    const read = ['api', '--paginate', '--slurp', 'repos/octo/widget/labels?per_page=100']
    assert.equal(isAllowedWrite(read, labelPost(s).body, TARGET), false)
    assert.equal(isAllowedWrite(['api', 'repos/octo/widget/labels'], labelPost(s).body, TARGET), false)
  })

  test('the read guard refuses every label write', () => {
    for (const l of LABELS) {
      assert.equal(isReadOnly(writeArgs(labelPost(l))), false)
      assert.equal(isReadOnly(writeArgs(labelPatch(l))), false)
    }
  })

  test('a label path encodes the colon, so the fence and the path builder agree', () => {
    assert.equal(labelPatch(s).path, 'repos/octo/widget/labels/size%3AS')
  })
})

describe('writeArgs for the CI setup writes', () => {
  test('is the 6-argument form for a body and the 4-argument form for DELETE', () => {
    assert.deepEqual(writeArgs({ method: 'POST', path: 'repos/octo/widget/git/refs', body: ciRef.body }), ciRef.args)
    assert.deepEqual(writeArgs({ method: 'PUT', path: `repos/octo/widget/contents/${CI_FILE}`, body: ciFile.body }), ciFile.args)
    assert.deepEqual(writeArgs({ method: 'DELETE', path: `repos/octo/widget/git/refs/heads/${CI_BRANCH}` }), ciDelete.args)
  })
})

describe('isAllowedWrite: the CI setup writes', () => {
  const ok = (w, ci) => isAllowedWrite(w.args, w.body, TARGET, ci)

  test('accepts each of the five writes with a context that has a PR', () => {
    for (const [name, w] of Object.entries(CI_WRITES)) assert.equal(ok(w, CI_WITH_PR), true, name)
  })

  test('accepts the first three while the PR is still null, and refuses merge and delete', () => {
    assert.equal(ok(ciRef, CI_NO_PR), true)
    assert.equal(ok(ciFile, CI_NO_PR), true)
    assert.equal(ok(ciPull, CI_NO_PR), true)
    assert.equal(ok(ciMerge, CI_NO_PR), false)
    assert.equal(ok(ciDelete, CI_NO_PR), false)
  })

  test('the PR base is the target branch', () => {
    const release = { repo: 'octo/widget', branch: 'release/1' }
    assert.equal(isAllowedWrite(ciPull.args, { ...ciPull.body, base: 'release/1' }, release, CI_NO_PR), true)
    assert.equal(isAllowedWrite(ciPull.args, ciPull.body, release, CI_NO_PR), false)
  })

  test('with no CI context, which is the normal path, every one of them is refused', () => {
    for (const ci of [undefined, null]) {
      for (const [name, w] of Object.entries(CI_WRITES)) assert.equal(ok(w, ci), false, name)
    }
  })

  test('a malformed CI context refuses everything and never throws', () => {
    const contexts = [
      'text',
      42,
      [],
      {},
      { pr: { number: 12, sha: PR_SHA } },
      { text: undefined, pr: CI_WITH_PR.pr },
      { text: null, pr: CI_WITH_PR.pr },
      { text: 5, pr: CI_WITH_PR.pr },
      { text: ['a'], pr: CI_WITH_PR.pr },
    ]
    for (const ci of contexts) {
      for (const [name, w] of Object.entries(CI_WRITES)) {
        assert.doesNotThrow(() => ok(w, ci), `${name} with ${JSON.stringify(ci)}`)
        assert.equal(ok(w, ci), false, `${name} with ${JSON.stringify(ci)}`)
      }
    }
  })

  const badPrs = [
    ['a string PR number', { number: '12', sha: PR_SHA }],
    ['a zero PR number', { number: 0, sha: PR_SHA }],
    ['a negative PR number', { number: -12, sha: PR_SHA }],
    ['a fractional PR number', { number: 12.5, sha: PR_SHA }],
    ['no PR number', { sha: PR_SHA }],
    ['a short SHA', { number: 12, sha: PR_SHA.slice(0, 39) }],
    ['an uppercase SHA', { number: 12, sha: PR_SHA.toUpperCase() }],
    ['a non-hex SHA', { number: 12, sha: 'g'.repeat(40) }],
    ['no SHA', { number: 12 }],
    ['a PR that is a string', '12'],
    ['a PR that is an array', [12, PR_SHA]],
  ]
  for (const [name, pr] of badPrs) {
    test(`merge and delete are refused with ${name}`, () => {
      const ci = { text: CI_TEXT, pr }
      assert.equal(isAllowedWrite(ciMerge.args, { merge_method: 'squash', sha: pr.sha }, TARGET, ci), false)
      assert.equal(isAllowedWrite(['api', '-X', 'PUT', `repos/octo/widget/pulls/${pr.number}/merge`, '--input', '-'], ciMerge.body, TARGET, ci), false)
      assert.equal(ok(ciMerge, ci), false)
      assert.equal(ok(ciDelete, ci), false)
    })
  }

  // Each row changes one thing in an otherwise accepted call.
  const withBody = (w, over) => [w.args, { ...w.body, ...over }]
  const without = (w, key) => [w.args, (({ [key]: _, ...rest }) => rest)(w.body)]
  const withArgs = (w, args, body = w.body) => [args, body]
  const refused = [
    // create ref
    ['ref: refs/heads/main', ...withBody(ciRef, { ref: 'refs/heads/main' })],
    ['ref: another branch', ...withBody(ciRef, { ref: 'refs/heads/orchestrai/other' })],
    ['ref: a tag', ...withBody(ciRef, { ref: `refs/tags/${CI_BRANCH}` })],
    ['ref: no refs/heads prefix', ...withBody(ciRef, { ref: CI_BRANCH })],
    ['ref: a short sha', ...withBody(ciRef, { sha: 'a'.repeat(39) })],
    ['ref: a non-string sha', ...withBody(ciRef, { sha: 7 })],
    ['ref: an extra key', ...withBody(ciRef, { force: true })],
    ['ref: no sha', ...without(ciRef, 'sha')],
    ['ref: another repo', ...withArgs(ciRef, ['api', '-X', 'POST', 'repos/octo/other/git/refs', '--input', '-'])],
    ['ref: PUT instead of POST', ...withArgs(ciRef, ['api', '-X', 'PUT', 'repos/octo/widget/git/refs', '--input', '-'])],
    ['ref: PATCH an existing ref', ...withArgs(ciRef, ['api', '-X', 'PATCH', `repos/octo/widget/git/refs/heads/${CI_BRANCH}`, '--input', '-'])],
    // put file
    ['file: one byte off', ...withBody(ciFile, { content: b64(CI_TEXT + '\n') })],
    ['file: the text is not base64', ...withBody(ciFile, { content: CI_TEXT })],
    ['file: a sha key', ...withBody(ciFile, { sha: BASE_SHA })],
    ['file: branch main', ...withBody(ciFile, { branch: 'main' })],
    ['file: another message', ...withBody(ciFile, { message: 'chore: edit' })],
    ['file: an extra key', ...withBody(ciFile, { committer: { name: 'x', email: 'x@y.z' } })],
    ['file: no branch', ...without(ciFile, 'branch')],
    ['file: another file', ...withArgs(ciFile, ['api', '-X', 'PUT', 'repos/octo/widget/contents/.github/workflows/other.yml', '--input', '-'])],
    ['file: another repo', ...withArgs(ciFile, ['api', '-X', 'PUT', `repos/octo/other/contents/${CI_FILE}`, '--input', '-'])],
    ['file: a query string', ...withArgs(ciFile, ['api', '-X', 'PUT', `repos/octo/widget/contents/${CI_FILE}?ref=main`, '--input', '-'])],
    ['file: POST instead of PUT', ...withArgs(ciFile, ['api', '-X', 'POST', `repos/octo/widget/contents/${CI_FILE}`, '--input', '-'])],
    ['file: DELETE with a body', ...withArgs(ciFile, ['api', '-X', 'DELETE', `repos/octo/widget/contents/${CI_FILE}`, '--input', '-'])],
    // open PR
    ['pull: draft true', ...withBody(ciPull, { draft: true })],
    ['pull: draft as a string', ...withBody(ciPull, { draft: 'false' })],
    ['pull: head main', ...withBody(ciPull, { head: 'main' })],
    ['pull: a head from a fork', ...withBody(ciPull, { head: `evil:${CI_BRANCH}` })],
    ['pull: another base', ...withBody(ciPull, { base: 'dev' })],
    ['pull: another title', ...withBody(ciPull, { title: 'ci: other' })],
    ['pull: another body', ...withBody(ciPull, { body: 'hello' })],
    ['pull: an extra key', ...withBody(ciPull, { maintainer_can_modify: true })],
    ['pull: no draft key', ...without(ciPull, 'draft')],
    ['pull: another repo', ...withArgs(ciPull, ['api', '-X', 'POST', 'repos/octo/other/pulls', '--input', '-'])],
    ['pull: a path under pulls', ...withArgs(ciPull, ['api', '-X', 'POST', 'repos/octo/widget/pulls/12', '--input', '-'])],
    ['pull: PATCH on a PR', ...withArgs(ciPull, ['api', '-X', 'PATCH', 'repos/octo/widget/pulls/12', '--input', '-'], { state: 'closed' })],
    // merge
    ['merge: another PR number', ...withArgs(ciMerge, ['api', '-X', 'PUT', 'repos/octo/widget/pulls/13/merge', '--input', '-'])],
    ['merge: a path with undefined', ...withArgs(ciMerge, ['api', '-X', 'PUT', 'repos/octo/widget/pulls/undefined/merge', '--input', '-'])],
    ['merge: another repo', ...withArgs(ciMerge, ['api', '-X', 'PUT', 'repos/octo/other/pulls/12/merge', '--input', '-'])],
    ['merge: a commit_title key', ...withBody(ciMerge, { commit_title: 'x' })],
    ['merge: a commit_message key', ...withBody(ciMerge, { commit_message: 'x' })],
    ['merge: merge method merge', ...withBody(ciMerge, { merge_method: 'merge' })],
    ['merge: merge method rebase', ...withBody(ciMerge, { merge_method: 'rebase' })],
    ['merge: another sha', ...withBody(ciMerge, { sha: 'c'.repeat(40) })],
    ['merge: no sha', ...without(ciMerge, 'sha')],
    ['merge: POST instead of PUT', ...withArgs(ciMerge, ['api', '-X', 'POST', 'repos/octo/widget/pulls/12/merge', '--input', '-'])],
    ['merge: a query string', ...withArgs(ciMerge, ['api', '-X', 'PUT', 'repos/octo/widget/pulls/12/merge?x=1', '--input', '-'])],
    // delete ref
    ['delete: 6 arguments', ...withArgs(ciDelete, [...ciDelete.args, '--input', '-'])],
    ['delete: 5 arguments', ...withArgs(ciDelete, [...ciDelete.args, '--paginate'])],
    ['delete: refs/heads/main', ...withArgs(ciDelete, ['api', '-X', 'DELETE', 'repos/octo/widget/git/refs/heads/main'])],
    ['delete: another branch', ...withArgs(ciDelete, ['api', '-X', 'DELETE', 'repos/octo/widget/git/refs/heads/orchestrai/other'])],
    ['delete: a tag', ...withArgs(ciDelete, ['api', '-X', 'DELETE', `repos/octo/widget/git/refs/tags/${CI_BRANCH}`])],
    ['delete: a longer path', ...withArgs(ciDelete, ['api', '-X', 'DELETE', `repos/octo/widget/git/refs/heads/${CI_BRANCH}/x`])],
    ['delete: another repo', ...withArgs(ciDelete, ['api', '-X', 'DELETE', `repos/octo/other/git/refs/heads/${CI_BRANCH}`])],
    ['delete: with a body', ciDelete.args, {}],
    ['delete: the repo itself', ...withArgs(ciDelete, ['api', '-X', 'DELETE', 'repos/octo/widget'])],
    ['delete: GET method', ...withArgs(ciDelete, ['api', '-X', 'GET', `repos/octo/widget/git/refs/heads/${CI_BRANCH}`])],
    ['delete: --method form', ...withArgs(ciDelete, ['api', '--method=DELETE', `repos/octo/widget/git/refs/heads/${CI_BRANCH}`])],
    // 4 arguments of any other kind
    ['4 arguments: a PUT without --input', ['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection'], undefined],
    ['4 arguments: another command', ['repo', '-X', 'DELETE', `repos/octo/widget/git/refs/heads/${CI_BRANCH}`], undefined],
    ['4 arguments: another method flag', ['api', '-H', 'DELETE', `repos/octo/widget/git/refs/heads/${CI_BRANCH}`], undefined],
  ]
  for (const [name, args, body] of refused) {
    test(`refuses ${name}`, () => {
      assert.equal(isAllowedWrite(args, body, TARGET, CI_WITH_PR), false)
    })
  }

  test('a context with a PR and a context without one differ only on merge and delete', () => {
    const changed = Object.entries(CI_WRITES)
      .filter(([, w]) => ok(w, CI_WITH_PR) !== ok(w, CI_NO_PR))
      .map(([name]) => name)
    assert.deepEqual(changed, ['merge', 'delete'])
  })

  test('the text in the file body is bound to ci.text', () => {
    assert.equal(ok(ciFile, { text: CI_TEXT + '#', pr: null }), false)
    assert.equal(ok(ciFile, { text: CI_TEXT, pr: null }), true)
    assert.equal(ok(ciFile, { text: '', pr: null }), false)
  })

  test('multi-byte text is encoded as utf8', () => {
    const text = 'name: tests # caf\u00e9\n'
    const body = { ...ciFile.body, content: Buffer.from(text, 'utf8').toString('base64') }
    assert.equal(isAllowedWrite(ciFile.args, body, TARGET, { text, pr: null }), true)
    const latin1 = { ...ciFile.body, content: Buffer.from(text, 'latin1').toString('base64') }
    assert.equal(isAllowedWrite(ciFile.args, latin1, TARGET, { text, pr: null }), false)
  })
})

describe('writeGuarded', () => {
  const [put, patch] = buildWrites(TARGET, noProtection)

  test('sends an allowed write to the runner with the body as a JSON string', () => {
    const seen = []
    const w = writeGuarded((args, input) => {
      seen.push([args, input])
      return { code: 0, stdout: '{}', stderr: '' }
    }, TARGET)
    w(writeArgs(put), put.body)
    assert.deepEqual(seen, [[writeArgs(put), JSON.stringify(put.body)]])
  })

  test('passes the CI context to the fence, and forwards a body-less DELETE with no input', () => {
    const seen = []
    const w = writeGuarded((args, input) => {
      seen.push([args, input])
      return { code: 0, stdout: '{}', stderr: '' }
    }, TARGET, CI_WITH_PR)
    w(ciFile.args, ciFile.body)
    w(ciMerge.args, ciMerge.body)
    w(ciDelete.args, undefined)
    assert.deepEqual(seen, [
      [ciFile.args, JSON.stringify(ciFile.body)],
      [ciMerge.args, JSON.stringify(ciMerge.body)],
      [ciDelete.args, undefined],
    ])
  })

  test('without a CI context every CI write is refused before the runner sees it', () => {
    const seen = []
    const w = writeGuarded((args) => seen.push(args), TARGET)
    for (const c of Object.values(CI_WRITES)) assert.throws(() => w(c.args, c.body), /not an allowed write/)
    assert.deepEqual(seen, [])
  })

  test('refuses anything else before the runner sees it', () => {
    const seen = []
    const w = writeGuarded((args) => seen.push(args), TARGET)
    assert.throws(() => w(['api', 'repos/octo/widget'], undefined), /not an allowed write/)
    assert.throws(() => w(writeArgs(patch), { archived: true }), /not an allowed write/)
    assert.throws(() => w(['pr', 'merge', '1'], {}), /not an allowed write/)
    assert.deepEqual(seen, [])
  })
})

describe('the read guard and the write fence stay apart', () => {
  test('isReadOnly refuses every write the plan can produce', () => {
    for (const facts of Object.values(FIXTURES)) {
      for (const op of buildWrites(TARGET, facts)) assert.equal(isReadOnly(writeArgs(op)), false)
    }
    assert.equal(isReadOnly(['api', '-X', 'PUT', 'repos/octo/widget/branches/main/protection', '--input', '-']), false)
    assert.equal(isReadOnly(['api', '-X', 'PATCH', 'repos/octo/widget', '--input', '-']), false)
  })

  test('isAllowedWrite refuses every read call Check makes', () => {
    const [put, patch] = buildWrites(TARGET, noProtection)
    for (const args of ACCEPTED_READS) {
      assert.equal(isAllowedWrite(args, put.body, TARGET), false, args.join(' '))
      assert.equal(isAllowedWrite(args, patch.body, TARGET), false, args.join(' '))
    }
  })

  test('isReadOnly refuses the five CI setup writes', () => {
    for (const [name, w] of Object.entries(CI_WRITES)) assert.equal(isReadOnly(w.args), false, name)
  })

  test('isAllowedWrite refuses every read call Check makes, with a full CI context too', () => {
    for (const args of ACCEPTED_READS) {
      for (const w of Object.values(CI_WRITES)) {
        assert.equal(isAllowedWrite(args, w.body, TARGET, CI_WITH_PR), false, args.join(' '))
      }
    }
  })

  test('guarded never forwards a second argument, so a read cannot carry a body', () => {
    const seen = []
    const call = guarded((...a) => {
      seen.push(a)
      return { code: 0, stdout: '{}', stderr: '' }
    })
    call(['api', 'user'], '{"x":1}')
    assert.deepEqual(seen, [[['api', 'user']]])
  })
})

// A clock that moves only when the code under test sleeps, so no test waits.
function fakeClock() {
  const clock = { t: 0, sleeps: [], now: () => clock.t, sleep: (ms) => { clock.sleeps.push(ms); clock.t += ms } }
  return clock
}
const OPEN_PR_FIELDS = 'number,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,statusCheckRollup'

// ---------------------------------------------------------------------------
// runApply: plan mode and confirm mode against a stateful fake
// ---------------------------------------------------------------------------
describe('runApply', () => {
  const done = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })
  const pr = (number, rollup, isDraft = false, extra = {}) => ({ number, isDraft, statusCheckRollup: rollup, ...extra })
  const pending = (name) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '' })
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const fail = (status, message) => ({
    code: 1,
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
  })

  // A made-up account. `protection` is the GET shape, or null for a 404.
  function makeFake(over = {}) {
    const state = {
      login: 'octo',
      repo: {
        full_name: 'octo/widget',
        name: 'widget',
        owner: { login: 'octo', type: 'User' },
        archived: false,
        private: false,
        default_branch: 'main',
        allow_auto_merge: false,
        allow_squash_merge: false,
        ...over.repo,
      },
      version: over.version ?? { code: 0, stdout: 'gh version 2.103.3 (2026-10-26)\n', stderr: '' },
      protection: over.protection ?? null,
      protectionError: over.protectionError ?? null,
      prs: over.prs ?? [pr(12, [done('Unit tests')])],
      labels: over.labels ?? [{ name: 'bug' }],
      tree: over.tree ?? ['src/a.js', 'src/a.test.js'],
      treeTruncated: over.treeTruncated ?? false,
      // File contents by repo path, read through the contents API.
      files: over.files ?? {},
      contentsError: over.contentsError ?? null,
      failPut: over.failPut ?? null,
      failPatch: over.failPatch ?? null,
      // The CI setup PR's side of the repo (issue #554). `rollup` is a function
      // of the fake time, so a check can start pending and turn green after a
      // sleep. `fail` maps a route name to the response that route answers with.
      ci: {
        branchSha: over.ci?.branchSha ?? BASE_SHA,
        branch: over.ci?.branch ?? false,
        file: over.ci?.file ?? null,
        pr: over.ci?.pr ?? null,
        rollup: over.ci?.rollup ?? ((t) => (t >= 60000 ? [done('tests')] : [pending('tests')])),
        prFiles: over.ci?.prFiles ?? null,
        shaFiles: over.ci?.shaFiles ?? {},
        openOthers: over.ci?.openOthers ?? [],
        listOverride: over.ci?.listOverride ?? null,
        nextPr: 20,
        openSha: over.ci?.openSha ?? PR_SHA,
        fail: over.ci?.fail ?? {},
      },
      clock: over.clock ?? fakeClock(),
      calls: [],
      writes: [],
    }
    const ci = state.ci
    // The CI PR as `gh pr list` shows it, at the fake's current time.
    const listedCiPr = () => (ci.pr ? { ...ci.pr, statusCheckRollup: ci.rollup(state.clock.now(), ci) } : null)
    const ciFileText = (ref) => (ci.shaFiles[ref] !== undefined ? ci.shaFiles[ref] : ci.file)
    const contentsOk = (text) => ok({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })
    const repoPath = 'repos/octo/widget'
    const protPath = `${repoPath}/branches/main/protection`

    function run(args, input) {
      state.calls.push({ args, input })
      const key = args.join(' ')
      if (key === '--version') return state.version
      if (key === 'api user') return ok({ login: state.login })
      if (/^api repos\/[^/]+\/[^/]+$/i.test(key)) {
        if (key.toLowerCase() === `api ${repoPath}`) return ok(state.repo)
        return fail(404, 'Not Found')
      }
      if (key === `api ${protPath}`) {
        if (state.protectionError) return state.protectionError
        return state.protection ? ok(state.protection) : fail(404, 'Branch not protected')
      }
      if (key === `pr list --repo ${repoPath.slice(6)} --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup`) {
        return ok(ci.pr ? [...state.prs, listedCiPr()] : state.prs)
      }
      if (key === `pr list --repo ${repoPath.slice(6)} --state open --limit 100 --json ${OPEN_PR_FIELDS}`) {
        if (ci.fail.openList) return ci.fail.openList
        if (ci.listOverride) return ok(ci.listOverride(state.clock.now()))
        const open = ci.pr && ci.pr.state === 'OPEN' ? [listedCiPr()] : []
        return ok([...open, ...ci.openOthers])
      }
      if (key === `api ${repoPath}/branches/main`) {
        return ci.fail.branchRead ?? ok({ name: 'main', commit: { sha: ci.branchSha } })
      }
      if (key === `api ${repoPath}/git/ref/heads/${CI_BRANCH}`) {
        if (ci.fail.refRead) return ci.fail.refRead
        return ci.branch ? ok({ ref: `refs/heads/${CI_BRANCH}`, object: { sha: ci.branchSha } }) : fail(404, 'Not Found')
      }
      if (key === `api ${repoPath}/contents/${CI_FILE}?ref=${encodeURIComponent(CI_BRANCH)}`) {
        if (ci.fail.branchFile) return ci.fail.branchFile
        return ci.branch && ci.file !== null ? contentsOk(ci.file) : fail(404, 'Not Found')
      }
      const byRef = key.match(new RegExp(`^api ${repoPath}/contents/${CI_FILE.replaceAll('.', '\\.')}\\?ref=([0-9a-f]{40})$`))
      if (byRef) {
        if (ci.fail.shaFile) return ci.fail.shaFile
        const text = ciFileText(byRef[1])
        return text === null ? fail(404, 'Not Found') : contentsOk(text)
      }
      const prFiles = key.match(/^api repos\/octo\/widget\/pulls\/(\d+)\/files$/)
      if (prFiles) {
        if (ci.fail.prFiles) return ci.fail.prFiles
        return ok(ci.prFiles ?? [{ filename: CI_FILE, status: 'added' }])
      }
      if (key === `api -X POST ${repoPath}/labels --input -`) {
        const b = JSON.parse(input)
        state.writes.push({ method: 'POST', path: `${repoPath}/labels`, body: b })
        if (ci.fail.label) return ci.fail.label
        state.labels = [...state.labels, b]
        return ok(b)
      }
      const labelPatch = key.match(/^api -X PATCH repos\/octo\/widget\/labels\/(.+) --input -$/)
      if (labelPatch) {
        const b = JSON.parse(input)
        const name = decodeURIComponent(labelPatch[1])
        state.writes.push({ method: 'PATCH', path: `${repoPath}/labels/${labelPatch[1]}`, body: b })
        if (ci.fail.label) return ci.fail.label
        state.labels = state.labels.map((l) => (l.name === name ? { ...l, ...b } : l))
        return ok(b)
      }
      if (key === `api -X POST ${repoPath}/git/refs --input -`) {
        state.writes.push({ method: 'POST', path: `${repoPath}/git/refs`, body: JSON.parse(input) })
        if (ci.fail.refCreate) return ci.fail.refCreate
        ci.branch = true
        return ok({ ref: JSON.parse(input).ref })
      }
      if (key === `api -X PUT ${repoPath}/contents/${CI_FILE} --input -`) {
        const b = JSON.parse(input)
        state.writes.push({ method: 'PUT', path: `${repoPath}/contents/${CI_FILE}`, body: b })
        if (ci.fail.filePut) return ci.fail.filePut
        ci.file = Buffer.from(b.content, 'base64').toString('utf8')
        return ok({ content: { path: CI_FILE } })
      }
      if (key === `api -X POST ${repoPath}/pulls --input -`) {
        const b = JSON.parse(input)
        state.writes.push({ method: 'POST', path: `${repoPath}/pulls`, body: b })
        if (ci.fail.prOpen) return ci.fail.prOpen
        ci.pr = {
          number: ci.nextPr,
          headRefName: CI_BRANCH,
          headRefOid: ci.openSha,
          baseRefName: b.base,
          isDraft: b.draft,
          isCrossRepository: false,
          state: 'OPEN',
        }
        // The sha in the open response is deliberately not the head the polls report.
        return ok({ number: ci.pr.number, state: 'open', head: { sha: STALE_SHA } })
      }
      const merge = key.match(/^api -X PUT repos\/octo\/widget\/pulls\/(\d+)\/merge --input -$/)
      if (merge) {
        const b = JSON.parse(input)
        state.writes.push({ method: 'PUT', path: `${repoPath}/pulls/${merge[1]}/merge`, body: b })
        if (ci.fail.merge) return ci.fail.merge
        // GitHub refuses a merge whose pinned sha is not the head, and a squash
        // merge while the setting is off.
        if (!ci.pr || b.sha !== ci.pr.headRefOid) return fail(409, 'Head branch was modified. Review and try the merge again.')
        if (!state.repo.allow_squash_merge) return fail(405, 'Squash merges are not allowed on this repository.')
        ci.pr = { ...ci.pr, state: 'MERGED' }
        // A merge into another base does not put the file on the default branch.
        if (ci.pr.baseRefName === 'main') state.tree = [...state.tree, CI_FILE]
        return ok({ merged: true })
      }
      if (key === `api -X DELETE ${repoPath}/git/refs/heads/${CI_BRANCH}`) {
        state.writes.push({ method: 'DELETE', path: `${repoPath}/git/refs/heads/${CI_BRANCH}` })
        if (ci.fail.refDelete) return ci.fail.refDelete
        ci.branch = false
        return { code: 0, stdout: '', stderr: '' }
      }
      if (key === `api ${repoPath}/git/trees/main?recursive=1`) {
        return ok({ tree: state.tree.map((path) => ({ path, type: 'blob' })), truncated: state.treeTruncated })
      }
      const contents = key.match(/^api repos\/octo\/widget\/contents\/(.+)\?ref=main$/)
      if (contents) {
        if (state.contentsError) return state.contentsError
        const text = state.files[contents[1]]
        if (text === undefined) return fail(404, 'Not Found')
        return ok({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })
      }
      if (key === `api --paginate --slurp ${repoPath}/labels?per_page=100`) return ok([state.labels])
      if (key === `api -X PUT ${protPath} --input -`) {
        state.writes.push({ method: 'PUT', path: protPath, body: JSON.parse(input) })
        if (state.failPut) return state.failPut
        const b = JSON.parse(input)
        const on = (v) => ({ enabled: v })
        state.protection = {
          required_status_checks: {
            strict: b.required_status_checks.strict,
            contexts: b.required_status_checks.contexts,
            checks: b.required_status_checks.contexts.map((context) => ({ context, app_id: null })),
          },
          enforce_admins: on(b.enforce_admins),
          required_pull_request_reviews: { ...b.required_pull_request_reviews },
          allow_force_pushes: on(b.allow_force_pushes),
          allow_deletions: on(b.allow_deletions),
          required_linear_history: on(b.required_linear_history),
          required_conversation_resolution: on(b.required_conversation_resolution),
          block_creations: on(b.block_creations),
          lock_branch: on(b.lock_branch),
          allow_fork_syncing: on(b.allow_fork_syncing),
        }
        return ok(state.protection)
      }
      if (key === `api -X PATCH ${repoPath} --input -`) {
        state.writes.push({ method: 'PATCH', path: repoPath, body: JSON.parse(input) })
        if (state.failPatch) return state.failPatch
        Object.assign(state.repo, JSON.parse(input))
        return ok(state.repo)
      }
      throw new Error(`unexpected gh call: ${key}`)
    }
    return { run, state, clock: state.clock }
  }

  const tokenOf = (text) => text.match(/^confirm token: ([0-9a-f]{12})$/m)?.[1]
  const apply = (fake, ...argv) => runApply(fake.run, argv, fake.clock)

  // A fully set up repo, as the fake reports it.
  const SET_UP_PROTECTION = {
    required_status_checks: { strict: true, contexts: ['Unit tests'], checks: [{ context: 'Unit tests', app_id: null }] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 0 },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  }

  describe('plan mode', () => {
    test('prints the changes, the checks, the writes and a token, and only reads', () => {
      const fake = makeFake()
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, /^octo\/widget: not set up/m)
      assert.match(text, /^ {2}branch protection$/m)
      assert.match(text, /^ {2}auto merge on$/m)
      assert.match(text, /^ {2}squash merge allowed$/m)
      assert.match(text, /^required checks after apply: Unit tests$/m)
      assert.match(text, /^ {2}PUT repos\/octo\/widget\/branches\/main\/protection$/m)
      assert.match(text, /^ {2}PATCH repos\/octo\/widget$/m)
      assert.ok(tokenOf(text), 'no token line')
      assert.ok(text.trimEnd().split('\n').pop().startsWith('confirm token: '), 'the token is the last line')
      for (const c of fake.state.calls) {
        assert.equal(isReadOnly(c.args), true, c.args.join(' '))
        assert.equal(c.input, undefined)
      }
      assert.deepEqual(fake.state.writes, [])
    })

    test('names a check that no longer runs', () => {
      const fake = makeFake({ prs: [pr(12, [done('Unit tests')]), pr(11, [done('Unit tests'), done('Version bump guard')])] })
      assert.match(apply(fake, 'widget').text, /^not required: no longer runs: Version bump guard$/m)
    })

    test('lists a required check that no longer runs as stop requiring', () => {
      const prot = { ...SET_UP_PROTECTION, required_status_checks: { strict: true, contexts: ['Unit tests', 'Gone'] } }
      const fake = makeFake({ protection: prot, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      const { text } = apply(fake, 'widget')
      assert.match(text, /^ {2}stop requiring: Gone$/m)
      assert.match(text, /^ {2}PUT /m)
      assert.doesNotMatch(text, /^ {2}PATCH /m)
    })

    test('a short name and owner/name give the same plan and token', () => {
      const a = apply(makeFake(), 'widget')
      const b = apply(makeFake(), 'octo/widget')
      assert.equal(a.text, b.text)
    })

    test('the owner is matched without regard to case', () => {
      const { code, text } = apply(makeFake(), 'Octo/widget')
      assert.equal(code, 0)
      assert.ok(tokenOf(text))
    })

    test('later calls use the canonical name from the response, not the typed one', () => {
      // GitHub resolves names without regard to case, and the fake does too for
      // the repo read. Every later call in the fake matches exactly, so a call
      // that used the typed WIDGET would fail there.
      const typed = apply(makeFake(), 'WIDGET')
      const canonical = apply(makeFake(), 'widget')
      assert.equal(typed.code, 0)
      assert.equal(typed.text, canonical.text)
      assert.equal(tokenOf(typed.text), tokenOf(canonical.text))

      const fake = makeFake()
      const token = tokenOf(apply(fake, 'WIDGET').text)
      const confirmed = apply(fake, 'WIDGET', '--confirm', token)
      assert.equal(confirmed.code, 0)
      const writePaths = fake.state.calls.filter((c) => !isReadOnly(c.args)).map((c) => c.args[3])
      assert.deepEqual(writePaths, ['repos/octo/widget/branches/main/protection', 'repos/octo/widget'])
    })

    // The fake answers a repo whose name is `--web` as if it were octo/widget, so
    // a call built from it can be told apart. Only the read guard stops it.
    const dashFake = (afterWritesOnly = false) => {
      const fake = makeFake({ repo: afterWritesOnly ? {} : { full_name: '--web' } })
      const seen = []
      const run = (args, input) => {
        seen.push({ args, afterWrite: fake.state.writes.length > 0 })
        const res = fake.run(
          args.map((a) => (a === '--web' ? 'octo/widget' : a.replace('repos/--web', 'repos/octo/widget'))),
          input
        )
        const isRepoRead = args.join(' ') === 'api repos/octo/widget'
        if (afterWritesOnly && isRepoRead && fake.state.writes.length > 0) {
          return ok({ ...fake.state.repo, full_name: '--web' })
        }
        return res
      }
      return { fake, run, seen }
    }

    test('plan mode reads through the guard: a name the guard refuses never reaches the runner', () => {
      const { fake, run, seen } = dashFake()
      const { code, text } = runApply(run, ['widget'])
      assert.equal(code, 1)
      assert.match(text, /not read-only/)
      assert.equal(seen.some((c) => c.args[0] === 'pr'), false, 'the runner received the rejected pr list call')
      assert.deepEqual(fake.state.writes, [])
    })

    test('the re-read after the writes goes through the guard too', () => {
      const { fake, run, seen } = dashFake(true)
      const token = tokenOf(runApply(run, ['widget']).text)
      seen.length = 0
      const { code, text } = runApply(run, ['widget', '--confirm', token])
      assert.equal(code, 1)
      assert.equal(fake.state.writes.length, 2)
      assert.match(text, /could not re-read the repo: .*not read-only/)
      assert.equal(seen.some((c) => c.afterWrite && c.args[0] === 'pr'), false, 'a rejected pr list call ran after the writes')
    })

    test('nothing to change prints one line and no token', () => {
      const fake = makeFake({ protection: SET_UP_PROTECTION, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.equal(text, 'octo/widget: set up, nothing to change\n')
    })
  })

  describe('confirm mode', () => {
    test('writes the PUT then the PATCH, re-reads, and reports set up', () => {
      const fake = makeFake()
      const token = tokenOf(apply(fake, 'widget').text)
      fake.state.calls.length = 0
      const { code, text } = apply(fake, 'widget', '--confirm', token)

      assert.equal(code, 0)
      assert.deepEqual(
        fake.state.writes.map((w) => w.method),
        ['PUT', 'PATCH']
      )
      const writes = fake.state.calls.filter((c) => !isReadOnly(c.args))
      assert.equal(writes.length, 2)
      for (const c of writes) {
        assert.equal(isAllowedWrite(c.args, JSON.parse(c.input), TARGET), true, c.args.join(' '))
        assert.equal(isReadOnly(c.args), false)
      }
      for (const c of fake.state.calls.filter((c) => isReadOnly(c.args))) assert.equal(c.input, undefined)
      assert.match(text, /^octo\/widget: set up$/m)
      assert.equal(fake.state.repo.allow_auto_merge, true)
      assert.equal(fake.state.protection.enforce_admins.enabled, true)
      assert.deepEqual(fake.state.protection.required_status_checks.contexts, ['Unit tests'])
    })

    test('a second run changes nothing and writes nothing', () => {
      const fake = makeFake()
      apply(fake, 'widget', '--confirm', tokenOf(apply(fake, 'widget').text))
      const writesBefore = fake.state.writes.length
      const again = apply(fake, 'widget')
      assert.equal(again.code, 0)
      assert.equal(again.text, 'octo/widget: set up, nothing to change\n')
      assert.equal(fake.state.writes.length, writesBefore)
    })

    test('a token from a changed state writes nothing', () => {
      const fake = makeFake()
      const token = tokenOf(apply(fake, 'widget').text)
      fake.state.prs = [pr(13, [done('Unit tests'), done('lint')]), ...fake.state.prs]
      const { code, text } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 2)
      assert.match(text, /plan changed since it was shown, nothing written/)
      assert.deepEqual(fake.state.writes, [])
    })

    test('a made-up token writes nothing', () => {
      const fake = makeFake()
      const { code } = apply(fake, 'widget', '--confirm', '000000000000')
      assert.equal(code, 2)
      assert.deepEqual(fake.state.writes, [])
    })

    test('the token must match exactly: no trimming, no case folding, no prefix', () => {
      const fake = makeFake()
      const token = tokenOf(apply(fake, 'widget').text)
      assert.notEqual(token.toUpperCase(), token)
      for (const value of ['', token.slice(0, 6), token.toUpperCase(), ' ' + token, token + '\n']) {
        const { code, text } = apply(fake, 'widget', '--confirm', value)
        assert.equal(code, 2, JSON.stringify(value))
        assert.match(text, /plan changed since it was shown, nothing written/)
        assert.deepEqual(fake.state.writes, [])
      }
    })

    test('with nothing to change, any token writes nothing', () => {
      const fake = makeFake({ protection: SET_UP_PROTECTION, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      const { code, text } = apply(fake, 'widget', '--confirm', 'whatever')
      assert.equal(code, 0)
      assert.match(text, /set up, nothing to change/)
      assert.deepEqual(fake.state.writes, [])
    })

    test('a failed PUT stops before the PATCH, reports the state unchanged and exits 1', () => {
      const fake = makeFake({ failPut: fail(422, 'Validation Failed') })
      const token = tokenOf(apply(fake, 'widget').text)
      const { code, text } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 1)
      assert.deepEqual(
        fake.state.writes.map((w) => w.method),
        ['PUT']
      )
      assert.match(text, /Validation Failed/)
      assert.match(text, /^octo\/widget: not set up$/m)
      assert.equal(fake.state.repo.allow_auto_merge, false)
    })

    test('a failed PATCH leaves protection on and auto merge still missing, and exits 1', () => {
      const fake = makeFake({ failPatch: fail(422, 'Validation Failed') })
      const token = tokenOf(apply(fake, 'widget').text)
      const { code, text } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 1)
      assert.deepEqual(
        fake.state.writes.map((w) => w.method),
        ['PUT', 'PATCH']
      )
      assert.match(text, /^octo\/widget: not set up$/m)
      assert.match(text, /missing: auto merge on, squash merge allowed/)
      assert.notEqual(fake.state.protection, null)
    })

    test('writes go through the fence: a body it refuses never reaches the runner', () => {
      // A completed check named '' is the one input that makes buildWrites build a
      // body the fence refuses (contexts: ['']), while the plan and token still
      // come out normally. A runApply that called the raw runner for its writes
      // would send it, and this test would fail.
      const fake = makeFake({ prs: [pr(12, [done('')])] })
      const token = tokenOf(apply(fake, 'widget').text)
      assert.ok(token, 'plan mode printed no token')
      const { code, text } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 1)
      assert.match(text, /refusing a call that is not an allowed write/)
      assert.equal(fake.state.calls.some((c) => c.args.includes('-X')), false, 'a write reached the runner')
      assert.deepEqual(fake.state.writes, [])
    })

    test('exits 1 when a write fails, even though the re-read then says set up', () => {
      // Only the auto merge PATCH is planned. The wrapper lets it change the
      // fake's state but answers 502, so the re-read looks fine and only the
      // failed write is left to make the exit code 1.
      const fake = makeFake({ protection: SET_UP_PROTECTION, repo: { allow_squash_merge: true } })
      const token = tokenOf(apply(fake, 'widget').text)
      const run = (args, input) => {
        const res = fake.run(args, input)
        return args[1] === '-X' && args[2] === 'PATCH' ? fail(502, 'Bad Gateway') : res
      }
      const { code, text } = runApply(run, ['widget', '--confirm', token])
      assert.equal(code, 1)
      assert.match(text, /write failed/)
      assert.match(text, /^octo\/widget: set up$/m)
    })

    test('exits 1 when the re-read still says not set up after the writes', () => {
      // A host that drops the status block would leave "up to date required" missing.
      const fake = makeFake()
      const token = tokenOf(apply(fake, 'widget').text)
      const run = (args, input) => {
        const res = fake.run(args, input)
        const afterWrites = fake.state.writes.length > 0
        if (afterWrites && args.join(' ').endsWith('/protection') && args[1] !== '-X' && res.code === 0) {
          const body = JSON.parse(res.stdout)
          return ok({ ...body, required_status_checks: null })
        }
        return res
      }
      const { code } = runApply(run, ['widget', '--confirm', token])
      assert.equal(code, 1)
    })
  })

  const NPM_TREE = ['package.json', 'package-lock.json', 'src/a.js', 'src/a.test.js']
  const PKG = JSON.stringify({ name: 'widget', scripts: { test: 'vitest run' } })
  // No finished PR has run a check, so the repo needs CI.
  const ciFake = (over = {}) => makeFake({ prs: [], tree: NPM_TREE, files: { 'package.json': PKG }, ...over })
  const NPM_YAML = buildCiYaml({
    branch: 'main',
    install: 'npm ci',
    test: 'npm test',
    runtime: [{ uses: 'actions/setup-node@v7', with: { 'node-version': 'lts/*' } }],
  })
  // The CI setup PR as `gh pr list --state open` shows it.
  const ciPr = (over = {}) => ({
    number: 20,
    headRefName: CI_BRANCH,
    headRefOid: PR_SHA,
    baseRefName: 'main',
    isDraft: false,
    isCrossRepository: false,
    state: 'OPEN',
    ...over,
  })
  // The writes of a fresh CI run, in the order the run makes them.
  const LABEL_CREATES = LABELS.map((l) => `POST repos/octo/widget/labels (${l.name})`)
  const FRESH_WRITES = [
    ...LABEL_CREATES,
    'PATCH repos/octo/widget',
    'POST repos/octo/widget/git/refs',
    `PUT repos/octo/widget/contents/${CI_FILE}`,
    'POST repos/octo/widget/pulls',
    'PUT repos/octo/widget/pulls/<new PR>/merge',
    `DELETE repos/octo/widget/git/refs/heads/${CI_BRANCH}`,
    'PUT repos/octo/widget/branches/main/protection',
  ]
  const writesBlock = (text) => {
    const lines = text.trimEnd().split('\n')
    const at = lines.indexOf('writes:')
    return lines.slice(at + 1, lines.length - 1).map((l) => l.replace(/^ {2}/, ''))
  }

  describe('CI setup plan (issue #551)', () => {
    const contentsCalls = (fake) => fake.state.calls.filter((c) => c.args[1]?.includes('/contents/'))

    test('prints the detected commands, the expected check, the file and the writes, then a token', () => {
      const fake = ciFake()
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, /^ {2}install: npm ci$/m)
      assert.match(text, /^ {2}test: npm test$/m)
      assert.match(text, /^ {2}expected check: tests$/m)
      assert.match(text, /^ {2}file: \.github\/workflows\/ci\.yml$/m)
      assert.match(text, /^ {2}PUT repos\/octo\/widget\/branches\/main\/protection$/m)
      assert.ok(text.trimEnd().split('\n').pop().startsWith('confirm token: '), 'the token is the last line')
      assert.deepEqual(fake.state.writes, [])
    })

    test('shows the label writes of the CI path: the labels block and the (name) suffixes', () => {
      const fake = ciFake()
      const { text } = apply(fake, 'widget')
      const lines = text.trimEnd().split('\n')
      const at = lines.indexOf('labels:')
      assert.ok(at > 0, text)
      assert.equal(lines.slice(at + 1, at + 7).every((l) => /^ {2}create \S+, color [0-9a-fA-F]{6}: /.test(l)), true, text)
      assert.equal(lines[at + 7], 'changes:')
      // The writes follow the run order: the six creates, each named, then the
      // repo PATCH, the CI writes, and the protection PUT last.
      const writes = lines.slice(lines.indexOf('writes:') + 1, lines.indexOf('writes:') + 9)
      assert.equal(writes.slice(0, 6).every((l, i) => l === `  POST repos/octo/widget/labels (${LABELS[i].name})`), true, text)
      assert.equal(writes[6], '  PATCH repos/octo/widget')
      assert.equal(writes[7], '  POST repos/octo/widget/git/refs')
      assert.deepEqual(fake.state.writes, [])
    })

    test('a repo with some of the labels already gets only the missing creates in the CI plan', () => {
      const fake = ciFake({ labels: [{ name: 'size:S', color: LABELS[0].color, description: LABELS[0].description }] })
      const { text } = apply(fake, 'widget')
      assert.doesNotMatch(text, /create size:S,/)
      assert.match(text, /^ {2}create size:M, color /m)
      assert.doesNotMatch(text, /POST repos\/octo\/widget\/labels \(size:S\)/)
    })

    test('prints the whole ci.yml, indented, in one block', () => {
      const { text } = apply(ciFake(), 'widget')
      const indented = NPM_YAML.trimEnd()
        .split('\n')
        .map((l) => (l === '' ? '' : `    ${l}`))
        .join('\n')
      assert.ok(text.includes(`  file: .github/workflows/ci.yml\n${indented}\n`), text)
      assert.doesNotMatch(text, /note: --confirm|resume:/)
    })

    test('computes the protection as if tests and both verdict checks were seen', () => {
      const { text } = apply(ciFake(), 'widget')
      assert.match(text, /^required checks after apply: orchestrai\/review, orchestrai\/test, tests$/m)
      assert.match(text, /^ {2}required check: tests$/m)
      assert.match(text, /^ {2}required check: orchestrai\/review$/m)
      assert.doesNotMatch(text, /needs CI first/)
    })

    test('reads only: every call passes the read guard and carries no input', () => {
      const fake = ciFake()
      apply(fake, 'widget')
      for (const c of fake.state.calls) {
        assert.equal(isReadOnly(c.args), true, c.args.join(' '))
        assert.equal(c.input, undefined)
      }
    })

    test('reads the root package.json once, as a plain path on the default branch', () => {
      const fake = ciFake()
      apply(fake, 'widget')
      assert.deepEqual(
        contentsCalls(fake).map((c) => c.args),
        [['api', 'repos/octo/widget/contents/package.json?ref=main']]
      )
    })

    test('the CI plan prints the same text and token every time', () => {
      assert.equal(apply(ciFake(), 'widget').text, apply(ciFake(), 'widget').text)
    })

    test('the token changes when the generated ci.yml changes', () => {
      const base = tokenOf(apply(ciFake(), 'widget').text)
      const yarn = ciFake({ tree: ['package.json', 'yarn.lock', 'src/a.test.js'] })
      assert.notEqual(tokenOf(apply(yarn, 'widget').text), base)
      const nvm = ciFake({ tree: [...NPM_TREE, '.nvmrc'] })
      assert.notEqual(tokenOf(apply(nvm, 'widget').text), base)
    })

    test('--confirm with the shown token sets CI up: labels, PATCH, branch, file, PR, merge, delete, then the protection', () => {
      const fake = ciFake()
      const token = tokenOf(apply(fake, 'widget').text)
      const { code, text } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 0, text)
      assert.deepEqual(
        fake.state.writes.map((w) => `${w.method} ${w.path}`),
        [
          ...LABELS.map(() => 'POST repos/octo/widget/labels'),
          'PATCH repos/octo/widget',
          'POST repos/octo/widget/git/refs',
          `PUT repos/octo/widget/contents/${CI_FILE}`,
          'POST repos/octo/widget/pulls',
          'PUT repos/octo/widget/pulls/20/merge',
          `DELETE repos/octo/widget/git/refs/heads/${CI_BRANCH}`,
          'PUT repos/octo/widget/branches/main/protection',
        ]
      )
      assert.match(text, /^octo\/widget: set up$/m)
      assert.deepEqual(fake.state.protection.required_status_checks.contexts, ['orchestrai/review', 'orchestrai/test', 'tests'])
    })

    test('--confirm with a wrong token writes nothing either', () => {
      const fake = ciFake()
      const { code } = apply(fake, 'widget', '--confirm', 'abcdefabcdef')
      assert.equal(code, 2)
      assert.deepEqual(fake.state.writes, [])
    })

    test('still prints the plan when protection already needs nothing, because the file is still needed', () => {
      const contexts = ['orchestrai/review', 'orchestrai/test', 'tests']
      const protection = { ...SET_UP_PROTECTION, required_status_checks: { strict: true, contexts } }
      const fake = ciFake({ protection, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, /^ {2}file: \.github\/workflows\/ci\.yml$/m)
      assert.doesNotMatch(text, /^ {2}PUT \S*\/protection$/m)
      assert.ok(tokenOf(text), 'no token line')
    })

    test('given commands skip detection: no package.json read, no runtime setup, quoted run lines', () => {
      const fake = makeFake({ prs: [] })
      const { code, text } = apply(fake, 'widget', '--install', 'make deps', '--test', 'make test "fast"')
      assert.equal(code, 0)
      assert.match(text, /^ {2}install: make deps$/m)
      assert.match(text, /^ {2}test: make test "fast"$/m)
      assert.match(text, /^ {12}run: "make test \\"fast\\""$/m)
      assert.doesNotMatch(text, /setup-/)
      assert.equal(contentsCalls(fake).length, 0)
      assert.ok(tokenOf(text), 'no token line')
    })

    test('given commands may hold characters YAML allows: an emoji and a byte order mark', () => {
      const { code, text } = apply(makeFake({ prs: [] }), 'widget', '--install', 'make \u{1F600}', '--test', 'make\ufeff test')
      assert.equal(code, 0)
      assert.ok(tokenOf(text), 'no token line')
    })

    test('given commands are part of the token', () => {
      const a = tokenOf(apply(makeFake({ prs: [] }), 'widget', '--install', 'make deps', '--test', 'make test').text)
      const b = tokenOf(apply(makeFake({ prs: [] }), 'widget', '--install', 'make deps', '--test', 'make check').text)
      const c = tokenOf(apply(makeFake({ prs: [] }), 'widget', '--test', 'make test', '--install', 'make deps').text)
      assert.notEqual(a, b)
      assert.equal(a, c, 'flag order does not change the plan')
    })

    test('given commands win over what detection would have found', () => {
      const { text } = apply(ciFake(), 'widget', '--install', 'make deps', '--test', 'make test')
      assert.match(text, /^ {2}install: make deps$/m)
      assert.doesNotMatch(text, /npm ci/)
    })

    test('a go repo has no install line and no install step', () => {
      const fake = makeFake({ prs: [], tree: ['go.mod', 'a_test.go'] })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, /^ {2}install: none$/m)
      assert.match(text, /^ {2}test: go test \.\/\.\.\.$/m)
      assert.doesNotMatch(text, /Install dependencies/)
      assert.equal(contentsCalls(fake).length, 0, 'go.mod is not read')
    })

    const refusesCi = (name, make, argv, pattern, code = 2) => {
      test(`${name}: exit ${code}, no token, nothing written`, () => {
        const fake = make()
        const out = apply(fake, ...argv)
        assert.equal(out.code, code)
        assert.match(out.text, pattern)
        assert.equal(tokenOf(out.text), undefined)
        assert.doesNotMatch(out.text, /confirm token/)
        assert.deepEqual(fake.state.writes, [])
        assert.equal(fake.state.calls.some((c) => !isReadOnly(c.args)), false)
      })
    }

    refusesCi(
      'two stacks at the root fail detection and name both',
      () => ciFake({ tree: [...NPM_TREE, 'requirements.txt'] }),
      ['widget'],
      /could not detect the install and test commands: more than one stack at the root: package\.json, requirements\.txt.*--install.*--test/s
    )
    refusesCi(
      'a default test script fails detection',
      () => ciFake({ files: { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) } }),
      ['widget'],
      /package\.json has no real test script/
    )
    refusesCi(
      'tests only under a subfolder with its own manifest fail detection',
      () => makeFake({ prs: [], tree: ['package.json', 'dashboard/package.json', 'dashboard/a.test.js'], files: { 'package.json': PKG } }),
      ['widget'],
      /only under subfolders.*dashboard\//
    )
    refusesCi(
      'a package.json that is not JSON fails detection and names the file',
      () => ciFake({ files: { 'package.json': '{ not json' } }),
      ['widget'],
      /package\.json is not valid JSON/
    )
    refusesCi(
      'a package.json that is not an object fails detection',
      () => ciFake({ files: { 'package.json': '[1]' } }),
      ['widget'],
      /package\.json is not valid JSON/
    )
    refusesCi(
      'a failed package.json read is a read failure',
      () => ciFake({ contentsError: fail(500, 'Server Error') }),
      ['widget'],
      /could not read: package\.json: Server Error/,
      1
    )
    describe('a merged CI PR counts only while ci.yml is on the default branch (issue #569)', () => {
      const mergedElsewhere = (over = {}) =>
        ciFake({ ci: { pr: ciPr({ state: 'MERGED', baseRefName: 'dev' }), rollup: () => [done('tests')] }, ...over })

      test('merged into another base, ci.yml is not on main: the CI path, nothing written', () => {
        const fake = mergedElsewhere()
        const { code, text } = apply(fake, 'widget')
        assert.equal(code, 0)
        assert.match(text, /^ {2}expected check: tests$/m)
        assert.match(text, /^ {2}file: \.github\/workflows\/ci\.yml$/m)
        assert.match(text, /^ {2}required check: tests$/m)
        assert.deepEqual(fake.state.writes, [])
      })

      test('with ci.yml on main, the normal path requires tests and has no CI block', () => {
        const fake = mergedElsewhere({ tree: [...NPM_TREE, CI_FILE] })
        const { code, text } = apply(fake, 'widget')
        assert.equal(code, 0)
        assert.match(text, /^ {2}required check: tests$/m)
        assert.doesNotMatch(text, /expected check|file: \.github\/workflows\/ci\.yml/)
        assert.deepEqual(fake.state.writes, [])
      })

      test('with ci.yml listed but the tree truncated, the PR does not count and the plan is refused', () => {
        const fake = mergedElsewhere({ tree: [...NPM_TREE, CI_FILE], treeTruncated: true })
        const out = apply(fake, 'widget')
        assert.equal(out.code, 2)
        assert.match(out.text, /file tree of octo\/widget is truncated/)
        assert.equal(tokenOf(out.text), undefined)
        assert.deepEqual(fake.state.writes, [])
      })
    })

    refusesCi('a truncated tree is not trusted', () => ciFake({ treeTruncated: true }), ['widget'], /file tree of octo\/widget is truncated/)
    refusesCi(
      'a plan without branch protection comes first, before the truncated tree',
      () => ciFake({ treeTruncated: true, protectionError: fail(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.') }),
      ['widget'],
      /blocked/
    )
    refusesCi(
      'an existing workflow that no PR has run is not joined by a second one',
      () => ciFake({ tree: [...NPM_TREE, '.github/workflows/build.yml'] }),
      ['widget'],
      /already has a workflow under \.github\/workflows\/.*no finished, non-draft PR has run it.*open or finish a PR so the existing workflow runs/is
    )
    refusesCi(
      'an existing workflow is refused with given commands too',
      () => makeFake({ prs: [], tree: ['src/a.test.js', '.github/workflows/build.yml'] }),
      ['widget', '--install', 'make deps', '--test', 'make test'],
      /already has a workflow under \.github\/workflows\//
    )
    refusesCi(
      'a repo that requires signed commits when the plan has a PUT',
      () => ciFake({ protection: { ...SET_UP_PROTECTION, required_signatures: { enabled: true } } }),
      ['widget'],
      /requires signed commits/
    )

    test('detection reads no package.json that is not at the root', () => {
      const fake = makeFake({ prs: [], tree: ['app/package.json', 'app/a.js', 'src/a.test.js'] })
      const { code } = apply(fake, 'widget')
      assert.equal(code, 2)
      assert.equal(contentsCalls(fake).length, 0)
    })

    test('--install and --test on a repo that does not need CI are refused, not ignored', () => {
      const fake = makeFake()
      const { code, text } = apply(fake, 'widget', '--install', 'make deps', '--test', 'make test')
      assert.equal(code, 2)
      assert.match(text, /usage.*only .*needs CI/is)
      assert.deepEqual(fake.state.writes, [])
    })

    test('--install and --test on a repo that is set up are refused too', () => {
      const fake = makeFake({ protection: SET_UP_PROTECTION, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      const { code } = apply(fake, 'widget', '--install', 'make deps', '--test', 'make test')
      assert.equal(code, 2)
    })

    test('the plan for a repo that does not need CI has no CI block', () => {
      const { text } = apply(makeFake(), 'widget')
      assert.doesNotMatch(text, /expected check|ci\.yml/)
    })
  })

  describe('CI setup plan: run order and resume (issue #554)', () => {
    const sawCalls = (fake, key) => fake.state.calls.filter((c) => c.args.join(' ').includes(key))

    test('a fresh plan lists the writes in the order the run makes them, with no resume line', () => {
      const { code, text } = apply(ciFake(), 'widget')
      assert.equal(code, 0)
      assert.deepEqual(writesBlock(text), FRESH_WRITES)
      assert.doesNotMatch(text, /resume:/)
    })

    test('a leftover branch with no file is named and its ref create is left out', () => {
      const fake = ciFake({ ci: { branch: true } })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, new RegExp(`^ {2}resume: branch ${CI_BRANCH} exists without the workflow file$`, 'm'))
      assert.deepEqual(writesBlock(text), FRESH_WRITES.filter((w) => w !== 'POST repos/octo/widget/git/refs'))
    })

    test('a leftover branch that holds the planned file also skips the file put', () => {
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML } })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, new RegExp(`^ {2}resume: branch ${CI_BRANCH} holds the planned workflow file$`, 'm'))
      assert.deepEqual(
        writesBlock(text),
        FRESH_WRITES.filter((w) => w !== 'POST repos/octo/widget/git/refs' && !w.startsWith('PUT repos/octo/widget/contents'))
      )
    })

    test('an open CI PR that holds only the planned file skips the PR open and names the PR in the merge line', () => {
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML, pr: ciPr() } })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.match(text, /^ {2}resume: PR #20 is open and holds the planned workflow file$/m)
      assert.deepEqual(writesBlock(text), [
        ...LABEL_CREATES,
        'PATCH repos/octo/widget',
        'PUT repos/octo/widget/pulls/20/merge',
        `DELETE repos/octo/widget/git/refs/heads/${CI_BRANCH}`,
        'PUT repos/octo/widget/branches/main/protection',
      ])
      assert.ok(tokenOf(text))
    })

    test('the PR check reads the changed files, then the file at the PR head sha', () => {
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML, pr: ciPr() } })
      apply(fake, 'widget')
      assert.equal(sawCalls(fake, 'pulls/20/files').length, 1)
      assert.equal(sawCalls(fake, `contents/${CI_FILE}?ref=${PR_SHA}`).length, 1)
      assert.equal(sawCalls(fake, 'git/ref/heads').length, 0, 'the ref is not read when a PR is found')
    })

    test('plan mode on a resume still only reads', () => {
      for (const ci of [{ branch: true }, { branch: true, file: NPM_YAML }, { branch: true, file: NPM_YAML, pr: ciPr() }]) {
        const fake = ciFake({ ci })
        apply(fake, 'widget')
        for (const c of fake.state.calls) {
          assert.equal(isReadOnly(c.args), true, c.args.join(' '))
          assert.equal(c.input, undefined)
        }
        assert.deepEqual(fake.state.writes, [])
      }
    })

    test('a PR for another head, or from a fork with the same head name, is not the CI PR', () => {
      const others = [ciPr({ headRefName: 'feat/x' }), ciPr({ number: 21, isCrossRepository: true })]
      const fake = ciFake({ ci: { openOthers: others } })
      const { code, text } = apply(fake, 'widget')
      assert.equal(code, 0)
      assert.deepEqual(writesBlock(text), FRESH_WRITES)
    })

    test('the token changes when the resume state changes', () => {
      const tokens = [
        {},
        { branch: true },
        { branch: true, file: NPM_YAML },
        { branch: true, file: NPM_YAML, pr: ciPr() },
        { branch: true, file: NPM_YAML, pr: ciPr({ number: 21 }) },
      ].map((ci) => tokenOf(apply(ciFake({ ci }), 'widget').text))
      assert.equal(new Set(tokens).size, tokens.length, tokens.join(' '))
    })

    test('the token does not cover the PR head sha, so a push alone does not make it stale', () => {
      const a = tokenOf(apply(ciFake({ ci: { branch: true, file: NPM_YAML, pr: ciPr() } }), 'widget').text)
      const other = 'c'.repeat(40)
      const b = tokenOf(apply(ciFake({ ci: { branch: true, file: NPM_YAML, pr: ciPr({ headRefOid: other }) } }), 'widget').text)
      assert.equal(a, b)
    })

    const refuses = (name, over, pattern, code = 2) => {
      test(`${name}: exit ${code}, no token, nothing written`, () => {
        const fake = ciFake(over)
        const out = apply(fake, 'widget')
        assert.equal(out.code, code)
        assert.match(out.text, pattern)
        assert.equal(tokenOf(out.text), undefined)
        assert.match(out.text, /nothing written/)
        assert.deepEqual(fake.state.writes, [])
        assert.equal(fake.state.calls.some((c) => !isReadOnly(c.args)), false)
      })
    }

    refuses('a branch that holds a different file', { ci: { branch: true, file: 'name: other\n' } }, /different.*delete the branch/is)
    refuses('an open CI PR that is a draft', { ci: { branch: true, file: NPM_YAML, pr: ciPr({ isDraft: true }) } }, /PR #20.*draft/is)
    refuses('an open CI PR against another base', { ci: { branch: true, file: NPM_YAML, pr: ciPr({ baseRefName: 'dev' }) } }, /PR #20.*base dev/is)
    refuses(
      'two open PRs from the CI branch',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), openOthers: [ciPr({ number: 21 })] } },
      /more than one open PR.*#20.*#21/is
    )
    refuses(
      'an open CI PR that changes more than one file',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), prFiles: [{ filename: CI_FILE, status: 'added' }, { filename: 'x.js', status: 'added' }] } },
      /PR #20.*exactly one file/is
    )
    refuses(
      'an open CI PR that changes another file',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), prFiles: [{ filename: 'x.js', status: 'added' }] } },
      /PR #20.*exactly one file/is
    )
    refuses(
      'an open CI PR that modifies the file instead of adding it',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), prFiles: [{ filename: CI_FILE, status: 'modified' }] } },
      /PR #20 does not add .*modified/is
    )
    refuses(
      'an open CI PR whose head holds a different file',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), shaFiles: { [PR_SHA]: 'name: other\n' } } },
      /PR #20.*not the planned file/is
    )
    refuses('a failed read of the open PRs', { ci: { fail: { openList: fail(500, 'Server Error') } } }, /could not read: .*Server Error/, 1)
    refuses('a failed read of the CI branch', { ci: { fail: { refRead: fail(500, 'Server Error') } } }, /could not read: .*Server Error/, 1)
    refuses(
      'a failed read of the file on the CI branch',
      { ci: { branch: true, fail: { branchFile: fail(500, 'Server Error') } } },
      /could not read: .*Server Error/,
      1
    )
    refuses(
      'a failed read of the PR files',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), fail: { prFiles: fail(500, 'Server Error') } } },
      /could not read: .*Server Error/,
      1
    )
    refuses(
      'a failed read of the file at the PR head',
      { ci: { branch: true, file: NPM_YAML, pr: ciPr(), fail: { shaFile: fail(500, 'Server Error') } } },
      /could not read: .*Server Error/,
      1
    )
  })

  describe('CI setup confirm (issue #554)', () => {
    const wrote = (fake) => fake.state.writes.map((w) => `${w.method} ${w.path.replace('repos/octo/widget', '')}`)
    const LABEL_WRITES = LABELS.map(() => 'POST /labels')
    const BEFORE = [...LABEL_WRITES, 'PATCH ']
    const REF = 'POST /git/refs'
    const FILE = `PUT /contents/${CI_FILE}`
    const OPEN = 'POST /pulls'
    const MERGE = 'PUT /pulls/20/merge'
    const DELETE = `DELETE /git/refs/heads/${CI_BRANCH}`
    const PUT = 'PUT /branches/main/protection'
    const pollsOf = (fake) => fake.state.calls.filter((c) => c.args.join(' ').includes('--state open'))
    const green = () => [done('tests')]

    // Plan, then confirm with the shown token. Returns the confirm result.
    const confirmCi = (fake, ...extra) => {
      const token = tokenOf(apply(fake, 'widget', ...extra).text)
      assert.ok(token, 'the plan printed no token')
      return apply(fake, 'widget', ...extra, '--confirm', token)
    }

    test('every call of a confirm run passes the read guard or the fence, and the merge is refused without a PR', () => {
      const fake = ciFake()
      const token = tokenOf(apply(fake, 'widget').text)
      fake.state.calls.length = 0
      assert.equal(apply(fake, 'widget', '--confirm', token).code, 0)
      const ctx = { text: NPM_YAML, pr: { number: 20, sha: PR_SHA } }
      for (const c of fake.state.calls) {
        const input = c.input === undefined ? undefined : JSON.parse(c.input)
        assert.equal(isReadOnly(c.args) || isAllowedWrite(c.args, input, TARGET, ctx), true, c.args.join(' '))
      }
      const merge = fake.state.calls.find((c) => c.args.join(' ').endsWith('/merge --input -'))
      assert.equal(isAllowedWrite(merge.args, JSON.parse(merge.input), TARGET, { text: NPM_YAML, pr: null }), false)
    })

    test('the branch starts at the default branch head, and the file and the PR are the planned ones', () => {
      const fake = ciFake()
      confirmCi(fake)
      const body = (suffix) => fake.state.writes.find((w) => w.path.endsWith(suffix)).body
      assert.deepEqual(body('/git/refs'), { ref: `refs/heads/${CI_BRANCH}`, sha: BASE_SHA })
      assert.deepEqual(body(`/contents/${CI_FILE}`), { message: CI_MESSAGE, content: b64(NPM_YAML), branch: CI_BRANCH })
      assert.deepEqual(body('/pulls'), { title: CI_TITLE, head: CI_BRANCH, base: 'main', body: CI_BODY, draft: false })
    })

    test('waits on a clock: polls 30 s apart until tests is green, then merges', () => {
      const fake = ciFake()
      const token = tokenOf(apply(fake, 'widget').text)
      const before = pollsOf(fake).length
      const { code } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 0)
      assert.deepEqual(fake.clock.sleeps, [30000, 30000])
      assert.equal(fake.clock.t, 60000)
      // One read to find an earlier PR, then three polls: pending, pending, green.
      assert.equal(pollsOf(fake).length - before, 1 + 3)
    })

    test('the merge pins the head sha from the poll that read green, not the sha in the PR open response', () => {
      const head = 'c'.repeat(40)
      const fake = ciFake({ ci: { openSha: head } })
      assert.equal(confirmCi(fake).code, 0)
      const merge = fake.state.writes.find((w) => w.path.endsWith('/merge')).body
      assert.deepEqual(merge, { merge_method: 'squash', sha: head })
      assert.notEqual(merge.sha, STALE_SHA)
    })

    test('the PR check runs on the green poll head sha', () => {
      const head = 'c'.repeat(40)
      const fake = ciFake({ ci: { openSha: head } })
      confirmCi(fake)
      const reads = fake.state.calls.map((c) => c.args.join(' '))
      assert.ok(reads.includes(`api repos/octo/widget/contents/${CI_FILE}?ref=${head}`))
      assert.equal(reads.some((r) => r.includes(STALE_SHA)), false)
    })

    test('a push after the green poll makes the merge fail on the pinned sha, and nothing is deleted or protected', () => {
      // The poll reads green on commit A while GitHub already holds commit B.
      const A = 'c'.repeat(40)
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML, pr: ciPr({ headRefOid: PR_SHA }) } })
      const run = (args, input) =>
        args.join(' ').includes('--state open')
          ? { code: 0, stdout: JSON.stringify([{ ...ciPr({ headRefOid: A }), statusCheckRollup: green() }]), stderr: '' }
          : fake.run(args, input)
      const token = tokenOf(runApply(run, ['widget'], fake.clock).text)
      const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
      assert.equal(code, 1)
      assert.deepEqual(wrote(fake).slice(-1), [MERGE])
      assert.equal(fake.state.writes.at(-1).body.sha, A)
      assert.match(text, /Head branch was modified/)
      assert.match(text, /PR #20/)
      assert.equal(fake.state.ci.branch, true)
    })

    test('waits for tests to exist: no checks right after the PR opens is not green', () => {
      const fake = ciFake({ ci: { rollup: (t) => (t >= 60000 ? green() : []) } })
      assert.equal(confirmCi(fake).code, 0)
      assert.equal(fake.clock.t, 60000)
    })

    test('a green check that is not tests does not count', () => {
      const fake = ciFake({ ci: { rollup: (t, ci) => (ci.pr.state === 'MERGED' ? green() : [done('lint'), ...(t >= 90000 ? green() : [])]) } })
      assert.equal(confirmCi(fake).code, 0)
      assert.equal(fake.clock.t, 90000)
    })

    test('a resume with an open CI PR writes no ref, file or PR, and finishes', () => {
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML, pr: ciPr({ number: 20 }), rollup: green } })
      const { code, text } = confirmCi(fake)
      assert.equal(code, 0, text)
      assert.deepEqual(wrote(fake), [...BEFORE, MERGE, DELETE, PUT])
    })

    test('a resume with the branch and the file opens the PR only', () => {
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML } })
      assert.equal(confirmCi(fake).code, 0)
      assert.deepEqual(wrote(fake), [...BEFORE, OPEN, MERGE, DELETE, PUT])
    })

    test('a resume with the branch and no file puts the file and opens the PR, with no ref create', () => {
      const fake = ciFake({ ci: { branch: true } })
      assert.equal(confirmCi(fake).code, 0)
      assert.deepEqual(wrote(fake), [...BEFORE, FILE, OPEN, MERGE, DELETE, PUT])
    })

    test('labels that exist and settings that are on are not written again', () => {
      const labels = LABELS.map((l) => ({ name: l.name, color: l.color, description: l.description }))
      const fake = ciFake({ labels, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      assert.equal(confirmCi(fake).code, 0)
      assert.deepEqual(wrote(fake), [REF, FILE, OPEN, MERGE, DELETE, PUT])
    })

    test('a plan with no protection PUT completes the CI setup, writes no PUT and exits 0', () => {
      const contexts = ['orchestrai/review', 'orchestrai/test', 'tests']
      const protection = { ...SET_UP_PROTECTION, required_status_checks: { strict: true, contexts } }
      const labels = LABELS.map((l) => ({ ...l }))
      const fake = ciFake({ protection, labels, repo: { allow_auto_merge: true, allow_squash_merge: true } })
      const { code, text } = confirmCi(fake)
      assert.equal(code, 0, text)
      assert.deepEqual(wrote(fake), [REF, FILE, OPEN, MERGE, DELETE])
    })

    test('a token from a plan with no PR is stale once a PR is open: nothing is written', () => {
      const fake = ciFake({ ci: { branch: true, file: NPM_YAML } })
      const token = tokenOf(apply(fake, 'widget').text)
      fake.state.ci.pr = ciPr()
      const { code, text } = apply(fake, 'widget', '--confirm', token)
      assert.equal(code, 2)
      assert.match(text, /plan changed since it was shown, nothing written/)
      assert.deepEqual(fake.state.writes, [])
    })

    describe('stops', () => {
      const stops = (name, over, exit, written, pattern, still = {}) => {
        test(`${name}: exit ${exit}, then no more writes`, () => {
          const fake = ciFake(over)
          const { code, text } = confirmCi(fake)
          assert.equal(code, exit, text)
          assert.deepEqual(wrote(fake), written)
          assert.match(text, pattern)
          assert.match(text, /stopped here/)
          assert.doesNotMatch(text, /nothing written/)
          for (const [key, want] of Object.entries(still)) assert.equal(fake.state.ci[key], want, key)
        })
      }
      const bad = fail(422, 'Validation Failed')
      const upToOpen = [...BEFORE, REF, FILE, OPEN]

      stops('a label write fails', { ci: { fail: { label: bad } } }, 1, ['POST /labels'], /write failed: POST repos\/octo\/widget\/labels .*Validation Failed/)
      stops('the repo PATCH fails', { failPatch: bad }, 1, BEFORE, /write failed: PATCH repos\/octo\/widget: Validation Failed/)
      stops('the default branch head cannot be read', { ci: { fail: { branchRead: fail(500, 'Server Error') } } }, 1, BEFORE, /default branch main.*Server Error/s)
      stops('the branch create fails', { ci: { fail: { refCreate: bad } } }, 1, [...BEFORE, REF], /write failed: POST repos\/octo\/widget\/git\/refs/)
      stops('the file put fails', { ci: { fail: { filePut: bad } } }, 1, [...BEFORE, REF, FILE], /write failed: PUT .*contents/, { branch: true })
      stops('the PR open fails', { ci: { fail: { prOpen: bad } } }, 1, upToOpen, /write failed: POST repos\/octo\/widget\/pulls/)
      stops(
        'a check is red',
        { ci: { rollup: (t) => (t >= 30000 ? [{ ...done('tests'), conclusion: 'FAILURE' }] : [pending('tests')]) } },
        1,
        upToOpen,
        /a check failed on PR #20.*stays open/s
      )
      stops(
        'one check is red while another is still running',
        { ci: { rollup: () => [pending('tests'), { ...done('lint'), conclusion: 'FAILURE' }] } },
        1,
        upToOpen,
        /a check failed on PR #20.*stays open/s
      )
      stops(
        'the merge fails',
        { ci: { fail: { merge: fail(405, 'Required status check is expected') } } },
        1,
        [...upToOpen, MERGE],
        /write failed: PUT .*merge: Required status check is expected.*PR #20/s
      )
      stops('the branch delete fails', { ci: { fail: { refDelete: bad } } }, 1, [...upToOpen, MERGE, DELETE], /write failed: DELETE .*git\/refs\/heads/, {
        branch: true,
      })

      test('the branch delete answers 422 Reference does not exist: it counts as done and the protection is written', () => {
        const fake = ciFake({ ci: { fail: { refDelete: fail(422, 'Reference does not exist') } } })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 0, text)
        assert.deepEqual(wrote(fake), [...upToOpen, MERGE, DELETE, PUT])
        assert.match(text, /already deleted: DELETE .*git\/refs\/heads/)
        assert.doesNotMatch(text, /write failed/)
      })

      test('the branch delete answers 404: it still stops, with no protection write', () => {
        const fake = ciFake({ ci: { fail: { refDelete: fail(404, 'Reference does not exist') } } })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 1, text)
        assert.deepEqual(wrote(fake), [...upToOpen, MERGE, DELETE])
        assert.match(text, /write failed: DELETE .*Reference does not exist/)
        assert.match(text, /stopped here/)
      })

      // The run stops before it re-reads the repo, so it cannot say which path the next apply takes.
      for (const [name, base] of [
        ['merged into main', 'main'],
        ['merged into another base', 'dev'],
      ]) {
        test(`the branch delete fails with 422 after the PR is ${name}: the stop names no path, and the next apply takes the right one`, () => {
          const fake = ciFake({ ci: { fail: { refDelete: fail(422, 'Validation Failed') } } })
          const token = tokenOf(apply(fake, 'widget').text)
          const run = (args, input) => {
            if (base !== 'main' && args.join(' ') === 'api repos/octo/widget/pulls/20/files') fake.state.ci.pr.baseRefName = base
            return fake.run(args, input)
          }
          const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
          assert.equal(code, 1, text)
          assert.deepEqual(wrote(fake), [...upToOpen, MERGE, DELETE])
          assert.match(text, /^PR #20 \(https:\/\/github\.com\/octo\/widget\/pull\/20\) is merged; run apply again$/m)
          assert.doesNotMatch(text, /normal path/)
          assert.doesNotMatch(text, /could not find/)

          const next = apply(fake, 'widget')
          assert.equal(next.code, 0, next.text)
          if (base === 'main') {
            assert.match(next.text, /required check: tests/)
            assert.doesNotMatch(next.text, /expected check/)
          } else {
            assert.match(next.text, /^ {2}expected check: tests$/m)
            assert.match(next.text, new RegExp(`^ {2}resume: branch ${CI_BRANCH} holds the planned workflow file$`, 'm'))
          }
        })
      }

      test('the protection PUT fails: the CI PR stays merged and the run exits 1', () => {
        const fake = ciFake({ failPut: bad })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 1)
        assert.deepEqual(wrote(fake), [...upToOpen, MERGE, DELETE, PUT])
        assert.match(text, /write failed: PUT .*protection.*Validation Failed/)
        assert.match(text, /^octo\/widget: not set up$/m)
      })

      test('waiting 20 minutes without a result stops with the PR named: 41 polls, 30 s apart, no merge', () => {
        const fake = ciFake({ ci: { rollup: () => [pending('tests')] } })
        const token = tokenOf(apply(fake, 'widget').text)
        const before = pollsOf(fake).length
        const { code, text } = apply(fake, 'widget', '--confirm', token)
        assert.equal(code, 1)
        assert.deepEqual(wrote(fake), upToOpen)
        assert.equal(fake.clock.sleeps.length, 40)
        assert.ok(fake.clock.sleeps.every((ms) => ms === 30000))
        assert.equal(fake.clock.t, 20 * 60 * 1000)
        assert.equal(pollsOf(fake).length - before, 1 + 41, 'one read for an earlier PR and 41 polls')
        assert.match(text, /after 20 minutes.*PR #20 .*stays open/s)
        assert.match(text, /stopped here/)
      })

      test('timing out while tests has not run says so', () => {
        const fake = ciFake({ ci: { rollup: () => [done('lint')] } })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 1)
        assert.match(text, /the tests check has not run/)
      })

      test('a poll that takes time shortens the last sleep, so the wait never passes the deadline', () => {
        const fake = ciFake({ ci: { rollup: () => [pending('tests')] } })
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ').includes('--state open') && fake.state.writes.length > 0) fake.clock.t += 7000
          return fake.run(args, input)
        }
        const start = fake.clock.t
        const { code } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1)
        assert.ok(fake.clock.sleeps.every((ms) => ms <= 30000))
        assert.ok(fake.clock.sleeps.at(-1) < 30000, 'the last sleep is cut short')
        assert.ok(fake.clock.t - start >= 20 * 60 * 1000)
        assert.ok(fake.clock.t - start <= 20 * 60 * 1000 + 7000)
      })

      const afterOpen = (fake) => fake.state.writes.some((w) => w.path.endsWith('/pulls'))

      test('a failed poll read stops with the PR named', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) =>
          args.join(' ').includes('--state open') && afterOpen(fake) ? fail(502, 'Bad Gateway') : fake.run(args, input)
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1)
        assert.match(text, /Bad Gateway/)
        assert.match(text, /stopped here/)
        assert.deepEqual(wrote(fake), upToOpen)
      })

      test('a PR that is no longer open stops the wait', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) =>
          args.join(' ').includes('--state open') && afterOpen(fake) ? { code: 0, stdout: '[]', stderr: '' } : fake.run(args, input)
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1)
        assert.match(text, /no longer open/)
        assert.deepEqual(wrote(fake), upToOpen)
      })

      test('a PR that turned into a draft during the wait is not merged: exit 2', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ').includes('--state open') && fake.state.ci.pr) fake.state.ci.pr.isDraft = true
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 2)
        assert.match(text, /PR #20 is a draft/)
        assert.equal(wrote(fake).includes(MERGE), false)
      })

      test('a base change during the wait is not merged: exit 2, stopped here', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ').includes('--state open') && fake.state.ci.pr) fake.state.ci.pr.baseRefName = 'dev'
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 2)
        assert.match(text, /PR #20 has base dev, not main/)
        assert.match(text, /stopped here/)
        assert.equal(wrote(fake).includes(MERGE), false)
      })

      test('a second open PR from the CI branch during the wait stops: exit 2, nothing written after it', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ').includes('--state open') && fake.state.ci.pr) fake.state.ci.openOthers = [ciPr({ number: 21 })]
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 2, text)
        assert.match(text, /more than one open PR.*#20.*#21/s)
        assert.match(text, /stopped here/)
        assert.deepEqual(wrote(fake), upToOpen)
      })

      test('a stop before the first write may say nothing was written', () => {
        // Labels and settings are right and an open PR is found, so the poll is the first call that can fail.
        const labels = LABELS.map((l) => ({ ...l }))
        const fake = ciFake({ labels, repo: { allow_auto_merge: true, allow_squash_merge: true }, ci: { branch: true, file: NPM_YAML, pr: ciPr() } })
        const token = tokenOf(apply(fake, 'widget').text)
        let polls = 0
        const run = (args, input) => (args.join(' ').includes('--state open') && ++polls === 2 ? fail(502, 'Bad Gateway') : fake.run(args, input))
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1)
        assert.match(text, /Bad Gateway/)
        assert.match(text, /nothing written/)
        assert.deepEqual(fake.state.writes, [])
      })

      const beforeMerge = (name, over, pattern, exit = 2) => {
        test(`the check before the merge: ${name}: exit ${exit}, no merge`, () => {
          const fake = ciFake({ ci: over })
          const { code, text } = confirmCi(fake)
          assert.equal(code, exit, text)
          assert.deepEqual(wrote(fake), upToOpen)
          assert.match(text, pattern)
          assert.match(text, /PR #20/)
          assert.match(text, /stopped here/)
          assert.doesNotMatch(text, /nothing written/)
        })
      }
      beforeMerge('a second file on the branch', { prFiles: [{ filename: CI_FILE, status: 'added' }, { filename: 'x.js', status: 'added' }] }, /exactly one file/)
      beforeMerge('a different file at the head', { shaFiles: { [PR_SHA]: 'name: other\n' } }, /not the planned file/)
      beforeMerge('the PR files cannot be read', { fail: { prFiles: fail(500, 'Server Error') } }, /Server Error/, 1)
    })

    describe('the safety stop after the merge', () => {
      const withMergedRollup = (merged) => (t, ci) => (ci.pr.state === 'MERGED' ? merged : t >= 60000 ? green() : [pending('tests')])
      const upToDelete = [...BEFORE, REF, FILE, OPEN, MERGE, DELETE]

      test('another check name on the merged PR stops before the PUT: exit 2, a normal-path plan and a new token', () => {
        const fake = ciFake({ ci: { rollup: withMergedRollup([done('tests'), done('lint')]) } })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 2, text)
        assert.deepEqual(wrote(fake), upToDelete)
        assert.match(text, /checks that ran on PR #20: lint, tests; the plan expected: tests/)
        assert.match(text, /stopped here/)
        assert.doesNotMatch(text, /nothing written/)
        assert.match(text, /^ {2}required check: lint$/m)
        assert.match(text, /^ {2}PUT repos\/octo\/widget\/branches\/main\/protection$/m)
        assert.ok(tokenOf(text), 'no new token')

        // The new token is the normal path's: a confirm with it writes the PUT.
        const again = apply(fake, 'widget', '--confirm', tokenOf(text))
        assert.equal(again.code, 0, again.text)
        assert.deepEqual(fake.state.protection.required_status_checks.contexts, ['lint', 'orchestrai/review', 'orchestrai/test', 'tests'])
      })

      test('a change to the repo during the wait stops before the PUT too', () => {
        const fake = ciFake({
          ci: {
            rollup: (t, ci) => {
              // Someone turns on dismiss stale reviews by hand while the run waits.
              if (t >= 30000 && fake.state.protection === null) {
                fake.state.protection = {
                  ...SET_UP_PROTECTION,
                  required_status_checks: { strict: true, contexts: ['x'] },
                  required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true },
                }
              }
              return withMergedRollup([done('tests')])(t, ci)
            },
          },
        })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 2, text)
        assert.match(text, /the repo changed during the wait/)
        assert.equal(wrote(fake).includes(PUT), false)
        assert.ok(tokenOf(text))
      })

      test('a repo that someone finished during the wait needs no PUT: the run reports the state and writes none', () => {
        const contexts = ['orchestrai/review', 'orchestrai/test', 'tests']
        const fake = ciFake({
          ci: {
            rollup: (t, ci) => {
              if (t >= 30000 && fake.state.protection === null) {
                fake.state.protection = { ...SET_UP_PROTECTION, required_status_checks: { strict: true, contexts } }
              }
              return withMergedRollup([done('tests')])(t, ci)
            },
          },
        })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 0, text)
        assert.match(text, /the repo changed during the wait; nothing is left to write/)
        assert.equal(wrote(fake).includes(PUT), false)
        assert.match(text, /^octo\/widget: set up$/m)
      })

      test('signed commits turned on during the wait stop before the PUT: exit 2, stopped here, nothing more written', () => {
        const fake = ciFake({
          ci: {
            rollup: (t, ci) => {
              if (t >= 30000 && fake.state.protection === null) {
                fake.state.protection = { ...SET_UP_PROTECTION, required_signatures: { enabled: true } }
              }
              return withMergedRollup([done('tests')])(t, ci)
            },
          },
        })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 2, text)
        assert.match(text, /refusing: octo\/widget requires signed commits/)
        assert.match(text, /stopped here/)
        assert.doesNotMatch(text, /nothing written/)
        assert.deepEqual(wrote(fake), upToDelete)
        assert.equal(tokenOf(text), undefined, 'a token would invite the same PUT')
        assert.equal(fake.state.protection.required_signatures.enabled, true)
      })

      test('a newer non-CI PR decides the checks and a retarget still stops at the missing ci.yml: exit 1, stopped here, no token', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ') === 'api repos/octo/widget/pulls/20/files') {
            fake.state.ci.pr.baseRefName = 'dev'
            // The newest PR decides the checks, so the safety stop must not depend on the merged CI PR.
            fake.state.prs = [pr(21, [done('tests'), done('lint')], false, { headRefName: 'feat/other', state: 'OPEN' })]
          }
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1, text)
        assert.deepEqual(wrote(fake), upToDelete)
        assert.match(text, /could not find .*ci\.yml on main/)
        assert.match(text, /stopped here/)
        assert.equal(tokenOf(text), undefined)
      })

      test('a newer non-CI PR decides the checks: the safety stop names that PR, not the CI PR', () => {
        const fake = ciFake({ ci: { rollup: withMergedRollup([done('tests'), done('lint')]) } })
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ') === 'api repos/octo/widget/pulls/20/files') {
            fake.state.prs = [pr(21, [done('tests'), done('lint')], false, { headRefName: 'feat/other', state: 'OPEN' })]
          }
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 2, text)
        assert.deepEqual(wrote(fake), upToDelete)
        assert.match(text, /checks that ran on PR #21: lint, tests; the plan expected: tests/)
        assert.doesNotMatch(text, /checks that ran on PR #20/)
        assert.match(text, /stopped here/)
        assert.ok(tokenOf(text), 'no new token')
      })

      test('no PR decides the checks: the safety stop names no PR', () => {
        const fake = ciFake({ ci: { rollup: withMergedRollup([]) } })
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ') === 'api repos/octo/widget/pulls/20/files') {
            fake.state.tree = fake.state.tree.filter((p) => p !== 'src/a.test.js')
          }
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 2, text)
        assert.match(text, /refusing: checks that ran: none; the plan expected: tests/)
        assert.doesNotMatch(text, /PR #null/)
        assert.ok(tokenOf(text), 'no new token')
      })

      test('a PR retargeted before the merge leaves ci.yml off the default branch: exit 1, stopped here, no token, no PUT', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) => {
          if (args.join(' ') === 'api repos/octo/widget/pulls/20/files') fake.state.ci.pr.baseRefName = 'dev'
          return fake.run(args, input)
        }
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1, text)
        assert.deepEqual(wrote(fake), upToDelete)
        assert.match(text, /could not find .*ci\.yml on main/)
        assert.match(text, /stopped here/)
        assert.equal(tokenOf(text), undefined)
        assert.equal(wrote(fake).includes(PUT), false)
      })

      test('a merged PR that still does not count as CI stops with exit 1', () => {
        const fake = ciFake({ ci: { rollup: withMergedRollup([]) } })
        const { code, text } = confirmCi(fake)
        assert.equal(code, 1, text)
        assert.deepEqual(wrote(fake), upToDelete)
        assert.match(text, /still needs CI/)
        assert.match(text, /stopped here/)
      })

      test('a failed re-read after the merge stops with exit 1 and does not say nothing was written', () => {
        const fake = ciFake()
        const token = tokenOf(apply(fake, 'widget').text)
        const run = (args, input) =>
          args.join(' ') === 'api repos/octo/widget' && fake.state.writes.some((w) => w.path.endsWith('/merge'))
            ? fail(502, 'Bad Gateway')
            : fake.run(args, input)
        const { code, text } = runApply(run, ['widget', '--confirm', token], fake.clock)
        assert.equal(code, 1)
        assert.match(text, /Bad Gateway/)
        assert.match(text, /stopped here/)
        assert.doesNotMatch(text, /nothing written/)
        assert.equal(wrote(fake).includes(PUT), false)
      })
    })

    describe('the clock', () => {
      test('SYSTEM_CLOCK sleeps for real: sleep(5) moves now() forward by at least 5 ms', () => {
        const before = SYSTEM_CLOCK.now()
        SYSTEM_CLOCK.sleep(5)
        assert.ok(SYSTEM_CLOCK.now() - before >= 5)
      })

      test('runApply without a clock uses SYSTEM_CLOCK, which a run that finds green at once never sleeps on', () => {
        const fake = ciFake({ ci: { rollup: green } })
        const token = tokenOf(runApply(fake.run, ['widget']).text)
        assert.equal(runApply(fake.run, ['widget', '--confirm', token]).code, 0)
        assert.deepEqual(fake.clock.sleeps, [])
      })
    })
  })

  describe('refusals', () => {
    const refused = (name, make, argv, pattern) => {
      test(`refuses ${name} and writes nothing`, () => {
        const fake = make()
        const { code, text } = runApply(fake.run, argv)
        assert.equal(code, 2)
        assert.match(text, pattern)
        assert.deepEqual(fake.state.writes, [])
        assert.equal(fake.state.calls.some((c) => !isReadOnly(c.args)), false)
      })
    }

    refused('no repo', makeFake, [], /usage/i)
    refused('two repos', makeFake, ['widget', 'other'], /usage|one repo/i)
    refused('a flag it does not know', makeFake, ['widget', '--force'], /usage|unknown/i)
    refused('--confirm without a token', makeFake, ['widget', '--confirm'], /usage|token/i)
    refused('a repeated --confirm', makeFake, ['widget', '--confirm', 'a', '--confirm', 'b'], /usage|token/i)
    refused('--install without --test', makeFake, ['widget', '--install', 'make deps'], /usage.*--install and --test/i)
    refused('--test without --install', makeFake, ['widget', '--test', 'make test'], /usage.*--install and --test/i)
    refused('a repeated --install', makeFake, ['widget', '--install', 'a', '--install', 'b', '--test', 't'], /usage.*--install/i)
    refused('a repeated --test', makeFake, ['widget', '--install', 'a', '--test', 't', '--test', 'u'], /usage.*--test/i)
    refused('--install without a value', makeFake, ['widget', '--test', 't', '--install'], /usage.*--install needs one command/i)
    refused('--test followed by another flag', makeFake, ['widget', '--install', 'a', '--test', '--confirm', 'x'], /usage.*--test needs one command/i)
    refused('an empty command', makeFake, ['widget', '--install', ' ', '--test', 't'], /usage.*--install needs one command/i)
    refused('a command with a newline', makeFake, ['widget', '--install', 'a\nb', '--test', 't'], /usage.*control character/i)
    refused('a command with a carriage return', makeFake, ['widget', '--install', 'a', '--test', 't\r'], /usage.*control character/i)
    refused('a command with a unicode line separator', makeFake, ['widget', '--install', 'a', '--test', 't\u2028u'], /usage.*control character/i)
    // YAML does not allow these characters at all, so the generated ci.yml would not parse.
    refused('a command with a C1 control character', makeFake, ['widget', '--install', 'a', '--test', 'c\u0090d'], /usage.*control character/i)
    refused('a command with the first C1 control character', makeFake, ['widget', '--install', '\u0080', '--test', 't'], /usage.*control character/i)
    refused('a command with the last C1 control character', makeFake, ['widget', '--install', 'a', '--test', 't\u009f'], /usage.*control character/i)
    refused('a command with U+FFFE', makeFake, ['widget', '--install', 'a', '--test', 't\ufffeu'], /usage.*control character/i)
    refused('a command with U+FFFF', makeFake, ['widget', '--install', 'a\uffff', '--test', 't'], /usage.*control character/i)
    refused('a command with a lone surrogate', makeFake, ['widget', '--install', 'a', '--test', 't\ud800u'], /usage.*control character/i)
    refused('a name starting with a dash', makeFake, ['--web'], /usage|unknown|repo/i)
    refused('a name starting with a dot', makeFake, ['.hidden'], /repo name/i)
    refused('an owner/name part starting with a dash', makeFake, ['octo/--web'], /repo name/i)
    refused('a name with a space', makeFake, ['wid get'], /repo name/i)
    refused('a name with a slash too many', makeFake, ['octo/widget/extra'], /repo name/i)
    refused('an owner that is not the user', makeFake, ['some-org/x'], /not your own|owner/i)

    // The names of Object.prototype members are valid repo names. The fake answers
    // each one as octo/widget, so the plan runs on the answer.
    for (const name of ['constructor', 'toString', 'valueOf']) {
      test(`accepts a repo named ${name} and writes nothing`, () => {
        const fake = makeFake()
        const run = (args, input) => fake.run(args.map((a) => (a === `repos/octo/${name}` ? 'repos/octo/widget' : a)), input)
        const { code, text } = runApply(run, [name])
        assert.equal(code, 0, text)
        assert.ok(tokenOf(text), 'no token line')
        assert.deepEqual(fake.state.writes, [])
      })
    }

    refused('an archived repo', () => makeFake({ repo: { archived: true } }), ['widget'], /archived/)
    refused('an organization owner', () => makeFake({ repo: { owner: { login: 'octo', type: 'Organization' } } }), ['widget'], /organization|not a user/i)
    refused(
      'a repo whose owner is another login',
      () => makeFake({ repo: { owner: { login: 'someone', type: 'User' } } }),
      ['widget'],
      /owner/i
    )
    refused(
      'a plan without branch protection',
      () => makeFake({ protectionError: fail(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.') }),
      ['widget'],
      /blocked|not available on the current plan/i
    )
    // Before #551 this repo was refused with "needs CI first". Its tree has no
    // root manifest, so it now reaches stack detection and fails there.
    refused(
      'a repo that needs CI when no stack can be detected',
      () => makeFake({ prs: [] }),
      ['widget'],
      /could not detect the install and test commands: no package\.json with a test script, requirements\.txt, pyproject\.toml or go\.mod at the root/
    )

    describe('signed commits and the protection PUT', () => {
      // The PUT replaces the whole rule and cannot carry required_signatures, so a
      // repo that requires signed commits is refused whenever the plan has a PUT.
      const signed = { ...SET_UP_PROTECTION, required_signatures: { enabled: true } }
      const incomplete = { ...signed, enforce_admins: { enabled: false } }

      test('a PUT in the plan is refused in plan mode: no token, nothing written', () => {
        const fake = makeFake({ protection: incomplete, repo: { allow_auto_merge: true, allow_squash_merge: true } })
        const { code, text } = runApply(fake.run, ['widget'])
        assert.equal(code, 2)
        assert.match(text, /requires signed commits/)
        assert.equal(tokenOf(text), undefined)
        assert.doesNotMatch(text, /confirm token/)
        assert.deepEqual(fake.state.writes, [])
        assert.equal(fake.state.calls.some((c) => !isReadOnly(c.args)), false)
      })

      test('a PUT in the plan is refused with any --confirm token, and nothing is written', () => {
        const fake = makeFake({ protection: incomplete, repo: { allow_auto_merge: true, allow_squash_merge: true } })
        const { code, text } = runApply(fake.run, ['widget', '--confirm', 'abcdefabcdef'])
        assert.equal(code, 2)
        assert.match(text, /requires signed commits/)
        assert.deepEqual(fake.state.writes, [])
        assert.equal(fake.state.calls.some((c) => !isReadOnly(c.args)), false)
      })

      test('a plan with a PUT and a PATCH is refused too, so the PATCH is not written alone', () => {
        const fake = makeFake({ protection: incomplete })
        const { code, text } = runApply(fake.run, ['widget', '--confirm', 'abcdefabcdef'])
        assert.equal(code, 2)
        assert.match(text, /requires signed commits/)
        assert.deepEqual(fake.state.writes, [])
      })

      test('a PATCH-only plan is not refused: the PATCH does not touch the rule', () => {
        const fake = makeFake({ protection: signed })
        const { code, text } = runApply(fake.run, ['widget'])
        assert.equal(code, 0)
        assert.doesNotMatch(text, /signed commits/)
        assert.match(text, /^ {2}PATCH repos\/octo\/widget$/m)
        assert.doesNotMatch(text, /^ {2}PUT /m)
        assert.ok(tokenOf(text), 'no token line')
        assert.deepEqual(fake.state.writes, [])
      })

      test('a PATCH-only plan is written on confirm', () => {
        const fake = makeFake({ protection: signed })
        const token = tokenOf(runApply(fake.run, ['widget']).text)
        const { code } = runApply(fake.run, ['widget', '--confirm', token])
        assert.equal(code, 0)
        assert.deepEqual(
          fake.state.writes.map((w) => w.method),
          ['PATCH']
        )
      })

      test('nothing to change still prints set up, nothing to change', () => {
        const fake = makeFake({ protection: signed, repo: { allow_auto_merge: true, allow_squash_merge: true } })
        const { code, text } = runApply(fake.run, ['widget'])
        assert.equal(code, 0)
        assert.equal(text, 'octo/widget: set up, nothing to change\n')
      })
    })

    test('an owner that is not the user reads only the user, not the repo', () => {
      const fake = makeFake()
      runApply(fake.run, ['some-org/x'])
      assert.deepEqual(
        fake.state.calls.map((c) => c.args.join(' ')),
        ['--version', 'api user']
      )
    })

    test('a usage error makes no call at all', () => {
      const fake = makeFake()
      runApply(fake.run, [])
      runApply(fake.run, ['a', 'b'])
      runApply(fake.run, ['.x'])
      assert.deepEqual(fake.state.calls, [])
    })

    test('a read error exits 1 and writes nothing', () => {
      const fake = makeFake({ protectionError: fail(500, 'Server Error') })
      const { code, text } = runApply(fake.run, ['widget'])
      assert.equal(code, 1)
      assert.match(text, /Server Error/)
      assert.deepEqual(fake.state.writes, [])
    })

    test('a refusal with --confirm still writes nothing', () => {
      const fake = makeFake({ repo: { archived: true } })
      const { code } = runApply(fake.run, ['widget', '--confirm', 'abcdefabcdef'])
      assert.equal(code, 2)
      assert.deepEqual(fake.state.writes, [])
    })
  })
})

describe('runStatuses', () => {
  const HEAD = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
  const OTHER_HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6'
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const fail = (status, message) => ({
    code: 1,
    stdout: JSON.stringify({ message, status: String(status) }),
    stderr: `gh: ${message} (HTTP ${status})`,
  })

  const BOTH = ['orchestrai/review', 'orchestrai/test']
  const protectionWith = (contexts) => ({
    required_status_checks: { strict: true, contexts, checks: contexts.map((context) => ({ context, app_id: null })) },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 0 },
  })

  // A made-up account. Each `over` key replaces that read's answer.
  function makeFake(over = {}) {
    const state = {
      login: 'octo',
      repo: { full_name: 'octo/widget', name: 'widget', owner: { login: 'octo', type: 'User' }, ...over.repo },
      pr: { state: 'open', merged: false, draft: false, head: { sha: HEAD }, base: { ref: 'main' }, ...over.pr },
      protection: over.protection === undefined ? ok(protectionWith(BOTH)) : over.protection,
      userRes: over.userRes ?? null,
      repoRes: over.repoRes ?? null,
      prRes: over.prRes ?? null,
      calls: [],
    }
    function run(args, input) {
      state.calls.push({ args, input })
      const key = args.join(' ')
      if (key === 'api user') return state.userRes ?? ok({ login: state.login })
      if (key === 'api repos/octo/widget') return state.repoRes ?? ok(state.repo)
      if (key === 'api repos/octo/widget/pulls/42') return state.prRes ?? ok(state.pr)
      if (key === `api repos/octo/widget/branches/${encodeURIComponent(state.pr.base.ref)}/protection`) return state.protection
      throw new Error(`unexpected gh call: ${key}`)
    }
    return { run, state }
  }

  const statuses = (fake, ...argv) => runStatuses(fake.run, argv)
  const readPaths = (fake) => fake.state.calls.map((c) => c.args.join(' '))
  const lines = (text) => text.trimEnd().split('\n')

  // Splits one printed command the way a shell would, for single quotes only.
  function splitCommand(line) {
    const words = []
    let cur = null
    let quoted = false
    for (const ch of line) {
      if (ch === "'") {
        quoted = !quoted
        cur ??= ''
      } else if (ch === ' ' && !quoted) {
        if (cur !== null) words.push(cur)
        cur = null
      } else {
        cur = (cur ?? '') + ch
      }
    }
    if (cur !== null) words.push(cur)
    return words
  }

  const TEST_LINE = `gh api -X POST 'repos/octo/widget/statuses/${HEAD}' -f state=success -f context=orchestrai/test -f description='by hand: owner verified'`
  const REVIEW_LINE = `gh api -X POST 'repos/octo/widget/statuses/${HEAD}' -f state=success -f context=orchestrai/review -f description='by hand: owner reviewed'`
  const QUEUE_LINE = `gh pr merge 42 --repo octo/widget --squash --auto --match-head-commit ${HEAD}`

  describe('the printed commands', () => {
    test('prints the head and the three commands in the pipeline order', () => {
      const fake = makeFake()
      const { code, text } = statuses(fake, 'widget', '42')
      assert.equal(code, 0)
      assert.equal(
        text,
        [`octo/widget PR #42: head ${HEAD}`, 'run these in your own shell:', TEST_LINE, REVIEW_LINE, QUEUE_LINE].join('\n') + '\n'
      )
    })

    test('makes exactly four reads, in order, and never passes input', () => {
      const fake = makeFake()
      statuses(fake, 'widget', '42')
      assert.deepEqual(readPaths(fake), [
        'api user',
        'api repos/octo/widget',
        'api repos/octo/widget/pulls/42',
        'api repos/octo/widget/branches/main/protection',
      ])
      for (const c of fake.state.calls) {
        assert.equal(isReadOnly(c.args), true, c.args.join(' '))
        assert.equal(c.input, undefined)
      }
    })

    test('a short name and owner/name give the same output, matched without regard to case', () => {
      const a = statuses(makeFake(), 'widget', '42')
      assert.equal(statuses(makeFake(), 'octo/widget', '42').text, a.text)
      assert.equal(statuses(makeFake(), 'Octo/widget', '42').text, a.text)
    })

    test('every printed command is refused by the read guard and the write fence', () => {
      const { text } = statuses(makeFake(), 'widget', '42')
      const commands = lines(text).slice(2)
      assert.equal(commands.length, 3)
      for (const line of commands) {
        const words = splitCommand(line)
        assert.equal(words[0], 'gh')
        const args = words.slice(1)
        assert.equal(isReadOnly(args), false, line)
        assert.equal(isAllowedWrite(args, undefined, { repo: 'octo/widget', branch: 'main' }), false, line)
        let called = false
        assert.throws(
          () =>
            guarded(() => {
              called = true
              return { code: 0, stdout: '', stderr: '' }
            })(args),
          /not read-only/
        )
        assert.equal(called, false)
      }
    })

    test('the head is in both status paths and after --match-head-commit', () => {
      const { text } = statuses(makeFake({ pr: { head: { sha: OTHER_HEAD } } }), 'widget', '42')
      const [, , testLine, reviewLine, queueLine] = lines(text)
      assert.ok(testLine.includes(`'repos/octo/widget/statuses/${OTHER_HEAD}'`))
      assert.ok(reviewLine.includes(`'repos/octo/widget/statuses/${OTHER_HEAD}'`))
      assert.ok(queueLine.endsWith(`--match-head-commit ${OTHER_HEAD}`))
      assert.ok(!text.includes(HEAD))
    })

    test('both descriptions start with "by hand: " and differ from every description the pipeline writes', () => {
      const { text } = statuses(makeFake(), 'widget', '42')
      const printed = lines(text)
        .slice(2, 4)
        .map((line) => splitCommand(line).find((w) => w.startsWith('description=')).slice('description='.length))
      for (const d of printed) assert.ok(d.startsWith('by hand: '), d)
      assert.notEqual(printed[0], printed[1])
      const pipeline = new Set()
      for (const track of ['full', 'lean']) {
        for (const fallbackReview of [false, true]) {
          const res = decide({
            track,
            verdictCommit: HEAD,
            head: HEAD,
            fallbackReview,
            autoMerge: true,
            branchProtected: true,
            branchRules: 0,
          })
          for (const s of res.statuses) pipeline.add(s.description)
        }
      }
      assert.ok(pipeline.size >= 4)
      for (const d of printed) assert.ok(!pipeline.has(d), d)
    })

    test('a draft PR gets a ready line just before the queue line', () => {
      const { code, text } = statuses(makeFake({ pr: { draft: true } }), 'widget', '42')
      assert.equal(code, 0)
      assert.deepEqual(lines(text).slice(2), [TEST_LINE, REVIEW_LINE, 'gh pr ready 42 --repo octo/widget', QUEUE_LINE])
    })

    test('a PR that is not a draft gets no ready line', () => {
      assert.doesNotMatch(statuses(makeFake(), 'widget', '42').text, /gh pr ready/)
    })

    test('reads the protection of the PR base branch, not the default branch', () => {
      const fake = makeFake({ pr: { base: { ref: 'release/1.x' } } })
      const { code } = statuses(fake, 'widget', '42')
      assert.equal(code, 0)
      assert.equal(readPaths(fake)[3], 'api repos/octo/widget/branches/release%2F1.x/protection')
    })
  })

  describe('refusals', () => {
    function refuses(fake, argv, pattern) {
      const { code, text } = runStatuses(fake.run, argv)
      assert.equal(code, 2)
      assert.equal(lines(text).length, 1, text)
      assert.match(text, /^refusing: /)
      assert.match(text.trimEnd(), pattern)
      assert.doesNotMatch(text, /gh api|gh pr/)
      for (const c of fake.state.calls) assert.equal(isReadOnly(c.args), true, c.args.join(' '))
    }

    test('an owner other than the user reads only the user', () => {
      const fake = makeFake()
      refuses(fake, ['some-org/widget', '42'], /^refusing: some-org\/widget is not a repo of your own account \(octo\)$/)
      assert.deepEqual(readPaths(fake), ['api user'])
    })

    test('an organization owner type', () => {
      const fake = makeFake({ repo: { owner: { login: 'octo', type: 'Organization' } } })
      refuses(fake, ['widget', '42'], /^refusing: octo\/widget is not a repo of your own account \(octo\)$/)
    })

    test('a repo owner login that differs from the user', () => {
      const fake = makeFake({ repo: { owner: { login: 'someone-else', type: 'User' } } })
      refuses(fake, ['widget', '42'], /^refusing: octo\/widget is not a repo of your own account \(octo\)$/)
    })

    test('a closed PR', () => {
      refuses(makeFake({ pr: { state: 'closed' } }), ['widget', '42'], /^refusing: octo\/widget PR #42 is not open \(closed\)$/)
    })

    test('a merged PR', () => {
      refuses(makeFake({ pr: { state: 'closed', merged: true } }), ['widget', '42'], /^refusing: octo\/widget PR #42 is not open \(merged\)$/)
    })

    const NOT_REQUIRED = /^refusing: octo\/widget does not require orchestrai\/review and orchestrai\/test on main$/

    test('a base branch with no protection', () => {
      refuses(makeFake({ protection: fail(404, 'Branch not protected') }), ['widget', '42'], NOT_REQUIRED)
    })

    test('protection that the plan does not offer', () => {
      const res = fail(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.')
      refuses(makeFake({ protection: res }), ['widget', '42'], NOT_REQUIRED)
    })

    test('only one verdict context required', () => {
      refuses(makeFake({ protection: ok(protectionWith(['orchestrai/review'])) }), ['widget', '42'], NOT_REQUIRED)
      refuses(makeFake({ protection: ok(protectionWith(['orchestrai/test'])) }), ['widget', '42'], NOT_REQUIRED)
    })

    test('CI checks only', () => {
      refuses(makeFake({ protection: ok(protectionWith(['Unit tests'])) }), ['widget', '42'], NOT_REQUIRED)
    })

    test('names the PR base branch in the refusal', () => {
      const fake = makeFake({ pr: { base: { ref: 'release/1.x' } }, protection: fail(404, 'Branch not protected') })
      refuses(fake, ['widget', '42'], /on release\/1\.x$/)
    })
  })

  describe('usage errors', () => {
    const cases = [
      ['no arguments', []],
      ['one argument', ['widget']],
      ['three arguments', ['widget', '42', 'extra']],
      ['PR 0', ['widget', '0']],
      ['PR abc', ['widget', 'abc']],
      ['PR #12', ['widget', '#12']],
      ['PR -1', ['widget', '-1']],
      ['PR with a leading zero', ['widget', '042']],
      ['a flag', ['widget', '--confirm']],
      ['a flag after the PR', ['widget', '42', '--repo']],
      ['a flag as the repo', ['--help', '42']],
    ]
    for (const [name, argv] of cases) {
      test(`${name}: exit 2, one usage line, no call`, () => {
        const fake = makeFake()
        const { code, text } = runStatuses(fake.run, argv)
        assert.equal(code, 2)
        assert.equal(text, 'usage: repo-guard.mjs statuses <repo> <pr>\n')
        assert.deepEqual(fake.state.calls, [])
      })
    }

    for (const bad of ['.hidden', 'a/b/c', 'bad name', 'octo/']) {
      test(`bad repo name ${JSON.stringify(bad)}: exit 2, one line, no call`, () => {
        const fake = makeFake()
        const { code, text } = runStatuses(fake.run, [bad, '42'])
        assert.equal(code, 2)
        assert.equal(text, `refusing: invalid repo name: ${bad}\n`)
        assert.deepEqual(fake.state.calls, [])
      })
    }
  })

  describe('read failures', () => {
    function failsRead(fake, pattern) {
      const { code, text } = runStatuses(fake.run, ['widget', '42'])
      assert.equal(code, 1)
      assert.equal(lines(text).length, 1, text)
      assert.match(text, /^could not read: /)
      assert.match(text, pattern)
    }

    test('the user read', () => failsRead(makeFake({ userRes: fail(401, 'Bad credentials') }), /user: Bad credentials/))
    test('the repo read', () => failsRead(makeFake({ repoRes: fail(404, 'Not Found') }), /repo: Not Found/))
    test('the PR read, including a PR that does not exist', () =>
      failsRead(makeFake({ prRes: fail(404, 'Not Found') }), /pull request: Not Found/))
    test('the protection read', () => failsRead(makeFake({ protection: fail(500, 'Server Error') }), /protection: Server Error/))

    test('a head that is not 40 lowercase hex characters', () => {
      for (const sha of ['abc123', HEAD.toUpperCase(), `${HEAD}; echo`, undefined, 42]) {
        failsRead(makeFake({ pr: { head: { sha } } }), /head/)
      }
    })

    test('a user answer with no usable login, with a short or a typed name', () => {
      for (const body of [{}, { login: '' }, { login: 7 }, { login: null }]) {
        for (const name of ['widget', 'octo/widget']) {
          const fake = makeFake({ userRes: ok(body) })
          const { code, text } = runStatuses(fake.run, [name, '42'])
          assert.equal(code, 1)
          assert.equal(lines(text).length, 1, text)
          assert.match(text, /^could not read: user: /)
          assert.deepEqual(readPaths(fake), ['api user'])
        }
      }
    })

    test('a full_name whose owner part or name part is not a valid name, and nothing of it is printed', () => {
      const bad = ['-octo/widget', '.octo/widget', 'oc to/widget', 'octo/-widget', 'octo/.widget', 'octo/wid get', 'octo/wid;get', '/widget', 'octo/']
      for (const full_name of bad) {
        const fake = makeFake({ repo: { full_name } })
        const { code, text } = runStatuses(fake.run, ['widget', '42'])
        assert.equal(code, 1, full_name)
        assert.equal(lines(text).length, 1, text)
        assert.match(text, /^could not read: repo: unexpected name /)
        assert.doesNotMatch(text, /gh api|gh pr/)
        assert.deepEqual(readPaths(fake), ['api user', 'api repos/octo/widget'])
      }
    })

    test('a full_name that is not a string or not owner/name', () => {
      for (const full_name of [42, { a: 1 }, 'octo/widget/extra', 'widget']) {
        const fake = makeFake({ repo: { full_name } })
        const { code, text } = runStatuses(fake.run, ['widget', '42'])
        assert.equal(code, 1, JSON.stringify(full_name))
        assert.equal(lines(text).length, 1, text)
        assert.match(text, /^could not read: repo: unexpected name /)
        assert.deepEqual(readPaths(fake), ['api user', 'api repos/octo/widget'])
      }
    })

    test('a PR with a missing or empty base.ref, and no protection read follows', () => {
      for (const base of [{}, { ref: '' }, { ref: null }, { ref: 7 }, undefined, null]) {
        const fake = makeFake({ pr: { base } })
        const { code, text } = runStatuses(fake.run, ['widget', '42'])
        assert.equal(code, 1)
        assert.equal(lines(text).length, 1, text)
        assert.equal(text, 'could not read: pull request: no base branch\n')
        assert.deepEqual(readPaths(fake), ['api user', 'api repos/octo/widget', 'api repos/octo/widget/pulls/42'])
      }
    })
  })

  describe('one line on every nonzero exit', () => {
    const multi = (status, message) => ({
      code: 1,
      stdout: JSON.stringify({ message, status: String(status) }),
      stderr: '',
    })
    const rawErr = (stderr) => ({ code: 1, stdout: '', stderr })

    function oneLine(fake, argv, code, head) {
      const out = runStatuses(fake.run, argv)
      assert.equal(out.code, code)
      assert.equal(out.text.endsWith('\n'), true)
      assert.doesNotMatch(out.text.slice(0, -1), /[\r\n\u2028\u2029]/, JSON.stringify(out.text))
      assert.match(out.text, head)
      return out.text
    }

    test('a gh stderr with several lines in the user read', () => {
      const text = oneLine(
        makeFake({ userRes: rawErr('To get started, please run:  gh auth login\nAlternatively, set a token.\n') }),
        ['widget', '42'],
        1,
        /^could not read: user: /
      )
      assert.match(text, /gh auth login Alternatively, set a token\.\n$/)
    })

    test('a multi-line API message in each read', () => {
      const msg = 'first part\r\nsecond part\n\nthird part'
      const cases = [
        [{ userRes: multi(500, msg) }, /user: first part second part third part/],
        [{ repoRes: multi(500, msg) }, /repo: first part second part third part/],
        [{ prRes: multi(500, msg) }, /pull request: first part second part third part/],
        [{ protection: multi(500, msg) }, /protection: first part second part third part/],
      ]
      for (const [over, pattern] of cases) assert.match(oneLine(makeFake(over), ['widget', '42'], 1, /^could not read: /), pattern)
    })

    test('a line separator character in a message', () => {
      oneLine(makeFake({ repoRes: multi(500, 'a\u2028b\u2029c') }), ['widget', '42'], 1, /^could not read: repo: a b c\n$/)
    })

    // Every C0 and C1 control, DEL, and the two Unicode separators.
    const CONTROLS = [
      ...Array.from({ length: 0x20 }, (_, i) => i),
      ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
      0x2028,
      0x2029,
    ].map((n) => String.fromCharCode(n))
    const hex = (ch) => `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    const hasControl = (text) => [...text].some((ch) => CONTROLS.includes(ch))

    test('no control or separator character survives a read failure', () => {
      for (const ch of CONTROLS) {
        const text = oneLine(
          makeFake({ userRes: rawErr(`a${ch}b ${ch}${ch} c${ch}`) }),
          ['widget', '42'],
          1,
          /^could not read: user: /
        )
        assert.equal(hasControl(text.slice(0, -1)), false, hex(ch))
        assert.match(text, /^could not read: user: a b c\n$/, hex(ch))
      }
    })

    test('no control or separator character survives a refusal with an API-derived value', () => {
      for (const ch of CONTROLS) {
        const fake = makeFake({ userRes: ok({ login: `octo${ch}x` }) })
        const text = oneLine(fake, ['some-org/widget', '42'], 2, /^refusing: /)
        assert.equal(hasControl(text.slice(0, -1)), false, hex(ch))
        assert.match(text, /\(octo x\)\n$/, hex(ch))
      }
    })

    test('a login with line breaks in the owner refusal', () => {
      const fake = makeFake({ userRes: ok({ login: 'octo\nsecond line' }) })
      oneLine(fake, ['some-org/widget', '42'], 2, /^refusing: some-org\/widget is not a repo of your own account \(octo second line\)\n$/)
    })

    test('a login with line breaks in the repo owner refusal', () => {
      const fake = makeFake({ userRes: ok({ login: 'octo\nx' }), repoRes: ok({ owner: { login: 'octo\nx', type: 'Organization' } }) })
      // The fake only serves one repo path, so serve the odd login's path.
      const run = (args, input) => (args.join(' ') === 'api repos/octo\nx/widget' ? fake.state.repoRes : fake.run(args, input))
      oneLine({ run }, ['widget', '42'], 2, /^refusing: octo x\/widget is not a repo of your own account \(octo x\)\n$/)
    })

    test('a base branch with line breaks in the protection refusal', () => {
      const ref = 'rel\nease'
      const path = `api repos/octo/widget/branches/${encodeURIComponent(ref)}/protection`
      const fake = makeFake({ pr: { base: { ref } } })
      const run = (args, input) => (args.join(' ') === path ? fail(404, 'Branch not protected') : fake.run(args, input))
      oneLine({ run }, ['widget', '42'], 2, /^refusing: octo\/widget does not require orchestrai\/review and orchestrai\/test on rel ease\n$/)
    })

    test('a typed repo name with a line break in the usage refusal', () => {
      const fake = makeFake()
      oneLine(fake, ['bad\nname', '42'], 2, /^refusing: invalid repo name: bad name\n$/)
      assert.deepEqual(fake.state.calls, [])
    })

    test('a zero exit keeps its lines', () => {
      assert.equal(lines(statuses(makeFake(), 'widget', '42').text).length, 5)
    })
  })

  describe('main', () => {
    // main writes to process.stdout and sets process.exitCode, so capture both.
    function runMain(argv) {
      const realWrite = process.stdout.write
      const realCode = process.exitCode
      let written = ''
      process.stdout.write = (chunk) => {
        written += chunk
        return true
      }
      try {
        process.exitCode = undefined
        main(argv)
        return { code: process.exitCode, written }
      } finally {
        process.stdout.write = realWrite
        process.exitCode = realCode
      }
    }

    test('statuses routes to runStatuses: a usage error prints one line on stdout and exits 2, with no gh call', () => {
      const { code, written } = runMain(['statuses', 'widget'])
      assert.equal(code, 2)
      assert.equal(written, 'usage: repo-guard.mjs statuses <repo> <pr>\n')
    })

    test('statuses routes a bad repo name to a one-line refusal with exit 2', () => {
      const { code, written } = runMain(['statuses', '.hidden', '42'])
      assert.equal(code, 2)
      assert.equal(written, 'refusing: invalid repo name: .hidden\n')
    })
  })
})

// ---------------------------------------------------------------------------
// Config dirs (Check, issue #502)
// ---------------------------------------------------------------------------
// Every test runs on a fake in-memory `local` under a made-up home. None of
// them touches the real home folder, spawns gh or calls main.
describe('config dirs', () => {
  const HOME = '/home/tester'
  const PLUGIN = 'orchestrai@orchestrai'
  const REPO = 'acme/agent-kit'
  const NEWEST = 'a'.repeat(40)
  const OLDER = '1a2b3c4' + 'd'.repeat(33)

  // Files are a path -> text map; every ancestor of a file or listed dir is a dir.
  function fakeLocal({ files = {}, dirs = [], envDir = null, listError = null, readErrors = {} } = {}) {
    const dirSet = new Set()
    const addWithParents = (p) => {
      for (let d = p; d !== '/' && !dirSet.has(d); d = dirname(d)) dirSet.add(d)
    }
    dirs.forEach(addWithParents)
    Object.keys(files).forEach((f) => addWithParents(dirname(f)))
    return {
      home: HOME,
      envDir,
      names(path) {
        if (listError !== null && path === HOME) throw new Error(listError)
        const all = [...dirSet, ...Object.keys(files)]
        return all.filter((p) => dirname(p) === path).map((p) => basename(p))
      },
      isDir: (path) => dirSet.has(path),
      read(path) {
        if (path in readErrors) throw new Error(readErrors[path])
        return files[path] ?? null
      },
    }
  }

  const dirOf = (name) => `${HOME}/${name}`
  const marker = (dir) => `${dir}/projects`
  const installedPath = (dir) => `${dir}/plugins/installed_plugins.json`
  const marketsPath = (dir) => `${dir}/plugins/known_marketplaces.json`
  const userEntry = (sha) => ({ scope: 'user', installPath: '/made/up', version: 'x', gitCommitSha: sha })
  const installedJson = (entries) => JSON.stringify({ version: 2, plugins: { [PLUGIN]: entries } })
  const marketsJson = (extra = {}, source = { source: 'github', repo: REPO }) =>
    JSON.stringify({ orchestrai: { source, ...extra } })

  // One config dir: its marker plus the two plugin files that are given.
  const configDir = (name, { installed, markets } = {}) => {
    const dir = dirOf(name)
    return {
      dirs: [marker(dir)],
      files: {
        ...(installed === undefined ? {} : { [installedPath(dir)]: installed }),
        ...(markets === undefined ? {} : { [marketsPath(dir)]: markets }),
      },
    }
  }
  const merge = (...parts) => ({
    dirs: parts.flatMap((p) => p.dirs ?? []),
    files: Object.assign({}, ...parts.map((p) => p.files ?? {})),
  })

  const ok = (stdout) => ({ code: 0, stdout: JSON.stringify(stdout), stderr: '' })
  const notFound = { code: 1, stdout: JSON.stringify({ message: 'Not Found', status: '404' }), stderr: 'gh: Not Found (HTTP 404)' }
  const runner = (calls, answer = ok({ sha: NEWEST })) => (args) => {
    calls.push(args)
    return answer
  }

  const lineOf = (text, display) => text.split('\n').find((l) => l.startsWith(`${display}:`))

  describe('findConfigDirs', () => {
    test('keeps ~/.claude and ~/.claude-<x> dirs that have a projects folder, sorted by path', () => {
      const local = fakeLocal({ dirs: [marker(dirOf('.claude-zeta')), marker(dirOf('.claude')), marker(dirOf('.claude-alpha'))] })
      const found = findConfigDirs(local)
      assert.deepEqual(found.dirs.map((d) => d.path), [dirOf('.claude'), dirOf('.claude-alpha'), dirOf('.claude-zeta')])
      assert.equal(found.error, null)
    })

    test('skips a dir with no projects folder, a .claudex dir, a .claude.json file and other dot dirs', () => {
      const local = fakeLocal({
        dirs: [marker(dirOf('.claude-alpha')), dirOf('.claude-noprojects'), marker(dirOf('.claudex')), marker(dirOf('.config'))],
        files: { [dirOf('.claude.json')]: '{}', [dirOf('.claude-file')]: 'x' },
      })
      assert.deepEqual(findConfigDirs(local).dirs.map((d) => d.path), [dirOf('.claude-alpha')])
    })

    test('counts the CLAUDE_CONFIG_DIR dir even outside home and with no projects folder', () => {
      const local = fakeLocal({ dirs: [marker(dirOf('.claude-alpha')), '/srv/elsewhere'], envDir: '/srv/elsewhere' })
      const found = findConfigDirs(local)
      assert.deepEqual(found.dirs.map((d) => [d.path, d.fromEnv]), [
        [dirOf('.claude-alpha'), false],
        ['/srv/elsewhere', true],
      ])
    })

    test('lists a dir once when CLAUDE_CONFIG_DIR names a home dir, with or without a trailing slash', () => {
      for (const envDir of [dirOf('.claude-alpha'), `${dirOf('.claude-alpha')}/`]) {
        const local = fakeLocal({ dirs: [marker(dirOf('.claude-alpha'))], envDir })
        assert.deepEqual(findConfigDirs(local).dirs.map((d) => d.path), [dirOf('.claude-alpha')])
      }
    })

    test('a failure listing home sets error, does not throw, and still returns the env dir', () => {
      const local = fakeLocal({ dirs: ['/srv/elsewhere'], envDir: '/srv/elsewhere', listError: 'EACCES: denied' })
      const found = findConfigDirs(local)
      assert.equal(found.error, 'EACCES: denied')
      assert.deepEqual(found.dirs.map((d) => d.path), ['/srv/elsewhere'])
    })
  })

  describe('collectConfigDirs and renderConfigDirs', () => {
    const report = (local, calls = [], answer) => {
      const result = collectConfigDirs(runner(calls, answer), local)
      return { result, text: renderConfigDirs(result) }
    }

    test('prints the summary and one line per dir with the three facts, in fixed order', () => {
      const parts = merge(
        configDir('.claude'),
        configDir('.claude-alpha', { installed: installedJson([userEntry(NEWEST)]), markets: marketsJson({ autoUpdate: true }) }),
        configDir('.claude-beta', { installed: installedJson([userEntry(OLDER)]), markets: marketsJson() }),
        configDir('.claude-delta', { installed: installedJson([{ scope: 'user' }]), markets: marketsJson({ autoUpdate: false }) }),
        configDir('.claude-gamma', { installed: installedJson([userEntry(NEWEST)]), markets: '{ not json' })
      )
      const { result, text } = report(fakeLocal(parts))
      const lines = text.split('\n')
      assert.equal(lines[0], 'config dirs: 5 (3 with the plugin, 1 auto update on, 1 at the newest commit, 1 could not read)')
      assert.equal(lines[1], '~/.claude: plugin not installed, auto update not recorded, no installed copy')
      assert.equal(lines[2], '~/.claude-alpha: plugin installed, auto update on, at the newest commit')
      assert.equal(
        lines[3],
        '~/.claude-beta: plugin installed, auto update not recorded, not at the newest commit (installed 1a2b3c4, newest aaaaaaa)'
      )
      assert.equal(lines[4], '~/.claude-delta: plugin installed, auto update off, commit not recorded')
      assert.match(lines[5], /^~\/\.claude-gamma: could not read: known_marketplaces\.json: /)
      assert.equal(lines.length, 7)
      assert.equal(lines[6], '')
      assert.equal(result.failed, true)
    })

    test('a tidy report is not failed', () => {
      const parts = configDir('.claude-alpha', { installed: installedJson([userEntry(NEWEST)]), markets: marketsJson({ autoUpdate: true }) })
      assert.equal(report(fakeLocal(parts)).result.failed, false)
    })

    test('with no config dir it prints a zero summary and is not failed', () => {
      const { result, text } = report(fakeLocal())
      assert.equal(text, 'config dirs: 0 (0 with the plugin, 0 auto update on, 0 at the newest commit, 0 could not read)\n')
      assert.equal(result.failed, false)
    })

    test('shows a path outside home in full', () => {
      const local = fakeLocal({ dirs: ['/srv/elsewhere'], envDir: '/srv/elsewhere' })
      assert.match(report(local).text, /^\/srv\/elsewhere: plugin not installed, auto update not recorded, no installed copy$/m)
    })

    test('when home cannot be listed it prints one line saying so and marks failed', () => {
      const { result, text } = report(fakeLocal({ listError: 'EACCES: denied' }))
      assert.equal(text, 'config dirs: could not list the home folder: EACCES: denied\n')
      assert.equal(result.failed, true)
    })

    test('when home cannot be listed the env dir is still reported after that line', () => {
      const local = fakeLocal({ dirs: ['/srv/elsewhere'], envDir: '/srv/elsewhere', listError: 'EACCES: denied' })
      const lines = report(local).text.split('\n')
      assert.equal(lines[0], 'config dirs: could not list the home folder: EACCES: denied')
      assert.match(lines[1], /^\/srv\/elsewhere: plugin not installed/)
    })

    describe('auto update', () => {
      const cases = [
        ['on when autoUpdate is true', marketsJson({ autoUpdate: true }), 'auto update on'],
        ['off when autoUpdate is false', marketsJson({ autoUpdate: false }), 'auto update off'],
        ['not recorded when the field is missing', marketsJson(), 'auto update not recorded'],
        ['not recorded when the value is not a boolean', marketsJson({ autoUpdate: 'true' }), 'auto update not recorded'],
        ['not recorded when the marketplace entry is missing', JSON.stringify({ other: { autoUpdate: true } }), 'auto update not recorded'],
        ['not recorded when the marketplaces file is missing', undefined, 'auto update not recorded'],
      ]
      for (const [name, markets, expected] of cases) {
        test(name, () => {
          const parts = configDir('.claude-alpha', { installed: installedJson([userEntry(NEWEST)]), markets })
          assert.ok(lineOf(report(fakeLocal(parts)).text, '~/.claude-alpha').includes(`, ${expected},`))
        })
      }
    })

    describe('plugin installed', () => {
      const cases = [
        ['a user entry counts as installed', installedJson([userEntry(NEWEST)]), 'plugin installed'],
        ['a user entry among project entries counts as installed', installedJson([{ scope: 'project', projectPath: '/p' }, userEntry(NEWEST)]), 'plugin installed'],
        ['a project-only entry does not count', installedJson([{ scope: 'project', projectPath: '/p', gitCommitSha: NEWEST }]), 'plugin not installed'],
        ['a missing plugin key does not count', JSON.stringify({ version: 2, plugins: { 'other@other': [userEntry(NEWEST)] } }), 'plugin not installed'],
        ['a missing installed_plugins.json does not count', undefined, 'plugin not installed'],
      ]
      for (const [name, installed, expected] of cases) {
        test(name, () => {
          const parts = configDir('.claude-alpha', { installed, markets: marketsJson() })
          assert.ok(lineOf(report(fakeLocal(parts)).text, '~/.claude-alpha').startsWith(`~/.claude-alpha: ${expected},`))
        })
      }

      test('a missing installed_plugins.json and no marketplaces file is not a failure', () => {
        const { result, text } = report(fakeLocal(configDir('.claude-alpha')))
        assert.ok(text.includes('~/.claude-alpha: plugin not installed, auto update not recorded, no installed copy'))
        assert.equal(result.failed, false)
      })
    })

    describe('installed commit', () => {
      const bad = [
        ['missing', { scope: 'user' }],
        ['not a string', { scope: 'user', gitCommitSha: 12 }],
        ['too short', { scope: 'user', gitCommitSha: 'abc123' }],
        ['upper case', { scope: 'user', gitCommitSha: 'A'.repeat(40) }],
      ]
      for (const [name, entry] of bad) {
        test(`${name}: reads "commit not recorded" and makes no call`, () => {
          const calls = []
          const parts = configDir('.claude-alpha', { installed: installedJson([entry]), markets: marketsJson() })
          const { result, text } = report(fakeLocal(parts), calls)
          assert.ok(text.includes('plugin installed, auto update not recorded, commit not recorded'))
          assert.deepEqual(calls, [])
          assert.equal(result.failed, false)
        })
      }
    })

    describe('could not read', () => {
      const next = configDir('.claude-next', { installed: installedJson([userEntry(NEWEST)]), markets: marketsJson({ autoUpdate: true }) })
      const unreadable = (installed, markets, readErrors) =>
        report(fakeLocal({ ...merge(configDir('.claude-bad', { installed, markets }), next), readErrors }))

      const shapes = [
        ['installed_plugins.json is an array', JSON.stringify([]), undefined, 'installed_plugins.json: unexpected shape'],
        ['installed_plugins.json is null', 'null', undefined, 'installed_plugins.json: unexpected shape'],
        ['plugins is not an object', JSON.stringify({ plugins: [] }), undefined, 'installed_plugins.json: unexpected shape'],
        ['the plugin value is not an array', JSON.stringify({ plugins: { [PLUGIN]: {} } }), undefined, 'installed_plugins.json: unexpected shape'],
        ['the plugin value holds a non-object', JSON.stringify({ plugins: { [PLUGIN]: ['x'] } }), undefined, 'installed_plugins.json: unexpected shape'],
        ['known_marketplaces.json is an array', undefined, JSON.stringify([]), 'known_marketplaces.json: unexpected shape'],
      ]
      for (const [name, installed, markets, message] of shapes) {
        test(`${name}`, () => {
          const { result, text } = unreadable(installed, markets)
          assert.equal(lineOf(text, '~/.claude-bad'), `~/.claude-bad: could not read: ${message}`)
          assert.ok(lineOf(text, '~/.claude-next').includes('plugin installed, auto update on'))
          assert.ok(text.startsWith('config dirs: 2 (1 with the plugin, 1 auto update on, 1 at the newest commit, 1 could not read)'))
          assert.equal(result.failed, true)
        })
      }

      test('bad JSON in installed_plugins.json names that file', () => {
        const { result, text } = unreadable('{ not json', undefined)
        assert.match(lineOf(text, '~/.claude-bad'), /^~\/\.claude-bad: could not read: installed_plugins\.json: .+/)
        assert.equal(result.failed, true)
      })

      test('bad JSON in known_marketplaces.json names that file', () => {
        const { text } = unreadable(undefined, '{ not json')
        assert.match(lineOf(text, '~/.claude-bad'), /^~\/\.claude-bad: could not read: known_marketplaces\.json: .+/)
      })

      test('a read error other than a missing file is could not read, with its message on one line', () => {
        const readErrors = { [installedPath(dirOf('.claude-bad'))]: 'EACCES: denied\nsecond line' }
        const { result, text } = unreadable('{}', undefined, readErrors)
        assert.equal(lineOf(text, '~/.claude-bad'), '~/.claude-bad: could not read: installed_plugins.json: EACCES: denied second line')
        assert.ok(lineOf(text, '~/.claude-next'))
        assert.equal(result.failed, true)
      })

      test('a CLAUDE_CONFIG_DIR that is not a directory is could not read, and the other dirs are still reported', () => {
        const { result, text } = report(fakeLocal({ ...next, envDir: '/srv/missing' }))
        assert.equal(lineOf(text, '/srv/missing'), '/srv/missing: could not read: not a directory')
        assert.ok(lineOf(text, '~/.claude-next'))
        assert.equal(result.failed, true)
      })
    })

    describe('newest commit', () => {
      const three = merge(
        ...['.claude-a', '.claude-b', '.claude-c'].map((n) =>
          configDir(n, { installed: installedJson([userEntry(OLDER)]), markets: marketsJson() })
        )
      )

      test('makes one read-only call for three dirs on the same repo', () => {
        const calls = []
        report(fakeLocal(three), calls)
        assert.deepEqual(calls, [['api', `repos/${REPO}/commits/HEAD`]])
        assert.equal(isReadOnly(calls[0]), true)
      })

      test('makes one call per repo when dirs record different repos', () => {
        const other = configDir('.claude-d', {
          installed: installedJson([userEntry(OLDER)]),
          markets: marketsJson({}, { source: 'github', repo: 'acme/other-kit' }),
        })
        const calls = []
        report(fakeLocal(merge(three, other)), calls)
        assert.deepEqual(calls.map((c) => c[1]).sort(), [`repos/${REPO}/commits/HEAD`, 'repos/acme/other-kit/commits/HEAD'])
      })

      test('makes no call when no dir has the plugin with a recorded commit', () => {
        const calls = []
        const parts = merge(configDir('.claude-a'), configDir('.claude-b', { installed: installedJson([{ scope: 'user' }]), markets: marketsJson() }))
        report(fakeLocal(parts), calls)
        assert.deepEqual(calls, [])
      })

      test('a failed read prints the unknown text, keeps the first two facts and marks failed', () => {
        const parts = configDir('.claude-a', { installed: installedJson([userEntry(OLDER)]), markets: marketsJson({ autoUpdate: true }) })
        const { result, text } = report(fakeLocal(parts), [], notFound)
        assert.equal(
          lineOf(text, '~/.claude-a'),
          '~/.claude-a: plugin installed, auto update on, newest commit unknown (could not read: Not Found)'
        )
        assert.equal(result.failed, true)
      })

      test('a runner that throws is a failed read, not a crash', () => {
        const parts = configDir('.claude-a', { installed: installedJson([userEntry(OLDER)]), markets: marketsJson() })
        const result = collectConfigDirs(() => {
          throw new Error('could not run gh: not found')
        }, fakeLocal(parts))
        assert.ok(renderConfigDirs(result).includes('newest commit unknown (could not read: could not run gh: not found)'))
        assert.equal(result.failed, true)
      })

      test('an answer with no 40-hex sha is a failed read', () => {
        const parts = configDir('.claude-a', { installed: installedJson([userEntry(OLDER)]), markets: marketsJson() })
        const { result, text } = report(fakeLocal(parts), [], ok({ sha: 'nope' }))
        assert.match(lineOf(text, '~/.claude-a'), /newest commit unknown \(could not read: .+\)$/)
        assert.equal(result.failed, true)
      })

      const sources = [
        ['a non-github source', { source: 'git', url: 'https://example.invalid/x.git' }],
        ['a repo with three parts', { source: 'github', repo: 'acme/agent-kit/extra' }],
        ['a repo with a leading dot part', { source: 'github', repo: 'acme/.hidden' }],
        ['a repo with a leading dash part', { source: 'github', repo: '-acme/agent-kit' }],
        ['a repo that is not a string', { source: 'github', repo: 7 }],
        ['a null source', null],
      ]
      for (const [name, source] of sources) {
        test(`${name} makes no call, reads "no GitHub source recorded" and is not failed`, () => {
          const calls = []
          const parts = configDir('.claude-a', { installed: installedJson([userEntry(OLDER)]), markets: marketsJson({}, source) })
          const { result, text } = report(fakeLocal(parts), calls)
          assert.ok(text.includes('plugin installed, auto update not recorded, newest commit unknown (no GitHub source recorded)'))
          assert.deepEqual(calls, [])
          assert.equal(result.failed, false)
        })
      }

      test('a missing marketplace entry reads "no GitHub source recorded" with no call', () => {
        const calls = []
        const parts = configDir('.claude-a', { installed: installedJson([userEntry(OLDER)]), markets: JSON.stringify({}) })
        const { text } = report(fakeLocal(parts), calls)
        assert.ok(text.includes('newest commit unknown (no GitHub source recorded)'))
        assert.deepEqual(calls, [])
      })
    })
  })

  // Round 1 findings from the tester (issue #502, PR #511).
  describe('hardening', () => {
    // The shared fake plus the extra behaviors the real disk has: `isDir`
    // throws for errors other than "does not exist", and `real` resolves
    // links. Both are opt-in so the earlier tests stay as they are.
    const withDisk = (base, { isDirErrors = {}, links = {}, realErrors = [] } = {}) => ({
      ...base,
      isDir(path) {
        if (path in isDirErrors) throw new Error(isDirErrors[path])
        return base.isDir(path)
      },
      real(path) {
        if (realErrors.includes(path)) throw new Error('ELOOP: cannot resolve')
        return links[path] ?? path
      },
    })
    const report = (local) => {
      const result = collectConfigDirs(runner([]), local)
      return { result, text: renderConfigDirs(result) }
    }

    // The whole class the script's one-line collapse covers: C0, DEL, C1, U+2028, U+2029.
    const controlChars = [
      ...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)),
      ...Array.from({ length: 0x21 }, (_, i) => String.fromCharCode(0x7f + i)),
      ' ',
      ' ',
    ]

    describe('finding 1: one line per dir', () => {
      test('a control character in a dir name never reaches the output, and the dir stays one line', () => {
        for (const c of controlChars) {
          const name = `.claude-x${c}y`
          const text = report(fakeLocal({ dirs: [marker(dirOf(name))] })).text
          const code = c.codePointAt(0).toString(16)
          assert.ok(!text.replaceAll('\n', '').includes(c), `U+${code} reached the output`)
          assert.deepEqual(
            text.split('\n').slice(1),
            ['~/.claude-x y: plugin not installed, auto update not recorded, no installed copy', ''],
            `U+${code} broke the dir line`
          )
        }
      })

      test('a control character in CLAUDE_CONFIG_DIR never reaches the output, and the dir stays one line', () => {
        for (const c of controlChars) {
          const envDir = `/srv/e${c}lsewhere`
          const text = report(fakeLocal({ dirs: [envDir], envDir })).text
          const code = c.codePointAt(0).toString(16)
          assert.ok(!text.replaceAll('\n', '').includes(c), `U+${code} reached the output`)
          assert.deepEqual(
            text.split('\n').slice(1),
            ['/srv/e lsewhere: plugin not installed, auto update not recorded, no installed copy', ''],
            `U+${code} broke the dir line`
          )
        }
      })

      test('a could-not-read line with a control character in the dir name is also one line', () => {
        const name = '.claude-x\nFAKE: plugin installed'
        const parts = configDir(name, { installed: '{ not json' })
        const lines = report(fakeLocal(parts)).text.split('\n')
        assert.equal(lines.length, 3)
        assert.match(lines[1], /^~\/\.claude-x FAKE: plugin installed: could not read: installed_plugins\.json: /)
      })

      test('a control character in the message of a disk error is collapsed', () => {
        const badMarker = marker(dirOf('.claude-b'))
        const local = withDisk(fakeLocal({ dirs: [badMarker] }), {
          isDirErrors: { [badMarker]: 'EACCES: denied\u001b[31m\nFAKE' },
        })
        const text = report(local).text
        assert.ok(!text.includes('\u001b'))
        assert.equal(text.split('\n').length, 3)
      })
    })

    describe('finding 2: "is not there" versus "cannot be looked at"', () => {
      const badMarker = marker(dirOf('.claude-b'))

      test('a candidate whose projects folder cannot be looked at is a could-not-read line, counted, and failed', () => {
        const tidy = { installed: installedJson([userEntry(NEWEST)]), markets: marketsJson({ autoUpdate: true }) }
        const local = withDisk(fakeLocal(merge(configDir('.claude-a', tidy), { dirs: [badMarker] })), {
          isDirErrors: { [badMarker]: 'EACCES: permission denied' },
        })
        const { result, text } = report(local)
        const lines = text.split('\n')
        assert.equal(lines[0], 'config dirs: 2 (1 with the plugin, 1 auto update on, 1 at the newest commit, 1 could not read)')
        assert.equal(lineOf(text, '~/.claude-b'), '~/.claude-b: could not read: EACCES: permission denied')
        assert.ok(lineOf(text, '~/.claude-a'))
        assert.equal(result.failed, true)
      })

      test('a candidate that itself cannot be looked at is a could-not-read line', () => {
        const dir = dirOf('.claude-b')
        const local = withDisk(fakeLocal({ dirs: [marker(dir)] }), { isDirErrors: { [dir]: 'EACCES: permission denied' } })
        const { result, text } = report(local)
        assert.equal(lineOf(text, '~/.claude-b'), '~/.claude-b: could not read: EACCES: permission denied')
        assert.equal(result.failed, true)
      })

      test('a dangling link is a could-not-read line', () => {
        const dir = dirOf('.claude-x')
        const base = fakeLocal()
        const local = withDisk(
          { ...base, names: (p) => (p === HOME ? ['.claude-x'] : []) },
          { isDirErrors: { [dir]: 'dangling link' } }
        )
        const { result, text } = report(local)
        assert.equal(lineOf(text, '~/.claude-x'), '~/.claude-x: could not read: dangling link')
        assert.ok(text.startsWith('config dirs: 1 (0 with the plugin, 0 auto update on, 0 at the newest commit, 1 could not read)'))
        assert.equal(result.failed, true)
      })

      test('a candidate with no projects folder is still skipped and not failed', () => {
        const { result, text } = report(withDisk(fakeLocal({ dirs: [dirOf('.claude-plain')] })))
        assert.equal(text, 'config dirs: 0 (0 with the plugin, 0 auto update on, 0 at the newest commit, 0 could not read)\n')
        assert.equal(result.failed, false)
      })

      test('findConfigDirs carries the error on the dir and keeps the other dirs', () => {
        const local = withDisk(fakeLocal({ dirs: [marker(dirOf('.claude-a')), badMarker] }), {
          isDirErrors: { [badMarker]: 'EACCES: permission denied' },
        })
        const found = findConfigDirs(local)
        assert.deepEqual(
          found.dirs.map((d) => [d.path, d.error]),
          [
            [dirOf('.claude-a'), undefined],
            [dirOf('.claude-b'), 'EACCES: permission denied'],
          ]
        )
        assert.equal(found.error, null)
      })
    })

    describe('finding 3: two names for one dir give one line', () => {
      const alpha = dirOf('.claude-alpha')
      const link = dirOf('.claude-link')
      const tidy = { installed: installedJson([userEntry(NEWEST)]), markets: marketsJson({ autoUpdate: true }) }
      const two = () => fakeLocal(merge(configDir('.claude-alpha', tidy), { dirs: [marker(link)] }))

      test('a link to a config dir is one dir, shown under the first name in sort order, and counted once', () => {
        const { result, text } = report(withDisk(two(), { links: { [link]: alpha, [marker(link)]: marker(alpha) } }))
        assert.equal(
          text,
          'config dirs: 1 (1 with the plugin, 1 auto update on, 1 at the newest commit, 0 could not read)\n' +
            '~/.claude-alpha: plugin installed, auto update on, at the newest commit\n'
        )
        assert.equal(result.failed, false)
      })

      test('the first name in sort order wins even when it is the link', () => {
        const first = dirOf('.claude-0link')
        const local = withDisk(fakeLocal(merge(configDir('.claude-alpha', tidy), { dirs: [marker(first)] })), { links: { [first]: alpha } })
        assert.deepEqual(findConfigDirs(local).dirs.map((d) => d.path), [first])
      })

      test('CLAUDE_CONFIG_DIR that is a link to a home dir is one dir', () => {
        const base = fakeLocal({ ...configDir('.claude-alpha', tidy), dirs: ['/srv/link', marker(alpha)], envDir: '/srv/link' })
        const local = withDisk(base, { links: { '/srv/link': alpha } })
        assert.deepEqual(findConfigDirs(local).dirs.map((d) => d.path), [alpha])
      })

      test('when the real path cannot be resolved it falls back to the resolved path and keeps both names', () => {
        const local = withDisk(two(), { links: { [link]: alpha }, realErrors: [link] })
        assert.deepEqual(findConfigDirs(local).dirs.map((d) => d.path), [alpha, link])
      })

      test('a local with no real function falls back to the resolved path', () => {
        const { real, ...rest } = withDisk(two(), { links: { [link]: alpha } })
        assert.deepEqual(findConfigDirs(rest).dirs.map((d) => d.path), [alpha, link])
      })
    })
  })
})
