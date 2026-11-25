/**
 * Hermes pipeline driver test (issue #334).
 *
 * Exercises the flat-star pipeline in dry-run mode: architect -> developer
 * -> tester -> reviewer -> ship. Verifies the stage sequencing, fix-round
 * routing, parking on exhaustion, and wave concurrency.
 *
 * No live API calls or GitHub writes; DRY_RUN=true is set before import.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

process.env.DRY_RUN = 'true'

describe('hermes pipeline driver', () => {
  let runPipeline, runWave

  before(async () => {
    const mod = await import('../../adapters/hermes-pipeline.mjs')
    runPipeline = mod.runPipeline
    runWave = mod.runWave
  })

  test('happy path: pipeline completes with APPROVE + PASS', async () => {
    const result = await runPipeline(42, { dryRun: true })

    assert.ok(result, 'pipeline returned no result')
    assert.equal(result.issue, 42)
    assert.equal(result.done, true, 'pipeline should be done on happy path')
    assert.equal(result.parked, null, 'should not be parked on happy path')
    assert.ok(result.branch, 'branch should be set')
    assert.ok(result.pr, 'PR should be set')
    assert.equal(result.testerVerdict, 'PASS')
    assert.equal(result.reviewerVerdict, 'APPROVE')
    assert.equal(result.fixRounds.tester, 0)
    assert.equal(result.fixRounds.reviewer, 0)
  })

  test('sub-plan is populated after architect stage', async () => {
    const result = await runPipeline(99, { dryRun: true })
    assert.ok(result.subPlan, 'sub-plan should be populated')
  })

  test('multiple issues run via runWave', async () => {
    const results = await runWave([1, 2, 3], { dryRun: true })
    assert.equal(results.length, 3)
    for (const r of results) {
      assert.ok(r.done, `issue ${r.issue} should be done`)
    }
  })

  test('wave respects concurrency limit', async () => {
    // 5 issues with max 3 concurrent: should still complete all 5
    const results = await runWave([1, 2, 3, 4, 5], { dryRun: true })
    assert.equal(results.length, 5)
    assert.ok(results.every((r) => r.done))
  })

  test('pipeline state has all expected fields', async () => {
    const result = await runPipeline(7, { dryRun: true })
    assert.ok('issue' in result)
    assert.ok('branch' in result)
    assert.ok('pr' in result)
    assert.ok('subPlan' in result)
    assert.ok('testerVerdict' in result)
    assert.ok('reviewerVerdict' in result)
    assert.ok('fixRounds' in result)
    assert.ok('parked' in result)
    assert.ok('done' in result)
  })
})

// ---------------------------------------------------------------------------
// Command line and gate rules (issue #355).
//
// Nothing below calls the real gh or git, and nothing spawns a real seat.
// Every GitHub and git call goes through the injected runner, backed by the
// saved fixtures in fixtures/hermes-pipeline/. Seats go through an injected
// spawn that lands in the same ordered call log.
// ---------------------------------------------------------------------------

const driver = await import('../../adapters/hermes-pipeline.mjs')
const { parseReport } = await import('../../adapters/role-contract-parser.mjs')

describe('parseArgs', () => {
  const { parseArgs } = driver

  test('an issue number becomes an issue item', () => {
    assert.deepEqual(parseArgs(['355']), { items: [{ issue: 355 }] })
  })

  test('label: selects a label and strips only the first prefix', () => {
    assert.deepEqual(parseArgs(['label:size:M']), { items: [{ label: 'size:M' }] })
    assert.deepEqual(parseArgs(['label:in-progress']), { items: [{ label: 'in-progress' }] })
  })

  test('numbers and labels mix in argument order, duplicates dropped', () => {
    const r = parseArgs(['9', 'label:a', '3', '9', 'label:a', 'label:b'])
    assert.deepEqual(r, { items: [{ issue: 9 }, { label: 'a' }, { issue: 3 }, { label: 'b' }] })
  })

  test('no arguments is a usage error', () => {
    assert.ok(parseArgs([]).error)
  })

  test('an empty label: is a usage error', () => {
    assert.ok(parseArgs(['355', 'label:']).error)
  })

  test('any other argument is a usage error', () => {
    for (const bad of ['abc', '#355', '12x', '--issues', '--issues=1,2', '1,2', '']) {
      assert.ok(parseArgs([bad]).error, `expected a usage error for ${JSON.stringify(bad)}`)
    }
  })
})

describe('parseBlockers', () => {
  const { parseBlockers } = driver

  test('reads whole Blocked by lines only', () => {
    const body = [
      'Part of batch #603',
      '',
      'Blocked by: #355',
      'Blocked by: #12   ',
      'Blocked by: #77\r',
      '- Blocked by: #9',
      '`Blocked by: #8`',
      'See Blocked by: #7 for more',
      'blocked by: #6',
      'Blocked by: #5, #4',
    ].join('\n')
    assert.deepEqual(parseBlockers(body), [355, 12, 77])
  })

  test('no blockers, empty and missing bodies', () => {
    assert.deepEqual(parseBlockers('nothing here'), [])
    assert.deepEqual(parseBlockers(''), [])
    assert.deepEqual(parseBlockers(undefined), [])
  })

  test('a repeated blocker is listed once', () => {
    assert.deepEqual(parseBlockers('Blocked by: #3\nBlocked by: #3'), [3])
  })
})

describe('resumeStage', () => {
  const { resumeStage, countFixRounds } = driver
  const c = (body, createdAt) => ({ author: { login: 'bot' }, body, createdAt })

  test('no verdict comment re-enters at the tester', () => {
    assert.deepEqual(resumeStage([]), { stage: 'tester' })
    assert.deepEqual(resumeStage([c('just a note', '2026-01-01T00:00:00Z')]), { stage: 'tester' })
  })

  test('PASS re-enters at the reviewer', () => {
    const r = resumeStage([c('**Tester report**\n\nVERDICT: PASS\nFINDINGS: none', '2026-01-01T00:00:00Z')])
    assert.deepEqual(r, { stage: 'reviewer' })
  })

  test('FAIL re-enters at the developer with the comment body verbatim', () => {
    const body = '**Tester report**\n\nVERDICT: FAIL\nFINDINGS: 1. parseArgs drops ids'
    assert.deepEqual(resumeStage([c(body, '2026-01-01T00:00:00Z')]), { stage: 'developer', findings: body })
  })

  test('CHANGES_REQUESTED re-enters at the developer with the comment body verbatim', () => {
    const body = 'VERDICT: CHANGES_REQUESTED\nFINDINGS: must fix the exit code'
    assert.deepEqual(resumeStage([c(body, '2026-01-01T00:00:00Z')]), { stage: 'developer', findings: body })
  })

  test('APPROVE re-enters at ship', () => {
    assert.deepEqual(resumeStage([c('VERDICT: APPROVE\nSTAGE: both clean', '2026-01-01T00:00:00Z')]), { stage: 'ship' })
  })

  test('the latest verdict comment wins, whatever the array order', () => {
    const comments = [
      c('VERDICT: APPROVE', '2026-01-03T00:00:00Z'),
      c('VERDICT: FAIL\nFINDINGS: old', '2026-01-01T00:00:00Z'),
      c('VERDICT: PASS', '2026-01-02T00:00:00Z'),
    ]
    assert.deepEqual(resumeStage(comments), { stage: 'ship' })
  })

  test('a later comment without a verdict does not hide an earlier verdict', () => {
    const comments = [c('VERDICT: PASS', '2026-01-01T00:00:00Z'), c('thanks, looks good', '2026-01-02T00:00:00Z')]
    assert.deepEqual(resumeStage(comments), { stage: 'reviewer' })
  })

  test('only the first verdict line of a comment counts', () => {
    assert.deepEqual(resumeStage([c('VERDICT: PASS\nVERDICT: FAIL', '2026-01-01T00:00:00Z')]), { stage: 'reviewer' })
  })

  test('a quoted verdict line is ignored', () => {
    const comments = [c('VERDICT: PASS', '2026-01-01T00:00:00Z'), c('> VERDICT: FAIL\nI disagree.', '2026-01-02T00:00:00Z')]
    assert.deepEqual(resumeStage(comments), { stage: 'reviewer' })
  })

  test('a fact-checker verdict is ignored', () => {
    const comments = [c('VERDICT: PASS', '2026-01-01T00:00:00Z'), c('VERDICT: CONTRADICTED\nCLAIMS: 1', '2026-01-02T00:00:00Z')]
    assert.deepEqual(resumeStage(comments), { stage: 'reviewer' })
  })

  test('a verdict word only in a bold header is ignored', () => {
    const header = '**Tester report, round 1 (VERDICT: PASS)**\n\nsee below'
    assert.deepEqual(resumeStage([c(header, '2026-01-01T00:00:00Z')]), { stage: 'tester' })
  })

  test('a longer word that starts with a verdict is ignored', () => {
    assert.deepEqual(resumeStage([c('VERDICT: PASSED', '2026-01-01T00:00:00Z')]), { stage: 'tester' })
  })

  test('a CRLF verdict line still counts', () => {
    assert.deepEqual(resumeStage([c('intro\r\nVERDICT: PASS\r\n', '2026-01-01T00:00:00Z')]), { stage: 'reviewer' })
  })

  // Only a line feed starts a line. None of these starts a line for the reader.
  for (const [name, ch] of [['U+2028', ' '], ['U+2029', ' '], ['a lone CR', '\r'], ['a vertical tab', '\v'], ['a form feed', '\f'], ['U+0085', '\u0085']]) {
    test(`${name} before a verdict word does not start a verdict line`, () => {
      assert.deepEqual(resumeStage([c(`note${ch}VERDICT: FAIL`, '2026-01-01T00:00:00Z')]), { stage: 'tester' })
      assert.deepEqual(resumeStage([c(`note${ch}VERDICT: APPROVE`, '2026-01-01T00:00:00Z')]), { stage: 'tester' })
    })
  }

  // The parser accepts these, so the reader has to as well.
  for (const [name, line] of [['no space', 'VERDICT:FAIL'], ['two spaces', 'VERDICT:  FAIL'], ['a tab', 'VERDICT:\tFAIL']]) {
    test(`a verdict line with ${name} after the colon counts`, () => {
      assert.deepEqual(resumeStage([c(line, '2026-01-01T00:00:00Z')]), { stage: 'developer', findings: line })
    })
  }

  describe('countFixRounds', () => {
    const none = { tester: 0, reviewer: 0 }

    test('no comments and comments without a verdict count nothing', () => {
      assert.deepEqual(countFixRounds([]), none)
      assert.deepEqual(countFixRounds([c('a note', '2026-01-01T00:00:00Z')]), none)
    })

    test('each FAIL is a tester round and each CHANGES_REQUESTED a reviewer round', () => {
      const comments = [
        c('VERDICT: FAIL\nFINDINGS: 1. a', '2026-01-01T00:00:00Z'),
        c('VERDICT: PASS', '2026-01-02T00:00:00Z'),
        c('VERDICT: CHANGES_REQUESTED\nFINDINGS: 1. b', '2026-01-03T00:00:00Z'),
        c('VERDICT: FAIL\nFINDINGS: 1. c', '2026-01-04T00:00:00Z'),
        c('VERDICT: FAIL\nFINDINGS: 1. d', '2026-01-05T00:00:00Z'),
        c('VERDICT: APPROVE', '2026-01-06T00:00:00Z'),
      ]
      assert.deepEqual(countFixRounds(comments), { tester: 3, reviewer: 1 })
    })

    test('the order of the array and the author do not matter', () => {
      const a = { author: { login: 'one' }, body: 'VERDICT: FAIL', createdAt: '2026-01-02T00:00:00Z' }
      const b = { author: { login: 'two' }, body: 'VERDICT: FAIL', createdAt: '2026-01-01T00:00:00Z' }
      assert.deepEqual(countFixRounds([a, b]), { tester: 2, reviewer: 0 })
      assert.deepEqual(countFixRounds([b, a]), { tester: 2, reviewer: 0 })
    })

    test('a quoted verdict, a fact-checker verdict and a verdict word in a header are ignored', () => {
      const comments = [
        c('> VERDICT: FAIL\nI disagree.', '2026-01-01T00:00:00Z'),
        c('VERDICT: CONTRADICTED\nCLAIMS: 1', '2026-01-02T00:00:00Z'),
        c('**Tester report, round 1 (VERDICT: FAIL)**\n\nsee below', '2026-01-03T00:00:00Z'),
        c('VERDICT: FAILED', '2026-01-04T00:00:00Z'),
      ]
      assert.deepEqual(countFixRounds(comments), none)
    })

    test('only the first verdict line of a comment counts', () => {
      assert.deepEqual(countFixRounds([c('VERDICT: FAIL\nVERDICT: CHANGES_REQUESTED', '2026-01-01T00:00:00Z')]), { tester: 1, reviewer: 0 })
    })

    test('a CRLF verdict line and the spacing the parser accepts count', () => {
      const comments = [
        c('intro\r\nVERDICT: FAIL\r\n', '2026-01-01T00:00:00Z'),
        c('VERDICT:CHANGES_REQUESTED', '2026-01-02T00:00:00Z'),
        c('VERDICT:  FAIL', '2026-01-03T00:00:00Z'),
      ]
      assert.deepEqual(countFixRounds(comments), { tester: 2, reviewer: 1 })
    })

    for (const [name, ch] of [['U+2028', ' '], ['U+2029', ' '], ['a lone CR', '\r'], ['a vertical tab', '\v'], ['a form feed', '\f'], ['U+0085', '\u0085']]) {
      test(`${name} before a verdict word does not start a verdict line`, () => {
        const comments = [c(`note${ch}VERDICT: FAIL`, '2026-01-01T00:00:00Z'), c(`note${ch}VERDICT: CHANGES_REQUESTED`, '2026-01-02T00:00:00Z')]
        assert.deepEqual(countFixRounds(comments), none)
      })
    }

    test('a verdict line after one of those characters and a line feed still counts', () => {
      assert.deepEqual(countFixRounds([c('a b\nVERDICT: FAIL', '2026-01-01T00:00:00Z')]), { tester: 1, reviewer: 0 })
    })

    test('a comment that does not parse as one string is skipped', () => {
      assert.deepEqual(countFixRounds([{ createdAt: '2026-01-01T00:00:00Z' }, { body: null }]), none)
    })
  })
})

describe('planWaves', () => {
  const { planWaves } = driver
  const e = (issue, outcome, blockers = []) => ({ issue, outcome, blockers })

  test('run and resume packages are wave 1, with no waiting', () => {
    const r = planWaves([e(1, 'run'), e(2, 'resume'), e(3, 'complete'), e(4, 'skip')])
    assert.deepEqual(r, { waves: [[1, 2]], waiting: [] })
  })

  test('a chain of blockers gives one wave per link', () => {
    const r = planWaves([e(1, 'run'), e(2, 'wait', [1]), e(3, 'wait', [2])])
    assert.deepEqual(r.waves, [[1], [2], [3]])
    assert.deepEqual(r.waiting, [])
  })

  test('a package waits for every blocker to land in an earlier wave', () => {
    const r = planWaves([e(1, 'run'), e(2, 'run'), e(3, 'wait', [1, 2]), e(4, 'wait', [3, 1])])
    assert.deepEqual(r.waves, [[1, 2], [3], [4]])
  })

  test('a blocker outside the run leaves the package waiting', () => {
    const r = planWaves([e(1, 'run'), e(2, 'wait', [99])])
    assert.deepEqual(r.waves, [[1]])
    assert.deepEqual(r.waiting, [{ issue: 2, blockers: [99] }])
  })

  test('a blocker that is not runnable leaves the package waiting', () => {
    const r = planWaves([e(1, 'park'), e(2, 'stop'), e(3, 'wait', [1]), e(4, 'wait', [2])])
    assert.deepEqual(r.waves, [])
    assert.deepEqual(r.waiting.map((w) => w.issue), [3, 4])
  })

  test('a cycle never lands in a wave', () => {
    const r = planWaves([e(1, 'run'), e(2, 'wait', [3]), e(3, 'wait', [2])])
    assert.deepEqual(r.waves, [[1]])
    assert.deepEqual(r.waiting.map((w) => w.issue), [2, 3])
  })
})

// --- fixtures and the fake runner -----------------------------------------

const FIXTURE_DIR = new URL('./fixtures/hermes-pipeline/', import.meta.url)
const loadFixture = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8'))

// Every write command the driver runs has a prefix here. A new one is added here.
const WRITE_PREFIXES = [
  'gh label create',
  'gh issue comment',
  'gh issue edit',
  'gh pr ready',
  'gh pr comment',
  'git fetch',
  'git worktree add',
]

const DEFAULT_REPORTS = {
  architect: parseReport('architect', 'SUB_PLAN\n\nApproach: do the thing.'),
  developer: { STATUS: 'DONE', PR: 'https://github.com/o/r/pull/900' },
  tester: { VERDICT: 'PASS' },
  reviewer: { VERDICT: 'APPROVE' },
}

/**
 * A fixture-backed runner plus a fake spawn, sharing one ordered call log.
 * A key in `reads` returns exit 0 with that stdout, a key in `failures`
 * returns exit 1 with that stderr, a known write prefix is recorded and
 * returns exit 0, and anything else throws. One default answer: the closing
 * references read of ship (`gh pr view <pr> --json closingIssuesReferences,number`)
 * with no fixture entry says the PR has the number in its URL or the bare
 * number given, and closes issues 5 to 9. An entry in the fixture wins, and a
 * test of the check itself uses one that does not close.
 */
const CLOSES_READ = /^gh pr view (\S+) --json closingIssuesReferences,number$/
function fakeRunner(fixture, reports = {}) {
  const calls = []
  const scripted = { ...DEFAULT_REPORTS, ...reports }
  const run = async (cmd, args, opts = {}) => {
    const key = [cmd, ...args].join(' ')
    const closes = CLOSES_READ.exec(key)
    if (closes && !(key in (fixture.reads || {})) && !(key in (fixture.failures || {}))) {
      const digits = /\/pull\/(\d+)$/.exec(closes[1])?.[1] ?? /^\d+$/.exec(closes[1])?.[0]
      if (digits !== undefined) {
        calls.push({ kind: 'read', key, cwd: opts.cwd })
        const refs = [5, 6, 7, 8, 9].map((number) => ({ number }))
        return { code: 0, stdout: JSON.stringify({ closingIssuesReferences: refs, number: Number(digits) }), stderr: '' }
      }
    }
    if (key in (fixture.failures || {})) {
      calls.push({ kind: 'read', key, cwd: opts.cwd })
      return { code: 1, stdout: '', stderr: fixture.failures[key] }
    }
    if (key in (fixture.reads || {})) {
      calls.push({ kind: 'read', key, cwd: opts.cwd })
      const v = fixture.reads[key]
      return { code: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' }
    }
    if (WRITE_PREFIXES.some((p) => key.startsWith(p))) {
      calls.push({ kind: 'write', key, cwd: opts.cwd })
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`no fixture for: ${key}`)
  }
  const spawn = async (role, task, opts = {}) => {
    calls.push({ kind: 'spawn', role, task, cwd: opts.cwd })
    const r = scripted[role]
    return Array.isArray(r) ? r.shift() : r
  }
  return { run, spawn, calls }
}

const keysOf = (calls, kind) => calls.filter((c) => c.kind === kind).map((c) => c.key)

// What a stop writes for issue 7: the reason on the issue, needs-human on, and
// in-progress off when this run or the gate had put it on. details is the seat
// text, quoted line by line under the reason.
// The writer ends a line at any of the seven line ends (CRLF is one). The
// readers (resumeStage, countFixRounds, the sub-plan reader) end it at LF only.
const LINE_ENDS = [
  ['a line feed', '\n'], ['a carriage return', '\r'], ['a vertical tab', '\v'], ['a form feed', '\f'],
  ['U+0085', '\u0085'], ['U+2028', '\u2028'], ['U+2029', '\u2029'],
]
const LINE_END = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/
// Everything of the seven except LF, which a multi-line comment does hold.
const NON_LF_END = /[\r\v\f\u0085\u2028\u2029]/
const quoted = (text) => text.split(LINE_END).map((l) => `> ${l}`).join('\n')
const parkWrites = (reason, { inProgress = false, details } = {}) => [
  `gh issue comment 7 --body Parked: ${reason}${details === undefined ? '' : `\n\n${quoted(details)}`}`,
  'gh issue edit 7 --add-label needs-human',
  ...(inProgress ? ['gh issue edit 7 --remove-label in-progress'] : []),
]

describe('the fake runner', () => {
  test('fails loudly on a command with no fixture', async () => {
    const { run } = fakeRunner({ reads: {} })
    await assert.rejects(run('gh', ['issue', 'view', '1']), /no fixture for: gh issue view 1/)
  })

  test('returns a string read unchanged and any other value stringified', async () => {
    const { run } = fakeRunner({ reads: { 'git a': 'raw text\n', 'gh b': [{ n: 1 }] } })
    assert.equal((await run('git', ['a'])).stdout, 'raw text\n')
    assert.equal((await run('gh', ['b'])).stdout, '[{"n":1}]')
  })
})

describe('createGitHub reads', () => {
  const { createGitHub } = driver
  const make = (fixture, extra = {}) => {
    const fake = fakeRunner(fixture)
    const logs = []
    const gh = createGitHub({ run: fake.run, dryRun: false, log: (m) => logs.push(m), cwd: '/repo', ...extra })
    return { gh, logs, ...fake }
  }
  const fixture = loadFixture('github-reads')

  test('issueView runs the exact command and parses the JSON', async () => {
    const { gh, calls } = make(fixture)
    const issue = await gh.issueView(355)
    assert.equal(issue.number, 355)
    assert.deepEqual(issue.labels.map((l) => l.name), ['size:M', 'in-progress'])
    assert.equal(
      calls[0].key,
      'gh issue view 355 --json body,comments,labels,number,state,stateReason,title'
    )
    assert.equal(calls[0].cwd, '/repo')
  })

  test('issueList asks for open issues with a limit and returns the numbers ascending', async () => {
    const { gh, calls } = make(fixture)
    assert.deepEqual(await gh.issueList('size:M'), [355, 450, 604])
    assert.equal(calls[0].key, 'gh issue list --state open --label size:M --limit 100 --json number')
  })

  test('prComments returns the comment list of one PR', async () => {
    const { gh, calls } = make(fixture)
    const comments = await gh.prComments(602)
    assert.equal(comments[0].body, 'VERDICT: PASS')
    assert.equal(calls[0].key, 'gh pr view 602 --json comments')
  })

  test('prList and remoteHeads are each read once however often they are asked', async () => {
    const { gh, calls } = make(fixture)
    await gh.prList()
    const prs = await gh.prList()
    await gh.remoteHeads()
    const heads = await gh.remoteHeads()
    assert.equal(prs[0].number, 602)
    assert.deepEqual(heads, ['refs/heads/main', 'refs/heads/feat/355-hermes-driver'])
    assert.deepEqual(keysOf(calls, 'read'), [
      'gh pr list --state open --limit 100 --json closingIssuesReferences,headRefName,isDraft,number,url',
      'git ls-remote --heads origin',
    ])
  })

  test('a failed read throws and names the command and the first stderr line', async () => {
    const { gh } = make(fixture)
    await assert.rejects(gh.issueView(404), (e) => {
      assert.match(e.message, /^gh issue view 404 --json body,comments,labels,number,state,stateReason,title: /)
      assert.match(e.message, /Could not resolve to an Issue/)
      assert.ok(!e.message.includes('second line'), 'only the first stderr line belongs in the message')
      return true
    })
  })

  test('output that is not JSON throws naming the command', async () => {
    const { gh } = make({ reads: { 'gh pr view 5 --json comments': 'not json' } })
    await assert.rejects(gh.prComments(5), /gh pr view 5 --json comments: .*JSON/i)
  })
})

describe('createGitHub writes', () => {
  const { createGitHub, LABELS } = driver
  const make = (dryRun) => {
    const fake = fakeRunner({ reads: {} })
    const logs = []
    const gh = createGitHub({ run: fake.run, dryRun, log: (m) => logs.push(m), cwd: '/repo' })
    return { gh, logs, ...fake }
  }

  test('live writes run the exact gh commands', async () => {
    const { gh, calls } = make(false)
    await gh.createLabel({ name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour.' })
    await gh.comment(7, 'hello')
    await gh.addLabel(7, 'in-progress')
    await gh.removeLabel(7, 'in-progress')
    await gh.prReady(12)
    assert.deepEqual(keysOf(calls, 'write'), [
      'gh label create size:S --color c2e0c6 --description Under 1 hour. --force',
      'gh issue comment 7 --body hello',
      'gh issue edit 7 --add-label in-progress',
      'gh issue edit 7 --remove-label in-progress',
      'gh pr ready 12',
    ])
  })

  test('dry-run writes never reach the runner, and each logs one line naming the command', async () => {
    const { gh, calls, logs } = make(true)
    await gh.createLabel(LABELS[0])
    await gh.comment(7, 'x'.repeat(500))
    await gh.addLabel(7, 'needs-human')
    await gh.removeLabel(7, 'in-progress')
    await gh.prReady(12)
    await gh.park(7, 'no size label', { inProgress: true })
    assert.deepEqual(calls, [])
    assert.ok(logs.length >= 5)
    assert.ok(logs.every((l) => !l.includes('\n')), 'one line per skipped write')
    assert.match(logs[0], /gh label create size:S/)
    assert.match(logs[1], /gh issue comment 7/)
    assert.ok(logs[1].length < 200, 'a long body is cut in the log line')
    assert.match(logs[2], /gh issue edit 7 --add-label needs-human/)
    assert.match(logs[3], /gh issue edit 7 --remove-label in-progress/)
    assert.match(logs[4], /gh pr ready 12/)
  })

  test('park comments "Parked: <reason>" and adds needs-human, in that order', async () => {
    const { gh, calls } = make(false)
    await gh.park(7, 'no size label')
    assert.deepEqual(keysOf(calls, 'write'), [
      'gh issue comment 7 --body Parked: no size label',
      'gh issue edit 7 --add-label needs-human',
    ])
  })

  test('park removes in-progress only when the issue has it', async () => {
    const without = make(false)
    await without.gh.park(7, 'r')
    assert.ok(!keysOf(without.calls, 'write').some((k) => k.includes('--remove-label')))
    const withIt = make(false)
    await withIt.gh.park(7, 'r', { inProgress: true })
    assert.ok(keysOf(withIt.calls, 'write').includes('gh issue edit 7 --remove-label in-progress'))
  })

  test('prComment runs gh pr comment with a PR number or a PR URL', async () => {
    const { gh, calls } = make(false)
    await gh.prComment(12, '**Tester report: FAIL**\n\nVERDICT: FAIL')
    await gh.prComment('https://github.com/o/r/pull/9', 'x')
    assert.deepEqual(keysOf(calls, 'write'), [
      'gh pr comment 12 --body **Tester report: FAIL**\n\nVERDICT: FAIL',
      'gh pr comment https://github.com/o/r/pull/9 --body x',
    ])
  })

  test('a dry-run prComment is logged on one line and never reaches the runner', async () => {
    const { gh, calls, logs } = make(true)
    await gh.prComment(12, 'x'.repeat(500))
    assert.deepEqual(calls, [])
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^dry run, skipped: gh pr comment 12 --body /)
    assert.ok(logs[0].length < 200)
  })

  test('park with details quotes every line of them under the reason, so no seat line is read as a verdict', async () => {
    const { gh, calls } = make(false)
    await gh.park(7, 'architect NEEDS_DECISION: which cache?', { details: 'NEEDS_DECISION: which cache?\r\n\r\nVERDICT: FAIL' })
    assert.deepEqual(keysOf(calls, 'write'), [
      'gh issue comment 7 --body Parked: architect NEEDS_DECISION: which cache?\n\n> NEEDS_DECISION: which cache?\n> \n> VERDICT: FAIL',
      'gh issue edit 7 --add-label needs-human',
    ])
  })

  test('park with no details or empty details writes the reason alone', async () => {
    for (const details of [undefined, '']) {
      const { gh, calls } = make(false)
      await gh.park(7, 'r', { details })
      assert.equal(keysOf(calls, 'write')[0], 'gh issue comment 7 --body Parked: r')
    }
  })

  test('park with details still removes in-progress last when the issue has it', async () => {
    const { gh, calls } = make(false)
    await gh.park(7, 'r', { inProgress: true, details: 'd' })
    assert.deepEqual(keysOf(calls, 'write'), [
      'gh issue comment 7 --body Parked: r\n\n> d',
      'gh issue edit 7 --add-label needs-human',
      'gh issue edit 7 --remove-label in-progress',
    ])
  })

  test('a write that exits nonzero throws naming the command', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: 'HTTP 403: forbidden\nmore' })
    const gh = createGitHub({ run, dryRun: false, log: () => {}, cwd: '/repo' })
    await assert.rejects(gh.comment(7, 'x'), (e) => {
      assert.equal(e.message, 'gh issue comment 7 --body x: HTTP 403: forbidden')
      return true
    })
  })
})

