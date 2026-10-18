/**
 * Tests for the token-report script (issue #379).
 *
 * `token-report.mjs` ships with the plugin at
 * `.claude/skills/tm-kickoff/token-report.mjs` and exports four pure
 * functions (parse, aggregate, price, render) plus a guarded CLI `main()`.
 * All fixtures under `fixtures/token-report/` are synthetic: this is a
 * public repo, so no real transcript content is ever checked in.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

import { parse, aggregate, price, render, perAgent } from '../../skills/tm-kickoff/token-report.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dir, 'fixtures', 'token-report')
const scriptPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'token-report.mjs')

function fixture(name) {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

describe('parse: de-duplication', () => {
  test('collapses split lines sharing one message.id, first line wins on usage', () => {
    const records = parse({ lead: fixture('lead-dedupe.jsonl') })

    // Only two logical turns: msg_AAA (split across 3 lines) and msg_BBB.
    // The user line, and the <synthetic> line, are both dropped.
    assert.equal(records.length, 2)

    const aaa = records.find((r) => r.id === 'msg_AAA')
    assert.ok(aaa, 'msg_AAA present')
    assert.equal(aaa.role, 'lead')
    assert.equal(aaa.model, 'claude-opus-5-5')
    // First line wins: usage numbers are not tripled across the 3 split lines.
    assert.equal(aaa.input, 100)
    assert.equal(aaa.cacheRead, 20)
    assert.equal(aaa.cache5m, 50)
    assert.equal(aaa.cache1h, 0)
    // Timestamp comes from the first line for this id.
    assert.equal(aaa.timestamp, '2026-09-27T10:00:01.000Z')
    // Visible-output estimate sums text + JSON.stringify(tool_use.input)
    // across ALL lines sharing the id; thinking is excluded.
    assert.equal(aaa.visibleChars, 'Hello world'.length + JSON.stringify({ command: 'ls' }).length)

    const bbb = records.find((r) => r.id === 'msg_BBB')
    assert.ok(bbb, 'msg_BBB present')
    assert.equal(bbb.model, 'claude-sonnet-5')
    assert.equal(bbb.input, 40)
    assert.equal(bbb.visibleChars, 'Done.'.length)
  })

  test('skips <synthetic> model lines entirely', () => {
    const records = parse({ lead: fixture('lead-dedupe.jsonl') })
    assert.ok(!records.some((r) => r.id === 'msg_CCC'))
  })
})

describe('parse: output tokens', () => {
  test('a lead turn keeps the measured output_tokens, not a multiple of it and not the estimate', () => {
    const aaa = parse({ lead: fixture('lead-dedupe.jsonl') }).find((r) => r.id === 'msg_AAA')
    assert.equal(aaa.outputTokens, 246) // repeated on all 3 split lines, taken once
    assert.equal(aaa.outputEstimated, false)
  })

  test('a subagent turn uses visible chars divided by 4, not its output_tokens', () => {
    const records = parse({
      lead: fixture('lead-roles.jsonl'),
      subagents: [{ hex: 'aaaa1111', text: fixture('agent-aaaa1111.jsonl') }],
    })
    const dev = records.find((r) => r.id === 'msg_dev1')
    assert.equal(dev.outputTokens, Math.round(dev.visibleChars / 4))
    assert.notEqual(dev.outputTokens, 50)
    assert.equal(dev.outputEstimated, true)
  })

  test('a lead turn with no output_tokens falls back to the estimate and is marked', () => {
    const lead = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { type: 'message', id: 'msg_nout', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'abcdefgh' }], usage: { input_tokens: 1 } },
    })
    const [record] = parse({ lead })
    assert.equal(record.outputTokens, 2)
    assert.equal(record.outputEstimated, true)
  })
})

describe('parse: role mapping', () => {
  test('maps a subagent hex to its dispatcher\'s subagent_type, prefix stripped', () => {
    const lead = fixture('lead-roles.jsonl')
    const records = parse({
      lead,
      subagents: [
        { hex: 'aaaa1111', text: fixture('agent-aaaa1111.jsonl') },
        { hex: 'bbbb2222', text: fixture('agent-bbbb2222.jsonl') },
      ],
    })

    const dev = records.find((r) => r.id === 'msg_dev1')
    assert.equal(dev.role, 'developer')

    // "team:reviewer" -> "reviewer": the marketplace-style prefix is stripped.
    const rev = records.find((r) => r.id === 'msg_rev1')
    assert.equal(rev.role, 'reviewer')
  })

  test('tags a subagent with no matching dispatcher as unmapped, never dropped', () => {
    const lead = fixture('lead-roles.jsonl')
    const records = parse({
      lead,
      subagents: [{ hex: 'cccc3333', text: fixture('agent-cccc3333.jsonl') }],
    })

    const orphan = records.find((r) => r.id === 'msg_orphan1')
    assert.ok(orphan, 'unmapped subagent record is kept, not dropped')
    assert.equal(orphan.role, 'unmapped')
  })

  test('lead\'s own turns are always tagged lead', () => {
    const records = parse({ lead: fixture('lead-roles.jsonl') })
    assert.ok(records.every((r) => r.role === 'lead'))
  })
})

describe('aggregate: since/until window', () => {
  function record(id, timestamp) {
    return {
      id,
      role: 'lead',
      model: 'claude-opus-5-5',
      timestamp,
      input: 1,
      cacheRead: 0,
      cache5m: 0,
      cache1h: 0,
      visibleChars: 0,
      outputTokens: 0,
      outputEstimated: false,
    }
  }

  const records = [
    record('before', '2026-09-27T09:59:59.000Z'),
    record('at-since', '2026-09-27T10:00:00.000Z'),
    record('inside', '2026-09-27T10:00:30.000Z'),
    record('at-until', '2026-09-27T10:01:00.000Z'),
    record('after', '2026-09-27T10:01:01.000Z'),
  ]

  test('since is inclusive, until is exclusive', () => {
    const aggregated = aggregate(records, {
      since: '2026-09-27T10:00:00.000Z',
      until: '2026-09-27T10:01:00.000Z',
    })
    assert.equal(aggregated.totals.calls, 2) // at-since, inside; not at-until or after/before
  })

  test('an omitted bound leaves that side of the window open', () => {
    const sinceOnly = aggregate(records, { since: '2026-09-27T10:01:00.000Z' })
    assert.equal(sinceOnly.totals.calls, 2) // at-until, after

    const untilOnly = aggregate(records, { until: '2026-09-27T10:00:00.000Z' })
    assert.equal(untilOnly.totals.calls, 1) // before
  })

  test('compares instants, so a bound without milliseconds matches its own second', () => {
    assert.equal(aggregate(records, { since: '2026-09-27T10:00:30Z' }).totals.calls, 3)
  })
})

describe('aggregate: grouping', () => {
  function record(id, role, model, input, visibleChars) {
    return {
      id,
      role,
      model,
      timestamp: '2026-09-27T10:00:00.000Z',
      input,
      cacheRead: 0,
      cache5m: 0,
      cache1h: 0,
      visibleChars,
      outputTokens: Math.round(visibleChars / 4),
      outputEstimated: role !== 'lead',
    }
  }

  const records = [
    record('lead-1', 'lead', 'claude-opus-5-5', 100, 40),
    record('lead-2', 'lead', 'claude-sonnet-5', 50, 20),
    record('dev-1', 'developer', 'claude-sonnet-5', 200, 80),
    record('dev-2', 'developer', 'claude-sonnet-5', 300, 120),
    record('orphan-1', 'unmapped', 'claude-opus-5-5', 10, 4),
  ]

  test('sums per role add up to the grand total', () => {
    const aggregated = aggregate(records, {})
    const roleSum = Object.values(aggregated.byRole).reduce((n, b) => n + b.input, 0)
    assert.equal(roleSum, aggregated.totals.input)
    assert.equal(aggregated.byRole.lead.input, 150)
    assert.equal(aggregated.byRole.lead.calls, 2)
    assert.equal(aggregated.byRole.developer.input, 500)
    assert.equal(aggregated.byRole.unmapped.input, 10)
  })

  test('sums per model add up to the grand total', () => {
    const aggregated = aggregate(records, {})
    const modelSum = Object.values(aggregated.byModel).reduce((n, b) => n + b.input, 0)
    assert.equal(modelSum, aggregated.totals.input)
    assert.equal(aggregated.byModel['claude-sonnet-5'].input, 550)
    assert.equal(aggregated.byModel['claude-opus-5-5'].input, 110)
  })

  test('the lead role is isolated from subagent roles', () => {
    const aggregated = aggregate(records, {})
    assert.equal(aggregated.byRole.lead.calls, 2)
    assert.equal(aggregated.byRole.developer.calls, 2)
    assert.notEqual(aggregated.byRole.lead.calls, aggregated.totals.calls)
  })

  test('output estimates per role add up to the total estimate', () => {
    const a = aggregate([record('a', 'lead', 'claude-opus-5-5', 0, 2), record('b', 'developer', 'claude-sonnet-5', 0, 2)], {})
    assert.equal(Object.values(a.byRole).reduce((n, b) => n + b.outputTokens, 0), a.totals.outputTokens)
    assert.equal(a.totals.outputTokens, 2) // round(2/4) twice, not NaN
  })

  test('a bucket is estimated when any of its records is, and measured otherwise', () => {
    const a = aggregate(records, {})
    assert.equal(a.byRole.lead.outputEstimated, false)
    assert.equal(a.byRole.developer.outputEstimated, true)
    assert.equal(a.byModel['claude-opus-5-5'].outputEstimated, true) // lead-1 plus orphan-1
    assert.equal(a.totals.outputEstimated, true)
  })
})

describe('price', () => {
  function bucket(overrides) {
    return { calls: 1, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 0, outputEstimated: false, ...overrides }
  }

  test('splits cache-write cost by the ephemeral 5m/1h TTL', () => {
    const aggregated = {
      byModel: {
        'claude-opus-5-5': bucket({ cache5m: 1_000_000, cache1h: 1_000_000 }),
      },
      totals: bucket({}),
    }
    const priceTable = {
      models: {
        'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_write_1h: 6, cache_read: 0.2, output: 20 },
      },
    }
    const priced = price(aggregated, priceTable)
    const row = priced.rows.find((r) => r.model === 'claude-opus-5-5')
    // 1M tokens at $5/MTok (5m) + 1M tokens at $6/MTok (1h) = $11.
    assert.equal(row.cost, 11)
    assert.equal(priced.notes.length, 0)
  })

  test('falls back to the 5m rate when the 1h price is missing, and notes it', () => {
    const aggregated = {
      byModel: {
        'claude-opus-5-5': bucket({ cache1h: 1_000_000 }),
      },
      totals: bucket({}),
    }
    const priceTable = {
      models: {
        'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_read: 0.2, output: 20 },
      },
    }
    const priced = price(aggregated, priceTable)
    const row = priced.rows.find((r) => r.model === 'claude-opus-5-5')
    assert.equal(row.cost, 5) // 1M tokens at the 5m rate, not skipped and not free
    assert.ok(priced.notes.some((n) => n.includes('claude-opus-5-5')))
  })

  test('leaves an unknown model unpriced and out of the priced total', () => {
    const aggregated = {
      byModel: {
        'claude-unknown-9': bucket({ input: 1_000_000 }),
        'claude-opus-5-5': bucket({ input: 1_000_000 }),
      },
      totals: bucket({}),
    }
    const priceTable = {
      models: {
        'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_read: 0.2, output: 20 },
      },
    }
    const priced = price(aggregated, priceTable)
    assert.deepEqual(priced.unpriced, ['claude-unknown-9'])
    assert.equal(priced.pricedTotal, 4) // only the known model's $4/MTok input cost
    const unknownRow = priced.rows.find((r) => r.model === 'claude-unknown-9')
    assert.equal(unknownRow.cost, null)
  })

  test('counts cache writes with no 5m/1h split as 5m, and notes it', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-27T10:00:00.000Z',
      message: {
        type: 'message',
        id: 'msg_nosplit',
        model: 'claude-opus-5-5',
        content: [],
        usage: { input_tokens: 0, cache_creation_input_tokens: 1_000_000 },
      },
    })
    const priced = price(aggregate(parse({ lead: line }), {}), {
      models: { 'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_read: 0.2, output: 20 } },
    })
    assert.equal(priced.rows[0].cost, 5)
    assert.ok(priced.notes.some((n) => n.includes('no 5m/1h split')))
  })
})

describe('token-prices.json shape', () => {
  const pricesPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'token-prices.json')
  const priceTable = JSON.parse(readFileSync(pricesPath, 'utf8'))

  test('prices claude-sonnet-5-5 at the published rates, with no 1h fallback', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-01T10:00:00.000Z',
      message: {
        type: 'message',
        id: 'msg_s55',
        model: 'claude-sonnet-5-5',
        content: [],
        usage: {
          input_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 2_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
          output_tokens: 1_000_000,
        },
      },
    })
    const priced = price(aggregate(parse({ lead: line }), {}), priceTable)
    assert.deepEqual(priced.unpriced, [])
    assert.equal(priced.notes.length, 0)
    const row = priced.rows.find((r) => r.model === 'claude-sonnet-5-5')
    // $2 input + $2.50 5m write + $4 1h write + $0.20 cache read + $10 output.
    assert.ok(Math.abs(row.cost - 18.7) < 1e-9, `cost ${row.cost}`)
    assert.ok(Math.abs(priced.pricedTotal - 18.7) < 1e-9)
  })

  test('has source, retrieved and unit metadata', () => {
    assert.equal(typeof priceTable.source, 'string')
    assert.ok(priceTable.source.length > 0)
    assert.match(priceTable.retrieved, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(typeof priceTable.unit, 'string')
  })

  test('every model entry carries the required rate fields', () => {
    assert.ok(Object.keys(priceTable.models).length > 0)
    for (const [model, rates] of Object.entries(priceTable.models)) {
      for (const field of ['input', 'cache_write_5m', 'cache_read', 'output']) {
        assert.equal(typeof rates[field], 'number', `${model}.${field} is a number`)
        assert.ok(rates[field] >= 0, `${model}.${field} is non-negative`)
      }
      // cache_write_1h is optional: only present where Anthropic's public
      // pricing page states it, per the sub-plan's "leave out anything you
      // cannot verify" rule.
      if ('cache_write_1h' in rates) {
        assert.equal(typeof rates.cache_write_1h, 'number')
      }
    }
  })

  test('model keys are exact API ids seen in real transcripts, not human labels', () => {
    for (const model of Object.keys(priceTable.models)) {
      assert.ok(/^claude-[a-z0-9-]+$/.test(model), `${model} looks like an API id`)
    }
  })
})

describe('render: limitations', () => {
  function baseArgs(overrides = {}) {
    return {
      session: 'fixture-session',
      aggregated: { since: null, until: null, byRole: {}, totals: { calls: 0, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 0 } },
      priced: { rows: [], unpriced: [], notes: [], pricedTotal: 0 },
      priceTable: { source: 'fixture', retrieved: '2026-09-27' },
      ...overrides,
    }
  }

  test('always states the output estimate and list-price caveats', () => {
    const markdown = render(baseArgs())
    assert.match(markdown, /## Limitations/)
    assert.match(markdown, /subagent transcripts carry no reliable count/i)
    assert.match(markdown, /not your actual billing/i)
    assert.ok(!markdown.includes('Output token counts are not in the transcripts'))
  })

  test('says lead figures are measured and an estimate undercounts', () => {
    const markdown = render(baseArgs())
    assert.match(markdown, /lead figures are measured from the lead transcript's `usage\.output_tokens`/)
    assert.match(markdown, /by-model or total figure that includes any estimate is marked too/)
    assert.match(markdown, /estimate leaves out thinking/)
  })

  test('names unpriced models by id, not silently', () => {
    const markdown = render(baseArgs({ priced: { rows: [], unpriced: ['claude-mystery-1'], notes: [], pricedTotal: 0 } }))
    assert.match(markdown, /claude-mystery-1/)
  })

  test('surfaces a TTL fallback note when one was recorded', () => {
    const markdown = render(
      baseArgs({ priced: { rows: [], unpriced: [], notes: ['claude-opus-5-5: no verified 1h cache-write price, used the 5m rate'], pricedTotal: 0 } })
    )
    assert.match(markdown, /no verified 1h cache-write price/)
  })
})

describe('CLI', () => {
  const cliConfigDir = join(fixturesDir, 'cli-config')
  const leadPath = join(cliConfigDir, 'projects', 'test-project', 'fixture-session.jsonl')

  test('the path form and the --session form produce identical output', () => {
    const byPath = spawnSync(process.execPath, [scriptPath, leadPath])
    const bySession = spawnSync(process.execPath, [
      scriptPath,
      '--session', 'fixture-session',
      '--config-dir', cliConfigDir,
    ])

    assert.equal(byPath.status, 0)
    assert.equal(bySession.status, 0)
    assert.equal(byPath.stdout.toString(), bySession.stdout.toString())
    assert.match(byPath.stdout.toString(), /# Token report/)
    assert.match(byPath.stdout.toString(), /\| unmapped \| 1 \|/)
  })

  test('an unknown session exits non-zero', () => {
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--session', 'no-such-session-1234',
      '--config-dir', cliConfigDir,
    ])
    assert.notEqual(result.status, 0)
  })
})

describe('output snapshot', () => {
  test('renders a full report for a simple two-call transcript', () => {
    const records = parse({ lead: fixture('lead-dedupe.jsonl') })
    const aggregated = aggregate(records, {})
    const priceTable = {
      source: 'fixture price list',
      retrieved: '2026-09-27',
      unit: 'USD per 1,000,000 tokens',
      models: {
        'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_read: 0.2, output: 20 },
        'claude-sonnet-5': { input: 2, cache_write_5m: 2.5, cache_read: 0.2, output: 10 },
      },
    }
    const priced = price(aggregated, priceTable)
    const markdown = render({ session: 'fixture-session', aggregated, priced, priceTable })

    assert.equal(
      markdown,
      readFileSync(join(fixturesDir, 'lead-dedupe.snapshot.md'), 'utf8')
    )
  })
})

// ---------------------------------------------------------------------------
// Issue #416: workflow subagents and the per-agent wall-clock table.
// ---------------------------------------------------------------------------

const wfConfigDir = join(fixturesDir, 'cli-config')
const wfProjectDir = join(wfConfigDir, 'projects', 'test-project')
const wfSessionDir = join(wfProjectDir, 'workflow-session')
const WINDOW = { since: '2026-10-01T10:00:00Z' }
const WF_HEXES = ['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005', 'a0a00001', 'b0b00002']

// Loads the synthetic workflow session the way main() does, so the pure
// functions see realistic input without going through the CLI.
function loadWorkflowSession() {
  const lead = readFileSync(join(wfProjectDir, 'workflow-session.jsonl'), 'utf8')
  const subDir = join(wfSessionDir, 'subagents')
  const subagents = readdirSync(subDir)
    .filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'))
    .map((n) => ({ hex: n.slice(6, -6), text: readFileSync(join(subDir, n), 'utf8') }))
  const runDir = join(subDir, 'workflows', 'wf_fixture-001')
  for (const n of readdirSync(runDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))) {
    const hex = n.slice(6, -6)
    const meta = JSON.parse(readFileSync(join(runDir, `agent-${hex}.meta.json`), 'utf8'))
    subagents.push({ hex, text: readFileSync(join(runDir, n), 'utf8'), workflowRunId: 'wf_fixture-001', label: meta.description })
  }
  return { lead, subagents }
}

function rowFor(rows, role, label) {
  const row = rows.find((r) => r.role === role && (label === undefined || r.label === label))
  assert.ok(row, `row for ${role}${label ? ` (${label})` : ''}`)
  return row
}

describe('parse: workflow subagents', () => {
  test('tags a workflow subagent with the launching workflow name, and carries its label', () => {
    const records = parse(loadWorkflowSession())
    const bugs = records.filter((r) => r.agent === 'a0a00001')
    assert.equal(bugs.length, 2)
    assert.ok(bugs.every((r) => r.role === 'workflow:tm-review-changes'))
    assert.ok(bugs.every((r) => r.label === 'review:bugs'))
    // The model comes from each call, never from the sidecar alias.
    assert.ok(bugs.every((r) => r.model === 'claude-sonnet-5'))
    assert.equal(records.find((r) => r.agent === 'b0b00002').model, 'claude-opus-5-5')
  })

  test('falls back to the run id when no Workflow launch matches', () => {
    const text = loadWorkflowSession().subagents.find((s) => s.hex === 'a0a00001').text
    const records = parse({
      lead: fixture('lead-dedupe.jsonl'),
      subagents: [{ hex: 'a0a00001', text, workflowRunId: 'wf_unknown-9' }],
    })
    const sub = records.filter((r) => r.agent === 'a0a00001')
    assert.equal(sub.length, 2)
    assert.ok(sub.every((r) => r.role === 'workflow:wf_unknown-9'))
  })

  test('workflow cost lands in the by-role totals', () => {
    const aggregated = aggregate(parse(loadWorkflowSession()), WINDOW)
    assert.equal(aggregated.byRole['workflow:tm-review-changes'].calls, 3)
    assert.equal(aggregated.byRole['workflow:tm-review-changes'].input, 400 + 410 + 500)
  })
})

describe('parse: tool uses', () => {
  test('sums tool_use blocks across the split lines of one message id', () => {
    const line = (block) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: { type: 'message', id: 'msg_split', model: 'claude-opus-5-5', content: [block], usage: { input_tokens: 1 } },
      })
    const lead = [
      line({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }),
      line({ type: 'text', text: 'hi' }),
      line({ type: 'tool_use', id: 't2', name: 'Read', input: { file: 'a' } }),
    ].join('\n')
    const [record, ...rest] = parse({ lead })
    assert.equal(rest.length, 0)
    assert.equal(record.toolUses, 2)
  })

  test('is zero for a turn with no tool calls', () => {
    assert.equal(parse({ lead: fixture('lead-dedupe.jsonl') }).find((r) => r.id === 'msg_BBB').toolUses, 0)
  })
})

describe('perAgent: one row per transcript', () => {
  const rows = perAgent(loadWorkflowSession(), WINDOW)

  test('lists the lead, five dispatched seats and two workflow subagents', () => {
    assert.equal(rows.length, 8)
    assert.equal(rows[0].role, 'lead')
    assert.equal(rows.filter((r) => r.role === 'workflow:tm-review-changes').length, 2)
  })

  test('never exposes an agent hex id', () => {
    const json = JSON.stringify(rows)
    for (const hex of WF_HEXES) assert.ok(!json.includes(hex), hex)
  })

  test('a dispatched seat uses its measured duration_ms, merged across duplicate carriers', () => {
    const dev = rowFor(rows, 'developer')
    assert.equal(dev.wallClockMs, 120000) // one enqueue and one attachment copy: not 240000
    assert.equal(dev.source, 'notification')
    assert.equal(dev.calls, 3)
  })

  test('ignores a notification quoted inside a tool result', () => {
    // The lead's Bash result quotes duration_ms 999000 for the developer.
    assert.notEqual(rowFor(rows, 'developer').wallClockMs, 999000)
  })

  test('counts tool uses from the transcript, not the notification field', () => {
    assert.equal(rowFor(rows, 'developer').toolUses, 2) // the notification says 99
  })

  test('a resumed seat sums its run segments, marked estimated', () => {
    const tester = rowFor(rows, 'tester')
    assert.equal(tester.wallClockMs, 90000) // 60 s + 30 s, not the 1 h idle gap, not 30 s
    assert.equal(tester.source, 'span')
    assert.equal(tester.calls, 4)
    assert.equal(tester.toolUses, 2)
  })

  test('an agent with no output still gets a row with its measured time', () => {
    const reviewer = rowFor(rows, 'reviewer')
    assert.equal(reviewer.calls, 1)
    assert.equal(reviewer.outputTokens, 0)
    assert.equal(reviewer.wallClockMs, 45000)
    assert.equal(reviewer.source, 'notification')
  })

  test('a zero duration with no usable span is n/a, not a made-up value', () => {
    const architect = rowFor(rows, 'architect')
    assert.equal(architect.calls, 0)
    assert.equal(architect.wallClockMs, null)
    assert.equal(architect.source, 'none')
  })

  test('an unmapped agent with one timestamp and no notification is n/a', () => {
    const orphan = rowFor(rows, 'unmapped')
    assert.equal(orphan.calls, 1)
    assert.equal(orphan.wallClockMs, null)
    assert.equal(orphan.source, 'none')
  })

  test('a workflow subagent uses its transcript span, marked estimated', () => {
    const bugs = rowFor(rows, 'workflow:tm-review-changes', 'review:bugs')
    assert.equal(bugs.wallClockMs, 90000)
    assert.equal(bugs.source, 'span')
    assert.equal(bugs.calls, 2)
    assert.equal(bugs.toolUses, 2)
    assert.deepEqual(bugs.models, ['claude-sonnet-5'])
    const consolidate = rowFor(rows, 'workflow:tm-review-changes', 'consolidate')
    assert.equal(consolidate.wallClockMs, 30000)
    assert.deepEqual(consolidate.models, ['claude-opus-5-5'])
  })

  test('the lead span is first to last line in the window, marked estimated', () => {
    const lead = rows[0]
    assert.equal(lead.wallClockMs, 90 * 60 * 1000) // the 09:59 line is before the window
    assert.equal(lead.source, 'lead-span')
    assert.equal(lead.calls, 7)
    assert.equal(lead.toolUses, 6)
  })

  test('orders the lead first, then by start time', () => {
    const starts = rows.slice(1).map((r) => r.start)
    assert.deepEqual(starts, [...starts].sort())
  })

  test('estimates a subagent row from visible chars and marks it', () => {
    const dev = rowFor(rows, 'developer')
    assert.equal(dev.outputTokens, 13)
    assert.equal(dev.outputEstimated, true)
  })

  test('the lead row sums the measured output_tokens and is not marked', () => {
    assert.equal(rows[0].outputTokens, 35) // 7 turns in the window at 5 each, not the 82 estimate
    assert.equal(rows[0].outputEstimated, false)
  })

  test('a notification outside the window is not used', () => {
    // Until 10:01:55 excludes the developer notification at 10:02:00.
    const early = perAgent(loadWorkflowSession(), { since: '2026-10-01T10:00:00Z', until: '2026-10-01T10:01:55Z' })
    const dev = rowFor(early, 'developer')
    assert.equal(dev.source, 'span')
    assert.equal(dev.wallClockMs, 100000) // lines at 10:00:10, 10:00:40 and 10:01:50
  })

  test('drops a transcript with no line in the window, and measures a window that holds only a completed notification', () => {
    const late = perAgent(loadWorkflowSession(), { since: '2026-10-01T11:00:00Z' })
    assert.ok(!late.some((r) => r.role === 'developer'))
    const tester = rowFor(late, 'tester')
    assert.equal(tester.source, 'notification')
    assert.equal(tester.wallClockMs, 30000)
  })
})

describe('render: output markers in the role and model tables', () => {
  const bucket = (overrides) => ({ calls: 2, input: 10, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 1234, outputEstimated: false, ...overrides })
  const aggregated = {
    since: null,
    until: null,
    byRole: { lead: bucket({}), developer: bucket({ outputTokens: 20, outputEstimated: true }) },
    byModel: {},
    totals: bucket({ outputTokens: 1254, outputEstimated: true }),
  }
  const priced = {
    rows: [
      { model: 'claude-opus-5-5', ...bucket({}), cost: 1 },
      { model: 'claude-sonnet-5', ...bucket({ outputTokens: 20, outputEstimated: true }), cost: 1 },
    ],
    unpriced: [],
    notes: [],
    pricedTotal: 2,
  }
  const markdown = render({ session: 's', aggregated, priced, priceTable: { source: 'fixture', retrieved: '2026-10-01' } })

  test('the header says where the figure is estimated', () => {
    assert.equal(markdown.match(/Output \(est\. where marked\)/g).length, 2)
    assert.ok(!markdown.includes('Output (est.) |'))
  })

  test('a measured role cell is bare and an estimated one is marked', () => {
    assert.match(markdown, /\| lead \| 2 \| 10 \| 0 \| 0 \| 0 \| 1,234 \|/)
    assert.match(markdown, /\| developer \| 2 \| 10 \| 0 \| 0 \| 0 \| 20 \(est\.\) \|/)
  })

  test('model rows and the Total row are marked when any part is estimated', () => {
    assert.match(markdown, /\| claude-opus-5-5 \| 2 \| 10 \| 0 \| 0 \| 0 \| 1,234 \| \$1\.00 \|/)
    assert.match(markdown, /\| claude-sonnet-5 \| 2 \| 10 \| 0 \| 0 \| 0 \| 20 \(est\.\) \| \$1\.00 \|/)
    assert.match(markdown, /\| \*\*Total\*\* \| 2 \| 10 \| 0 \| 0 \| 0 \| 1,254 \(est\.\) \|/)
  })
})

describe('render: by agent table', () => {
  function baseArgs(overrides = {}) {
    return {
      session: 'fixture-session',
      aggregated: { since: null, until: null, byRole: {}, totals: { calls: 0, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 0 } },
      priced: { rows: [], unpriced: [], notes: [], pricedTotal: 0 },
      priceTable: { source: 'fixture', retrieved: '2026-10-01' },
      ...overrides,
    }
  }
  const agent = (overrides) => ({
    start: '2026-10-01T10:00:00.000Z',
    role: 'developer',
    label: null,
    models: ['claude-sonnet-5'],
    calls: 3,
    toolUses: 2,
    outputTokens: 13,
    wallClockMs: 120000,
    source: 'notification',
    ...overrides,
  })

  test('prints no By agent section and no unread line when there is nothing to show', () => {
    const markdown = render(baseArgs())
    assert.ok(!markdown.includes('## By agent'))
    assert.ok(!markdown.includes('Found but not read'))
  })

  test('renders the columns and a measured value without a marker', () => {
    const markdown = render(baseArgs({ agents: [agent({})] }))
    assert.match(markdown, /## By agent/)
    assert.match(markdown, /\| Start \(UTC\) \| Role \| Model \| Calls \| Tool uses \| Output \(est\. where marked\) \| Wall-clock \| Source \|/)
    assert.match(markdown, /\| 2026-10-01 10:00:00 \| developer \| claude-sonnet-5 \| 3 \| 2 \| 13 \| 2m 0s \| task notification duration_ms \|/)
  })

  test('marks an estimated output cell and leaves a measured one bare', () => {
    const markdown = render(baseArgs({ agents: [agent({ outputEstimated: true }), agent({ role: 'lead', outputTokens: 35, outputEstimated: false })] }))
    assert.match(markdown, /\| developer \| claude-sonnet-5 \| 3 \| 2 \| 13 \(est\.\) \|/)
    assert.match(markdown, /\| lead \| claude-sonnet-5 \| 3 \| 2 \| 35 \|/)
  })

  test('marks an estimated value and names its source', () => {
    const markdown = render(baseArgs({ agents: [agent({ wallClockMs: 90000, source: 'span' }), agent({ role: 'lead', wallClockMs: 5400000, source: 'lead-span' })] }))
    assert.match(markdown, /1m 30s \(est\.\) \| transcript span/)
    assert.match(markdown, /1h 30m 0s \(est\.\) \| lead first-to-last span/)
  })

  test('shows n/a and never a number when there is no value', () => {
    const markdown = render(baseArgs({ agents: [agent({ calls: 0, models: [], wallClockMs: null, source: 'none' })] }))
    assert.match(markdown, /\| 0 \| 2 \| 13 \| n\/a \| n\/a \|/) // outputEstimated unset: no marker
    assert.ok(!/NaN|Infinity/.test(markdown))
  })

  test('shows a workflow label in the role cell and escapes a pipe in it', () => {
    const markdown = render(baseArgs({ agents: [agent({ role: 'workflow:tm-review-changes', label: 'review|bugs' })] }))
    assert.ok(markdown.includes('workflow:tm-review-changes (review\\|bugs)'))
  })

  test('joins several models with a comma', () => {
    const markdown = render(baseArgs({ agents: [agent({ models: ['claude-opus-5-5', 'claude-sonnet-5'] })] }))
    assert.match(markdown, /claude-opus-5-5, claude-sonnet-5/)
  })

  test('limitations explain est. and n/a when the table is present', () => {
    const markdown = render(baseArgs({ agents: [agent({})] }))
    assert.match(markdown, /"est\."/)
    assert.match(markdown, /"n\/a"/)
    assert.match(markdown, /idle and waiting time/)
  })

  test('names every path that was found but not read', () => {
    const markdown = render(baseArgs({ unread: ['subagents/unknown-layout', 'subagents/workflows/wf_x'] }))
    assert.match(markdown, /Found but not read.*subagents\/unknown-layout, subagents\/workflows\/wf_x/)
  })

  test('puts no agent id in the unread line, even for an unknown entry named after one', () => {
    const markdown = render(baseArgs({ unread: ['subagents/agent-deadbeef01', 'subagents/workflows/wf_x/agent-0a0b0c0d'] }))
    assert.match(markdown, /Found but not read/)
    assert.ok(!/deadbeef01|0a0b0c0d/.test(markdown))
  })

  test('keeps a pipe or newline in a label from splitting its table row', () => {
    const markdown = render(baseArgs({ agents: [agent({ role: 'workflow:x', label: 'a\nb|c\r\nd' })] }))
    assert.ok(markdown.includes('workflow:x (a b\\|c d)'))
    const rows = markdown.split('\n').filter((line) => line.includes('workflow:x'))
    assert.equal(rows.length, 1)
  })
})

describe('CLI: workflow session', () => {
  const leadPath = join(wfProjectDir, 'workflow-session.jsonl')
  const since = '2026-10-01T10:00:00Z'
  const sessionArgs = ['--session', 'workflow-session', '--config-dir', wfConfigDir, '--since', since]
  const run = (args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })

  test('the path form and the --session form produce identical output', () => {
    const byPath = run([leadPath, '--since', since])
    const bySession = run(sessionArgs)
    assert.equal(byPath.status, 0)
    assert.equal(bySession.status, 0)
    assert.equal(byPath.stdout, bySession.stdout)
  })

  test('includes the workflow role and the by agent table, and leaves out the unreadable layout', () => {
    const out = run(sessionArgs).stdout
    assert.match(out, /\| workflow:tm-review-changes \| 3 \|/)
    assert.match(out, /## By agent/)
    assert.match(out, /Found but not read.*subagents\/unknown-layout/)
    assert.ok(!out.includes('999,999'), 'the unreadable transcript is in no total')
    assert.ok(!out.includes('777,777'), 'the journal is in no total')
    for (const hex of WF_HEXES) assert.ok(!out.includes(hex), `no agent hex ${hex} in the report`)
  })

  test('matches the saved snapshot', () => {
    assert.equal(run(sessionArgs).stdout, readFileSync(join(fixturesDir, 'workflow-session.snapshot.md'), 'utf8'))
  })

  test('survives an unreadable run directory and a malformed sidecar, and reports the directory', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('chmod cannot block root')
    const dir = mkdtempSync(join(tmpdir(), 'token-report-'))
    const project = join(dir, 'projects', 'p')
    const okRun = join(project, 'sess', 'subagents', 'workflows', 'wf_ok')
    const blocked = join(project, 'sess', 'subagents', 'workflows', 'wf_blocked')
    mkdirSync(okRun, { recursive: true })
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(project, 'sess.jsonl'), fixture('lead-dedupe.jsonl'))
    writeFileSync(join(okRun, 'agent-abc123.jsonl'), fixture('agent-aaaa1111.jsonl'))
    writeFileSync(join(okRun, 'agent-abc123.meta.json'), '{not json')
    chmodSync(blocked, 0o000)
    try {
      const result = run(['--session', 'sess', '--config-dir', dir])
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Found but not read.*subagents\/workflows\/wf_blocked/)
      assert.match(result.stdout, /workflow:wf_ok/)
    } finally {
      chmodSync(blocked, 0o755)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI: unreadable transcripts and odd sidecars', () => {
  const run = (args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
  const copyConfig = () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-report-'))
    cpSync(wfConfigDir, dir, { recursive: true })
    return dir
  }
  const sessionDir = (dir) => join(dir, 'projects', 'test-project', 'workflow-session', 'subagents')

  test('an unreadable transcript names its directory and count, never its agent id', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('chmod cannot block root')
    const dir = copyConfig()
    const subagents = sessionDir(dir)
    const wfRun = join(subagents, 'workflows', 'wf_fixture-001')
    const blocked = [join(subagents, 'agent-aaaa0001.jsonl'), join(wfRun, 'agent-a0a00001.jsonl'), join(wfRun, 'agent-b0b00002.jsonl')]
    for (const path of blocked) chmodSync(path, 0o000)
    try {
      const result = run(['--session', 'workflow-session', '--config-dir', dir])
      assert.equal(result.status, 0, result.stderr)
      const line = result.stdout.split('\n').find((l) => l.includes('Found but not read'))
      assert.ok(line, 'the unread line is printed')
      assert.match(line, /subagents \(1 transcript\)/)
      assert.match(line, /subagents\/workflows\/wf_fixture-001 \(2 transcripts\)/)
      for (const hex of [...WF_HEXES, 'aaaa0001']) assert.ok(!result.stdout.includes(hex), `no agent hex ${hex} in the report`)
    } finally {
      for (const path of blocked) chmodSync(path, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a sidecar description with a newline and a pipe stays in one table row', () => {
    const dir = copyConfig()
    try {
      const meta = join(sessionDir(dir), 'workflows', 'wf_fixture-001', 'agent-a0a00001.meta.json')
      writeFileSync(meta, JSON.stringify({ description: 'a\nb|c' }))
      const result = run(['--session', 'workflow-session', '--config-dir', dir])
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.includes('(a b\\|c)'))
      assert.ok(!/^b\\\|c\)/m.test(result.stdout), 'no row starts mid-description')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
