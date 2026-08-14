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

  const ctx = {}

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

  const stageNames = Object.keys(stages)
  const lastName = stageNames[stageNames.length - 1]
  return ctx[lastName]
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

function getDynamicListItems(stage, ctx, args) {
  const parts = stage.items_source.split('.')
  let val = ctx
  for (const part of parts) {
    val = val?.[part]
  }
  if (!Array.isArray(val)) {
    return [{ name: 'stub-area', paths: ['.'], why: 'stub' }]
  }
  const cap = args[stage.items_cap] || stage.items_default_cap || Infinity
  return val.slice(0, cap)
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
