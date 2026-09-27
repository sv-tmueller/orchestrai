#!/usr/bin/env node
// Token-usage report for a Claude Code session transcript (issue #379).
//
// Reads a lead transcript (and, when present, its subagents' transcripts),
// de-duplicates streamed usage lines, maps each call to a role, sums tokens
// by role and by model, prices the totals against a verified price table,
// and renders a markdown report. It never prints transcript content, only
// counts and derived stats.
//
// Exports are pure (parse, aggregate, price, render); main() is the only
// part that touches argv, the filesystem, or process.exit.

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { homedir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

// Strips a marketplace-style prefix ("team:developer" -> "developer"). Real
// subagent_type values seen so far carry no prefix, but the Agent tool_use
// payload does not guarantee that, so this is defensive.
function stripPrefix(subagentType) {
  const i = subagentType.lastIndexOf(':')
  return i === -1 ? subagentType : subagentType.slice(i + 1)
}

// Extracts visible chars (text + JSON.stringify(tool_use.input)) from one
// assistant line's content blocks. Thinking is never counted.
function visibleCharsOf(content) {
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length
    } else if (block.type === 'tool_use') {
      chars += JSON.stringify(block.input ?? {}).length
    }
  }
  return chars
}

// Parses one transcript's raw JSONL text into deduplicated per-turn usage
// records tagged with the given role. First line wins for model, timestamp
// and usage numbers; visible chars accumulate across every line sharing an
// id, since a single turn can be split into thinking/text/tool_use lines
// that all repeat the same usage object.
function parseTranscript(text, role, agentHex) {
  const byId = new Map()
  const order = []

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    const message = entry.message
    if (!message || message.type !== 'message') continue
    if (message.model === '<synthetic>') continue
    const id = message.id
    if (!id) continue

    const chars = visibleCharsOf(message.content)

    let record = byId.get(id)
    if (!record) {
      const usage = message.usage || {}
      const cacheCreation = usage.cache_creation || null
      const cache5m = cacheCreation
        ? cacheCreation.ephemeral_5m_input_tokens ?? 0
        : usage.cache_creation_input_tokens ?? 0
      const cache1h = cacheCreation ? cacheCreation.ephemeral_1h_input_tokens ?? 0 : 0
      record = {
        id,
        role,
        agent: agentHex ?? null,
        model: message.model,
        timestamp: entry.timestamp,
        input: usage.input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cache5m,
        cache1h,
        splitMissing: !cacheCreation && (usage.cache_creation_input_tokens ?? 0) > 0,
        visibleChars: 0,
      }
      byId.set(id, record)
      order.push(id)
    }
    record.visibleChars += chars
  }

  return order.map((id) => byId.get(id))
}

// Scans the lead transcript for Agent tool_use dispatches and their matching
// tool_result (which carries the agentId hex), building a hex -> role map.
function buildRoleMap(leadText) {
  const roleByToolUseId = new Map()
  const roleByAgentHex = new Map()

  for (const line of leadText.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Agent' && block.input?.subagent_type) {
          roleByToolUseId.set(block.id, stripPrefix(String(block.input.subagent_type)))
        }
      }
    } else if (entry.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        const role = roleByToolUseId.get(block.tool_use_id)
        if (!role) continue
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c?.text ?? '').join('\n')
          : String(block.content ?? '')
        const match = /agentId:\s*([0-9a-f]+)/.exec(text)
        if (match) roleByAgentHex.set(match[1], role)
      }
    }
  }

  return roleByAgentHex
}

/**
 * Parses a lead transcript and, optionally, its subagent transcripts into a
 * flat array of deduplicated usage records tagged with a role.
 *
 * @param {{lead: string, subagents?: Array<{hex: string, text: string}>}} sources
 */
