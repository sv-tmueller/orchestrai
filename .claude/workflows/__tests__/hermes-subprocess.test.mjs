/**
 * Hermes subprocess adapter test (issue #351).
 *
 * The adapter spawns each seat as a `hermes` subprocess rather than via
 * delegate_task, so every binding the tier abstraction declares (model,
 * provider, effort, tool surface) is actually applied. These tests cover
 * the offline verification steps in
 * docs/superpowers/specs/2026-09-16-hermes-subprocess-adapter-design.md
 * section 7: argv construction, report parsing, failure detection, and
 * the within-tier retry ladder.
 *
 * No live API calls. The argv builder is a pure function and the parser
 * runs against recorded stdout fixtures.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')

process.env.DRY_RUN = 'true'

const hermesTable = JSON.parse(readFileSync(join(adaptersDir, 'hermes.json'), 'utf8'))
const claudeTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))

const ALL_ROLES = [
  'architect', 'developer', 'tester', 'reviewer',
  'fact-checker', 'docs-writer', 'perf-investigator',
]

// Recorded stdout per role, matching the report contracts in
// docs/architecture/role-contracts.md. These are fixtures, not live output.
const FIXTURES = {
  architect: 'SUB_PLAN\n\nApproach: extend the table.\nFiles: hermes.json\nOrder: table, then adapter.\nVerification: npm test',
  developer: [
    'Implemented per the sub-plan.',
    '',
    'STATUS: DONE',
    'BRANCH: feat/351-hermes-subprocess-spawn',
    'PR: https://github.com/sv-tmueller/orchestrai/pull/354',
    'CHECKS: `npm test` -> 0',
    'DEVIATIONS: none',
    'NOTES: none',
  ].join('\n'),
  tester: [
    'VERDICT: PASS',
    'COMMIT: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    'FINDINGS: none',
    'UNTESTED CLAIMS: none',
  ].join('\n'),
  reviewer: [
    'VERDICT: CHANGES_REQUESTED',
    'STAGE: quality',
    'FINDINGS: 1. hermes-adapter.mjs:42 must-fix, unchecked exit code.',
  ].join('\n'),
  'fact-checker': [
    'VERDICT: GROUNDED',
    'COMMIT: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    'CLAIMS:',
    '  1. "301 tests pass"',
    '     STATUS: VERIFIED',
    '     EVIDENCE: npm test -> # pass 301',
    'SUMMARY: 1 verified, 0 contradicted, 0 unverified, 0 labeled',
  ].join('\n'),
  'docs-writer': [
    'FILES:',
    '  1. README.md - updated - document the subprocess adapter',
    'GAPS_NOT_FILLED: none',
    'ASSUMPTIONS: none',
  ].join('\n'),
  'perf-investigator': [
    'BASELINE:',
    '  1. npm test wall clock',
    '     COMMAND: npm test',
    '     RUNS: 64ms, 66ms, 65ms',
    'BOTTLENECK: none found',
    'TARGET: under 100ms, read by npm test',
    'RE-MEASURE: npm test',
  ].join('\n'),
}

// ===========================================================================
// 1. Adapter table: provider, fallback model, seats
// ===========================================================================
describe('hermes adapter table: subprocess bindings', () => {
  test('every tier declares a provider', () => {
    for (const [tier, cfg] of Object.entries(hermesTable.tiers)) {
      assert.ok(cfg.provider, `tier "${tier}" missing provider`)
    }
  })

  test('every tier declares a fallback model distinct from its model', () => {
    for (const [tier, cfg] of Object.entries(hermesTable.tiers)) {
      assert.ok(cfg.fallback_model, `tier "${tier}" missing fallback_model`)
      assert.notEqual(
        cfg.fallback_model, cfg.model,
        `tier "${tier}" fallback_model must differ from its model, else retry is a re-roll`
      )
    }
  })

  test('every role has a seat with a non-empty toolset', () => {
    for (const role of ALL_ROLES) {
      const seat = hermesTable.seats?.[role]
      assert.ok(seat, `missing seat for role "${role}"`)
      assert.ok(
        Array.isArray(seat.toolsets) && seat.toolsets.length > 0,
        `seat "${role}" needs a non-empty toolsets array`
      )
    }
  })

  test('no seat gets the delegation toolset, which enforces flat-star', () => {
    for (const role of ALL_ROLES) {
      assert.ok(
        !hermesTable.seats[role].toolsets.includes('delegation'),
        `seat "${role}" must not have the delegation toolset: a seat that can ` +
        `re-delegate breaks the flat-star invariant`
      )
    }
  })

  test('every seat can reach the terminal, needed for git and the check suite', () => {
    for (const role of ALL_ROLES) {
      assert.ok(
        hermesTable.seats[role].toolsets.includes('terminal'),
        `seat "${role}" needs the terminal toolset`
      )
    }
  })

  test('forbidden efforts cover both max and ultra', () => {
    // Hermes --reasoning accepts ultra above max; the ceiling is xhigh.
    assert.deepEqual([...hermesTable.forbidden_efforts].sort(), ['max', 'ultra'])
  })

  test('no tier or seat resolves to a forbidden effort', () => {
    for (const [tier, cfg] of Object.entries(hermesTable.tiers)) {
      assert.ok(
        !hermesTable.forbidden_efforts.includes(cfg.effort),
        `tier "${tier}" uses forbidden effort "${cfg.effort}"`
      )
    }
  })

  test('unverified model ids are flagged so the open question is not lost', () => {
    const unverified = hermesTable._unverified_model_ids
    assert.ok(unverified, 'table must carry an _unverified_model_ids map')
    // Every flagged id must explain itself and cite the issue.
    for (const [id, note] of Object.entries(unverified)) {
      assert.match(
        note, /#\d+/,
        `unverified id "${id}" must cite the issue that tracks its confirmation`
      )
    }
  })

  test('the Claude Code table declares no fallback_model, keeping cross-tier retry', () => {
    for (const [tier, cfg] of Object.entries(claudeTable.tiers)) {
      assert.equal(
        cfg.fallback_model, undefined,
        `Claude Code tier "${tier}" must not declare fallback_model: its ladder ` +
        `is cross-tier (opus to sonnet) and must stay unchanged`
      )
    }
  })
})

// ===========================================================================
// 2. Argv construction
// ===========================================================================
describe('buildArgv', () => {
  let buildArgv, resolveTier

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    buildArgv = mod.buildArgv
    resolveTier = mod.resolveTier
  })

  // Read a flag's value out of an argv array.
  const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]

  test('passes the prompt as the -z oneshot argument', () => {
    const argv = buildArgv('developer', 'do the thing', { cwd: '/tmp/wt' })
    assert.ok(argv.includes('-z'))
    assert.equal(valueOf(argv, '-z'), 'do the thing')
  })

  test('pins the model and provider from the role tier', () => {
    const argv = buildArgv('architect', 'p', { cwd: '/tmp/wt' })
    const tier = resolveTier('judgment')
    assert.equal(valueOf(argv, '-m'), tier.model)
    assert.equal(valueOf(argv, '--provider'), tier.provider)
  })

  test('pins effort per tier: judgment xhigh, worker high', () => {
    const judgment = buildArgv('architect', 'p', { cwd: '/tmp/wt' })
    const worker = buildArgv('developer', 'p', { cwd: '/tmp/wt' })
    assert.equal(valueOf(judgment, '--reasoning'), 'xhigh')
    assert.equal(valueOf(worker, '--reasoning'), 'high')
  })

  test('passes the seat toolsets as a comma-separated list', () => {
    const argv = buildArgv('developer', 'p', { cwd: '/tmp/wt' })
    assert.equal(
      valueOf(argv, '-t'),
      hermesTable.seats.developer.toolsets.join(',')
    )
  })

  test('runs in the working directory the driver supplies', () => {
    const argv = buildArgv('tester', 'p', { cwd: '/repo/.worktrees/pkg-42' })
    assert.equal(valueOf(argv, '--in'), '/repo/.worktrees/pkg-42')
  })

  test('never passes -w: the driver owns the worktree', () => {
    for (const role of ALL_ROLES) {
      const argv = buildArgv(role, 'p', { cwd: '/tmp/wt' })
      assert.ok(
        !argv.includes('-w') && !argv.includes('--worktree'),
        `seat "${role}" must not spawn with -w: its atexit cleanup force-removes ` +
        `the worktree and deletes the branch unless commits are pushed`
      )
    }
  })

  test('runs headless without prompting for approval', () => {
    const argv = buildArgv('developer', 'p', { cwd: '/tmp/wt' })
    assert.ok(argv.includes('--yolo'), 'needs --yolo to run without a TTY prompt')
    assert.ok(argv.includes('--accept-hooks'), 'needs --accept-hooks to run headless')
  })

  test('requires a working directory', () => {
    assert.throws(
      () => buildArgv('developer', 'p', {}),
      /working directory/i,
      'a seat with no cwd would run in the driver directory and defeat isolation'
    )
  })

  test('rejects a forbidden effort override', () => {
    assert.throws(
      () => buildArgv('developer', 'p', { cwd: '/tmp/wt', effort: 'ultra' }),
      /ultra/,
      'the effort ceiling is xhigh; ultra and max are forbidden'
    )
  })
})

// ===========================================================================
// 3. Report parsing
// ===========================================================================
describe('parseReport', () => {
  let parseReport

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    parseReport = mod.parseReport
  })

  test('reads the developer status block', () => {
    const r = parseReport('developer', FIXTURES.developer)
    assert.equal(r.STATUS, 'DONE')
    assert.equal(r.BRANCH, 'feat/351-hermes-subprocess-spawn')
    assert.equal(r.PR, 'https://github.com/sv-tmueller/orchestrai/pull/354')
    assert.equal(r.CHECKS, '`npm test` -> 0')
  })

  test('reads the tester verdict including the spaced UNTESTED CLAIMS key', () => {
    const r = parseReport('tester', FIXTURES.tester)
    assert.equal(r.VERDICT, 'PASS')
    assert.equal(r['UNTESTED CLAIMS'], 'none')
  })

  test('reads the reviewer verdict and stage', () => {
    const r = parseReport('reviewer', FIXTURES.reviewer)
    assert.equal(r.VERDICT, 'CHANGES_REQUESTED')
    assert.equal(r.STAGE, 'quality')
  })

  test('reads the architect opener as the report kind', () => {
    const r = parseReport('architect', FIXTURES.architect)
    assert.equal(r.KIND, 'SUB_PLAN')
  })

  test('reads a NEEDS_DECISION architect report and keeps the question', () => {
    const out = 'NEEDS_DECISION: worktree per package or per seat?\n\nBoth readings are defensible.'
    const r = parseReport('architect', out)
    assert.equal(r.KIND, 'NEEDS_DECISION')
    assert.equal(r.NEEDS_DECISION, 'worktree per package or per seat?')
  })

  test('reads the perf-investigator RE-MEASURE key, which contains a hyphen', () => {
    const r = parseReport('perf-investigator', FIXTURES['perf-investigator'])
    assert.equal(r['RE-MEASURE'], 'npm test')
    assert.equal(r.BOTTLENECK, 'none found')
  })

  test('reads the docs-writer and fact-checker reports', () => {
    assert.equal(parseReport('fact-checker', FIXTURES['fact-checker']).VERDICT, 'GROUNDED')
    assert.equal(parseReport('docs-writer', FIXTURES['docs-writer']).GAPS_NOT_FILLED, 'none')
  })

  test('keeps the raw text alongside the parsed fields', () => {
    const r = parseReport('tester', FIXTURES.tester)
    assert.equal(r.raw, FIXTURES.tester)
  })

  test('ignores prose before the report block', () => {
    const r = parseReport('developer', FIXTURES.developer)
    assert.equal(r.STATUS, 'DONE', 'the leading prose line must not break parsing')
  })
})

// ===========================================================================
// 4. Failure detection
// ===========================================================================
describe('detectFailure', () => {
  let detectFailure

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    detectFailure = mod.detectFailure
  })

  test('a clean run with a parseable report is not a failure', () => {
    assert.equal(
      detectFailure({ code: 0, stdout: FIXTURES.tester, stderr: '' }, 'tester'),
      false
    )
  })

  test('a nonzero exit code is a failure', () => {
    assert.equal(detectFailure({ code: 1, stdout: FIXTURES.tester, stderr: '' }, 'tester'), true)
  })

  test('empty stdout is a failure', () => {
    assert.equal(detectFailure({ code: 0, stdout: '   ', stderr: '' }, 'tester'), true)
  })

  test('an HTTP error from the provider is a failure', () => {
    assert.equal(
      detectFailure({ code: 0, stdout: 'HTTP 403: Virtual key has expired', stderr: '' }, 'tester'),
      true
    )
  })

  test('a report missing its required field is a failure', () => {
    assert.equal(
      detectFailure({ code: 0, stdout: 'I had a look and it seems fine.', stderr: '' }, 'tester'),
      true,
      'a tester report with no VERDICT must not pass downstream as a PASS'
    )
  })

  test('null and error shapes stay failures, as before', () => {
    assert.equal(detectFailure(null), true)
    assert.equal(detectFailure(undefined), true)
    assert.equal(detectFailure({ error: 'boom' }), true)
    assert.equal(detectFailure(''), true)
  })
})

// ===========================================================================
// 5. Within-tier retry
// ===========================================================================
describe('retry ladder', () => {
  let resolveRetryTarget

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    resolveRetryTarget = mod.resolveRetryTarget
  })

  test('a tier with a fallback_model retries within tier', () => {
    const target = resolveRetryTarget(hermesTable, 'judgment')
    assert.equal(target.tier, 'judgment', 'must stay in tier')
    assert.equal(target.model, hermesTable.tiers.judgment.fallback_model)
    assert.equal(
      target.effort, hermesTable.tiers.judgment.effort,
      'a within-tier fallback keeps the tier effort'
    )
  })

  test('a tier without a fallback_model falls back across tiers', () => {
    const target = resolveRetryTarget(claudeTable, 'judgment')
    assert.equal(target.tier, 'worker', 'Claude Code keeps the opus to sonnet ladder')
    assert.equal(target.model, claudeTable.tiers.worker.model)
  })

  test('a worker failure with no lower tier has nowhere to go', () => {
    const target = resolveRetryTarget(claudeTable, 'worker')
    assert.equal(
      target, null,
      'the stage fix-cap rules handle this; there is no lower tier to reach'
    )
  })
})

// ===========================================================================
// 6. Unverified model ids surface on failure
// ===========================================================================
describe('modelIdHint', () => {
  let modelIdHint

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    modelIdHint = mod.modelIdHint
  })

  test('explains a failure on a model id that was never confirmed', () => {
    const [unverifiedId] = Object.keys(hermesTable._unverified_model_ids)
    const hint = modelIdHint(unverifiedId)
    assert.ok(hint, `expected a hint for the unverified id "${unverifiedId}"`)
    assert.match(hint, /#\d+/, 'the hint must cite the tracking issue')
  })

  test('says nothing about a model id that is confirmed', () => {
    assert.equal(modelIdHint('vllm/release/glm-5-2'), null)
  })
})

// ===========================================================================
// 7. Driver-owned worktrees
// ===========================================================================
describe('worktreePlan', () => {
  let worktreePlan

  before(async () => {
    const mod = await import('../../adapters/hermes-pipeline.mjs')
    worktreePlan = mod.worktreePlan
  })

  test('names the branch by the repo convention, not a UUID', () => {
    const plan = worktreePlan('/repo', 42, 'hermes-subprocess-spawn')
    assert.equal(
      plan.branch, 'feat/42-hermes-subprocess-spawn',
      'the branch must follow <type>/<issue>-<slug> from process-core.md'
    )
  })

  test('puts the worktree under .worktrees, keyed by issue', () => {
    const plan = worktreePlan('/repo', 42, 'some-slug')
    assert.equal(plan.path, '/repo/.worktrees/pkg-42')
  })

  test('two packages get two distinct worktrees', () => {
    const a = worktreePlan('/repo', 42, 'a')
    const b = worktreePlan('/repo', 43, 'b')
    assert.notEqual(a.path, b.path)
    assert.notEqual(a.branch, b.branch)
  })

  test('honours a fix branch type', () => {
    const plan = worktreePlan('/repo', 9, 'broken-thing', { type: 'fix' })
    assert.equal(plan.branch, 'fix/9-broken-thing')
  })
})

describe('pipeline threads a working directory to every seat', () => {
  let runPipeline

  before(async () => {
    const mod = await import('../../adapters/hermes-pipeline.mjs')
    runPipeline = mod.runPipeline
  })

  test('every dispatched seat receives the package worktree as its cwd', async () => {
    const result = await runPipeline(42, { dryRun: true, repoRoot: '/repo' })
    assert.ok(result.dispatches.length > 0, 'expected the pipeline to dispatch seats')
    for (const d of result.dispatches) {
      assert.equal(
        d.cwd, '/repo/.worktrees/pkg-42',
        `seat "${d.role}" ran in "${d.cwd}" instead of the package worktree; ` +
        `a seat with no cwd runs in the driver directory and defeats isolation`
      )
    }
  })

  test('records the worktree and branch on the pipeline state', async () => {
    const result = await runPipeline(42, { dryRun: true, repoRoot: '/repo' })
    assert.equal(result.worktree, '/repo/.worktrees/pkg-42')
    assert.match(result.branch, /^feat\/42-/)
  })
})

// ===========================================================================
// 8. Workflow renderer stage bindings
// ===========================================================================
describe('renderer stageOpts', () => {
  let stageOpts

  before(async () => {
    const mod = await import('../../adapters/hermes-renderer.mjs')
    stageOpts = mod.stageOpts
  })

  test('gives every workflow stage the repo root as its working directory', () => {
    const opts = stageOpts({ tier: 'worker' }, 'review', '/repo')
    assert.equal(
      opts.cwd, '/repo',
      'a workflow stage with no cwd cannot spawn: buildArgv requires one'
    )
  })

  test('carries the stage tier and the inferred role', () => {
    const opts = stageOpts({ tier: 'judgment' }, 'consolidate', '/repo')
    assert.equal(opts.tier, 'judgment')
    assert.ok(opts.role, 'the role is needed for report parsing and failure detection')
  })
})
