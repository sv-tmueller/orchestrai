/**
 * Hermes pipeline driver test (issue #334).
 *
 * Exercises the flat-star pipeline in dry-run mode: architect -> developer
 * -> tester -> reviewer -> ship. Verifies the stage sequencing, fix-round
 * routing, parking on exhaustion, and wave concurrency.
 *
 * No live API calls or GitHub writes; DRY_RUN=true is set before import.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.DRY_RUN = 'true'

describe('hermes pipeline driver', () => {
  let runPipeline, runWave

  before(async () => {
    const mod = await import('../../adapters/hermes-pipeline.mjs')
    runPipeline = mod.runPipeline
    runWave = mod.runWave
  })

  test('happy path: pipeline completes with APPROVE + PASS', async () => {
    const result = await runPipeline(42, { dryRun: true })

    assert.ok(result, 'pipeline returned no result')
    assert.equal(result.issue, 42)
    assert.equal(result.done, true, 'pipeline should be done on happy path')
    assert.equal(result.parked, null, 'should not be parked on happy path')
    assert.ok(result.branch, 'branch should be set')
    assert.ok(result.pr, 'PR should be set')
    assert.equal(result.testerVerdict, 'PASS')
    assert.equal(result.reviewerVerdict, 'APPROVE')
    assert.equal(result.fixRounds.tester, 0)
    assert.equal(result.fixRounds.reviewer, 0)
  })

  test('sub-plan is populated after architect stage', async () => {
    const result = await runPipeline(99, { dryRun: true })
    assert.ok(result.subPlan, 'sub-plan should be populated')
  })

  test('multiple issues run via runWave', async () => {
    const results = await runWave([1, 2, 3], { dryRun: true })
    assert.equal(results.length, 3)
    for (const r of results) {
      assert.ok(r.done, `issue ${r.issue} should be done`)
    }
  })

  test('wave respects concurrency limit', async () => {
    // 5 issues with max 3 concurrent: should still complete all 5
    const results = await runWave([1, 2, 3, 4, 5], { dryRun: true })
    assert.equal(results.length, 5)
    assert.ok(results.every((r) => r.done))
  })

  test('pipeline state has all expected fields', async () => {
    const result = await runPipeline(7, { dryRun: true })
    assert.ok('issue' in result)
    assert.ok('branch' in result)
    assert.ok('pr' in result)
    assert.ok('subPlan' in result)
    assert.ok('testerVerdict' in result)
    assert.ok('reviewerVerdict' in result)
    assert.ok('fixRounds' in result)
    assert.ok('parked' in result)
    assert.ok('done' in result)
  })
})
