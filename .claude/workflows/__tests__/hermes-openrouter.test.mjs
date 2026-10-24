/**
 * Hermes OpenRouter variant test (issue #444, batch #443).
 *
 * The variant is a second Hermes table that routes all three tiers to a
 * paid provider. The adapter picks its table once, at module load, from
 * HERMES_ADAPTER_TABLE, so this file sets the variable before a dynamic
 * import. node --test runs each file in its own process, so the setting
 * cannot leak into other test files.
 *
 * No live calls: buildArgv is pure and DRY_RUN is set.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const adaptersDir = join(__dir, '..', '..', 'adapters')

process.env.DRY_RUN = 'true'
process.env.HERMES_ADAPTER_TABLE = 'hermes-openrouter.json'

const VARIANT_FILE = 'hermes-openrouter.json'
const MODEL = 'moonshotai/kimi-k3.1-pro'
const FALLBACK = 'moonshotai/kimi-k3'

const variant = JSON.parse(readFileSync(join(adaptersDir, VARIANT_FILE), 'utf8'))
const hermesTable = JSON.parse(readFileSync(join(adaptersDir, 'hermes.json'), 'utf8'))

// The value following a flag in an argv array.
function flagValue(argv, flag) {
  const i = argv.indexOf(flag)
  assert.notEqual(i, -1, `argv has no ${flag}`)
  return argv[i + 1]
}

describe('hermes-openrouter.json table', () => {
  test('is a hermes table with xhigh ceiling and max/ultra forbidden', () => {
    assert.equal(variant.host, 'hermes')
    assert.equal(variant.effort_ceiling, 'xhigh')
    assert.deepEqual(variant.forbidden_efforts, ['max', 'ultra'])
  })

  test('routes all three tiers to kimi-k3.1-pro on openrouter at xhigh', () => {
    assert.deepEqual(Object.keys(variant.tiers).sort(), ['judgment', 'lead', 'worker'])
    for (const [tier, cfg] of Object.entries(variant.tiers)) {
      assert.equal(cfg.model, MODEL, `tier ${tier} model`)
      assert.equal(cfg.fallback_model, FALLBACK, `tier ${tier} fallback_model`)
      assert.equal(cfg.provider, 'openrouter', `tier ${tier} provider`)
      assert.equal(cfg.effort, 'xhigh', `tier ${tier} effort`)
    }
  })

  test('repeats the roles and seats of hermes.json', () => {
    assert.deepEqual(variant.roles, hermesTable.roles)
    assert.deepEqual(variant.seats, hermesTable.seats)
  })
})

describe('adapter loads the table named by HERMES_ADAPTER_TABLE', () => {
  let buildArgv, resolveRetryTarget, loadAdapterTable

  before(async () => {
    const mod = await import('../../adapters/hermes-adapter.mjs')
    buildArgv = mod.buildArgv
    resolveRetryTarget = mod.resolveRetryTarget
    loadAdapterTable = mod.loadAdapterTable
  })

  const cwd = '/tmp/seat-cwd'

  for (const [label, role, opts] of [
    ['judgment (architect)', 'architect', {}],
    ['worker (developer)', 'developer', {}],
    ['lead tier', 'architect', { tier: 'lead' }],
  ]) {
    test(`${label} argv carries the model, provider, and reasoning`, () => {
      const argv = buildArgv(role, 'one-line prompt', { cwd, ...opts })
      assert.equal(flagValue(argv, '-m'), MODEL)
      assert.equal(flagValue(argv, '--provider'), 'openrouter')
      assert.equal(flagValue(argv, '--reasoning'), 'xhigh')
    })
  }

  for (const effort of ['max', 'ultra']) {
    test(`effort ${effort} is rejected`, () => {
      assert.throws(
        () => buildArgv('architect', 'p', { cwd, effort }),
        (err) =>
          err.message.includes(`"${effort}" is forbidden`) &&
          err.message.includes('xhigh') &&
          // De-duplicated: ultra is in both the table and the host extras.
          !/ultra, ultra/.test(err.message)
      )
    })
  }

  test('the judgment retry stays within the tier on the fallback model', () => {
    const target = resolveRetryTarget(variant, 'judgment')
    assert.deepEqual(target, {
      tier: 'judgment',
      model: FALLBACK,
      effort: 'xhigh',
      provider: 'openrouter',
      withinTier: true,
    })
  })

  test('loadAdapterTable rejects a path outside the adapters directory', () => {
    assert.throws(() => loadAdapterTable('../claude-code.json'), /\.\.\/claude-code\.json/)
  })

  test('loadAdapterTable rejects a table whose host is not hermes', () => {
    assert.throws(() => loadAdapterTable('claude-code.json'), /claude-code\.json.*hermes/)
  })

  test('loadAdapterTable rejects a name that is not a .json file', () => {
    assert.throws(() => loadAdapterTable('hermes-adapter.mjs'), /hermes-adapter\.mjs/)
  })

  test('loadAdapterTable loads the variant by bare file name', () => {
    assert.equal(loadAdapterTable(VARIANT_FILE).tiers.judgment.model, MODEL)
  })
})
