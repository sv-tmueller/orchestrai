/**
 * token-usage.mjs prints a per-seat token table for one session, from the
 * transcripts under a project dir. Fixtures live in fixtures/token-usage/proj:
 * a lead file with a duplicated message id and one line before the --since
 * time, a subagent with a meta file, and a workflow subagent one level down.
 * Dollar figures use fixtures/token-usage/priced: round per-million rates in
 * prices.json, and a session built to hit each pricing rule.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const script = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'token-usage.mjs')
const projectDir = join(__dir, 'fixtures', 'token-usage', 'proj')

const priced = join(__dir, 'fixtures', 'token-usage', 'priced')
const prices = join(priced, 'prices.json')

const run = (...args) =>
  spawnSync(process.execPath, [script, '--project-dir', projectDir, '--prices', prices, ...args], { encoding: 'utf8' })

const runPriced = (...args) =>
  spawnSync(process.execPath, [script, '--project-dir', priced, '--prices', prices, '--session', 'sess2', ...args], { encoding: 'utf8' })

const rows = (stdout) =>
  stdout
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))

describe('token-usage.mjs', () => {
  test('prints one row per seat, workflow agents included, and a total row', () => {
    const r = run('--session', 'sess1', '--since', '2026-11-25T10:00:00.000Z')
    assert.equal(r.status, 0, r.stderr)
    const t = rows(r.stdout)
    assert.deepEqual(t[0], ['Seat', 'Model', 'Input', 'Cache write', 'Cache read', 'Output', '$'])
    const body = t.slice(2)
    assert.deepEqual(body, [
      ['lead', 'claude-opus-5-5', '30', '300', '3,000', '120', '$0.00'],
      ['developer: Implement 7', 'claude-sonnet-5-5', '5', '6', '7', '8', '$0.00'],
      ['workflow-critic: Critic stage', 'claude-sonnet-5-5', '100', '0', '0', '9', '$0.00'],
      ['Total', '', '135', '306', '3,007', '137', '$0.01'],
    ])
  })

  test('counts a message id once and keeps lines before --since out', () => {
    const all = rows(run('--session', 'sess1').stdout)
    // msg_old is counted without --since; the duplicated msg_a only once.
    assert.deepEqual(all[2], ['lead', 'claude-opus-5-5', '31', '301', '3,001', '121', '$0.00'])
  })

  test('reports a missing transcript on stderr with a non-zero exit', () => {
    const r = run('--session', 'nope')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /no transcript/i)
    assert.equal(r.stdout, '')
  })

  test('requires --session', () => {
    const r = run()
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /--session/)
  })

  test('rejects a --since that is not a time', () => {
    const r = run('--session', 'sess1', '--since', 'yesterday-ish')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /--since/)
  })

  test('prices a 5m/1h cache write split, a missing split at the 5m rate, and a fast message at fast rates', () => {
    const r = runPriced()
    assert.equal(r.status, 0, r.stderr)
    const lead = rows(r.stdout)[2]
    // m1 standard: 4 + 5 (5m) + 8 (1h) + 0.2 + 20 = 37.20
    // m2 no split, 1M writes at the 5m rate: 5.00
    // m3 fast: 8 + 40 + 10 (5m write at 2x) + 0.4 (read at 2x) = 58.40
    assert.deepEqual(lead.slice(0, 2), ['lead', 'claude-opus-5-5'])
    assert.equal(lead[6], '$100.60')
  })

  test('shows unpriced for a model with no rate row, never a guessed rate', () => {
    const body = rows(runPriced().stdout).slice(2)
    assert.equal(body[1][0], 'developer: Unknown model')
    assert.equal(body[1][6], 'unpriced')
  })

  test('prices per message, so a seat that mixes a priced and an unknown model keeps its priced part', () => {
    const body = rows(runPriced().stdout).slice(2)
    assert.equal(body[3][0], 'developer: Mixed models')
    assert.equal(body[3][6], '$20.00 (+ unpriced)')
  })

  test('rounds each figure to 2 decimals and marks the total when a seat is unpriced', () => {
    const body = rows(runPriced().stdout).slice(2)
    // 1000 in at 2 + 333 out at 10 is 0.00533 dollars
    assert.equal(body[2][6], '$0.01')
    // 100.60 + 0.00533 + 20.00 = 120.60533
    assert.deepEqual(body[4].slice(0, 1).concat(body[4][6]), ['Total', '$120.61 (+ unpriced)'])
  })

  test('prints the source line under the table with the retrieval date', () => {
    const lines = runPriced().stdout.trim().split('\n')
    assert.equal(
      lines.at(-1),
      '$ = API list price from token-prices.json (retrieved 2026-01-02), not a subscription charge.',
    )
  })

  test('the shipped token-prices.json names its source and date and covers the four models', () => {
    const p = JSON.parse(readFileSync(join(__dir, '..', '..', 'skills', 'tm-kickoff', 'token-prices.json'), 'utf8'))
    assert.match(p.source, /^https:\/\/platform\.claude\.com\//)
    assert.match(p.retrieved, /^\d{4}-\d{2}-\d{2}$/)
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']) {
      const m = p.models[id]
      assert.ok(m, id)
      for (const k of ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output']) {
        assert.equal(typeof m[k], 'number', `${id}.${k}`)
      }
    }
    assert.equal(p.models['claude-sonnet-5-5'].cache_read, 0.1)
    assert.deepEqual(p.models['claude-opus-5-5'].fast, { input: 8, output: 40 })
  })
})
