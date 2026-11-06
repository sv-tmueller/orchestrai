/**
 * Claude Code subprocess seat adapter (issue #453).
 *
 * Implements the adapter interface (spawn, detectFailure, retry; see
 * docs/architecture/adapter-interface.md) for the Claude Code host in its
 * subprocess spawn mode. Where claude-code.json's default mode dispatches
 * a seat through the in-process Agent tool, this module runs each seat as
 * its own headless `claude -p` process, so the seat gets a real per-seat
 * model, endpoint, and effort pin and its own working directory. It is the
 * Claude Code counterpart of hermes-adapter.mjs.
 *
 * The role-contract parser is shared, not duplicated: parseReport,
 * hasProviderError, and the role/kind tables live in
 * role-contract-parser.mjs, imported here and by hermes-adapter.mjs. The
 * markers (STATUS:, VERDICT:, the architect job header, NEEDS_DECISION:)
 * are host-neutral per docs/architecture/role-contracts.md, so a second
 * copy would drift. The choice is recorded in the PR body.
 *
 * See docs/architecture/adapter-interface.md for the interface contract
 * and the subprocess spawn mode.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  parseReport,
  hasProviderError,
  REQUIRED_FIELD,
} from './role-contract-parser.mjs'

// Re-exported so a caller of this adapter finds the parser without reaching
// into the shared module, mirroring hermes-adapter.mjs.
export { parseReport, hasProviderError }

const execFileAsync = promisify(execFile)

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = __dir
const promptsDir = join(__dir, 'prompts')

/**
 * Load a Claude Code adapter table by bare file name from the adapters
 * directory.
 *
 * Two guards, each naming the file: the name must be a bare `*.json` file
 * name (no path, so the env var cannot point outside this directory), and
 * the table's host must be `claude-code` (this module builds `claude -p`
 * argv, so another host's table would silently mis-route seats).
 */
export function loadAdapterTable(name) {
  if (typeof name !== 'string' || basename(name) !== name || !name.endsWith('.json')) {
    throw new Error(
      `Adapter table "${name}" must be a bare .json file name in ${adaptersDir}.`
    )
  }
  const table = JSON.parse(readFileSync(join(adaptersDir, name), 'utf8'))
  if (table.host !== 'claude-code') {
    throw new Error(
      `Adapter table "${name}" has host "${table.host}", but the Claude Code ` +
        `subprocess adapter needs host "claude-code".`
    )
  }
  return table
}

// The table is chosen once, at module load: one run is one process, so
// CLAUDE_CODE_ADAPTER_TABLE selects the table for the whole run. The
// default (claude-code.json) describes the in-process agent path; the two
// subprocess variants set dispatch to "subprocess".
const TABLE_NAME = process.env.CLAUDE_CODE_ADAPTER_TABLE || 'claude-code.json'
const adapterTable = loadAdapterTable(TABLE_NAME)

const TIERS = adapterTable.tiers
const ROLE_TIERS = adapterTable.roles
const TABLE_FORBIDDEN_EFFORTS = adapterTable.forbidden_efforts || []

// Providers whose models run self-hosted, so the paid-API effort ceiling
// does not apply. The effort-policy test holds the authority (its
// SELF_HOSTED_HOSTS and SELF_HOSTED_PROVIDERS sets); this is the runtime
// guard that mirrors it, so a mixed table can forbid max on its paid tiers
// while a self-hosted tier runs at max. Keep the two in step.
const SELF_HOSTED_PROVIDERS = new Set(['vllm', 'custom'])

// The efforts forbidden for one tier: none when the tier is self-hosted,
// the table's paid baseline otherwise.
function forbiddenEffortsForTier(tier) {
  if (SELF_HOSTED_PROVIDERS.has(tier.provider)) return []
  return TABLE_FORBIDDEN_EFFORTS
}

// The binary to spawn. Overridable so tests and CI never shell out to a
// real claude install or endpoint. Read at call time, not module load, so
// a test (or driver) can point CLAUDE_BIN at a stub after the module is
// imported (the HERMES_BIN lesson, batch #437).
function claudeBin() {
  return process.env.CLAUDE_BIN || 'claude'
}

// A seat is a long autonomous run (a developer implementing an issue),
// not a quick subtask. 30 minutes per seat, then kill.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

// Cache loaded prompt templates.
const promptCache = {}

