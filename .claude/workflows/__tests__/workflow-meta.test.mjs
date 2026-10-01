/**
 * Guard for the `meta` export of each workflow script (issue #424).
 *
 * The Claude Code workflow runtime reads `meta` before it runs the script, so
 * it has to be a plain literal and the first statement of the file. It cannot
 * be computed from SPEC. This test pins that shape for every workflow script
 * and checks the literal stays in sync with SPEC and TIER_MODELS, which are
 * checked in turn against the JSON spec and the adapter table elsewhere.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')

const META_START = 'export const meta = {'

// Listed from disk so a new workflow cannot skip the check.
const WORKFLOW_FILES = readdirSync(workflowsDir).filter((f) => f.endsWith('.js'))

// Return the source text of the first brace-balanced object literal that
// starts at or after `from`.
function braceMatch(src, from) {
  let pos = src.indexOf('{', from)
  const start = pos
  let depth = 0
  while (pos < src.length) {
    if (src[pos] === '{') depth++
    if (src[pos] === '}') depth--
    pos++
    if (depth === 0) break
  }
  return src.slice(start, pos)
}

function evalLiteral(literal) {
  return runInContext('(' + literal + ')', createContext({}))
}

// Objects built in a vm context come from another realm, so deepStrictEqual
// fails on them. A JSON round-trip moves both sides into this realm.
const plain = (value) => JSON.parse(JSON.stringify(value))

describe('workflow scripts: meta is a literal first statement', () => {
  test('the workflow scripts are found on disk', () => {
    assert.ok(WORKFLOW_FILES.length >= 3, `found ${WORKFLOW_FILES.join(', ')}`)
  })

  for (const file of WORKFLOW_FILES) {
    const src = readFileSync(join(workflowsDir, file), 'utf8')

    test(`${file}: starts at byte 0 with the meta export`, () => {
      assert.ok(
        src.startsWith(META_START),
        `${file}: must begin with "${META_START}" (no header comment, no other statement above it)`
      )
    })

    test(`${file}: meta is a plain literal with no calls or references`, () => {
      const idx = src.indexOf(META_START)
      assert.notEqual(idx, -1, `${file}: no meta export found`)
      const literal = braceMatch(src, idx)
      // Evaluating in an empty context is not enough: builtins such as
      // Object.freeze and Array.prototype.map are always there. So strip the
      // quoted strings and the `key:` names, then require only punctuation
      // to remain. That rejects calls, identifiers as values, arrows, spreads,
      // template literals and comments.
      const stripped = literal
        .replace(/'[^'\\\n]*'/g, '')
        .replace(/"[^"\\\n]*"/g, '')
        .replace(/[A-Za-z_$][\w$]*\s*:/g, '')
      assert.match(
        stripped,
        /^[\s{}[\],]*$/,
        `${file}: meta must hold only quoted strings, object keys, braces, brackets and commas; left over: ${stripped.replace(/\s+/g, ' ').trim()}`
      )
      assert.doesNotThrow(() => evalLiteral(literal), `${file}: meta does not evaluate in an empty context`)
    })

    test(`${file}: meta matches SPEC with tiers resolved through TIER_MODELS`, () => {
      const metaIdx = src.indexOf(META_START)
      assert.notEqual(metaIdx, -1, `${file}: no meta export found`)
      const meta = evalLiteral(braceMatch(src, metaIdx))

      const specIdx = src.indexOf('const SPEC = {')
      assert.notEqual(specIdx, -1, `${file}: no SPEC found`)
      const spec = evalLiteral(braceMatch(src, specIdx))

      const modelsIdx = src.indexOf('const TIER_MODELS = {')
      assert.notEqual(modelsIdx, -1, `${file}: no TIER_MODELS found`)
      const models = evalLiteral(braceMatch(src, modelsIdx))

      const expected = {
        name: spec.name,
        description: spec.description,
        phases: spec.phases.map((p) => ({ title: p.title, detail: p.detail, model: models[p.tier] })),
      }
      assert.deepStrictEqual(plain(meta), plain(expected), `${file}: meta drifted from SPEC / TIER_MODELS`)
    })
  }
})
