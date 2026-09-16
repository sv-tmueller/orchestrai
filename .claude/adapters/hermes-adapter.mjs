/**
 * Hermes adapter (issue #351, amending Phase C of #311).
 *
 * Implements the adapter interface (spawn, detectFailure, retry) for the
 * Hermes host. Each seat runs as a `hermes -z` subprocess, which is what
 * makes the tier abstraction real: model, provider, effort, and tool
 * surface are all pinned per spawn.
 *
 * This replaced a delegate_task implementation. delegate_task takes no
 * model override, no working directory, and no output schema, so the tier
 * table was decorative, concurrent seats shared one checkout, and the
 * live path was gated on a Node global Hermes never provides.
 *
 * The adapter does not pass -w. Hermes' own worktree mode registers an
 * atexit cleanup that force-removes the worktree and deletes its branch
 * unless commits are pushed, and it names branches from a UUID. The
 * driver creates one worktree per package and passes it as --in.
 *
 * See docs/architecture/adapter-interface.md for the interface contract
 * and docs/superpowers/specs/2026-09-16-hermes-subprocess-adapter-design.md
 * for the design.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = __dir
const promptsDir = join(__dir, 'prompts')

// Load the Hermes adapter table.
const adapterTable = JSON.parse(
  readFileSync(join(adaptersDir, 'hermes.json'), 'utf8')
)

const TIERS = adapterTable.tiers
const ROLE_TIERS = adapterTable.roles
const SEATS = adapterTable.seats
const FORBIDDEN_EFFORTS = adapterTable.forbidden_efforts || []
const UNVERIFIED_MODEL_IDS = adapterTable._unverified_model_ids || {}

// The binary to spawn. Overridable so tests and CI never shell out to a
// real Hermes install.
const HERMES_BIN = process.env.HERMES_BIN || 'hermes'

// A seat is a long autonomous run (a developer implementing an issue),
// not a quick subtask. The driver overrides this per seat when it needs to.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

// Cache loaded prompt templates.
const promptCache = {}

/**
 * Load the prompt template for a role from .claude/adapters/prompts/.
 * The template carries the role's job description, guardrails, and report
 * contract in host-neutral markdown; the adapter prepends it to the
 * task-specific prompt.
 */
export function loadPrompt(role) {
  if (promptCache[role]) return promptCache[role]
  const promptPath = join(promptsDir, `${role}.md`)
  const text = readFileSync(promptPath, 'utf8')
  promptCache[role] = text
  return text
}

/** Resolve a tier to its model, provider, effort, and in-tier fallback. */
export function resolveTier(tier) {
  const cfg = TIERS[tier]
  if (!cfg) throw new Error(`Unknown tier "${tier}". Add it to hermes.json.`)
  return {
    model: cfg.model,
    effort: cfg.effort,
    provider: cfg.provider,
    fallbackModel: cfg.fallback_model || null,
  }
}

/** Resolve a role to its tier. */
export function resolveRole(role) {
  const tier = ROLE_TIERS[role]
  if (!tier) throw new Error(`Unknown role "${role}". Add it to hermes.json.`)
  return tier
}

/** Resolve a role to its seat binding (the tool surface). */
export function resolveSeat(role) {
  const seat = SEATS?.[role]
  if (!seat) throw new Error(`Unknown seat "${role}". Add it to hermes.json.`)
  return { toolsets: seat.toolsets }
}

/**
 * Return the note explaining an unverified model ID, or null when the ID
 * is confirmed. Surfaced on spawn failure so a wrong ID diagnoses itself
 * instead of looking like a provider outage.
 */
export function modelIdHint(model) {
  return UNVERIFIED_MODEL_IDS[model] || null
}

/**
 * buildArgv(role, prompt, opts) -> string[]
 *
 * Build the argv for one seat's `hermes` subprocess. Pure function, so
 * the binding is assertable without spawning anything.
 *
 * opts: { cwd (required), tier?, model?, effort? }
 */
export function buildArgv(role, prompt, opts = {}) {
  if (!opts.cwd) {
    throw new Error(
      `buildArgv(${role}): a working directory is required. Without --in the ` +
      `seat runs in the driver's directory, which defeats package isolation.`
    )
  }

  const tier = opts.tier || resolveRole(role)
  const resolved = resolveTier(tier)
  const effort = opts.effort || resolved.effort

  if (FORBIDDEN_EFFORTS.includes(effort)) {
    throw new Error(
      `buildArgv(${role}): effort "${effort}" is forbidden. The ceiling is ` +
      `${adapterTable.effort_ceiling}; forbidden: ${FORBIDDEN_EFFORTS.join(', ')}.`
    )
  }

  const model = opts.model || resolved.model
  const { toolsets } = resolveSeat(role)

  return [
    '-z', prompt,
    '-m', model,
    '--provider', resolved.provider,
    '--reasoning', effort,
    '-t', toolsets.join(','),
    '--in', opts.cwd,
    // Headless: no TTY is attached, so neither prompt can be answered.
    '--yolo',
    '--accept-hooks',
  ]
}

