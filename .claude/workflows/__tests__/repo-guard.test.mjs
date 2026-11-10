/**
 * Tests for tm-repo-guard's read-only check (issue #472, batch #470).
 *
 * `repo-guard.mjs` ships with the plugin at
 * `.claude/skills/tm-repo-guard/repo-guard.mjs`. It reads the GitHub state of
 * every repo the user owns and prints one state per repo: set up, not set up,
 * or blocked. These tests cover the pure rule functions, the read-only guard
 * on every gh call, and a full collect() run over a made-up fixture with a
 * fake runner. Nothing here touches GitHub; repo and owner names are invented.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

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
} from '../../skills/tm-repo-guard/repo-guard.mjs'

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------
describe('isReadOnly', () => {
  const accepted = [
    ['api', 'user'],
    ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner&per_page=100'],
    ['api', 'repos/acme/widget'],
    ['api', 'repos/acme/widget/branches/main/protection'],
    ['api', 'repos/acme/widget/git/trees/main?recursive=1'],
    ['api', '--paginate', '--slurp', 'repos/acme/widget/labels?per_page=100'],
    ['pr', 'list', '--repo', 'acme/widget', '--state', 'all', '--limit', '10', '--json', 'number,isDraft,statusCheckRollup'],
  ]
  for (const args of accepted) {
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
      strict: true,
      deletionsOff: true,
      noApprovalNeeded: true,
      carry: CARRY_OFF,
    })
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
  ciChecks: ['Unit tests'],
  testFileCount: 5,
  pipelineLabels: false,
  ...over,
})
const NO_CI = { ciChecks: [], prCheckNames: [], protection: { ...PROTECTED, requiredChecks: [] } }

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
      protection: { ...PROTECTED, requiredChecks: ['Unit tests', 'Version bump guard'] },
    })
    const got = planChanges(facts)
    assert.deepEqual(got.changes, ['stop requiring: Version bump guard'])
    assert.deepEqual(got.requiredChecks, ['Unit tests'])
    assert.deepEqual(got.notRequired, ['Version bump guard'])
  })

  test('a name seen only on older PRs that is not required is no change, but is named', () => {
    const got = planChanges(baseFacts({ prCheckNames: ['Unit tests', 'Zeta', 'Alpha'] }))
    assert.deepEqual(got.changes, [])
    assert.deepEqual(got.notRequired, ['Alpha', 'Zeta'])
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
    assert.deepEqual(evaluate(baseFacts({ prCheckNames: ['Unit tests', 'Old'] })).notRequired, ['Old'])
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
