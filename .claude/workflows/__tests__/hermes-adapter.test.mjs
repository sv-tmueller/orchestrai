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

  test('effort ceiling and forbidden efforts match the Hermes local-model policy', () => {
    // Self-hosted vLLM models: no token-cost ceiling, so max effort is
    // allowed. Paid-API hosts (claude-code.json, codex.json) keep the
    // xhigh ceiling and forbid max; this table intentionally diverges.
    assert.equal(hermesTable.effort_ceiling, 'max')
    assert.deepEqual(hermesTable.forbidden_efforts, [])
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

  test('tm-map-codebase (dry-run): logs when items_source falls back to the stub', async () => {
    const warnings = []
    const origWarn = console.warn
    console.warn = (msg) => warnings.push(msg)
    try {
      await renderWorkflow('tm-map-codebase', {})
    } finally {
      console.warn = origWarn
    }
    const stageStartLine = warnings.find((w) => w.includes('stage: area_map (tier:'))
    assert.ok(stageStartLine, 'expected the stage-start log line')
    const stubLines = warnings.filter(
      (w) => w !== stageStartLine && w.includes('area_map') && w.includes('stub')
    )
    assert.equal(stubLines.length, 1, 'expected exactly one distinct stub-fallback log line')
  })

  // Live-mode tests use the subprocess seam (batch #437): HERMES_BIN points
  // at a stub seat that records its -z prompt to a sidecar and answers by
  // role contract. The scout emits a fenced json block; parseReport copies
  // its keys onto the report, so items_source resolves against real data.
  async function runLiveWithStubSeats(workflow, wfArgs) {
    const { writeFileSync, chmodSync, mkdtempSync, readFileSync: rf } =
      await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: pj } = await import('node:path')
    const dir = mkdtempSync(pj(tmpdir(), 'hermes-seat-stub-'))
    const sidecar = pj(dir, 'calls.jsonl')
    const bin = pj(dir, 'hermes-stub.mjs')
    const f = '```'.repeat(1)
    const SCOUT_PAYLOAD = JSON.stringify({
      areas: [
        { name: 'alpha-area', paths: ['alpha/'], why: 'core' },
        { name: 'beta-area', paths: ['beta/'], why: 'support' },
      ],
      dropped: [],
    })
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      "const zi = args.indexOf('-z')",
      "const prompt = zi >= 0 ? args[zi + 1] : ''",
      `appendFileSync(${JSON.stringify(sidecar)}, JSON.stringify({ prompt }) + '\\n')`,
      `const f = '${f}'`,
      "let out = 'STATUS: DONE\\n\\n' + f + 'json\\n{}\\n' + f + '\\n'",
      "if (prompt.includes('coherent areas')) {",
      // STATUS satisfies the developer report contract (detectFailure);
      // the json block carries the structured payload downstream.
      `  out = 'STATUS: DONE\\n\\n' + f + 'json\\n' + ${JSON.stringify(SCOUT_PAYLOAD)} + '\\n' + f + '\\n'`,
      '}',
      'process.stdout.write(out)',
    ].join('\n'))
    chmodSync(bin, 0o755)

    const origBin = process.env.HERMES_BIN
    const origDryRun = process.env.DRY_RUN
    const warnings = []
    const origWarn = console.warn
    process.env.HERMES_BIN = bin
    process.env.DRY_RUN = 'false'
    console.warn = (msg) => warnings.push(String(msg))
    try {
      await renderWorkflow(workflow, wfArgs)
    } finally {
      console.warn = origWarn
      process.env.HERMES_BIN = origBin
      process.env.DRY_RUN = origDryRun
    }
    const calls = []
    for (const line of rf(sidecar, 'utf8').trim().split('\n').filter(Boolean)) {
      calls.push(JSON.parse(line))
    }
    return { calls, warnings }
  }

  test('tm-map-codebase: area_map stage receives the real scout areas, not the stub', async () => {
    const { calls, warnings } = await runLiveWithStubSeats('tm-map-codebase', {})

    const areaMapGoals = calls.map((c) => c.prompt)
      .filter((g) => g.includes('alpha-area') || g.includes('beta-area'))

    assert.equal(areaMapGoals.length, 2, 'expected one dispatch per real scout area')
    assert.ok(areaMapGoals.some((g) => g.includes('alpha-area')), 'missing alpha-area dispatch')
    assert.ok(areaMapGoals.some((g) => g.includes('beta-area')), 'missing beta-area dispatch')
    assert.ok(
      !areaMapGoals.some((g) => g.includes('stub-area')),
      'must not fall back to the stub area when a real scout result is available'
    )
    assert.ok(
      !warnings.some((w) => w.includes('falling back to 1 stub item')),
      'stub fallback log must not fire when the real scout result resolves'
    )
  })

  test('tm-map-codebase: items_cap "args.areas" resolves to the passed args.areas value', async () => {
    const { calls } = await runLiveWithStubSeats('tm-map-codebase', { areas: 1 })

    const areaMapGoals = calls.map((c) => c.prompt)
      .filter((g) => g.includes('alpha-area') || g.includes('beta-area'))
    assert.equal(areaMapGoals.length, 1, 'args.areas = 1 must cap the dispatch at one area')
    assert.ok(areaMapGoals[0].includes('alpha-area'), 'the cap keeps the first area')
  })

  test('tm-review-codebase: area_review stage receives the real scout areas, not the stub', async () => {
    const { calls } = await runLiveWithStubSeats('tm-review-codebase', {})

    // architecture_review shares the same schema but never carries an area
    // name in its prompt, so filter by area name.
    const areaGoals = calls.map((c) => c.prompt)
      .filter((g) => g.includes('alpha-area') || g.includes('beta-area'))

    assert.equal(areaGoals.length, 2, 'expected one dispatch per real scout area')
    assert.ok(!areaGoals.some((g) => g.includes('stub-area')))
  })
})
