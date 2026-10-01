/**
 * Item transform and cap tests for dynamic-list stages (issue #406).
 *
 * getDynamicListItems is exported from both the Hermes and Codex renderers.
 * Codex shells out to execSync in spawn, so its renderWorkflow cannot be
 * stubbed; the exported resolver is the seam that both renderers share, so one
 * parametrized suite runs against both modules.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

process.env.DRY_RUN = 'true'

const RENDERERS = {
  hermes: '../../adapters/hermes-renderer.mjs',
  codex: '../../adapters/codex-renderer.mjs',
}

const finding = (file, line, problem, severity = 'must-fix') => ({
  file,
  line,
  problem,
  severity,
  fix: 'x',
})

const verifyStage = (over = {}) => ({
  parallelism: 'dynamic-list',
  items_source: 'review_result',
  items_transform: 'must_fix_deduped',
  items_cap: 'args.maxVerify',
  items_default_cap: 3,
  ...over,
})

for (const [host, path] of Object.entries(RENDERERS)) {
  describe(`${host} renderer: getDynamicListItems`, async () => {
    const { getDynamicListItems } = await import(path)
    const log = () => {}

    test('must_fix_deduped keeps only must-fix findings, flattened across reports', () => {
      const ctx = {
        review_result: [
          { findings: [finding('a.js', '1', 'p1'), finding('a.js', '2', 'p2', 'nit')] },
          { findings: [finding('b.js', '3', 'p3'), finding('c.js', '4', 'p4', 'should-fix')] },
        ],
      }
      const items = getDynamicListItems(verifyStage(), ctx, {}, 'verify', log)
      assert.deepEqual(items.map((f) => f.problem), ['p1', 'p3'])
    })

    test('must_fix_deduped dedups on file + line + problem', () => {
      const ctx = {
        review_result: [
          { findings: [finding('a.js', '1', 'p1')] },
          { findings: [finding('a.js', '1', 'p1'), finding('a.js', '2', 'p1'), finding('a.js', '1', 'other')] },
        ],
      }
      const items = getDynamicListItems(verifyStage(), ctx, {}, 'verify', log)
      assert.equal(items.length, 3)
    })

    test('must_fix_deduped skips null reports and reports without a findings array', () => {
      const ctx = { review_result: [null, undefined, {}, { findings: 'x' }, { findings: [finding('a.js', '1', 'p1')] }] }
      const items = getDynamicListItems(verifyStage(), ctx, {}, 'verify', log)
      assert.deepEqual(items.map((f) => f.problem), ['p1'])
    })

    test('the cap field is read from args by its name with the "args." prefix stripped', () => {
      const many = Array.from({ length: 6 }, (_, i) => finding('a.js', String(i), `p${i}`))
      const ctx = { review_result: [{ findings: many }] }
      assert.equal(getDynamicListItems(verifyStage(), ctx, { maxVerify: 2 }, 'verify', log).length, 2)
      assert.equal(getDynamicListItems(verifyStage(), ctx, { maxVerify: 5 }, 'verify', log).length, 5)
    })

    test('an absent or invalid cap value falls back to items_default_cap', () => {
      const many = Array.from({ length: 6 }, (_, i) => finding('a.js', String(i), `p${i}`))
      const ctx = { review_result: [{ findings: many }] }
      for (const bad of [undefined, 0, -1, 1.5, '2', NaN, null]) {
        assert.equal(
          getDynamicListItems(verifyStage(), ctx, { maxVerify: bad }, 'verify', log).length,
          3,
          `maxVerify=${String(bad)} should use the default cap`
        )
      }
    })

    test('the cap runs after the transform, so non-must-fix findings do not use up the budget', () => {
      const ctx = {
        review_result: [
          {
            findings: [
              finding('n.js', '1', 'n1', 'nit'),
              finding('n.js', '2', 'n2', 'nit'),
              finding('a.js', '1', 'p1'),
              finding('a.js', '2', 'p2'),
            ],
          },
        ],
      }
      const items = getDynamicListItems(verifyStage(), ctx, { maxVerify: 2 }, 'verify', log)
      assert.deepEqual(items.map((f) => f.problem), ['p1', 'p2'])
    })

    test('items past the cap are logged with the dropped count', () => {
      const many = Array.from({ length: 5 }, (_, i) => finding('a.js', String(i), `p${i}`))
      const local = []
      getDynamicListItems(verifyStage(), { review_result: [{ findings: many }] }, { maxVerify: 2 }, 'verify', (m) => local.push(m))
      assert.equal(local.length, 1)
      assert.match(local[0], /verify/)
      assert.match(local[0], /3/)
    })

    test('no overflow log when the items fit under the cap', () => {
      const local = []
      getDynamicListItems(verifyStage(), { review_result: [{ findings: [finding('a.js', '1', 'p1')] }] }, {}, 'verify', (m) => local.push(m))
      assert.deepEqual(local, [])
    })

    test('an unknown items_transform name throws', () => {
      assert.throws(
        () => getDynamicListItems(verifyStage({ items_transform: 'no_such_reducer' }), { review_result: [] }, {}, 'verify', log),
        /no_such_reducer/
      )
    })

    test('a stage with no items_transform passes the source array through, capped', () => {
      const stage = { parallelism: 'dynamic-list', items_source: 'scout_result.areas', items_cap: 'args.areas', items_default_cap: 24 }
      const areas = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
      const out = getDynamicListItems(stage, { scout_result: { areas } }, { areas: 2 }, 'area_map', log)
      assert.deepEqual(out.map((a) => a.name), ['a', 'b'])
    })

    test('an unresolved items_source still falls back to the stub item and skips the transform', () => {
      const local = []
      const out = getDynamicListItems(verifyStage(), {}, {}, 'verify', (m) => local.push(m))
      assert.equal(out.length, 1)
      assert.ok(local.some((m) => m.includes('did not resolve to an array')))
    })
  })
}