// The field whose absence means the seat did not produce a real report.
const REQUIRED_FIELD = {
  architect: 'KIND',
  developer: 'STATUS',
  tester: 'VERDICT',
  reviewer: 'VERDICT',
  'fact-checker': 'VERDICT',
  'docs-writer': 'FILES',
  'perf-investigator': 'BASELINE',
}

// The openers an architect report may start with (role-contracts.md).
const ARCHITECT_KINDS = ['SUB_PLAN', 'SPLIT_PROPOSAL', 'ARBITRATION', 'NEEDS_DECISION']

// Report keys are uppercase and may contain spaces ("UNTESTED CLAIMS") or
// hyphens ("RE-MEASURE"). Anchored at column 0 so the indented sub-keys
// inside a CLAIMS or BASELINE block do not shadow the top-level fields.
const REPORT_LINE = /^([A-Z][A-Z _-]*):[ \t]*(.*)$/

/**
 * parseReport(role, stdout) -> object
 *
 * Parse a seat's report out of its stdout. `hermes -z` prints only the
 * final response, so the report arrives as text. This replaces the
 * output_schema parameter the previous implementation passed, which
 * delegate_task does not document.
 *
 * Returns the parsed fields plus `raw`. An architect report also gets
 * `KIND`, since its contract opens with a bare keyword rather than a
 * key-value line.
 */
export function parseReport(role, stdout) {
  const text = stdout || ''
  const report = { raw: text }

  for (const line of text.split('\n')) {
    const match = REPORT_LINE.exec(line)
    if (!match) continue
    const [, key, value] = match
    // First occurrence wins: a later mention in prose cannot overwrite the
    // report block.
    if (!(key in report)) report[key] = value.trim()
  }

  if (role === 'architect') {
    const kind = parseArchitectKind(text)
    if (kind) report.KIND = kind
  }

  return report
}

// The architect's contract is "start your report with one of ...", so the
// kind is decided by the first non-empty line.
function parseArchitectKind(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    for (const kind of ARCHITECT_KINDS) {
      if (trimmed === kind || trimmed.startsWith(`${kind}:`)) return kind
    }
    return null
  }
  return null
}

/**
 * Does this output carry a provider-level error rather than a report?
 * The reference case is `HTTP 403: Virtual key has expired`.
 */
export function hasProviderError(text) {
  if (!text) return false
  if (/HTTP \d{3}/.test(text)) return true
  return /\b(quota exceeded|rate limit|unauthorized|invalid api key)\b/i.test(text)
}

/**
 * detectFailure(result, role) -> bool
 *
 * True when the seat could not complete. Accepts either a raw subprocess
 * result (`{ code, stdout, stderr }`) or, for backward compatibility, a
 * report object, a string, or null.
 *
 * For a raw result the five failure shapes are: a nonzero exit code,
 * empty stdout, a provider error in either stream, and a report missing
 * its role's required field. The last one matters most: a tester report
 * with no VERDICT must not travel downstream as a PASS.
 */
export function detectFailure(result, role) {
  if (result === null || result === undefined) return true
  if (typeof result === 'string') {
    return result.trim() === '' || hasProviderError(result)
  }
  if (typeof result !== 'object') return true
  if (result.error) return true

  // A raw subprocess result carries a numeric exit code.
  if (typeof result.code === 'number') {
    if (result.code !== 0) return true
    const out = result.stdout || ''
    if (out.trim() === '') return true
    if (hasProviderError(out) || hasProviderError(result.stderr)) return true
    const required = REQUIRED_FIELD[role]
    if (required) {
      const report = parseReport(role, out)
      if (!(required in report)) return true
    }
    return false
  }

  return false
}

/**
 * resolveRetryTarget(table, tier) -> { tier, model, effort, provider, withinTier } | null
 *
 * Where a failed tier retries. A tier declaring `fallback_model` retries
 * within tier; otherwise the ladder is cross-tier (judgment to worker),
 * as the parent design specifies.
 *
 * Within-tier exists because a cross-tier retry would hand an arbitration
 * or a review verdict to the worker tier. That is correct on Claude Code,
 * where the worker tier is a capable generalist, and wrong wherever the
 * worker tier is a cheap task-specialised model.
 *
 * Returns null when there is nowhere to go: a worker-tier failure has no
 * lower tier, so the stage's fix-cap rules take over and the package
 * parks on exhaustion.
 */
export function resolveRetryTarget(table, tier) {
  const cfg = table?.tiers?.[tier]
  if (!cfg) return null

  if (cfg.fallback_model) {
    return {
      tier,
      model: cfg.fallback_model,
      effort: cfg.effort,
      provider: cfg.provider,
      withinTier: true,
    }
  }

  if (tier === 'judgment' || tier === 'lead') {
    const worker = table.tiers.worker
    if (!worker) return null
    return {
      tier: 'worker',
      model: worker.model,
      effort: worker.effort,
      provider: worker.provider,
      withinTier: false,
    }
  }

  return null
}