describe('LABELS', () => {
  test('holds the six canonical labels with their colors and descriptions', () => {
    assert.deepEqual(driver.LABELS, [
      { name: 'size:S', color: 'c2e0c6', description: 'Under 1 hour. One focused change.' },
      { name: 'size:M', color: 'BFD4F2', description: '1 to 3 hours. Write a sub-plan first.' },
      { name: 'size:L', color: 'F9D0C4', description: '4 to 6 hours. Split or checkpoint.' },
      { name: 'size:XL', color: 'D93F0B', description: 'About 8 hours. Too big. Split it.' },
      { name: 'in-progress', color: 'FBCA04', description: 'Package dispatched; resume, do not restart.' },
      { name: 'needs-human', color: 'B60205', description: 'Agent loop exhausted or blocked; human decision needed.' },
    ])
  })

  test('the comment above it does not claim the skill list is gone while the skill still holds it', () => {
    const source = readFileSync(new URL('../../adapters/hermes-pipeline.mjs', import.meta.url), 'utf8')
    const skill = readFileSync(new URL('../../skills/tm-kickoff/SKILL.hermes.md', import.meta.url), 'utf8')
    assert.ok(skill.includes('label create'), 'the premise: the skill still carries the list')
    assert.ok(!source.includes('so this is the only copy'))
    assert.ok(source.includes(
      '// The canonical label set. SKILL.hermes.md carries the same list in its Gate\n' +
      '// block today. #605 removes it there, and this becomes the only copy.\n'
    ))
  })
})

describe('defaultRun', () => {
  test('returns code, stdout and stderr and never rejects on a nonzero exit', async () => {
    const ok = await driver.defaultRun(process.execPath, ['-e', 'console.log("out")'], {})
    assert.deepEqual({ code: ok.code, stdout: ok.stdout.trim() }, { code: 0, stdout: 'out' })
    const bad = await driver.defaultRun(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], {})
    assert.equal(bad.code, 3)
    assert.match(bad.stderr, /boom/)
  })

  test('a missing command comes back as a nonzero code with a message', async () => {
    const r = await driver.defaultRun('definitely-not-a-command-355', [], {})
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /ENOENT|not found/)
  })
})

