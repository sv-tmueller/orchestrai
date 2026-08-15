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
const promptsDir = join(__dir, '..', 'workflows', 'prompts')

// Load a workflow spec by name (without extension).
function loadSpec(workflowName) {
  const specPath = join(specsDir, `${workflowName}.spec.json`)
  return JSON.parse(readFileSync(specPath, 'utf8'))
}

// Load the prompt templates for a workflow from prompts/<name>.prompts.json.
// Returns an object mapping stage names to plain-string templates with
// {{slot}} markers. Cached per workflow name. Exported for testing.
const promptsCache = {}
export function loadPrompts(workflowName) {
  if (promptsCache[workflowName]) return promptsCache[workflowName]
  const path = join(promptsDir, `${workflowName}.prompts.json`)
  const prompts = JSON.parse(readFileSync(path, 'utf8'))
  promptsCache[workflowName] = prompts
  return prompts
}

// Interpolate {{slot}} markers in a template string. Unknown slots are
// substituted with deterministic stubs so the dry-run produces a real,
// non-placeholder prompt. Mirrors the renderPrompt helper in the JS
// workflows, but with stub fallback for runtime-only values. Exported for
// testing.
export function renderTemplate(template, vals) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key in vals) return String(vals[key])
    return STUB_SLOTS[key] !== undefined ? String(STUB_SLOTS[key]) : ''
  })
}

// Deterministic stubs for runtime-only slots the renderer cannot derive
// in dry-run. These mirror the empty/default state the JS computes when
// no workers fail and coverage is complete.
const STUB_SLOTS = {
  coverageNote: '',
  rawFindings: '[]',
  reviewedAreas: '[]',
  mappedAreas: '[]',
  workersFailed: '[]',
  scoutDropped: '[]',
  ceilingReached: false,
  suggestedNextActionClause: '',
  coveredCount: '0',
}

// Build the scope string the same way the JS workflows do.
function buildScope(root) {
  return `Work from the repo root scoped to "${root}". List source files with \`git ls-files -- ${root}\` (it already respects .gitignore); ignore vendored and generated trees (node_modules, dist, build, vendor, .git, coverage) and lockfiles.`
}

// Build the diffHint string the same way tm-review-changes.js does.
function buildDiffHint(base) {
  return `Get the change under review with \`git diff ${base}...HEAD\` for committed work on the branch, and \`git diff\` plus \`git status\` for any uncommitted changes; review the union. Read surrounding code before judging, and do not flag what the diff does not touch.`
}

// The dimensions string for tm-review-codebase's area_review stage.
const CODEBASE_DIMENSIONS = `Review across these dimensions:
- bugs: adversarial correctness. Logic errors, wrong or missing edge-case handling, broken error paths, races and ordering bugs, off-by-one, misused or wrongly-assumed APIs, null and boundary handling, resource leaks.
- security: untrusted input reaching a sink (injection, path traversal, SSRF, unsafe deserialization), missing authn or authz, secrets or credentials in code or logs, unsafe defaults, weak crypto, risky dependencies.
- scope: speculative abstraction, dead configurability, code that could be much smaller.
- tests: behavior with no test pinning it, logic with a right answer lacking a test, integration points with no fixture coverage.
- style: project code and writing style (em dashes, AI-cliche phrases, hard-coded user-facing strings, raw primitives where dedicated types exist, comments that restate code).`

/**
 * renderWorkflow(workflowName, args) -> report
 *
 * Executes a workflow by driving its spec through the Hermes adapter.
 * Handles all three parallelism modes (single, fixed-list, dynamic-list)
 * and the fallback ladder for stages that declare one.
 */
