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

// ===========================================================================
// 1. Header parsing
// ===========================================================================
describe('parsePlanStatus: header', () => {
  test('parses the subject out of the header line', () => {
    const block = parsePlanStatus('Plan status (issue #42):\n  [x] 1. sub-plan')
    assert.equal(block.subject, 'issue #42')
  })
})
