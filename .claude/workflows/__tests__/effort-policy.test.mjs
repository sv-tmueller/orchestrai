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
 * The workflow stage pins check the embedded SPEC and TIER_MODELS/
 * TIER_EFFORTS maps in each JS file, asserting they match the adapter
 * table.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const agentsDir = join(__dir, '..', '..', 'agents')
const adaptersDir = join(__dir, '..', '..', 'adapters')

// ---------------------------------------------------------------------------
// Policy constants: THESE ARE THE AUTHORITY, not the adapter table.
// ---------------------------------------------------------------------------
const FORBIDDEN_EFFORTS = ['max']
const EFFORT_CEILING = 'xhigh'
const ALLOWED_AGENT_TIERS = ['judgment', 'worker']

const EFFORT_RANK = { low: 0, medium: 0, high: 1, xhigh: 2, max: 3 }

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

const WORKFLOW_FILES = ['tm-review-changes.js', 'tm-review-codebase.js', 'tm-map-codebase.js']

// ===========================================================================
// 0. Adapter table conforms to the hardcoded policy.
// ===========================================================================
describe('adapter table conforms to policy', () => {
  test('forbidden_efforts in the table matches the hardcoded policy', () => {
    assert.deepEqual(
      adapterTable.forbidden_efforts,
      FORBIDDEN_EFFORTS,
      `adapter table forbidden_efforts is ${JSON.stringify(adapterTable.forbidden_efforts)}, ` +
        `but the policy hardcodes ${JSON.stringify(FORBIDDEN_EFFORTS)}; ` +
        `do not weaken the policy by editing the JSON`
    )
  })

  test('effort_ceiling in the table matches the hardcoded policy', () => {
    assert.equal(
      adapterTable.effort_ceiling,
      EFFORT_CEILING,
      `adapter table effort_ceiling is "${adapterTable.effort_ceiling}", ` +
        `but the policy hardcodes "${EFFORT_CEILING}"; ` +
        `do not weaken the policy by editing the JSON`
    )
  })

  test('no tier effort exceeds the hardcoded ceiling', () => {
    for (const [tier, cfg] of Object.entries(TIERS)) {
      assert.ok(
        EFFORT_RANK[cfg.effort] !== undefined,
        `tier "${tier}" effort "${cfg.effort}" is not a recognized effort level`
      )
      assert.ok(
        EFFORT_RANK[cfg.effort] <= EFFORT_RANK[EFFORT_CEILING],
        `tier "${tier}" effort "${cfg.effort}" exceeds the ceiling "${EFFORT_CEILING}"`
      )
    }
  })

  test('no tier uses a hardcoded forbidden effort', () => {
    for (const forbidden of FORBIDDEN_EFFORTS) {
      for (const [tier, cfg] of Object.entries(TIERS)) {
        assert.notEqual(
          cfg.effort,
          forbidden,
          `adapter table tier "${tier}" uses forbidden effort "${forbidden}"`
        )
      }
    }
  })
})

// ===========================================================================
// 1. Agent frontmatter: every role agent pins tier, and model+effort match
//    the adapter table's mapping for that tier.
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

  test('every role in the adapter table has a corresponding agent file', () => {
    for (const role of Object.keys(ROLE_TIERS)) {
      const agentFile = `${role}.md`
      assert.ok(
        agentFiles.includes(agentFile),
        `adapter table references role "${role}" but no ${agentFile} found in ${agentsDir}`
      )
    }
  })

  test('every agent file has a role in the adapter table', () => {
    for (const file of agentFiles) {
      const role = file.replace(/\.md$/, '')
      assert.ok(
        ROLE_TIERS[role],
        `${file} has no entry in the adapter table roles map; ` +
          `add "${role}" to .claude/adapters/claude-code.json`
      )
    }
  })
})

