/**
 * Hermes renderer: tm-review-changes verify stage (issue #406).
 *
 * Drives the renderer in live mode against a stubbed delegate_task global and
 * inspects the prompts it sends. The verify stage's items come from the review
 * stage's reports through the must_fix_deduped transform.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const RENDERER_PATH = '../../adapters/hermes-renderer.mjs'

const MUST_FIX = { file: 'src/a.js', line: '12', severity: 'must-fix', problem: 'unique-problem-text', fix: 'f' }

async function runLive() {
  const calls = []
  const origDryRun = process.env.DRY_RUN
  const origDelegate = globalThis.delegate_task
  process.env.DRY_RUN = 'false'
  globalThis.delegate_task = async ({ goal, output_schema }) => {
    calls.push({ goal, output_schema })
    if (output_schema === 'FINDINGS_SCHEMA') return { findings: [MUST_FIX] }
    if (output_schema === 'VERIFY_SCHEMA') return { confirmed: true, note: 'reproduced' }
    return { verdict: 'approve', summary: 's', mustFix: [], shouldFix: [], nits: [] }
  }
  const origWarn = console.warn
  console.warn = () => {}
  try {
    const { renderWorkflow } = await import(RENDERER_PATH)
    await renderWorkflow('tm-review-changes', { base: 'origin/main' })
  } finally {
    console.warn = origWarn
    globalThis.delegate_task = origDelegate
    process.env.DRY_RUN = origDryRun
  }
  return calls
}

describe('hermes renderer: tm-review-changes verify stage', () => {
  test('dispatches one verifier for the deduped must-fix finding, with the finding and diffHint filled in', async () => {
    const calls = await runLive()
    const verifyCalls = calls.filter((c) => c.output_schema === 'VERIFY_SCHEMA')
    assert.equal(verifyCalls.length, 1, 'every reviewer reports the same finding; dedup leaves one verifier')
    const goal = verifyCalls[0].goal
    assert.ok(goal.includes('unique-problem-text'), 'verify prompt must carry the finding JSON')
    assert.ok(goal.includes('origin/main...HEAD'), 'verify prompt must carry the diffHint')
    assert.ok(goal.includes('adversarial verifier'), 'verify prompt must carry the adversarial stance')
    assert.ok(!goal.includes('{{'), 'no unfilled slot markers')
  })

  test('verify runs on the fact-checker role prompt, not the developer default', async () => {
    const calls = await runLive()
    const goal = calls.find((c) => c.output_schema === 'VERIFY_SCHEMA').goal
    assert.ok(goal.startsWith('# Fact-checker role prompt'), `got: ${goal.slice(0, 60)}`)
  })

  test('the consolidate prompt renders with no unfilled slot markers', async () => {
    const calls = await runLive()
    const goal = calls.find((c) => c.output_schema === 'REPORT_SCHEMA').goal
    assert.ok(!goal.includes('{{'), 'no unfilled slot markers')
  })
})
