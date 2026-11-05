#!/usr/bin/env node
// Validator and normalizer for a target repo's `.orchestrai/columns.json`
// (issue #451, design WP3).
//
// Before each seat dispatch the lead reads that file from its checkout and
// turns it into a per-stage summary: which runner executes the stage, which
// provider and model it uses, and whether the lead dispatches the seat
// itself or hands the stage to that runner's poller. The parse, the
// validation rules and the local-vs-remote decision are deterministic, so
// they live here rather than in the lead's head.
//
// Exports are pure; main() is the only part that touches argv, the
// filesystem, or process.exit.
//
// Done when: the CLI prints the summary and exits 0, prints an `absent`
// marker and exits 0 when the file is missing, or prints one line and exits
// nonzero when the file is invalid.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const KINDS = ['anthropic', 'openai', 'vllm']
// v1 accepts only "wait". A runner away is never a fallback trigger: the
// package waits until a human swaps it to the VPS (design principle 5).
const ON_RUNNER_AWAY = ['wait']

// Throws on the first problem found, so the report the lead sees names one
// cause instead of a wall of them.
function fail(message) {
  throw new Error(message)
}

// The lead runs a stage itself only when the column is on the VPS and the
// provider is Claude; anything else goes to that runner's poller, the VPS
// runner included (design section 6, "Who runs a stage").
function executeFor(runner, kind) {
  return runner === 'vps' && kind === 'anthropic' ? 'lead' : `runner:${runner}`
}

function validateProvider(name, provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    fail(`provider "${name}" is not an object`)
  }
  if (!KINDS.includes(provider.kind)) {
    fail(`unknown provider kind "${provider.kind}" for provider "${name}"`)
  }
  if (provider.kind === 'vllm' && typeof provider.base_url !== 'string') {
    fail(`provider "${name}" (kind vllm) needs a base_url`)
  }
}

function validateColumn(stage, column, runners, providers) {
  if (!column || typeof column !== 'object' || Array.isArray(column)) {
    fail(`column "${stage}" is not an object`)
  }
  if (!runners.includes(column.runner)) {
    fail(`unknown runner "${column.runner}" in column "${stage}"`)
  }
  if (!Object.hasOwn(providers, column.provider)) {
    fail(`unknown provider "${column.provider}" in column "${stage}"`)
  }
  if (!EFFORTS.includes(column.effort)) {
    fail(`effort "${column.effort}" is not one of ${EFFORTS.join(', ')}`)
  }
  if (column.on_runner_away !== undefined && !ON_RUNNER_AWAY.includes(column.on_runner_away)) {
    fail(`on_runner_away "${column.on_runner_away}" is not "wait"`)
  }
  const execute = executeFor(column.runner, providers[column.provider].kind)
  // A remote runner has no adapter table to fall back on: the JOB comment
  // and the WP4 render both need the model the lead hands over.
  if (execute.startsWith('runner:') && (typeof column.model !== 'string' || column.model === '')) {
    fail(`column "${stage}" (execute ${execute}) needs a model`)
  }
  return {
    runner: column.runner,
    provider: column.provider,
    kind: providers[column.provider].kind,
    model: column.model,
    effort: column.effort,
    execute,
  }
}

// Turns a parsed columns.json into `{ stage: { runner, provider, kind,
// model, effort, execute } }`. Throws with a one-line reason when the file
// is malformed; main() prefixes it.
export function normalize(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('expected a JSON object at the root')
  }
  if (!Array.isArray(config.runners) || config.runners.length === 0) {
    fail('"runners" must be a non-empty array')
  }
  const providers = config.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    fail('"providers" must be an object')
  }
  for (const [name, provider] of Object.entries(providers)) {
    validateProvider(name, provider)
  }
  const columns = config.columns
  if (!columns || typeof columns !== 'object' || Array.isArray(columns)) {
    fail('"columns" must be an object')
  }

  const summary = {}
  for (const [stage, column] of Object.entries(columns)) {
    summary[stage] = validateColumn(stage, column, config.runners, providers)
  }
  return summary
}

// Parses raw file text: invalid JSON is a one-line report like any other
// invalid file, never a stack trace.
export function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid JSON')
  }
}

export function main(argv) {
  const fileIdx = argv.indexOf('--file')
  if (fileIdx === -1 || !argv[fileIdx + 1]) {
    process.stderr.write('usage: columns.mjs --file <path>\n')
    process.exit(2)
  }
  const path = argv[fileIdx + 1]

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Missing file is not an error: the lead falls back to its adapter
      // table, and every runner is vps (design section 5).
      process.stdout.write(JSON.stringify({ absent: true }) + '\n')
      process.exit(0)
    }
    throw err
  }

  try {
    process.stdout.write(JSON.stringify(normalize(parse(text))) + '\n')
  } catch (err) {
    process.stderr.write(`invalid columns config: ${err.message}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
}
