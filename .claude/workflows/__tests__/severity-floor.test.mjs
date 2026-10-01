/**
 * Severity floor test (issue #407).
 *
 * Five objectively checkable conditions force a finding to must-fix. The
 * list is prompt text copied into several surfaces, so this test pins that
 * every surface carries all five conditions and that a drifted edit to one
 * copy fails here. Whitespace is normalized on both sides so markdown line
 * wrapping does not matter.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const repoRoot = join(__dir, '..', '..', '..')

const FLOOR_CONDITIONS = [
  'A test deleted, skipped or weakened, without the PR body saying why.',
  '`--no-verify`, or any other bypassed git hook.',
  'A new dependency with no justification in the PR body.',
  'A CI job with no `timeout-minutes`, or a workflow with no `concurrency` group carrying `cancel-in-progress: true`.',
  'A change touching the full stack, shipped without e2e.',
]

const NO_DOWNGRADE = 'cannot be downgraded'

const norm = (s) => s.replace(/\s+/g, ' ')

// Same brace-match plus node:vm approach as prompts-sync.test.mjs.
function parsePromptsFromJs(src) {
  const startIdx = src.indexOf('const PROMPTS = {')
  let pos = src.indexOf('{', startIdx)
  let depth = 0
  let started = false
  while (pos < src.length) {
    if (src[pos] === '{') { depth++; started = true }
    if (src[pos] === '}') depth--
    pos++
    if (started && depth === 0) break
  }
  const ctx = createContext({})
  runInContext(src.slice(startIdx, pos), ctx)
  return runInContext('PROMPTS', ctx)
}

function loadJs(name) {
  return parsePromptsFromJs(readFileSync(join(workflowsDir, name), 'utf8'))
}
function loadJson(name) {
  return JSON.parse(readFileSync(join(workflowsDir, 'prompts', name), 'utf8'))
}

// Every template where a severity gets set. verify and scout set none.
const WORKFLOWS = [
  { name: 'tm-review-changes', keys: ['review', 'consolidate'] },
  { name: 'tm-review-codebase', keys: ['area_review', 'architecture_review', 'consolidate'] },
]

function assertHasFloor(text, label) {
  const t = norm(text)
  for (const cond of FLOOR_CONDITIONS) {
    assert.ok(t.includes(norm(cond)), `${label} is missing floor condition: ${cond}`)
  }
}

describe('severity floor in workflow prompts', () => {
  for (const { name, keys } of WORKFLOWS) {
    const js = loadJs(`${name}.js`)
    const json = loadJson(`${name}.prompts.json`)
    for (const key of keys) {
      test(`${name}.js PROMPTS.${key} carries all five conditions`, () => {
        assertHasFloor(js[key], `${name}.js PROMPTS.${key}`)
      })
      test(`${name}.prompts.json ${key} carries all five conditions`, () => {
        assertHasFloor(json[key], `${name}.prompts.json ${key}`)
      })
    }
    test(`${name}.js consolidate says a floor finding ${NO_DOWNGRADE}`, () => {
      assert.ok(norm(js.consolidate).includes(NO_DOWNGRADE))
    })
    test(`${name}.prompts.json consolidate says a floor finding ${NO_DOWNGRADE}`, () => {
      assert.ok(norm(json.consolidate).includes(NO_DOWNGRADE))
    })
  }

  test('tm-review-changes verify prompt is unchanged (floor sets severity, not truth)', () => {
    const js = loadJs('tm-review-changes.js')
    assert.ok(!norm(js.verify).includes(FLOOR_CONDITIONS[0]))
  })
})

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
