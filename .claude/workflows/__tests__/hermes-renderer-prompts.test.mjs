/**
 * Hermes renderer prompts test (issue #335).
 *
 * Verifies that the Hermes workflow renderer loads the real prompt
 * templates from .claude/workflows/prompts/<name>.prompts.json and
 * interpolates them at render time, instead of emitting the old
 * "Stage: ${name}. Phase: ..." placeholder strings. Also confirms all
 * 3 workflows produce structurally-valid reports in dry-run mode with
 * the real prompts.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

const RENDERER_PATH = '../../adapters/hermes-renderer.mjs'

describe('hermes renderer loads real prompt templates', () => {
  let loadPrompts
  let renderTemplate

  before(async () => {
    const mod = await import(RENDERER_PATH)
    loadPrompts = mod.loadPrompts
    renderTemplate = mod.renderTemplate
  })

  for (const wf of [
    'tm-review-changes',
    'tm-review-codebase',
    'tm-map-codebase',
  ]) {
    test(`${wf}.prompts.json loads and has stage keys`, () => {
      const prompts = loadPrompts(wf)
      assert.ok(
        typeof prompts === 'object' && prompts !== null,
        `${wf}: prompts is not an object`
      )
      const keys = Object.keys(prompts)
      assert.ok(keys.length >= 2, `${wf}: expected at least 2 stages, got ${keys.length}`)
      for (const k of keys) {
        assert.equal(
          typeof prompts[k],
          'string',
          `${wf}: prompt for stage "${k}" is not a string`
        )
      }
    })
  }

  test('renderTemplate fills known slots', () => {
    const out = renderTemplate('Hello {{name}}, {{greeting}}.', {
      name: 'world',
      greeting: 'hi',
    })
    assert.equal(out, 'Hello world, hi.')
  })

  test('renderTemplate substitutes stubs for runtime-only slots', () => {
    // coverageNote and rawFindings are runtime-only; the renderer stubs
    // them so the dry-run prompt is real without live stage data.
    const out = renderTemplate('{{coverageNote}} Raw: {{rawFindings}}', {})
    assert.equal(out, ' Raw: []')
  })

  test('renderTemplate drops unknown slots to empty', () => {
    const out = renderTemplate('[{{totally_unknown_slot}}]', {})
    assert.equal(out, '[]')
  })
})

describe('hermes renderer produces real, non-placeholder prompts', () => {
  let renderWorkflow
  let loadPrompts
  let renderTemplate

  before(async () => {
    process.env.DRY_RUN = 'true'
    const mod = await import(RENDERER_PATH)
    renderWorkflow = mod.renderWorkflow
    loadPrompts = mod.loadPrompts
    renderTemplate = mod.renderTemplate
  })

  // Distinctive substrings taken from the real prompt templates in the
  // JSON files. If the renderer emitted the old "Stage: ${name}."
  // placeholder, none of these would appear.
  const REAL_FRAGMENTS = {
    'tm-review-changes': {
      review: 'You review one dimension of a code change',
      consolidate: 'You are the senior reviewer.',
    },
    'tm-review-codebase': {
      scout: 'You map a repository into coherent review areas.',
      area_review: 'You review one area of a codebase',
      architecture_review: "You audit a repository's structure",
      consolidate: 'You are the senior reviewer consolidating a full-codebase review.',
    },
    'tm-map-codebase': {
      scout: 'You map a repository into coherent areas for a codebase map',
      area_map: 'You map one area of a codebase.',
      synthesize: 'You are the senior architect synthesizing a full-codebase map',
    },
  }

  for (const [wf, stages] of Object.entries(REAL_FRAGMENTS)) {
    for (const [stage, fragment] of Object.entries(stages)) {
      test(`${wf}.${stage}: rendered prompt contains real template text`, () => {
        const prompts = loadPrompts(wf)
        const template = prompts[stage]
        assert.ok(typeof template === 'string', `${wf}.${stage}: no template`)
        // Render with stubs only (no live slot values); the static
        // scaffold text must survive regardless of slot substitution.
        const rendered = renderTemplate(template, {})
        assert.ok(
          rendered.includes(fragment),
          `${wf}.${stage}: rendered prompt missing real fragment "${fragment}". Got: ${rendered.slice(0, 120)}...`
        )
        assert.ok(
          !rendered.startsWith('Stage:'),
          `${wf}.${stage}: rendered prompt is still the placeholder. Got: ${rendered.slice(0, 80)}...`
        )
      })
    }
  }

  for (const wf of [
    'tm-review-changes',
    'tm-review-codebase',
    'tm-map-codebase',
  ]) {
    test(`${wf}: renderWorkflow returns a structurally-valid report`, async () => {
      const report = await renderWorkflow(wf, {})
      assert.ok(report, `${wf}: renderer returned no report`)
      assert.equal(report._dryRun, true, `${wf}: report should be dry-run`)
      assert.equal(
        report._tier,
        'judgment',
        `${wf}: final stage should be judgment tier`
      )
    })
  }
})
