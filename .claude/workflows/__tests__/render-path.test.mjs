/**
 * Render-path test (issue #314, review #321 findings 1, N1, N2).
 *
 * Stubs the workflow runtime (agent, parallel, phase, log, args) and
 * dynamically executes each workflow JS file, recording every agent()
 * call's opts. The parallel stub INVOKES its thunks so fan-out callsites
 * are covered too, not just scout/critic stages.
 *
 * For each recorded call, the test maps opts.label back to its SPEC
 * stage (via label or item_label_prefix) and asserts:
 *   opts.model === TIER_MODELS[stage.tier]
 *   opts.effort === TIER_EFFORTS[stage.tier]
 * This catches both hardcoded bypasses (model:'opus' at a worker stage)
 * and aliasing bugs (consolStage pointed at the wrong SPEC stage).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const adaptersDir = join(__dir, '..', '..', 'adapters')

const adapterTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))

const TIER_MODELS = { judgment: 'opus', worker: 'sonnet', lead: 'fable' }
const TIER_EFFORTS = { judgment: 'xhigh', worker: 'high', lead: 'xhigh' }

const ALLOWED_AGENT_TIERS = ['judgment', 'worker']

const WORKFLOW_FILES = ['tm-review-changes.js', 'tm-review-codebase.js', 'tm-map-codebase.js']

// Expected agent() call counts per workflow (scout + fan-out workers + critic).
const EXPECTED_CALL_COUNTS = {
  'tm-review-changes.js': 11, // 1 scout-equivalent + 8 review dimensions + 1 consolidate + 1 critic? No...
  'tm-review-codebase.js': 9,
  'tm-map-codebase.js': 8,
}

// Synthetic agent results that satisfy each workflow's schema requirements.
function fakeAgentResult(label) {
  return {
    _stub: true,
    _label: label,
    areas: [{ name: 'stub-area', paths: ['.'], why: 'stub' }],
    dropped: [],
    summary: 'stub summary',
    reportPath: 'docs/stub.md',
    openQuestions: [],
    coverage: {
      areasMapped: ['stub-area'],
      areasDropped: [],
      workersFailed: [],
      ceilingReached: false,
    },
  }
}

function createStubRuntime() {
  const calls = { agent: [], parallel: [], phase: [] }

  const runtime = {
    agent: (prompt, opts) => {
      calls.agent.push({ prompt, opts })
      return Promise.resolve(fakeAgentResult(opts?.label))
    },
    // Invoke the thunks so fan-out agent() calls are actually executed.
    parallel: (thunks) => {
      calls.parallel.push(thunks.length)
      return Promise.all(thunks.map((t) => t()))
    },
    phase: (title) => {
      calls.phase.push(title)
    },
    log: () => {},
    args: {},
  }

  return { runtime, calls }
}

// Parse the SPEC constant from a workflow JS file.
function parseSpec(src) {
  const match = src.match(/const\s+SPEC\s*=\s*/)
  if (!match) return null
  let pos = src.indexOf('{', match.index)
  let depth = 0
  let started = false
  while (pos < src.length) {
    if (src[pos] === '{') { depth++; started = true }
    if (src[pos] === '}') depth--
    pos++
    if (started && depth === 0) break
  }
  const constSrc = src.slice(match.index, pos)
  const ctx = createContext({})
  runInContext(constSrc, ctx)
  return runInContext('SPEC', ctx)
}

// Build a label-to-stage-name lookup from the SPEC.
function buildLabelIndex(spec) {
  const index = {}
  for (const [name, stage] of Object.entries(spec.stages)) {
    if (stage.label) {
      index[stage.label] = name
    }
    if (stage.item_label) {
      index[stage.item_label] = name
    }
    if (stage.item_label_prefix) {
      index[`__prefix:${stage.item_label_prefix}`] = name
    }
  }
  return index
}

