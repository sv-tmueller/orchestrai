/**
 * Codex adapter (issue #316, Phase D of #311).
 *
 * Implements the adapter interface (spawn, detectFailure, retry) for the
 * Codex host. Spawn uses `codex exec` invoked via the terminal, with -m
 * for model selection and -s for sandbox mode. Reports come through
 * stdout. Authentication is ChatGPT subscription (no metered API keys).
 *
 * The adapter table (.claude/adapters/codex.json) maps tiers to concrete
 * models and efforts. This module reads the table at init time and
 * exposes the three interface operations.
 *
 * See docs/architecture/adapter-interface.md for the interface contract.
 * See docs/research/2026-08-14-codex-subscription-auth-spike.md for the
 * verified auth path.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'

const __dir = dirname(fileURLToPath(import.meta.url))

// Load the Codex adapter table.
const adapterTable = JSON.parse(
  readFileSync(join(__dir, 'codex.json'), 'utf8')
)

const TIERS = adapterTable.tiers
const ROLE_TIERS = adapterTable.roles

// Codex effort levels map to reasoning effort config overrides.
// The codex exec CLI uses model_reasoning_effort in config.toml, overridden
// via -c model_reasoning_effort="<level>".
const EFFORT_TO_CODEX = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high', // codex has no xhigh; high is the ceiling
}

// Resolve a tier to its model and effort.
export function resolveTier(tier) {
  const cfg = TIERS[tier]
  if (!cfg) throw new Error(`Unknown tier "${tier}". Add it to codex.json.`)
  return { model: cfg.model, effort: cfg.effort }
}

// Resolve a role to its tier.
export function resolveRole(role) {
  const tier = ROLE_TIERS[role]
  if (!tier) throw new Error(`Unknown role "${role}". Add it to codex.json.`)
  return tier
}

/**
 * spawn(role, task, opts) -> report | null
 *
 * Dispatch a role agent via `codex exec`. The task prompt is passed as the
 * positional argument; the model is selected via -m; sandbox mode via -s.
 * The report is collected from stdout.
 *
 * In dry-run mode (DRY_RUN=true), returns a synthetic report without
 * invoking codex exec.
 */
export async function spawn(role, task, opts = {}) {
  const tier = opts.tier || resolveRole(role)
  const { model, effort } = resolveTier(tier)

  const effectiveOpts = {
    ...opts,
    tier,
    model,
    effort: opts.effort || effort,
  }

  if (process.env.DRY_RUN === 'true') {
    return dryRunSpawn(role, task, effectiveOpts)
  }

  // Live mode: invoke codex exec via the terminal.
  const codexEffort = EFFORT_TO_CODEX[effectiveOpts.effort] || 'high'
  const sandboxMode = opts.isolation === 'worktree' ? 'workspace-write' : 'read-only'

  // Build the codex exec command. The task is passed as a quoted argument.
  // The -c flag overrides model_reasoning_effort for this run.
  const escapedTask = task.replace(/'/g, "'\\''")
  const cmd = [
    'codex exec',
    `-m "${model}"`,
    `-s ${sandboxMode}`,
    `-c model_reasoning_effort="${codexEffort}"`,
    `'${escapedTask}'`,
  ].join(' ')

  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      timeout: 300000, // 5 min timeout per agent dispatch
      cwd: process.cwd(),
    })

    // Parse the report from stdout. The last non-header line is the result.
    const report = parseCodexOutput(stdout, effectiveOpts)
    return report
  } catch (err) {
    // codex exec failure: return null so detectFailure triggers retry.
    console.warn(`[codex-adapter] spawn failed for role ${role}: ${err.message}`)
    return null
  }
}

/**
 * detectFailure(report) -> bool
 *
 * Codex-specific failure detection. A null report, an empty string, a
 * stderr-only output, or a nonzero exit code (caught as null above) all
 * count as failure.
 */
export function detectFailure(report) {
  if (report === null || report === undefined) return true
  if (typeof report === 'object' && report.error) return true
  if (typeof report === 'string' && report.trim() === '') return true
  return false
}

/**
 * retry(task, opts, fallbackTier) -> report
 *
 * Re-dispatch the same task on a degraded tier via codex exec. Logs the
 * fallback, appends a retry notice, and flags the result.
 */
export async function retry(task, opts, fallbackTier) {
  const { model: fbModel, effort: fbEffort } = resolveTier(fallbackTier)
  const { model: origModel } = resolveTier(opts.tier)

  console.warn(
    `[codex-adapter] fallback: ${opts.tier} (${origModel}) -> ${fallbackTier} (${fbModel})`
  )

  const retryNotice =
    `\n\nNOTE: this is a retry on the ${fbModel} fallback after the ` +
    `${origModel} agent returned nothing (quota or a skip). If you write ` +
    `a report file, record in it that this fallback produced it.`

  const retryOpts = {
    ...opts,
    tier: fallbackTier,
    model: fbModel,
    effort: opts.effort || fbEffort,
  }

  const report = await spawn(opts.role || 'unknown', task + retryNotice, retryOpts)

  if (report && typeof report === 'object') {
    return { ...report, modelFallback: `${origModel} -> ${fbModel}` }
  }
  return report
}

// ---------------------------------------------------------------------------
// Internal: parse codex exec stdout into a report object.
// ---------------------------------------------------------------------------

function parseCodexOutput(stdout, opts) {
  // codex exec output has a header block (lines starting with ------) and
  // then the agent's response. The last non-empty line after the separator
  // is typically the result text.
  const lines = stdout.split('\n')
  const sepIdx = lines.findIndex((l) => l.startsWith('--------'))

  let resultText
  if (sepIdx >= 0) {
    // Take everything after the second separator (after the config block).
    // The response follows the "codex" marker.
    const codexMarkerIdx = lines.indexOf('codex', sepIdx)
    const startIdx = codexMarkerIdx >= 0 ? codexMarkerIdx + 1 : sepIdx + 1
    resultText = lines.slice(startIdx).filter((l) => l.trim()).join('\n').trim()
  } else {
    resultText = stdout.trim()
  }

  // Strip the "tokens used" footer if present.
  const tokensIdx = resultText.lastIndexOf('tokens used')
  if (tokensIdx > 0) {
    resultText = resultText.slice(0, tokensIdx).trim()
  }

  return {
    _codex: true,
    _role: opts.role,
    _tier: opts.tier,
    _model: opts.model,
    _effort: opts.effort,
    output: resultText,
    raw: stdout,
  }
}

// ---------------------------------------------------------------------------
// Dry-run: synthetic reports for offline pipeline testing.
// ---------------------------------------------------------------------------

function dryRunSpawn(role, task, opts) {
  return {
    _dryRun: true,
    _codex: true,
    _role: role,
    _tier: opts.tier,
    _model: opts.model,
    _effort: opts.effort,
    _taskLength: task.length,
    verdict: 'approve',
    status: 'DONE',
    branch: 'dry-run-branch',
    pr: 'https://github.com/example/dry-run',
    checks: 'npm test -> 0',
    deviations: 'none',
    notes: 'dry-run: no codex exec call',
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
