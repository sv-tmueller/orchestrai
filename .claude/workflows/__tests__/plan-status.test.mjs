/**
 * Tests for the plan-status block parser/renderer (issue #257).
 *
 * The block format is defined in .claude/team-guide.md, "Plan-status block
 * before dispatch". These tests parse the two examples from that section
 * verbatim, check the round trip, and cover one failing case per
 * validation rule listed in the issue.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanStatus, renderPlanStatus } from '../lib/plan-status.mjs'

// The dispatching example from team-guide.md, "Plan-status block before
// dispatch", parsed verbatim.
const DISPATCH_EXAMPLE = [
  'Plan status (issue #42):',
  '  [x] 1. sub-plan',
  '  [x] 2. develop',
  '  [>] 3. test   <- dispatching tester',
  '  [ ] 4. review',
  '  [ ] 5. PR ready',
].join('\n')

// The fix-round example from the same section:
// "A fix round annotates the current item, for example
// `[>] 3. test (fix round 2/3)`."
const FIX_ROUND_EXAMPLE = [
  'Plan status (issue #42):',
  '  [x] 1. sub-plan',
  '  [x] 2. develop',
  '  [>] 3. test (fix round 2/3)',
  '  [ ] 4. review',
  '  [ ] 5. PR ready',
].join('\n')

// ===========================================================================
// 1. Header parsing
// ===========================================================================
describe('parsePlanStatus: header', () => {
  test('parses the subject out of the header line', () => {
    const block = parsePlanStatus('Plan status (issue #42):\n  [x] 1. sub-plan')
    assert.equal(block.subject, 'issue #42')
  })
})

// ===========================================================================
// 2. The two team-guide.md examples, parsed verbatim
// ===========================================================================
describe('parsePlanStatus: team-guide.md examples', () => {
  test('parses the dispatching example', () => {
    const block = parsePlanStatus(DISPATCH_EXAMPLE)
    assert.equal(block.subject, 'issue #42')
    assert.deepEqual(block.steps, [
      { number: 1, title: 'sub-plan', state: 'done', dispatching: null, fixRound: null },
      { number: 2, title: 'develop', state: 'done', dispatching: null, fixRound: null },
      { number: 3, title: 'test', state: 'current', dispatching: 'tester', fixRound: null },
      { number: 4, title: 'review', state: 'todo', dispatching: null, fixRound: null },
      { number: 5, title: 'PR ready', state: 'todo', dispatching: null, fixRound: null },
    ])
  })

  test('parses the fix-round example', () => {
    const block = parsePlanStatus(FIX_ROUND_EXAMPLE)
    assert.equal(block.subject, 'issue #42')
    assert.deepEqual(block.steps[2], {
      number: 3,
      title: 'test',
      state: 'current',
      dispatching: null,
      fixRound: { round: 2, cap: 3 },
    })
  })
})

// ===========================================================================
// 3. renderPlanStatus renders the canonical text
// ===========================================================================
describe('renderPlanStatus', () => {
  test('renders the dispatching example with single spaces (source has 3 before "<-")', () => {
    const block = parsePlanStatus(DISPATCH_EXAMPLE)
    const canonical = DISPATCH_EXAMPLE.replace('test   <- dispatching', 'test <- dispatching')
    assert.equal(renderPlanStatus(block), canonical)
  })

  test('renders the fix-round example back to its canonical text', () => {
    const block = parsePlanStatus(FIX_ROUND_EXAMPLE)
    assert.equal(renderPlanStatus(block), FIX_ROUND_EXAMPLE)
  })

  test('collapses multiple spaces between fields to single spaces', () => {
    // The dispatching example uses 3 spaces before "<-"; the canonical
    // render uses exactly 1.
    const block = parsePlanStatus(DISPATCH_EXAMPLE)
    const rendered = renderPlanStatus(block)
    assert.ok(rendered.includes('[>] 3. test <- dispatching tester'))
  })
})

// ===========================================================================
// 4. Round trip: parsePlanStatus(renderPlanStatus(b)) deep-equals b
// ===========================================================================
describe('round trip', () => {
  test('parse(render(b)) deep-equals b for a block with a plain current step', () => {
    const block = {
      subject: 'issue #7',
      steps: [
        { number: 1, title: 'plan', state: 'done', dispatching: null, fixRound: null },
        { number: 2, title: 'build', state: 'current', dispatching: 'developer', fixRound: null },
        { number: 3, title: 'ship', state: 'todo', dispatching: null, fixRound: null },
      ],
    }
    assert.deepEqual(parsePlanStatus(renderPlanStatus(block)), block)
  })

  test('parse(render(b)) deep-equals b for a block with a fix-round current step', () => {
    const block = {
      subject: 'issue #7',
      steps: [
        { number: 1, title: 'plan', state: 'done', dispatching: null, fixRound: null },
        { number: 2, title: 'build', state: 'current', dispatching: null, fixRound: { round: 1, cap: 2 } },
        { number: 3, title: 'ship', state: 'todo', dispatching: null, fixRound: null },
      ],
    }
    assert.deepEqual(parsePlanStatus(renderPlanStatus(block)), block)
  })

  test('parse(render(b)) deep-equals b for a block with no current step', () => {
    const block = {
      subject: 'issue #7',
      steps: [
        { number: 1, title: 'plan', state: 'done', dispatching: null, fixRound: null },
        { number: 2, title: 'build', state: 'todo', dispatching: null, fixRound: null },
      ],
    }
    assert.deepEqual(parsePlanStatus(renderPlanStatus(block)), block)
  })
})

// ===========================================================================
// 5. Validation rule 1: header must match "Plan status (<subject>):" with a
// non-empty subject
// ===========================================================================
describe('validation rule 1: header', () => {
  test('rejects a missing header', () => {
    assert.throws(() => parsePlanStatus('  [x] 1. sub-plan'), /header/)
  })

  test('rejects an empty subject', () => {
    assert.throws(() => parsePlanStatus('Plan status ():\n  [x] 1. sub-plan'), /header/)
  })

  test('rejects a header missing the trailing colon', () => {
    assert.throws(() => parsePlanStatus('Plan status (issue #42)\n  [x] 1. sub-plan'), /header/)
  })
})

// ===========================================================================
// 6. Validation rule 2: every step marker must be [x], [>], or [ ]
// ===========================================================================
describe('validation rule 2: step marker', () => {
  test('rejects an invalid marker', () => {
    assert.throws(
      () => parsePlanStatus('Plan status (issue #1):\n  [y] 1. sub-plan'),
      /invalid step marker/
    )
  })
})

// ===========================================================================
// 7. Validation rule 3: step numbers run 1..N in order, no gaps, no dupes
// ===========================================================================
describe('validation rule 3: sequential numbering', () => {
  test('rejects a gap in step numbers', () => {
    const text = ['Plan status (issue #1):', '  [x] 1. sub-plan', '  [ ] 3. review'].join('\n')
    assert.throws(() => parsePlanStatus(text), /1\.\.N/)
  })

  test('rejects a duplicate step number', () => {
    const text = ['Plan status (issue #1):', '  [x] 1. sub-plan', '  [ ] 1. review'].join('\n')
    assert.throws(() => parsePlanStatus(text), /1\.\.N/)
  })

  test('renderPlanStatus rejects a gap in step numbers', () => {
    const block = {
      subject: 'issue #1',
      steps: [
        { number: 1, title: 'sub-plan', state: 'done', dispatching: null, fixRound: null },
        { number: 3, title: 'review', state: 'todo', dispatching: null, fixRound: null },
      ],
    }
    assert.throws(() => renderPlanStatus(block), /1\.\.N/)
  })
})

// ===========================================================================
// 8. Validation rule 4: at most one [>] step per block
// ===========================================================================
describe('validation rule 4: at most one current step', () => {
  test('rejects two [>] steps', () => {
    const text = [
      'Plan status (issue #1):',
      '  [>] 1. sub-plan',
      '  [>] 2. develop',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /at most one/)
  })
})

// ===========================================================================
// 9. Validation rule 5: state order is monotonic (done*, current?, todo*)
// ===========================================================================
describe('validation rule 5: monotonic state order', () => {
  test('rejects a [x] step after a [ ] step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [ ] 1. sub-plan',
      '  [x] 2. develop',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /state order/)
  })

  test('rejects a [>] step after a [ ] step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [ ] 1. sub-plan',
      '  [>] 2. develop',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /state order/)
  })
})

// ===========================================================================
// 10. Validation rule 6: "<- dispatching <agent>" is only valid on [>]
// ===========================================================================
describe('validation rule 6: dispatching suffix only on current step', () => {
  test('rejects a dispatching suffix on a [ ] step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan',
      '  [ ] 2. develop <- dispatching developer',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /dispatching/)
  })

  test('rejects a dispatching suffix on a [x] step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan <- dispatching developer',
      '  [ ] 2. develop',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /dispatching/)
  })

  test('renderPlanStatus rejects a dispatching value on a non-current step', () => {
    const block = {
      subject: 'issue #1',
      steps: [
        { number: 1, title: 'sub-plan', state: 'done', dispatching: 'developer', fixRound: null },
      ],
    }
    assert.throws(() => renderPlanStatus(block), /dispatching/)
  })
})

// ===========================================================================
// 11. Validation rule 7: "(fix round N/M)" is only valid on [>], N and M
// are positive integers, N <= M
// ===========================================================================
describe('validation rule 7: fix round annotation', () => {
  test('rejects a fix-round annotation on a [ ] step', () => {
    const text = [
      'Plan status (issue #1):',
      '  [x] 1. sub-plan',
      '  [ ] 2. develop (fix round 1/2)',
    ].join('\n')
    assert.throws(() => parsePlanStatus(text), /fix round/)
  })

  test('rejects round 0', () => {
    const text = ['Plan status (issue #1):', '  [>] 1. sub-plan (fix round 0/2)'].join('\n')
    assert.throws(() => parsePlanStatus(text), /fix round/)
  })

  test('rejects round greater than cap', () => {
    const text = ['Plan status (issue #1):', '  [>] 1. sub-plan (fix round 3/2)'].join('\n')
    assert.throws(() => parsePlanStatus(text), /fix round/)
  })

  test('renderPlanStatus rejects a fix round with round > cap', () => {
    const block = {
      subject: 'issue #1',
      steps: [
        { number: 1, title: 'sub-plan', state: 'current', dispatching: null, fixRound: { round: 3, cap: 2 } },
      ],
    }
    assert.throws(() => renderPlanStatus(block), /fix round/)
  })
})

// ===========================================================================
// 12. Error messages name the offending line for invalid input
// ===========================================================================
describe('error messages name the offending line', () => {
  test('invalid marker error includes the offending line text', () => {
    assert.throws(
      () => parsePlanStatus('Plan status (issue #1):\n  [y] 1. sub-plan'),
      /\[y\] 1\. sub-plan/
    )
  })
})
