/**
 * Hermes pipeline driver test (issues #334, #355, #631).
 *
 * The driver follows docs/architecture/light-flow.md: a developer, a reviewer
 * only when the review gate says so, at most 2 fix rounds, then ship.
 *
 * No test calls the real gh, git or hermes. Every command goes through an
 * injected runner and every seat through an injected spawn, both writing to one
 * ordered call log.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const driver = await import('../../adapters/hermes-pipeline.mjs')
const { parseReport } = await import('../../adapters/role-contract-parser.mjs')
const { runPipeline, runWave, runGate, createGitHub, main, needsReview, resumeStage, countFixRounds } = driver

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12'
const PR = 'https://github.com/o/r/pull/900'
const WRITES = ['gh label create', 'gh issue comment', 'gh issue edit', 'gh pr ready', 'gh pr comment', 'gh api -X POST', 'git fetch', 'git worktree add']

const dev = (status = 'DONE', extra = '') => parseReport('developer', `STATUS: ${status}\nPR: ${PR}\nCHECKS: \`npm test\` -> 0\nNOTES: none\n${extra}`)
const rev = (verdict, checks = '`npm test` -> 0') => parseReport('reviewer', `VERDICT: ${verdict}\nFINDINGS: 1. fix the thing\nCHECKS: ${checks}`)
const issue = (number, over = {}) => ({
  number, state: 'OPEN', stateReason: '', title: `Issue ${number}`, body: '## Approach\n- do it', labels: [], comments: [], ...over,
})
const labels = (...names) => names.map((name) => ({ name }))

/** A runner and a spawn that share one call log. `world` is the GitHub state. */
function fake(world = {}, seats = {}) {
  const calls = []
  const w = { issues: {}, prs: [], comments: {}, paths: ['src/a.js'], head: HEAD, closes: [7], heads: [], byLabel: {}, ...world }
  const queues = Object.fromEntries(Object.entries(seats).map(([role, v]) => [role, Array.isArray(v) ? [...v] : v]))
  const ok = (stdout) => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' })
  const run = async (cmd, args, opts = {}) => {
    const key = [cmd, ...args].join(' ')
    if (w.failOn?.test(key)) return { code: 1, stdout: '', stderr: `boom: ${key}\nsecond line` }
    let m
    if ((m = /^gh issue view (\d+) --json/.exec(key))) return ok(w.issues[m[1]])
    if ((m = /^gh issue list --state open --label (\S+) /.exec(key))) return ok((w.byLabel[m[1]] ?? []).map((number) => ({ number })))
    if (key.startsWith('gh pr list')) return ok(w.prs)
    if ((m = /^gh pr view (\S+) --json comments$/.exec(key))) return ok({ comments: w.comments[m[1]] ?? [] })
    if (/^gh pr view \S+ --json closingIssuesReferences,headRefOid,number$/.test(key)) {
      return ok({ number: 900, headRefOid: w.head, closingIssuesReferences: w.closes.map((number) => ({ number })) })
    }
    if (/^gh pr diff \S+ --name-only$/.test(key)) return ok(w.paths.join('\n'))
    if (key === 'git ls-remote --heads origin') return ok(w.heads.map((h) => `1111\t${h}`).join('\n'))
    if (key === 'git worktree list --porcelain') return ok('')
    if (WRITES.some((p) => key.startsWith(p))) {
      calls.push({ kind: 'write', key, cwd: opts.cwd })
      return ok('')
    }
    throw new Error(`no fixture for: ${key}`)
  }
  const spawn = async (role, task, opts = {}) => {
    calls.push({ kind: 'spawn', role, task, cwd: opts.cwd, tier: opts.tier })
    const q = queues[role]
    return Array.isArray(q) ? q.shift() : q
  }
  return { run, spawn, calls }
}
const seatsOf = (calls) => calls.filter((c) => c.kind === 'spawn').map((c) => c.role)
const writesOf = (calls) => calls.filter((c) => c.kind === 'write').map((c) => c.key)
const statusWrite = (calls) => writesOf(calls).find((k) => k.includes('/statuses/'))
const pipe = (n, f, opts = {}) => runPipeline(n, { repoRoot: '/repo', run: f.run, spawn: f.spawn, log: () => {}, dryRun: false, ...opts })

describe('parseArgs', () => {
  const { parseArgs } = driver
  test('issue numbers and labels, in order, duplicates dropped, only the first label: stripped', () => {
    assert.deepEqual(parseArgs(['9', 'label:size:M', '3', '9', 'label:size:M']), { items: [{ issue: 9 }, { label: 'size:M' }, { issue: 3 }] })
  })
  test('no arguments, an empty label and any other word are usage errors', () => {
    for (const argv of [[], ['label:'], ['#355'], ['abc'], ['1,2'], ['--issues']]) assert.ok(parseArgs(argv).error, JSON.stringify(argv))
  })
})

