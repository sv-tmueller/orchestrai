/**
 * Tests for the columns.json validator (issue #451, design WP3).
 *
 * `.orchestrai/columns.json` in a target repo decides, per stage, whether the
 * lead dispatches a seat itself or hands the stage to a runner's poller.
 * `columns.mjs` ships with the plugin at
 * `.claude/skills/tm-kickoff/columns.mjs`; it turns that file into a
 * normalized per-stage JSON summary, and the lead stops the package on a
 * nonzero exit. Fixtures are written to a temp dir, never checked in.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

import { normalize } from '../../skills/tm-kickoff/columns.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'columns.mjs')

const tmpRoot = mkdtempSync(join(tmpdir(), 'tm-columns-'))
after(() => rmSync(tmpRoot, { recursive: true, force: true }))

let seq = 0
function configFile(value) {
  const path = join(tmpRoot, `columns-${seq++}.json`)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

function run(...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
}

// One valid file exercising every branch the design names: a vps anthropic
// column, a second runner, a vps column on a non-anthropic provider, and a
// vllm provider with a base_url.
const VALID = {
  runners: ['vps', 'mac'],
  providers: {
    claude: { kind: 'anthropic' },
    gpt: { kind: 'openai' },
    noris: { kind: 'vllm', base_url: 'http://noris:8000/v1' },
  },
  columns: {
    architect: { runner: 'vps', provider: 'claude', model: 'opus', effort: 'xhigh' },
    developer: { runner: 'vps', provider: 'claude', model: 'sonnet', effort: 'high' },
    tester: {
      runner: 'mac',
      provider: 'noris',
      model: 'qwen3-coder-30b',
      effort: 'high',
      on_runner_away: 'wait',
    },
    reviewer: { runner: 'vps', provider: 'gpt', model: 'gpt-5.6', effort: 'high' },
  },
}

function clone(mutate) {
  const copy = structuredClone(VALID)
  mutate(copy)
  return copy
}

function expectThrow(value, pattern) {
  try {
    normalize(value)
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${error}`)
    assert.match(error.message, pattern)
    return
  }
  assert.fail('expected normalize to throw')
}

describe('normalize: summary', () => {
  test('is keyed by stage and executes a vps anthropic column on the lead', () => {
    const summary = normalize(VALID)

    assert.deepEqual(
      summary.architect,
      {
        runner: 'vps',
        provider: 'claude',
        kind: 'anthropic',
        model: 'opus',
        effort: 'xhigh',
        execute: 'lead',
      }
    )
  })

  test('carries each column’s own model and effort', () => {
    const summary = normalize(VALID)

    assert.equal(summary.developer.model, 'sonnet')
    assert.equal(summary.developer.effort, 'high')
    assert.equal(summary.architect.model, 'opus')
    assert.equal(summary.architect.effort, 'xhigh')
  })

  test('hands a column on another runner to that runner', () => {
    const summary = normalize(VALID)

    assert.deepEqual(
      summary.tester,
      {
        runner: 'mac',
        provider: 'noris',
        kind: 'vllm',
        model: 'qwen3-coder-30b',
        effort: 'high',
        execute: 'runner:mac',
      }
    )
  })

  test('hands a vps column with a non-anthropic provider to the vps runner', () => {
    const summary = normalize(VALID)

    assert.deepEqual(
      summary.reviewer,
      {
        runner: 'vps',
        provider: 'gpt',
        kind: 'openai',
        model: 'gpt-5.6',
        effort: 'high',
        execute: 'runner:vps',
      }
    )
  })

  test('accepts an omitted on_runner_away, which means waiting', () => {
    const summary = normalize(clone((c) => delete c.columns.tester.on_runner_away))

    assert.equal(summary.tester.runner, 'mac')
    assert.equal('on_runner_away' in summary.tester, false)
  })

  test('accepts a lead column with no model, which falls back to the adapter table', () => {
    const summary = normalize(clone((c) => delete c.columns.architect.model))

    assert.equal(summary.architect.execute, 'lead')
    assert.equal(summary.architect.model, undefined)
  })
})

describe('normalize: invalid files', () => {
  test('rejects a non-object root', () => {
    expectThrow([], /expected a JSON object/)
  })

  test('rejects an unknown runner', () => {
    expectThrow(
      clone((c) => {
        c.columns.tester.runner = 'nas'
      }),
      /unknown runner "nas"/
    )
  })

  test('rejects an unknown provider', () => {
    expectThrow(
      clone((c) => {
        c.columns.tester.provider = 'mystery'
      }),
      /unknown provider "mystery"/
    )
  })

  test('rejects an unknown provider kind', () => {
    expectThrow(
      clone((c) => {
        c.providers.claude.kind = 'gemini'
      }),
      /unknown provider kind "gemini" for provider "claude"/
    )
  })

  test('rejects an effort outside low|medium|high|xhigh', () => {
    expectThrow(
      clone((c) => {
        c.columns.developer.effort = 'max'
      }),
      /effort "max" is not one of low, medium, high, xhigh/
    )
  })

  test('rejects a vllm provider with no base_url', () => {
    expectThrow(
      clone((c) => {
        delete c.providers.noris.base_url
      }),
      /provider "noris" \(kind vllm\) needs a base_url/
    )
  })

  test('rejects an on_runner_away other than wait', () => {
    expectThrow(
      clone((c) => {
        c.columns.tester.on_runner_away = 'run'
      }),
      /on_runner_away "run" is not "wait"/
    )
  })

  test('rejects a remote column with no model', () => {
    expectThrow(
      clone((c) => {
        delete c.columns.tester.model
      }),
      /column "tester" \(execute runner:mac\) needs a model/
    )
  })

  test('rejects a remote column with an empty model', () => {
    expectThrow(
      clone((c) => {
        c.columns.tester.model = ''
      }),
      /column "tester" \(execute runner:mac\) needs a model/
    )
  })

  test('rejects a vps column on a non-anthropic provider with no model', () => {
    expectThrow(
      clone((c) => {
        delete c.columns.reviewer.model
      }),
      /column "reviewer" \(execute runner:vps\) needs a model/
    )
  })
})

describe('CLI', () => {
  test('a valid file exits 0 with one JSON object of per-stage summaries', () => {
    const result = run('--file', configFile(VALID))

    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(summary).sort(), [
      'architect',
      'developer',
      'reviewer',
      'tester',
    ])
    assert.equal(summary.architect.execute, 'lead')
    assert.equal(summary.tester.execute, 'runner:mac')
    assert.equal(result.stderr, '')
  })

  test('a missing file exits 0 with an absent marker', () => {
    const result = run('--file', join(tmpRoot, 'not-there.json'))

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).absent, true)
    assert.equal(result.stderr, '')
  })

  test('an unreadable path exits 1 with a one-line report, not a stack trace', () => {
    const result = run('--file', tmpRoot)

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    const lines = result.stderr.replace(/\n$/, '').split('\n')
    assert.equal(lines.length, 1, `expected one line, got: ${result.stderr}`)
    assert.match(lines[0], /^invalid columns config: cannot read .+ \(EISDIR\)$/)
  })

  test('invalid JSON exits nonzero with a one-line report', () => {
    const result = run('--file', configFile('{ not json'))

    assert.notEqual(result.status, 0)
    const lines = result.stderr.replace(/\n$/, '').split('\n')
    assert.equal(lines.length, 1, `expected one line, got: ${result.stderr}`)
    assert.match(lines[0], /^invalid columns config: invalid JSON/)
  })

  test('an invalid column exits nonzero with a one-line report naming it', () => {
    const result = run(
      '--file',
      configFile(clone((c) => {
        c.columns.developer.effort = 'max'
      }))
    )

    assert.notEqual(result.status, 0)
    const lines = result.stderr.replace(/\n$/, '').split('\n')
    assert.equal(lines.length, 1, `expected one line, got: ${result.stderr}`)
    assert.match(lines[0], /^invalid columns config: effort "max"/)
  })

  test('a remote column with no model exits nonzero with a one-line report', () => {
    const result = run(
      '--file',
      configFile(clone((c) => {
        delete c.columns.tester.model
      }))
    )

    assert.notEqual(result.status, 0)
    const lines = result.stderr.replace(/\n$/, '').split('\n')
    assert.equal(lines.length, 1, `expected one line, got: ${result.stderr}`)
    assert.match(lines[0], /^invalid columns config: column "tester" \(execute runner:mac\) needs a model/)
  })

  test('a missing --file argument exits nonzero with usage', () => {
    const result = run()

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /^usage: columns\.mjs --file/)
  })
})
