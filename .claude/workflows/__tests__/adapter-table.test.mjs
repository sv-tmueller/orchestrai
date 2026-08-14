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
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')
const agentsDir = join(__dir, '..', '..', 'agents')

const REQUIRED_TIERS = ['judgment', 'worker', 'lead']
const REQUIRED_TIER_FIELDS = ['model', 'effort']

// Load every adapter table in the directory.
const adapterFiles = readdirSync(adaptersDir).filter((f) => f.endsWith('.json'))
const adapterTables = adapterFiles.map((f) => ({
  name: f,
  path: join(adaptersDir, f),
  table: JSON.parse(readFileSync(join(adaptersDir, f), 'utf8')),
}))

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
      for (const [role, tier] of Object.entries(table.roles)) {
        assert.ok(
          table.tiers[tier],
          `${name}: role "${role}" maps to tier "${tier}", which is not in the tiers map`
        )
      }
    })

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
