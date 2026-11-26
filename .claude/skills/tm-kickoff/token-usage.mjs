#!/usr/bin/env node
// Per-seat token table for one Claude Code session: the lead transcript plus
// every subagent transcript under <session>/subagents (workflows included).
// Real `usage` numbers only, deduped on message.id. Tokens, no prices.
//
// Usage: node token-usage.mjs --session <id> [--since <ISO time>] [--project-dir <dir>]
// Exit 1 with a message on stderr when the transcript is missing or an
// argument is bad; callers note that and carry on.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

const FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']

function fail(msg) {
  console.error(`token-usage: ${msg}`)
  process.exit(1)
}

// Sums one transcript. A message is written once per content block with the
// same id and usage, so only the first line of each id counts.
function sumFile(file, sinceMs) {
  const seen = new Set()
  const sums = FIELDS.map(() => 0)
  let model = ''
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
    if (!model && m.model && m.model !== '<synthetic>') model = m.model
  }
  return { sums, model, count: seen.size }
}

function readMeta(file) {
  try { return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch { return {} }
}

function seats(projectDir, session, sinceMs) {
  const leadFile = join(projectDir, `${session}.jsonl`)
  if (!existsSync(leadFile)) fail(`no transcript at ${leadFile}`)
  const out = [{ label: 'lead', ...sumFile(leadFile, sinceMs) }]
  const subDir = join(projectDir, session, 'subagents')
  if (existsSync(subDir)) {
    const files = readdirSync(subDir, { recursive: true })
      .filter((f) => /^agent-[^/]*\.jsonl$/.test(basename(f)))
      .sort()
    for (const f of files) {
      const file = join(subDir, f)
      const meta = readMeta(file)
      const r = sumFile(file, sinceMs)
      const label = [meta.agentType ?? 'agent', meta.description].filter(Boolean).join(': ')
      out.push({ label, ...r, model: r.model || meta.model || '' })
    }
  }
  return out.filter((s) => s.count > 0)
}

function table(rows) {
  const n = (v) => v.toLocaleString('en-US')
  const total = FIELDS.map((_, i) => rows.reduce((a, r) => a + r.sums[i], 0))
  const line = (cells) => `| ${cells.join(' | ')} |`
  return [
    line(['Seat', 'Model', 'Input', 'Cache write', 'Cache read', 'Output']),
    line(['---', '---', '---:', '---:', '---:', '---:']),
    ...rows.map((r) => line([r.label, r.model, ...r.sums.map(n)])),
    line(['Total', '', ...total.map(n)]),
  ].join('\n')
}

const { values } = parseArgs({
  options: { session: { type: 'string' }, since: { type: 'string' }, 'project-dir': { type: 'string' } },
})
if (!values.session) fail('--session <id> is required')
const sinceMs = values.since === undefined ? null : Date.parse(values.since)
if (Number.isNaN(sinceMs)) fail(`--since is not a time: ${values.since}`)

const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const projectDir = values['project-dir'] ?? join(base, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
console.log(table(seats(projectDir, values.session, sinceMs)))
