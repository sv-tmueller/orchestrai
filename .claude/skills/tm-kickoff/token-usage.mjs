#!/usr/bin/env node
// Per-seat token table for one Claude Code session: the lead transcript plus
// every subagent transcript under <session>/subagents (workflows included).
// Real `usage` numbers only, deduped on message.id. The $ column is the API
// list price from token-prices.json, worked out per message (one seat can mix
// models and speeds). It is not a subscription charge.
//
// Usage: node token-usage.mjs --session <id> [--since <ISO time>] [--project-dir <dir>]
//                             [--prices <file>]
// Exit 1 with a message on stderr when the transcript is missing or an
// argument is bad; callers note that and carry on.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

const FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']

function fail(msg) {
  console.error(`token-usage: ${msg}`)
  process.exit(1)
}

// USD for one message, or null when there is no rate to use: an unknown model,
// or a fast message for a model with no fast rates. Never a guessed rate.
// Fast mode scales the cache rates by the same factor as input (the pricing
// page stacks the cache multipliers on top of the fast rate).
function price(model, u, prices) {
  const r = prices.models[model]
  const fast = u.speed === 'fast'
  if (!r || (fast && !r.fast)) return null
  const k = fast ? r.fast.input / r.input : 1
  const cc = u.cache_creation
  const split = typeof cc?.ephemeral_5m_input_tokens === 'number' || typeof cc?.ephemeral_1h_input_tokens === 'number'
  const w5 = split ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0
  const w1 = split ? cc.ephemeral_1h_input_tokens ?? 0 : 0
  return (
    (u.input_tokens ?? 0) * (fast ? r.fast.input : r.input) +
    w5 * r.cache_write_5m * k +
    w1 * r.cache_write_1h * k +
    (u.cache_read_input_tokens ?? 0) * r.cache_read * k +
    (u.output_tokens ?? 0) * (fast ? r.fast.output : r.output)
  ) / 1e6
}

// Sums one transcript. A message is written once per content block with the
// same id and usage, so only the first line of each id counts.
function sumFile(file, sinceMs, prices) {
  const seen = new Set()
  const sums = FIELDS.map(() => 0)
  let model = ''
  let usd = 0
  let unpriced = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const m = e.message
    if (e.type !== 'assistant' || !m?.usage) continue
    if (sinceMs !== null && !(Date.parse(e.timestamp) >= sinceMs)) continue
    if (m.id) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
    }
    FIELDS.forEach((f, i) => { sums[i] += m.usage[f] ?? 0 })
    if (m.model === '<synthetic>') continue
    if (!model && m.model) model = m.model
    const p = price(m.model, m.usage, prices)
    if (p === null) unpriced = true
    else usd += p
  }
  return { sums, model, count: seen.size, usd, unpriced }
}

function readMeta(file) {
  try { return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch { return {} }
}

function seats(projectDir, session, sinceMs, prices) {
  const leadFile = join(projectDir, `${session}.jsonl`)
  if (!existsSync(leadFile)) fail(`no transcript at ${leadFile}`)
  const out = [{ label: 'lead', ...sumFile(leadFile, sinceMs, prices) }]
  const subDir = join(projectDir, session, 'subagents')
  if (existsSync(subDir)) {
    const files = readdirSync(subDir, { recursive: true })
      .filter((f) => /^agent-[^/]*\.jsonl$/.test(basename(f)))
      .sort()
    for (const f of files) {
      const file = join(subDir, f)
      const meta = readMeta(file)
      const r = sumFile(file, sinceMs, prices)
      const label = [meta.agentType ?? 'agent', meta.description].filter(Boolean).join(': ')
      out.push({ label, ...r, model: r.model || meta.model || '' })
    }
  }
  return out.filter((s) => s.count > 0)
}

function table(rows, prices) {
  const n = (v) => v.toLocaleString('en-US')
  const money = ({ usd, unpriced }) => {
    const d = `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    return !unpriced ? d : usd > 0 ? `${d} (+ unpriced)` : 'unpriced'
  }
  const total = FIELDS.map((_, i) => rows.reduce((a, r) => a + r.sums[i], 0))
  const all = { usd: rows.reduce((a, r) => a + r.usd, 0), unpriced: rows.some((r) => r.unpriced) }
  const line = (cells) => `| ${cells.join(' | ')} |`
  return [
    line(['Seat', 'Model', 'Input', 'Cache write', 'Cache read', 'Output', '$']),
    line(['---', '---', '---:', '---:', '---:', '---:', '---:']),
    ...rows.map((r) => line([r.label, r.model, ...r.sums.map(n), money(r)])),
    line(['Total', '', ...total.map(n), money(all)]),
    '',
    `$ = API list price from token-prices.json (retrieved ${prices.retrieved}), not a subscription charge.`,
  ].join('\n')
}

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    since: { type: 'string' },
    'project-dir': { type: 'string' },
    prices: { type: 'string' },
  },
})
if (!values.session) fail('--session <id> is required')
const sinceMs = values.since === undefined ? null : Date.parse(values.since)
if (Number.isNaN(sinceMs)) fail(`--since is not a time: ${values.since}`)

const pricesFile = values.prices ?? join(dirname(fileURLToPath(import.meta.url)), 'token-prices.json')
let prices
try { prices = JSON.parse(readFileSync(pricesFile, 'utf8')) } catch (e) { fail(`cannot read prices ${pricesFile}: ${e.message}`) }

const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const projectDir = values['project-dir'] ?? join(base, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
console.log(table(seats(projectDir, values.session, sinceMs, prices), prices))
