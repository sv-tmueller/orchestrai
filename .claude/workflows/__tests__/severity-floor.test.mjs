/**
 * Severity floor test (issue #407).
 *
 * Five objectively checkable conditions force a finding to must-fix. The
 * list is prompt text copied into the reviewer surfaces, so this test pins
 * that every surface carries all five conditions and that a drifted edit to
 * one copy fails here. Whitespace is normalized on both sides so markdown line
 * wrapping does not matter.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dir, '..', '..', '..')

const FLOOR_CONDITIONS = [
  'A test deleted, skipped or weakened, without the PR body saying why.',
  '`--no-verify`, or any other bypassed git hook.',
  'A new dependency with no justification in the PR body.',
  'A CI job with no `timeout-minutes`, or a workflow with no `concurrency` group carrying `cancel-in-progress: true`.',
  'A change touching the full stack, shipped without e2e.',
]

const norm = (s) => s.replace(/\s+/g, ' ')

function assertHasFloor(text, label) {
  const t = norm(text)
  for (const cond of FLOOR_CONDITIONS) {
    assert.ok(t.includes(norm(cond)), `${label} is missing floor condition: ${cond}`)
  }
}

describe('severity floor in reviewer role surfaces', () => {
  const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

  test('.claude/agents/reviewer.md carries all five conditions', () => {
    assertHasFloor(read('.claude/agents/reviewer.md'), 'agents/reviewer.md')
  })

  test('.claude/adapters/prompts/reviewer.md carries all five conditions', () => {
    assertHasFloor(read('.claude/adapters/prompts/reviewer.md'), 'adapters/prompts/reviewer.md')
  })

  test('role-contracts.md reviewer section carries all five conditions', () => {
    const doc = read('docs/architecture/role-contracts.md')
    const start = doc.search(/^## reviewer\s*$/m)
    assert.ok(start !== -1, 'no ## reviewer section')
    const rest = doc.slice(start + 1)
    const next = rest.search(/^## /m)
    const section = next === -1 ? rest : rest.slice(0, next)
    assertHasFloor(section, 'role-contracts.md reviewer section')
  })
})
