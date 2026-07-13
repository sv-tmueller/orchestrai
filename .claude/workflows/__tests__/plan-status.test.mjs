/**
 * Tests for the plan-status block parser/renderer (issue #256).
 *
 * The block grammar is defined in .claude/team-guide.md under "Plan-status
 * block before dispatch". These tests parse the two examples from that doc
 * verbatim, round-trip a block through render/parse, and exercise each of
 * the 7 validation rules with one failing case apiece.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanStatus, renderPlanStatus } from '../lib/plan-status.mjs'

// The fenced 5-step example from team-guide.md, verbatim (including the
// alignment padding before "<- dispatching tester").
const FENCED_BLOCK = [
  'Plan status (issue #42):',
  '  [x] 1. sub-plan',
  '  [x] 2. develop',
  '  [>] 3. test   <- dispatching tester',
  '  [ ] 4. review',
  '  [ ] 5. PR ready',
].join('\n')

// The canonical (single-space) form of the same block.
const FENCED_BLOCK_CANONICAL = [
  'Plan status (issue #42):',
  '  [x] 1. sub-plan',
  '  [x] 2. develop',
  '  [>] 3. test <- dispatching tester',
  '  [ ] 4. review',
  '  [ ] 5. PR ready',
].join('\n')

// A minimal valid block whose current-step line is the verbatim fix-round
// example from team-guide.md: "[>] 3. test (fix round 2/3)".
const FIX_ROUND_BLOCK = [
  'Plan status (issue #7):',
  '  [x] 1. sub-plan',
  '  [x] 2. develop',
  '  [>] 3. test (fix round 2/3)',
].join('\n')

describe('parsePlanStatus: team-guide examples', () => {
  test('parses the fenced 5-step block verbatim', () => {
    const result = parsePlanStatus(FENCED_BLOCK)
    assert.deepEqual(result, {
      subject: 'issue #42',
      steps: [
        { number: 1, title: 'sub-plan', state: 'done', dispatching: null, fixRound: null },
        { number: 2, title: 'develop', state: 'done', dispatching: null, fixRound: null },
        { number: 3, title: 'test', state: 'current', dispatching: 'tester', fixRound: null },
        { number: 4, title: 'review', state: 'todo', dispatching: null, fixRound: null },
        { number: 5, title: 'PR ready', state: 'todo', dispatching: null, fixRound: null },
      ],
    })
  })

  test('parses the minimal fix-round block verbatim', () => {
    const result = parsePlanStatus(FIX_ROUND_BLOCK)
    assert.deepEqual(result, {
      subject: 'issue #7',
      steps: [
        { number: 1, title: 'sub-plan', state: 'done', dispatching: null, fixRound: null },
        { number: 2, title: 'develop', state: 'done', dispatching: null, fixRound: null },
        {
          number: 3,
          title: 'test',
          state: 'current',
          dispatching: null,
          fixRound: { round: 2, cap: 3 },
        },
      ],
    })
  })
})

describe('renderPlanStatus: canonical output', () => {
  test('normalizes alignment padding to single spaces', () => {
    const parsed = parsePlanStatus(FENCED_BLOCK)
    assert.equal(renderPlanStatus(parsed), FENCED_BLOCK_CANONICAL)
  })
})

describe('round trip', () => {
  test('parsePlanStatus(renderPlanStatus(block)) deep-equals block', () => {
    const block = {
      subject: 'issue #99',
      steps: [
        { number: 1, title: 'sub-plan', state: 'done', dispatching: null, fixRound: null },
        { number: 2, title: 'develop', state: 'done', dispatching: null, fixRound: null },
        {
          number: 3,
          title: 'test',
          state: 'current',
          dispatching: 'tester',
          fixRound: { round: 2, cap: 3 },
        },
        { number: 4, title: 'review', state: 'todo', dispatching: null, fixRound: null },
      ],
    }

    const rendered = renderPlanStatus(block)
    const parsed = parsePlanStatus(rendered)
    assert.deepEqual(parsed, block)
  })
})

describe('validation rules', () => {
  test('rule 1: header must match "Plan status (<subject>):" with a non-empty subject', () => {
    const text = ['Plan status issue #1', '  [x] 1. sub-plan'].join('\n')
    assert.throws(() => parsePlanStatus(text), /Plan status issue #1/)
  })

  test('rule 2: every step marker must be [x], [>], or [ ]', () => {
    const text = ['Plan status (issue #1):', '  [y] 1. sub-plan'].join('\n')
    assert.throws(() => parsePlanStatus(text), /\[y\] 1\. sub-plan/)
  })

  test('rule 3: step numbers run 1..N in order, no gaps, no duplicates', () => {
    const text = ['Plan status (issue #1):', '  [x] 1. sub-plan', '  [x] 3. develop'].join('\n')
    assert.throws(() => parsePlanStatus(text), /\[x\] 3\. develop/)
  })

  test('rule 4: at most one [>] step per block', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan',
      '  [>] 2. develop',
      '  [>] 3. test',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /\[>\] 3\. test/)
  })

  test('rule 5: state order is monotonic (done, then current, then todo)', () => {
    const text = ['Plan status (issue #1):', '  [ ] 1. sub-plan', '  [x] 2. develop'].join('\n')
    assert.throws(() => parsePlanStatus(text), /\[x\] 2\. develop/)
  })

  test('rule 6: a dispatching suffix is only valid on the current step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan <- dispatching tester',
      '  [ ] 2. develop',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /\[x\] 1\. sub-plan <- dispatching tester/)
  })

  test('rule 7: a fix round annotation is only valid on the current step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan (fix round 2/3)',
      '  [ ] 2. develop',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /\[x\] 1\. sub-plan \(fix round 2\/3\)/)
  })
})

describe('error messages', () => {
  test('the error message names the offending line', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan <- dispatching tester',
      '  [ ] 2. develop',
    ].join('\n')

    assert.throws(
      () => parsePlanStatus(text),
      (err) => {
        assert.ok(err instanceof Error)
        assert.ok(
          err.message.includes('[x] 1. sub-plan <- dispatching tester'),
          `expected message to include the offending line, got: ${err.message}`
        )
        return true
      }
    )
  })
})
