/**
 * Hermes adapter test (issue #315, Phase C of #311).
 *
 * Verifies the Hermes adapter table structure, the adapter interface
 * (spawn/detectFailure/retry), and the workflow renderer in dry-run mode.
 * No live API calls are made; DRY_RUN=true is set before importing the
 * adapter.
 *
 * These tests prove the data-spec approach works on a second host: the
 * same JSON spec files consumed by the Claude Code JS renderer are
 * consumed by the Hermes renderer, producing structurally-valid reports.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')

// Enable dry-run before importing the adapter.
process.env.DRY_RUN = 'true'

const hermesTable = JSON.parse(readFileSync(join(adaptersDir, 'hermes.json'), 'utf8'))
const claudeTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))

// ===========================================================================
// 1. Hermes adapter table structure
// ===========================================================================
describe('hermes adapter table structure', () => {
  test('exists and is valid JSON', () => {
    assert.ok(hermesTable.host === 'hermes')
  })

  test('has all required tiers', () => {
    for (const tier of ['judgment', 'worker', 'lead']) {
      assert.ok(hermesTable.tiers[tier], `missing tier "${tier}"`)
    }
  })

  test('every tier has a model and effort', () => {
    for (const [tier, cfg] of Object.entries(hermesTable.tiers)) {
      assert.ok(cfg.model, `tier "${tier}" missing model`)
      assert.ok(cfg.effort, `tier "${tier}" missing effort`)
    }
  })

  test('uses GLM-5-2 for judgment and lead tiers', () => {
    assert.ok(
      hermesTable.tiers.judgment.model.includes('glm'),
      `judgment tier should use a GLM model, got "${hermesTable.tiers.judgment.model}"`
    )
    assert.ok(
      hermesTable.tiers.lead.model.includes('glm'),
      `lead tier should use a GLM model, got "${hermesTable.tiers.lead.model}"`
    )
  })

  test('has all 7 roles mapped', () => {
    const expectedRoles = [
      'architect', 'developer', 'docs-writer', 'fact-checker',
      'perf-investigator', 'reviewer', 'tester',
    ]
    for (const role of expectedRoles) {
      assert.ok(hermesTable.roles[role], `missing role "${role}"`)
    }
  })

  test('effort ceiling and forbidden efforts match the universal policy', () => {
    assert.equal(hermesTable.effort_ceiling, 'xhigh')
    assert.deepEqual(hermesTable.forbidden_efforts, ['max'])
  })

  test('shares the same role-to-tier mapping as the Claude Code table', () => {
    assert.deepEqual(
      hermesTable.roles,
      claudeTable.roles,
      'Hermes and Claude Code adapter tables must agree on role-to-tier assignments'
    )
  })
})

// ===========================================================================
// 2. Adapter interface (spawn/detectFailure/retry)
// ===========================================================================
describe('hermes adapter interface', () => {
  // Import dynamically so DRY_RUN takes effect.
  let spawn, detectFailure, retry, resolveTier, resolveRole

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    spawn = mod.spawn
    detectFailure = mod.detectFailure
    retry = mod.retry
    resolveTier = mod.resolveTier
    resolveRole = mod.resolveRole
  })

  test('resolveTier returns model and effort for each tier', () => {
    const j = resolveTier('judgment')
    assert.ok(j.model)
    assert.ok(j.effort)
    const w = resolveTier('worker')
    assert.ok(w.model)
    assert.ok(w.effort)
  })

  test('resolveRole returns the tier for each role', () => {
    assert.equal(resolveRole('architect'), 'judgment')
    assert.equal(resolveRole('developer'), 'worker')
    assert.equal(resolveRole('reviewer'), 'judgment')
  })

  test('spawn returns a report in dry-run mode', async () => {
    const report = await spawn('developer', 'test task', { tier: 'worker' })
    assert.ok(report)
    assert.equal(report._dryRun, true)
    assert.equal(report._role, 'developer')
    assert.equal(report._tier, 'worker')
  })

  test('detectFailure identifies null, error, and empty-string reports', () => {
    assert.equal(detectFailure(null), true)
    assert.equal(detectFailure(undefined), true)
    assert.equal(detectFailure({ error: 'something' }), true)
    assert.equal(detectFailure(''), true)
    assert.equal(detectFailure('   '), true)
    assert.equal(detectFailure({ verdict: 'approve' }), false)
    assert.equal(detectFailure({ status: 'DONE' }), false)
  })

  test('retry re-dispatches on the fallback tier and marks the report', async () => {
    const report = await retry(
      'original task',
      { tier: 'judgment', role: 'reviewer' },
      'worker'
    )
    assert.ok(report)
    assert.ok(report.modelFallback, 'retry must set modelFallback marker')
    assert.ok(
      report.modelFallback.includes('->'),
      'modelFallback should show "origModel -> fbModel"'
    )
  })
})

// ===========================================================================
// 3. Workflow renderer (dry-run: exercises the spec-driven fan-out)
// ===========================================================================
describe('hermes workflow renderer', () => {
  let renderWorkflow

  before(async () => {
    const mod = await import('../../adapters/hermes-renderer.mjs')
    renderWorkflow = mod.renderWorkflow
  })

  for (const wf of ['tm-review-changes', 'tm-review-codebase', 'tm-map-codebase']) {
    test(`${wf}: renderer produces a report from the JSON spec`, async () => {
      const report = await renderWorkflow(wf, {})
      assert.ok(report, `${wf}: renderer returned no report`)
      // The last stage is the consolidate/synthesize stage (judgment tier).
      // Its dry-run report carries _dryRun and _tier markers.
      assert.equal(report._dryRun, true, `${wf}: report should be dry-run`)
      assert.equal(
        report._tier,
        'judgment',
        `${wf}: final stage should be judgment tier`
      )
    })
  }

  test('tm-review-changes: renderer handles fixed-list parallelism', async () => {
    // tm-review-changes has a fixed-list review stage (DIMENSIONS).
    // Pass stub dimensions to exercise the fixed-list path.
    const report = await renderWorkflow('tm-review-changes', {
      dimensions: [
        { key: 'bugs', brief: 'bug dimension' },
        { key: 'security', brief: 'security dimension' },
      ],
    })
    assert.ok(report)
    assert.equal(report._dryRun, true)
  })

  test('tm-map-codebase: renderer handles dynamic-list parallelism', async () => {
    // tm-map-codebase has a dynamic-list area_map stage. Without a real
    // scout result, the renderer falls back to a stub area, exercising the
    // dynamic-list path.
    const report = await renderWorkflow('tm-map-codebase', {})
    assert.ok(report)
    assert.equal(report._dryRun, true)
  })
})
