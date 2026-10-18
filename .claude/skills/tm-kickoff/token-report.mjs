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

// Extracts visible chars (text + JSON.stringify(tool_use.input)) and the
// tool_use count from one assistant line's content blocks. Thinking is never
// counted.
function visibleOf(content) {
  if (!Array.isArray(content)) return { chars: 0, toolUses: 0 }
  let chars = 0
  let toolUses = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      chars += block.text.length
    } else if (block.type === 'tool_use') {
      chars += JSON.stringify(block.input ?? {}).length
      toolUses += 1
    }
  }
  return { chars, toolUses }
}

// Parses one transcript's raw JSONL text into deduplicated per-turn usage
// records tagged with the given role. First line wins for model, timestamp
// and usage numbers; visible chars accumulate across every line sharing an
// id, since a single turn can be split into thinking/text/tool_use lines
// that all repeat the same usage object. Tool uses accumulate the same way.
//
// The lead's output_tokens is taken from the first line: every line of a lead
// turn repeats the final count. Subagent transcripts carry no reliable count
// (streamed lines can grow), so their output stays a visible-chars estimate.
function parseTranscript(text, role, agentHex, label, isLead = false) {
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

    const { chars, toolUses } = visibleOf(message.content)

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
        label: label ?? null,
        model: message.model,
        timestamp: entry.timestamp,
        input: usage.input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cache5m,
        cache1h,
        splitMissing: !cacheCreation && (usage.cache_creation_input_tokens ?? 0) > 0,
        visibleChars: 0,
        toolUses: 0,
      }
      if (isLead && typeof usage.output_tokens === 'number') record.outputTokens = usage.output_tokens
      byId.set(id, record)
      order.push(id)
    }
    record.visibleChars += chars
    record.toolUses += toolUses
  }

  return order.map((id) => {
    const record = byId.get(id)
    record.outputEstimated = record.outputTokens === undefined
    record.outputTokens ??= Math.round(record.visibleChars / 4)
    return record
  })
}

