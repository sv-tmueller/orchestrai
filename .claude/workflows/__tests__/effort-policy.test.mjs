/**
 * Policy-lock test for the effort policy (issue #140, migrated to tier
 * assertions in #313, hardened in review of #320).
 *
 * Every seat pins its own effort, so session /effort governs only the
 * lead. The test reads the adapter table (.claude/adapters/claude-code.json)
 * to derive tier-to-model and tier-to-effort mappings, then asserts each
 * agent frontmatter's tier, model, and effort are consistent with the
 * table.
 *
 * POLICY VALUES ARE HARDCODED IN THIS FILE, NOT READ FROM THE TABLE.
 * The forbidden efforts list and the effort ceiling are the authority;
 * the adapter table must conform to them, not the reverse. Otherwise
 * editing the JSON disables the lock (review #320 finding 2).
 *
 * Lead tier is rejected on agent seats and workflow stages: fable is
 * lead-session-only (team-guide Model policy); letting it onto a worker
 * seat is a live 2x-cost regression path (review #320 finding 1).
 *
 * The workflow stage pins (the agent() calls in the three .js files) are
 * checked the same way: each stage's model must correspond to a tier in
 * the adapter table, and its effort must match that tier's effort.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const agentsDir = join(__dir, '..', '..', 'agents')
const adaptersDir = join(__dir, '..', '..', 'adapters')

// ---------------------------------------------------------------------------
// Policy constants: THESE ARE THE AUTHORITY, not the adapter table.
// The adapter table must conform to these values. If someone edits the
// JSON to weaken the policy, these hardcoded values still catch it.
// ---------------------------------------------------------------------------
const FORBIDDEN_EFFORTS = ['max']
const EFFORT_CEILING = 'xhigh'
const ALLOWED_AGENT_TIERS = ['judgment', 'worker']

const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

// ---------------------------------------------------------------------------
// Load the adapter table and derive tier mappings.
// ---------------------------------------------------------------------------
const adapterTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))
const TIERS = adapterTable.tiers
const ROLE_TIERS = adapterTable.roles

// Build tier -> effort for quick lookup.
const EFFORT_BY_TIER = {}
for (const [tier, cfg] of Object.entries(TIERS)) {
  EFFORT_BY_TIER[tier] = cfg.effort
}

// Build tier -> model for quick lookup.
const MODEL_BY_TIER = {}
for (const [tier, cfg] of Object.entries(TIERS)) {
  MODEL_BY_TIER[tier] = cfg.model
}

// ---------------------------------------------------------------------------
// Load every adapter table in the directory (review #320 finding 15).
// ---------------------------------------------------------------------------
const adapterFiles = readdirSync(adaptersDir).filter((f) => f.endsWith('.json'))
const adapterTables = adapterFiles.map((f) => ({
  name: f,
  table: JSON.parse(readFileSync(join(adaptersDir, f), 'utf8')),
}))

// Hardcoded seat-level expectations: these are the policy, not the table.
// A coordinated edit to the JSON cannot weaken them (review #320 finding 14).
const SEAT_EXPECTATIONS = {
  judgment: { model: 'opus', effort: 'xhigh' },
  worker: { model: 'sonnet', effort: 'high' },
  lead: { model: 'fable', effort: 'xhigh' },
}

const WORKFLOW_FILES = ['tm-review-changes.js', 'tm-review-codebase.js', 'tm-map-codebase.js']

// ===========================================================================
// 0. Every adapter table conforms to the hardcoded policy.
//    The table is the data; this test is the authority.
// ===========================================================================
for (const { name, table } of adapterTables) {
  describe(`adapter table conforms to policy: ${name}`, () => {
    test('forbidden_efforts matches the hardcoded policy', () => {
      assert.deepEqual(
        table.forbidden_efforts,
        FORBIDDEN_EFFORTS,
        `${name}: forbidden_efforts is ${JSON.stringify(table.forbidden_efforts)}, ` +
          `but the policy hardcodes ${JSON.stringify(FORBIDDEN_EFFORTS)}; ` +
          `do not weaken the policy by editing the JSON`
      )
    })

    test('effort_ceiling matches the hardcoded policy', () => {
      assert.equal(
        table.effort_ceiling,
        EFFORT_CEILING,
        `${name}: effort_ceiling is "${table.effort_ceiling}", ` +
          `but the policy hardcodes "${EFFORT_CEILING}"; ` +
          `do not weaken the policy by editing the JSON`
      )
    })

    test('no tier effort exceeds the hardcoded ceiling', () => {
      for (const [tier, cfg] of Object.entries(table.tiers)) {
        assert.ok(
          EFFORT_RANK[cfg.effort] !== undefined,
          `${name}: tier "${tier}" effort "${cfg.effort}" is not a recognized effort level`
        )
        assert.ok(
          EFFORT_RANK[cfg.effort] <= EFFORT_RANK[EFFORT_CEILING],
          `${name}: tier "${tier}" effort "${cfg.effort}" exceeds the ceiling "${EFFORT_CEILING}"`
        )
      }
    })

    test('no tier uses a hardcoded forbidden effort', () => {
      for (const forbidden of FORBIDDEN_EFFORTS) {
        for (const [tier, cfg] of Object.entries(table.tiers)) {
          assert.notEqual(
            cfg.effort,
            forbidden,
            `${name}: tier "${tier}" uses forbidden effort "${forbidden}"`
          )
        }
      }
    })

    test('seat-level model and effort match hardcoded expectations', () => {
      for (const [tier, expected] of Object.entries(SEAT_EXPECTATIONS)) {
        const cfg = table.tiers[tier]
        assert.ok(cfg, `${name}: missing tier "${tier}"`)
        assert.equal(
          cfg.model,
          expected.model,
          `${name}: tier "${tier}" model is "${cfg.model}", but the policy hardcodes "${expected.model}"`
        )
        assert.equal(
          cfg.effort,
          expected.effort,
          `${name}: tier "${tier}" effort is "${cfg.effort}", but the policy hardcodes "${expected.effort}"`
        )
      }
    })
  })
}

// ===========================================================================
// 1. Agent frontmatter: every role agent pins tier, and model+effort match
//    the adapter table's mapping for that tier. Lead tier is rejected.
// ===========================================================================
describe('agent frontmatter tier pins', () => {
  const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))

  test('the role agents are present', () => {
    assert.ok(
      agentFiles.length >= 7,
      `expected at least the 7 role agents in ${agentsDir}, found ${agentFiles.length}`
    )
  })

  for (const file of agentFiles) {
    test(`${file} pins tier, model, and effort consistent with the adapter table`, () => {
      const src = readFileSync(join(agentsDir, file), 'utf8')
      const fm = src.match(/^---\n([\s\S]*?)\n---/)
      assert.ok(fm, `${file} has no frontmatter block`)

      const tier = fm[1].match(/^tier:\s*(\S+)/m)?.[1]
      assert.ok(tier, `${file} must pin tier: explicitly`)
      assert.ok(
        TIERS[tier],
        `${file} pins tier "${tier}", which is not in the adapter table; ` +
          `add it to .claude/adapters/claude-code.json`
      )

      // Reject lead tier on agent seats: fable is lead-session-only.
      assert.ok(
        ALLOWED_AGENT_TIERS.includes(tier),
        `${file} pins tier "${tier}", but agent seats may only use ` +
          `${ALLOWED_AGENT_TIERS.join(' or ')}; lead is reserved for the session`
      )

      const model = fm[1].match(/^model:\s*(\S+)/m)?.[1]
      assert.ok(model, `${file} must pin model: explicitly`)
      assert.equal(
        model,
        MODEL_BY_TIER[tier],
        `${file} (tier ${tier}) must pin model: ${MODEL_BY_TIER[tier]}, ` +
          `found ${model}; the adapter table maps tier ${tier} to ${MODEL_BY_TIER[tier]}`
      )

      const effort = fm[1].match(/^effort:\s*(\S+)/m)?.[1]
      assert.equal(
        effort,
        EFFORT_BY_TIER[tier],
        `${file} (tier ${tier}) must pin effort: ${EFFORT_BY_TIER[tier]}, ` +
          `found ${effort ?? 'none (would inherit the session effort)'}`
      )
    })
  }

  test('no agent file uses a forbidden effort', () => {
    for (const forbidden of FORBIDDEN_EFFORTS) {
      for (const file of agentFiles) {
        const src = readFileSync(join(agentsDir, file), 'utf8')
        assert.ok(
          !new RegExp(`effort:\\s*${forbidden}`).test(src),
          `${file} contains effort: ${forbidden}`
        )
      }
    }
  })
})

// ===========================================================================
// 2. Workflow stages: every agent() call pins the effort matching its
//    model's tier in the adapter table.
//
// Agent-call opts in both workflows are single-line objects carrying both
// label: and model:. The meta.phases display entries carry model: but
// title:/detail: instead of label:, so requiring label: excludes them. The
// criticWithFallback retry opts (`{ ...opts, model: 'sonnet' }`) also carry
// model: with no label: and no literal effort:, so the same filter excludes
// them too; that is safe because the spread inherits effort: from the
// caller's opts line, which this test already checks.
//
// FORMAT IS LOAD-BEARING: the filter requires label: and model: on the
// same line. Reformatting an agent() opts object across multiple lines
// silently removes it from the checks below. Do not reformat these calls
// (review #320 finding 20).
// ===========================================================================
describe('workflow stage effort pins', () => {
  for (const file of WORKFLOW_FILES) {
    const src = readFileSync(join(workflowsDir, file), 'utf8')
    const optLines = src
      .split('\n')
      .filter((l) => l.includes('label:') && l.includes('model:'))

    test(`${file} has agent-call opts lines to check`, () => {
      assert.ok(
        optLines.length > 0,
        `${file}: no lines with both label: and model: found; ` +
          `if the opts format changed, update this test's parsing rule`
      )
    })

    test(`${file}: every stage pins the effort matching its model's tier`, () => {
      for (const line of optLines) {
        const model = line.match(/model:\s*'(\w+)'/)?.[1]
        assert.ok(model, `${file}: unparseable model in: ${line.trim()}`)

        // Find the tier for this model in the adapter table.
        let tier = null
        for (const [t, cfg] of Object.entries(TIERS)) {
          if (cfg.model === model) {
            tier = t
            break
          }
        }
        assert.ok(
          tier,
          `${file}: model "${model}" is not in the adapter table; ` +
            `add it to .claude/adapters/claude-code.json under a tier`
        )

        // Reject lead tier on workflow stages.
        assert.ok(
          ALLOWED_AGENT_TIERS.includes(tier),
          `${file}: model "${model}" resolves to tier "${tier}", but workflow ` +
            `stages may only use ${ALLOWED_AGENT_TIERS.join(' or ')}; ` +
            `lead is reserved for the session`
        )

        const expected = EFFORT_BY_TIER[tier]
        const effort = line.match(/effort:\s*'(\w+)'/)?.[1]
        assert.equal(
          effort,
          expected,
          `${file}: a ${model} stage (tier ${tier}) must pin effort: '${expected}': ${line.trim()}`
        )
      }
    })

    test(`${file}: nothing runs at a forbidden effort`, () => {
      for (const forbidden of FORBIDDEN_EFFORTS) {
        assert.ok(
          !new RegExp(`effort:\\s*'${forbidden}'`).test(src),
          `${file} contains effort: '${forbidden}'`
        )
      }
    })
  }
})