// Given a label and the index, find the SPEC stage name.
function lookupStage(label, index) {
  if (index[label]) return index[label]
  for (const [key, name] of Object.entries(index)) {
    if (key.startsWith('__prefix:')) {
      const prefix = key.slice('__prefix:'.length)
      if (label && label.startsWith(prefix)) return name
    }
  }
  return null
}

async function executeWorkflow(filename) {
  const src = readFileSync(join(workflowsDir, filename), 'utf8')
  const { runtime, calls } = createStubRuntime()

  // Transform for VM: strip import statements, replace export const with const.
  // The import regex anchors on ^\s*import to avoid touching prompt text that
  // begins with "import" inside template literals (none currently do, but the
  // guard is defensive).
  const transformed = src
    .replace(/^\s*import\s+.*$/gm, '')
    .replace(/export\s+const\s+/g, 'const ')

  const wrapper = `(async () => {\n${transformed}\n})`

  const ctx = createContext({
    agent: runtime.agent,
    parallel: runtime.parallel,
    phase: runtime.phase,
    log: runtime.log,
    args: runtime.args,
    Promise,
    console,
    JSON,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
  })

  const fn = runInContext(wrapper, ctx)
  await fn()

  return { calls, src }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('render-path callsite coverage', () => {
  for (const file of WORKFLOW_FILES) {
    test(`${file}: every agent() call resolves through its SPEC stage tier`, async () => {
      const { calls, src } = await executeWorkflow(file)
      const spec = parseSpec(src)
      assert.ok(spec, `${file}: could not parse SPEC`)
      const index = buildLabelIndex(spec)

      assert.ok(
        calls.agent.length > 0,
        `${file}: no agent() calls recorded; the stub runtime may need adjustment`
      )

      for (const { opts } of calls.agent) {
        assert.ok(opts, `${file}: agent() called with no opts`)
        assert.ok(opts.model, `${file}: agent() call has no model in opts`)
        assert.ok(opts.effort, `${file}: agent() call has no effort in opts`)
        assert.ok(opts.label, `${file}: agent() call has no label in opts`)

        // Map the label back to its SPEC stage.
        const stageName = lookupStage(opts.label, index)
        assert.ok(
          stageName,
          `${file}: agent() call label "${opts.label}" does not match any SPEC stage`
        )

        const stage = spec.stages[stageName]
        assert.ok(stage, `${file}: stage "${stageName}" not in SPEC`)

        // Assert model matches TIER_MODELS for the stage's declared tier.
        assert.equal(
          opts.model,
          TIER_MODELS[stage.tier],
          `${file}: agent() call label "${opts.label}" (stage "${stageName}") ` +
            `pins model "${opts.model}", but the SPEC declares tier "${stage.tier}" ` +
            `which maps to model "${TIER_MODELS[stage.tier]}"`
        )

        // Assert effort matches TIER_EFFORTS for the stage's declared tier.
        assert.equal(
          opts.effort,
          TIER_EFFORTS[stage.tier],
          `${file}: agent() call label "${opts.label}" (stage "${stageName}") ` +
            `pins effort "${opts.effort}", but the SPEC declares tier "${stage.tier}" ` +
            `which maps to effort "${TIER_EFFORTS[stage.tier]}"`
        )

        // Reject lead tier on workflow stages.
        assert.ok(
          ALLOWED_AGENT_TIERS.includes(stage.tier),
          `${file}: stage "${stageName}" declares tier "${stage.tier}", but ` +
            `workflow stages may only use ${ALLOWED_AGENT_TIERS.join(' or ')}; ` +
            `lead is reserved for the session`
        )
      }
    })

    test(`${file}: no agent() call uses a forbidden effort`, async () => {
      const { calls } = await executeWorkflow(file)
      for (const { opts } of calls.agent) {
        assert.notEqual(
          opts.effort,
          'max',
          `${file}: agent() call with label "${opts.label}" uses forbidden effort "max"`
        )
      }
    })
  }
})