// Scans the lead transcript for Agent tool_use dispatches and their matching
// tool_result (which carries the agentId hex), building a hex -> role map. It
// also maps each Workflow launch's runId to its workflow name.
function buildRoleMap(leadText) {
  const roleByToolUseId = new Map()
  const roleByAgentHex = new Map()
  const workflowByRunId = new Map()

  for (const line of leadText.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const launch = entry.type === 'user' ? entry.toolUseResult : null
    if (launch?.taskType === 'local_workflow' && launch.runId && launch.workflowName) {
      workflowByRunId.set(String(launch.runId), String(launch.workflowName))
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

  return { roleByAgentHex, workflowByRunId }
}

/**
 * Parses a lead transcript and, optionally, its subagent transcripts into a
 * flat array of deduplicated usage records tagged with a role.
 *
 * A subagent entry with a workflowRunId came from a Workflow run. Its role is
 * workflow:<name> (the launching workflow's name, else the run id) and its
 * optional label names the agent() call.
 *
 * @param {{lead: string, subagents?: Array<{hex: string, text: string, workflowRunId?: string, label?: string}>}} sources
 */
export function parse({ lead, subagents = [] }) {
  const records = parseTranscript(lead, 'lead', null, null, true)
  if (subagents.length > 0) {
    const roleMap = buildRoleMap(lead)
    for (const sub of subagents) {
      records.push(...parseTranscript(sub.text, roleOf(sub, roleMap), sub.hex, sub.label))
    }
  }
  return records
}

function roleOf({ hex, workflowRunId }, { roleByAgentHex, workflowByRunId }) {
  if (workflowRunId) return `workflow:${workflowByRunId.get(workflowRunId) ?? workflowRunId}`
  return roleByAgentHex.get(hex) ?? 'unmapped'
}

function windowBounds({ since, until } = {}) {
  const from = since ? Date.parse(since) : -Infinity
  const to = until ? Date.parse(until) : Infinity
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('--since/--until must be ISO timestamps')
  return { from, to }
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

function emptyBucket() {
  return { calls: 0, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 0, outputEstimated: false, splitMissing: false }
}

function addToBucket(bucket, record) {
  bucket.calls += 1
  bucket.input += record.input
  bucket.cacheRead += record.cacheRead
  bucket.cache5m += record.cache5m
  bucket.cache1h += record.cache1h
  bucket.visibleChars += record.visibleChars
  bucket.outputTokens += record.outputTokens
  bucket.outputEstimated ||= record.outputEstimated
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

  const { from, to } = windowBounds({ since, until })

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
// perAgent
// ---------------------------------------------------------------------------

function parseLines(text) {
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A torn or foreign line is skipped, like everywhere else in this file.
    }
  }
  return entries
}

function tagValue(block, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)
  return match ? match[1].trim() : null
}

// The three line shapes a task notification arrives in. Tool results are
// never read: a lead that greps transcripts quotes notifications in them.
function notificationText(entry) {
  if (entry.type === 'queue-operation' && entry.operation === 'enqueue') return entry.content
  if (entry.type === 'attachment' && entry.attachment?.commandMode === 'task-notification') return entry.attachment.prompt
  if (entry.type === 'user' && entry.origin?.kind === 'task-notification') return entry.message?.content
  return null
}

// Task notifications found in the lead transcript, inside the window. The same
// notification shows up in two or three carriers, so copies that agree on
// task id, tool-use id, status and duration merge into one.
function findNotifications(lead, { from, to }) {
  const merged = new Map()
  for (const entry of parseLines(lead)) {
    const text = notificationText(entry)
    if (typeof text !== 'string') continue
    const t = Date.parse(entry.timestamp ?? entry.attachment?.timestamp)
    if (Number.isNaN(t) || t < from || t >= to) continue
    for (const [, block] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const taskId = tagValue(block, 'task-id')
      if (!taskId) continue
      const duration = tagValue(block, 'duration_ms')
      const note = {
        taskId,
        toolUseId: tagValue(block, 'tool-use-id'),
        status: tagValue(block, 'status'),
        durationMs: duration !== null && Number.isFinite(Number(duration)) ? Number(duration) : null,
      }
      merged.set(`${note.taskId}|${note.toolUseId}|${note.status}|${note.durationMs}`, note)
    }
  }
  return [...merged.values()]
}

// First timestamp in the window, the whole first-to-last span, and the sum of
// per-run spans. A coordinator line (a SendMessage resume) starts a new run, so
// a seat resumed hours later does not count the idle gap.
function transcriptTiming(text, { from, to }) {
  let start = Infinity
  let first = Infinity
  let last = -Infinity
  let run = 0
  const runs = new Map()
  for (const entry of parseLines(text)) {
    if (entry.type === 'user' && entry.origin?.kind === 'coordinator') run += 1
    const t = Date.parse(entry.timestamp)
    if (Number.isNaN(t) || t < from || t >= to) continue
    start = Math.min(start, t)
    first = Math.min(first, t)
    last = Math.max(last, t)
    const span = runs.get(run) ?? { min: t, max: t }
    span.min = Math.min(span.min, t)
    span.max = Math.max(span.max, t)
    runs.set(run, span)
  }
  if (start === Infinity) return null
  let runSpanMs = 0
  for (const { min, max } of runs.values()) runSpanMs += max - min
  return { start, spanMs: last - first, runSpanMs }
}

/**
 * Builds one row per transcript with a timestamped line in the window: the
 * lead, each dispatched seat and each workflow subagent. wallClockMs is null
 * (source "none") when no source gives a positive value. Sources:
 * "notification" (measured duration_ms), "span" (sum of run spans, estimated),
 * "lead-span" (first to last line, estimated, includes idle time).
 *
 * @param {{lead: string, subagents?: Array}} sources
 * @param {{since?: string, until?: string}} window
 */
export function perAgent({ lead, subagents = [] }, window = {}) {
  const bounds = windowBounds(window)
  const records = parse({ lead, subagents }).filter((r) => {
    const t = Date.parse(r.timestamp)
    return t >= bounds.from && t < bounds.to
  })
  const roleMap = buildRoleMap(lead)
  const notifications = findNotifications(lead, bounds)

  function row(owner, role, label, timing, wallClockMs, source) {
    const mine = records.filter((r) => r.agent === owner)
    return {
      start: new Date(timing.start).toISOString(),
      role,
      label: label ?? null,
      models: [...new Set(mine.map((r) => r.model))].sort(),
      calls: mine.length,
      toolUses: mine.reduce((n, r) => n + r.toolUses, 0),
      outputTokens: mine.reduce((n, r) => n + r.outputTokens, 0),
      outputEstimated: mine.some((r) => r.outputEstimated),
      wallClockMs: wallClockMs > 0 ? wallClockMs : null,
      source: wallClockMs > 0 ? source : 'none',
    }
  }

  const rows = []
  const leadTiming = transcriptTiming(lead, bounds)
  const leadRow = leadTiming && row(null, 'lead', null, leadTiming, leadTiming.spanMs, 'lead-span')

  for (const sub of subagents) {
    const timing = transcriptTiming(sub.text, bounds)
    if (!timing) continue
    const notes = sub.workflowRunId ? [] : notifications.filter((n) => n.taskId === sub.hex)
    const measured = notes.length > 0 && notes.every((n) => n.durationMs > 0)
    rows.push(
      measured
        ? row(sub.hex, roleOf(sub, roleMap), sub.label, timing, notes.reduce((n, x) => n + x.durationMs, 0), 'notification')
        : row(sub.hex, roleOf(sub, roleMap), sub.label, timing, timing.runSpanMs, 'span')
    )
  }

  rows.sort((a, b) => a.start.localeCompare(b.start) || a.role.localeCompare(b.role) || (a.label ?? '').localeCompare(b.label ?? ''))
  return leadRow ? [leadRow, ...rows] : rows
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

function fmtOutput(item) {
  return `${fmtInt(item.outputTokens)}${item.outputEstimated ? ' (est.)' : ''}`
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
    '| Role | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est. where marked) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const role of roles) {
    const b = byRole[role]
    lines.push(
      `| ${role} | ${b.calls} | ${fmtInt(b.input)} | ${fmtInt(b.cacheRead)} | ${fmtInt(b.cache5m)} | ${fmtInt(b.cache1h)} | ${fmtOutput(b)} |`
    )
  }
  return lines.join('\n')
}

function modelTable(priced, totals) {
  const lines = [
    '| Model | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est. where marked) | Cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const row of priced.rows) {
    const label = row.cost == null ? `${row.model} (unpriced)` : row.model
    lines.push(
      `| ${label} | ${row.calls} | ${fmtInt(row.input)} | ${fmtInt(row.cacheRead)} | ${fmtInt(row.cache5m)} | ${fmtInt(row.cache1h)} | ${fmtOutput(row)} | ${fmtCost(row.cost)} |`
    )
  }
  lines.push(
    `| **Total** | ${totals.calls} | ${fmtInt(totals.input)} | ${fmtInt(totals.cacheRead)} | ${fmtInt(totals.cache5m)} | ${fmtInt(totals.cache1h)} | ${fmtOutput(totals)} | **${fmtCost(priced.pricedTotal)}** |`
  )
  return lines.join('\n')
}

function fmtDuration(ms) {
  const total = Math.round(ms / 1000)
  if (total < 1) return '<1s'
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

const SOURCE_LABELS = {
  notification: { text: 'task notification duration_ms', estimated: false },
  span: { text: 'transcript span', estimated: true },
  'lead-span': { text: 'lead first-to-last span', estimated: true },
}

function agentTable(agents) {
  const lines = [
    '| Start (UTC) | Role | Model | Calls | Tool uses | Output (est. where marked) | Wall-clock | Source |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const a of agents) {
    const source = SOURCE_LABELS[a.source]
    const wallClock = source && a.wallClockMs != null ? `${fmtDuration(a.wallClockMs)}${source.estimated ? ' (est.)' : ''}` : 'n/a'
    const role = a.label ? `${a.role} (${a.label.replace(/\s*[\r\n]+\s*/g, ' ').replaceAll('|', '\\|')})` : a.role
    lines.push(
      `| ${a.start.slice(0, 19).replace('T', ' ')} | ${role} | ${a.models.join(', ') || '-'} | ${a.calls} | ${a.toolUses} | ${fmtOutput(a)} | ${wallClock} | ${source && a.wallClockMs != null ? source.text : 'n/a'} |`
    )
  }
  return lines.join('\n')
}

function limitations(priced, agents, unread) {
  const lines = [
    '- Output: lead figures are measured from the lead transcript\'s `usage.output_tokens`. Subagent transcripts carry no reliable count, so subagent figures are visible text plus tool-call input divided by 4, marked "(est.)". A by-model or total figure that includes any estimate is marked too.',
    '- The estimate leaves out thinking tokens, so it undercounts real output token usage.',
    '- Prices are Anthropic public list prices, not your actual billing (discounts, batch pricing and negotiated rates are not reflected).',
  ]
  if (agents.length > 0) {
    lines.push(
      '- Wall-clock: "task notification duration_ms" is the time the harness measured for a dispatched seat. "transcript span" is the first-to-last timestamp span of each run in a transcript, used for workflow subagents and for a seat with no positive measured duration. "est." marks a span. The lead row spans its first to last line in the window, so it includes idle and waiting time. "n/a" means no source gave a positive value.',
      '- Tool uses are counted from tool_use blocks in each transcript.'
    )
  }
  if (unread.length > 0) {
    // The report is posted publicly: never print an agent id, even from an unknown entry.
    const names = unread.map((entry) => entry.replace(/agent-[^/\s,]+/g, 'agent-<id>'))
    lines.push(`- Found but not read (left out of every total): ${names.join(', ')}.`)
  }
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
 * agents (from perAgent) adds the By agent table when non-empty. unread lists
 * paths that were found but could not be read.
 *
 * @param {{session: string, aggregated: ReturnType<typeof aggregate>, priced: ReturnType<typeof price>, priceTable: object, agents?: ReturnType<typeof perAgent>, unread?: string[]}} input
 */
export function render({ session, aggregated, priced, priceTable, agents = [], unread = [] }) {
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
    ...(agents.length > 0 ? ['## By agent', '', agentTable(agents), ''] : []),
    '## Limitations',
    '',
    limitations(priced, agents, unread),
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

const isAgentTranscript = (name) => name.startsWith('agent-') && name.endsWith('.jsonl')
const hexOf = (name) => name.slice('agent-'.length, -'.jsonl'.length)

// The agent() label from a workflow subagent's meta sidecar. A missing or
// malformed sidecar only costs the label, never the report.
function readLabel(path) {
  try {
    const { description } = JSON.parse(readFileSync(path, 'utf8'))
    return typeof description === 'string' && description ? description : undefined
  } catch {
    return undefined
  }
}

// Given the lead transcript path (either from the positional argument or
// resolved from --session), returns the sibling subagent transcripts: the
// plain ones under subagents/ and the workflow ones under
// subagents/workflows/<runId>/. Anything it finds but cannot read, or does not
// know the layout of, goes into unread (paths relative to the session dir),
// so the report can name it instead of leaving it out silently. An unreadable
// transcript is reported as its directory plus a count, so no agent id (the
// file name) reaches the public report.
function findSubagents(leadPath) {
  const sessionDir = join(dirname(leadPath), basename(leadPath, '.jsonl'))
  const subagents = []
  const unread = []
  const unreadTranscripts = new Map()
  const rel = (path) => path.slice(sessionDir.length + 1)

  function list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      unread.push(rel(dir))
      return []
    }
  }

  function readTranscript(path, extra) {
    try {
      subagents.push({ hex: hexOf(basename(path)), text: readFileSync(path, 'utf8'), ...extra })
    } catch {
      const dir = rel(dirname(path))
      unreadTranscripts.set(dir, (unreadTranscripts.get(dir) || 0) + 1)
    }
  }

  const root = join(sessionDir, 'subagents')
  if (!existsSync(root)) return { subagents, unread }
  const finish = () => {
    for (const [dir, count] of unreadTranscripts) unread.push(`${dir} (${count} ${count === 1 ? 'transcript' : 'transcripts'})`)
    return { subagents, unread }
  }

  for (const entry of list(root)) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && entry.name === 'workflows') {
      for (const run of list(path)) {
        if (!run.isDirectory()) continue
        const runDir = join(path, run.name)
        for (const item of list(runDir)) {
          const itemPath = join(runDir, item.name)
          if (item.isDirectory()) unread.push(rel(itemPath))
          else if (isAgentTranscript(item.name)) {
            const label = readLabel(join(runDir, `agent-${hexOf(item.name)}.meta.json`))
            readTranscript(itemPath, { workflowRunId: run.name, label })
          }
        }
      }
    } else if (entry.isDirectory()) {
      unread.push(rel(path))
    } else if (isAgentTranscript(entry.name)) {
      readTranscript(path)
    }
  }
  return finish()
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
  const { subagents, unread } = findSubagents(leadPath)
  const window = { since: opts.since, until: opts.until }
  const records = parse({ lead, subagents })
  const aggregated = aggregate(records, window)
  const agents = perAgent({ lead, subagents }, window)
  const priceTable = JSON.parse(readFileSync(join(__dir, 'token-prices.json'), 'utf8'))
  const priced = price(aggregated, priceTable)
  const session = opts.session || basename(leadPath, '.jsonl')
  process.stdout.write(render({ session, aggregated, priced, priceTable, agents, unread }) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
