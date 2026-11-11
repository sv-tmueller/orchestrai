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
  classifyProtection,
  countTestFiles,
  hasPipelineLabels,
  planChanges,
  evaluate,
  collect,
  render,
  buildWrites,
  confirmToken,
  isAllowedWrite,
  writeGuarded,
  writeArgs,
  runApply,
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
  ['api', 'user'],
  ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner&per_page=100'],
  ['api', 'repos/acme/widget'],
  ['api', 'repos/acme/widget/branches/main/protection'],
  ['api', 'repos/acme/widget/git/trees/main?recursive=1'],
  ['api', '--paginate', '--slurp', 'repos/acme/widget/labels?per_page=100'],
  ['pr', 'list', '--repo', 'acme/widget', '--state', 'all', '--limit', '10', '--json', 'number,isDraft,statusCheckRollup'],
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
    [],
  ]
  for (const args of rejected) {
    test(`rejects: gh ${args.join(' ') || '(no args)'}`, () => {
      assert.equal(isReadOnly(args), false)
    })
  }
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
    'pr list --repo octo/widget-api --state all --limit 10 --json number,isDraft,statusCheckRollup': json([
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
    'pr list --repo octo/private-notes --state all --limit 10 --json number,isDraft,statusCheckRollup': json([
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
    'pr list --repo octo/blank-repo --state all --limit 10 --json number,isDraft,statusCheckRollup': json([]),
    'api repos/octo/blank-repo/git/trees/main?recursive=1': fail(409, 'Git Repository is empty.'),
    'api --paginate --slurp repos/octo/blank-repo/labels?per_page=100': json([[]]),
  }

  const expectedPerRepo = (name) => [
    `api repos/octo/${name}`,
    `api repos/octo/${name}/branches/main/protection`,
    `pr list --repo octo/${name} --state all --limit 10 --json number,isDraft,statusCheckRollup`,
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
    const widgetWith = (prs) => {
      const key = 'pr list --repo octo/widget-api --state all --limit 10 --json number,isDraft,statusCheckRollup'
      const table = { ...responses, [key]: json(prs) }
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
    for (const [name, facts] of Object.entries(FIXTURES)) {
      assert.equal(buildWrites(TARGET, facts).length === 0, planChanges(facts).changes.length === 0, name)
    }
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
})

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

// ---------------------------------------------------------------------------
// runApply: plan mode and confirm mode against a stateful fake
// ---------------------------------------------------------------------------
describe('runApply', () => {
  const done = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })
  const pr = (number, rollup, isDraft = false) => ({ number, isDraft, statusCheckRollup: rollup })
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
      protection: over.protection ?? null,
      protectionError: over.protectionError ?? null,
      prs: over.prs ?? [pr(12, [done('Unit tests')])],
      tree: over.tree ?? ['src/a.js', 'src/a.test.js'],
      failPut: over.failPut ?? null,
      failPatch: over.failPatch ?? null,
      calls: [],
      writes: [],
    }
    const repoPath = 'repos/octo/widget'
    const protPath = `${repoPath}/branches/main/protection`

    function run(args, input) {
      state.calls.push({ args, input })
      const key = args.join(' ')
      if (key === 'api user') return ok({ login: state.login })
      if (/^api repos\/[^/]+\/[^/]+$/i.test(key)) {
        if (key.toLowerCase() === `api ${repoPath}`) return ok(state.repo)
        return fail(404, 'Not Found')
      }
      if (key === `api ${protPath}`) {
        if (state.protectionError) return state.protectionError
        return state.protection ? ok(state.protection) : fail(404, 'Branch not protected')
      }
      if (key === `pr list --repo ${repoPath.slice(6)} --state all --limit 10 --json number,isDraft,statusCheckRollup`) {
        return ok(state.prs)
      }
      if (key === `api ${repoPath}/git/trees/main?recursive=1`) {
        return ok({ tree: state.tree.map((path) => ({ path, type: 'blob' })) })
      }
      if (key === `api --paginate --slurp ${repoPath}/labels?per_page=100`) return ok([[{ name: 'bug' }]])
      if (key === `api -X PUT ${protPath} --input -`) {
        state.writes.push({ method: 'PUT', body: JSON.parse(input) })
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
        state.writes.push({ method: 'PATCH', body: JSON.parse(input) })
        if (state.failPatch) return state.failPatch
        Object.assign(state.repo, JSON.parse(input))
        return ok(state.repo)
      }
      throw new Error(`unexpected gh call: ${key}`)
    }
    return { run, state }
  }

  const tokenOf = (text) => text.match(/^confirm token: ([0-9a-f]{12})$/m)?.[1]
  const apply = (fake, ...argv) => runApply(fake.run, argv)

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
    refused('a name starting with a dash', makeFake, ['--web'], /usage|unknown|repo/i)
    refused('a name starting with a dot', makeFake, ['.hidden'], /repo name/i)
    refused('an owner/name part starting with a dash', makeFake, ['octo/--web'], /repo name/i)
    refused('a name with a space', makeFake, ['wid get'], /repo name/i)
    refused('a name with a slash too many', makeFake, ['octo/widget/extra'], /repo name/i)
    refused('an owner that is not the user', makeFake, ['some-org/x'], /not your own|owner/i)
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
    refused('a repo that needs CI first', () => makeFake({ prs: [] }), ['widget'], /needs CI first: it has test files but no finished, non-draft PR has run a check/)

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
        ['api user']
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
})