export async function renderWorkflow(workflowName, args = {}) {
  const spec = loadSpec(workflowName)
  const prompts = loadPrompts(workflowName)
  const stages = spec.stages
  const log = (msg) => console.warn(`[renderer:${workflowName}] ${msg}`)

  // Shared render inputs derived from args, reused across stages.
  const root = safeArg(args.path, '.')
  const base = safeArg(args.base, 'origin/main')

  // Execution context: accumulates results from each stage.
  const ctx = {}

  // Execute stages in declaration order. Dynamic-list stages read their
  // item list from a previous stage's output (items_source).
  for (const [name, stage] of Object.entries(stages)) {
    log(`stage: ${name} (tier: ${stage.tier}, parallelism: ${stage.parallelism})`)

    if (stage.parallelism === 'single') {
      const report = await executeStage(stage, name, ctx, args, log, prompts, root, base)
      ctx[name] = report
    } else if (stage.parallelism === 'fixed-list') {
      const items = getFixedListItems(stage, ctx, args)
      const reports = await executeParallel(stage, name, items, ctx, args, log, prompts, root, base)
      ctx[name] = reports
    } else if (stage.parallelism === 'dynamic-list') {
      const items = getDynamicListItems(stage, ctx, args)
      const reports = await executeParallel(stage, name, items, ctx, args, log, prompts, root, base)
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
async function executeStage(stage, name, ctx, args, log, prompts, root, base) {
  const task = buildTaskPrompt(stage, name, ctx, args, prompts, root, base)
  const opts = { tier: stage.tier, schema: stage.schema, role: inferRole(name) }

  const report = await spawn(inferRole(name), task, opts)

  if (detectFailure(report) && stage.fallback) {
    log(`stage ${name}: primary failed, retrying on ${stage.fallback.to_tier}`)
    return await retry(task, { ...opts, role: inferRole(name) }, stage.fallback.to_tier)
  }

  return report
}

// Execute a parallel stage (fixed-list or dynamic-list).
async function executeParallel(stage, name, items, ctx, args, log, prompts, root, base) {
  const tasks = items.map((item) => {
    const task = buildItemTaskPrompt(stage, name, item, ctx, args, prompts, root, base)
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

// Validate an arg against path/ref-safe chars; fall back to the default if it
// contains shell metacharacters. Mirrors safeRef in the JS workflows so the
// interpolated prompt text cannot inject.
function safeArg(value, fallback) {
  return typeof value === 'string' && /^[\w.~^\/\-]+$/.test(value) && !value.includes('..')
    ? value
    : fallback
}

// Collect the slot values a single stage needs, derivable from args and the
// shared render inputs. Runtime-only slots (coverageNote, rawFindings, etc.)
// are filled by STUB_SLOTS in renderTemplate so the dry-run prompt is real
// without duplicating the JS's imperative assembly logic.
function collectSlotVals(name, args, root, base) {
  const vals = {}
  if (name === 'scout') {
    vals.scope = buildScope(root)
    vals.root = root
    vals.maxAreas = String(Number.isInteger(args.areas) && args.areas > 0 ? args.areas : 24)
  } else if (name === 'area_review') {
    vals.dimensions = CODEBASE_DIMENSIONS
  } else if (name === 'area_map') {
    // repoMap is derived from the scout result in the JS; stubbed here.
  } else if (name === 'architecture_review') {
    vals.scope = buildScope(root)
  } else if (name === 'review') {
    // brief and diffHint are per-item; supplied by buildItemTaskPrompt.
    vals.diffHint = buildDiffHint(base)
  } else if (name === 'consolidate' || name === 'synthesize') {
    if (name === 'consolidate') vals.diffHint = buildDiffHint(base)
  }
  return vals
}

// Build the task prompt for a single stage.
function buildTaskPrompt(stage, name, ctx, args, prompts, root, base) {
  const template = prompts[name]
  if (!template) {
    throw new Error(`No prompt template for stage "${name}". Missing from prompts JSON?`)
  }
  const vals = collectSlotVals(name, args, root, base)
  return renderTemplate(template, vals)
}

// Build the task prompt for a parallel stage item.
function buildItemTaskPrompt(stage, name, item, ctx, args, prompts, root, base) {
  const template = prompts[name]
  if (!template) {
    throw new Error(`No prompt template for stage "${name}". Missing from prompts JSON?`)
  }
  const vals = collectSlotVals(name, args, root, base)
  // Per-item slots: the area/dimension name and paths.
  if (item && typeof item === 'object') {
    vals.areaName = item.name || ''
    vals.areaPaths = Array.isArray(item.paths) ? item.paths.join(', ') : ''
    vals.repoMap = '' // stub: derived from the scout result in the JS
    vals.brief = item.brief || ''
  }
  return renderTemplate(template, vals)
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