// ===========================================================================
// 2. Workflow stages: every stage in the embedded SPEC declares a tier that
//    exists in the adapter table, and the TIER_MODELS/TIER_EFFORTS maps in
//    each JS file match the adapter table.
//
// Since #314 the workflow scripts reference tiers via SPEC.stages.*.tier and
// resolve them through inlined TIER_MODELS/TIER_EFFORTS maps. The test parses
// the SPEC constant and the maps from the JS source, then asserts consistency
// with the adapter table. It also still scans for literal forbidden efforts
// in the source (defense in depth).
// ===========================================================================
describe('workflow stage tier pins', () => {
  // Parse the SPEC object from a JS source file. The SPEC is a top-level
  // const assigned with an object literal ending before the next top-level
  // const/export/statement. We extract it by brace-matching from `const SPEC = {`.
  function parseSpec(src) {
    const startIdx = src.indexOf('const SPEC = {')
    assert.ok(startIdx !== -1, 'SPEC constant not found')
    let pos = src.indexOf('{', startIdx)
    let depth = 0
    let started = false
    while (pos < src.length) {
      if (src[pos] === '{') { depth++; started = true }
      if (src[pos] === '}') depth--
      pos++
      if (started && depth === 0) break
    }
    const specSrc = src.slice(startIdx, pos)
    const ctx = createContext({})
    runInContext(specSrc, ctx)
    return runInContext('SPEC', ctx)
  }

  // Parse the TIER_MODELS and TIER_EFFORTS maps from a JS source file.
  function parseTierMaps(src) {
    function extractConst(name) {
      const re = new RegExp(`const ${name} = \\{`)
      const match = re.exec(src)
      if (!match) return null
      let pos = src.indexOf('{', match.index)
      let depth = 0
      let started = false
      while (pos < src.length) {
        if (src[pos] === '{') { depth++; started = true }
        if (src[pos] === '}') depth--
        pos++
        if (started && depth === 0) break
      }
      const constSrc = src.slice(match.index, pos)
      const ctx = createContext({})
      runInContext(constSrc, ctx)
      return runInContext(name, ctx)
    }
    return {
      models: extractConst('TIER_MODELS'),
      efforts: extractConst('TIER_EFFORTS'),
    }
  }

  for (const file of WORKFLOW_FILES) {
    const src = readFileSync(join(workflowsDir, file), 'utf8')

    test(`${file} has a SPEC constant`, () => {
      assert.ok(src.includes('const SPEC = {'), `${file}: no SPEC constant found`)
    })

    test(`${file}: every stage tier exists in the adapter table`, () => {
      const spec = parseSpec(src)
      assert.ok(spec.stages, `${file}: SPEC has no stages`)
      for (const [name, stage] of Object.entries(spec.stages)) {
        assert.ok(
          TIERS[stage.tier],
          `${file}: stage "${name}" declares tier "${stage.tier}", which is not in the adapter table`
        )
        // Reject lead tier on workflow stages: fable is lead-session-only.
        assert.ok(
          ALLOWED_AGENT_TIERS.includes(stage.tier),
          `${file}: stage "${name}" declares tier "${stage.tier}", but workflow ` +
            `stages may only use ${ALLOWED_AGENT_TIERS.join(' or ')}; ` +
            `lead is reserved for the session`
        )
      }
    })

    test(`${file}: TIER_MODELS matches the adapter table`, () => {
      const { models } = parseTierMaps(src)
      assert.ok(models, `${file}: TIER_MODELS not found`)
      for (const [tier, model] of Object.entries(models)) {
        assert.equal(
          model,
          MODEL_BY_TIER[tier],
          `${file}: TIER_MODELS[${tier}] is "${model}" but the adapter table says "${MODEL_BY_TIER[tier]}"`
        )
      }
    })

    test(`${file}: TIER_EFFORTS matches the adapter table`, () => {
      const { efforts } = parseTierMaps(src)
      assert.ok(efforts, `${file}: TIER_EFFORTS not found`)
      for (const [tier, effort] of Object.entries(efforts)) {
        assert.equal(
          effort,
          EFFORT_BY_TIER[tier],
          `${file}: TIER_EFFORTS[${tier}] is "${effort}" but the adapter table says "${EFFORT_BY_TIER[tier]}"`
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
