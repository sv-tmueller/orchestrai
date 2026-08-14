/**
 * Codex adapter test (issue #316, Phase D of #311).
 *
 * Verifies the Codex adapter table structure, the adapter interface
 * (spawn/detectFailure/retry), the workflow renderer in dry-run mode,
 * and the TOML persona files. No live codex exec calls are made;
 * DRY_RUN=true is set before importing the adapter.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')
const personasDir = join(adaptersDir, 'personas')

process.env.DRY_RUN = 'true'

const codexTable = JSON.parse(readFileSync(join(adaptersDir, 'codex.json'), 'utf8'))
const hermesTable = JSON.parse(readFileSync(join(adaptersDir, 'hermes.json'), 'utf8'))
const claudeTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))

// ===========================================================================
// 1. Codex adapter table structure
// ===========================================================================
describe('codex adapter table structure', () => {
  test('exists and is valid JSON', () => {
    assert.ok(codexTable.host === 'codex')
  })

  test('has all required tiers', () => {
    for (const tier of ['judgment', 'worker', 'lead']) {
      assert.ok(codexTable.tiers[tier], `missing tier "${tier}"`)
    }
  })

  test('every tier has a model and effort', () => {
    for (const [tier, cfg] of Object.entries(codexTable.tiers)) {
      assert.ok(cfg.model, `tier "${tier}" missing model`)
      assert.ok(cfg.effort, `tier "${tier}" missing effort`)
    }
  })

  test('judgment and lead tiers use o3', () => {
    assert.equal(codexTable.tiers.judgment.model, 'o3')
    assert.equal(codexTable.tiers.lead.model, 'o3')
  })

  test('worker tier uses gpt-5.6', () => {
    assert.equal(codexTable.tiers.worker.model, 'gpt-5.6')
  })

  test('has all 7 roles mapped', () => {
    const expectedRoles = [
      'architect', 'developer', 'docs-writer', 'fact-checker',
      'perf-investigator', 'reviewer', 'tester',
    ]
    for (const role of expectedRoles) {
      assert.ok(codexTable.roles[role], `missing role "${role}"`)
    }
  })

  test('effort ceiling and forbidden efforts match the universal policy', () => {
    assert.equal(codexTable.effort_ceiling, 'xhigh')
    assert.deepEqual(codexTable.forbidden_efforts, ['max'])
  })

  test('auth mode is subscription, not metered', () => {
    assert.equal(codexTable.auth_mode, 'subscription')
    assert.ok(codexTable.auth_note.includes('No ANTHROPIC_API_KEY'))
  })

  test('shares the same role-to-tier mapping as the other adapter tables', () => {
    assert.deepEqual(codexTable.roles, claudeTable.roles)
    assert.deepEqual(codexTable.roles, hermesTable.roles)
  })
})

// ===========================================================================
// 2. Adapter interface (spawn/detectFailure/retry)
// ===========================================================================
describe('codex adapter interface', () => {
  let spawn, detectFailure, retry, resolveTier, resolveRole

  before(async () => {
    const mod = await import('../../adapters/codex-adapter.mjs')
    spawn = mod.spawn
    detectFailure = mod.detectFailure
    retry = mod.retry
    resolveTier = mod.resolveTier
    resolveRole = mod.resolveRole
  })

  test('resolveTier returns model and effort for each tier', () => {
    const j = resolveTier('judgment')
    assert.equal(j.model, 'o3')
    assert.ok(j.effort)
    const w = resolveTier('worker')
    assert.equal(w.model, 'gpt-5.6')
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
    assert.equal(report._codex, true)
    assert.equal(report._role, 'developer')
    assert.equal(report._tier, 'worker')
    assert.equal(report._model, 'gpt-5.6')
  })

  test('detectFailure identifies null, error, and empty reports', () => {
    assert.equal(detectFailure(null), true)
    assert.equal(detectFailure(undefined), true)
    assert.equal(detectFailure({ error: 'something' }), true)
    assert.equal(detectFailure(''), true)
    assert.equal(detectFailure({ verdict: 'approve' }), false)
  })

  test('retry re-dispatches on the fallback tier and marks the report', async () => {
    const report = await retry(
      'original task',
      { tier: 'judgment', role: 'reviewer' },
      'worker'
    )
    assert.ok(report)
    assert.ok(report.modelFallback, 'retry must set modelFallback')
    assert.ok(report.modelFallback.includes('->'))
    // judgment=o3 -> worker=gpt-5.6
    assert.ok(report.modelFallback.includes('o3'))
    assert.ok(report.modelFallback.includes('gpt-5.6'))
  })
})

// ===========================================================================
// 3. Workflow renderer (dry-run)
// ===========================================================================
describe('codex workflow renderer', () => {
  let renderWorkflow

  before(async () => {
    const mod = await import('../../adapters/codex-renderer.mjs')
    renderWorkflow = mod.renderWorkflow
  })

  for (const wf of ['tm-review-changes', 'tm-review-codebase', 'tm-map-codebase']) {
    test(`${wf}: renderer produces a report from the JSON spec`, async () => {
      const report = await renderWorkflow(wf, {})
      assert.ok(report)
      assert.equal(report._dryRun, true)
      assert.equal(report._tier, 'judgment')
    })
  }
})

// ===========================================================================
// 4. TOML personas
// ===========================================================================
describe('codex TOML personas', () => {
  const expectedRoles = [
    'architect', 'developer', 'docs-writer', 'fact-checker',
    'perf-investigator', 'reviewer', 'tester',
  ]

  test('personas directory exists', () => {
    assert.ok(existsSync(personasDir))
  })

  for (const role of expectedRoles) {
    test(`${role}.toml exists`, () => {
      assert.ok(
        existsSync(join(personasDir, `${role}.toml`)),
        `missing persona: ${role}.toml`
      )
    })

    test(`${role}.toml has description, jobs, report_contract, constraints`, () => {
      const content = readFileSync(join(personasDir, `${role}.toml`), 'utf8')
      assert.ok(content.includes('description ='), `${role}.toml missing description`)
      assert.ok(content.includes('jobs ='), `${role}.toml missing jobs`)
      assert.ok(content.includes('report_contract ='), `${role}.toml missing report_contract`)
      assert.ok(content.includes('constraints ='), `${role}.toml missing constraints`)
    })

    test(`${role}.toml does not hardcode a model or effort`, () => {
      const content = readFileSync(join(personasDir, `${role}.toml`), 'utf8')
      // Personas must not carry model or effort; those are resolved from
      // the adapter table at dispatch time (issue #316 acceptance criterion).
      assert.ok(
        !content.includes('model =') && !content.includes('effort ='),
        `${role}.toml must not hardcode model or effort; resolve from codex.json`
      )
    })
  }

  test('persona count matches role count', () => {
    const tomlFiles = readdirSync(personasDir).filter((f) => f.endsWith('.toml'))
    assert.equal(tomlFiles.length, expectedRoles.length)
  })
})
