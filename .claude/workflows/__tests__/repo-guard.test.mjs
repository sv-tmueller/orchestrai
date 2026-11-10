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
  classifyProtection,
  countTestFiles,
  hasPipelineLabels,
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
    ['pr', 'list', '--repo', 'acme/widget', '--state', 'all', '--limit', '10', '--json', 'statusCheckRollup'],
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
// classifyProtection
// ---------------------------------------------------------------------------
describe('classifyProtection', () => {
  test('exit 0 is present, with the union of both required-check shapes', () => {
    const body = {
      required_status_checks: {
        contexts: ['Unit tests', 'lint'],
        checks: [{ context: 'lint' }, { context: 'Version bump guard' }],
      },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      allow_force_pushes: { enabled: false },
    }
    assert.deepEqual(classifyProtection({ code: 0, stdout: JSON.stringify(body) }), {
      kind: 'present',
      requiredChecks: ['Unit tests', 'Version bump guard', 'lint'],
      prRequired: true,
      forcePushesOff: true,
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
// evaluate
// ---------------------------------------------------------------------------
describe('evaluate', () => {
  const PROTECTED = {
    kind: 'present',
    requiredChecks: ['Unit tests'],
    prRequired: true,
    forcePushesOff: true,
  }
  const base = (over = {}) => ({
    visibility: 'public',
    allowAutoMerge: true,
    protection: PROTECTED,
    prCheckNames: ['Unit tests'],
    testFileCount: 5,
    pipelineLabels: false,
    ...over,
  })

  test('fully set up', () => {
    const got = evaluate(base())
    assert.equal(got.state, 'set up')
    assert.deepEqual(got.missing, [])
    assert.deepEqual(got.flags, [])
    assert.deepEqual(got.layers, ['base', 'ci'])
  })

  test('no protection: not set up, with the base items missing', () => {
    const got = evaluate(base({ protection: { kind: 'none' }, prCheckNames: [] }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing.slice(0, 3), ['branch protection', 'PR required', 'force pushes off'])
  })

  test('PR not required', () => {
    const got = evaluate(base({ protection: { ...PROTECTED, prRequired: false } }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing, ['PR required'])
  })

  test('force pushes allowed', () => {
    const got = evaluate(base({ protection: { ...PROTECTED, forcePushesOff: false } }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing, ['force pushes off'])
  })

  test('auto merge off', () => {
    const got = evaluate(base({ allowAutoMerge: false }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing, ['auto merge on'])
  })

  test('a PR check that is not a required check', () => {
    const got = evaluate(base({ prCheckNames: ['Unit tests', 'Version bump guard'] }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing, ['required check: Version bump guard'])
  })

  test('test files but no PR checks: not set up, needs CI first', () => {
    const got = evaluate(base({ prCheckNames: [], protection: { ...PROTECTED, requiredChecks: [] } }))
    assert.equal(got.state, 'not set up')
    assert.deepEqual(got.missing, ['needs CI first'])
    assert.deepEqual(got.layers, ['base'])
  })

  test('no tests and no PR checks prints the agent-verdicts flag', () => {
    const got = evaluate(base({ prCheckNames: [], testFileCount: 0, protection: { ...PROTECTED, requiredChecks: [] } }))
    assert.equal(got.state, 'set up')
    assert.deepEqual(got.flags, ['agent verdicts only, short track off'])
  })

  test('no tests but PR checks present prints the second flag and keeps the CI layer', () => {
    const got = evaluate(base({ testFileCount: 0 }))
    assert.deepEqual(got.flags, ['no tests, short track off'])
    assert.deepEqual(got.layers, ['base', 'ci'])
    assert.equal(got.state, 'set up')
  })

  test('a truncated tree with zero matches so far prints no no-tests flag', () => {
    const got = evaluate(base({ testFileCount: 0, testFilesTruncated: true }))
    assert.deepEqual(got.flags, [])
  })

  test('protection not available on the plan is blocked, even when other things are missing', () => {
    const got = evaluate(
      base({
        visibility: 'private',
        protection: { kind: 'unavailable', message: 'Upgrade to GitHub Pro' },
        allowAutoMerge: false,
        prCheckNames: [],
      })
    )
    assert.equal(got.state, 'blocked')
    assert.match(got.reason, /not available on the current plan/)
    assert.deepEqual(got.missing, ['auto merge on', 'needs CI first'])
  })

  test('the verdicts layer applies only when the pipeline labels exist', () => {
    const off = evaluate(base({ pipelineLabels: false }))
    assert.equal(off.layers.includes('verdicts'), false)
    assert.equal(off.state, 'set up')

    const on = evaluate(base({ pipelineLabels: true }))
    assert.deepEqual(on.layers, ['base', 'ci', 'verdicts'])
    assert.equal(on.state, 'not set up')
    assert.deepEqual(on.missing, ['required check: orchestrai/review', 'required check: orchestrai/test'])
  })

  test('verdicts layer is met when both verdict contexts are required', () => {
    const protection = { ...PROTECTED, requiredChecks: ['Unit tests', 'orchestrai/review', 'orchestrai/test'] }
    assert.equal(evaluate(base({ pipelineLabels: true, protection })).state, 'set up')
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

  const check = (name) => ({ __typename: 'CheckRun', name, conclusion: 'SUCCESS' })

  // Keyed by the joined args, so any call outside this set fails loudly.
  const responses = {
    'api user': json({ login: 'octo' }),
    'api --paginate --slurp user/repos?affiliation=owner&per_page=100': json([
      [repo('octo', 'widget-api'), repo('octo', 'private-notes')],
      [repo('octo', 'blank-repo'), repo('octo', 'old-stuff', { archived: true }), repo('some-org', 'shared')],
    ]),

    // A tidy public repo, fully set up.
    'api repos/octo/widget-api': json({ private: false, allow_auto_merge: true, default_branch: 'main' }),
    'api repos/octo/widget-api/branches/main/protection': json({
      required_status_checks: { contexts: ['Unit tests'] },
      required_pull_request_reviews: {},
      allow_force_pushes: { enabled: false },
    }),
    'pr list --repo octo/widget-api --state all --limit 10 --json statusCheckRollup': json([
      { statusCheckRollup: [check('Unit tests')] },
    ]),
    'api repos/octo/widget-api/git/trees/main?recursive=1': tree(['src/a.js', 'src/a.test.js']),
    'api --paginate --slurp repos/octo/widget-api/labels?per_page=100': json([[{ name: 'bug' }]]),

    // A private repo on a plan with no protection. It has a workflow file but
    // its PRs show no checks, so the CI layer must not apply.
    'api repos/octo/private-notes': json({ private: true, allow_auto_merge: false, default_branch: 'main' }),
    'api repos/octo/private-notes/branches/main/protection': fail(
      403,
      'Upgrade to GitHub Pro or make this repository public to enable this feature.'
    ),
    'pr list --repo octo/private-notes --state all --limit 10 --json statusCheckRollup': json([
      { statusCheckRollup: [] },
    ]),
    'api repos/octo/private-notes/git/trees/main?recursive=1': tree(['.github/workflows/ci.yml', 'notes.md']),
    'api --paginate --slurp repos/octo/private-notes/labels?per_page=100': json([
      [{ name: 'in-progress' }],
      [{ name: 'needs-human' }],
    ]),

    // An empty repo: no branch yet, and the tree endpoint answers 409.
    'api repos/octo/blank-repo': json({ private: false, allow_auto_merge: false, default_branch: 'main' }),
    'api repos/octo/blank-repo/branches/main/protection': fail(404, 'Branch not found'),
    'pr list --repo octo/blank-repo --state all --limit 10 --json statusCheckRollup': json([]),
    'api repos/octo/blank-repo/git/trees/main?recursive=1': fail(409, 'Git Repository is empty.'),
    'api --paginate --slurp repos/octo/blank-repo/labels?per_page=100': json([[]]),
  }

  const expectedPerRepo = (name) => [
    `api repos/octo/${name}`,
    `api repos/octo/${name}/branches/main/protection`,
    `pr list --repo octo/${name} --state all --limit 10 --json statusCheckRollup`,
    `api repos/octo/${name}/git/trees/main?recursive=1`,
    `api --paginate --slurp repos/octo/${name}/labels?per_page=100`,
  ]

  function recordingRunner(table = responses) {
    const calls = []
    const run = (args) => {
      calls.push(args)
      const key = args.join(' ')
      if (!(key in table)) throw new Error(`unexpected gh call: ${key}`)
      return table[key]
    }
    return { run, calls }
  }

  test('every call passes the read-only guard and the call set is exactly the expected one', () => {
    const { run, calls } = recordingRunner()
    collect(run)
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
    facts: { visibility: 'public', prCount: 3, prCheckNames: ['Unit tests'], testFileCount: 4, ...facts },
    result,
  })

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

  test('uses no em dashes', () => {
    const text = render({
      login: 'o',
      entries: [entry('o/a', { state: 'set up', missing: [], flags: [], layers: ['base'] })],
    })
    assert.equal(text.includes('—'), false)
  })
})
