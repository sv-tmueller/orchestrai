/**
 * token-usage.mjs prints a per-seat token table for one session, from the
 * transcripts under a project dir. Fixtures live in fixtures/token-usage/proj:
 * a lead file with a duplicated message id and one line before the --since
 * time, a subagent with a meta file, and a workflow subagent one level down.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const script = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'token-usage.mjs')
const projectDir = join(__dir, 'fixtures', 'token-usage', 'proj')

const run = (...args) =>
  spawnSync(process.execPath, [script, '--project-dir', projectDir, ...args], { encoding: 'utf8' })

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
    assert.deepEqual(t[0], ['Seat', 'Model', 'Input', 'Cache write', 'Cache read', 'Output'])
    const body = t.slice(2)
    assert.deepEqual(body, [
      ['lead', 'claude-opus-5-5', '30', '300', '3,000', '120'],
      ['developer: Implement 7', 'claude-sonnet-5-5', '5', '6', '7', '8'],
      ['workflow-critic: Critic stage', 'claude-sonnet-5-5', '100', '0', '0', '9'],
      ['Total', '', '135', '306', '3,007', '137'],
    ])
  })

  test('counts a message id once and keeps lines before --since out', () => {
    const all = rows(run('--session', 'sess1').stdout)
    // msg_old is counted without --since; the duplicated msg_a only once.
    assert.deepEqual(all[2], ['lead', 'claude-opus-5-5', '31', '301', '3,001', '121'])
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
})