/**
 * spawn(role, task, opts) -> report | null
 *
 * Run one seat as a `hermes` subprocess and return its parsed report, or
 * null on failure. In dry-run mode (DRY_RUN=true) it returns a synthetic
 * report so the pipeline exercises offline.
 *
 * opts: { cwd (required live), tier?, model?, effort?, timeoutMs? }
 */
export async function spawn(role, task, opts = {}) {
  const tier = opts.tier || resolveRole(role)
  const resolved = resolveTier(tier)

  const effectiveOpts = {
    ...opts,
    tier,
    model: opts.model || resolved.model,
    effort: opts.effort || resolved.effort,
  }

  // Prepend the role's contract to the task-specific prompt.
  const rolePrompt = loadPrompt(role)
  const fullPrompt = `${rolePrompt}\n\n---\n\n${task}`

  if (process.env.DRY_RUN === 'true') {
    return dryRunSpawn(role, fullPrompt, effectiveOpts)
  }

  return runHermes(role, fullPrompt, effectiveOpts)
}

// Live mode: spawn the subprocess, normalise the result, parse or diagnose.
async function runHermes(role, prompt, opts) {
  const argv = buildArgv(role, prompt, opts)

  let raw
  try {
    const { stdout, stderr } = await execFileAsync(HERMES_BIN, argv, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    raw = { code: 0, stdout, stderr }
  } catch (e) {
    // execFile rejects on a nonzero exit, but the output still matters.
    // e.code is the exit status when numeric, or a string like ETIMEDOUT.
    raw = {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout || '',
      stderr: e.stderr || String(e.message || e),
    }
  }

  if (detectFailure(raw, role)) {
    diagnoseFailure(role, opts, raw)
    return null
  }

  return parseReport(role, raw.stdout)
}

// Explain a failure on the way out, so the caller's null has a reason in
// the run log. An unverified model ID is called out by name: it looks
// exactly like a provider outage otherwise.
function diagnoseFailure(role, opts, raw) {
  const detail = (raw.stderr || raw.stdout || '').trim().split('\n')[0] || 'no output'
  console.warn(
    `[adapter] ${role} failed on ${opts.model} (${opts.tier}, exit ${raw.code}): ${detail}`
  )
  const hint = modelIdHint(opts.model)
  if (hint) {
    console.warn(`[adapter] the model ID "${opts.model}" is unverified. ${hint}`)
  }
}

/**
 * retry(task, opts, fallbackTier) -> report | null
 *
 * Re-dispatch on the fallback for the failed tier. Logs and flags the
 * fallback, preserves the effort, and appends a retry notice so no
 * unchanged prompt is re-dispatched.
 *
 * `fallbackTier` is optional; omit it to use the table's ladder
 * (within-tier where a fallback_model is declared, cross-tier otherwise).
 */
export async function retry(task, opts = {}, fallbackTier) {
  const fromTier = opts.tier || resolveRole(opts.role || 'unknown')
  const fromModel = opts.model || resolveTier(fromTier).model

  const target = fallbackTier
    ? { tier: fallbackTier, ...resolveTier(fallbackTier), withinTier: fallbackTier === fromTier }
    : resolveRetryTarget(adapterTable, fromTier)

  if (!target) {
    console.warn(
      `[adapter] no fallback for tier "${fromTier}"; the stage fix-cap rules apply`
    )
    return null
  }

  const shape = target.withinTier ? 'within tier' : 'across tiers'
  console.warn(
    `[adapter] fallback ${shape}: ${fromTier} (${fromModel}) -> ` +
    `${target.tier} (${target.model})`
  )

  const retryNotice =
    `\n\nNOTE: this is a retry on the ${target.model} fallback after the ` +
    `${fromModel} agent returned nothing (quota, an error, or a skip). If you ` +
    `write a report file, record in it that this fallback produced it.`

  const report = await spawn(opts.role || 'unknown', task + retryNotice, {
    ...opts,
    tier: target.tier,
    model: target.model,
    effort: opts.effort || target.effort,
  })

  if (report && typeof report === 'object') {
    return { ...report, modelFallback: `${fromModel} -> ${target.model}` }
  }
  return report
}

// ---------------------------------------------------------------------------
// Dry-run: synthetic reports for offline pipeline testing.
// ---------------------------------------------------------------------------

function dryRunSpawn(role, task, opts) {
  // Role-specific verdicts so the pipeline driver can route correctly.
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

  return {
    _dryRun: true,
    _role: role,
    _tier: opts.tier,
    _model: opts.model,
    _effort: opts.effort,
    _taskLength: task.length,
    ...roleSpecific,
    // Generic fallback fields for tests that check them.
    verdict: roleSpecific.VERDICT?.toLowerCase() || 'approve',
    status: roleSpecific.STATUS || 'DONE',
    branch: 'dry-run-branch',
    pr: 'https://github.com/example/dry-run',
    checks: 'npm test -> 0',
    deviations: 'none',
    notes: 'dry-run: no live API call',
    findings: [],
    summary: 'dry-run summary',
    reportPath: 'docs/dry-run.md',
    openQuestions: [],
    coverage: {
      areasMapped: [],
      areasDropped: [],
      workersFailed: [],
      ceilingReached: false,
    },
  }
}
