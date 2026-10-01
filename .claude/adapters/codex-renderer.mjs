/**
 * Codex workflow renderer (issue #316, Phase D of #311).
 *
 * Reads a workflow fan-out JSON spec from .claude/workflows/specs/ and
 * drives the Codex adapter's spawn/parallel operations. Mirrors the
 * Hermes renderer but uses codex-adapter.mjs for spawn.
 *
 * Proves the data-spec approach works on a third host: the same JSON
 * spec files consumed by the Claude Code JS renderer and the Hermes
 * renderer are consumed here via direct file read.
 *
 * See docs/architecture/adapter-interface.md section "Spec format".
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawn, detectFailure, retry } from './codex-adapter.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const specsDir = join(__dir, '..', 'workflows', 'specs')

function loadSpec(workflowName) {
  const specPath = join(specsDir, `${workflowName}.spec.json`)
  return JSON.parse(readFileSync(specPath, 'utf8'))
}

/**
 * renderWorkflow(workflowName, args) -> report
 *
 * Executes a workflow by driving its spec through the Codex adapter.
 */
export async function renderWorkflow(workflowName, args = {}) {
  const spec = loadSpec(workflowName)
  const stages = spec.stages
  const log = (msg) => console.warn(`[codex-renderer:${workflowName}] ${msg}`)

  // Execution context: accumulates results from each stage, keyed by
  // "<stage>_result" (not the bare stage name), matching the spec files'
  // items_source vocabulary (e.g. "scout_result.areas").
  const ctx = {}

  for (const [name, stage] of Object.entries(stages)) {
    log(`stage: ${name} (tier: ${stage.tier}, parallelism: ${stage.parallelism})`)

    if (stage.parallelism === 'single') {
      const report = await executeStage(stage, name, ctx, args, log)
      ctx[`${name}_result`] = report
    } else if (stage.parallelism === 'fixed-list') {
      const items = getFixedListItems(stage, ctx, args)
      const reports = await executeParallel(stage, name, items, ctx, args, log)
      ctx[`${name}_result`] = reports
    } else if (stage.parallelism === 'dynamic-list') {
      const items = getDynamicListItems(stage, ctx, args, name, log)
      const reports = await executeParallel(stage, name, items, ctx, args, log)
      ctx[`${name}_result`] = reports
    } else {
      throw new Error(`Unknown parallelism "${stage.parallelism}" in stage "${name}"`)
    }
  }

  const stageNames = Object.keys(stages)
  const lastName = stageNames[stageNames.length - 1]
  return ctx[`${lastName}_result`]
}

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

async function executeParallel(stage, name, items, ctx, args, log) {
  const reports = []
  for (const item of items) {
    const task = buildItemTaskPrompt(stage, name, item, ctx, args)
    const opts = { tier: stage.tier, schema: stage.schema, role: inferRole(name) }
    const report = await spawn(inferRole(name), task, opts)
    reports.push(report)
  }
  return reports
}

function buildTaskPrompt(stage, name, ctx, args) {
  return `Stage: ${name}. Phase: ${stage.phase}. Tier: ${stage.tier}. Args: ${JSON.stringify(args)}.`
}

function buildItemTaskPrompt(stage, name, item, ctx, args) {
  return `Stage: ${name}. Item: ${typeof item === 'string' ? item : JSON.stringify(item)}. Phase: ${stage.phase}. Tier: ${stage.tier}.`
}

function getFixedListItems(stage, ctx, args) {
  return args[stage.items_key] || [{ key: 'stub', name: 'stub-item' }]
}

// Closed set of item reducers a dynamic-list stage can name with
// items_transform. A reducer only flattens, filters and dedups; the cap stays
// the one generic step in getDynamicListItems. Keep in sync with
// hermes-renderer.mjs and the "Spec format" section of adapter-interface.md.
const ITEM_TRANSFORMS = {
  // Worker reports ({ findings: [...] }) -> unique must-fix findings.
  must_fix_deduped(reports) {
    const seen = new Set()
    const out = []
    for (const report of reports) {
      if (!report || !Array.isArray(report.findings)) continue
      for (const f of report.findings) {
        if (!f || f.severity !== 'must-fix') continue
        const key = JSON.stringify([f.file, f.line, f.problem])
        if (seen.has(key)) continue
        seen.add(key)
        out.push(f)
      }
    }
    return out
  },
}

// Exported for testing: Codex's spawn shells out, so the resolver is the
// testable seam.
export function getDynamicListItems(stage, ctx, args, name, log) {
  // An unknown transform must fail loudly: a host without the reducer would
  // otherwise fan out over unreduced items.
  const transform = stage.items_transform
  if (transform !== undefined && !Object.hasOwn(ITEM_TRANSFORMS, transform)) {
    throw new Error(`stage ${name}: unknown items_transform "${transform}"`)
  }
  // items_source is a dotted path like "scout_result.areas".
  const parts = stage.items_source.split('.')
  let val = ctx
  for (const part of parts) {
    val = val?.[part]
  }
  if (!Array.isArray(val)) {
    // Fallback (also exercised by dry-run, which never populates ctx with
    // real stage output): stub a single area, but log it so a silent
    // resolution failure on a live host is visible.
    log(
      `stage ${name}: items_source "${stage.items_source}" did not resolve to an array; falling back to 1 stub item`
    )
    return [{ name: 'stub-area', paths: ['.'], why: 'stub' }]
  }
  const items = transform ? ITEM_TRANSFORMS[transform](val) : val
  // items_cap names an args field as "args.<field>"; same coercion as the JS
  // workflows' MAX_AREAS (positive integer, else the default).
  const capField = typeof stage.items_cap === 'string' ? stage.items_cap.replace(/^args\./, '') : undefined
  const passed = capField ? args?.[capField] : undefined
  const cap = Number.isInteger(passed) && passed > 0 ? passed : stage.items_default_cap || Infinity
  if (items.length > cap) {
    log(`stage ${name}: ${items.length - cap} item(s) past the cap of ${cap} were not dispatched`)
  }
  return items.slice(0, cap)
}

function inferRole(stageName) {
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
