/**
 * Policy-lock test for the effort policy (issue #140).
 *
 * Every seat pins its own effort, so session /effort governs only the lead:
 * sonnet seats run high, fable seats run xhigh, and nothing runs at max.
 * The test reads the real agent frontmatters and workflow sources, so a new
 * agent or workflow stage that omits its pin (and would silently inherit the
 * session effort) fails here instead of shipping.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const agentsDir = join(__dir, '..', '..', 'agents')

const EFFORT_BY_MODEL = { sonnet: 'high', fable: 'xhigh' }
const WORKFLOW_FILES = ['tm-review-changes.js', 'tm-review-codebase.js', 'tm-map-codebase.js']

// ===========================================================================
// 1. Agent frontmatter: every role agent pins model and the matching effort
// ===========================================================================
describe('agent frontmatter effort pins', () => {
  const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))

  test('the role agents are present', () => {
    assert.ok(
      agentFiles.length >= 5,
      `expected at least the 5 role agents in ${agentsDir}, found ${agentFiles.length}`
    )
  })

  for (const file of agentFiles) {
    test(`${file} pins model and the matching effort`, () => {
      const src = readFileSync(join(agentsDir, file), 'utf8')
      const fm = src.match(/^---\n([\s\S]*?)\n---/)
      assert.ok(fm, `${file} has no frontmatter block`)

      const model = fm[1].match(/^model:\s*(\S+)/m)?.[1]
      assert.ok(model, `${file} must pin model: explicitly`)

      const expected = EFFORT_BY_MODEL[model]
      assert.ok(
        expected,
        `${file} pins model "${model}", which has no effort rule; ` +
          `extend EFFORT_BY_MODEL in this test when adding a new model tier`
      )

      const effort = fm[1].match(/^effort:\s*(\S+)/m)?.[1]
      assert.equal(
        effort,
        expected,
        `${file} (model ${model}) must pin effort: ${expected}, ` +
          `found ${effort ?? 'none (would inherit the session effort)'}`
      )
    })
  }
})

// ===========================================================================
// 2. Workflow stages: every agent() call pins the effort matching its model
//
// Agent-call opts in both workflows are single-line objects carrying both
// label: and model:. The meta.phases display entries carry model: but
// title:/detail: instead of label:, so requiring label: excludes them.
// ===========================================================================
describe('workflow stage effort pins', () => {
  for (const file of WORKFLOW_FILES) {
    const src = readFileSync(join(workflowsDir, file), 'utf8')
    const optLines = src
      .split('\n')
      .filter((l) => l.includes('label:') && l.includes('model:'))

    test(`${file} has agent-call opts lines to check`, () => {
      assert.ok(
        optLines.length > 0,
        `${file}: no lines with both label: and model: found; ` +
          `if the opts format changed, update this test's parsing rule`
      )
    })

    test(`${file}: every stage pins the effort matching its model`, () => {
      for (const line of optLines) {
        const model = line.match(/model:\s*'(\w+)'/)?.[1]
        assert.ok(model, `${file}: unparseable model in: ${line.trim()}`)

        const expected = EFFORT_BY_MODEL[model]
        assert.ok(
          expected,
          `${file}: model "${model}" has no effort rule; ` +
            `extend EFFORT_BY_MODEL in this test when adding a new model tier`
        )

        const effort = line.match(/effort:\s*'(\w+)'/)?.[1]
        assert.equal(
          effort,
          expected,
          `${file}: a ${model} stage must pin effort: '${expected}': ${line.trim()}`
        )
      }
    })

    test(`${file}: nothing runs at max effort`, () => {
      assert.ok(!/effort:\s*'max'/.test(src), `${file} contains effort: 'max'`)
    })
  }
})
