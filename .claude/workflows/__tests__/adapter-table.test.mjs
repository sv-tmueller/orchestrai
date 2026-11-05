/**
 * Adapter table structural test (issue #313).
 *
 * Validates the STRUCTURE of every adapter table JSON file in
 * .claude/adapters/: required tiers present, every tier has a model and
 * effort, every role maps to a known tier, and every agent file has a
 * corresponding role.
 *
 * CONFORMANCE CHECKS (does the table match the policy?) live in
 * effort-policy.test.mjs, not here. This file checks structure only;
 * that file checks values. The role-to-agent-file cross-checks live
 * here exclusively (review #320 finding 4).
 *
 * Host-agnostic: iterates every *.json in the adapters directory, so a
 * future Hermes or Codex adapter table is validated automatically
 * (review #320 finding 5).
 *
 * Per-role overrides (#453): a role value is either a tier string, as in
 * the reference table, or an object with a tier key plus optional model,
 * effort, and settings overrides. Both forms are accepted here; the
 * effort policy that constrains the values lives in effort-policy.test.mjs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')
const agentsDir = join(__dir, '..', '..', 'agents')

const REQUIRED_TIERS = ['judgment', 'worker', 'lead']
const REQUIRED_TIER_FIELDS = ['model', 'effort']

// The fields a per-role override object may carry. A whitelist, so a typo
// in a table ("modell") fails loudly instead of being ignored silently.
const OVERRIDE_FIELDS = ['tier', 'model', 'effort', 'settings']

// Tables that spawn each seat as its own headless `claude -p` subprocess
// (#453). claude-code.json stays the in-process Agent tool default.
const SUBPROCESS_TABLES = ['claude-code-vllm.json', 'claude-code-split.json']

// Load every adapter table in the directory.
const adapterFiles = readdirSync(adaptersDir).filter((f) => f.endsWith('.json'))
const adapterTables = adapterFiles.map((f) => ({
  name: f,
  path: join(adaptersDir, f),
  table: JSON.parse(readFileSync(join(adaptersDir, f), 'utf8')),
}))

// A role value is a tier string, or an override object naming its tier.
function tierOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.tier
  return undefined
}

// Every string in a parsed table, so a structural rule can be asserted on
// the values without walking the tree again in each test.
function stringValues(node, out = []) {
  if (typeof node === 'string') {
    out.push(node)
  } else if (Array.isArray(node)) {
    for (const item of node) stringValues(item, out)
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) stringValues(value, out)
  }
  return out
}

test('at least one adapter table exists', () => {
  assert.ok(adapterTables.length > 0, `no *.json files found in ${adaptersDir}`)
})

for (const { name, table } of adapterTables) {
  describe(`adapter table structure: ${name}`, () => {
    test('has a tiers map', () => {
      assert.ok(table.tiers, `${name}: must have a tiers map`)
      assert.ok(typeof table.tiers === 'object', `${name}: tiers must be an object`)
    })

    test('has all required tiers', () => {
      for (const tier of REQUIRED_TIERS) {
        assert.ok(
          table.tiers[tier],
          `${name}: missing required tier "${tier}"`
        )
      }
    })

    test('every tier maps to a model and an effort', () => {
      for (const [tier, cfg] of Object.entries(table.tiers)) {
        for (const field of REQUIRED_TIER_FIELDS) {
          assert.ok(
            cfg[field],
            `${name}: tier "${tier}" is missing "${field}"`
          )
        }
      }
    })

    test('has a roles map', () => {
      assert.ok(table.roles, `${name}: must have a roles map`)
      assert.ok(typeof table.roles === 'object', `${name}: roles must be an object`)
    })

    test('every role maps to a known tier', () => {
      for (const [role, value] of Object.entries(table.roles)) {
        const tier = tierOf(value)
        assert.ok(
          tier,
          `${name}: role "${role}" must be a tier string or an object with a tier key`
        )
        assert.ok(
          table.tiers[tier],
          `${name}: role "${role}" maps to tier "${tier}", which is not in the tiers map`
        )
      }
    })

    test('every per-role override uses only known fields', () => {
      for (const [role, value] of Object.entries(table.roles)) {
        if (typeof value !== 'object' || value === null) continue
        for (const field of Object.keys(value)) {
          assert.ok(
            OVERRIDE_FIELDS.includes(field),
            `${name}: role "${role}" override has unknown field "${field}"; ` +
              `allowed: ${OVERRIDE_FIELDS.join(', ')}`
          )
        }
      }
    })

    test('every per-role override model and effort, where present, is a string', () => {
      for (const [role, value] of Object.entries(table.roles)) {
        if (typeof value !== 'object' || value === null) continue
        for (const field of ['model', 'effort', 'settings']) {
          if (value[field] === undefined) continue
          assert.equal(
            typeof value[field], 'string',
            `${name}: role "${role}" override "${field}" must be a string`
          )
        }
      }
    })

    test('declares a dispatch mode of "agent" or "subprocess"', () => {
      const dispatch = table.dispatch ?? 'agent'
      assert.ok(
        ['agent', 'subprocess'].includes(dispatch),
        `${name}: dispatch is "${dispatch}"; expected "agent" or "subprocess"`
      )
    })

    test('no table carries an absolute path or a token in a settings pointer', () => {
      // Rules from the #453 pinned design: the settings profile travels as a
      // placeholder the run expands from its own environment, so a checked-in
      // table never names a local path or embeds a secret.
      for (const value of stringValues(table)) {
        assert.ok(
          !value.startsWith('/'),
          `${name}: "${value}" is an absolute path; use a placeholder such as ` +
            `$CLAUDE_CODE_NORIS_SETTINGS`
        )
        assert.ok(
          !/\b(sk-|ghp_|Bearer )/.test(value),
          `${name}: "${value}" looks like a credential; never put a token in a table`
        )
      }
    })

    if (SUBPROCESS_TABLES.includes(name)) {
      test('is a claude-code host table that spawns seats as subprocesses', () => {
        assert.equal(table.host, 'claude-code', `${name}: host must be "claude-code"`)
        assert.equal(
          table.dispatch, 'subprocess',
          `${name}: this table exists for subprocess seats, so dispatch must be "subprocess"`
        )
      })

      test('carries a per-tier settings profile placeholder', () => {
        for (const [tier, cfg] of Object.entries(table.tiers)) {
          assert.ok(
            cfg.settings,
            `${name}: tier "${tier}" needs a settings pointer (a placeholder, ` +
              `not a path) so the seat loads the right profile`
          )
        }
      })
    }

    test('every role in the table has a corresponding agent file', () => {
      const agentNames = readdirSync(agentsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
      for (const role of Object.keys(table.roles)) {
        assert.ok(
          agentNames.includes(role),
          `${name}: references role "${role}" but no ${role}.md found in ${agentsDir}`
        )
      }
    })

    test('every agent file has a role in the table', () => {
      const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      for (const file of agentFiles) {
        const role = file.replace(/\.md$/, '')
        assert.ok(
          table.roles[role],
          `${name}: agent file ${file} has no entry in the roles map`
        )
      }
    })
  })
}

// ===========================================================================
// The subprocess tables (#453). claude-code.json stays the in-process
// default; these two exist so a run can spawn every seat as its own
// headless `claude -p` session against a self-hosted endpoint.
// ===========================================================================
function readTable(file) {
  const path = join(adaptersDir, file)
  assert.ok(existsSync(path), `missing adapter table ${file}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('claude-code-vllm.json', () => {
  const table = readTable('claude-code-vllm.json')

  test('spawns subprocess seats on the vllm provider at the lifted ceiling', () => {
    assert.equal(table.host, 'claude-code')
    assert.equal(table.dispatch, 'subprocess')
    assert.equal(table.effort_ceiling, 'max')
    assert.deepEqual(table.forbidden_efforts, [])
  })

  test('routes every tier to a vllm model at max effort', () => {
    for (const [tier, cfg] of Object.entries(table.tiers)) {
      assert.equal(cfg.provider, 'vllm', `tier "${tier}" provider`)
      assert.ok(
        cfg.model.startsWith('vllm/'),
        `tier "${tier}" model "${cfg.model}" is not a vllm model`
      )
      assert.equal(cfg.effort, 'max', `tier "${tier}" effort`)
    }
  })

  test('every role resolves through the tiers, with no per-role override needed', () => {
    for (const [role, tier] of Object.entries(table.roles)) {
      assert.equal(typeof tier, 'string', `role "${role}" should stay a plain tier string`)
      assert.ok(table.tiers[tier], `role "${role}" maps to unknown tier "${tier}"`)
      assert.equal(
        table.tiers[tier].provider, 'vllm',
        `role "${role}" must resolve to a vllm model through its tier`
      )
    }
  })
})

describe('claude-code-split.json', () => {
  const table = readTable('claude-code-split.json')

  test('spawns subprocess seats, keeping the paid baseline at the table level', () => {
    assert.equal(table.host, 'claude-code')
    assert.equal(table.dispatch, 'subprocess')
    // Mixed providers: not every tier is self-hosted, so the baseline is
    // the paid policy and the vllm tiers are lifted per tier (#453).
    assert.equal(table.effort_ceiling, 'xhigh')
    assert.deepEqual(table.forbidden_efforts, ['max'])
  })

  test('judgment stays on opus at xhigh on a paid provider', () => {
    const judgment = table.tiers.judgment
    assert.equal(judgment.model, 'opus')
    assert.equal(judgment.effort, 'xhigh')
    assert.notEqual(judgment.provider, 'vllm', 'judgment must stay on a paid model')
  })

  test('worker runs on vllm and lifts the ceiling', () => {
    const worker = table.tiers.worker
    assert.equal(worker.provider, 'vllm')
    assert.ok(worker.model.startsWith('vllm/'), `worker model "${worker.model}" is not vllm`)
    assert.equal(worker.effort, 'max')
  })

  test('a per-role override beats the tier default', () => {
    // The pinned design (#453): a role entry may be an object with a tier
    // plus a pinned model/effort, and the override wins over the tier map.
    const override = table.roles.developer
    assert.equal(typeof override, 'object', 'developer must carry a per-role override')
    assert.ok(override.tier, 'the override must still name its tier')
    assert.ok(
      override.model || override.effort,
      'an override with neither model nor effort would be a no-op'
    )
    // If it pins a model, it must be a real, non-fable model string.
    if (override.model) {
      assert.ok(override.model.trim().length > 0)
    }
  })
})
