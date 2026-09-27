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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

import { parse, aggregate, price, render } from '../../skills/tm-kickoff/token-report.mjs'

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

  test('compares instants, so a bound without milliseconds matches its own second', () => { assert.equal(aggregate(records, { since: '2026-09-27T10:00:30Z' }).totals.calls, 3) })
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

  test('output estimates per role add up to the total estimate', () => { const a = aggregate([record('a', 'lead', 'claude-opus-5-5', 0, 2), record('b', 'developer', 'claude-sonnet-5', 0, 2)], {}); assert.equal(Object.values(a.byRole).reduce((n, b) => n + b.outputTokens, 0), a.totals.outputTokens) })
})

describe('price', () => {
  function bucket(overrides) {
    return { calls: 1, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, visibleChars: 0, outputTokens: 0, ...overrides }
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
})

describe('token-prices.json shape', () => {
  const pricesPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'token-prices.json')
  const priceTable = JSON.parse(readFileSync(pricesPath, 'utf8'))

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
    assert.match(markdown, /output.*(is not in the transcripts|estimated)/i)
    assert.match(markdown, /not your actual billing/i)
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