describe('the gate', () => {
  const { runGate, createGitHub, formatGateLine, planWaves } = driver
  const fixture = loadFixture('gate-rules')

  async function gate(numbers) {
    const fake = fakeRunner(fixture)
    const gh = createGitHub({ run: fake.run, dryRun: false, log: () => {}, cwd: '/repo' })
    const entries = await runGate(numbers, gh)
    return { entries, calls: fake.calls }
  }
  const one = async (n) => (await gate([n])).entries[0]

  test('rule 1: a closed issue is skipped', async () => {
    const e = await one(101)
    assert.equal(e.outcome, 'skip')
    assert.match(e.detail, /closed/)
  })

  test('rule 2: a needs-human issue is skipped', async () => {
    const e = await one(102)
    assert.equal(e.outcome, 'skip')
    assert.match(e.detail, /needs-human/)
  })

  test('rule 3: size:L and size:XL stop with a split-it note', async () => {
    for (const [n, size] of [[103, 'size:L'], [104, 'size:XL']]) {
      const e = await one(n)
      assert.equal(e.outcome, 'stop')
      assert.equal(e.size, size)
      assert.match(e.detail, /split it first/)
    }
  })

  test('rule 4: an issue with no size label is parked, never given a guessed size', async () => {
    for (const n of [105, 106]) {
      const e = await one(n)
      assert.equal(e.outcome, 'park')
      assert.equal(e.size, 'unsized')
      assert.match(e.detail, /size/)
    }
  })

  test('rule 4: an unsized issue remembers whether it carries in-progress', async () => {
    assert.equal((await one(105)).inProgress, false)
  })

  test('rule 5: a ready PR means complete, even with in-progress, and writes nothing', async () => {
    const { entries, calls } = await gate([107])
    assert.equal(entries[0].outcome, 'complete')
    assert.match(entries[0].detail, /PR #205 is ready, awaiting merge/)
    assert.equal(keysOf(calls, 'write').length, 0)
  })

  test('rule 5: a ready PR beats a sub-plan comment', async () => {
    assert.equal((await one(108)).outcome, 'complete')
  })

  test('rule 5: with several ready PRs the highest number is used', async () => {
    const e = await one(109)
    assert.equal(e.outcome, 'complete')
    assert.match(e.detail, /PR #211/)
  })

  test('rule 5: a complete entry carries the number of its PR, and no other entry does', async () => {
    assert.equal((await one(107)).pr, 205)
    assert.equal((await one(109)).pr, 211)
    for (const n of [101, 110, 116, 117]) assert.equal('pr' in (await one(n)), false, `#${n}`)
  })

  test('rule 6: a draft PR with no verdict resumes at the tester on its branch', async () => {
    const e = await one(110)
    assert.equal(e.outcome, 'resume')
    assert.deepEqual(e.resume, { stage: 'tester', branch: 'feat/110-x', pr: 210, fixRounds: { tester: 0, reviewer: 0 } })
  })

  test('rule 6: a PASS verdict resumes at the reviewer', async () => {
    assert.deepEqual((await one(111)).resume, {
      stage: 'reviewer', branch: 'feat/111-x', pr: 212, fixRounds: { tester: 0, reviewer: 0 },
    })
  })

  test('rule 6: a FAIL verdict resumes at the developer with the findings', async () => {
    const e = await one(112)
    assert.equal(e.resume.stage, 'developer')
    assert.equal(e.resume.branch, 'fix/112-x')
    assert.equal(e.resume.pr, 213)
    assert.match(e.resume.findings, /VERDICT: FAIL\nFINDINGS: 1\. exit code is 0 on a failed read/)
  })

  test('rule 6: the fix rounds already used are counted from the verdict comments of the PR', async () => {
    // PR 213 holds a PASS and, later, one FAIL.
    assert.deepEqual((await one(112)).resume.fixRounds, { tester: 1, reviewer: 0 })
  })

  test('the entry carries the issue title, for the branch name', async () => {
    assert.equal((await one(116)).title, 'Issue 116 title')
  })

  test('rule 6: an APPROVE verdict on a draft resumes at ship', async () => {
    assert.deepEqual((await one(113)).resume, {
      stage: 'ship', branch: 'feat/113-x', pr: 214, fixRounds: { tester: 0, reviewer: 0 },
    })
  })

  test('rule 6: with several draft PRs the highest number is used', async () => {
    const e = await one(120)
    assert.equal(e.resume.pr, 222)
    assert.equal(e.resume.branch, 'feat/120-new')
  })

  test('rule 7: in-progress with no PR and a branch on origin resumes at the developer', async () => {
    // The origin also holds feat/1140-other, which must not match issue 114.
    const e = await one(114)
    assert.equal(e.outcome, 'resume')
    assert.deepEqual(e.resume, { stage: 'developer', branch: 'feat/114-tester-branch' })
    assert.match(e.detail, /no PR, resuming at the developer$/)
  })

  test('rule 7: in-progress with no PR and no branch runs from the developer', async () => {
    const e = await one(115)
    assert.equal(e.outcome, 'run')
    assert.deepEqual(e.resume, { stage: 'developer' })
    assert.match(e.detail, /developer/)
  })

  test('rule 8: no sub-plan comment runs from the architect', async () => {
    const e = await one(116)
    assert.equal(e.outcome, 'run')
    assert.equal(e.resume, undefined)
    assert.match(e.detail, /architect/)
  })

  test('rule 8: a sub-plan comment runs from the developer', async () => {
    const e = await one(117)
    assert.equal(e.outcome, 'run')
    assert.deepEqual(e.resume, { stage: 'developer' })
    assert.match(e.detail, /sub-plan/)
  })

  test('rule 8: SUB_PLAN has to be a line of its own, not a prefix, a quote or code', async () => {
    const e = await one(118)
    assert.equal(e.outcome, 'run')
    assert.equal(e.resume, undefined)
  })

  test('rule 8: the SUB_PLAN line is found on a later CRLF line of a comment', async () => {
    assert.deepEqual((await one(119)).resume, { stage: 'developer' })
  })

  test('rule 8: only a line feed starts a SUB_PLAN line, so no other line end makes a sub-plan comment', async () => {
    for (const ch of [' ', ' ', '\r', '\v', '\f', '\u0085']) {
      const key = 'gh issue view 118 --json body,comments,labels,number,state,stateReason,title'
      const copy = JSON.parse(JSON.stringify(fixture))
      copy.reads[key].comments[0].body = `intro${ch}SUB_PLAN${ch}more`
      const fake = fakeRunner(copy)
      const gh = createGitHub({ run: fake.run, dryRun: false, log: () => {}, cwd: '/repo' })
      const [e] = await runGate([118], gh)
      assert.equal(e.resume, undefined, `U+${ch.codePointAt(0).toString(16)} must not start a line`)
    }
  })

  test('a blocker closed as completed does not block', async () => {
    const e = await one(121)
    assert.equal(e.outcome, 'run')
    assert.deepEqual(e.blockers, [])
  })

  test('a blocker closed as not planned still blocks', async () => {
    const e = await one(122)
    assert.equal(e.outcome, 'wait')
    assert.deepEqual(e.blockers, [131])
    assert.match(e.detail, /blocked by #131/)
  })

  test('an open blocker outside the run blocks', async () => {
    const e = await one(123)
    assert.equal(e.outcome, 'wait')
    assert.deepEqual(e.blockers, [132])
  })

  test('a blocker with a ready PR still blocks until it is merged', async () => {
    assert.deepEqual((await one(126)).blockers, [108])
  })

  test('size:L stops before blockers are looked at', async () => {
    const { entries, calls } = await gate([127])
    assert.equal(entries[0].outcome, 'stop')
    assert.ok(!keysOf(calls, 'read').some((k) => k.includes('issue view 132')))
  })

  test('only unmerged blockers are listed, and a chain makes waves', async () => {
    const { entries } = await gate([116, 121, 122, 123, 124, 125])
    assert.deepEqual(entries.map((e) => [e.issue, e.outcome]), [
      [116, 'run'], [121, 'run'], [122, 'wait'], [123, 'wait'], [124, 'wait'], [125, 'wait'],
    ])
    assert.deepEqual(entries[5].blockers, [124])
    const plan = planWaves(entries)
    assert.deepEqual(plan.waves, [[116, 121], [124], [125]])
    assert.deepEqual(plan.waiting.map((w) => w.issue), [122, 123])
  })

  test('entries come back in argument order', async () => {
    const { entries } = await gate([117, 101, 116])
    assert.deepEqual(entries.map((e) => e.issue), [117, 101, 116])
  })

  test('gh pr list and git ls-remote are each read once, and each issue view at most once', async () => {
    const { calls } = await gate([107, 110, 114, 115, 116, 124, 125, 126, 108])
    const reads = keysOf(calls, 'read')
    assert.equal(reads.filter((k) => k.startsWith('gh pr list')).length, 1)
    assert.equal(reads.filter((k) => k.startsWith('git ls-remote')).length, 1)
    assert.equal(new Set(reads).size, reads.length, 'no read is repeated')
  })

  test('PR and branch reads happen only when a rule needs them', async () => {
    const stopped = await gate([101, 102, 103, 104, 105])
    assert.deepEqual(keysOf(stopped.calls, 'read').filter((k) => !k.startsWith('gh issue view')), [])
    const noBranchNeeded = await gate([116])
    assert.ok(!keysOf(noBranchNeeded.calls, 'read').some((k) => k.startsWith('git ls-remote')))
  })

  test('the gate line has the fixed shape', async () => {
    const e = await one(116)
    assert.match(formatGateLine(e), /^#116 size:M run: .+/)
    assert.match(formatGateLine(await one(105)), /^#105 unsized park: .+/)
  })

  test('a failed gh read rejects and names the command', async () => {
    const fake = fakeRunner(loadFixture('github-reads'))
    const gh = createGitHub({ run: fake.run, dryRun: false, log: () => {}, cwd: '/repo' })
    await assert.rejects(runGate([404], gh), /^Error: gh issue view 404 /)
  })
})

// The wave-end report (issue #610): a pure function of the gate entries and the
// results of wave 1. Every free text in it is one line (oneLine), and the next
// steps hold numbers only, so no title or reason can start a heading or a list item.
describe('formatReport', () => {
  const { formatReport } = driver
  const entry = (issue, outcome, detail, extra = {}) =>
    ({ issue, size: 'size:M', outcome, detail, blockers: [], inProgress: false, title: `Title ${issue}`, ...extra })
  const done = (issue, prNumber) => ({ issue, done: true, parked: null, prNumber })
  const parked = (issue, reason) => ({ issue, done: false, parked: reason })
  const errored = (issue, error) => ({ issue, done: false, parked: null, error })

  test('every kind of line, in gate order, with the next steps they give', () => {
    const entries = [
      entry(201, 'run', 'no sub-plan comment, starting at the architect'),
      entry(202, 'resume', 'draft PR #12, resuming at the tester'),
      entry(203, 'complete', 'PR #910 is ready, awaiting merge', { pr: 910 }),
      entry(204, 'park', 'no size label, not guessing a size'),
      entry(205, 'stop', 'size:L, split it first'),
      entry(206, 'skip', 'closed'),
      entry(207, 'wait', 'blocked by #201'),
      entry(208, 'run', 'sub-plan comment found, starting at the developer'),
      entry(209, 'resume', 'draft PR #13, resuming at the reviewer'),
    ]
    const results = [done(201, 900), parked(202, 'architect NEEDS_DECISION: which cache?'), errored(208, 'fatal: boom'), done(209, 13)]
    assert.deepEqual(formatReport(entries, results), [
      '## What happened',
      '- PR #900 ready  - Title 201',
      '- #202 parked (needs-human): architect NEEDS_DECISION: which cache?',
      '- PR #910 ready  - Title 203',
      '- #204 parked (needs-human): no size label, not guessing a size',
      '- #205 stopped: size:L, split it first',
      '- #206 skipped: closed',
      '- #207 deferred: blocked by #201',
      '- #208 error: fatal: boom',
      '- PR #13 ready  - Title 209',
      '',
      '## Next steps',
      '1. Review & merge: #900, #910, #13',
      '2. Decide on #202, #204, #208 (retry or close)',
      '3. Run the driver again to start the next wave',
    ])
  })

  const steps = (entries, results = []) => formatReport(entries, results).slice(formatReport(entries, results).indexOf('## Next steps') + 1)

  test('the next steps list only the items that have members, numbered from 1', () => {
    assert.deepEqual(steps([entry(1, 'complete', 'd', { pr: 5 })]), ['1. Review & merge: #5'])
    assert.deepEqual(steps([entry(1, 'park', 'd')]), ['1. Decide on #1 (retry or close)'])
    assert.deepEqual(steps([entry(1, 'run', 'd')], [errored(1, 'e')]), ['1. Decide on #1 (retry or close)'])
    assert.deepEqual(steps([entry(1, 'wait', 'd')]), ['1. Run the driver again to start the next wave'])
    assert.deepEqual(steps([entry(1, 'complete', 'd', { pr: 5 }), entry(2, 'wait', 'd')]), [
      '1. Review & merge: #5', '2. Run the driver again to start the next wave',
    ])
    assert.deepEqual(steps([entry(1, 'park', 'd'), entry(2, 'wait', 'd')]), [
      '1. Decide on #1 (retry or close)', '2. Run the driver again to start the next wave',
    ])
  })

  test('a stopped or skipped package is no next step: with nothing else the section is Nothing to do', () => {
    assert.deepEqual(steps([entry(1, 'stop', 'd'), entry(2, 'skip', 'd')]), ['1. Nothing to do'])
  })

  test('the shape is fixed: the heading first with no blank line before it, one empty line before the next steps', () => {
    const lines = formatReport([entry(1, 'skip', 'closed')], [])
    assert.deepEqual(lines, ['## What happened', '- #1 skipped: closed', '', '## Next steps', '1. Nothing to do'])
  })

  test('a package that is parked in a run and one that is parked at the gate read the same', () => {
    const lines = formatReport([entry(1, 'run', 'd'), entry(2, 'park', 'why')], [parked(1, 'why')])
    assert.deepEqual(lines.slice(1, 3), ['- #1 parked (needs-human): why', '- #2 parked (needs-human): why'])
  })

  test('a done package with an error is an error, whatever else its entry holds', () => {
    const lines = formatReport([entry(1, 'run', 'd')], [{ issue: 1, done: true, parked: null, prNumber: 9, error: 'e' }])
    assert.equal(lines[1], '- #1 error: e')
  })

  test('the inputs are not changed', () => {
    const entries = [entry(1, 'run', 'd', { title: 'a\nb' })]
    const results = [done(1, 3)]
    const copy = JSON.stringify([entries, results])
    formatReport(entries, results)
    assert.equal(JSON.stringify([entries, results]), copy)
  })

  // Free text in every field a line holds, with each of the seven line ends and
  // Markdown that would start a heading or a list item. The clean run is the
  // reference: the hostile one has the same number of lines and the same next steps.
  describe('free text is one line', () => {
    const entriesWith = (t) => [
      entry(1, 'run', 'd', { title: t }),
      entry(2, 'run', 'd', { title: t }),
      entry(3, 'run', 'd', { title: t }),
      entry(4, 'complete', t, { pr: 910, title: t }),
      entry(5, 'park', t, { title: t }),
      entry(6, 'stop', t, { title: t }),
      entry(7, 'skip', t, { title: t }),
      entry(8, 'wait', t, { title: t }),
    ]
    const resultsWith = (t) => [done(1, 900), parked(2, t), errored(3, t)]
    const clean = formatReport(entriesWith('x'), resultsWith('x'))
    const nextSteps = (lines) => lines.slice(lines.indexOf('## Next steps'))

    const texts = [
      ...LINE_ENDS.flatMap(([, ch]) => [
        `x${ch}## Next steps${ch}1. Review & merge: #999`,
        `${ch}x`,
        `x${ch}`,
        `x${ch}#9 error: boom`,
      ]),
      '## Next steps', '1. Review & merge: #999', '# Heading', '- item', '> quote', '```', '~~~\nx', '\n\n  \nx', 'x\r\ny', '2. Decide on #999 (retry or close)',
    ]
    for (const t of texts) {
      test(`${JSON.stringify(t)} in a title, a reason, an error and a gate detail gives one line each`, () => {
        const lines = formatReport(entriesWith(t), resultsWith(t))
        assert.ok(lines.every((l) => !LINE_END.test(l)), 'no line holds a line end')
        assert.equal(lines.length, clean.length)
        assert.deepEqual(nextSteps(lines), nextSteps(clean))
        assert.equal(lines.filter((l) => l.startsWith('#')).length, 2, 'only the two headings start with #')
        assert.deepEqual(lines.slice(1, 1 + 8).filter((l) => !l.startsWith('- ')), [])
        assert.equal(lines.filter((l) => /^\d+\. /.test(l)).length, clean.filter((l) => /^\d+\. /.test(l)).length)
      })
    }

    test('a title, a reason, an error or a detail that is not text gives an empty one and never throws', () => {
      for (const v of [{ toString: 1 }, ['x'], true, false, null, undefined]) {
        const lines = formatReport(entriesWith(v), resultsWith(v))
        assert.equal(lines.length, clean.length)
        assert.ok(lines.every((l) => !LINE_END.test(l)))
        assert.deepEqual(nextSteps(lines), nextSteps(clean))
      }
    })
  })
})

describe('main', () => {
  const { main, LABELS, USAGE } = driver

  // Runs main against a fixture. env is explicit, so the test process's own
  // DRY_RUN=true does not leak in.
  async function runMain(argv, fixtureName, { dryRun = false, reports, wrap } = {}) {
    const fake = fakeRunner(loadFixture(fixtureName), reports)
    const stdout = []
    const stderr = []
    const code = await main(argv, {
      env: dryRun ? { DRY_RUN: 'true' } : {},
      run: wrap ? wrap(fake.run) : fake.run,
      spawn: fake.spawn,
      out: (l) => stdout.push(l),
      err: (l) => stderr.push(l),
      cwd: '/repo',
    })
    return { code, stdout, stderr, calls: fake.calls }
  }

  describe('usage errors', () => {
    for (const argv of [[], ['label:'], ['abc'], ['--issues', '1,2']]) {
      test(`${JSON.stringify(argv)} exits 2 with the usage line and makes no call`, async () => {
        const r = await runMain(argv, 'main-live')
        assert.equal(r.code, 2)
        assert.ok(r.stderr.some((l) => l.includes(USAGE)))
        assert.deepEqual(r.stdout, [])
        assert.deepEqual(r.calls, [])
      })
    }
  })

  describe('with DRY_RUN=true', () => {
    const argv = ['label:size:M', '204', '202', '201']

    test('exits 0, makes no write call and spawns no seat', async () => {
      const r = await runMain(argv, 'main-live', { dryRun: true })
      assert.equal(r.code, 0)
      assert.deepEqual(keysOf(r.calls, 'write'), [])
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn'), [])
    })

    test('stdout is the gate in package order and then the wave plan, nothing else', async () => {
      const r = await runMain(argv, 'main-live', { dryRun: true })
      assert.equal(r.stdout.length, 6)
      assert.match(r.stdout[0], /^#201 size:M run: /)
      assert.match(r.stdout[1], /^#203 size:M wait: blocked by #201$/)
      assert.match(r.stdout[2], /^#204 size:S run: /)
      assert.match(r.stdout[3], /^#202 unsized park: /)
      assert.deepEqual(r.stdout.slice(4), ['wave 1: #201 #204', 'wave 2: #203'])
    })

    test('every skipped write is named on stderr, the labels and the park among them', async () => {
      const r = await runMain(argv, 'main-live', { dryRun: true })
      for (const l of LABELS) {
        assert.ok(r.stderr.some((s) => s.includes(`gh label create ${l.name} `)), `label ${l.name}`)
      }
      assert.ok(r.stderr.some((s) => s.includes('gh issue comment 202 --body Parked: ')))
      assert.ok(r.stderr.some((s) => s.includes('gh issue edit 202 --add-label needs-human')))
    })

    test('a label expands to the open issues carrying it, and a repeated number is one package', async () => {
      const r = await runMain(['label:size:M', '201'], 'main-live', { dryRun: true })
      assert.ok(keysOf(r.calls, 'read').includes('gh issue list --state open --label size:M --limit 100 --json number'))
      assert.deepEqual(r.stdout.filter((l) => l.startsWith('#')).map((l) => l.split(' ')[0]), ['#201', '#203'])
    })

    test('waiting issues get a waiting line', async () => {
      const r = await runMain(['203'], 'main-live', { dryRun: true })
      assert.deepEqual(r.stdout.slice(1), ['waiting: #203 (blocked by #201)'])
    })

    test('a label with no open issues prints nothing and exits 0', async () => {
      const r = await runMain(['label:nothing'], 'main-live', { dryRun: true })
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout, [])
    })
  })

  describe('live', () => {
    const argv = ['label:size:M', '204', '202']
    const index = (calls, pred) => calls.findIndex(pred)

    test('the six label creates come first, before any other write and any seat', async () => {
      const r = await runMain(argv, 'main-live')
      assert.equal(r.code, 0)
      assert.deepEqual(r.calls.slice(0, 6).map((c) => c.key), LABELS.map(
        (l) => `gh label create ${l.name} --color ${l.color} --description ${l.description} --force`
      ))
      assert.ok(index(r.calls, (c) => c.kind === 'spawn') > 5)
    })

    test('an unsized issue gets the park writes and does not run', async () => {
      const r = await runMain(['202'], 'main-live')
      const writes = keysOf(r.calls, 'write').slice(6)
      assert.deepEqual(writes, [
        'gh issue comment 202 --body Parked: no size label, not guessing a size',
        'gh issue edit 202 --add-label needs-human',
      ])
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn'), [])
      assert.match(r.stdout[0], /^#202 unsized park: /)
    })

    test('a parked issue that carries in-progress has it removed', async () => {
      const r = await runMain(['206'], 'main-park-in-progress')
      assert.ok(keysOf(r.calls, 'write').includes('gh issue edit 206 --remove-label in-progress'))
    })

    test('in-progress is added before the developer is spawned', async () => {
      const r = await runMain(['204'], 'main-live')
      const added = index(r.calls, (c) => c.key === 'gh issue edit 204 --add-label in-progress')
      const developer = index(r.calls, (c) => c.kind === 'spawn' && c.role === 'developer')
      assert.ok(added > 5, 'the label is added')
      assert.ok(added < developer, 'before the developer dispatch')
    })

    test('the architect runs only when there is no sub-plan comment, and the developer after it', async () => {
      const r = await runMain(['201', '204'], 'main-live')
      const roles = (cwd) => r.calls.filter((c) => c.kind === 'spawn' && c.cwd === cwd).map((c) => c.role)
      assert.deepEqual(roles('/repo/.worktrees/pkg-201'), ['architect', 'developer', 'tester', 'reviewer'])
      assert.deepEqual(roles('/repo/.worktrees/pkg-204'), ['developer', 'tester', 'reviewer'])
    })

    test('only wave 1 runs: a wave 2 issue is never spawned and gets no worktree', async () => {
      const r = await runMain(['label:size:M'], 'main-live')
      assert.equal(r.code, 0)
      assert.ok(r.calls.some((c) => c.kind === 'spawn' && c.cwd === '/repo/.worktrees/pkg-201'))
      assert.ok(!r.calls.some((c) => c.kind === 'spawn' && c.cwd.includes('pkg-203')))
      assert.ok(!r.calls.some((c) => c.key && c.key.includes('pkg-203')))
      assert.ok(r.stdout.includes('wave 2: #203'))
    })

    test('stdout is the gate, the wave plan and one result line per package; progress is on stderr', async () => {
      const r = await runMain(['201', '204'], 'main-live')
      assert.match(r.stdout[0], /^#201 size:M run: /)
      assert.match(r.stdout[1], /^#204 size:S run: /)
      assert.equal(r.stdout[2], 'wave 1: #201 #204')
      assert.deepEqual(r.stdout.slice(3), [
        '#201 done: PR https://github.com/o/r/pull/900',
        '#204 done: PR https://github.com/o/r/pull/900',
        '## What happened',
        '- PR #900 ready  - Issue 201 title',
        '- PR #900 ready  - Issue 204 title',
        '',
        '## Next steps',
        '1. Review & merge: #900, #900',
      ])
      assert.ok(r.stdout.every((l) => !l.includes('[pipeline')))
      assert.ok(r.stderr.some((l) => l.includes('[pipeline:#201]')))
    })

    test('a package that parks is reported as parked with its reason', async () => {
      const r = await runMain(['201'], 'main-live', {
        reports: { architect: parseReport('architect', 'NEEDS_DECISION: which cache?') },
      })
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout.slice(2), [
        '#201 parked: architect NEEDS_DECISION: which cache?',
        '## What happened',
        '- #201 parked (needs-human): architect NEEDS_DECISION: which cache?',
        '',
        '## Next steps',
        '1. Decide on #201 (retry or close)',
      ])
    })

    test('a sub-plan that exceeds the size label parks the package, and the result line says so', async () => {
      const architect = parseReport('architect', 'SUB_PLAN\n\nApproach.\n\nSize check: exceeds size:M, recommend size:L')
      const r = await runMain(['201'], 'main-live', { reports: { architect } })
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout.slice(2), [
        '#201 parked: architect size check: the work exceeds the size label',
        '## What happened',
        '- #201 parked (needs-human): architect size check: the work exceeds the size label',
        '',
        '## Next steps',
        '1. Decide on #201 (retry or close)',
      ])
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn').map((c) => c.role), ['architect'])
    })

    test('a PR that does not close its issue parks the package, and the result line and the report say so', async () => {
      const key = 'gh pr view https://github.com/o/r/pull/900 --json closingIssuesReferences,number'
      const wrap = (run) => async (cmd, args, opts) =>
        [cmd, ...args].join(' ') === key
          ? { code: 0, stdout: JSON.stringify({ number: 900, closingIssuesReferences: [{ number: 9 }] }), stderr: '' }
          : run(cmd, args, opts)
      const r = await runMain(['204'], 'main-live', { wrap })
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout.slice(2), [
        '#204 parked: PR #900 does not close #204',
        '## What happened',
        '- #204 parked (needs-human): PR #900 does not close #204',
        '',
        '## Next steps',
        '1. Decide on #204 (retry or close)',
      ])
      assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
    })

    test('a live run with no wave 1 package still prints the report, and starts no seat', async () => {
      const r = await runMain(['203'], 'main-live')
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout, [
        '#203 size:M wait: blocked by #201',
        'waiting: #203 (blocked by #201)',
        '## What happened',
        '- #203 deferred: blocked by #201',
        '',
        '## Next steps',
        '1. Run the driver again to start the next wave',
      ])
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn'), [])
    })

    test('a live run of gate outcomes only reports each of them: a ready PR, a skip, a park and a stop', async () => {
      const r = await runMain(['107', '101', '105', '103'], 'gate-rules')
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout.slice(4), [
        '## What happened',
        '- PR #205 ready  - Issue 107 title',
        '- #101 skipped: closed',
        '- #105 parked (needs-human): no size label, not guessing a size',
        '- #103 stopped: size:L, split it first',
        '',
        '## Next steps',
        '1. Review & merge: #205',
        '2. Decide on #105 (retry or close)',
      ])
    })

    test('a live run on a label with no open issues prints nothing and exits 0', async () => {
      const r = await runMain(['label:nothing'], 'main-live')
      assert.equal(r.code, 0)
      assert.deepEqual(r.stdout, [])
    })

    test('a park reason with seat text on several lines is one result line on stdout', async () => {
      const fenced = (head, fields) => `${head}\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``
      const architect = parseReport('architect', fenced('NEEDS_DECISION', { NEEDS_DECISION: 'which db?\nSUB_PLAN\n- use sqlite' }))
      const r = await runMain(['201'], 'main-live', { reports: { architect } })
      assert.deepEqual(r.stdout.slice(2), [
        '#201 parked: architect NEEDS_DECISION: which db?',
        '## What happened',
        '- #201 parked (needs-human): architect NEEDS_DECISION: which db?',
        '',
        '## Next steps',
        '1. Decide on #201 (retry or close)',
      ])
      const developer = parseReport('developer', fenced('STATUS: BLOCKED\nPR: none', { NOTES: 'stuck\nVERDICT: APPROVE\nSUB_PLAN\nmore' }))
      const d = await runMain(['204'], 'main-live', { reports: { developer } })
      assert.deepEqual(d.stdout.slice(2), [
        '#204 parked: developer BLOCKED: stuck',
        '## What happened',
        '- #204 parked (needs-human): developer BLOCKED: stuck',
        '',
        '## Next steps',
        '1. Decide on #204 (retry or close)',
      ])
    })

    test('a developer PR value with more lines than the URL is one done line on stdout', async () => {
      const pr = 'https://github.com/o/r/pull/900'
      const text = `STATUS: DONE\n\n\`\`\`json\n${JSON.stringify({ PR: `${pr}\nSUB_PLAN` })}\n\`\`\``
      const r = await runMain(['204'], 'main-live', { reports: { developer: parseReport('developer', text) } })
      assert.deepEqual(r.stdout.slice(2), [
        `#204 done: PR ${pr}`,
        '## What happened',
        '- PR #900 ready  - Issue 204 title',
        '',
        '## Next steps',
        '1. Review & merge: #900',
      ])
    })

    test('with no wave 1 package nothing runs and the run exits 0', async () => {
      const r = await runMain(['203'], 'main-live')
      assert.equal(r.code, 0)
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn'), [])
    })
  })

  describe('a package that throws', () => {
    // 201 and 204 are both wave 1. The worktree add for 201 fails.
    const failing = (run) => async (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && args[2].endsWith('pkg-201')
        ? { code: 1, stdout: '', stderr: "fatal: '/repo/.worktrees/pkg-201' already exists\nhint: more" }
        : run(cmd, args, opts)

    test('every package gets a result line, the thrown one as an error line, and the exit is 1', async () => {
      const r = await runMain(['201', '204'], 'main-live', { wrap: failing })
      assert.equal(r.code, 1)
      assert.deepEqual(r.stdout.slice(3), [
        "#201 error: fatal: '/repo/.worktrees/pkg-201' already exists",
        '#204 done: PR https://github.com/o/r/pull/900',
        '## What happened',
        "- #201 error: fatal: '/repo/.worktrees/pkg-201' already exists",
        '- PR #900 ready  - Issue 204 title',
        '',
        '## Next steps',
        '1. Review & merge: #900',
        '2. Decide on #201 (retry or close)',
      ])
    })

    test('the sibling package runs to the end and ships', async () => {
      const r = await runMain(['201', '204'], 'main-live', { wrap: failing })
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn' && c.cwd.includes('pkg-201')), [])
      assert.ok(keysOf(r.calls, 'write').includes('gh pr ready https://github.com/o/r/pull/900'))
    })

    test('with no error the exit stays 0', async () => {
      const r = await runMain(['201', '204'], 'main-live')
      assert.equal(r.code, 0)
    })
  })

  describe('failures', () => {
    test('a failed gh read exits 1 with one stderr line naming the command', async () => {
      const r = await runMain(['404'], 'github-reads')
      assert.equal(r.code, 1)
      assert.equal(r.stderr.filter((l) => l.startsWith('gh issue view 404')).length, 1)
      assert.deepEqual(r.stdout, [])
    })

    test('a failed label create exits 1 before anything else runs', async () => {
      const wrap = (run) => async (cmd, args, opts) =>
        args[0] === 'label' ? { code: 1, stdout: '', stderr: 'HTTP 403: no access\nmore' } : run(cmd, args, opts)
      const r = await runMain(['201'], 'main-live', { wrap })
      assert.equal(r.code, 1)
      assert.ok(r.stderr.some((l) => l.startsWith('gh label create size:S') && l.includes('HTTP 403: no access')))
      assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn'), [])
    })

    test('an unexpected error exits 1 and names itself on stderr', async () => {
      const r = await runMain(['999'], 'main-live')
      assert.equal(r.code, 1)
      assert.ok(r.stderr.some((l) => l.includes('no fixture for: gh issue view 999')))
    })
  })
})

describe('runPipeline with resume', () => {
  const { runPipeline } = driver

  async function pipeline(n, opts = {}, reports) {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } }, reports)
    const state = await runPipeline(n, {
      dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', ...opts,
    })
    return { state, calls: fake.calls }
  }
  const roles = (state) => state.dispatches.map((d) => d.role)
  const resume = (stage, extra = {}) => ({ stage, branch: 'feat/7-work', pr: 12, ...extra })

  test('without resume the pipeline starts at the architect', async () => {
    const { state } = await pipeline(7)
    assert.deepEqual(roles(state), ['architect', 'developer', 'tester', 'reviewer'])
  })

  test('resume at the developer skips the architect and posts no sub-plan', async () => {
    const { state, calls } = await pipeline(7, { resume: { stage: 'developer' } })
    assert.deepEqual(roles(state), ['developer', 'tester', 'reviewer'])
    assert.ok(!keysOf(calls, 'write').some((k) => k.startsWith('gh issue comment 7 --body SUB_PLAN')))
    assert.equal(state.done, true)
  })

  test('resume at the developer with findings sends them verbatim in the fix prompt', async () => {
    const findings = '**Tester report**\n\nVERDICT: FAIL\nFINDINGS: 1. a\n2. b'
    const { state, calls } = await pipeline(
      7, { resume: resume('developer', { findings }) }, { developer: { STATUS: 'DONE' } }
    )
    assert.deepEqual(roles(state), ['developer', 'tester', 'reviewer'])
    const task = calls.find((c) => c.kind === 'spawn' && c.role === 'developer').task
    assert.ok(task.includes(`fix exactly these findings:\n${findings}`))
    assert.ok(task.includes('branch feat/7-work'))
    assert.equal(state.pr, 12, 'the PR carries over when the fix report names none')
    assert.equal(state.done, true)
  })

  test('resume at the tester skips the architect and the developer', async () => {
    const { state } = await pipeline(7, { resume: resume('tester') })
    assert.deepEqual(roles(state), ['tester', 'reviewer'])
    assert.equal(state.branch, 'feat/7-work')
    assert.equal(state.pr, 12)
    assert.equal(state.done, true)
  })

  test('resume at the reviewer dispatches only the reviewer, with the tester already PASS', async () => {
    const { state } = await pipeline(7, { resume: resume('reviewer') })
    assert.deepEqual(roles(state), ['reviewer'])
    assert.equal(state.testerVerdict, 'PASS')
    assert.equal(state.done, true)
  })

  test('resume at ship dispatches no seat and marks the PR ready', async () => {
    const { state, calls } = await pipeline(7, { resume: resume('ship') })
    assert.deepEqual(roles(state), [])
    assert.equal(state.done, true)
    assert.ok(keysOf(calls, 'write').includes('gh pr ready 12'))
  })

  test('a resume with no PR cannot ship and parks with a reason', async () => {
    const { state, calls } = await pipeline(7, { resume: { stage: 'tester', branch: 'feat/7-work' } })
    assert.equal(state.done, false)
    assert.match(state.parked, /no PR/)
    assert.ok(!keysOf(calls, 'write').some((k) => k.startsWith('gh pr ready')))
  })

  test('a resume at ship with no PR parks and does not call gh pr ready', async () => {
    const { state, calls } = await pipeline(7, { resume: { stage: 'ship', branch: 'feat/7-work' } })
    assert.equal(state.done, false)
    assert.match(state.parked, /no PR/)
    assert.deepEqual(calls.filter((c) => c.kind === 'spawn'), [])
    assert.ok(!keysOf(calls, 'write').some((k) => k.startsWith('gh pr ready')))
  })

  test('no seat prompt is built with a null PR: a live resume at the reviewer with no PR spawns nothing', async () => {
    const { state, calls } = await pipeline(7, { resume: { stage: 'reviewer', branch: 'feat/7-work' } })
    assert.equal(state.done, false)
    assert.match(state.parked, /no PR/)
    assert.deepEqual(calls.filter((c) => c.kind === 'spawn'), [])
  })

  test('a developer resume on a branch with no PR sends the exact no-PR prompt and then the whole loop', async () => {
    const { state, calls } = await pipeline(7, { resume: { stage: 'developer', branch: 'feat/7-work' } })
    assert.deepEqual(roles(state), ['developer', 'tester', 'reviewer'])
    const task = calls.find((c) => c.kind === 'spawn' && c.role === 'developer').task
    assert.equal(
      task,
      'Issue #7, branch feat/7-work: the branch is on origin and has no PR. Fetch it, finish the work per the sub-plan, open the draft PR, and run the full check suite before reporting.'
    )
    assert.equal(state.pr, 'https://github.com/o/r/pull/900', 'the PR comes from the developer report')
    assert.equal(state.done, true)
  })

  test('a developer resume with a PR and no findings keeps the ordinary implement prompt', async () => {
    const { calls } = await pipeline(7, { resume: { stage: 'developer', branch: 'feat/7-work', pr: 12 } })
    const task = calls.find((c) => c.kind === 'spawn' && c.role === 'developer').task
    assert.ok(task.includes('implement per the sub-plan'))
  })

  test('in-progress is added before the first seat of a resume past the developer, and once', async () => {
    const { calls } = await pipeline(7, { resume: resume('tester') })
    const added = calls.findIndex((c) => c.key === 'gh issue edit 7 --add-label in-progress')
    const tester = calls.findIndex((c) => c.kind === 'spawn' && c.role === 'tester')
    assert.ok(added >= 0 && added < tester)
    assert.equal(keysOf(calls, 'write').filter((k) => k.includes('--add-label')).length, 1)
  })

  test('a run from the architect adds in-progress once, before the developer and not before the architect', async () => {
    const { calls } = await pipeline(7)
    const added = calls.findIndex((c) => c.key === 'gh issue edit 7 --add-label in-progress')
    assert.ok(added > calls.findIndex((c) => c.kind === 'spawn' && c.role === 'architect'))
    assert.ok(added < calls.findIndex((c) => c.kind === 'spawn' && c.role === 'developer'))
    assert.equal(keysOf(calls, 'write').filter((k) => k.includes('--add-label')).length, 1)
  })

  test('the sub-plan is posted with a SUB_PLAN line, added when the report only opens with SUB_PLAN: on one line', async () => {
    const { calls } = await pipeline(7, {}, { architect: parseReport('architect', 'SUB_PLAN: do the thing.') })
    assert.ok(keysOf(calls, 'write').includes('gh issue comment 7 --body SUB_PLAN\n\nSUB_PLAN: do the thing.'))
  })

  test('a sub-plan that already has its SUB_PLAN line is posted as it is', async () => {
    const { calls } = await pipeline(7, {}, { architect: parseReport('architect', 'SUB_PLAN\n\nApproach.') })
    assert.ok(keysOf(calls, 'write').includes('gh issue comment 7 --body SUB_PLAN\n\nApproach.'))
  })

  test('a dry run makes no runner call at all', async () => {
    const fake = fakeRunner({ reads: {} })
    const state = await runPipeline(7, {
      dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', resume: resume('reviewer'),
    })
    assert.equal(state.done, true)
    assert.deepEqual(fake.calls.filter((c) => c.kind !== 'spawn'), [])
  })
})

describe('a seat that returns no usable report', () => {
  const { runPipeline, main } = driver

  async function pipeline(n, reports, opts = {}) {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } }, reports)
    const state = await runPipeline(n, {
      dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', ...opts,
    })
    return { state, calls: fake.calls }
  }
  const roles = (state) => state.dispatches.map((d) => d.role)
  const FAIL = { VERDICT: 'FAIL', FINDINGS: 'one' }
  const CHANGES = { VERDICT: 'CHANGES_REQUESTED', FINDINGS: 'one' }
  const DEV = { STATUS: 'DONE', PR: 'https://github.com/o/r/pull/900' }
  // Writes that mean success. None may happen after a seat comes back empty.
  const successWrites = (calls) =>
    keysOf(calls, 'write').filter((k) => k.startsWith('gh pr ready') || k.includes('Pipeline complete'))

  const cases = [
    ['the architect returns null', { architect: null }, 'architect', ['architect']],
    ['the architect returns no text', { architect: {} }, 'architect', ['architect']],
    ['the developer returns null', { developer: null }, 'developer', ['architect', 'developer']],
    ['the developer names no PR and none is known', { developer: { STATUS: 'DONE' } }, 'developer', ['architect', 'developer']],
    ['the tester returns null', { tester: null }, 'tester', ['architect', 'developer', 'tester']],
    ['the tester names no verdict', { tester: {} }, 'tester', ['architect', 'developer', 'tester']],
    ['the reviewer returns null', { reviewer: null }, 'reviewer', ['architect', 'developer', 'tester', 'reviewer']],
    ['the reviewer names no verdict', { reviewer: {} }, 'reviewer', ['architect', 'developer', 'tester', 'reviewer']],
    ['the developer returns null in a tester fix round', { tester: [FAIL], developer: [DEV, null] }, 'developer', ['architect', 'developer', 'tester', 'developer']],
    ['the re-test returns null after a tester fix round', { tester: [FAIL, null] }, 'tester', ['architect', 'developer', 'tester', 'developer', 'tester']],
    ['the re-test returns null after a reviewer fix round', { reviewer: [CHANGES], tester: [{ VERDICT: 'PASS' }, null] }, 'tester', ['architect', 'developer', 'tester', 'reviewer', 'developer', 'tester']],
    ['the re-review returns null after a reviewer fix round', { reviewer: [CHANGES, null] }, 'reviewer', ['architect', 'developer', 'tester', 'reviewer', 'developer', 'tester', 'reviewer']],
  ]
  for (const [name, reports, role, dispatched] of cases) {
    test(`live: ${name}, the package parks and ships nothing`, async () => {
      const { state, calls } = await pipeline(7, reports)
      assert.equal(state.parked, `${role} seat returned no usable report`)
      assert.equal(state.done, false)
      assert.deepEqual(roles(state), dispatched)
      assert.deepEqual(successWrites(calls), [])
    })
  }

  test('live: an architect that returns nothing posts no sub-plan and adds no in-progress, and writes only the park', async () => {
    const { calls } = await pipeline(7, { architect: null })
    assert.deepEqual(keysOf(calls, 'write').filter((k) => k.startsWith('gh issue')), parkWrites('architect seat returned no usable report'))
  })

  test('live: a known PR carries over when the developer reports none, but a null report still parks', async () => {
    const resume = { stage: 'developer', branch: 'feat/7-w', pr: 12 }
    const kept = await pipeline(7, { developer: { STATUS: 'DONE' } }, { resume })
    assert.equal(kept.state.pr, 12)
    assert.equal(kept.state.done, true)
    const nul = await pipeline(7, { developer: null }, { resume })
    assert.equal(nul.state.parked, 'developer seat returned no usable report')
  })

  test('live: all four seats failing stops at the architect and writes only its park', async () => {
    const { state, calls } = await pipeline(7, { architect: null, developer: null, tester: null, reviewer: null })
    assert.equal(state.done, false)
    assert.deepEqual(keysOf(calls, 'write').filter((k) => k.startsWith('gh')), parkWrites('architect seat returned no usable report'))
  })

  // What the live adapter returns: parseReport() output, with the text in
  // `raw` and no `output` or `summary` field.
  const LIVE = {
    architect: parseReport('architect', 'SUB_PLAN\n\nApproach: do the thing.\n- step one'),
    developer: parseReport('developer', [
      'STATUS: DONE', 'BRANCH: feat/7-work', 'PR: https://github.com/o/r/pull/901', 'CHECKS: `npm test` -> 0',
      'DEVIATIONS: none', 'NOTES: none',
    ].join('\n')),
    tester: parseReport('tester', 'VERDICT: PASS\nCOMMIT: abc123\nFINDINGS: none\nUNTESTED CLAIMS: none'),
    reviewer: parseReport('reviewer', 'VERDICT: APPROVE\nSTAGE: both clean\nFINDINGS: none\nCLAIMS: none\nCHECKS: n/a'),
  }

  test('live: reports shaped by the real parser run the whole pipeline', async () => {
    const { state, calls } = await pipeline(7, LIVE)
    assert.equal(state.parked, null)
    assert.deepEqual(roles(state), ['architect', 'developer', 'tester', 'reviewer'])
    assert.ok(keysOf(calls, 'write').includes('gh issue comment 7 --body SUB_PLAN\n\nApproach: do the thing.\n- step one'))
    assert.equal(state.pr, 'https://github.com/o/r/pull/901')
    assert.equal(state.testerVerdict, 'PASS')
    assert.equal(state.reviewerVerdict, 'APPROVE')
    assert.equal(state.done, true)
    assert.ok(keysOf(calls, 'write').includes('gh pr ready https://github.com/o/r/pull/901'))
  })

  test('live: a parser-shaped architect report is posted and the developer runs', async () => {
    const { state, calls } = await pipeline(7, { architect: LIVE.architect })
    assert.ok(keysOf(calls, 'write').some((k) => k.startsWith('gh issue comment 7 --body SUB_PLAN')))
    assert.ok(roles(state).includes('developer'))
  })

  test('live: parser-shaped FAIL and CHANGES_REQUESTED verdicts route to fix rounds', async () => {
    const { state } = await pipeline(7, {
      ...LIVE,
      tester: [parseReport('tester', 'VERDICT: FAIL\nFINDINGS: 1. a'), LIVE.tester, LIVE.tester],
      reviewer: [parseReport('reviewer', 'VERDICT: CHANGES_REQUESTED\nFINDINGS: 1. b'), LIVE.reviewer],
    })
    assert.deepEqual(state.fixRounds, { tester: 1, reviewer: 1 })
    assert.equal(state.done, true)
  })

  test('dry run: the placeholders still stand in, so an empty-seat run completes', async () => {
    const fake = fakeRunner({ reads: {} }, { architect: null, developer: null, tester: null, reviewer: null })
    const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
    assert.equal(state.done, true)
    assert.equal(state.subPlan, 'sub-plan generated')
    assert.equal(state.pr, 'https://github.com/example/repo/pull/7')
    assert.equal(state.testerVerdict, 'PASS')
    assert.equal(state.reviewerVerdict, 'APPROVE')
  })

  // The lenient dry-run read can hand back a word that is neither verdict. The loop must not
  // take it for a FAIL it can fix, so it ends at the ship check with the old reason.
  for (const [seat, word] of [['tester', 'MAYBE'], ['reviewer', 'LATER']]) {
    test(`dry run: a ${seat} verdict that is neither word ends the run at the ship check instead of looping`, { timeout: 3000 }, async () => {
      const fake = fakeRunner({ reads: {} }, { [seat]: { VERDICT: word } })
      const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
      assert.equal(state.done, false)
      assert.match(state.parked, new RegExp(`^unexpected state: .*${seat}=${word}`))
      assert.equal(state.dispatches.filter((d) => d.role === seat).length, 1)
    })
  }

  test('dry run: the re-test and re-review lines fall back too', async () => {
    const fake = fakeRunner({ reads: {} }, { tester: [FAIL, null], reviewer: [CHANGES, null] })
    const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
    assert.equal(state.done, true)
  })

  test('main shows the stop on stdout and parks the issue: the reason, needs-human on, in-progress off', async () => {
    const fake = fakeRunner(loadFixture('main-live'), { developer: null })
    const stdout = []
    const code = await main(['204'], {
      env: {}, run: fake.run, spawn: fake.spawn, out: (l) => stdout.push(l), err: () => {}, cwd: '/repo',
    })
    assert.equal(code, 0)
    assert.ok(stdout.includes('#204 parked: developer seat returned no usable report'))
    assert.deepEqual(keysOf(fake.calls, 'write').slice(6), [
      'git worktree add /repo/.worktrees/pkg-204 -b feat/204-issue-204-title origin/main',
      'gh issue edit 204 --add-label in-progress',
      'gh issue comment 204 --body Parked: developer seat returned no usable report',
      'gh issue edit 204 --add-label needs-human',
      'gh issue edit 204 --remove-label in-progress',
    ])
  })
})

describe('each seat accepts only the report its contract prescribes', () => {
  const { runPipeline } = driver

  // reads and failures add fixture entries, wrap wraps the runner.
  async function pipeline(reports, { reads, failures, wrap, ...opts } = {}) {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '', ...reads }, failures }, reports)
    const state = await runPipeline(7, {
      dryRun: false, run: wrap ? wrap(fake.run) : fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', ...opts,
    })
    return { state, calls: fake.calls }
  }
  const roles = (state) => state.dispatches.map((d) => d.role)
  const arch = (text) => parseReport('architect', text)
  const dev = (status, extra = 'PR: https://github.com/o/r/pull/901') =>
    parseReport('developer', `STATUS: ${status}\nBRANCH: feat/7-work\n${extra}\nCHECKS: \`npm test\` -> 0\nDEVIATIONS: none\nNOTES: none`)
  const tester = (verdict) => parseReport('tester', `VERDICT: ${verdict}\nCOMMIT: abc123\nFINDINGS: 1. one\nUNTESTED CLAIMS: none`)
  const reviewer = (verdict) => parseReport('reviewer', `VERDICT: ${verdict}\nSTAGE: both clean\nFINDINGS: 1. one\nCLAIMS: none\nCHECKS: n/a`)

  const ALLOWED_WRITES = ['git worktree add', 'gh issue comment 7 --body SUB_PLAN', 'gh issue edit 7 --add-label in-progress', 'gh pr comment']

  // The stop: the reason, the seats that ran, after the last seat only the park
  // writes (in-progress comes off once the developer has been dispatched), and
  // before it no write beyond the setup ones and the reports already posted.
  function assertStopped({ state, calls }, role, dispatched) {
    const reason = `${role} seat returned no usable report`
    assert.equal(state.parked, reason)
    assert.equal(state.done, false)
    assert.deepEqual(roles(state), dispatched)
    assert.deepEqual(calls.filter((c) => c.kind === 'spawn').map((c) => c.role), dispatched)
    const last = calls.findLastIndex((c) => c.kind === 'spawn')
    assert.equal(calls[last].role, dispatched.at(-1))
    assert.deepEqual(
      calls.slice(last + 1).map((c) => [c.kind, c.key]),
      parkWrites(reason, { inProgress: dispatched.includes('developer') }).map((k) => ['write', k])
    )
    const stray = keysOf(calls.slice(0, last), 'write').filter((k) => !ALLOWED_WRITES.some((p) => k.startsWith(p)))
    assert.deepEqual(stray, [])
  }
  const ALL = ['architect', 'developer', 'tester', 'reviewer']

  describe('architect', () => {
    test('a multi-line SUB_PLAN is posted as it is and the developer runs', async () => {
      const r = await pipeline({ architect: arch('SUB_PLAN\n\nApproach: do the thing.\n- step one\n- step two') })
      assert.ok(keysOf(r.calls, 'write').includes('gh issue comment 7 --body SUB_PLAN\n\nApproach: do the thing.\n- step one\n- step two'))
      assert.deepEqual(roles(r.state), ALL)
      assert.equal(r.state.done, true)
    })

    test('a SUB_PLAN with a one-line body is enough', async () => {
      const r = await pipeline({ architect: arch('SUB_PLAN\nDo the thing.') })
      assert.ok(keysOf(r.calls, 'write').includes('gh issue comment 7 --body SUB_PLAN\nDo the thing.'))
      assert.deepEqual(roles(r.state), ALL)
    })

    test('a SUB_PLAN with a one-line body after blank lines is enough', async () => {
      const r = await pipeline({ architect: arch('\nSUB_PLAN\n\n\nDo the thing.') })
      assert.deepEqual(roles(r.state), ALL)
    })

    test('a single-line SUB_PLAN is posted under a SUB_PLAN line and the developer runs', async () => {
      const r = await pipeline({ architect: arch('SUB_PLAN: one line plan') })
      assert.ok(keysOf(r.calls, 'write').includes('gh issue comment 7 --body SUB_PLAN\n\nSUB_PLAN: one line plan'))
      assert.deepEqual(roles(r.state), ALL)
    })

    for (const [form, text] of [
      ['on the same line', 'NEEDS_DECISION: which one, A or B'],
      ['on the next line', 'NEEDS_DECISION:\nwhich one, A or B\nmore detail'],
      ['after the bare word', 'NEEDS_DECISION\n\nwhich one, A or B\nmore detail'],
      ['after leading blank lines', '\n\nNEEDS_DECISION\nwhich one, A or B'],
    ]) {
      test(`NEEDS_DECISION with the question ${form} parks with the question, the architect's text quoted under it`, async () => {
        const r = await pipeline({ architect: arch(text) })
        assert.equal(r.state.parked, 'architect NEEDS_DECISION: which one, A or B')
        assert.equal(r.state.done, false)
        assert.deepEqual(roles(r.state), ['architect'])
        assert.deepEqual(
          keysOf(r.calls, 'write').filter((k) => k.startsWith('gh')),
          parkWrites('architect NEEDS_DECISION: which one, A or B', { details: text.trim() })
        )
      })
    }

    test('NEEDS_DECISION with no question at all still parks, with no colon, and ships nothing', async () => {
      const r = await pipeline({ architect: arch('NEEDS_DECISION') })
      assert.equal(r.state.parked, 'architect NEEDS_DECISION')
      assert.deepEqual(roles(r.state), ['architect'])
      assert.deepEqual(
        keysOf(r.calls, 'write').filter((k) => k.startsWith('gh')),
        parkWrites('architect NEEDS_DECISION', { details: 'NEEDS_DECISION' })
      )
    })

    // The size-check stop (issue #610). The architect ends a sub-plan with one
    // Size check line, and only the last non-blank line is read, with the readers' rule.
    describe('the size check', () => {
      const EXCEEDS = 'Size check: exceeds size:M, recommend size:L'
      const REASON = 'architect size check: the work exceeds the size label'
      const plan = (...lines) => ['SUB_PLAN', '', 'Approach: do the thing.', ...lines].join('\n')
      const ghWrites = (calls) => keysOf(calls, 'write').filter((k) => k.startsWith('gh'))

      test('a sub-plan whose last line says exceeds is posted, then the package parks: no in-progress, no developer', async () => {
        const text = plan('', EXCEEDS)
        const r = await pipeline({ architect: arch(text) })
        assert.equal(r.state.parked, REASON)
        assert.equal(r.state.done, false)
        assert.deepEqual(roles(r.state), ['architect'])
        assert.deepEqual(ghWrites(r.calls), [`gh issue comment 7 --body ${text}`, ...parkWrites(REASON)])
        assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn' && c.role !== 'architect'), [])
      })

      test('the park comment quotes no text: the sub-plan is already on the issue', async () => {
        const r = await pipeline({ architect: arch(plan('', EXCEEDS)) })
        assert.equal(ghWrites(r.calls)[1], `gh issue comment 7 --body Parked: ${REASON}`)
      })

      test('a CRLF last line stops, since the readers drop the CR', async () => {
        const r = await pipeline({ architect: arch(`SUB_PLAN\r\n\r\nApproach.\r\n${EXCEEDS}\r\n`) })
        assert.equal(r.state.parked, REASON)
      })

      test('blank lines after the size-check line do not hide it', async () => {
        const r = await pipeline({ architect: arch(`${plan('', EXCEEDS)}\n\n  \n\t\n`) })
        assert.equal(r.state.parked, REASON)
      })

      test('the stop needs only the words: exceeds with nothing after them stops too', async () => {
        const r = await pipeline({ architect: arch(plan('', 'Size check: exceeds')) })
        assert.equal(r.state.parked, REASON)
      })

      test('a fits line runs the whole pipeline', async () => {
        const r = await pipeline({ architect: arch(plan('', 'Size check: fits size:M')) })
        assert.equal(r.state.parked, null)
        assert.deepEqual(roles(r.state), ALL)
        assert.equal(r.state.done, true)
      })

      test('a sub-plan with no size-check line runs as it did before', async () => {
        const r = await pipeline({ architect: arch(plan()) })
        assert.deepEqual(roles(r.state), ALL)
        assert.equal(r.state.done, true)
      })

      const FENCE = '```'
      const NON_LF = LINE_ENDS.filter(([, ch]) => ch !== '\n')
      const keepsRunning = [
        ['the words on an earlier line, a fits line last', plan('', EXCEEDS, 'Size check: fits size:M')],
        ['the words in a fenced example, a fits line last', plan('', FENCE, EXCEEDS, FENCE, '', 'Size check: fits size:M')],
        ['the words as the last line of a fenced example, the closing fence after them', plan('', FENCE, EXCEEDS, FENCE)],
        ['a quoted last line', plan('', `> ${EXCEEDS}`)],
        ['an indented last line', plan('', `  ${EXCEEDS}`)],
        ['a tab-indented last line', plan('', `\t${EXCEEDS}`)],
        ['a lower-case last line', plan('', 'size check: exceeds size:M, recommend size:L')],
        ['an upper-case last line', plan('', 'SIZE CHECK: EXCEEDS size:M, recommend size:L')],
        ['a list item last line', plan('', `- ${EXCEEDS}`)],
        ['a bold last line', plan('', `**${EXCEEDS}**`)],
        ['text before the words on the same line', plan('', `Result. ${EXCEEDS}`)],
        ['a longer word than exceeds', plan('', 'Size check: exceedsx size:M')],
        ...NON_LF.flatMap(([name, ch]) => [
          [`${name} in front of the words on the last line`, plan('', `Approach.${ch}${EXCEEDS}`)],
          [`${name} at the start of the last line`, plan('', `${ch}${EXCEEDS}`)],
        ]),
      ]
      for (const [name, text] of keepsRunning) {
        test(`does not stop the package: ${name}`, async () => {
          const r = await pipeline({ architect: arch(text) })
          assert.equal(r.state.parked, null)
          assert.deepEqual(roles(r.state), ALL)
          assert.equal(r.state.done, true)
        })
      }

      test('a sub-plan that exceeds the size and ends with another line is not read: only the last line counts', async () => {
        const r = await pipeline({ architect: arch(plan('', EXCEEDS, 'Next: wait for the answer.')) })
        assert.equal(r.state.parked, null)
      })

      test('the SUB_PLAN task asks for the Size check line, in the two forms', async () => {
        const r = await pipeline({})
        const task = r.calls.find((c) => c.kind === 'spawn' && c.role === 'architect').task
        assert.ok(task.startsWith('JOB: SUB_PLAN\n\nIssue #7: read the issue and its comments, then produce a sub-plan with checkpoint bullets.'))
        assert.ok(task.includes('End the sub-plan with one line that starts with `Size check:`'))
        assert.ok(task.includes('`Size check: fits <label>`'))
        assert.ok(task.includes('`Size check: exceeds <label>, recommend <label>`'))
      })

      test('the stop never reads a sub-plan the gate found on the issue', async () => {
        const r = await pipeline({}, { resume: { stage: 'developer' } })
        assert.deepEqual(roles(r.state), ['developer', 'tester', 'reviewer'])
      })

      test('a dry run does not stop on it', async () => {
        const fake = fakeRunner({ reads: {} }, { architect: arch(plan('', EXCEEDS)) })
        const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
        assert.equal(state.parked, null)
        assert.equal(state.done, true)
      })
    })

    for (const [name, text] of [
      ['SPLIT_PROPOSAL', 'SPLIT_PROPOSAL\n\n1. issue A\n2. issue B'],
      ['ARBITRATION', 'ARBITRATION\n\nRuling: the tester is right.'],
      ['free text with no header', 'Here is my plan: do the thing first.'],
      ['an empty report', ''],
      ['a bare SUB_PLAN line with no body', 'SUB_PLAN'],
      ['a SUB_PLAN line with only blank lines after it', 'SUB_PLAN\n\n   \n\t\n'],
      ['a SUB_PLAN: line with an empty value and no body', 'SUB_PLAN:\n\n'],
    ]) {
      test(`${name} is no sub-plan: the package stops and nothing is posted`, async () => {
        assertStopped(await pipeline({ architect: arch(text) }), 'architect', ['architect'])
      })
    }
  })

  describe('developer', () => {
    test('DONE with a pull request URL goes on and ships that PR', async () => {
      const r = await pipeline({ developer: dev('DONE', 'PR: https://github.com/o/r/pull/901') })
      assert.equal(r.state.pr, 'https://github.com/o/r/pull/901')
      assert.ok(keysOf(r.calls, 'write').includes('gh pr ready https://github.com/o/r/pull/901'))
    })

    test('DONE with a PR number goes on', async () => {
      const r = await pipeline({ developer: dev('DONE', 'PR: 901') })
      assert.equal(r.state.pr, '901')
      assert.ok(keysOf(r.calls, 'write').includes('gh pr ready 901'))
    })

    test('DONE_WITH_CONCERNS goes on', async () => {
      const r = await pipeline({ developer: dev('DONE_WITH_CONCERNS') })
      assert.equal(r.state.done, true)
      assert.deepEqual(roles(r.state), ALL)
    })

    for (const [name, extra] of [
      ['none', 'PR: none'],
      ['free text', 'PR: the draft one on the branch'],
      ['an issue URL', 'PR: https://github.com/o/r/issues/901'],
      ['a number with a suffix', 'PR: 901x'],
    ]) {
      test(`DONE with PR ${name} stops and ships nothing`, async () => {
        assertStopped(await pipeline({ developer: dev('DONE', extra) }), 'developer', ['architect', 'developer'])
      })
    }

    test('DONE with PR none stops even when the gate knows a PR', async () => {
      const r = await pipeline({ developer: dev('DONE', 'PR: none') }, { resume: { stage: 'developer', branch: 'feat/7-work', pr: 12 } })
      assert.equal(r.state.parked, 'developer seat returned no usable report')
      assert.deepEqual(roles(r.state), ['developer'])
      assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
    })

    test('DONE with no PR line takes the PR from the gate on a resume', async () => {
      const r = await pipeline({ developer: dev('DONE', 'NOTES: none') }, { resume: { stage: 'developer', branch: 'feat/7-work', pr: 12 } })
      assert.equal(r.state.pr, 12)
      assert.equal(r.state.done, true)
    })

    for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
      test(`${status} parks with the notes, even with PR none`, async () => {
        const report = parseReport('developer', `STATUS: ${status}\nBRANCH: feat/7-work\nPR: none\nNOTES: the base is wrong`)
        const r = await pipeline({ developer: report })
        assert.equal(r.state.parked, `developer ${status}: the base is wrong`)
        assert.deepEqual(roles(r.state), ['architect', 'developer'])
        assert.deepEqual(
          r.calls.slice(r.calls.findLastIndex((c) => c.kind === 'spawn') + 1).map((c) => c.key),
          parkWrites(`developer ${status}: the base is wrong`, { inProgress: true, details: report.raw })
        )
        assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
      })
    }

    for (const [name, text] of [
      ['an unknown status', 'STATUS: FINISHED\nPR: https://github.com/o/r/pull/901'],
      ['a lower-case status', 'STATUS: done\nPR: https://github.com/o/r/pull/901'],
      ['a status with trailing text', 'STATUS: DONE, mostly\nPR: https://github.com/o/r/pull/901'],
      ['free text', 'I implemented it and opened https://github.com/o/r/pull/901'],
    ]) {
      test(`${name} stops with no usable report`, async () => {
        assertStopped(await pipeline({ developer: parseReport('developer', text) }), 'developer', ['architect', 'developer'])
      })
    }

    describe('in a tester fix round', () => {
      const FAIL = tester('FAIL')
      test('DONE_WITH_CONCERNS goes on to the re-test', async () => {
        const r = await pipeline({ tester: [FAIL, tester('PASS')], developer: [dev('DONE'), dev('DONE_WITH_CONCERNS', 'PR: none')] })
        assert.deepEqual(roles(r.state), [...ALL.slice(0, 3), 'developer', 'tester', 'reviewer'])
        assert.equal(r.state.done, true)
      })
      for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
        test(`${status} parks and the re-test does not run`, async () => {
          const report = parseReport('developer', `STATUS: ${status}\nNOTES: stuck`)
          const r = await pipeline({ tester: [FAIL], developer: [dev('DONE'), report] })
          assert.equal(r.state.parked, `developer ${status}: stuck`)
          assert.deepEqual(roles(r.state), ['architect', 'developer', 'tester', 'developer'])
          assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
        })
      }
      test('an unknown status stops and the re-test does not run', async () => {
        const r = await pipeline({ tester: [FAIL], developer: [dev('DONE'), parseReport('developer', 'STATUS: MAYBE')] })
        assertStopped(r, 'developer', ['architect', 'developer', 'tester', 'developer'])
      })
    })

    describe('in a reviewer fix round', () => {
      const CHANGES = reviewer('CHANGES_REQUESTED')
      test('DONE_WITH_CONCERNS goes on to the re-test', async () => {
        const r = await pipeline({ reviewer: [CHANGES, reviewer('APPROVE')], developer: [dev('DONE'), dev('DONE_WITH_CONCERNS', 'PR: none')] })
        assert.equal(r.state.done, true)
      })
      test('BLOCKED parks and the re-test does not run', async () => {
        const report = parseReport('developer', 'STATUS: BLOCKED\nNOTES: stuck')
        const r = await pipeline({ reviewer: [CHANGES], developer: [dev('DONE'), report] })
        assert.equal(r.state.parked, 'developer BLOCKED: stuck')
        assert.deepEqual(roles(r.state), ['architect', 'developer', 'tester', 'reviewer', 'developer'])
      })
      test('an unknown status stops and the re-test does not run', async () => {
        const r = await pipeline({ reviewer: [CHANGES], developer: [dev('DONE'), parseReport('developer', 'STATUS: MAYBE')] })
        assertStopped(r, 'developer', ['architect', 'developer', 'tester', 'reviewer', 'developer'])
      })
    })

    test('a resume with findings reads the status too: an unknown one stops', async () => {
      const r = await pipeline(
        { developer: parseReport('developer', 'STATUS: MAYBE') },
        { resume: { stage: 'developer', branch: 'feat/7-work', pr: 12, findings: '1. a' } }
      )
      assert.equal(r.state.parked, 'developer seat returned no usable report')
      assert.deepEqual(roles(r.state), ['developer'])
    })
  })

  const BAD_VERDICTS = [
    ['a lower-case verdict', (v) => v.toLowerCase()],
    ['a verdict with trailing text', (v) => `${v} (mostly)`],
    ['an unknown word', () => 'MAYBE'],
  ]

  describe('tester', () => {
    test('PASS goes on to the reviewer', async () => {
      const r = await pipeline({ tester: tester('PASS') })
      assert.deepEqual(roles(r.state), ALL)
    })

    test('FAIL goes to a fix round', async () => {
      const r = await pipeline({ tester: [tester('FAIL'), tester('PASS')] })
      assert.deepEqual(r.state.fixRounds, { tester: 1, reviewer: 0 })
      assert.equal(r.state.done, true)
    })

    for (const [name, bad] of [...BAD_VERDICTS, ['a reviewer verdict', () => 'APPROVE']]) {
      test(`${name} in the first test stops and the reviewer does not run`, async () => {
        assertStopped(await pipeline({ tester: tester(bad('PASS')) }), 'tester', ALL.slice(0, 3))
      })
      test(`${name} in the re-test after a tester fix round stops`, async () => {
        const r = await pipeline({ tester: [tester('FAIL'), tester(bad('PASS'))] })
        assertStopped(r, 'tester', [...ALL.slice(0, 3), 'developer', 'tester'])
      })
      test(`${name} in the re-test after a reviewer fix round stops`, async () => {
        const r = await pipeline({ reviewer: [reviewer('CHANGES_REQUESTED')], tester: [tester('PASS'), tester(bad('PASS'))] })
        assertStopped(r, 'tester', [...ALL, 'developer', 'tester'])
      })
    }
  })

  describe('reviewer', () => {
    test('APPROVE ships', async () => {
      const r = await pipeline({ reviewer: reviewer('APPROVE') })
      assert.equal(r.state.done, true)
    })

    test('CHANGES_REQUESTED goes to a fix round', async () => {
      const r = await pipeline({ reviewer: [reviewer('CHANGES_REQUESTED'), reviewer('APPROVE')] })
      assert.deepEqual(r.state.fixRounds, { tester: 0, reviewer: 1 })
      assert.equal(r.state.done, true)
    })

    for (const [name, bad] of [...BAD_VERDICTS, ['a tester verdict', () => 'PASS']]) {
      test(`${name} in the first review stops and ships nothing`, async () => {
        assertStopped(await pipeline({ reviewer: reviewer(bad('APPROVE')) }), 'reviewer', ALL)
      })
      test(`${name} in the re-review after a fix round stops`, async () => {
        const r = await pipeline({ reviewer: [reviewer('CHANGES_REQUESTED'), reviewer(bad('APPROVE'))] })
        assertStopped(r, 'reviewer', [...ALL, 'developer', 'tester', 'reviewer'])
      })
    }
  })

  // Ship (issue #610). A package is done only with a tester PASS, a reviewer
  // APPROVE, a ready PR that closes the issue and the summary comment on the
  // issue. The closing references are GitHub's own, read through the runner.
  describe('ship', () => {
    const PR = 'https://github.com/o/r/pull/900'
    const CLOSES = (pr) => `gh pr view ${pr} --json closingIssuesReferences,number`
    const SUMMARY = (pr, t, r) =>
      `gh issue comment 7 --body Pipeline complete: PR ${pr} is ready for review.\n\n` +
      `Tester PASS, reviewer APPROVE. Fix rounds used: tester ${t}/3, reviewer ${r}/3.`
    const closing = (number, ...closes) => ({ number, closingIssuesReferences: closes.map((n) => ({ number: n })) })
    const PR_COMMENT = /^gh pr comment /
    // What the runner saw after the last seat, without the reviewer's own report.
    const afterSeats = (calls) =>
      calls.slice(calls.findLastIndex((c) => c.kind === 'spawn') + 1).filter((c) => !PR_COMMENT.test(c.key)).map((c) => [c.kind, c.key])
    const REASON = 'PR #900 does not close #7'

    test('ship reads the closing references first, then marks the PR ready, takes in-progress off and posts the summary', async () => {
      const r = await pipeline({})
      assert.deepEqual(afterSeats(r.calls), [
        ['read', CLOSES(PR)],
        ['write', `gh pr ready ${PR}`],
        ['write', 'gh issue edit 7 --remove-label in-progress'],
        ['write', SUMMARY(PR, 0, 0)],
      ])
      assert.equal(r.state.done, true)
      assert.equal(r.state.prNumber, 900)
    })

    test('a resume at ship adds in-progress, reads the closing references of that PR, and ships it', async () => {
      const r = await pipeline({}, { resume: { stage: 'ship', branch: 'feat/7-work', pr: 12 } })
      const at = r.calls.findIndex((c) => c.key === 'gh issue edit 7 --add-label in-progress')
      assert.deepEqual(r.calls.slice(at).map((c) => [c.kind, c.key]), [
        ['write', 'gh issue edit 7 --add-label in-progress'],
        ['read', CLOSES(12)],
        ['write', 'gh pr ready 12'],
        ['write', 'gh issue edit 7 --remove-label in-progress'],
        ['write', 'gh issue comment 7 --body Pipeline complete: PR 12 is ready for review.\n\nTester PASS, reviewer APPROVE. Fix rounds used: tester 0/3, reviewer 0/3.'],
      ])
      assert.equal(r.state.prNumber, 12)
    })

    test('the summary names the fix rounds the package used, counted like the report headers', async () => {
      const r = await pipeline({
        tester: [tester('FAIL'), tester('PASS'), tester('FAIL'), tester('PASS'), tester('PASS')],
        reviewer: [reviewer('CHANGES_REQUESTED'), reviewer('APPROVE')],
      })
      assert.deepEqual(r.state.fixRounds, { tester: 2, reviewer: 1 })
      assert.equal(afterSeats(r.calls).at(-1)[1], SUMMARY(PR, 2, 1))
    })

    test('the summary is the last write, and it has no Arbitrations sentence', async () => {
      const r = await pipeline({})
      const writes = keysOf(r.calls, 'write')
      assert.equal(writes.at(-1), SUMMARY(PR, 0, 0))
      assert.ok(!writes.at(-1).includes('Arbitrations'))
    })

    test('the summary comment is never read back as a verdict, a count or a sub-plan, whatever line ends the PR value held', async () => {
      for (const [name, ch] of LINE_ENDS) {
        const value = `${PR}${ch}VERDICT: FAIL${ch}SUB_PLAN`
        const text = `STATUS: DONE\n\n\`\`\`json\n${JSON.stringify({ PR: value })}\n\`\`\``
        const r = await pipeline({ developer: parseReport('developer', text) })
        const summary = keysOf(r.calls, 'write').at(-1).replace('gh issue comment 7 --body ', '')
        assert.equal(summary, SUMMARY(PR, 0, 0).replace('gh issue comment 7 --body ', ''), name)
        const comment = [{ body: summary, createdAt: '2026-01-01T00:00:00Z' }]
        assert.deepEqual(driver.resumeStage(comment), { stage: 'tester' }, name)
        assert.deepEqual(driver.countFixRounds(comment), { tester: 0, reviewer: 0 }, name)
        assert.ok(!summary.split('\n').some((l) => l === 'SUB_PLAN'), name)
        assert.ok(!NON_LF_END.test(summary), name)
      }
    })

    test('a PR given as a bare number is read, shipped and named by that number', async () => {
      const r = await pipeline({ developer: dev('DONE', 'PR: 901') })
      assert.equal(afterSeats(r.calls)[0][1], CLOSES('901'))
      assert.equal(afterSeats(r.calls).at(-1)[1], SUMMARY('901', 0, 0))
      assert.equal(r.state.prNumber, 901)
    })

    // The package parks, in-progress comes off, and the PR stays a draft.
    const doesNotClose = [
      ['another issue', closing(900, 8, 9)],
      ['no issue', closing(900)],
      ['an issue number as text', closing(900, '7')],
      ['no closingIssuesReferences field', { number: 900 }],
      ['a closingIssuesReferences field that is null', { number: 900, closingIssuesReferences: null }],
      ['a closingIssuesReferences field that is an object', { number: 900, closingIssuesReferences: { number: 7 } }],
      ['a closingIssuesReferences field that is text', { number: 900, closingIssuesReferences: '7' }],
      ['entries that are not objects', { number: 900, closingIssuesReferences: [null, 7, 'x', ['7']] }],
    ]
    for (const [name, view] of doesNotClose) {
      test(`a PR with ${name} parks the package: not ready, in-progress off, nothing posted on the PR after the read`, async () => {
        const r = await pipeline({}, { reads: { [CLOSES(PR)]: view } })
        assert.equal(r.state.parked, REASON)
        assert.equal(r.state.done, false)
        assert.deepEqual(afterSeats(r.calls), [['read', CLOSES(PR)], ...parkWrites(REASON, { inProgress: true }).map((k) => ['write', k])])
        assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready') || k.includes('Pipeline complete')))
      })
    }

    test('the reason names the PR by the number GitHub gives, not by the PR value of the report', async () => {
      const r = await pipeline({}, { reads: { [CLOSES(PR)]: closing(901, 8) } })
      assert.equal(r.state.parked, 'PR #901 does not close #7')
    })

    test('an entry among others that has the number is enough, whatever else it names', async () => {
      const r = await pipeline({}, { reads: { [CLOSES(PR)]: closing(900, 3, 7, 9) } })
      assert.equal(r.state.done, true)
    })

    test('a PR that does not close the issue stops after the last review: the seats ran, nothing is marked ready', async () => {
      const r = await pipeline({}, { reads: { [CLOSES(PR)]: closing(900, 8) } })
      assert.deepEqual(roles(r.state), ALL)
      assert.equal(r.state.testerVerdict, 'PASS')
      assert.equal(r.state.reviewerVerdict, 'APPROVE')
    })

    test('a failed closing read throws naming the command, and nothing is marked ready or posted', async () => {
      const seen = []
      const wrap = (run) => async (cmd, args, opts) => { seen.push([cmd, ...args].join(' ')); return run(cmd, args, opts) }
      await assert.rejects(
        pipeline({}, { failures: { [CLOSES(PR)]: 'HTTP 502: bad gateway\nmore' }, wrap }),
        (e) => e.message === `${CLOSES(PR)}: HTTP 502: bad gateway`
      )
      assert.ok(!seen.some((k) => k.startsWith('gh pr ready') || k.includes('Pipeline complete')))
    })

    test('closing read output that is not JSON throws naming the command', async () => {
      await assert.rejects(pipeline({}, { reads: { [CLOSES(PR)]: 'not json' } }), /closingIssuesReferences,number: output is not valid JSON/)
    })

    test('a failed summary comment is an error entry in the wave, not done', async () => {
      const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
      const run = async (cmd, args, opts) =>
        args[1] === 'comment' && String(args[4]).startsWith('Pipeline complete')
          ? { code: 1, stdout: '', stderr: 'HTTP 500: summary failed\nmore' }
          : fake.run(cmd, args, opts)
      const [result] = await driver.runWave([7], { dryRun: false, run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
      assert.equal(result.done, false)
      assert.equal(result.error, 'HTTP 500: summary failed')
      const writes = keysOf(fake.calls, 'write')
      assert.ok(writes.includes(`gh pr ready ${PR}`), 'the writes before the summary happened')
      assert.ok(writes.includes('gh issue edit 7 --remove-label in-progress'))
    })

    test('a failed gh pr ready is an error entry too, with no summary posted', async () => {
      const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
      const run = async (cmd, args, opts) =>
        args[0] === 'pr' && args[1] === 'ready' ? { code: 1, stdout: '', stderr: 'HTTP 403: not allowed' } : fake.run(cmd, args, opts)
      const [result] = await driver.runWave([7], { dryRun: false, run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
      assert.equal(result.done, false)
      assert.equal(result.error, 'HTTP 403: not allowed')
      assert.ok(!keysOf(fake.calls, 'write').some((k) => k.includes('Pipeline complete')))
    })

    test('a dry run reads nothing at ship and logs the writes it skips', async () => {
      const fake = fakeRunner({ reads: {} })
      const logs = []
      const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: (l) => logs.push(l), repoRoot: '/repo' })
      assert.equal(state.done, true)
      assert.deepEqual(fake.calls.filter((c) => c.kind !== 'spawn'), [])
      assert.ok(logs.some((l) => l.includes(`dry run, skipped: gh pr ready ${PR}`)))
      assert.ok(logs.some((l) => l.includes('dry run, skipped: gh issue comment 7 --body Pipeline complete: PR https://github.com/o/r/pull/900')))
    })

    test('the fake runner answers a closing read that has no fixture entry, and a fixture entry wins', async () => {
      const { run } = fakeRunner({ reads: { [CLOSES(PR)]: closing(900, 201) } })
      const answer = async (pr) => JSON.parse((await run('gh', ['pr', 'view', pr, '--json', 'closingIssuesReferences,number'])).stdout)
      assert.deepEqual(await answer('https://github.com/o/r/pull/77'), { number: 77, closingIssuesReferences: [5, 6, 7, 8, 9].map((number) => ({ number })) })
      assert.equal((await answer('12')).number, 12)
      assert.deepEqual(await answer(PR), closing(900, 201))
    })
  })

  // The fix-round loop (issue #604). Every report below comes from the live
  // parser, and every write goes through the fake runner.
  describe('the fix-round loop', () => {
    const PR = 'https://github.com/o/r/pull/900'
    const COMMENT = /^gh pr comment \S+ --body /
    const posted = (calls) => keysOf(calls, 'write').filter((k) => COMMENT.test(k)).map((k) => k.replace(COMMENT, ''))
    const tasks = (calls, role) => calls.filter((c) => c.kind === 'spawn' && c.role === role).map((c) => c.task)
    const FAIL = () => tester('FAIL')
    const PASS = () => tester('PASS')
    const CHANGES = () => reviewer('CHANGES_REQUESTED')
    const APPROVE = () => reviewer('APPROVE')
    // Three tester rounds and three reviewer rounds, one of the tester rounds
    // opened by the re-test that follows a reviewer round.
    const longest = () => ({
      tester: [FAIL(), PASS(), FAIL(), PASS(), FAIL(), PASS(), PASS()],
      reviewer: [CHANGES(), CHANGES(), CHANGES(), APPROVE()],
    })
    const PICKUP = '\n\nThis run picks the package up at this stage. Check the branch and the PR for work an earlier run may have left, and build on it.'

    test('the longest run ships: three tester rounds and three reviewer rounds, a re-test FAIL after a reviewer round among them', async () => {
      const r = await pipeline(longest())
      assert.equal(r.state.parked, null)
      assert.equal(r.state.done, true)
      assert.deepEqual(r.state.fixRounds, { tester: 3, reviewer: 3 })
      assert.deepEqual(roles(r.state), [
        'architect', 'developer', 'tester', 'developer', 'tester',
        'reviewer', 'developer', 'tester', 'developer', 'tester',
        'reviewer', 'developer', 'tester', 'developer', 'tester',
        'reviewer', 'developer', 'tester',
        'reviewer',
      ])
      assert.equal(posted(r.calls).length, 11, 'seven tester reports and four reviewer reports')
      assert.ok(keysOf(r.calls, 'write').includes(`gh pr ready ${PR}`))
    })

    test('a fourth tester FAIL is posted as 4/3 and parks, with no fifth dispatch and no ship', async () => {
      const r = await pipeline({ tester: [FAIL(), FAIL(), FAIL(), FAIL()] })
      assert.equal(r.state.parked, 'tester fix rounds exhausted (3/3)')
      assert.deepEqual(r.state.fixRounds, { tester: 4, reviewer: 0 })
      assert.deepEqual(roles(r.state), [
        'architect', 'developer', 'tester', 'developer', 'tester', 'developer', 'tester', 'developer', 'tester',
      ])
      assert.deepEqual(posted(r.calls).map((b) => b.split('\n')[0]), [1, 2, 3, 4].map(
        (k) => `**Tester report: FAIL (issue #7, tester fix rounds ${k}/3)**`
      ))
      assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
    })

    test('a fourth reviewer CHANGES_REQUESTED is posted as 4/3 and parks', async () => {
      const r = await pipeline({ reviewer: [CHANGES(), CHANGES(), CHANGES(), CHANGES()] })
      assert.equal(r.state.parked, 'reviewer fix rounds exhausted (3/3)')
      assert.deepEqual(r.state.fixRounds, { tester: 0, reviewer: 4 })
      assert.equal(roles(r.state).filter((x) => x === 'developer').length, 4, 'the implement run and three fix rounds')
      assert.equal(roles(r.state).at(-1), 'reviewer')
      const headers = posted(r.calls).map((b) => b.split('\n')[0]).filter((h) => h.startsWith('**Reviewer'))
      assert.equal(headers.at(-1), '**Reviewer report: CHANGES_REQUESTED (issue #7, reviewer fix rounds 4/3)**')
      assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
    })

    test('the old one-round parks are gone: a tester FAIL after a fix round goes to a second round', async () => {
      const r = await pipeline({ tester: [FAIL(), FAIL(), PASS()] })
      assert.equal(r.state.parked, null)
      assert.deepEqual(r.state.fixRounds, { tester: 2, reviewer: 0 })
      assert.equal(r.state.done, true)
    })

    test('a reviewer round whose re-test FAILs counts a tester round and goes through the tester loop', async () => {
      const r = await pipeline({ reviewer: [CHANGES(), APPROVE()], tester: [PASS(), FAIL(), PASS(), PASS()] })
      assert.deepEqual(r.state.fixRounds, { tester: 1, reviewer: 1 })
      assert.deepEqual(roles(r.state), [
        'architect', 'developer', 'tester', 'reviewer', 'developer', 'tester', 'developer', 'tester', 'reviewer',
      ])
      assert.equal(r.state.done, true)
    })

    test('the report comment has the exact header, then the seat\'s own text trimmed and unquoted', async () => {
      const failRaw = 'VERDICT: FAIL\nCOMMIT: abc123\nFINDINGS: 1. one\nUNTESTED CLAIMS: none'
      const passRaw = 'VERDICT: PASS\nCOMMIT: def456\nFINDINGS: none\nUNTESTED CLAIMS: none'
      const approveRaw = 'VERDICT: APPROVE\nSTAGE: both clean\nFINDINGS: none\nCLAIMS: none\nCHECKS: n/a'
      const r = await pipeline({
        tester: [parseReport('tester', `\n${failRaw}\n\n`), parseReport('tester', passRaw)],
        reviewer: parseReport('reviewer', `${approveRaw}\n`),
      })
      assert.deepEqual(keysOf(r.calls, 'write').filter((k) => COMMENT.test(k)), [
        `gh pr comment ${PR} --body **Tester report: FAIL (issue #7, tester fix rounds 1/3)**\n\n${failRaw}`,
        `gh pr comment ${PR} --body **Tester report: PASS (issue #7, tester fix rounds 1/3)**\n\n${passRaw}`,
        `gh pr comment ${PR} --body **Reviewer report: APPROVE (issue #7, reviewer fix rounds 0/3)**\n\n${approveRaw}`,
      ])
    })

    test('a report with no raw text is posted as its verdict, with the findings when it has them', async () => {
      const r = await pipeline({ tester: [{ VERDICT: 'FAIL', FINDINGS: 'one' }, { VERDICT: 'PASS' }], reviewer: { VERDICT: 'APPROVE' } })
      assert.deepEqual(posted(r.calls), [
        '**Tester report: FAIL (issue #7, tester fix rounds 1/3)**\n\nVERDICT: FAIL\nFINDINGS: one',
        '**Tester report: PASS (issue #7, tester fix rounds 1/3)**\n\nVERDICT: PASS',
        '**Reviewer report: APPROVE (issue #7, reviewer fix rounds 0/3)**\n\nVERDICT: APPROVE',
      ])
    })

    test('round trip: every posted report reads back as the stage it leaves and the count its header names', async () => {
      const { resumeStage, countFixRounds } = driver
      const r = await pipeline(longest())
      const bodies = posted(r.calls)
      const comments = bodies.map((body, i) => ({ body, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
      const stageAfter = { PASS: 'reviewer', APPROVE: 'ship', FAIL: 'developer', CHANGES_REQUESTED: 'developer' }
      bodies.forEach((body, i) => {
        const [, verdict, seat, n] = body.split('\n')[0].match(/report: (\w+) \(issue #7, (tester|reviewer) fix rounds (\d)\/3\)\*\*$/)
        const read = resumeStage(comments.slice(0, i + 1))
        assert.equal(read.stage, stageAfter[verdict], `stage after comment ${i + 1}`)
        if (read.findings !== undefined) assert.equal(read.findings, body)
        assert.equal(countFixRounds(comments.slice(0, i + 1))[seat], Number(n), `${seat} count after comment ${i + 1}`)
      })
      assert.deepEqual(countFixRounds(comments), r.state.fixRounds)
    })

    // A seat whose only verdict is in its fenced json block: the parser copies
    // it onto the report, but the text has no VERDICT line for a reader.
    const jsonOnlyTester = (verdict) => parseReport('tester', [
      'COMMIT: abc123', 'FINDINGS: 1. one', 'UNTESTED CLAIMS: none', '', '```json', JSON.stringify({ VERDICT: verdict }), '```',
    ].join('\n'))
    const jsonOnlyReviewer = (verdict) => parseReport('reviewer', [
      'STAGE: both clean', 'FINDINGS: 1. one', 'CLAIMS: none', 'CHECKS: n/a', '', '```json', JSON.stringify({ VERDICT: verdict }), '```',
    ].join('\n'))
    // The text holds a PASS line with a CR, which the parser's key pattern skips and
    // the readers do not, ahead of the FAIL line the parser takes.
    const crThenFailTester = () => parseReport('tester', 'VERDICT: PASS\r\nCOMMIT: abc123\nFINDINGS: 1. one\nVERDICT: FAIL\nUNTESTED CLAIMS: none')
    const stamp = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    const header = (body) => body.split('\n')[0].match(/report: (\w+) \(issue #7, (tester|reviewer) fix rounds (\d)\/3\)\*\*$/)

    // After every post, a fresh read of the comments so far gives the count the
    // header names, and a resumed run from those comments parks as exhausted.
    async function assertReadsBack(r, seat, verdict) {
      const bodies = posted(r.calls).filter((b) => b.startsWith(seat === 'tester' ? '**Tester' : '**Reviewer'))
      const all = posted(r.calls).map((body, i) => ({ body, createdAt: stamp(i) }))
      assert.equal(bodies.length, 4)
      const seen = []
      all.forEach((comment, i) => {
        seen.push(comment)
        const [, v, s, n] = header(comment.body)
        assert.equal(driver.countFixRounds(seen)[s], Number(n), `${s} count after post ${i + 1}`)
        assert.equal(driver.resumeStage(seen).stage, v === 'PASS' ? 'reviewer' : v === 'APPROVE' ? 'ship' : 'developer', `stage after post ${i + 1}`)
      })
      assert.equal(driver.countFixRounds(all)[seat], r.state.fixRounds[seat])
      const { stage, findings } = driver.resumeStage(all)
      assert.equal(stage, 'developer')
      const resume = { stage, findings, branch: 'feat/7-work', pr: 12, fixRounds: driver.countFixRounds(all) }
      const again = await pipeline({}, { resume })
      assert.equal(again.state.parked, `${seat} fix rounds exhausted (3/3)`)
      assert.deepEqual(roles(again.state), [])
    }

    test('a tester FAIL taken from a json block is posted with a VERDICT line, so the cap holds across runs', async () => {
      const report = jsonOnlyTester('FAIL')
      assert.equal(report.VERDICT, 'FAIL', 'the premise: the parser took the verdict from the block')
      assert.ok(!/^VERDICT:/m.test(report.raw), 'the premise: the text has no VERDICT line')
      const r = await pipeline({ tester: [report, jsonOnlyTester('FAIL'), jsonOnlyTester('FAIL'), jsonOnlyTester('FAIL')] })
      assert.equal(r.state.parked, 'tester fix rounds exhausted (3/3)')
      assert.deepEqual(r.state.fixRounds, { tester: 4, reviewer: 0 })
      assert.ok(posted(r.calls)[0].startsWith('**Tester report: FAIL (issue #7, tester fix rounds 1/3)**\n\nVERDICT: FAIL\n\nCOMMIT: abc123'))
      await assertReadsBack(r, 'tester', 'FAIL')
    })

    test('a reviewer CHANGES_REQUESTED taken from a json block is posted with a VERDICT line, so the cap holds across runs', async () => {
      const report = jsonOnlyReviewer('CHANGES_REQUESTED')
      assert.equal(report.VERDICT, 'CHANGES_REQUESTED', 'the premise: the parser took the verdict from the block')
      const r = await pipeline({ reviewer: [report, jsonOnlyReviewer('CHANGES_REQUESTED'), jsonOnlyReviewer('CHANGES_REQUESTED'), jsonOnlyReviewer('CHANGES_REQUESTED')] })
      assert.equal(r.state.parked, 'reviewer fix rounds exhausted (3/3)')
      assert.deepEqual(r.state.fixRounds, { tester: 0, reviewer: 4 })
      assert.ok(posted(r.calls).find((b) => b.startsWith('**Reviewer')).includes('rounds 1/3)**\n\nVERDICT: CHANGES_REQUESTED\n\nSTAGE: both clean'))
      await assertReadsBack(r, 'reviewer', 'CHANGES_REQUESTED')
    })

    test('a PASS and an APPROVE taken from a json block read back as PASS and APPROVE', async () => {
      const r = await pipeline({ tester: jsonOnlyTester('PASS'), reviewer: jsonOnlyReviewer('APPROVE') })
      const comments = posted(r.calls).map((body, i) => ({ body, createdAt: stamp(i) }))
      assert.equal(comments.length, 2)
      assert.deepEqual(driver.resumeStage(comments.slice(0, 1)), { stage: 'reviewer' })
      assert.deepEqual(driver.resumeStage(comments), { stage: 'ship' })
    })

    test('a report whose text holds another verdict word before its own is posted with its own on top', async () => {
      const report = crThenFailTester()
      assert.equal(report.VERDICT, 'FAIL', 'the premise: the parser takes the FAIL line')
      const r = await pipeline({ tester: [crThenFailTester(), crThenFailTester(), crThenFailTester(), crThenFailTester()] })
      assert.ok(posted(r.calls)[0].startsWith('**Tester report: FAIL (issue #7, tester fix rounds 1/3)**\n\nVERDICT: FAIL\n\nVERDICT: PASS\r\n'))
      await assertReadsBack(r, 'tester', 'FAIL')
    })

    test('a report that already reads back as its verdict is posted as it is, with no added line', async () => {
      const r = await pipeline({ tester: [FAIL(), PASS()] })
      assert.ok(posted(r.calls)[0].endsWith('\n\nVERDICT: FAIL\nCOMMIT: abc123\nFINDINGS: 1. one\nUNTESTED CLAIMS: none'))
      assert.equal(posted(r.calls)[0].split('VERDICT:').length, 2)
    })

    test('a report with three findings reaches the developer whole, though the parser keeps only the first line', async () => {
      const report = parseReport('tester', 'VERDICT: FAIL\nCOMMIT: abc123\nFINDINGS: 1. first\n2. second\n3. third\nUNTESTED CLAIMS: none')
      assert.equal(report.FINDINGS, '1. first', 'the premise: the parser drops the other lines')
      const r = await pipeline({ tester: [report, PASS()] })
      const [body] = posted(r.calls)
      assert.ok(body.includes('2. second') && body.includes('3. third'))
      assert.equal(
        tasks(r.calls, 'developer')[1],
        `Issue #7, branch feat/7-pending, tester fix round 1/3: fix exactly these findings:\n${body}`
      )
    })

    test('a reviewer fix round uses the must-fix wording and carries the whole review', async () => {
      const report = parseReport('reviewer', 'VERDICT: CHANGES_REQUESTED\nSTAGE: spec\nFINDINGS: 1. first\n2. second\nCLAIMS: none\nCHECKS: n/a')
      const r = await pipeline({ reviewer: [report, APPROVE()] })
      const body = posted(r.calls).find((b) => b.startsWith('**Reviewer'))
      assert.ok(body.includes('2. second'))
      assert.equal(
        tasks(r.calls, 'developer')[1],
        `Issue #7, branch feat/7-pending, reviewer fix round 1/3: fix exactly the must-fix findings of this review:\n${body}`
      )
    })

    test('every re-test and review prompt names the fix round it follows, and the reviewer gets the latest tester report', async () => {
      const r = await pipeline({ tester: [FAIL(), PASS(), PASS()], reviewer: [CHANGES(), APPROVE()] })
      const bodies = posted(r.calls)
      const claims = (body) => `\n\nUntested claims to rate under CLAIMS, by their number in this tester report:\n${body}`
      const verify = (after) => `Branch feat/7-pending, issue #7: verify the change${after}. Run the full check suite and attack the change.`
      const review = (after) => `PR ${PR}, issue #7: review the diff against the issue and sub-plan${after}. Two passes: spec compliance then code quality.`
      assert.deepEqual(tasks(r.calls, 'tester'), [
        verify(''), verify(' after tester fix round 1/3'), verify(' after reviewer fix round 1/3'),
      ])
      assert.deepEqual(tasks(r.calls, 'reviewer'), [
        review(' after tester fix round 1/3') + claims(bodies[1]),
        review(' after reviewer fix round 1/3') + claims(bodies[3]),
      ])
    })

    test('no (role, task) pair is dispatched twice in the longest run', async () => {
      const r = await pipeline(longest())
      const pairs = r.calls.filter((c) => c.kind === 'spawn').map((c) => `${c.role}\n${c.task}`)
      assert.equal(new Set(pairs).size, pairs.length)
    })

    test('the first seat of a resume gets the pick-up line, and no other seat does', async () => {
      const r = await pipeline({}, { resume: { stage: 'tester', branch: 'feat/7-work', pr: 12 } })
      const [first] = tasks(r.calls, 'tester')
      assert.equal(first, `Branch feat/7-work, issue #7: verify the change. Run the full check suite and attack the change.${PICKUP}`)
      assert.ok(!tasks(r.calls, 'reviewer')[0].includes('picks the package up'))
      const fresh = await pipeline({})
      assert.ok(!fresh.calls.filter((c) => c.kind === 'spawn').some((c) => c.task.includes('picks the package up')))
    })

    test('a resume at the reviewer points the reviewer to the tester comment instead of quoting one', async () => {
      const r = await pipeline({}, { resume: { stage: 'reviewer', branch: 'feat/7-work', pr: 12 } })
      assert.equal(
        tasks(r.calls, 'reviewer')[0],
        'PR 12, issue #7: review the diff against the issue and sub-plan. Two passes: spec compliance then code quality.' +
          `\n\nUntested claims to rate under CLAIMS: take them from the latest tester report comment on PR 12.${PICKUP}`
      )
    })

    describe('on a resume', () => {
      const body = (kind, count) =>
        kind === 'tester'
          ? `**Tester report: FAIL (issue #7, tester fix rounds ${count}/3)**\n\nVERDICT: FAIL\nFINDINGS: 1. a`
          : `**Reviewer report: CHANGES_REQUESTED (issue #7, reviewer fix rounds ${count}/3)**\n\nVERDICT: CHANGES_REQUESTED\nFINDINGS: 1. a`
      const from = (stage, extra) => ({ stage, branch: 'feat/7-work', pr: 12, ...extra })

      test('the count read from the PR is the round of the findings, and a FAIL after it is the 4th and parks', async () => {
        const findings = body('tester', 3)
        const r = await pipeline(
          { developer: { STATUS: 'DONE' }, tester: [FAIL()] },
          { resume: from('developer', { findings, fixRounds: { tester: 3, reviewer: 1 } }) }
        )
        assert.equal(
          tasks(r.calls, 'developer')[0],
          `Issue #7, branch feat/7-work, tester fix round 3/3: fix exactly these findings:\n${findings}${PICKUP}`
        )
        assert.equal(tasks(r.calls, 'tester')[0], 'Branch feat/7-work, issue #7: verify the change after tester fix round 3/3. Run the full check suite and attack the change.')
        assert.deepEqual(r.state.fixRounds, { tester: 4, reviewer: 1 })
        assert.equal(r.state.parked, 'tester fix rounds exhausted (3/3)')
        assert.equal(posted(r.calls)[0].split('\n')[0], '**Tester report: FAIL (issue #7, tester fix rounds 4/3)**')
        assert.ok(!keysOf(r.calls, 'write').some((k) => k.startsWith('gh pr ready')))
      })

      for (const kind of ['tester', 'reviewer']) {
        test(`findings of a ${kind} count already above 3 park before any seat is dispatched`, async () => {
          const r = await pipeline({}, { resume: from('developer', { findings: body(kind, 4), fixRounds: { tester: 4, reviewer: 4 } }) })
          assert.equal(r.state.parked, `${kind} fix rounds exhausted (3/3)`)
          assert.deepEqual(r.calls.filter((c) => c.kind === 'spawn'), [])
        })
      }

      test('reviewer findings use the reviewer count and wording, then the re-test and the re-review', async () => {
        const findings = body('reviewer', 2)
        const r = await pipeline(
          { developer: { STATUS: 'DONE' } },
          { resume: from('developer', { findings, fixRounds: { tester: 0, reviewer: 2 } }) }
        )
        assert.equal(
          tasks(r.calls, 'developer')[0],
          `Issue #7, branch feat/7-work, reviewer fix round 2/3: fix exactly the must-fix findings of this review:\n${findings}${PICKUP}`
        )
        assert.deepEqual(roles(r.state), ['developer', 'tester', 'reviewer'])
        assert.match(tasks(r.calls, 'tester')[0], / verify the change after reviewer fix round 2\/3\./)
        assert.equal(r.state.done, true)
      })

      test('with no count given the round is 1 and the state counts it', async () => {
        const r = await pipeline({ developer: { STATUS: 'DONE' } }, { resume: from('developer', { findings: body('tester', 1) }) })
        assert.match(tasks(r.calls, 'developer')[0], /tester fix round 1\/3: fix exactly/)
        assert.deepEqual(r.state.fixRounds, { tester: 1, reviewer: 0 })
      })

      test('findings with no verdict line are read as tester findings', async () => {
        const r = await pipeline({ developer: { STATUS: 'DONE' } }, { resume: from('developer', { findings: '1. a' }) })
        assert.match(tasks(r.calls, 'developer')[0], /tester fix round 1\/3: fix exactly these findings:\n1\. a/)
      })

      test('a resume at the reviewer starts from the counts of the PR: two reviewer rounds used leaves one', async () => {
        const r = await pipeline(
          { developer: { STATUS: 'DONE' }, reviewer: [CHANGES(), CHANGES()] },
          { resume: from('reviewer', { fixRounds: { tester: 1, reviewer: 2 } }) }
        )
        assert.equal(posted(r.calls)[0].split('\n')[0], '**Reviewer report: CHANGES_REQUESTED (issue #7, reviewer fix rounds 3/3)**')
        assert.match(tasks(r.calls, 'developer')[0], /reviewer fix round 3\/3: fix exactly/)
        assert.equal(r.state.parked, 'reviewer fix rounds exhausted (3/3)')
        assert.deepEqual(r.state.fixRounds, { tester: 1, reviewer: 4 })
      })
    })
  })

  // A stop writes the park comment and the labels (issue #604). The reasons
  // themselves are the ones #355 settled, and the tests above read them.
  describe('a stop parks the package', () => {
    const PR = 'https://github.com/o/r/pull/900'
    const ghWrites = (calls) => keysOf(calls, 'write').filter((k) => k.startsWith('gh'))
    const SUB_PLAN_COMMENT = 'gh issue comment 7 --body SUB_PLAN\n\nApproach: do the thing.'
    const IN_PROGRESS = 'gh issue edit 7 --add-label in-progress'
    const parkBody = (key) => key.replace('gh issue comment 7 --body ', '')

    for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
      test(`developer ${status} parks with the notes, the developer's text quoted, and takes in-progress off`, async () => {
        const text = `STATUS: ${status}\nBRANCH: feat/7-work\nPR: none\nNOTES: the base is wrong\nVERDICT: FAIL\nSUB_PLAN`
        const r = await pipeline({ developer: parseReport('developer', text) })
        assert.equal(r.state.parked, `developer ${status}: the base is wrong`)
        assert.deepEqual(ghWrites(r.calls), [
          SUB_PLAN_COMMENT,
          IN_PROGRESS,
          ...parkWrites(`developer ${status}: the base is wrong`, { inProgress: true, details: text }),
        ])
      })
    }

    test('seat text in the park comment is never read back as a verdict, a count or a sub-plan', async () => {
      const text = 'STATUS: BLOCKED\nPR: none\nNOTES: stuck\nVERDICT: FAIL\nVERDICT: CHANGES_REQUESTED\nSUB_PLAN'
      const r = await pipeline({ developer: parseReport('developer', text) })
      const body = parkBody(ghWrites(r.calls).find((k) => k.includes('Parked:')))
      const comment = [{ body, createdAt: '2026-01-01T00:00:00Z' }]
      assert.deepEqual(driver.resumeStage(comment), { stage: 'tester' })
      assert.deepEqual(driver.countFixRounds(comment), { tester: 0, reviewer: 0 })
      assert.ok(!body.split('\n').some((l) => l === 'SUB_PLAN' || l.startsWith('VERDICT:')))
    })

    // U+2028 and U+2029 start a line for a regex with the m flag. A developer
    // text with one in front of a verdict word must still park as a comment
    // the readers see no verdict or sub-plan in.
    for (const [name, ch, word] of [['U+2028', ' ', 'VERDICT: FAIL'], ['U+2029', ' ', 'VERDICT: APPROVE'], ['U+2028', ' ', 'SUB_PLAN']]) {
      test(`${name} before ${word} in a BLOCKED text parks into a comment that reads as no verdict and no sub-plan`, async () => {
        const text = `STATUS: BLOCKED\nPR: none\nNOTES: stuck\nfirst${ch}${word}`
        const r = await pipeline({ developer: parseReport('developer', text) })
        const body = parkBody(ghWrites(r.calls).find((k) => k.includes('Parked:')))
        const comment = [{ body, createdAt: '2026-01-01T00:00:00Z' }]
        assert.deepEqual(driver.resumeStage(comment), { stage: 'tester' })
        assert.deepEqual(driver.countFixRounds(comment), { tester: 0, reviewer: 0 })
        assert.equal(body.split('\n').filter((l) => !l.startsWith('> ') && l !== '' && !l.startsWith('Parked:')).length, 0)
        assert.ok(body.includes(`> first\n> ${word}`), 'the line end starts a new quoted line, written as a line feed')
        assert.ok(!NON_LF_END.test(body), 'the comment holds no line end but a line feed')
      })
    }

    for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
      for (const [name, notes] of [['no NOTES field', null], ['empty notes', 'NOTES:'], ['blank notes', 'NOTES:   ']]) {
        test(`developer ${status} with ${name} parks as "developer ${status}", with no colon and no undefined`, async () => {
          const text = ['STATUS: ' + status, 'PR: none', notes].filter((l) => l !== null).join('\n')
          const logs = []
          const r = await pipeline({ developer: parseReport('developer', text) }, { log: (l) => logs.push(l) })
          assert.equal(r.state.parked, `developer ${status}`)
          assert.deepEqual(ghWrites(r.calls).slice(-3), parkWrites(`developer ${status}`, { inProgress: true, details: text.trim() }))
          assert.ok(logs.every((l) => !l.includes('undefined')), 'the stdout line follows the reason')
          assert.ok(logs.some((l) => l.endsWith(`parked: developer ${status}`)))
        })
      }
    }

    // A value the parser took from a fenced json block can hold line feeds. The
    // reason line of a park is one line, and the seat's whole text stays quoted below it.
    describe('the park reason is one line', () => {
      const fenced = (head, fields) => `${head}\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``
      const GATE_KEY = 'gh issue view 118 --json body,comments,labels,number,state,stateReason,title'
      const gateSeesSubPlan = async (body) => {
        const copy = JSON.parse(JSON.stringify(loadFixture('gate-rules')))
        copy.reads[GATE_KEY].comments[0].body = body
        const fake = fakeRunner(copy)
        const gh = driver.createGitHub({ run: fake.run, dryRun: false, log: () => {}, cwd: '/repo' })
        const [e] = await driver.runGate([118], gh)
        return e.resume !== undefined
      }

      // The park comment, its readers and the log line, for one seat report.
      async function assertParkedOnOneLine(reports, reason, details, inProgress) {
        const logs = []
        const r = await pipeline(reports, { log: (l) => logs.push(l) })
        assert.equal(r.state.parked, reason)
        assert.ok(!reason.includes('\n'))
        const writes = ghWrites(r.calls)
        assert.deepEqual(writes.slice(inProgress ? -3 : -2), parkWrites(reason, { inProgress, details }))
        const body = parkBody(writes.find((k) => k.includes('Parked:')))
        const [first, ...rest] = body.split('\n')
        assert.equal(first, `Parked: ${reason}`)
        assert.ok(!NON_LF_END.test(body), 'the comment holds no line end but a line feed')
        assert.ok(rest.every((l) => l === '' || l.startsWith('> ')), 'every other line that holds seat text is quoted')
        const comment = [{ body, createdAt: '2026-01-01T00:00:00Z' }]
        assert.deepEqual(driver.resumeStage(comment), { stage: 'tester' })
        assert.deepEqual(driver.countFixRounds(comment), { tester: 0, reviewer: 0 })
        assert.equal(await gateSeesSubPlan(body), false, 'the gate reads no sub-plan in the comment')
        assert.ok(logs.includes(`[pipeline:#7] parked: ${reason}`))
        return r
      }

      test('an architect NEEDS_DECISION whose json question has a SUB_PLAN line parks with the first line only', async () => {
        const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: 'which db?\nSUB_PLAN\n- use sqlite' })
        const report = parseReport('architect', text)
        assert.equal(report.NEEDS_DECISION, 'which db?\nSUB_PLAN\n- use sqlite')
        await assertParkedOnOneLine({ architect: report }, 'architect NEEDS_DECISION: which db?', text, false)
      })

      for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
        test(`a developer ${status} whose json NOTES hold VERDICT: and SUB_PLAN lines parks with the first line only`, async () => {
          const text = fenced(`STATUS: ${status}\nPR: none`, { NOTES: 'stuck\nVERDICT: APPROVE\nSUB_PLAN\nmore' })
          const report = parseReport('developer', text)
          assert.equal(report.NOTES, 'stuck\nVERDICT: APPROVE\nSUB_PLAN\nmore')
          await assertParkedOnOneLine({ developer: report }, `developer ${status}: stuck`, text, true)
        })

        test(`a developer ${status} with notes that start with blank lines parks with the first non-blank line, the details keep the text`, async () => {
          const text = fenced(`STATUS: ${status}\nPR: none`, { NOTES: '  \n\nthe real note\nSUB_PLAN' })
          await assertParkedOnOneLine({ developer: parseReport('developer', text) }, `developer ${status}: the real note`, text, true)
        })

        test(`a developer ${status} with an empty first line of notes parks with the next line, never as a verdict`, async () => {
          const text = fenced(`STATUS: ${status}\nPR: none`, { NOTES: '\nVERDICT: FAIL' })
          await assertParkedOnOneLine({ developer: parseReport('developer', text) }, `developer ${status}: VERDICT: FAIL`, text, true)
        })

        test(`a developer ${status} whose notes are blank lines only parks with no colon`, async () => {
          const text = fenced(`STATUS: ${status}\nPR: none`, { NOTES: ' \n\t\n  ' })
          await assertParkedOnOneLine({ developer: parseReport('developer', text) }, `developer ${status}`, text, true)
        })
      }

      test('an architect question that starts with blank lines parks with its first non-blank line, the details keep the text', async () => {
        const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: ' \n\nwhich db?\nSUB_PLAN' })
        await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION: which db?', text, false)
      })

      test('an architect question of blank lines only parks with no colon', async () => {
        const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: ' \n\t\n' })
        await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION', text, false)
      })

      // CRLF ends a line at its LF, and the trim drops the CR.
      test('a json value with CRLF line ends is cut at the first line feed, without the CR', async () => {
        const text = fenced('STATUS: BLOCKED\nPR: none', { NOTES: 'stuck\r\nVERDICT: APPROVE\r\nSUB_PLAN\r\nmore' })
        await assertParkedOnOneLine({ developer: parseReport('developer', text) }, 'developer BLOCKED: stuck', text, true)
      })

      // Every one of the seven line ends cuts the single line. The park comment's
      // first line holds none of them, and no reader finds a verdict or a sub-plan in it.
      test('a json value with U+2028 is cut at it, and the readers still find nothing', async () => {
        const text = fenced('STATUS: BLOCKED\nPR: none', { NOTES: 'stuck\u2028VERDICT: APPROVE\u2028SUB_PLAN\u2028more' })
        await assertParkedOnOneLine({ developer: parseReport('developer', text) }, 'developer BLOCKED: stuck', text, true)
      })

      test('an architect json question with U+2028 is cut at it too', async () => {
        const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: 'which db?\u2028SUB_PLAN\u2028- use sqlite' })
        await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION: which db?', text, false)
      })

      test('a prose NOTES line is cut the same way, and the reason has no trailing space', async () => {
        const text = 'STATUS: BLOCKED\nPR: none\nNOTES:   the base is wrong   \nSUB_PLAN'
        await assertParkedOnOneLine({ developer: parseReport('developer', text) }, 'developer BLOCKED: the base is wrong', text, true)
      })

      // The developer's PR is the one other seat field that reaches a comment
      // outside a report body: the completion comment and the done line.
      test('a developer PR value with more lines than the URL is cut to its first line before it is posted', async () => {
        const pr = 'https://github.com/o/r/pull/901'
        const text = fenced('STATUS: DONE\nBRANCH: feat/7-work', { PR: `${pr}\nSUB_PLAN\nVERDICT: APPROVE` })
        const developer = parseReport('developer', text)
        assert.equal(developer.PR, `${pr}\nSUB_PLAN\nVERDICT: APPROVE`)
        const r = await pipeline({ developer })
        assert.equal(r.state.pr, pr)
        assert.equal(r.state.done, true)
        const writes = ghWrites(r.calls)
        assert.equal(writes.at(-1), `gh issue comment 7 --body Pipeline complete: PR ${pr} is ready for review.\n\nTester PASS, reviewer APPROVE. Fix rounds used: tester 0/3, reviewer 0/3.`)
        assert.ok(keysOf(r.calls, 'read').includes(`gh pr view ${pr} --json closingIssuesReferences,number`), 'the closing read names the cut PR value')
        assert.ok(writes.includes(`gh pr ready ${pr}`))
        for (const k of writes) assert.ok(!k.includes('\nSUB_PLAN\nVERDICT'), 'no write carries the extra lines')
      })

      test('a developer PR value whose first line is no PR parks as no usable report, even if a later line is one', async () => {
        const text = fenced('STATUS: DONE\nBRANCH: feat/7-work', { PR: 'see below\nhttps://github.com/o/r/pull/901' })
        assertStopped(await pipeline({ developer: parseReport('developer', text) }), 'developer', ['architect', 'developer'])
      })

      // --- The single line is the first non-blank line (issue #604, round 3).
      const AT = { stage: 'developer', branch: 'feat/7-work', pr: 12 }
      const devWith = (fields) => parseReport('developer', fenced('STATUS: DONE\nBRANCH: feat/7-work', fields))
      const URL1 = 'https://github.com/o/r/pull/901'

      for (const [name, value] of [
        ['a line feed, then none', '\nnone'],
        ['two line feeds, then free text', '\n\nsee the PR'],
        ['blank lines, then an issue URL', ' \n\nhttps://github.com/o/r/issues/901'],
        ['only a tilde fence', '~~~'],
      ]) {
        test(`a PR value of ${name} stops the package even when the gate knows a PR`, async () => {
          const r = await pipeline({ developer: devWith({ PR: value }) }, { resume: AT })
          assert.equal(r.state.parked, 'developer seat returned no usable report')
          assert.equal(r.state.done, false)
          assert.deepEqual(roles(r.state), ['developer'])
          assert.ok(!ghWrites(r.calls).some((k) => k.startsWith('gh pr ready')))
        })
      }

      test('a PR value of blank lines only is missing: the gate\'s PR is used on a resume', async () => {
        const r = await pipeline({ developer: devWith({ PR: ' \n\n\t\n  ' }) }, { resume: AT })
        assert.equal(r.state.parked, null)
        assert.equal(r.state.pr, 12)
        assert.equal(r.state.done, true)
      })

      test('a PR value of blank lines only, with no PR known, stops', async () => {
        assertStopped(await pipeline({ developer: devWith({ PR: '\n \n' }) }), 'developer', ['architect', 'developer'])
      })

      for (const [name, value, expected] of [
        ['blank lines, then a pull request URL', `\n \n  ${URL1}  \nmore text`, URL1],
        ['a tilde fence, then a pull request URL', `~~~\n${URL1}\n~~~`, URL1],
        ['a tilde fence with a word, then a number', '~~~text\n\n901', '901'],
      ]) {
        test(`a PR value of ${name} is accepted as that line`, async () => {
          const r = await pipeline({ developer: devWith({ PR: value }) }, { resume: AT })
          assert.equal(r.state.pr, expected)
          assert.equal(r.state.done, true)
        })
      }

      test('notes that start with a tilde fence line park with the first line after it', async () => {
        const text = fenced('STATUS: BLOCKED\nPR: none', { NOTES: '~~~json\nthe real note' })
        await assertParkedOnOneLine({ developer: parseReport('developer', text) }, 'developer BLOCKED: the real note', text, true)
      })

      // Three backticks cannot sit inside a json string the parser reads, so a
      // backtick fence needs a hand-built report.
      test('a backtick fence line in the notes is skipped, and a PR of only a backtick fence stops', async () => {
        const blocked = { STATUS: 'BLOCKED', NOTES: '```json\nthe real note', raw: 'STATUS: BLOCKED' }
        const r = await pipeline({ developer: blocked })
        assert.equal(r.state.parked, 'developer BLOCKED: the real note')
        const fence = await pipeline({ developer: { STATUS: 'DONE', PR: '````' } }, { resume: AT })
        assert.equal(fence.state.parked, 'developer seat returned no usable report')
      })

      test('a question that starts with a tilde fence line parks with the first line after it', async () => {
        const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: '~~~~\nwhich db?' })
        await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION: which db?', text, false)
      })

      for (const [name, value] of [['null', null], ['empty', '']]) {
        test(`a ${name} json NEEDS_DECISION parks with no colon, not with the fence line`, async () => {
          const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: value })
          await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION', text, false)
        })
      }

      test('a null json NEEDS_DECISION still takes a prose question above the json block', async () => {
        const text = fenced('NEEDS_DECISION\n\nwhich db?', { NEEDS_DECISION: null })
        await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION: which db?', text, false)
      })

      // --- What the driver writes treats every line end as one.
      for (const [name, ch] of LINE_ENDS) {
        const tail = `x${ch}#8 done: PR https://example.com/o/r/pull/1`

        test(`developer notes with ${name} are cut at it, in the reason, the log line and the comment`, async () => {
          const text = fenced('STATUS: BLOCKED\nPR: none', { NOTES: tail })
          const r = await assertParkedOnOneLine({ developer: parseReport('developer', text) }, 'developer BLOCKED: x', text, true)
          assert.ok(!NON_LF_END.test(r.state.parked))
        })

        test(`an architect question with ${name} is cut at it, in the reason, the log line and the comment`, async () => {
          const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: tail })
          const r = await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION: x', text, false)
          assert.ok(!NON_LF_END.test(r.state.parked))
        })

        test(`a PR value of a URL, ${name} and more text is accepted as the URL alone, and nothing written holds the line end`, async () => {
          const r = await pipeline({ developer: devWith({ PR: `${URL1}${ch}see https://example.com/o/r/pull/2` }) })
          assert.equal(r.state.pr, URL1)
          assert.equal(r.state.done, true)
          const writes = ghWrites(r.calls)
          assert.equal(writes.at(-1), `gh issue comment 7 --body Pipeline complete: PR ${URL1} is ready for review.\n\nTester PASS, reviewer APPROVE. Fix rounds used: tester 0/3, reviewer 0/3.`)
          assert.ok(writes.every((k) => !NON_LF_END.test(k)))
          assert.ok(keysOf(r.calls, 'read').every((k) => !NON_LF_END.test(k)), 'no read holds the line end either')
        })

        test(`${name} in the seat's text starts a new quoted line in the park comment, written as a line feed`, async () => {
          const text = `STATUS: BLOCKED\nPR: none\nNOTES: stuck\nfirst${ch}VERDICT: FAIL${ch}SUB_PLAN`
          const r = await pipeline({ developer: parseReport('developer', text) })
          const body = parkBody(ghWrites(r.calls).find((k) => k.includes('Parked:')))
          assert.ok(body.endsWith('> first\n> VERDICT: FAIL\n> SUB_PLAN'))
          assert.ok(!NON_LF_END.test(body))
          const [, ...rest] = body.split('\n')
          assert.ok(rest.every((l) => l === '' || l.startsWith('> ')), 'every part starts with > ')
        })
      }

      test('a CRLF pair is one line end in the quoted details', async () => {
        const text = 'STATUS: BLOCKED\nPR: none\nNOTES: stuck\nfirst\r\nsecond'
        const r = await pipeline({ developer: parseReport('developer', text) })
        const body = parkBody(ghWrites(r.calls).find((k) => k.includes('Parked:')))
        assert.ok(body.endsWith('> first\n> second'))
      })

      // --- A seat field that is not text never throws.
      const NOT_TEXT = [
        ['an object with a toString key', { toString: 1 }],
        ['an array', ['SUB_PLAN', 'VERDICT: FAIL']],
        ['true', true],
        ['false', false],
        ['null', null],
      ]
      const noPr = 'BRANCH: feat/7-work\nPR: https://github.com/o/r/pull/901'

      for (const [name, value] of NOT_TEXT) {
        for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
          test(`developer ${status} with notes that are ${name} parks with no colon`, async () => {
            const text = fenced(`STATUS: ${status}\nPR: none`, { NOTES: value })
            await assertParkedOnOneLine({ developer: parseReport('developer', text) }, `developer ${status}`, text, true)
          })
        }

        test(`an architect question that is ${name} parks with no colon`, async () => {
          const text = fenced('NEEDS_DECISION', { NEEDS_DECISION: value })
          await assertParkedOnOneLine({ architect: parseReport('architect', text) }, 'architect NEEDS_DECISION', text, false)
        })

        test(`a developer STATUS that is ${name} is no usable report`, async () => {
          const report = parseReport('developer', fenced(noPr, { STATUS: value }))
          assertStopped(await pipeline({ developer: report }), 'developer', ['architect', 'developer'])
        })

        test(`a tester VERDICT that is ${name} is no usable report`, async () => {
          assertStopped(await pipeline({ tester: parseReport('tester', fenced('COMMIT: abc', { VERDICT: value })) }), 'tester', ALL.slice(0, 3))
        })

        test(`a reviewer VERDICT that is ${name} is no usable report`, async () => {
          assertStopped(await pipeline({ reviewer: parseReport('reviewer', fenced('STAGE: both clean', { VERDICT: value })) }), 'reviewer', ALL)
        })

        test(`a developer PR that is ${name} is no usable report when no PR is known`, async () => {
          assertStopped(await pipeline({ developer: devWith({ PR: value }) }), 'developer', ['architect', 'developer'])
        })

        // json null is a missing PR. An object, an array or a boolean is an invalid one.
        if (value === null) {
          test('a developer PR that is null is missing on a resume: the gate\'s PR is used', async () => {
            const r = await pipeline({ developer: devWith({ PR: value }) }, { resume: AT })
            assert.equal(r.state.pr, 12)
            assert.equal(r.state.done, true)
          })
        } else {
          test(`a developer PR that is ${name} is invalid: it stops the package on a resume, and no completion comment is posted`, async () => {
            const r = await pipeline({ developer: devWith({ PR: value }) }, { resume: AT })
            assert.equal(r.state.parked, 'developer seat returned no usable report')
            assert.equal(r.state.done, false)
            assert.deepEqual(roles(r.state), ['developer'])
            assert.ok(!ghWrites(r.calls).some((k) => k.startsWith('gh pr ready') || k.includes('Pipeline complete')))
          })
        }
      }

      test('a developer PR that is an empty string is missing on a resume: the gate\'s PR is used', async () => {
        const r = await pipeline({ developer: devWith({ PR: '' }) }, { resume: AT })
        assert.equal(r.state.pr, 12)
        assert.equal(r.state.done, true)
      })

      test('a developer PR that is a json number is that PR number, also on a resume with a gate PR', async () => {
        const r = await pipeline({ developer: devWith({ PR: 901 }) }, { resume: AT })
        assert.equal(r.state.pr, '901')
        assert.equal(r.state.done, true)
      })

      test('a json number is read as its digits: notes, a question and a PR', async () => {
        const notes = fenced('STATUS: BLOCKED\nPR: none', { NOTES: 42 })
        await assertParkedOnOneLine({ developer: parseReport('developer', notes) }, 'developer BLOCKED: 42', notes, true)
        const question = fenced('NEEDS_DECISION', { NEEDS_DECISION: 7 })
        await assertParkedOnOneLine({ architect: parseReport('architect', question) }, 'architect NEEDS_DECISION: 7', question, false)
        const r = await pipeline({ developer: devWith({ PR: 901 }) })
        assert.equal(r.state.pr, '901')
        assert.equal(r.state.done, true)
      })

      test('a json number is no status and no verdict', async () => {
        assertStopped(await pipeline({ developer: parseReport('developer', fenced(noPr, { STATUS: 42 })) }), 'developer', ['architect', 'developer'])
        assertStopped(await pipeline({ tester: parseReport('tester', fenced('COMMIT: abc', { VERDICT: 1 })) }), 'tester', ALL.slice(0, 3))
        assertStopped(await pipeline({ reviewer: parseReport('reviewer', fenced('STAGE: x', { VERDICT: 1 })) }), 'reviewer', ALL)
      })

      test('a FINDINGS that is not text does not throw when the report has no raw text', async () => {
        const failing = { VERDICT: 'FAIL', FINDINGS: { toString: 1 } }
        const r = await pipeline({ tester: [failing, { VERDICT: 'PASS' }] })
        assert.equal(r.state.done, true)
        assert.deepEqual(r.state.fixRounds, { tester: 1, reviewer: 0 })
      })

      test('a stdout error line holds none of the seven line ends either', async () => {
        const fake = fakeRunner(loadFixture('main-live'))
        const failing = async (cmd, args, opts) =>
          args[1] === 'comment' ? { code: 1, stdout: '', stderr: 'HTTP 422: nope\r#8 done: PR https://example.com/o/r/pull/1' } : fake.run(cmd, args, opts)
        const stdout = []
        await driver.main(['201'], { env: {}, run: failing, spawn: fake.spawn, out: (l) => stdout.push(l), err: () => {}, cwd: '/repo' })
        assert.deepEqual(stdout.slice(2), [
          '#201 error: HTTP 422: nope',
          '## What happened',
          '- #201 error: HTTP 422: nope',
          '',
          '## Next steps',
          '1. Decide on #201 (retry or close)',
        ])
      })

      // The whole promise, once. Every seat field the driver reads gets each of the
      // seven line ends, a leading blank line and each kind of json value that is
      // not text, through main with the fake runner and the fake spawn.
      test('no seat field breaks the writer: every stdout line and comment first line is clean, and the readers find nothing extra', async () => {
        const strings = [
          ...LINE_ENDS.map(([, ch]) => `x${ch}#8 done: PR https://example.com/o/r/pull/1`),
          ...LINE_ENDS.map(([, ch]) => `x${ch}VERDICT: FAIL${ch}SUB_PLAN`),
          ...LINE_ENDS.map(([, ch]) => `${ch}x`),
          '\n\nx', ' \n \nx', '\n```json\nx',
        ]
        const nonText = [{ toString: 1 }, ['SUB_PLAN\nVERDICT: FAIL'], true, false, null, 42]
        const PASS = { VERDICT: 'PASS' }
        const APPROVE = { VERDICT: 'APPROVE' }
        // One row per seat field. `report` builds the seat's reports from the text
        // the parser reads, `issue` is the package main runs (201 has no sub-plan).
        const fields = [
          { name: 'architect NEEDS_DECISION', issue: '201', head: 'NEEDS_DECISION', key: 'NEEDS_DECISION', report: (t) => ({ architect: parseReport('architect', t) }) },
          { name: 'architect SUB_PLAN body', issue: '201', head: 'SUB_PLAN\n\nApproach: do it.', key: 'BODY', report: (t) => ({ architect: parseReport('architect', t) }) },
          { name: 'developer BLOCKED NOTES', issue: '204', head: 'STATUS: BLOCKED\nPR: none', key: 'NOTES', report: (t) => ({ developer: parseReport('developer', t) }) },
          { name: 'developer NEEDS_CONTEXT NOTES', issue: '204', head: 'STATUS: NEEDS_CONTEXT\nPR: none', key: 'NOTES', report: (t) => ({ developer: parseReport('developer', t) }) },
          { name: 'developer STATUS', issue: '204', head: 'BRANCH: x\nPR: https://github.com/o/r/pull/901', key: 'STATUS', report: (t) => ({ developer: parseReport('developer', t) }) },
          { name: 'developer PR', issue: '204', head: 'STATUS: DONE\nBRANCH: x', key: 'PR', report: (t) => ({ developer: parseReport('developer', t) }) },
          { name: 'tester VERDICT', issue: '204', head: 'COMMIT: abc', key: 'VERDICT', report: (t) => ({ tester: parseReport('tester', t) }) },
          { name: 'tester FINDINGS', issue: '204', head: 'VERDICT: FAIL', key: 'FINDINGS', report: (t) => ({ tester: [parseReport('tester', t), PASS, PASS] }) },
          { name: 'reviewer VERDICT', issue: '204', head: 'STAGE: both clean', key: 'VERDICT', report: (t) => ({ reviewer: parseReport('reviewer', t) }) },
          { name: 'reviewer FINDINGS', issue: '204', head: 'VERDICT: CHANGES_REQUESTED', key: 'FINDINGS', report: (t) => ({ reviewer: [parseReport('reviewer', t), APPROVE, APPROVE] }) },
        ]
        const jsonText = (head, key, value) => (key === 'BODY' ? `${head}\n${value}` : fenced(head, { [key]: value }))
        const proseText = (head, key, value) => (key === 'BODY' ? `${head}\n${value}` : `${head}\n${key}: ${value}`)
        const cases = []
        for (const f of fields) {
          for (const v of strings) {
            cases.push({ f, how: 'json', text: jsonText(f.head, f.key, v) })
            if (f.key !== 'BODY') cases.push({ f, how: 'prose', text: proseText(f.head, f.key, v) })
          }
          if (f.key !== 'BODY') for (const v of nonText) cases.push({ f, how: 'json non-text', text: jsonText(f.head, f.key, v) })
        }

        const verdictStage = { PASS: 'reviewer', APPROVE: 'ship', FAIL: 'developer', CHANGES_REQUESTED: 'developer' }
        for (const { f, how, text } of cases) {
          const label = `${f.name} (${how}): ${JSON.stringify(text)}`
          const fake = fakeRunner(loadFixture('main-live'), f.report(text))
          const stdout = []
          const code = await driver.main([f.issue], { env: {}, run: fake.run, spawn: fake.spawn, out: (l) => stdout.push(l), err: () => {}, cwd: '/repo' })
          assert.equal(code, 0, `no exception escapes: ${label}`)
          assert.ok(stdout.every((l) => !LINE_END.test(l)), `a stdout line holds a line end: ${label}`)
          assert.equal(stdout.filter((l) => l.startsWith('## ')).length, 2, `seat text made a heading on stdout: ${label}`)
          assert.equal(stdout.filter((l) => /^\d+\. /.test(l)).length, 1, `seat text made a next step: ${label}`)
          for (const key of keysOf(fake.calls, 'write')) {
            const m = /^gh (issue|pr) comment (\S+) --body ([\s\S]*)$/.exec(key)
            if (!m) continue
            const [, kind, , body] = m
            assert.ok(!LINE_END.test(body.split('\n')[0]), `a comment first line holds a line end: ${label}`)
            if (kind === 'pr') {
              const verdict = /^\*\*(?:Tester|Reviewer) report: ([A-Z_]+) \(/.exec(body)?.[1]
              assert.ok(verdict in verdictStage, `a posted report names its accepted verdict: ${label}`)
              assert.equal(driver.resumeStage([{ body, createdAt: '2026-01-01T00:00:00Z' }]).stage, verdictStage[verdict], label)
              const counts = driver.countFixRounds([{ body }])
              assert.equal(counts.tester + counts.reviewer, verdict === 'FAIL' || verdict === 'CHANGES_REQUESTED' ? 1 : 0, label)
            } else if (body.startsWith('SUB_PLAN')) {
              assert.equal(body.split('\n')[0], 'SUB_PLAN', label)
            } else {
              assert.ok(!NON_LF_END.test(body), `a park or completion comment holds a line end: ${label}`)
              assert.deepEqual(driver.resumeStage([{ body, createdAt: '2026-01-01T00:00:00Z' }]), { stage: 'tester' }, label)
              assert.equal(await gateSeesSubPlan(body), false, `the gate reads a sub-plan in: ${label}`)
            }
          }
        }
        assert.equal(cases.length, 10 * 24 + 9 * 24 + 9 * 6)
      })
    })

    test('a developer BLOCKED in a tester fix round parks after the FAIL report was posted', async () => {
      const report = parseReport('developer', 'STATUS: BLOCKED\nNOTES: stuck')
      const r = await pipeline({ tester: [tester('FAIL')], developer: [dev('DONE'), report] })
      const w = ghWrites(r.calls)
      assert.ok(w.at(-4).startsWith('gh pr comment https://github.com/o/r/pull/901 --body **Tester report: FAIL (issue #7, tester fix rounds 1/3)**'))
      assert.deepEqual(w.slice(-3), parkWrites('developer BLOCKED: stuck', { inProgress: true, details: 'STATUS: BLOCKED\nNOTES: stuck' }))
    })

    test('the fourth tester FAIL posts its 4/3 report, then parks with the reason alone', async () => {
      const r = await pipeline({ tester: [tester('FAIL'), tester('FAIL'), tester('FAIL'), tester('FAIL')] })
      const w = ghWrites(r.calls)
      assert.ok(w.at(-4).startsWith(`gh pr comment ${PR} --body **Tester report: FAIL (issue #7, tester fix rounds 4/3)**`))
      assert.deepEqual(w.slice(-3), parkWrites('tester fix rounds exhausted (3/3)', { inProgress: true }))
    })

    test('the fourth reviewer CHANGES_REQUESTED posts its 4/3 report, then parks with the reason alone', async () => {
      const changes = () => reviewer('CHANGES_REQUESTED')
      const r = await pipeline({ reviewer: [changes(), changes(), changes(), changes()] })
      const w = ghWrites(r.calls)
      assert.ok(w.at(-4).startsWith(`gh pr comment ${PR} --body **Reviewer report: CHANGES_REQUESTED (issue #7, reviewer fix rounds 4/3)**`))
      assert.deepEqual(w.slice(-3), parkWrites('reviewer fix rounds exhausted (3/3)', { inProgress: true }))
    })

    test('findings of a used-up count park before any seat, and the gate\'s in-progress label comes off', async () => {
      const findings = '**Tester report: FAIL (issue #7, tester fix rounds 4/3)**\n\nVERDICT: FAIL\nFINDINGS: 1. a'
      const resume = { stage: 'developer', branch: 'feat/7-work', pr: 12, findings, fixRounds: { tester: 4, reviewer: 0 } }
      const r = await pipeline({}, { resume, inProgress: true })
      assert.deepEqual(ghWrites(r.calls), parkWrites('tester fix rounds exhausted (3/3)', { inProgress: true }))
    })

    test('a package with no PR to ship parks, and takes in-progress off only when the gate said it had it', async () => {
      const resume = { stage: 'tester', branch: 'feat/7-work' }
      const without = await pipeline({}, { resume })
      assert.deepEqual(ghWrites(without.calls), parkWrites('no PR to mark ready'))
      const withLabel = await pipeline({}, { resume, inProgress: true })
      assert.deepEqual(ghWrites(withLabel.calls), parkWrites('no PR to mark ready', { inProgress: true }))
    })

    test('a dry-run stop calls no runner and names the skipped park writes', async () => {
      const fake = fakeRunner({ reads: {} }, { architect: parseReport('architect', 'NEEDS_DECISION: which?') })
      const logs = []
      const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: (l) => logs.push(l), repoRoot: '/repo' })
      assert.equal(state.parked, 'architect NEEDS_DECISION: which?')
      assert.deepEqual(fake.calls.filter((c) => c.kind !== 'spawn'), [])
      assert.ok(logs.some((l) => l.includes('dry run, skipped: gh issue comment 7 --body Parked: architect NEEDS_DECISION: which?')))
      assert.ok(logs.some((l) => l.includes('dry run, skipped: gh issue edit 7 --add-label needs-human')))
    })
  })

  describe('a dry run keeps its placeholders', () => {
    test('the dry-run stub shapes still complete the pipeline', async () => {
      const fake = fakeRunner({ reads: {} }, {
        architect: { KIND: 'SUB_PLAN', output: 'SUB_PLAN: approach.' },
        developer: { STATUS: 'DONE', PR: 'https://github.com/example/dry-run' },
        tester: { VERDICT: 'PASS' },
        reviewer: { VERDICT: 'APPROVE' },
      })
      const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
      assert.equal(state.done, true)
    })

    for (const [name, value] of [['an object with a toString key', { toString: 1 }], ['an array', ['x']], ['true', true], ['null', null]]) {
      test(`a seat field that is ${name} does not throw, and the placeholders stand in`, async () => {
        const fake = fakeRunner({ reads: {} }, {
          developer: { STATUS: 'DONE', PR: value },
          tester: { VERDICT: value, FINDINGS: value },
          reviewer: { VERDICT: value, FINDINGS: value },
        })
        const state = await runPipeline(7, { dryRun: true, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
        assert.equal(state.done, true)
        assert.equal(state.pr, 'https://github.com/example/repo/pull/7')
      })
    }
  })
})