/**
 * Load the prompt template for a role from .claude/adapters/prompts/.
 * The same library the Hermes path uses: the templates are host-neutral
 * markdown, so both hosts share one source of truth.
 */
export function loadPrompt(role) {
  if (promptCache[role]) return promptCache[role]
  const promptPath = join(promptsDir, `${role}.md`)
  const text = readFileSync(promptPath, 'utf8')
  promptCache[role] = text
  return text
}

/** Resolve a tier to its model, provider, effort, and settings pointer. */
export function resolveTier(tier) {
  const cfg = TIERS[tier]
  if (!cfg) throw new Error(`Unknown tier "${tier}". Add it to ${TABLE_NAME}.`)
  return {
    model: cfg.model,
    effort: cfg.effort,
    provider: cfg.provider || null,
    settings: cfg.settings || null,
  }
}

/**
 * resolveSeat(role) -> { tier, model, effort, provider, settings }
 *
 * Resolve a role to its seat binding. A role value is either a plain tier
 * string or an object naming a tier plus per-role overrides. Resolution
 * order: role override, then tier default.
 */
export function resolveSeat(role) {
  const value = ROLE_TIERS[role]
  if (!value) throw new Error(`Unknown role "${role}". Add it to ${TABLE_NAME}.`)

  const tier = typeof value === 'string' ? value : value.tier
  if (!tier) {
    throw new Error(
      `Role "${role}" in ${TABLE_NAME} is an object with no "tier" key.`
    )
  }
  const base = resolveTier(tier)

  if (typeof value === 'string') {
    return { tier, ...base }
  }
  return {
    tier,
    model: value.model || base.model,
    effort: value.effort || base.effort,
    provider: value.provider || base.provider,
    settings: value.settings || base.settings,
  }
}

/**
 * resolveEffectiveSeat(role, opts) -> seat
 *
 * The seat binding one dispatch actually uses. `opts.tier` names a tier
 * explicitly (the interface's documented override), and the tier's own
 * model, effort, and settings then win over the role's binding, exactly as
 * resolveTier serves them. Without opts.tier the role's binding applies,
 * per-role override included. Every dispatch path resolves its seat
 * through here, so the live, dry-run, and argv paths cannot drift.
 */
function resolveEffectiveSeat(role, opts = {}) {
  if (opts.tier) return { tier: opts.tier, ...resolveTier(opts.tier) }
  return resolveSeat(role)
}

/**
 * The settings fragment every subprocess seat carries, merged with the
 * tier's own profile. Each entry is a trap from the headless `claude -p`
 * checklist (.claude/skills/tm-ab-test/SKILL.md), each one observed live:
 *
 * - every orchestrai plugin key off: disabling only the first copy left
 *   the account-synced second copy loading silently.
 * - `--permission-mode auto`: dontAsk denies every write under `.claude/`
 *   (a protected path) and still exits RC 0, so a seat silently commits
 *   nothing. Set in buildArgv, not here.
 * - `blockReadsOutsideWorkingDirectories`: a bare grant of Read or Grep
 *   bypasses the boundary check, so keep it explicit for subprocess seats.
 */
const SETTINGS_FRAGMENT = {
  enabledPlugins: {
    'orchestrai@orchestrai': false,
    'orchestrai@synced': false,
  },
  permissions: {
    blockReadsOutsideWorkingDirectories: true,
  },
}

/**
 * Expand a settings pointer from the run's environment. The table carries
 * a placeholder such as `$CLAUDE_CODE_NORIS_SETTINGS`, never an absolute
 * path and never a token, so a checked-in table stays machine-independent.
 *
 * The variable may hold a file path or an inline JSON object. An unset
 * variable throws: reaching the CLI with the literal placeholder would
 * silently load no profile.
 */
function expandSettings(pointer) {
  if (!pointer) return {}
  const match = /^\$([A-Z][A-Z0-9_]*)$/.exec(pointer.trim())
  if (!match) {
    // Not a placeholder: treat it as an inline JSON profile.
    try {
      return JSON.parse(pointer)
    } catch {
      throw new Error(
        `Settings pointer "${pointer}" is neither a $VAR placeholder nor valid JSON.`
      )
    }
  }
  const raw = process.env[match[1]]
  if (!raw || raw.trim() === '') {
    throw new Error(
      `Settings pointer "${pointer}" is unset. Export ${match[1]} (a settings ` +
        `file path or an inline JSON profile) before dispatching a subprocess seat.`
    )
  }
  if (raw.trim().startsWith('{')) {
    try {
      return JSON.parse(raw)
    } catch (e) {
      throw new Error(`Environment variable ${match[1]} is not valid JSON: ${e.message}`)
    }
  }
  return JSON.parse(readFileSync(raw, 'utf8'))
}