export function parse({ lead, subagents = [] }) {
  const records = parseTranscript(lead, 'lead')
  if (subagents.length > 0) {
    const roleMap = buildRoleMap(lead)
    for (const { hex, text } of subagents) {
      const role = roleMap.get(hex) ?? 'unmapped'
      records.push(...parseTranscript(text, role, hex))
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

function emptyBucket() {
  return { calls: 0, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 0, splitMissing: false }
}

function addToBucket(bucket, record) {
  bucket.calls += 1
  bucket.input += record.input
  bucket.cacheRead += record.cacheRead
  bucket.cache5m += record.cache5m
  bucket.cache1h += record.cache1h
  bucket.visibleChars += record.visibleChars
  bucket.outputTokens += Math.round(record.visibleChars / 4)
  bucket.splitMissing ||= record.splitMissing
}

/**
 * Filters records to the [since, until) window (since inclusive, until
 * exclusive; either bound may be omitted) and groups tokens by role and by
 * model.
 *
 * @param {Array} records
 * @param {{since?: string, until?: string}} window
 */
export function aggregate(records, { since, until } = {}) {
  const byRole = {}
  const byModel = {}
  const totals = emptyBucket()

  const from = since ? Date.parse(since) : -Infinity
  const to = until ? Date.parse(until) : Infinity
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('--since/--until must be ISO timestamps')

  for (const record of records) {
    const t = Date.parse(record.timestamp)
    if (t < from || t >= to) continue

    byRole[record.role] ??= emptyBucket()
    byModel[record.model] ??= emptyBucket()
    addToBucket(byRole[record.role], record)
    addToBucket(byModel[record.model], record)
    addToBucket(totals, record)
  }

  return { since: since ?? null, until: until ?? null, byRole, byModel, totals }
}

// ---------------------------------------------------------------------------
// price
// ---------------------------------------------------------------------------

const TOKENS_PER_PRICE_UNIT = 1_000_000

/**
 * Prices per-model totals against a price table (see token-prices.json for
 * the shape). Unknown models are returned unpriced and are never included in
 * the priced total. A model missing its 1h cache-write price falls back to
 * the 5m rate for those tokens, and the fallback is noted.
 *
 * @param {ReturnType<typeof aggregate>} aggregated
 * @param {{models: Record<string, object>}} priceTable
 */
export function price(aggregated, priceTable) {
  const models = priceTable?.models ?? {}
  const rows = []
  const unpriced = []
  const notes = []
  let pricedTotal = 0

  for (const [model, bucket] of Object.entries(aggregated.byModel)) {
    const outputTokens = bucket.outputTokens
    const rates = models[model]

    if (bucket.splitMissing) notes.push(`${model}: some cache writes had no 5m/1h split, counted as 5m`)

    if (!rates) {
      unpriced.push(model)
      rows.push({ model, ...bucket, outputTokens, cost: null })
      continue
    }

    let cache1hRate = rates.cache_write_1h
    if (cache1hRate == null) {
      cache1hRate = rates.cache_write_5m
      if (bucket.cache1h > 0) notes.push(`${model}: no verified 1h cache-write price, used the 5m rate`)
    }

    const cost =
      (bucket.input / TOKENS_PER_PRICE_UNIT) * rates.input +
      (bucket.cache5m / TOKENS_PER_PRICE_UNIT) * rates.cache_write_5m +
      (bucket.cache1h / TOKENS_PER_PRICE_UNIT) * cache1hRate +
      (bucket.cacheRead / TOKENS_PER_PRICE_UNIT) * rates.cache_read +
      (outputTokens / TOKENS_PER_PRICE_UNIT) * rates.output

    pricedTotal += cost
    rows.push({ model, ...bucket, outputTokens, cost })
  }

  rows.sort((a, b) => a.model.localeCompare(b.model))

  return { rows, unpriced: unpriced.sort(), notes, pricedTotal }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US')
}

function fmtCost(n) {
  return n == null ? '-' : `$${n.toFixed(2)}`
}

function roleOrder(role) {
  if (role === 'lead') return 0
  if (role === 'unmapped') return 2
  return 1
}

function windowLabel(since, until) {
  if (!since && !until) return 'full transcript'
  if (since && until) return `${since} to ${until}`
  if (since) return `from ${since}`
  return `up to ${until}`
}

function roleTable(byRole) {
  const roles = Object.keys(byRole).sort((a, b) => {
    const diff = roleOrder(a) - roleOrder(b)
    return diff !== 0 ? diff : a.localeCompare(b)
  })
  const lines = [
    '| Role | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const role of roles) {
    const b = byRole[role]
    lines.push(
      `| ${role} | ${b.calls} | ${fmtInt(b.input)} | ${fmtInt(b.cacheRead)} | ${fmtInt(b.cache5m)} | ${fmtInt(b.cache1h)} | ${fmtInt(b.outputTokens)} |`
    )
  }
  return lines.join('\n')
}

function modelTable(priced, totals) {
  const lines = [
    '| Model | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) | Cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const row of priced.rows) {
    const label = row.cost == null ? `${row.model} (unpriced)` : row.model
    lines.push(
      `| ${label} | ${row.calls} | ${fmtInt(row.input)} | ${fmtInt(row.cacheRead)} | ${fmtInt(row.cache5m)} | ${fmtInt(row.cache1h)} | ${fmtInt(row.outputTokens)} | ${fmtCost(row.cost)} |`
    )
  }
  lines.push(
    `| **Total** | ${totals.calls} | ${fmtInt(totals.input)} | ${fmtInt(totals.cacheRead)} | ${fmtInt(totals.cache5m)} | ${fmtInt(totals.cache1h)} | ${fmtInt(totals.outputTokens)} | **${fmtCost(priced.pricedTotal)}** |`
  )
  return lines.join('\n')
}

function limitations(priced) {
  const lines = [
    '- Output token counts are not in the transcripts; the "Output (est.)" column is estimated from visible text and tool-call input, divided by 4.',
    '- The estimate excludes thinking tokens, so it undercounts real output token usage.',
    '- Prices are Anthropic public list prices, not your actual billing (discounts, batch pricing and negotiated rates are not reflected).',
  ]
  if (priced.unpriced.length > 0) {
    lines.push(`- Unpriced models (left out of the total): ${priced.unpriced.join(', ')}.`)
  }
  for (const note of priced.notes) {
    lines.push(`- ${note}.`)
  }
  return lines.join('\n')
}

/**
 * Renders the markdown report. Never prints transcript content, only counts
 * and derived stats.
 *
 * @param {{session: string, aggregated: ReturnType<typeof aggregate>, priced: ReturnType<typeof price>, priceTable: object}} input
 */
export function render({ session, aggregated, priced, priceTable }) {
  const header = [
    '# Token report',
    '',
    `- Session: ${session}`,
    `- Window: ${windowLabel(aggregated.since, aggregated.until)}`,
    `- Price source: ${priceTable.source} (retrieved ${priceTable.retrieved})`,
  ].join('\n')

  return [
    header,
    '',
    '## By role',
    '',
    roleTable(aggregated.byRole),
    '',
    '## By model',
    '',
    modelTable(priced, aggregated.totals),
    '',
    '## Limitations',
    '',
    limitations(priced),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// main (CLI)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { path: null, session: null, configDir: null, since: null, until: null }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--session') opts.session = rest.shift()
    else if (arg === '--config-dir') opts.configDir = rest.shift()
    else if (arg === '--since') opts.since = rest.shift()
    else if (arg === '--until') opts.until = rest.shift()
    else if (!opts.path && !arg.startsWith('--')) opts.path = arg
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!opts.path === !opts.session) throw new Error('usage: token-report.mjs <transcript.jsonl> | --session <id> [--config-dir <dir>] [--since <ISO>] [--until <ISO>]')
  return opts
}

function resolveConfigDir(opts) {
  return opts.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

// Given the lead transcript path (either from the positional argument or
// resolved from --session), returns the sibling subagent transcripts.
function findSubagents(leadPath) {
  const sessionDir = join(dirname(leadPath), basename(leadPath, '.jsonl'), 'subagents')
  if (!existsSync(sessionDir)) return []
  return readdirSync(sessionDir)
    .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
    .map((name) => ({
      hex: name.slice('agent-'.length, -'.jsonl'.length),
      text: readFileSync(join(sessionDir, name), 'utf8'),
    }))
}

function resolveLeadPath(opts) {
  if (opts.path) return opts.path

  const configDir = resolveConfigDir(opts)
  const projectsDir = join(configDir, 'projects')
  if (!existsSync(projectsDir)) {
    throw new Error(`no projects directory under config dir: ${projectsDir}`)
  }
  const matches = []
  for (const project of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, project, `${opts.session}.jsonl`)
    if (existsSync(candidate)) matches.push(candidate)
  }
  if (matches.length === 0) {
    throw new Error(`no transcript found for session ${opts.session} under ${projectsDir}`)
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous session ${opts.session}: ${matches.length} matches under ${projectsDir}`)
  }
  return matches[0]
}

export function main(argv) {
  const opts = parseArgs(argv)
  const leadPath = resolveLeadPath(opts)
  const lead = readFileSync(leadPath, 'utf8')
  const subagents = findSubagents(leadPath)
  const records = parse({ lead, subagents })
  const aggregated = aggregate(records, { since: opts.since, until: opts.until })
  const priceTable = JSON.parse(readFileSync(join(__dir, 'token-prices.json'), 'utf8'))
  const priced = price(aggregated, priceTable)
  const session = opts.session || basename(leadPath, '.jsonl')
  process.stdout.write(render({ session, aggregated, priced, priceTable }) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