describe('parseBlockers', () => {
  test('only whole lines of the form Blocked by: #N count', () => {
    const body = 'Blocked by: #5\n- Blocked by: #6\n`Blocked by: #7`\nBlocked by: #8\r\nBlocked by: #5'
    assert.deepEqual(driver.parseBlockers(body), [5, 8])
  })
})

describe('planWaves', () => {
  test('wave 1 is every run and resume entry, then waiters whose blockers are placed; the rest wait', () => {
    const e = (issue, outcome, blockers = []) => ({ issue, outcome, blockers })
    const r = driver.planWaves([e(1, 'run'), e(2, 'wait', [1]), e(3, 'resume'), e(4, 'wait', [9]), e(5, 'wait', [2])])
    assert.deepEqual(r.waves, [[1, 3], [2], [5]])
    assert.deepEqual(r.waiting, [{ issue: 4, blockers: [9] }])
  })
})

describe('needsReview', () => {
  const base = { size: 'S', paths: ['src/a.js'], status: 'DONE' }
  test('a plain S change with a clean status needs no reviewer', () => assert.equal(needsReview(base), false))
  test('size M or larger needs one', () => {
    for (const size of ['M', 'size:M', 'size:L']) assert.equal(needsReview({ ...base, size }), true, size)
  })
  test('a risky path needs one, also in a nested manifest', () => {
    for (const p of ['.github/workflows/ci.yml', '.claude/agents/x.md', '.claude/skills/a/SKILL.md', '.claude/workflows/w.js', 'package-lock.json', 'sub/package.json', 'go.sum']) {
      assert.equal(needsReview({ ...base, paths: ['src/a.js', p] }), true, p)
    }
  })
  test('a path that only starts like a risky one does not count', () => {
    assert.equal(needsReview({ ...base, paths: ['.claude/agents-notes.md', 'docs/package.json.md'] }), false)
  })
  test('DONE_WITH_CONCERNS needs one', () => assert.equal(needsReview({ ...base, status: 'DONE_WITH_CONCERNS' }), true))
})

describe('resumeStage and countFixRounds', () => {
  const c = (body, createdAt) => ({ body, createdAt })
  const review = (verdict, at) => c(`**Reviewer report: ${verdict} (issue #7)**\n\nVERDICT: ${verdict}\nFINDINGS: x`, at)

  test('no PR resumes at the developer', () => assert.equal(resumeStage([], { hasPr: false }), 'develop'))
  test('a PR with no review comment goes to the gate', () => {
    assert.equal(resumeStage([], { hasPr: true }), 'gate')
    assert.equal(resumeStage([c('looks fine to me', '1')], { hasPr: true }), 'gate')
  })
  test('the last review decides: CHANGES_REQUESTED is a fix, APPROVE is done', () => {
    assert.equal(resumeStage([review('CHANGES_REQUESTED', '1')], { hasPr: true }), 'fix')
    assert.equal(resumeStage([review('CHANGES_REQUESTED', '1'), review('APPROVE', '2')], { hasPr: true }), 'done')
    assert.equal(resumeStage([review('APPROVE', '2'), review('CHANGES_REQUESTED', '1')], { hasPr: true }), 'done', 'order is by createdAt')
  })
  test('a verdict in a quote or mid-line is not a verdict', () => {
    assert.equal(resumeStage([c('> VERDICT: APPROVE\nsee VERDICT: APPROVE', '1')], { hasPr: true }), 'gate')
  })
  test('countFixRounds counts CHANGES_REQUESTED comments only', () => {
    assert.equal(countFixRounds([review('CHANGES_REQUESTED', '1'), review('APPROVE', '2'), review('CHANGES_REQUESTED', '3'), c('VERDICT: FAIL', '4')]), 2)
    assert.equal(countFixRounds([]), 0)
  })
})