// Merge the fragment into the tier profile. The fragment wins on the keys
// it sets: those are the checklist's proven traps, not per-project policy.
function composeSettings(pointer) {
  const profile = expandSettings(pointer)
  return {
    ...profile,
    enabledPlugins: { ...(profile.enabledPlugins || {}), ...SETTINGS_FRAGMENT.enabledPlugins },
    permissions: { ...(profile.permissions || {}), ...SETTINGS_FRAGMENT.permissions },
  }
}

/**
 * buildArgv(role, prompt, opts) -> string[]
 *
 * Build the argv for one seat's `claude -p` subprocess. Pure function, so
 * the binding is assertable without spawning anything.
 *
 * opts: { cwd (required), tier?, model?, effort?, settings? }
 */
export function buildArgv(role, prompt, opts = {}) {
  if (!opts.cwd) {
    throw new Error(
      `buildArgv(${role}): a working directory is required. The seat would ` +
        `otherwise run in the lead's directory, which defeats package isolation.`
    )
  }

  const seat = resolveEffectiveSeat(role, opts)
  const effort = opts.effort || seat.effort
  const model = opts.model || seat.model

  // The ceiling is per the seat's own tier, so a mixed table can pin its
  // paid tiers at xhigh while a self-hosted tier runs at max.
  const forbidden = forbiddenEffortsForTier(seat)
  if (forbidden.includes(effort)) {
    throw new Error(
      `buildArgv(${role}): effort "${effort}" is forbidden on ${TABLE_NAME}. ` +
        `The ceiling is ${adapterTable.effort_ceiling}; forbidden: ${forbidden.join(', ')}.`
    )
  }

  // Prepend the role contract, then the task, so the seat's report matches
  // the markers the parser keys on.
  const rolePrompt = loadPrompt(role)
  const fullPrompt = `${rolePrompt}\n\n---\n\n${prompt}`

  const settings = composeSettings(opts.settings || seat.settings)

  return [
    '-p', fullPrompt,
    '--model', model,
    '--effort', effort,
    '--permission-mode', 'auto',
    // json, not text: the token and cost line is read from the envelope.
    '--output-format', 'json',
    '--settings', JSON.stringify(settings),
  ]
}

/**
 * buildEnv(role, base) -> object
 *
 * The environment for a seat's subprocess. Two escapes the checklist
 * proved necessary for any non-Anthropic model:
 *
 * - CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1: a custom vllm model ID is not
 *   recognized as effort-capable, so the --effort pin is dropped silently.
 * - CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0: a finished-looking run can
 *   otherwise hang on a phantom background child until the 600s ceiling.
 *   The adapter's own timeout is the backstop (cli docs: "set it to 0 to
 *   wait without one"), so a killed seat fails loudly instead of hanging.
 */
export function buildEnv(role, base = process.env) {
  return {
    ...base,
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  }
}

/**
 * The `claude -p --output-format json` envelope, parsed. Returns the
 * envelope object, or null when stdout is not JSON (a crash or a wrapper's
 * own output).
 */
function parseEnvelope(stdout) {
  const text = (stdout || '').trim()
  if (!text) return null
  // The envelope is one JSON object. Tolerate a leading line by also
  // trying the last non-empty line.
  const candidates = [text, text.split('\n').filter(Boolean).pop()]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Not this one; try the next.
    }
  }
  return null
}

/**
 * Is this a raw subprocess result rather than a parsed report object? A raw
 * result carries the process exit shape (a numeric exit code, the timeout
 * flag, a captured stdout stream). A report object carries the contract
 * fields and `raw`, and none of those. The two shapes need telling apart:
 * classifyFailure's job is to name why a raw seat failed, while a report
 * object is the success path's return value.
 */
function isRawResult(result) {
  // The `raw` marker decides the shape first: parseReport always sets it to
  // the original text, before any fenced ```json payload key is copied on, so
  // no payload field can forge it. The wrapper fields are consulted only
  // after that, because a report's payload may legitimately carry a key named
  // `code`, `stdout`, or `timedOut`, and those names must not decide the
  // shape.
  if (typeof result.raw === 'string') return false
  return (
    typeof result.code === 'number' ||
    result.timedOut === true ||
    typeof result.stdout === 'string'
  )
}

