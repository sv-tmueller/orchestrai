/**
 * Hermes workflow renderer (issue #315, Phase C of #311).
 *
 * Reads a workflow fan-out JSON spec from .claude/workflows/specs/ and
 * drives the Hermes adapter's spawn/parallel/phase operations. This
 * proves the data-spec approach works on a second host: the same JSON
 * spec that the Claude Code JS renderer consumes (via its embedded SPEC
 * constant) is consumed here via direct file read.
 *
 * Usage:
 *   import { renderWorkflow } from './hermes-renderer.mjs'
 *   const report = await renderWorkflow('tm-review-changes', {
 *     base: 'main', head: 'feat/my-branch'
 *   })
 *
 * In dry-run mode (DRY_RUN=true), spawn returns synthetic reports, so the
 * full fan-out (scout, parallel workers, critic with fallback) exercises
 * without live API calls.
 *
 * See docs/architecture/adapter-interface.md section "Spec format".
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawn, detectFailure, retry } from './hermes-adapter.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const specsDir = join(__dir, '..', 'workflows', 'specs')

// Load a workflow spec by name (without extension).
function loadSpec(workflowName) {
  const specPath = join(specsDir, `${workflowName}.spec.json`)
  return JSON.parse(readFileSync(specPath, 'utf8'))
}

/**
 * renderWorkflow(workflowName, args) -> report
 *
 * Executes a workflow by driving its spec through the Hermes adapter.
 * Handles all three parallelism modes (single, fixed-list, dynamic-list)
 * and the fallback ladder for stages that declare one.
 */
export async function renderWorkflow(workflowName, args = {}) {
  const spec = loadSpec(workflowName)
  const stages = spec.stages
  const log = (msg) => console.warn(`[renderer:${workflowName}] ${msg}`)

  // Execution context: accumulates results from each stage.
  const ctx = {}

  // Execute stages in declaration order. Dynamic-list stages read their
  // item list from a previous stage's output (items_source).
  for (const [name, stage] of Object.entries(stages)) {
    log(`stage: ${name} (tier: ${stage.tier}, parallelism: ${stage.parallelism})`)

    if (stage.parallelism === 'single') {
      const report = await executeStage(stage, name, ctx, args, log)
      ctx[name] = report
    } else if (stage.parallelism === 'fixed-list') {
      const items = getFixedListItems(stage, ctx, args)
      const reports = await executeParallel(stage, name, items, ctx, args, log)
      ctx[name] = reports
    } else if (stage.parallelism === 'dynamic-list') {
      const items = getDynamicListItems(stage, ctx, args)
      const reports = await executeParallel(stage, name, items, ctx, args, log)
      ctx[name] = reports
    } else {
      throw new Error(`Unknown parallelism "${stage.parallelism}" in stage "${name}"`)
    }
  }

  // The last stage's result is the workflow's report. Convention: the
  // final stage is the consolidate/synthesize stage (single, judgment tier).
  const stageNames = Object.keys(stages)
  const lastName = stageNames[stageNames.length - 1]
  return ctx[lastName]
}

// Execute a single-agent stage, with fallback if the stage declares one.
async function executeStage(stage, name, ctx, args, log) {
  const task = buildTaskPrompt(stage, name, ctx, args)
  const opts = { tier: stage.tier, schema: stage.schema, role: inferRole(name) }

  const report = await spawn(inferRole(name), task, opts)

  if (detectFailure(report) && stage.fallback) {
    log(`stage ${name}: primary failed, retrying on ${stage.fallback.to_tier}`)
    return await retry(task, { ...opts, role: inferRole(name) }, stage.fallback.to_tier)
  }

  return report
}

// Execute a parallel stage (fixed-list or dynamic-list).
async function executeParallel(stage, name, items, ctx, args, log) {
  const tasks = items.map((item) => {
    const task = buildItemTaskPrompt(stage, name, item, ctx, args)
    return { task, label: `${stage.item_label_prefix || ''}${item.key || item.name || item}` }
  })

  // In dry-run mode, execute sequentially (no real concurrency needed).
  // In live mode, delegate_task supports parallel batches.
  const reports = []
  for (const { task, label } of tasks) {
    const opts = { tier: stage.tier, schema: stage.schema, role: inferRole(name) }
    const report = await spawn(inferRole(name), task, opts)
    reports.push(report)
  }

  return reports
}

// Build the task prompt for a single stage.
function buildTaskPrompt(stage, name, ctx, args) {
  // In a full implementation, the prompt template lives alongside the spec.
  // For the dry-run renderer, a minimal prompt suffices to exercise the
  // fan-out structure. The live renderer would interpolate the full prompt
  // from the workflow's JS source or a shared prompt template.
  return `Stage: ${name}. Phase: ${stage.phase}. Tier: ${stage.tier}. Args: ${JSON.stringify(args)}.`
}

// Build the task prompt for a parallel stage item.
function buildItemTaskPrompt(stage, name, item, ctx, args) {
  return `Stage: ${name}. Item: ${typeof item === 'string' ? item : JSON.stringify(item)}. Phase: ${stage.phase}. Tier: ${stage.tier}.`
}

// Resolve the item list for a fixed-list stage.
function getFixedListItems(stage, ctx, args) {
  // Fixed-list stages reference a data array by key. In the Claude Code
  // renderer, the data array (e.g. DIMENSIONS) is inlined in the JS. The
  // Hermes renderer reads it from args or a companion data file.
  // For dry-run, fall back to a minimal stub list.
  return args[stage.items_key] || [{ key: 'stub', name: 'stub-item' }]
}

// Resolve the item list for a dynamic-list stage.
function getDynamicListItems(stage, ctx, args) {
  // Dynamic-list stages read items from a previous stage's output.
  // items_source is a dotted path like "scout_result.areas".
  const parts = stage.items_source.split('.')
  let val = ctx
  for (const part of parts) {
    val = val?.[part]
  }
  if (!Array.isArray(val)) {
    // Dry-run fallback: stub a single area.
    return [{ name: 'stub-area', paths: ['.'], why: 'stub' }]
  }
  // Cap the item count.
  const cap = args[stage.items_cap] || stage.items_default_cap || Infinity
  return val.slice(0, cap)
}

// Infer the role agent for a stage from the stage name.
function inferRole(stageName) {
  // Map stage names to role agents. The consolidate/synthesize stages use
  // the reviewer or architect role (judgment tier). Scout and area stages
  // use the developer role (worker tier). This mapping is a simplification;
  // the full pipeline dispatches based on the role contracts.
  const roleMap = {
    scout: 'developer',
    review: 'developer',
    area_review: 'developer',
    area_map: 'developer',
    architecture_review: 'developer',
    consolidate: 'reviewer',
    synthesize: 'architect',
  }
  return roleMap[stageName] || 'developer'
}