describe('createGitHub', () => {
  test('a read that exits nonzero throws, naming the command and the first stderr line', async () => {
    const f = fake({ failOn: /^gh pr list/ })
    const gh = createGitHub({ run: f.run })
    await assert.rejects(gh.prList(), (e) => e.message === 'gh pr list --state open --limit 100 --json closingIssuesReferences,headRefName,isDraft,number,url: boom: gh pr list --state open --limit 100 --json closingIssuesReferences,headRefName,isDraft,number,url' && e.reason.startsWith('boom'))
  })
  test('a malformed answer is a failed read with a fixed message', async () => {
    const f = fake({ issues: { 5: { number: 5, labels: 'x', comments: [] } } })
    await assert.rejects(createGitHub({ run: f.run }).issueView(5), /^Error: gh issue view returned a malformed answer$/)
  })
  test('under dryRun a write logs one line and never reaches the runner', async () => {
    const f = fake()
    const lines = []
    const gh = createGitHub({ run: f.run, dryRun: true, log: (l) => lines.push(l) })
    await gh.comment(5, 'hi')
    await gh.postStatus(HEAD, 'ok')
    assert.deepEqual(f.calls, [])
    assert.equal(lines.length, 2)
    assert.match(lines[1], /^dry run, skipped: gh api -X POST repos\/\{owner\}\/\{repo\}\/statuses\/abcdef/)
  })
  test('postStatus writes orchestrai/review = success on the given sha', async () => {
    const f = fake()
    await createGitHub({ run: f.run }).postStatus(HEAD, 'not required (size S)')
    assert.deepEqual(writesOf(f.calls), [`gh api -X POST repos/{owner}/{repo}/statuses/${HEAD} -f state=success -f context=orchestrai/review -f description=not required (size S)`])
  })
  test('park writes the reason with the seat text quoted, needs-human on, in-progress off only when set', async () => {
    const f = fake()
    const gh = createGitHub({ run: f.run })
    await gh.park(7, 'because', { inProgress: true, details: 'VERDICT: APPROVE\nSUB_PLAN' })
    assert.deepEqual(writesOf(f.calls), [
      'gh issue comment 7 --body Parked: because\n\n> VERDICT: APPROVE\n> SUB_PLAN',
      'gh issue edit 7 --add-label needs-human',
      'gh issue edit 7 --remove-label in-progress',
    ])
    const g = fake()
    await createGitHub({ run: g.run }).park(7, 'because')
    assert.equal(writesOf(g.calls).length, 2)
  })
  test('LABELS is the flow label set and nothing else', () => {
    assert.deepEqual(driver.LABELS.map((l) => l.name), ['size:S', 'size:M', 'size:L', 'size:XL', 'in-progress', 'needs-human'])
  })
})