/**
 * classifyFailure(result, role) -> string | null
 *
 * Name why a seat failed, or null when it did not. The name feeds the
 * respawn prompt, so a retried seat knows what went wrong the first time.
 */
export function classifyFailure(result, role) {
  if (result === null || result === undefined) return 'no result'
  // A parsed report object has no failure class of its own; detectFailure
  // checks its required contract field.
  if (!isRawResult(result)) return null
  if (result.timedOut) return 'timeout'
  if (typeof result.code === 'number' && result.code !== 0) return `exit ${result.code}`
  if (result.error) return String(result.error)

  const out = result.stdout || ''
  if (out.trim() === '') return 'empty output'
  if (hasProviderError(out) || hasProviderError(result.stderr)) return 'provider error'

  const envelope = parseEnvelope(out)
  if (envelope?.is_error) return 'error envelope'
  const body = envelope?.result ?? out
  if (String(body).trim() === '') return 'empty output'

  const required = REQUIRED_FIELD[role]
  if (required) {
    const report = parseReport(role, body)
    if (!(required in report)) return `no ${required} in the report`
  }
  return null
}

/**
 * detectFailure(result, role) -> bool
 *
 * True when the seat could not complete. Accepts a raw subprocess result
 * (`{ code, stdout, stderr, timedOut }`) or a parsed report object, string,
 * or null. The interface's documented call shape is spawn -> detectFailure
 * (report), so a clean report object must read as no failure: it is the
 * success path's return value, not a raw result with a missing stdout. A
 * report still fails when it is missing its role's required contract field.
 * See adapter-interface.md for the interface contract.
 */
export function detectFailure(result, role) {
  if (result === null || result === undefined) return true
  if (typeof result === 'string') {
    return result.trim() === '' || hasProviderError(result)
  }
  if (typeof result !== 'object') return true
  if (result.error) return true

  const reason = classifyFailure(result, role)
  if (reason) return true

  // A parsed report object (not a raw result) carries no stdout, so the
  // required-field check runs against its own fields.
  if (!isRawResult(result)) {
    const required = REQUIRED_FIELD[role]
    if (required && !(required in result)) return true
  }
  return false
}

/**
 * Read the printed token and cost line out of a seat's envelope. Self-hosted
 * vllm models carry no marginal cost, so their usage is recorded unpriced
 * (raw counts only), which is what the run's token report needs.
 */
export function captureUsage(envelope, model) {
  const usage = envelope?.usage || {}
  const isSelfHosted = model?.startsWith('vllm/')
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    costUsd: isSelfHosted ? null : envelope?.total_cost_usd ?? null,
    priced: !isSelfHosted,
  }
}

/**
 * spawn(role, task, opts) -> report | null
 *
 * Run one seat as a `claude -p` subprocess and return its parsed report,
 * or null on failure. In dry-run mode (DRY_RUN=true) it returns a
 * synthetic report so a pipeline exercises offline.
 *
 * opts: { cwd (required live), tier?, model?, effort?, settings?, timeoutMs? }
 */
export async function spawn(role, task, opts = {}) {
  if (process.env.DRY_RUN === 'true') {
    return dryRunSpawn(role, task, opts)
  }
  return runClaude(role, task, opts)
}

