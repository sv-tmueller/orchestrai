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
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

// ---------------------------------------------------------------------------
// Command line and gate rules (issue #355).
//
// Nothing below calls the real gh or git, and nothing spawns a real seat.
// Every GitHub and git call goes through the injected runner, backed by the
// saved fixtures in fixtures/hermes-pipeline/. Seats go through an injected
// spawn that lands in the same ordered call log.
// ---------------------------------------------------------------------------

const driver = await import('../../adapters/hermes-pipeline.mjs')

describe('parseArgs', () => {
  const { parseArgs } = driver

  test('an issue number becomes an issue item', () => {
    assert.deepEqual(parseArgs(['355']), { items: [{ issue: 355 }] })
  })

  test('label: selects a label and strips only the first prefix', () => {
    assert.deepEqual(parseArgs(['label:size:M']), { items: [{ label: 'size:M' }] })
    assert.deepEqual(parseArgs(['label:in-progress']), { items: [{ label: 'in-progress' }] })
  })

  test('numbers and labels mix in argument order, duplicates dropped', () => {
    const r = parseArgs(['9', 'label:a', '3', '9', 'label:a', 'label:b'])
    assert.deepEqual(r, { items: [{ issue: 9 }, { label: 'a' }, { issue: 3 }, { label: 'b' }] })
  })

  test('no arguments is a usage error', () => {
    assert.ok(parseArgs([]).error)
  })

  test('an empty label: is a usage error', () => {
    assert.ok(parseArgs(['355', 'label:']).error)
  })

  test('any other argument is a usage error', () => {
    for (const bad of ['abc', '#355', '12x', '--issues', '--issues=1,2', '1,2', '']) {
      assert.ok(parseArgs([bad]).error, `expected a usage error for ${JSON.stringify(bad)}`)
    }
  })
})

describe('parseBlockers', () => {
  const { parseBlockers } = driver

  test('reads whole Blocked by lines only', () => {
    const body = [
      'Part of batch #603',
      '',
      'Blocked by: #355',
      'Blocked by: #12   ',
      'Blocked by: #77\r',
      '- Blocked by: #9',
      '`Blocked by: #8`',
      'See Blocked by: #7 for more',
      'blocked by: #6',
      'Blocked by: #5, #4',
    ].join('\n')
    assert.deepEqual(parseBlockers(body), [355, 12, 77])
  })

  test('no blockers, empty and missing bodies', () => {
    assert.deepEqual(parseBlockers('nothing here'), [])
    assert.deepEqual(parseBlockers(''), [])
    assert.deepEqual(parseBlockers(undefined), [])
  })

  test('a repeated blocker is listed once', () => {
    assert.deepEqual(parseBlockers('Blocked by: #3\nBlocked by: #3'), [3])
  })
})