describe('the gate', () => {
  async function gate(numbers, world) {
    const f = fake(world)
    return { entries: await runGate(numbers, createGitHub({ run: f.run })), calls: f.calls }
  }
  const one = async (n, world) => (await gate([n], world)).entries[0]
  const pr = (number, over = {}) => ({ number, isDraft: false, headRefName: `feat/${number}-x`, url: 'u', closingIssuesReferences: [{ number: 5 }], ...over })

  test('closed, needs-human, L and XL, unsized: skip, skip, stop, park', async () => {
    const i = (labelsList, over) => issue(5, { labels: labels(...labelsList), ...over })
    assert.equal((await one(5, { issues: { 5: i(['size:S'], { state: 'CLOSED' }) } })).outcome, 'skip')
    assert.match((await one(5, { issues: { 5: i(['size:S', 'needs-human']) } })).detail, /needs-human/)
    for (const size of ['size:L', 'size:XL']) {
      const e = await one(5, { issues: { 5: i([size]) } })
      assert.deepEqual([e.outcome, e.size], ['stop', size])
    }
    const e = await one(5, { issues: { 5: i([]) } })
    assert.deepEqual([e.outcome, e.size], ['park', 'unsized'])
  })

  test('a ready PR is complete (the highest number), and the gate writes nothing', async () => {
    const world = { issues: { 5: issue(5, { labels: labels('size:M', 'in-progress') }) }, prs: [pr(10), pr(12), pr(14, { isDraft: true })] }
    const { entries, calls } = await gate([5], world)
    assert.deepEqual([entries[0].outcome, entries[0].pr], ['complete', 12])
    assert.deepEqual(writesOf(calls), [])
  })

  test('a draft PR resumes: no review goes to the gate, the last verdict to fix or done', async () => {
    const issues = { 5: issue(5, { labels: labels('size:S') }) }
    const prs = [pr(10, { isDraft: true })]
    const at = (comments) => one(5, { issues, prs, comments: { 10: comments } })
    assert.deepEqual((await at([])).resume, { stage: 'gate', branch: 'feat/10-x', pr: 10, fixRounds: 0 })
    const cr = { body: 'VERDICT: CHANGES_REQUESTED\nFINDINGS: 1. x', createdAt: '1' }
    const e = await at([cr])
    assert.deepEqual([e.outcome, e.resume.stage, e.resume.fixRounds, e.resume.findings], ['resume', 'fix', 1, cr.body])
    assert.equal((await at([cr, { body: 'VERDICT: APPROVE', createdAt: '2' }])).resume.stage, 'done')
  })

  test('in-progress with no PR resumes on its remote branch, or runs fresh with none', async () => {
    const issues = { 5: issue(5, { labels: labels('size:S', 'in-progress') }) }
    const e = await one(5, { issues, heads: ['refs/heads/feat/5-x', 'refs/heads/feat/55-y'] })
    assert.deepEqual([e.outcome, e.resume], ['resume', { stage: 'develop', branch: 'feat/5-x' }])
    assert.deepEqual([(await one(5, { issues })).outcome, 'resume' in (await one(5, { issues }))], ['run', false])
  })

  test('a fresh run needs an Approach section in the body or a comment, else it parks', async () => {
    const sized = labels('size:S')
    const none = await one(5, { issues: { 5: issue(5, { labels: sized, body: 'just do it' }) } })
    assert.deepEqual([none.outcome, none.detail], ['park', 'no ## Approach section in the issue or its comments, add one and remove needs-human'])
    const inComment = issue(5, { labels: sized, body: 'x', comments: [{ body: '## Approach\n- a' }] })
    assert.equal((await one(5, { issues: { 5: inComment } })).outcome, 'run')
    assert.equal((await one(5, { issues: { 5: issue(5, { labels: sized }) } })).outcome, 'run')
  })

  test('a blocker that is not closed as completed turns a run into a wait', async () => {
    const issues = {
      5: issue(5, { labels: labels('size:S'), body: '## Approach\n- x\nBlocked by: #6\nBlocked by: #7' }),
      6: issue(6, { state: 'CLOSED', stateReason: 'COMPLETED' }),
      7: issue(7, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    }
    const e = await one(5, { issues })
    assert.deepEqual([e.outcome, e.blockers, e.detail], ['wait', [7], 'blocked by #7'])
  })
})

describe('formatReport', () => {
  const { formatReport } = driver
  const entry = (issue, outcome, extra = {}) => ({ issue, outcome, detail: 'd', title: `T${issue}`, ...extra })
  test('one line per entry, then only the next steps that have members', () => {
    const entries = [entry(1, 'run'), entry(2, 'run'), entry(3, 'run'), entry(4, 'complete', { pr: 40 }), entry(5, 'stop'), entry(6, 'wait'), entry(7, 'skip'), entry(8, 'park')]
    const results = [{ issue: 1, done: true, prNumber: 11 }, { issue: 2, done: false, parked: 'why\nmore' }, { issue: 3, error: 'broke' }]
    assert.deepEqual(formatReport(entries, results), [
      '## What happened',
      '- PR #11 ready  - T1', '- #2 parked (needs-human): why', '- #3 error: broke', '- PR #40 ready  - T4',
      '- #5 stopped: d', '- #6 deferred: d', '- #7 skipped: d', '- #8 parked (needs-human): d',
      '',
      '## Next steps',
      '1. Review & merge: #11, #40', '2. Decide on #2, #3, #8 (retry or close)', '3. Run the driver again to start the next wave',
    ])
  })
  test('with nothing to report the next step is Nothing to do', () => {
    assert.deepEqual(formatReport([], []).slice(-1), ['1. Nothing to do'])
  })
})

describe('runPipeline: the review gate', () => {
  test('S issue, safe paths: the developer only, status "not required (size S)" on the head, PR ready', async () => {
    const f = fake({}, { developer: dev() })
    const r = await pipe(7, f, { size: 'size:S', title: 'Do it' })
    assert.equal(r.done, true)
    assert.deepEqual(seatsOf(f.calls), ['developer'])
    assert.deepEqual(writesOf(f.calls), [
      'git worktree add /repo/.worktrees/pkg-7 -b feat/7-do-it origin/main',
      'gh issue edit 7 --add-label in-progress',
      `gh api -X POST repos/{owner}/{repo}/statuses/${HEAD} -f state=success -f context=orchestrai/review -f description=not required (size S)`,
      `gh pr ready ${PR}`,
      'gh issue edit 7 --remove-label in-progress',
      `gh issue comment 7 --body Pipeline complete: PR ${PR} is ready for review.\n\nReviewer: not required (size S). Fix rounds used: 0/2.`,
    ])
  })

  test('S issue in a dry run: one seat, the status write is logged, nothing is written', async () => {
    const f = fake({}, { developer: dev() })
    const lines = []
    const r = await pipe(7, f, { size: 'size:S', dryRun: true, log: (l) => lines.push(l) })
    assert.equal(r.done, true)
    assert.deepEqual(seatsOf(f.calls), ['developer'])
    assert.deepEqual(writesOf(f.calls), [])
    assert.ok(lines.some((l) => l.includes('statuses/') && l.includes('orchestrai/review') && l.includes('not required (size S)')), lines.join('\n'))
    assert.ok(lines.some((l) => l.includes('gh pr ready')))
  })

  test('a risky path, DONE_WITH_CONCERNS, a failing CHECKS line and size M each bring the reviewer in', async () => {
    const cases = [
      [{ paths: ['src/a.js', '.github/workflows/ci.yml'] }, dev(), 'size:S'],
      [{}, dev('DONE_WITH_CONCERNS'), 'size:S'],
      [{}, parseReport('developer', `STATUS: DONE\nPR: ${PR}\nCHECKS: \`npm test\` -> 1`), 'size:S'],
      [{}, parseReport('developer', `STATUS: DONE\nPR: ${PR}\nNOTES: none`), 'size:S'],
      [{}, dev(), 'size:M'],
    ]
    for (const [world, report, size] of cases) {
      const f = fake(world, { developer: report, reviewer: rev('APPROVE') })
      const r = await pipe(7, f, { size })
      assert.deepEqual([r.done, seatsOf(f.calls)], [true, ['developer', 'reviewer']], JSON.stringify(world) + size)
      assert.match(statusWrite(f.calls), /description=approved by the reviewer$/)
    }
  })

  test('the reviewer runs the judgment tier, the developer the worker tier, both in the package worktree', async () => {
    const f = fake({}, { developer: dev(), reviewer: rev('APPROVE') })
    await pipe(7, f, { size: 'size:M' })
    const seats = f.calls.filter((c) => c.kind === 'spawn')
    assert.deepEqual(seats.map((s) => [s.role, s.tier, s.cwd]), [['developer', 'worker', '/repo/.worktrees/pkg-7'], ['reviewer', 'judgment', '/repo/.worktrees/pkg-7']])
  })

  test('the reviewer comment goes on the PR with a readable VERDICT line', async () => {
    const f = fake({}, { developer: dev(), reviewer: rev('APPROVE') })
    await pipe(7, f, { size: 'size:M' })
    const comment = writesOf(f.calls).find((k) => k.startsWith('gh pr comment'))
    assert.match(comment, new RegExp(`^gh pr comment ${PR.replace(/\//g, '\\/')} --body \\*\\*Reviewer report: APPROVE \\(issue #7\\)\\*\\*\\n\\nVERDICT: APPROVE\\nFINDINGS`))
  })
})

describe('runPipeline: fix rounds', () => {
  test('CHANGES_REQUESTED twice, then APPROVE: three reviews, two fix rounds, shipped', async () => {
    const f = fake({}, { developer: [dev(), dev(), dev()], reviewer: [rev('CHANGES_REQUESTED'), rev('CHANGES_REQUESTED'), rev('APPROVE')] })
    const r = await pipe(7, f, { size: 'size:M' })
    assert.deepEqual(seatsOf(f.calls), ['developer', 'reviewer', 'developer', 'reviewer', 'developer', 'reviewer'])
    assert.deepEqual([r.done, r.parked, r.fixRounds], [true, null, 2])
    const tasks = f.calls.filter((c) => c.role === 'developer').map((c) => c.task)
    assert.match(tasks[1], /fix round 1\/2/)
    assert.match(tasks[2], /fix round 2\/2/)
    assert.match(tasks[1], /VERDICT: CHANGES_REQUESTED\nFINDINGS: 1\. fix the thing/, 'the fix prompt carries the whole review comment')
    assert.match(tasks[1], /pushback: finding <k>/, 'and tells the developer how to dispute a finding')
  })

  test('CHANGES_REQUESTED three times parks the package after the second fix round re-review', async () => {
    const f = fake({}, { developer: [dev(), dev(), dev()], reviewer: [rev('CHANGES_REQUESTED'), rev('CHANGES_REQUESTED'), rev('CHANGES_REQUESTED')] })
    const r = await pipe(7, f, { size: 'size:M' })
    assert.deepEqual(seatsOf(f.calls), ['developer', 'reviewer', 'developer', 'reviewer', 'developer', 'reviewer'])
    assert.equal(r.done, false)
    assert.equal(r.parked, 'fix rounds exhausted (2/2)')
    const w = writesOf(f.calls)
    assert.ok(w.some((k) => k.startsWith('gh issue comment 7 --body Parked: fix rounds exhausted (2/2)')))
    assert.ok(w.includes('gh issue edit 7 --add-label needs-human'))
    assert.ok(w.includes('gh issue edit 7 --remove-label in-progress'))
    assert.equal(statusWrite(f.calls), undefined)
    assert.ok(!w.some((k) => k.startsWith('gh pr ready')))
  })

  test('a developer who disputes a finding parks the package, with the report quoted', async () => {
    const dispute = dev('DONE', 'DEVIATIONS:\n- pushback: finding 1: the helper is used twice')
    const f = fake({}, { developer: [dev(), dispute], reviewer: rev('CHANGES_REQUESTED') })
    const r = await pipe(7, f, { size: 'size:M' })
    assert.deepEqual(seatsOf(f.calls), ['developer', 'reviewer', 'developer'])
    assert.equal(r.parked, 'developer disputes a finding of the review')
    assert.ok(writesOf(f.calls).some((k) => k.includes('> - pushback: finding 1: the helper is used twice')))
  })

  test('the prompt of the pushback rule is not itself read as a dispute', async () => {
    const echoed = dev('DONE', 'NOTES: you said "pushback: finding <k>: <why>" but nothing is wrong')
    const f = fake({}, { developer: [dev(), echoed, dev()], reviewer: [rev('CHANGES_REQUESTED'), rev('APPROVE')] })
    assert.equal((await pipe(7, f, { size: 'size:M' })).done, true)
  })
})

describe('runPipeline: stops', () => {
  const parkedWith = async (seats, opts = {}, world = {}) => {
    const f = fake(world, seats)
    const r = await pipe(7, f, { size: 'size:M', ...opts })
    return { r, f }
  }

  test('developer BLOCKED and NEEDS_CONTEXT park with the notes, and no reviewer runs', async () => {
    for (const status of ['BLOCKED', 'NEEDS_CONTEXT']) {
      const { r, f } = await parkedWith({ developer: parseReport('developer', `STATUS: ${status}\nNOTES: no creds\nmore`) })
      assert.equal(r.parked, `developer ${status}: no creds`)
      assert.deepEqual(seatsOf(f.calls), ['developer'])
    }
  })

  test('a seat with no usable report parks, in a live run', async () => {
    assert.equal((await parkedWith({ developer: { raw: 'garbled' } })).r.parked, 'developer seat returned no usable report')
    assert.equal((await parkedWith({ developer: undefined })).r.parked, 'developer seat returned no usable report')
    assert.equal((await parkedWith({ developer: dev(), reviewer: { VERDICT: 'approve' } })).r.parked, 'reviewer seat returned no usable report')
    assert.equal((await parkedWith({ developer: dev(), reviewer: { VERDICT: ['APPROVE'] } })).r.parked, 'reviewer seat returned no usable report')
  })

  test('a developer PR that is not a pull request parks; no PR at all parks', async () => {
    const bad = parseReport('developer', 'STATUS: DONE\nPR: not-a-pr\nCHECKS: `x` -> 0')
    assert.equal((await parkedWith({ developer: bad })).r.parked, 'developer seat returned no usable report')
    const none = parseReport('developer', 'STATUS: DONE\nCHECKS: `x` -> 0')
    assert.equal((await parkedWith({ developer: none })).r.parked, 'developer seat returned no usable report')
  })

  test('a PR that does not close the issue parks before any status or ready mark', async () => {
    const { r, f } = await parkedWith({ developer: dev(), reviewer: rev('APPROVE') }, {}, { closes: [8] })
    assert.equal(r.parked, 'PR #900 does not close #7')
    assert.deepEqual(writesOf(f.calls).filter((k) => /statuses|pr ready/.test(k)), [])
  })

  test('a failed write throws, so the package is not done', async () => {
    const f = fake({ failOn: /^gh pr ready/ }, { developer: dev() })
    await assert.rejects(pipe(7, f, { size: 'size:S' }), /gh pr ready/)
  })
})

describe('runPipeline: the reviewed head', () => {
  const sha = HEAD.slice(0, 12)

  test('a reviewer CHECKS line that starts with the head sha (full or short) posts on the head', async () => {
    for (const lead of [HEAD, sha]) {
      const f = fake({}, { developer: dev(), reviewer: rev('APPROVE', `${lead} \`npm test\` -> 0`) })
      assert.equal((await pipe(7, f, { size: 'size:M' })).done, true)
      assert.match(statusWrite(f.calls), new RegExp(`statuses/${HEAD} `))
    }
  })

  test('a different sha posts nothing and runs the gate again; the second mismatch parks', async () => {
    const stale = rev('APPROVE', '1111111 `npm test` -> 0')
    const f = fake({}, { developer: dev(), reviewer: [stale, stale] })
    const r = await pipe(7, f, { size: 'size:M' })
    assert.deepEqual(seatsOf(f.calls), ['developer', 'reviewer', 'reviewer'])
    assert.match(r.parked, /^the PR head moved after two reviews/)
    assert.equal(statusWrite(f.calls), undefined)
  })

  test('a stale review followed by a matching one ships on the head', async () => {
    const f = fake({}, { developer: dev(), reviewer: [rev('APPROVE', '1111111 `x` -> 0'), rev('APPROVE', `${sha} \`x\` -> 0`)] })
    const r = await pipe(7, f, { size: 'size:M' })
    assert.deepEqual([r.done, seatsOf(f.calls)], [true, ['developer', 'reviewer', 'reviewer']])
    assert.equal(r.fixRounds, 0, 'a re-review is not a fix round')
  })
})

describe('runPipeline: resume', () => {
  test('a PR with no review comment on an S issue runs the gate, never a developer', async () => {
    const f = fake({}, { reviewer: rev('APPROVE') })
    const r = await pipe(7, f, { size: 'size:S', resume: { stage: 'gate', branch: 'feat/7-x', pr: 10, fixRounds: 0 } })
    assert.deepEqual(seatsOf(f.calls), ['reviewer'])
    assert.equal(r.done, true)
    assert.match(f.calls.find((c) => c.role === 'reviewer').task, /check the branch and the PR for work an earlier run may have left/)
    assert.ok(writesOf(f.calls).includes('git fetch origin feat/7-x'))
  })

  test('a fix resume sends the findings and the count, then re-reviews', async () => {
    const findings = 'VERDICT: CHANGES_REQUESTED\nFINDINGS: 1. a\n2. b'
    const f = fake({}, { developer: dev(), reviewer: rev('APPROVE') })
    const r = await pipe(7, f, { size: 'size:M', resume: { stage: 'fix', branch: 'feat/7-x', pr: 10, fixRounds: 1, findings } })
    assert.deepEqual(seatsOf(f.calls), ['developer', 'reviewer'])
    assert.match(f.calls[0].task, /fix round 1\/2/)
    assert.ok(f.calls[0].task.includes('2. b'))
    assert.equal(r.done, true)
  })

  test('a fix resume whose count is already above the cap parks before any seat', async () => {
    const f = fake({}, {})
    const r = await pipe(7, f, { size: 'size:M', resume: { stage: 'fix', branch: 'b', pr: 10, fixRounds: 3, findings: 'VERDICT: CHANGES_REQUESTED' } })
    assert.deepEqual(seatsOf(f.calls), [])
    assert.equal(r.parked, 'fix rounds exhausted (2/2)')
  })

  test('an APPROVE already on the PR ships with no seat', async () => {
    const f = fake({}, {})
    const r = await pipe(7, f, { size: 'size:M', resume: { stage: 'done', branch: 'b', pr: 10, fixRounds: 0 } })
    assert.deepEqual(seatsOf(f.calls), [])
    assert.deepEqual([r.done, r.pr], [true, 10])
    assert.match(statusWrite(f.calls), /description=approved by the reviewer$/)
  })

  test('a branch with no PR goes back to the developer, who is told to open the PR', async () => {
    const f = fake({}, { developer: dev() })
    await pipe(7, f, { size: 'size:S', resume: { stage: 'develop', branch: 'feat/7-x' } })
    assert.match(f.calls[0].task, /on origin and has no PR/)
  })

  test('a PR the developer does not name falls back to the gate PR', async () => {
    const f = fake({}, { developer: parseReport('developer', 'STATUS: DONE\nCHECKS: `x` -> 0'), reviewer: rev('APPROVE') })
    const r = await pipe(7, f, { size: 'size:M', resume: { stage: 'fix', branch: 'b', pr: 10, fixRounds: 1, findings: 'VERDICT: CHANGES_REQUESTED' } })
    assert.equal(r.pr, 10)
  })
})

describe('runPipeline: dry run with the adapter placeholders', () => {
  test('a dry run completes through the adapter dry-run seats and writes nothing', async () => {
    process.env.DRY_RUN = 'true'
    try {
      const f = fake()
      const r = await runPipeline(42, { dryRun: true, size: 'size:M', run: f.run, log: () => {} })
      assert.deepEqual([r.done, r.parked, r.reviewerVerdict], [true, null, 'APPROVE'])
      assert.deepEqual(writesOf(f.calls), [])
    } finally {
      delete process.env.DRY_RUN
    }
  })
})

describe('runWave', () => {
  test('runs every package, at most 3 at once', async () => {
    let running = 0
    let peak = 0
    const spawn = async () => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return dev()
    }
    const f = fake()
    const results = await runWave([1, 2, 3, 4, 5].map((issue) => ({ issue, size: 'size:S' })), { dryRun: true, run: f.run, spawn, log: () => {} })
    assert.equal(results.length, 5)
    assert.ok(results.every((r) => r.done))
    assert.equal(peak, 3)
  })

  test('a package that throws gets an error entry and the others still finish', async () => {
    const f = fake({ failOn: /^gh issue edit 2 --add-label/ }, { developer: dev() })
    const results = await runWave([{ issue: 1, size: 'size:S' }, { issue: 2, size: 'size:S' }], { repoRoot: '/repo', run: f.run, spawn: f.spawn, log: () => {} })
    assert.equal(results[0].done, true)
    assert.deepEqual([results[1].issue, results[1].done, results[1].parked], [2, false, null])
    assert.match(results[1].error, /^boom: gh issue edit 2/)
  })
})

