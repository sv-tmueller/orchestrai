/**
 * Spec consistency test (issue #314).
 *
 * Asserts that the embedded SPEC constant in each workflow JS file matches
 * the corresponding JSON spec file under specs/. The JSON file is the
 * portable representation other hosts consume; the embedded constant is what
 * the Claude Code renderer uses at runtime (the workflow runtime has no
 * imports). This test catches drift between the two.
 *
 * Also asserts that every tier referenced in a spec exists in the adapter
 * table, bridging Phase A (#313) and Phase B (#314).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const specsDir = join(workflowsDir, 'specs')
const adaptersDir = join(workflowsDir, '..', 'adapters')

const adapterTable = JSON.parse(readFileSync(join(adaptersDir, 'claude-code.json'), 'utf8'))
const VALID_TIERS = Object.keys(adapterTable.tiers)

const WORKFLOW_FILES = ['tm-review-changes.js', 'tm-review-codebase.js', 'tm-map-codebase.js']

// ---------------------------------------------------------------------------
// Parse the SPEC object from a JS source file by brace-matching.
// ---------------------------------------------------------------------------
function parseSpecFromJs(src) {
  const startIdx = src.indexOf('const SPEC = {')
  if (startIdx === -1) return null
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

// Deep equality that ignores functions and the _comment field.
function deepEqualIgnoringMeta(a, b) {
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return a === b
  const ak = Object.keys(a).filter((k) => k !== '_comment')
  const bk = Object.keys(b).filter((k) => k !== '_comment')
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!(k in b)) return false
    if (!deepEqualIgnoringMeta(a[k], b[k])) return false
  }
  return true
}

// ===========================================================================
// 1. Embedded SPEC matches the JSON spec file.
// ===========================================================================
describe('embedded SPEC matches JSON spec file', () => {
  for (const file of WORKFLOW_FILES) {
    const specName = file.replace(/\.js$/, '.spec.json')
    const specPath = join(specsDir, specName)

    test(`${specName} exists`, () => {
      assert.ok(existsSync(specPath), `missing spec file: ${specPath}`)
    })

    test(`${file}: embedded SPEC matches ${specName}`, () => {
      const src = readFileSync(join(workflowsDir, file), 'utf8')
      const embeddedSpec = parseSpecFromJs(src)
      assert.ok(embeddedSpec, `${file}: no SPEC constant found`)

      const jsonSpec = JSON.parse(readFileSync(specPath, 'utf8'))

      // Compare name, description, phases, stages.
      assert.equal(embeddedSpec.name, jsonSpec.name, `${file}: SPEC.name mismatch`)
      assert.equal(embeddedSpec.description, jsonSpec.description, `${file}: SPEC.description mismatch`)
      // Phases: compare element-by-element ignoring key order. The
      // vm-parsed SPEC comes from another realm (createContext), so
      // deepStrict comparisons fail on cross-realm objects; serializing
      // with sorted keys removes the realm problem.
      assert.equal(embeddedSpec.phases.length, jsonSpec.phases.length, `${file}: SPEC.phases length mismatch`)
      for (let i = 0; i < embeddedSpec.phases.length; i++) {
        const ep = JSON.stringify(embeddedSpec.phases[i], Object.keys(embeddedSpec.phases[i]).sort())
        const jp = JSON.stringify(jsonSpec.phases[i], Object.keys(jsonSpec.phases[i]).sort())
        assert.equal(ep, jp, `${file}: SPEC.phases[${i}] mismatch`)
      }
      assert.ok(deepEqualIgnoringMeta(embeddedSpec.stages, jsonSpec.stages), `${file}: SPEC.stages mismatch`)
    })
  }
})

// ===========================================================================
// 2. Every tier in a spec exists in the adapter table.
// ===========================================================================
describe('spec tiers exist in the adapter table', () => {
  const specFiles = readdirSync(specsDir).filter((f) => f.endsWith('.spec.json'))

  test('spec file count matches workflow file count', () => {
    assert.equal(specFiles.length, WORKFLOW_FILES.length, `expected ${WORKFLOW_FILES.length} spec files, found ${specFiles.length}: ${specFiles.join(', ')}`)
  })

  for (const specFile of specFiles) {
    const spec = JSON.parse(readFileSync(join(specsDir, specFile), 'utf8'))

    test(`${specFile}: all phase tiers are valid`, () => {
      for (const phase of spec.phases) {
        assert.ok(
          VALID_TIERS.includes(phase.tier),
          `${specFile}: phase "${phase.title}" declares tier "${phase.tier}", not in adapter table (${VALID_TIERS.join(', ')})`
        )
      }
    })

    test(`${specFile}: all stage tiers are valid`, () => {
      for (const [name, stage] of Object.entries(spec.stages)) {
        assert.ok(
          VALID_TIERS.includes(stage.tier),
          `${specFile}: stage "${name}" declares tier "${stage.tier}", not in adapter table (${VALID_TIERS.join(', ')})`
        )
      }
    })

    test(`${specFile}: fallback tiers are valid`, () => {
      for (const [name, stage] of Object.entries(spec.stages)) {
        if (stage.fallback) {
          assert.ok(
            VALID_TIERS.includes(stage.fallback.from_tier),
            `${specFile}: stage "${name}" fallback.from_tier "${stage.fallback.from_tier}" is not in the adapter table`
          )
          assert.ok(
            VALID_TIERS.includes(stage.fallback.to_tier),
            `${specFile}: stage "${name}" fallback.to_tier "${stage.fallback.to_tier}" is not in the adapter table`
          )
        }
      }
    })
  }
})
