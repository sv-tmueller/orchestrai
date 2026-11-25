/**
 * Pins the light flow doc (docs/architecture/light-flow.md), the one source
 * the Claude kickoff and advisor skills and the Hermes driver follow.
 *
 * The pins cover the parts that must not drift: the section headings other
 * files link to, the review gate, the fix-round cap and the issue body
 * template. Whitespace is collapsed first, so re-wrapping a line cannot
 * break a pin.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const docPath = join(__dir, '..', '..', '..', 'docs', 'architecture', 'light-flow.md')

describe('light flow doc', () => {
  const raw = readFileSync(docPath, 'utf8')
  const text = raw.replace(/\s+/g, ' ')

  test('has the six sections', () => {
    for (const heading of [
      '## Advisor',
      '## Issue body',
      '## Kickoff',
      '## Review gate',
      '## Merge gate',
      '## Resume',
    ]) {
      assert.ok(
        raw.split('\n').some((line) => line.trim() === heading),
        `missing heading ${heading}`
      )
    }
  })

  test('states the review gate', () => {
    assert.ok(text.includes('size:M'), 'size:M')
    for (const path of [
      '.claude/agents',
      '.claude/skills',
      '.claude/workflows',
      '.github/workflows',
      'dependency manifest',
    ]) {
      assert.ok(text.includes(path), `risky path ${path}`)
    }
    assert.ok(text.includes('DONE_WITH_CONCERNS'), 'DONE_WITH_CONCERNS')
  })

  test('caps fix rounds at 2', () => {
    assert.ok(text.includes('2 fix rounds'))
  })

  test('issue body template', () => {
    for (const heading of [
      '## What to build',
      '## Approach',
      '## Acceptance criteria',
      '## Non-goals',
    ]) {
      assert.ok(text.includes(heading), `missing template heading ${heading}`)
    }
  })

  test('stays under 120 lines', () => {
    assert.ok(raw.split('\n').length < 120)
  })
})