describe('main', () => {
  async function runMain(argv, world, seats, env = {}) {
    const f = fake(world, seats)
    const out = []
    const err = []
    const code = await main(argv, { env, run: f.run, spawn: f.spawn, out: (l) => out.push(l), err: (l) => err.push(l), cwd: '/repo' })
    return { code, out, err, calls: f.calls }
  }
  const world = {
    issues: {
      1: issue(1, { labels: labels('size:S') }),
      2: issue(2, { labels: labels('size:M'), body: '## Approach\n- x\nBlocked by: #1' }),
      3: issue(3),
      4: issue(4, { labels: labels('size:L') }),
    },
    byLabel: { 'size:S': [1] },
  }

  test('a usage error exits 2 with the usage line and makes no call', async () => {
    const r = await runMain(['abc'], world, {})
    assert.deepEqual([r.code, r.out, r.calls], [2, [], []])
    assert.ok(r.err.includes(driver.USAGE))
  })

  test('a dry run prints the gate and the wave plan, writes nothing and starts no seat', async () => {
    const r = await runMain(['label:size:S', '2', '3', '4'], world, {}, { DRY_RUN: 'true' })
    assert.equal(r.code, 0)
    assert.deepEqual(r.out, [
      '#1 size:S run: no PR yet, starting at the developer',
      '#2 size:M wait: blocked by #1',
      '#3 unsized park: no size label, not guessing a size',
      '#4 size:L stop: size:L, split it first',
      'wave 1: #1',
      'waiting: #2 (blocked by #1)',
    ])
    assert.deepEqual(r.calls, [])
    assert.ok(r.err.some((l) => l.includes('gh issue comment 3 --body Parked: ')))
  })

  test('a live run creates the labels, parks the unsized issue, runs wave 1 and prints results and the report', async () => {
    const r = await runMain(['1', '3'], world, { developer: dev() })
    assert.equal(r.code, 0)
    const w = writesOf(r.calls)
    assert.equal(w.filter((k) => k.startsWith('gh label create')).length, 6)
    assert.ok(w.includes('gh issue edit 3 --add-label needs-human'))
    assert.deepEqual(r.out.slice(0, 3), ['#1 size:S run: no PR yet, starting at the developer', '#3 unsized park: no size label, not guessing a size', 'wave 1: #1'])
    assert.equal(r.out[3], `#1 done: PR ${PR}`)
    assert.deepEqual(r.out.slice(4, 6), ['## What happened', '- PR #900 ready  - Issue 1'])
  })

  test('a failed read at the gate exits 1 with one line on stderr and no gate lines', async () => {
    const r = await runMain(['1'], { ...world, failOn: /^gh issue view/ }, {})
    assert.deepEqual([r.code, r.out], [1, []])
    assert.equal(r.err.length, 1)
    assert.match(r.err[0], /^boom: /)
  })

  test('a package that throws exits 1 and its line reads error', async () => {
    const r = await runMain(['1'], { ...world, failOn: /^gh issue edit 1 --add-label in-progress/ }, { developer: dev() })
    assert.equal(r.code, 1)
    assert.ok(r.out.some((l) => l.startsWith('#1 error: boom')))
  })
})

describe('the script entry point', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'adapters', 'hermes-pipeline.mjs')

  test('no arguments exits 2 with the usage line and makes no gh or git call', () => {
    const bin = mkdtempSync(join(tmpdir(), 'hermes-stub-'))
    for (const name of ['gh', 'git']) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${bin}/called"\nexit 1\n`)
      chmodSync(join(bin, name), 0o755)
    }
    try {
      const r = spawnSync(process.execPath, [script], { env: { PATH: bin }, encoding: 'utf8' })
      assert.deepEqual([r.status, r.stdout], [2, ''])
      assert.ok(r.stderr.includes(driver.USAGE), r.stderr)
      assert.equal(spawnSync('test', ['-e', `${bin}/called`]).status, 1, 'a gh or git call was made')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