describe('the error line of a package that threw', () => {
  const { main, runWave, createGitHub } = driver

  async function runMain(argv, { wrap, spawn } = {}) {
    const fake = fakeRunner(loadFixture('main-live'))
    const stdout = []
    const stderr = []
    const code = await main(argv, {
      env: {}, run: wrap ? wrap(fake.run) : fake.run, spawn: spawn || fake.spawn,
      out: (l) => stdout.push(l), err: (l) => stderr.push(l), cwd: '/repo',
    })
    return { code, stdout, stderr, calls: fake.calls }
  }
  const failsSubPlanComment = (stderr) => (run) => async (cmd, args, opts) =>
    cmd === 'gh' && args[1] === 'comment' && args[2] === '201'
      ? { code: 1, stdout: '', stderr }
      : run(cmd, args, opts)

  test('a failed command whose argument holds a newline gives the first line of its stderr', async () => {
    const r = await runMain(['201'], { wrap: failsSubPlanComment('HTTP 422: body is too long\nsecond line') })
    assert.equal(r.code, 1)
    assert.ok(r.calls.some((c) => c.kind === 'spawn' && c.role === 'architect'), 'the sub-plan was written by a real run')
    assert.deepEqual(r.stdout.slice(2), [
      '#201 error: HTTP 422: body is too long',
      '## What happened',
      '- #201 error: HTTP 422: body is too long',
      '',
      '## Next steps',
      '1. Decide on #201 (retry or close)',
    ])
  })

  test('a failed command with an empty stderr falls back to its exit status', async () => {
    const r = await runMain(['201'], { wrap: failsSubPlanComment('') })
    assert.deepEqual(r.stdout.slice(2), [
      '#201 error: exit 1',
      '## What happened',
      '- #201 error: exit 1',
      '',
      '## Next steps',
      '1. Decide on #201 (retry or close)',
    ])
  })

  // JS trim keeps U+0085, so a cut built on trim alone found an empty first piece.
  test('a gh stderr that starts with U+0085 still gives its first non-blank line', async () => {
    const r = await runMain(['201'], { wrap: failsSubPlanComment('\u0085HTTP 422: nope\nsecond line') })
    assert.equal(r.code, 1)
    assert.deepEqual(r.stdout.slice(2), [
      '#201 error: HTTP 422: nope',
      '## What happened',
      '- #201 error: HTTP 422: nope',
      '',
      '## Next steps',
      '1. Decide on #201 (retry or close)',
    ])
  })

  test('an error that is not a failed command gives the first line of its message', async () => {
    const spawn = async () => { throw new Error('seat crashed\nstack detail') }
    const r = await runMain(['201'], { spawn })
    assert.equal(r.code, 1)
    assert.deepEqual(r.stdout.slice(2), [
      '#201 error: seat crashed',
      '## What happened',
      '- #201 error: seat crashed',
      '',
      '## Next steps',
      '1. Decide on #201 (retry or close)',
    ])
  })

  test('runWave carries the same line on the error entry', async () => {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
    const run = async (cmd, args, opts) =>
      args[1] === 'comment' ? { code: 1, stdout: '', stderr: 'HTTP 422: nope\nmore' } : fake.run(cmd, args, opts)
    const [result] = await runWave([9], { dryRun: false, run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
    assert.equal(result.error, 'HTTP 422: nope')
  })

  test('a failed command still names itself in the thrown message, arguments on one line', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: 'HTTP 422: nope\nmore' })
    const gh = createGitHub({ run, dryRun: false, log: () => {}, cwd: '/repo' })
    await assert.rejects(gh.comment(7, 'SUB_PLAN\n\nline two'), (e) => {
      assert.equal(e.message, 'gh issue comment 7 --body SUB_PLAN  line two: HTTP 422: nope')
      return true
    })
  })

  test('a gate-time failure prints one stderr line naming the command, then the first stderr line', async () => {
    const wrap = (run) => async (cmd, args, opts) =>
      args[0] === 'label' ? { code: 1, stdout: '', stderr: 'HTTP 403: no access\nmore' } : run(cmd, args, opts)
    const r = await runMain(['201'], { wrap })
    assert.equal(r.code, 1)
    const line = r.stderr.find((l) => l.startsWith('gh label create'))
    assert.ok(line.endsWith(': HTTP 403: no access'))
    assert.ok(!line.includes('\n'))
  })
})

