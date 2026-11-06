/**
 * Claude Code subprocess seat adapter test (issue #453).
 *
 * The adapter spawns each seat as its own headless `claude -p` session
 * rather than an in-process Agent tool call, so a pipeline seat gets its
 * own model, endpoint, and effort pin in its own process. These tests
 * cover the offline verification for that mechanism: table resolution
 * with per-role overrides, command and environment composition, report
 * parsing, failure classification, the respawn-once-then-park retry, the
 * per-seat timeout, and per-dispatch token capture.
 *
 * No live `claude` install and no endpoint: CLAUDE_BIN points at a stub
 * this file writes, the same seam the Hermes adapter uses with
 * HERMES_BIN.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')

// Pin the table the adapter loads before its dynamic import. The split
// table is the one with a per-role override, which is what this file
// exercises; claude-code.json's in-process default is asserted directly
// from the JSON below. node --test runs each file in its own process, so
// selecting the table here cannot leak into other test files.
process.env.CLAUDE_CODE_ADAPTER_TABLE = 'claude-code-split.json'
process.env.DRY_RUN = 'false'

const splitTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code-split.json'), 'utf8'))
const vllmTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code-vllm.json'), 'utf8'))

// Read a flag's value out of an argv array.
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1]

// ---------------------------------------------------------------------------
// The stub `claude` binary. It answers by STUB_MODE so a test can drive the
// real failure classes without a network call. Every invocation appends
// {argv, cwd, env} to the sidecar so composition is assertable.
// ---------------------------------------------------------------------------
function stubScript(sidecar) {
  return [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(sidecar)}, JSON.stringify({`,
    '  argv: args,',
    '  cwd: process.cwd(),',
    '  alwaysEffort: process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT,',
    '  bgCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,',
    '}) + "\\n")',
    "const mode = process.env.STUB_MODE || 'ok'",
    "const prompt = args[args.indexOf('-p') + 1] || ''",
    "if (mode === 'sleep') { setTimeout(() => process.exit(0), 30000); }",
    "else if (mode === 'empty') { process.exit(0) }",
    "else if (mode === 'exit1') { process.stderr.write('boom\\n'); process.exit(1) }",
    "else if (mode === 'fail-once' && !prompt.includes('RESPAWN')) {",
    "  process.stdout.write(JSON.stringify({ is_error: true, result: '' }) + '\\n'); process.exit(1)",
    "}",
    "else {",
    '  const text = [',
    "    'STATUS: DONE',",
    "    'BRANCH: feat/453-subprocess-seat-adapter',",
    "    'PR: https://github.com/sv-tmueller/orchestrai/pull/1',",
    "    'CHECKS: `npm test` -> 0',",
    "  ].join('\\n')",
    '  process.stdout.write(JSON.stringify({',
    '    is_error: false,',
    '    result: text,',
    "    total_cost_usd: 1.25,",
    "    usage: { input_tokens: 1000, output_tokens: 250, cache_read_input_tokens: 10 },",
    "  }) + '\\n')",
    '}',
  ].join('\n')
}

let stubDir
let sidecar
let origBin
let origSettings

function setStubEnv(mode, extra = {}) {
  process.env.CLAUDE_BIN = join(stubDir, 'claude-stub.mjs')
  process.env.STUB_MODE = mode
  Object.assign(process.env, extra)
}

function readCalls() {
  if (!existsSync(sidecar)) return []
  return readFileSync(sidecar, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function resetSidecar() {
  writeFileSync(sidecar, '')
}

before(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'claude-seat-stub-'))
  sidecar = join(stubDir, 'calls.jsonl')
  const bin = join(stubDir, 'claude-stub.mjs')
  writeFileSync(bin, stubScript(sidecar))
  chmodSync(bin, 0o755)
  origBin = process.env.CLAUDE_BIN
  origSettings = process.env.CLAUDE_CODE_NORIS_SETTINGS
})

after(() => {
  process.env.CLAUDE_BIN = origBin
  process.env.CLAUDE_CODE_NORIS_SETTINGS = origSettings
  delete process.env.STUB_MODE
  rmSync(stubDir, { recursive: true, force: true })
})

// ===========================================================================
// 1. Table resolution: per-role override beats the tier default
// ===========================================================================
describe('table resolution', () => {
  let resolveSeat, resolveTier

  before(async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    resolveSeat = mod.resolveSeat
    resolveTier = mod.resolveTier
  })

  test('resolves a plain tier string through the tiers map', () => {
    const seat = resolveSeat('tester')
    assert.equal(seat.tier, 'worker')
    assert.equal(seat.model, splitTable.tiers.worker.model)
    assert.equal(seat.effort, splitTable.tiers.worker.effort)
  })

  test('a per-role override beats the tier default', () => {
    const override = splitTable.roles.developer
    const seat = resolveSeat('developer')
    assert.equal(seat.tier, override.tier, 'the override names the tier')
    assert.equal(seat.model, override.model, 'the override model must win')
    assert.equal(seat.effort, override.effort, 'the override effort must win')
    assert.notEqual(
      seat.model, splitTable.tiers[override.tier].model,
      'the fixture is only meaningful when the override differs from the tier default'
    )
  })

  test('a tier still resolves its own model and effort', () => {
    const tier = resolveTier('judgment')
    assert.equal(tier.model, splitTable.tiers.judgment.model)
    assert.equal(tier.effort, splitTable.tiers.judgment.effort)
  })

  test('an unknown role throws instead of returning a silent default', () => {
    assert.throws(() => resolveSeat('nobody'), /nobody/)
  })
})

// ===========================================================================
// 2. Command and environment composition
// ===========================================================================
describe('buildArgv and buildEnv', () => {
  let buildArgv, buildEnv, loadAdapterTable

  before(async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    buildArgv = mod.buildArgv
    buildEnv = mod.buildEnv
    loadAdapterTable = mod.loadAdapterTable
    // The tables name a placeholder; a run expands it from its own
    // environment. Give the suite a profile so most cases can build argv.
    process.env.CLAUDE_CODE_NORIS_SETTINGS = JSON.stringify({ permissions: {} })
  })

  const opts = () => ({ cwd: '/repo/.worktrees/pkg-453' })

  test('runs headless with the prompt on -p and automatic permissions', () => {
    const argv = buildArgv('developer', 'do the thing', opts())
    assert.ok(
      valueOf(argv, '-p').includes('do the thing'),
      'the task reaches the seat on -p, behind the prepended role prompt'
    )
    assert.equal(
      valueOf(argv, '--permission-mode'), 'auto',
      'dontAsk silently denies .claude/ writes and still exits 0'
    )
  })

  test('asks for JSON output so the result and the usage line are parseable', () => {
    const argv = buildArgv('developer', 'p', opts())
    assert.equal(
      valueOf(argv, '--output-format'), 'json',
      'token and cost capture reads the json envelope, not the text stream'
    )
  })

  test('pins --model and --effort explicitly from the resolved seat', () => {
    const argv = buildArgv('developer', 'p', opts())
    assert.equal(valueOf(argv, '--model'), splitTable.roles.developer.model)
    assert.equal(
      valueOf(argv, '--effort'), splitTable.roles.developer.effort,
      'effort never inherits across models, so every pin is explicit'
    )
  })

  test('merges the settings fragment with the tier profile', () => {
    const profile = join(stubDir, 'noris-settings.json')
    writeFileSync(profile, JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } }))
    process.env.CLAUDE_CODE_NORIS_SETTINGS = profile
    const argv = buildArgv('tester', 'p', opts())
    const settings = JSON.parse(valueOf(argv, '--settings'))
    assert.equal(
      settings.permissions.blockReadsOutsideWorkingDirectories, true,
      'the tier profile must survive the merge'
    )
    assert.equal(
      settings.enabledPlugins['orchestrai@orchestrai'], false,
      'the fragment must disable the orchestrai plugin'
    )
    assert.equal(
      settings.enabledPlugins['orchestrai@synced'], false,
      'the account-synced second copy must be disabled too, or it loads silently'
    )
  })

  test('accepts an inline JSON profile as well as a file path', () => {
    process.env.CLAUDE_CODE_NORIS_SETTINGS = JSON.stringify({ permissions: { allow: ['Read'] } })
    const argv = buildArgv('tester', 'p', opts())
    const settings = JSON.parse(valueOf(argv, '--settings'))
    assert.deepEqual(settings.permissions.allow, ['Read'])
    assert.equal(settings.enabledPlugins['orchestrai@orchestrai'], false)
  })

  test('never emits a raw placeholder when the profile env var is unset', () => {
    const saved = process.env.CLAUDE_CODE_NORIS_SETTINGS
    delete process.env.CLAUDE_CODE_NORIS_SETTINGS
    try {
      assert.throws(
        () => buildArgv('tester', 'p', opts()),
        /CLAUDE_CODE_NORIS_SETTINGS/,
        'an unexpanded placeholder must fail loudly, not reach the CLI'
      )
    } finally {
      process.env.CLAUDE_CODE_NORIS_SETTINGS = saved
    }
  })

  test('requires a working directory', () => {
    assert.throws(
      () => buildArgv('developer', 'p', {}),
      /working directory/i,
      'a seat with no cwd would run in the lead directory and defeat isolation'
    )
  })

  test('does not pass --bare, which would drop the repo skills the seats need', () => {
    const argv = buildArgv('developer', 'p', opts())
    assert.ok(
      !argv.includes('--bare'),
      'bare mode skips skills and CLAUDE.md, which a seat needs for its checks'
    )
  })

  test('buildEnv exports the effort and background-wait escapes', () => {
    const env = buildEnv('developer', { PATH: '/usr/bin' })
    assert.equal(
      env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, '1',
      'a custom vllm model ID is not recognized as effort-capable, so effort is dropped without this'
    )
    assert.equal(
      env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0',
      'a phantom background child otherwise hangs a finished-looking run'
    )
    assert.equal(env.PATH, '/usr/bin', 'the base environment must survive')
  })

  test('loadAdapterTable rejects another host and a path-y name', () => {
    assert.throws(() => loadAdapterTable('../adapters/hermes.json'), /bare/)
    assert.throws(() => loadAdapterTable('hermes.json'), /hermes/)
  })
})

// ===========================================================================
// 3. Report parsing from stdout
// ===========================================================================
describe('parseReport', () => {
  let parseReport

  before(async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    parseReport = mod.parseReport
  })

  test('reads the developer status block out of a plain-text report', () => {
    const r = parseReport('developer', 'STATUS: DONE\nBRANCH: feat/1-x\nPR: https://example/1')
    assert.equal(r.STATUS, 'DONE')
    assert.equal(r.BRANCH, 'feat/1-x')
  })

  test('reads a tester verdict', () => {
    const r = parseReport('tester', 'VERDICT: PASS\nCOMMIT: abc\nFINDINGS: none')
    assert.equal(r.VERDICT, 'PASS')
  })

  test('reads the architect opener as the report kind', () => {
    assert.equal(parseReport('architect', 'SUB_PLAN\n\nApproach: x').KIND, 'SUB_PLAN')
    assert.equal(
      parseReport('architect', 'NEEDS_DECISION: which worktree layout?').KIND,
      'NEEDS_DECISION'
    )
  })

  test('keeps the raw text alongside the parsed fields', () => {
    const raw = 'STATUS: DONE'
    assert.equal(parseReport('developer', raw).raw, raw)
  })
})

// ===========================================================================
// 4. Failure classification
// ===========================================================================
describe('detectFailure', () => {
  let detectFailure

  before(async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    detectFailure = mod.detectFailure
  })

  const clean = {
    code: 0,
    stdout: JSON.stringify({ result: 'VERDICT: PASS\nFINDINGS: none' }),
    stderr: '',
  }

  test('a clean contract report is not a failure', () => {
    assert.equal(detectFailure(clean, 'tester'), false)
  })

  test('a clean parsed report object is not a failure', () => {
    // The interface documents the call shape spawn -> detectFailure(report),
    // and a report object carries `raw` plus the parsed contract fields, not
    // a code/stdout pair. Treating it as a raw result reported "empty output".
    const report = { raw: 'STATUS: DONE\nBRANCH: b', STATUS: 'DONE', BRANCH: 'b' }
    assert.equal(detectFailure(report, 'developer'), false)
  })

  test('a report object missing its required contract field is a failure', () => {
    assert.equal(
      detectFailure({ raw: 'looks fine to me' }, 'tester'),
      true,
      'a tester report with no VERDICT must not travel downstream as a PASS'
    )
  })

  test('a nonzero exit code is a failure', () => {
    assert.equal(detectFailure({ ...clean, code: 1 }, 'tester'), true)
  })

  test('empty stdout is a failure', () => {
    assert.equal(detectFailure({ code: 0, stdout: '   ', stderr: '' }, 'tester'), true)
  })

  test('a timing-out run is a failure, flagged as stalled', () => {
    const result = { code: null, timedOut: true, stdout: '', stderr: '' }
    assert.equal(detectFailure(result, 'tester'), true)
  })

  test('a report missing its required contract field is a failure', () => {
    assert.equal(
      detectFailure({ code: 0, stdout: JSON.stringify({ result: 'looks fine to me' }), stderr: '' }, 'tester'),
      true,
      'a tester report with no VERDICT must not travel downstream as a PASS'
    )
  })

  test('an error envelope from the CLI is a failure', () => {
    assert.equal(
      detectFailure({ code: 0, stdout: JSON.stringify({ is_error: true, result: '' }), stderr: '' }, 'tester'),
      true
    )
  })

  test('a provider error in either stream is a failure', () => {
    assert.equal(
      detectFailure({ code: 0, stdout: JSON.stringify({ result: 'HTTP 403: key expired' }), stderr: '' }, 'tester'),
      true
    )
  })

  test('classifyFailure names the failure class', () => {
    // classifyFailure is the retry notice's source: the respawn prompt
    // names what went wrong, so it is worth asserting on directly.
    return import('../../adapters/claude-code-subprocess.mjs').then((mod) => {
      assert.equal(mod.classifyFailure({ code: null, timedOut: true }, 'tester'), 'timeout')
      assert.equal(mod.classifyFailure({ code: 1, stdout: '', stderr: '' }, 'tester'), 'exit 1')
      assert.equal(mod.classifyFailure({ code: 0, stdout: '', stderr: '' }, 'tester'), 'empty output')
    })
  })
})

// ===========================================================================
// 5. Spawn, timeout, and the respawn-once-then-park retry
// ===========================================================================
describe('spawn and retry', () => {
  let spawn, retry, dispatchSeat

  before(async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    spawn = mod.spawn
    retry = mod.retry
    dispatchSeat = mod.dispatchSeat
    process.env.CLAUDE_CODE_NORIS_SETTINGS = JSON.stringify({ permissions: {} })
  })

  test('spawn runs the seat in the package worktree and returns its report', async () => {
    resetSidecar()
    setStubEnv('ok')
    const report = await spawn('developer', 'implement issue 453', { cwd: stubDir })
    assert.equal(report.STATUS, 'DONE')
    const calls = readCalls()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cwd, stubDir, 'the seat must run in the lead-owned package worktree')
    assert.equal(calls[0].alwaysEffort, '1')
    assert.equal(calls[0].bgCeiling, '0')
  })

  test('the spawn -> detectFailure round trip sees a clean report as no failure', async () => {
    resetSidecar()
    setStubEnv('ok')
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    const report = await mod.spawn('developer', 'p', { cwd: stubDir })
    // The pipeline's real call shape: spawn returns the report, and the
    // caller feeds that report straight back into detectFailure.
    assert.equal(mod.detectFailure(report, 'developer'), false)
  })

  test('spawn captures the token and cost line per dispatch', async () => {
    resetSidecar()
    setStubEnv('ok')
    const report = await spawn('developer', 'p', { cwd: stubDir })
    assert.equal(report.usage.inputTokens, 1000)
    assert.equal(report.usage.outputTokens, 250)
    assert.equal(report.usage.cacheReadTokens, 10)
    assert.equal(
      report.usage.priced, false,
      'the developer seat on the split table is a self-hosted vllm model, so it is recorded unpriced'
    )
    assert.equal(
      report.usage.costUsd, null,
      'an unpriced seat has no marginal cost to attribute, so the raw number is dropped'
    )
  })

  test('captureUsage prices a paid endpoint and leaves a self-hosted model unpriced', () => {
    return import('../../adapters/claude-code-subprocess.mjs').then((mod) => {
      const envelope = {
        total_cost_usd: 1.25,
        usage: { input_tokens: 1000, output_tokens: 250, cache_read_input_tokens: 10 },
      }
      const paid = mod.captureUsage(envelope, 'opus')
      assert.equal(paid.costUsd, 1.25, 'a paid endpoint reports its cost')
      assert.equal(paid.priced, true)

      const local = mod.captureUsage(envelope, 'vllm/release/glm-5-3')
      assert.equal(local.costUsd, null, 'self-hosted vllm carries no marginal cost')
      assert.equal(local.priced, false)
      assert.equal(local.inputTokens, 1000, 'the raw counts are still recorded unpriced')
    })
  })

  test('spawn returns null on a nonzero exit', async () => {
    resetSidecar()
    setStubEnv('exit1')
    const report = await spawn('developer', 'p', { cwd: stubDir })
    assert.equal(report, null)
  })

  test('a run past its timeout is killed and treated as stalled', async () => {
    resetSidecar()
    setStubEnv('sleep')
    const started = Date.now()
    const report = await spawn('developer', 'p', { cwd: stubDir, timeoutMs: 300 })
    assert.equal(report, null, 'a timed-out seat has no report')
    assert.ok(
      Date.now() - started < 5000,
      'the timeout must kill the child, not wait for it to finish'
    )
  })

  test('retry issues exactly one respawn, naming the retry in the prompt', async () => {
    resetSidecar()
    // The stub answers only a prompt carrying RESPAWN, so a clean report
    // here proves the respawn prompt differs from the original dispatch.
    setStubEnv('fail-once')
    const report = await retry('p', { role: 'developer', cwd: stubDir })
    assert.ok(report, 'the respawn must produce a report when the endpoint answers')
    assert.equal(report.STATUS, 'DONE')
    const calls = readCalls()
    assert.equal(calls.length, 1, 'retry is the single respawn, not another loop')
    assert.ok(
      calls[0].argv.join(' ').includes('RESPAWN'),
      'the respawn prompt must say this is a retry'
    )
  })

  test('the respawn prompt names the failure, so nothing is re-dispatched unchanged', async () => {
    resetSidecar()
    setStubEnv('exit1')
    const report = await retry('p', { role: 'developer', cwd: stubDir })
    assert.equal(report, null, 'a respawn failure parks')
    const calls = readCalls()
    assert.equal(calls.length, 1, 'exactly one respawn call')
    assert.ok(
      calls[0].argv.join(' ').includes('RESPAWN'),
      'the respawn prompt names the retry, so it is never the unchanged prompt'
    )
  })

  test('dispatchSeat composes spawn plus retry and reports the park', async () => {
    resetSidecar()
    setStubEnv('exit1')
    const result = await dispatchSeat('developer', 'p', { cwd: stubDir })
    assert.equal(result.report, null)
    assert.equal(result.attempts, 2, 'one original dispatch plus one respawn')
    assert.ok(result.parked, 'the caller needs a reason to park the package')
  })

  test('dispatchSeat succeeds on the first attempt without a respawn', async () => {
    resetSidecar()
    setStubEnv('ok')
    const result = await dispatchSeat('developer', 'p', { cwd: stubDir })
    assert.equal(result.report.STATUS, 'DONE')
    assert.equal(result.attempts, 1)
    assert.equal(result.parked, null)
    assert.equal(readCalls().length, 1, 'no respawn on a clean first attempt')
  })

  test('the live path honors opts.tier, matching the dry run', async () => {
    resetSidecar()
    setStubEnv('ok')
    // The judgment tier names its own settings profile; the live argv path
    // expands it, so the test must export it like a run would.
    process.env.CLAUDE_CODE_ANTHROPIC_SETTINGS = JSON.stringify({ permissions: {} })
    const mod = await import('../../adapters/claude-code-subprocess.mjs')

    const saved = process.env.DRY_RUN
    process.env.DRY_RUN = 'true'
    let dryModel
    try {
      const report = await mod.spawn('developer', 'p', { tier: 'judgment' })
      dryModel = report._model
    } finally {
      process.env.DRY_RUN = saved
    }

    // The documented opts.tier override must reach the live argv too, or a
    // caller passing a tier silently gets the role's default-tier model.
    await mod.spawn('developer', 'p', { cwd: stubDir, tier: 'judgment' })
    const argv = readCalls()[0].argv
    assert.equal(
      valueOf(argv, '--model'), dryModel,
      'the live path must resolve the requested tier, not the role default'
    )
    assert.equal(valueOf(argv, '--model'), splitTable.tiers.judgment.model)
  })

  test('a dry run derives the seat from the tier when opts.tier names one', async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    const saved = process.env.DRY_RUN
    process.env.DRY_RUN = 'true'
    try {
      const report = await mod.spawn('developer', 'p', { tier: 'judgment' })
      assert.equal(report._tier, 'judgment')
      assert.equal(report._model, splitTable.tiers.judgment.model)
    } finally {
      process.env.DRY_RUN = saved
    }
  })
})

// ===========================================================================
// 6. Prompt library
// ===========================================================================
describe('role prompts', () => {
  test('loads the shared role prompt library the Hermes path uses', async () => {
    const mod = await import('../../adapters/claude-code-subprocess.mjs')
    const prompt = mod.loadPrompt('developer')
    assert.ok(prompt.length > 100, 'the developer prompt should be substantial')
    assert.ok(
      prompt.includes('Report contract'),
      'the prompt carries the report contract the parser keys on'
    )
  })

  test('buildArgv prepends the role prompt to the task', () => {
    return import('../../adapters/claude-code-subprocess.mjs').then((mod) => {
      const argv = mod.buildArgv('developer', 'TASK-MARKER', { cwd: '/tmp/wt' })
      const prompt = argv[argv.indexOf('-p') + 1]
      assert.ok(prompt.includes('TASK-MARKER'), 'the task must reach the seat')
      assert.ok(prompt.length > 'TASK-MARKER'.length, 'the role prompt must be prepended')
    })
  })
})

// ===========================================================================
// 7. The variant tables agree on the tier and role shape
// ===========================================================================
describe('subprocess tables stay consistent', () => {
  test('both variants declare the same roles and tiers', () => {
    assert.deepEqual(Object.keys(splitTable.roles).sort(), Object.keys(vllmTable.roles).sort())
    assert.deepEqual(Object.keys(splitTable.tiers).sort(), Object.keys(vllmTable.tiers).sort())
  })

  test('the default claude-code.json stays the in-process agent table', () => {
    const def = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))
    assert.equal(def.dispatch, undefined, 'absence means the agent path, the current default')
    assert.equal(def.effort_ceiling, 'xhigh')
    assert.deepEqual(def.forbidden_efforts, ['max'])
    for (const [role, tier] of Object.entries(def.roles)) {
      assert.equal(typeof tier, 'string', `claude-code.json role "${role}" must stay a tier string`)
    }
  })
})
