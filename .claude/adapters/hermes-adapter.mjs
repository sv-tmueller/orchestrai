/**
 * Hermes adapter (issue #315, Phase C of #311).
 *
 * Implements the adapter interface (spawn, detectFailure, retry) for the
 * Hermes host. Spawn uses delegate_task, detectFailure inspects the
 * delegated task result for error signals, and retry re-dispatches on a
 * degraded tier with a logged fallback notice.
 *
 * The adapter table (.claude/adapters/hermes.json) maps tiers to concrete
 * models and efforts. This module reads the table at init time and exposes
 * the three interface operations.
 *
 * See docs/architecture/adapter-interface.md for the interface contract.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = __dir
const promptsDir = join(__dir, 'prompts')

// Load the Hermes adapter table.
const adapterTable = JSON.parse(
  readFileSync(join(adaptersDir, 'hermes.json'), 'utf8')
)

const TIERS = adapterTable.tiers
const ROLE_TIERS = adapterTable.roles

// Cache loaded prompt templates.
const promptCache = {}

/**
 * Load the prompt template for a role from .claude/adapters/prompts/.
 * The prompt template contains the role's job description, guardrails, and
 * report contract in host-neutral markdown. The adapter prepends it to the
 * task-specific prompt so the delegated agent gets the full context.
 */
export function loadPrompt(role) {
  if (promptCache[role]) return promptCache[role]
  const promptPath = join(promptsDir, `${role}.md`)
  const text = readFileSync(promptPath, 'utf8')
  promptCache[role] = text
  return text
}

// Resolve a tier to its model and effort.
export function resolveTier(tier) {
  const cfg = TIERS[tier]
  if (!cfg) throw new Error(`Unknown tier "${tier}". Add it to hermes.json.`)
  return { model: cfg.model, effort: cfg.effort }
}

// Resolve a role to its tier.
export function resolveRole(role) {
  const tier = ROLE_TIERS[role]
  if (!tier) throw new Error(`Unknown role "${role}". Add it to hermes.json.`)
  return tier
}

/**
 * spawn(role, task, opts) -> report | null
 *
 * Dispatch a role agent via Hermes delegate_task. The task prompt goes to
 * a leaf subagent; the report comes back as the subagent's final summary.
 *
 * In a live Hermes session, this calls the real delegate_task tool. In
 * dry-run mode (DRY_RUN=true), it returns a synthetic report shaped to
 * match the schema, so the pipeline can be exercised without API calls.
 *
 * Parameters:
 * - role: one of the 7 role names (architect, developer, tester, reviewer,
 *   fact-checker, docs-writer, perf-investigator)
 * - task: the full prompt string
 * - opts: { tier, effort, schema?, isolation? }
 *
 * Returns: the agent's report object, or null on failure.
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

  // Prepend the role's prompt template to the task-specific prompt.
  const rolePrompt = loadPrompt(role)
  const fullPrompt = `${rolePrompt}\n\n---\n\n${task}`

  if (process.env.DRY_RUN === 'true') {
    return dryRunSpawn(role, fullPrompt, effectiveOpts)
  }

  // Live mode: delegate to a leaf subagent.
  // The delegate_task call is made by the Hermes runtime hosting this
  // module. In a standalone test context, this branch is not reached.
  const result = await delegateTaskLeaf(role, fullPrompt, effectiveOpts)
  return result
}

/**
 * detectFailure(report) -> bool
 *
 * Hermes-specific failure detection. A null report, a report containing
 * an error field, or a report with an empty/error sentinel all count as
 * failure. This generalises the `if (first)` check in criticWithFallback.
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
 * Re-dispatch the same task on a degraded tier. Logs the fallback,
 * appends a retry notice to the prompt, and flags the result with a
 * modelFallback marker.
 */
export async function retry(task, opts, fallbackTier) {
  const { model: fbModel, effort: fbEffort } = resolveTier(fallbackTier)
  const { model: origModel } = resolveTier(opts.tier)

  console.warn(
    `[adapter] fallback: ${opts.tier} (${origModel}) -> ${fallbackTier} (${fbModel})`
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
// Internal: delegate_task wrapper for live mode.
// ---------------------------------------------------------------------------

async function delegateTaskLeaf(role, task, opts) {
  // In a live Hermes session, the delegate_task tool is available as a
  // global. This function is the bridge: it constructs the delegate_task
  // call with the role's prompt and an output_schema derived from opts.schema.
  //
  // The actual delegate_task invocation is performed by the Hermes runtime
  // when this module is imported into an agent session. Standalone tests
  // use DRY_RUN=true and never reach this path.
  if (typeof globalThis.delegate_task !== 'function') {
    throw new Error(
      'delegate_task is not available in this context. ' +
      'Set DRY_RUN=true for offline testing, or run inside a Hermes session.'
    )
  }

  const result = await globalThis.delegate_task({
    goal: task,
    output_schema: opts.schema || undefined,
  })
  return result
}

// ---------------------------------------------------------------------------
// Dry-run: synthetic reports for offline pipeline testing.
// ---------------------------------------------------------------------------

function dryRunSpawn(role, task, opts) {
  return {
    _dryRun: true,
    _role: role,
    _tier: opts.tier,
    _model: opts.model,
    _effort: opts.effort,
    _taskLength: task.length,
    // Generic report fields that satisfy most schema shapes.
    verdict: 'approve',
    status: 'DONE',
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