describe('the resume worktree', () => {
  const { runPipeline, ensureWorktree, worktreePlan, main } = driver
  const WT_ADD_FRESH = 'git worktree add /repo/.worktrees/pkg-7 -b feat/7-pending origin/main'
  const WT_ADD_RESUME = 'git worktree add /repo/.worktrees/pkg-7 -B feat/7-work origin/feat/7-work'

  async function pipeline(opts, worktrees = '') {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': worktrees } })
    await runPipeline(7, {
      dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', ...opts,
    })
    return fake.calls
  }

  test('a resume with a branch fetches it, then adds the worktree on it with -B, before any seat', async () => {
    const calls = await pipeline({ resume: { stage: 'tester', branch: 'feat/7-work', pr: 12 } })
    const writes = keysOf(calls, 'write')
    assert.ok(writes.includes('git fetch origin feat/7-work'))
    assert.ok(writes.includes(WT_ADD_RESUME))
    assert.ok(writes.indexOf('git fetch origin feat/7-work') < writes.indexOf(WT_ADD_RESUME))
    assert.ok(!writes.includes(WT_ADD_FRESH), 'no fresh branch off origin/main')
    const firstSeat = calls.findIndex((c) => c.kind === 'spawn')
    assert.ok(calls.findIndex((c) => c.key === WT_ADD_RESUME) < firstSeat)
  })

  test('a resume with no known branch starts a fresh branch like a first run', async () => {
    const calls = await pipeline({ resume: { stage: 'developer' } })
    assert.ok(keysOf(calls, 'write').includes(WT_ADD_FRESH))
    assert.ok(!keysOf(calls, 'write').some((k) => k.startsWith('git fetch')))
  })

  // The branch comes from the issue title, once, for the worktree and for the developer.
  describe('the branch name', () => {
    const developerTask = (calls) => calls.find((c) => c.kind === 'spawn' && c.role === 'developer').task
    const worktreeBranch = (calls) => keysOf(calls, 'write').find((k) => k.startsWith('git worktree add')).split(' ')[5]

    test('a title with a colon and a hash gives a branch of lowercase words, the same one for the worktree and the developer', async () => {
      const sub = parseReport('architect', 'SUB_PLAN\n\n# Issue #7: Hermes driver, the second half')
      const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } }, { architect: sub })
      await runPipeline(7, {
        dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', title: 'Hermes driver: fix rounds (#7)',
      })
      const branch = worktreeBranch(fake.calls)
      assert.equal(branch, 'feat/7-hermes-driver-fix-rounds-7')
      assert.match(branch, /^feat\/7-[a-z0-9-]+$/)
      assert.ok(developerTask(fake.calls).includes(`branch ${branch}: implement per the sub-plan`))
    })

    test('the sub-plan text no longer has a say in the branch', async () => {
      const a = fakeRunner({ reads: { 'git worktree list --porcelain': '' } }, { architect: parseReport('architect', 'SUB_PLAN\n\nAlpha: one') })
      const b = fakeRunner({ reads: { 'git worktree list --porcelain': '' } }, { architect: parseReport('architect', 'SUB_PLAN\n\nBeta: two') })
      for (const f of [a, b]) {
        await runPipeline(7, { dryRun: false, run: f.run, spawn: f.spawn, log: () => {}, repoRoot: '/repo', title: 'Same title' })
      }
      assert.equal(worktreeBranch(a.calls), 'feat/7-same-title')
      assert.equal(worktreeBranch(b.calls), 'feat/7-same-title')
    })

    test('with no title the branch is feat/<n>-pending in the worktree and in the developer prompt', async () => {
      const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
      await runPipeline(7, { dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' })
      assert.equal(worktreeBranch(fake.calls), 'feat/7-pending')
      assert.ok(developerTask(fake.calls).includes('branch feat/7-pending:'))
    })

    test('a run that starts at the developer names the same branch as the worktree, not an -impl one', async () => {
      const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
      await runPipeline(7, {
        dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', title: 'Fix it', resume: { stage: 'developer' },
      })
      assert.equal(worktreeBranch(fake.calls), 'feat/7-fix-it')
      assert.ok(developerTask(fake.calls).includes('branch feat/7-fix-it:'))
    })

    test('branchType still picks the prefix', async () => {
      const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
      await runPipeline(7, {
        dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo', title: 'Crash on empty', branchType: 'fix',
      })
      assert.equal(worktreeBranch(fake.calls), 'fix/7-crash-on-empty')
    })

    test('the resume branch wins over the title', async () => {
      const calls = await pipeline({ title: 'Other title', resume: { stage: 'developer', branch: 'feat/7-work' } })
      assert.ok(developerTask(calls).includes('branch feat/7-work:'))
      assert.ok(keysOf(calls, 'write').includes(WT_ADD_RESUME))
    })

    test('main passes the issue title: issue 201 is built on feat/201-issue-201-title', async () => {
      const fake = fakeRunner(loadFixture('main-live'))
      await main(['201'], { env: {}, run: fake.run, spawn: fake.spawn, out: () => {}, err: () => {}, cwd: '/repo' })
      assert.ok(keysOf(fake.calls, 'write').includes('git worktree add /repo/.worktrees/pkg-201 -b feat/201-issue-201-title origin/main'))
      assert.ok(developerTask(fake.calls).includes('branch feat/201-issue-201-title:'))
    })

    test('slugOf lowercases, turns every run of other characters into one hyphen, trims and cuts at 40', () => {
      const { slugOf } = driver
      assert.equal(slugOf('Issue #604: Hermes'), 'issue-604-hermes')
      assert.equal(slugOf('Hermes driver: fix-round loop, counters and parking'), 'hermes-driver-fix-round-loop-counters-an')
      assert.equal(slugOf(`${'a'.repeat(39)} b`), 'a'.repeat(39), 'no hyphen is left at the cut')
      assert.equal(slugOf('  --Hello--  '), 'hello')
    })

    test('slugOf gives pending for a missing or empty title and for one with no letters or digits', () => {
      const { slugOf } = driver
      for (const t of [undefined, null, '', '   ', '!!!', '#:']) assert.equal(slugOf(t), 'pending')
    })
  })

  test('a first run does not fetch', async () => {
    const calls = await pipeline({})
    assert.ok(keysOf(calls, 'write').includes(WT_ADD_FRESH))
    assert.ok(!keysOf(calls, 'write').some((k) => k.startsWith('git fetch')))
  })

  test('an existing worktree is left alone: no fetch and no add', async () => {
    const calls = await pipeline(
      { resume: { stage: 'tester', branch: 'feat/7-work', pr: 12 } },
      'worktree /repo/.worktrees/pkg-7\nHEAD abc\nbranch refs/heads/feat/7-work\n'
    )
    assert.ok(!keysOf(calls, 'write').some((k) => k.startsWith('git fetch') || k.startsWith('git worktree add')))
  })

  test('a worktree whose path only starts like ours is not ours: pkg-35 next to pkg-355 is created', async () => {
    const fake = fakeRunner({
      reads: { 'git worktree list --porcelain': 'worktree /repo/.worktrees/pkg-355\nHEAD abc\nbranch refs/heads/feat/355-x\n' },
    })
    const r = await ensureWorktree('/repo', worktreePlan('/repo', 35), 'origin/main', { run: fake.run })
    assert.deepEqual(r, { created: true, path: '/repo/.worktrees/pkg-35' })
    assert.ok(keysOf(fake.calls, 'write').includes('git worktree add /repo/.worktrees/pkg-35 -b feat/35-pending origin/main'))
  })

  test('a path that is the tail of another entry is not ours either', async () => {
    const fake = fakeRunner({
      reads: { 'git worktree list --porcelain': 'worktree /other/repo/.worktrees/pkg-7\nHEAD abc\n\nworktree /repo/.worktrees/pkg-7x\nHEAD def\n' },
    })
    const r = await ensureWorktree('/repo', worktreePlan('/repo', 7), 'origin/main', { run: fake.run })
    assert.equal(r.created, true)
  })

  test('a failed fetch stops the setup and names the command', async () => {
    const fake = fakeRunner({
      reads: { 'git worktree list --porcelain': '' },
      failures: { 'git fetch origin feat/7-work': "fatal: couldn't find remote ref feat/7-work\nmore" },
    })
    await assert.rejects(
      ensureWorktree('/repo', worktreePlan('/repo', 7), 'origin/main', { run: fake.run, resumeBranch: 'feat/7-work' }),
      /^Error: git fetch origin feat\/7-work: fatal: couldn't find remote ref feat\/7-work$/
    )
    assert.ok(!keysOf(fake.calls, 'write').some((k) => k.startsWith('git worktree add')))
  })

  test('main resumes a draft PR on its branch with the verdict findings in the fix prompt', async () => {
    const fake = fakeRunner(loadFixture('main-resume'), { developer: { STATUS: 'DONE' } })
    const code = await main(['301'], {
      env: {}, run: fake.run, spawn: fake.spawn, out: () => {}, err: () => {}, cwd: '/repo',
    })
    assert.equal(code, 0)
    const writes = keysOf(fake.calls, 'write')
    assert.ok(writes.includes('git fetch origin feat/301-work'))
    assert.ok(writes.includes('git worktree add /repo/.worktrees/pkg-301 -B feat/301-work origin/feat/301-work'))
    const task = fake.calls.find((c) => c.kind === 'spawn' && c.role === 'developer').task
    assert.ok(task.includes('fix exactly these findings:\n**Tester report, round 1**'))
    assert.ok(task.includes('FINDINGS: 1. missing test for the cycle case'))
    assert.deepEqual(
      fake.calls.filter((c) => c.kind === 'spawn').map((c) => c.role),
      ['developer', 'tester', 'reviewer']
    )
  })
  test('main resumes a PR at tester fix round 3/3, posts the 4/3 report of the next FAIL and parks the issue', async () => {
    const failRaw = 'VERDICT: FAIL\nCOMMIT: abc123\nFINDINGS: 1. still broken\nUNTESTED CLAIMS: none'
    const fake = fakeRunner(loadFixture('main-resume-rounds'), {
      developer: { STATUS: 'DONE' },
      tester: [parseReport('tester', failRaw)],
    })
    const stdout = []
    const code = await main(['302'], {
      env: {}, run: fake.run, spawn: fake.spawn, out: (l) => stdout.push(l), err: () => {}, cwd: '/repo',
    })
    assert.equal(code, 0)
    assert.deepEqual(keysOf(fake.calls, 'write').slice(6), [
      'git fetch origin feat/302-work',
      'git worktree add /repo/.worktrees/pkg-302 -B feat/302-work origin/feat/302-work',
      'gh issue edit 302 --add-label in-progress',
      `gh pr comment 320 --body **Tester report: FAIL (issue #302, tester fix rounds 4/3)**\n\n${failRaw}`,
      'gh issue comment 302 --body Parked: tester fix rounds exhausted (3/3)',
      'gh issue edit 302 --add-label needs-human',
      'gh issue edit 302 --remove-label in-progress',
    ])
    const task = fake.calls.find((c) => c.kind === 'spawn' && c.role === 'developer').task
    assert.ok(task.startsWith('Issue #302, branch feat/302-work, tester fix round 3/3: fix exactly these findings:\n**Tester report: FAIL (issue #302, tester fix rounds 3/3)**'))
    assert.ok(task.includes('FINDINGS: 1. d\n2. e\n3. f'), 'the whole report, not its first line')
    assert.deepEqual(stdout.slice(2), [
      '#302 parked: tester fix rounds exhausted (3/3)',
      '## What happened',
      '- #302 parked (needs-human): tester fix rounds exhausted (3/3)',
      '',
      '## Next steps',
      '1. Decide on #302 (retry or close)',
    ])
  })

})

