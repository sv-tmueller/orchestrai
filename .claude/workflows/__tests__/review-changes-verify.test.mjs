/**
 * tm-review-changes verify stage, end to end against a stubbed runtime
 * (issue #406).
 *
 * Runs the real workflow script in node:vm with stub agent/parallel/phase/log
 * globals. Reviewers, verifiers and the critic are driven by per-test
 * callbacks, so the tests pin what the script does with their output: refuted
 * findings leave mustFix, findings past the cap and findings with a dead
 * verifier are reported as unverified (never refuted), and an empty must-fix
 * set skips the verify stage.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dir, '..', 'tm-review-changes.js'), 'utf8')

const mf = (file, problem, severity = 'must-fix') => ({ file, line: '1', severity, problem, fix: 'fix' })

// reviewerFindings: label -> findings array. verifier: finding -> verdict | null.
// critic: prompt -> report.
async function runWorkflow({ args = {}, reviewerFindings = () => [], verifier = () => ({ confirmed: true, note: 'ok' }), critic }) {
  const agents = []
  const logs = []
  const runtime = {
    agent: async (prompt, opts) => {
      agents.push({ prompt, opts })
      if (opts.label.startsWith('review:')) return { findings: reviewerFindings(opts.label) }
      if (opts.label.startsWith('verify:')) {
        const finding = JSON.parse(prompt.slice(prompt.indexOf('Finding (JSON):\n') + 'Finding (JSON):\n'.length).split('\n\nReturn confirmed')[0])
        return verifier(finding)
      }
      return critic(prompt)
    },
    parallel: (thunks) => Promise.all(thunks.map((t) => t())),
    phase: () => {},
    log: (m) => logs.push(m),
    args,
  }
  const body = src.replace(/^\s*import\s+.*$/gm, '').replace(/export\s+const\s+/g, 'const ')
  const ctx = createContext({ ...runtime, Promise, JSON, Math, Number, String, Boolean, Array, Object, RegExp, Error, Set })
  const raw = await runInContext(`(async () => {\n${body}\n})`, ctx)()
  // JSON round trip moves the report out of the vm realm so deepEqual works.
  return { report: JSON.parse(JSON.stringify(raw)), agents, logs }
}

const criticEcho = (mustFix) => () => ({ verdict: 'changes-requested', summary: 's', mustFix, shouldFix: [], nits: [] })

describe('tm-review-changes verify stage', () => {
  test('a refuted finding is absent from mustFix and present in refuted with the verifier note', async () => {
    const keep = mf('a.js', 'real')
    const stale = mf('b.js', 'stale')
    const { report } = await runWorkflow({
      // Only the bugs reviewer reports, so there is no cross-reviewer dedup noise.
      reviewerFindings: (label) => (label === 'review:bugs' ? [keep, stale] : []),
      verifier: (f) => (f.problem === 'stale' ? { confirmed: false, note: 'already fixed' } : { confirmed: true, note: 'reproduced' }),
      // The critic ignores the refuted group and keeps both, as a careless model might.
      critic: criticEcho([keep, stale]),
    })
    assert.deepEqual(report.mustFix.map((f) => f.problem), ['real'])
    assert.equal(report.refuted.length, 1)
    assert.equal(report.refuted[0].problem, 'stale')
    assert.equal(report.refuted[0].note, 'already fixed')
    assert.deepEqual(report.unverified, [])
  })

  test('the critic prompt gets confirmed and refuted findings as separate groups', async () => {
    const { agents } = await runWorkflow({
      reviewerFindings: (label) => (label === 'review:bugs' ? [mf('a.js', 'real-one'), mf('b.js', 'stale-one'), mf('c.js', 'a-nit', 'nit')] : []),
      verifier: (f) => ({ confirmed: f.problem === 'real-one', note: 'n' }),
      critic: criticEcho([]),
    })
    const prompt = agents.find((a) => a.opts.label === 'consolidate').prompt
    const confirmedSection = prompt.split('Confirmed must-fix findings (JSON):')[1].split('Refuted must-fix findings')[0]
    const refutedSection = prompt.split('Refuted must-fix findings (JSON, with the verifier note):')[1].split('Unverified must-fix findings')[0]
    const rawSection = prompt.split('Raw should-fix and nit findings (JSON):')[1]
    assert.ok(confirmedSection.includes('real-one') && !confirmedSection.includes('stale-one'))
    assert.ok(refutedSection.includes('stale-one') && !refutedSection.includes('real-one'))
    assert.ok(rawSection.includes('a-nit'), 'should-fix and nit findings stay in the raw group')
    assert.ok(!rawSection.includes('real-one'), 'must-fix findings are not in the raw group')
  })

  test('must-fix findings past the cap are reported as unverified, not dropped', async () => {
    const findings = [mf('a.js', 'one'), mf('b.js', 'two'), mf('c.js', 'three')]
    const { report, agents } = await runWorkflow({
      args: { maxVerify: 1 },
      reviewerFindings: (label) => (label === 'review:bugs' ? findings : []),
      critic: criticEcho(findings),
    })
    assert.equal(agents.filter((a) => a.opts.label.startsWith('verify:')).length, 1)
    assert.deepEqual(report.unverified.map((f) => f.problem), ['two', 'three'])
    assert.deepEqual(report.refuted, [])
    const prompt = agents.find((a) => a.opts.label === 'consolidate').prompt
    assert.match(prompt, /2 must-fix finding\(s\) were past the verify cap of 1/)
    assert.ok(prompt.split('Unverified must-fix findings (JSON):')[1].includes('three'))
    assert.equal(report.mustFix.length, 3, 'unverified findings stay in the critic-judged mustFix')
  })

  test('a dead verifier leaves the finding unverified, never refuted', async () => {
    const f1 = mf('a.js', 'one')
    const f2 = mf('b.js', 'two')
    const { report, agents } = await runWorkflow({
      reviewerFindings: (label) => (label === 'review:bugs' ? [f1, f2] : []),
      verifier: (f) => (f.problem === 'one' ? null : { confirmed: true, note: 'ok' }),
      critic: criticEcho([f1, f2]),
    })
    assert.deepEqual(report.refuted, [])
    assert.deepEqual(report.unverified.map((f) => f.problem), ['one'])
    assert.deepEqual(report.mustFix.map((f) => f.problem), ['one', 'two'])
    assert.match(agents.find((a) => a.opts.label === 'consolidate').prompt, /1 verifier\(s\) returned nothing/)
  })

  test('a verdict with no boolean confirmed is unverified, not refuted', async () => {
    const f1 = mf('a.js', 'one')
    const { report } = await runWorkflow({
      reviewerFindings: (label) => (label === 'review:bugs' ? [f1] : []),
      verifier: () => ({ note: 'malformed' }),
      critic: criticEcho([f1]),
    })
    assert.deepEqual(report.refuted, [])
    assert.deepEqual(report.unverified.map((f) => f.problem), ['one'])
  })

  test('with no must-fix findings the verify stage is skipped and logged', async () => {
    const { report, agents, logs } = await runWorkflow({
      reviewerFindings: (label) => (label === 'review:bugs' ? [mf('a.js', 'just-a-nit', 'nit')] : []),
      critic: () => ({ verdict: 'approve', summary: 's', mustFix: [], shouldFix: [], nits: [] }),
    })
    assert.equal(agents.filter((a) => a.opts.label.startsWith('verify:')).length, 0)
    assert.ok(logs.some((m) => m.includes('skipping the verify stage')))
    assert.deepEqual(report.refuted, [])
    assert.deepEqual(report.unverified, [])
  })

  test('identical must-fix findings from several reviewers get one verifier', async () => {
    const dup = mf('a.js', 'same')
    const { agents } = await runWorkflow({
      reviewerFindings: () => [dup],
      critic: criticEcho([dup]),
    })
    assert.equal(agents.filter((a) => a.opts.label.startsWith('verify:')).length, 1)
  })
})
