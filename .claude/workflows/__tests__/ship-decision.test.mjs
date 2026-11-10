/**
 * Tests for the step 7 ship decision (issue #474).
 *
 * At the end of a package the lead reads the PR head and the repo's auto
 * merge setup, then runs `ship-decision.mjs` to learn which verdict statuses
 * to post and whether to queue the merge. The script makes no gh calls, so
 * these tests need no network: they call `decide` and spawn the CLI.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

import { decide } from '../../skills/tm-kickoff/ship-decision.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'ship-decision.mjs')

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

// A set-up repo, full track, tester PASS on the head, review not a fallback.
const BASE = {
  track: 'full',
  verdictCommit: SHA,
  head: SHA,
  fallbackReview: false,
  autoMerge: true,
  branchProtected: true,
  branchRules: 0,
}

function byContext(result, context) {
  return result.statuses.find((s) => s.context === context)
}

function cliArgs(input) {
  return [
    '--track', input.track,
    '--verdict-commit', input.verdictCommit,
    '--head', input.head,
    '--fallback-review', String(input.fallbackReview),
    '--auto-merge', String(input.autoMerge),
    '--branch-protected', String(input.branchProtected),
    '--branch-rules', String(input.branchRules),
  ]
}

function run(...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
}

describe('decide: the five acceptance cases', () => {
  test('full track pass on a set-up repo posts both successes and queues', () => {
    const r = decide(BASE)
    assert.equal(r.sha, SHA)
    assert.equal(r.queue, true)
    assert.equal(r.reason, 'queued')
    assert.equal(byContext(r, 'orchestrai/test').state, 'success')
    assert.match(byContext(r, 'orchestrai/test').description, /Tester PASS/)
    assert.equal(byContext(r, 'orchestrai/review').state, 'success')
    assert.equal(r.statuses.length, 2)
  })

  test('lean track marks the test status skipped (lean) and still queues', () => {
    const r = decide({ ...BASE, track: 'lean' })
    assert.equal(byContext(r, 'orchestrai/test').state, 'success')
    assert.match(byContext(r, 'orchestrai/test').description, /skipped \(lean\)/)
    assert.equal(r.queue, true)
    assert.equal(r.reason, 'queued')
  })

  test('fallback review posts a pending review owed status and does not queue', () => {
    const r = decide({ ...BASE, fallbackReview: true })
    assert.equal(byContext(r, 'orchestrai/review').state, 'pending')
    assert.match(byContext(r, 'orchestrai/review').description, /review owed/)
    assert.equal(byContext(r, 'orchestrai/test').state, 'success')
    assert.equal(r.queue, false)
    assert.equal(r.reason, 'review-owed')
  })

  test('repo not set up posts statuses but does not queue', () => {
    const r = decide({ ...BASE, autoMerge: false, branchProtected: false, branchRules: 0 })
    assert.equal(r.statuses.length, 2)
    assert.equal(byContext(r, 'orchestrai/review').state, 'success')
    assert.equal(r.queue, false)
    assert.equal(r.reason, 'not-set-up')
  })

  test('commit moved posts nothing and does not queue', () => {
    const r = decide({ ...BASE, verdictCommit: OTHER })
    assert.deepEqual(r.statuses, [])
    assert.equal(r.queue, false)
    assert.equal(r.reason, 'head-moved')
  })
})

describe('decide: edge cases', () => {
  test('a read that failed (unknown) counts as not set up', () => {
    for (const patch of [
      { autoMerge: 'unknown' },
      { branchProtected: 'unknown', branchRules: 'unknown' },
      { branchProtected: false, branchRules: 'unknown' },
    ]) {
      const r = decide({ ...BASE, ...patch })
      assert.equal(r.queue, false)
      assert.equal(r.reason, 'set-up-unknown')
      assert.equal(r.statuses.length, 2)
    }
  })

  test('unknown protection is set up when rulesets alone protect the branch', () => {
    const r = decide({ ...BASE, branchProtected: 'unknown', branchRules: 2 })
    assert.equal(r.queue, true)
    assert.equal(r.reason, 'queued')
  })

  test('protection from rulesets only counts as set up', () => {
    const r = decide({ ...BASE, branchProtected: false, branchRules: 1 })
    assert.equal(r.queue, true)
    assert.equal(r.reason, 'queued')
  })

  test('auto merge on but no protection of either kind is not set up', () => {
    const r = decide({ ...BASE, branchProtected: false, branchRules: 0 })
    assert.equal(r.queue, false)
    assert.equal(r.reason, 'not-set-up')
  })

  test('auto merge off is not set up even when protection reads fail', () => {
    const r = decide({
      ...BASE, autoMerge: false, branchProtected: 'unknown', branchRules: 'unknown',
    })
    assert.equal(r.reason, 'not-set-up')
  })

  test('lean track with a fallback review keeps both lean and owed wording', () => {
    const r = decide({ ...BASE, track: 'lean', fallbackReview: true })
    assert.match(byContext(r, 'orchestrai/test').description, /skipped \(lean\)/)
    assert.equal(byContext(r, 'orchestrai/review').state, 'pending')
    assert.equal(r.queue, false)
    assert.equal(r.reason, 'review-owed')
  })

  test('a verdict commit that is not a SHA counts as moved', () => {
    for (const verdictCommit of ['none', '', 'abc1234', 'z'.repeat(40)]) {
      const r = decide({ ...BASE, verdictCommit })
      assert.deepEqual(r.statuses, [])
      assert.equal(r.reason, 'head-moved')
    }
  })

  test('SHA comparison ignores case and the result carries the head', () => {
    const r = decide({ ...BASE, verdictCommit: SHA.toUpperCase() })
    assert.equal(r.reason, 'queued')
    assert.equal(r.sha, SHA)
  })

  test('a fallback review on a repo that is not set up still reports review owed', () => {
    const r = decide({ ...BASE, fallbackReview: true, autoMerge: false })
    assert.equal(r.reason, 'review-owed')
    assert.equal(r.queue, false)
  })

  test('descriptions stay at or under 140 characters', () => {
    for (const patch of [{}, { track: 'lean' }, { fallbackReview: true }]) {
      for (const s of decide({ ...BASE, ...patch }).statuses) {
        assert.ok(s.description.length <= 140, s.description)
      }
    }
  })

  test('decide rejects an unknown track', () => {
    assert.throws(() => decide({ ...BASE, track: 'medium' }), /track/)
  })
})

describe('ship-decision CLI', () => {
  test('exits 0 and prints the decision as JSON', () => {
    const r = run(...cliArgs(BASE))
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.sha, SHA)
    assert.equal(out.queue, true)
    assert.equal(out.reason, 'queued')
    assert.equal(out.statuses.length, 2)
  })

  test('accepts unknown for the three set-up reads', () => {
    const r = run(...cliArgs({
      ...BASE, autoMerge: 'unknown', branchProtected: 'unknown', branchRules: 'unknown',
    }))
    assert.equal(r.status, 0)
    assert.equal(JSON.parse(r.stdout).reason, 'set-up-unknown')
  })

  test('a verdict commit of none exits 0 with head-moved', () => {
    const r = run(...cliArgs({ ...BASE, verdictCommit: 'none' }))
    assert.equal(r.status, 0)
    assert.equal(JSON.parse(r.stdout).reason, 'head-moved')
  })

  test('a missing flag exits 2 with one line on stderr', () => {
    const r = run('--track', 'full')
    assert.equal(r.status, 2)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.trim().split('\n').length, 1)
  })

  test('a bad value exits 2 with one line on stderr', () => {
    const args = cliArgs(BASE)
    args[args.indexOf('--auto-merge') + 1] = 'maybe'
    const r = run(...args)
    assert.equal(r.status, 2)
    assert.equal(r.stderr.trim().split('\n').length, 1)
  })
})