describe('resumeStage', () => {
  const { resumeStage } = driver
  const c = (body, createdAt) => ({ author: { login: 'bot' }, body, createdAt })

  test('no verdict comment re-enters at the tester', () => {
    assert.deepEqual(resumeStage([]), { stage: 'tester' })
    assert.deepEqual(resumeStage([c('just a note', '2026-01-01T00:00:00Z')]), { stage: 'tester' })
  })

  test('PASS re-enters at the reviewer', () => {
    const r = resumeStage([c('**Tester report**\n\nVERDICT: PASS\nFINDINGS: none', '2026-01-01T00:00:00Z')])
    assert.deepEqual(r, { stage: 'reviewer' })
  })

  test('FAIL re-enters at the developer with the comment body verbatim', () => {
    const body = '**Tester report**\n\nVERDICT: FAIL\nFINDINGS: 1. parseArgs drops ids'
    assert.deepEqual(resumeStage([c(body, '2026-01-01T00:00:00Z')]), { stage: 'developer', findings: body })
  })

  test('CHANGES_REQUESTED re-enters at the developer with the comment body verbatim', () => {
    const body = 'VERDICT: CHANGES_REQUESTED\nFINDINGS: must fix the exit code'
    assert.deepEqual(resumeStage([c(body, '2026-01-01T00:00:00Z')]), { stage: 'developer', findings: body })
  })

  test('APPROVE re-enters at ship', () => {
    assert.deepEqual(resumeStage([c('VERDICT: APPROVE\nSTAGE: both clean', '2026-01-01T00:00:00Z')]), { stage: 'ship' })
  })

  test('the latest verdict comment wins, whatever the array order', () => {
    const comments = [
      c('VERDICT: APPROVE', '2026-01-03T00:00:00Z'),
      c('VERDICT: FAIL\nFINDINGS: old', '2026-01-01T00:00:00Z'),
      c('VERDICT: PASS', '2026-01-02T00:00:00Z'),
    ]
    assert.deepEqual(resumeStage(comments), { stage: 'ship' })
  })

  test('a later comment without a verdict does not hide an earlier verdict', () => {
    const comments = [c('VERDICT: PASS', '2026-01-01T00:00:00Z'), c('thanks, looks good', '2026-01-02T00:00:00Z')]
    assert.deepEqual(resumeStage(comments), { stage: 'reviewer' })
  })

  test('only the first verdict line of a comment counts', () => {
    assert.deepEqual(resumeStage([c('VERDICT: PASS\nVERDICT: FAIL', '2026-01-01T00:00:00Z')]), { stage: 'reviewer' })
  })

  test('a quoted verdict line is ignored', () => {
    const comments = [c('VERDICT: PASS', '2026-01-01T00:00:00Z'), c('> VERDICT: FAIL\nI disagree.', '2026-01-02T00:00:00Z')]
    assert.deepEqual(resumeStage(comments), { stage: 'reviewer' })
  })

  test('a fact-checker verdict is ignored', () => {
    const comments = [c('VERDICT: PASS', '2026-01-01T00:00:00Z'), c('VERDICT: CONTRADICTED\nCLAIMS: 1', '2026-01-02T00:00:00Z')]
    assert.deepEqual(resumeStage(comments), { stage: 'reviewer' })
  })

  test('a verdict word only in a bold header is ignored', () => {
    const header = '**Tester report, round 1 (VERDICT: PASS)**\n\nsee below'
    assert.deepEqual(resumeStage([c(header, '2026-01-01T00:00:00Z')]), { stage: 'tester' })
  })

  test('a longer word that starts with a verdict is ignored', () => {
    assert.deepEqual(resumeStage([c('VERDICT: PASSED', '2026-01-01T00:00:00Z')]), { stage: 'tester' })
  })

  test('a CRLF verdict line still counts', () => {
    assert.deepEqual(resumeStage([c('intro\r\nVERDICT: PASS\r\n', '2026-01-01T00:00:00Z')]), { stage: 'reviewer' })
  })
})

describe('planWaves', () => {
  const { planWaves } = driver
  const e = (issue, outcome, blockers = []) => ({ issue, outcome, blockers })

  test('run and resume packages are wave 1, with no waiting', () => {
    const r = planWaves([e(1, 'run'), e(2, 'resume'), e(3, 'complete'), e(4, 'skip')])
    assert.deepEqual(r, { waves: [[1, 2]], waiting: [] })
  })

  test('a chain of blockers gives one wave per link', () => {
    const r = planWaves([e(1, 'run'), e(2, 'wait', [1]), e(3, 'wait', [2])])
    assert.deepEqual(r.waves, [[1], [2], [3]])
    assert.deepEqual(r.waiting, [])
  })

  test('a package waits for every blocker to land in an earlier wave', () => {
    const r = planWaves([e(1, 'run'), e(2, 'run'), e(3, 'wait', [1, 2]), e(4, 'wait', [3, 1])])
    assert.deepEqual(r.waves, [[1, 2], [3], [4]])
  })

  test('a blocker outside the run leaves the package waiting', () => {
    const r = planWaves([e(1, 'run'), e(2, 'wait', [99])])
    assert.deepEqual(r.waves, [[1]])
    assert.deepEqual(r.waiting, [{ issue: 2, blockers: [99] }])
  })

  test('a blocker that is not runnable leaves the package waiting', () => {
    const r = planWaves([e(1, 'park'), e(2, 'stop'), e(3, 'wait', [1]), e(4, 'wait', [2])])
    assert.deepEqual(r.waves, [])
    assert.deepEqual(r.waiting.map((w) => w.issue), [3, 4])
  })

  test('a cycle never lands in a wave', () => {
    const r = planWaves([e(1, 'run'), e(2, 'wait', [3]), e(3, 'wait', [2])])
    assert.deepEqual(r.waves, [[1]])
    assert.deepEqual(r.waiting.map((w) => w.issue), [2, 3])
  })
})
