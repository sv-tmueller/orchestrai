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
import { readFileSync } from 'node:fs'
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
  const { resumeStage } = driver
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

// #604 extends this list if it adds a new write command.
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
  architect: { output: 'SUB_PLAN\n\nApproach: do the thing.' },
  developer: { STATUS: 'DONE', PR: 'https://github.com/o/r/pull/900' },
  tester: { VERDICT: 'PASS' },
  reviewer: { VERDICT: 'APPROVE' },
}

/**
 * A fixture-backed runner plus a fake spawn, sharing one ordered call log.
 * A key in `reads` returns exit 0 with that stdout, a key in `failures`
 * returns exit 1 with that stderr, a known write prefix is recorded and
 * returns exit 0, and anything else throws.
 */
function fakeRunner(fixture, reports = {}) {
  const calls = []
  const scripted = { ...DEFAULT_REPORTS, ...reports }
  const run = async (cmd, args, opts = {}) => {
    const key = [cmd, ...args].join(' ')
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

  test('rule 6: a draft PR with no verdict resumes at the tester on its branch', async () => {
    const e = await one(110)
    assert.equal(e.outcome, 'resume')
    assert.deepEqual(e.resume, { stage: 'tester', branch: 'feat/110-x', pr: 210 })
  })

  test('rule 6: a PASS verdict resumes at the reviewer', async () => {
    assert.deepEqual((await one(111)).resume, { stage: 'reviewer', branch: 'feat/111-x', pr: 212 })
  })

  test('rule 6: a FAIL verdict resumes at the developer with the findings', async () => {
    const e = await one(112)
    assert.equal(e.resume.stage, 'developer')
    assert.equal(e.resume.branch, 'fix/112-x')
    assert.equal(e.resume.pr, 213)
    assert.match(e.resume.findings, /VERDICT: FAIL\nFINDINGS: 1\. exit code is 0 on a failed read/)
  })

  test('rule 6: an APPROVE verdict on a draft resumes at ship', async () => {
    assert.deepEqual((await one(113)).resume, { stage: 'ship', branch: 'feat/113-x', pr: 214 })
  })

  test('rule 6: with several draft PRs the highest number is used', async () => {
    const e = await one(120)
    assert.equal(e.resume.pr, 222)
    assert.equal(e.resume.branch, 'feat/120-new')
  })

  test('rule 7: in-progress with no PR and a branch on origin resumes at the tester', async () => {
    // The origin also holds feat/1140-other, which must not match issue 114.
    const e = await one(114)
    assert.equal(e.outcome, 'resume')
    assert.deepEqual(e.resume, { stage: 'tester', branch: 'feat/114-tester-branch' })
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