async function runClaude(role, task, opts) {
  const seat = resolveEffectiveSeat(role, opts)
  const argv = buildArgv(role, task, opts)
  const model = opts.model || seat.model

  let raw
  try {
    const { stdout, stderr } = await execFileAsync(claudeBin(), argv, {
      cwd: opts.cwd,
      env: buildEnv(role),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    raw = { code: 0, stdout, stderr }
  } catch (e) {
    // execFile rejects on a nonzero exit or a timeout, but the output still
    // matters. e.code is the exit status when numeric, ETIMEDOUT on kill.
    raw = {
      code: typeof e.code === 'number' ? e.code : null,
      timedOut: e.killed === true || e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM',
      stdout: e.stdout || '',
      stderr: e.stderr || String(e.message || e),
    }
  }

  const reason = classifyFailure(raw, role)
  if (reason) {
    diagnoseFailure(role, { model, tier: seat.tier }, raw, reason)
    return null
  }

  const envelope = parseEnvelope(raw.stdout)
  const report = parseReport(role, envelope?.result ?? raw.stdout)
  report.usage = captureUsage(envelope, model)
  return report
}

// Explain a failure on the way out, so the caller's null has a reason in
// the run log and the retry prompt can name it.
function diagnoseFailure(role, opts, raw, reason) {
  const detail = (raw.stderr || raw.stdout || '').trim().split('\n')[0] || 'no output'
  console.warn(
    `[adapter] ${role} failed on ${opts.model} (${opts.tier}, ${reason}): ${detail}`
  )
}

/**
 * retry(task, opts, failureReason) -> report | null
 *
 * One respawn per failed dispatch, on the same binding. Task-first and
 * opts-carrying-`role`, matching the interface signature and the Hermes
 * adapter. Unlike the Hermes tier-ladder retry, a subprocess seat has no
 * cheap degenerate tier to fall to, so a failure is retried once as-is
 * and then the package parks. The respawn prompt names the failure and
 * what the dead attempt left behind, so no unchanged prompt is
 * re-dispatched.
 */
export async function retry(task, opts = {}, failureReason = 'the first attempt failed') {
  const role = opts.role || 'unknown'
  const fromModel = opts.model || resolveEffectiveSeat(role, opts).model

  const retryNotice =
    `\n\nRESPAWN: this is a retry. The previous attempt (${fromModel}) did not ` +
    `complete (${failureReason}). Check what it left on origin (branch, commits, ` +
    `PR) before redoing any work, and carry it forward instead of starting over.`

  return spawn(role, task + retryNotice, opts)
}

/**
 * dispatchSeat(role, task, opts) -> { report, attempts, failure, parked }
 *
 * The full dispatch: spawn once, and on any failure class respawn exactly
 * once, then report the park. The caller sets the label and parks the
 * package; the reason travels in the result.
 */
export async function dispatchSeat(role, task, opts = {}) {
  const first = await spawn(role, task, opts)
  if (first) {
    return { report: first, attempts: 1, failure: null, parked: null }
  }

  // Name the failure for the respawn prompt. spawn returned null, so the
  // class is one of the generic shapes; the retry notice names them.
  const reason = 'timeout, empty or stalled output, or a nonzero exit'
  const second = await retry(task, { ...opts, role }, reason)
  if (second) {
    return { report: second, attempts: 2, failure: null, parked: null }
  }

  return {
    report: null,
    attempts: 2,
    failure: reason,
    parked: `${role} failed twice on the same binding; the fix-cap rules apply`,
  }
}

// ---------------------------------------------------------------------------
// Dry-run: synthetic reports for offline pipeline testing.
// ---------------------------------------------------------------------------

function dryRunSpawn(role, task, opts) {
  const VERDICTS = {
    architect: { KIND: 'SUB_PLAN', output: 'SUB_PLAN: approach, files, order, verification.' },
    developer: { STATUS: 'DONE', BRANCH: 'dry-run-branch', PR: 'https://github.com/example/dry-run' },
    tester: { VERDICT: 'PASS', COMMIT: 'abc123', FINDINGS: 'none', UNTESTED_CLAIMS: 'none' },
    reviewer: { VERDICT: 'APPROVE', STAGE: 'both clean', FINDINGS: 'none' },
    'fact-checker': { VERDICT: 'GROUNDED', COMMIT: 'abc123', CLAIMS: [], SUMMARY: '0 verified, 0 contradicted' },
    'docs-writer': { FILES: [], GAPS_NOT_FILLED: 'none', ASSUMPTIONS: 'none' },
    'perf-investigator': { BASELINE: [], BOTTLENECK: 'none', TARGET: 'none', RE_MEASURE: 'none' },
  }

  const roleSpecific = VERDICTS[role] || {}
  const seat = resolveEffectiveSeat(role, opts)

  return {
    _dryRun: true,
    _role: role,
    _tier: seat.tier,
    _model: seat.model,
    _effort: seat.effort,
    _taskLength: task.length,
    ...roleSpecific,
    verdict: roleSpecific.VERDICT?.toLowerCase() || 'approve',
    status: roleSpecific.STATUS || 'DONE',
    branch: 'dry-run-branch',
    pr: 'https://github.com/example/dry-run',
    checks: 'npm test -> 0',
    deviations: 'none',
    notes: 'dry-run: no live claude -p call',
    findings: [],
    summary: 'dry-run summary',
    reportPath: 'docs/dry-run.md',
    openQuestions: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null, priced: false },
  }
}