describe('the script entry point', () => {
  const script = fileURLToPath(new URL('../../adapters/hermes-pipeline.mjs', import.meta.url))

  test('no arguments exits 2 with the usage line and makes no gh call', () => {
    // A stub gh and git first on PATH record any call. The real ones are out of reach.
    const bin = mkdtempSync(join(tmpdir(), 'hermes-stub-'))
    const marker = join(bin, 'called')
    for (const name of ['gh', 'git']) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 1\n`)
      chmodSync(join(bin, name), 0o755)
    }
    try {
      const r = spawnSync(process.execPath, [script], { env: { PATH: bin }, encoding: 'utf8' })
      assert.equal(r.status, 2)
      assert.ok(r.stderr.includes(driver.USAGE), `stderr: ${r.stderr}`)
      assert.equal(r.stdout, '')
      assert.equal(existsSync(marker), false, 'a gh or git call was made')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('runWave when a package throws', () => {
  test('the other packages still finish and the failure comes back as an error entry', async () => {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
    const run = async (cmd, args, opts) =>
      cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && args[2].endsWith('pkg-5')
        ? { code: 1, stdout: '', stderr: 'fatal: boom\nmore' }
        : fake.run(cmd, args, opts)
    const results = await driver.runWave([5, 6, 7, 8], {
      dryRun: false, run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo',
    })
    assert.deepEqual(results.map((r) => r.issue), [5, 6, 7, 8])
    assert.equal(results[0].error, 'fatal: boom')
    assert.equal(results[0].done, false)
    assert.deepEqual(results.slice(1).map((r) => r.done), [true, true, true], 'the next chunk still starts')
  })
})

describe('runWave with resume', () => {
  test('a package is a number or { issue, resume }', async () => {
    const fake = fakeRunner({ reads: { 'git worktree list --porcelain': '' } })
    const results = await driver.runWave(
      [5, { issue: 6, resume: { stage: 'reviewer', branch: 'feat/6-x', pr: 20 } }],
      { dryRun: false, run: fake.run, spawn: fake.spawn, log: () => {}, repoRoot: '/repo' }
    )
    assert.deepEqual(results.map((r) => r.issue), [5, 6])
    assert.deepEqual(results[1].dispatches.map((d) => d.role), ['reviewer'])
    assert.deepEqual(results[0].dispatches.map((d) => d.role), ['architect', 'developer', 'tester', 'reviewer'])
  })
})
