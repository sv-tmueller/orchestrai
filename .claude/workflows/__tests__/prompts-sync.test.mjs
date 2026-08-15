/**
 * Prompts sync test (issue #335).
 *
 * Asserts that the embedded PROMPTS constant in each workflow JS file
 * matches the corresponding JSON prompt file under prompts/. The JSON
 * file is the portable representation the Hermes renderer loads; the
 * embedded constant is what the Claude Code renderer uses at runtime
 * (the workflow runtime has no imports). This test catches drift between
 * the two, mirroring the SPEC sync technique from specs.test.mjs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')
const promptsDir = join(workflowsDir, 'prompts')

const WORKFLOW_FILES = [
  'tm-review-changes.js',
  'tm-review-codebase.js',
  'tm-map-codebase.js',
]

// ---------------------------------------------------------------------------
// Parse the PROMPTS object from a JS source file by brace-matching,
// mirroring parseSpecFromJs in specs.test.mjs. The PROMPTS const stores
// plain strings with {{slot}} markers, so it is evaluatable by node:vm
// with no runtime context (unlike template literals with ${expr}).
// ---------------------------------------------------------------------------
function parsePromptsFromJs(src) {
  const startIdx = src.indexOf('const PROMPTS = {')
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
  const promptsSrc = src.slice(startIdx, pos)
  const ctx = createContext({})
  runInContext(promptsSrc, ctx)
  return runInContext('PROMPTS', ctx)
}

// Serialize with sorted keys so cross-realm object identity does not
// trip deepStrict (same trick specs.test.mjs uses for phases).
function canon(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort())
}

// ===========================================================================
// 1. Embedded PROMPTS matches the JSON prompt file.
// ===========================================================================
describe('embedded PROMPTS matches JSON prompt file', () => {
  for (const file of WORKFLOW_FILES) {
    const promptsName = file.replace(/\.js$/, '.prompts.json')
    const promptsPath = join(promptsDir, promptsName)

    test(`${promptsName} exists`, () => {
      assert.ok(existsSync(promptsPath), `missing prompt file: ${promptsPath}`)
    })

    test(`${file}: embedded PROMPTS matches ${promptsName}`, () => {
      const src = readFileSync(join(workflowsDir, file), 'utf8')
      const embedded = parsePromptsFromJs(src)
      assert.ok(embedded, `${file}: no PROMPTS constant found`)
      assert.ok(
        typeof embedded === 'object' && embedded !== null,
        `${file}: PROMPTS is not an object`
      )

      const jsonPrompts = JSON.parse(readFileSync(promptsPath, 'utf8'))

      const ek = Object.keys(embedded).sort()
      const jk = Object.keys(jsonPrompts).sort()
      assert.deepEqual(ek, jk, `${file}: PROMPTS key set ${ek} != JSON key set ${jk}`)

      for (const key of ek) {
        assert.equal(
          typeof embedded[key],
          'string',
          `${file}: PROMPTS.${key} is not a string`
        )
        assert.equal(
          typeof jsonPrompts[key],
          'string',
          `${promptsName}: ${key} is not a string`
        )
        assert.equal(
          embedded[key],
          jsonPrompts[key],
          `${file}: PROMPTS.${key} != ${promptsName}:${key}`
        )
      }

      // Sanity: the canonical serialized forms match (catches nested
      // structural drift the per-key loop would miss, e.g. extra keys).
      assert.equal(canon(embedded), canon(jsonPrompts), `${file}: canonical mismatch`)
    })
  }
})

// ===========================================================================
// 2. Each template declares only known {{slot}} markers.
// ===========================================================================
describe('prompt slot declarations are correct', () => {
  const KNOWN_SLOTS = {
    'tm-review-changes.js': {
      review: ['brief', 'diffHint'],
      consolidate: ['coveredCount', 'coverageNote', 'diffHint', 'rawFindings'],
    },
    'tm-review-codebase.js': {
      scout: ['scope', 'root', 'maxAreas'],
      area_review: ['areaName', 'areaPaths', 'dimensions'],
      architecture_review: ['scope', 'repoMap'],
      consolidate: [
        'coverageNote', 'reviewedAreas', 'workersFailed',
        'ceilingReached', 'suggestedNextActionClause', 'rawFindings',
        'scoutDropped',
      ],
    },
    'tm-map-codebase.js': {
      scout: ['scope', 'root', 'maxAreas'],
      area_map: ['areaName', 'areaPaths', 'repoMap'],
      synthesize: [
        'coverageNote', 'mappedAreas', 'workersFailed',
        'ceilingReached', 'suggestedNextActionClause', 'rawFindings',
        'scoutDropped',
      ],
    },
  }

  for (const [file, expectedSlots] of Object.entries(KNOWN_SLOTS)) {
    test(`${file}: PROMPTS keys match expected stage names`, () => {
      const src = readFileSync(join(workflowsDir, file), 'utf8')
      const embedded = parsePromptsFromJs(src)
      assert.ok(embedded, `${file}: no PROMPTS constant`)
      assert.deepEqual(
        Object.keys(expectedSlots).sort(),
        Object.keys(embedded).sort(),
        `${file}: PROMPTS stage keys mismatch`
      )
    })

    for (const [stage, slots] of Object.entries(expectedSlots)) {
      test(`${file}: ${stage} template declares exactly ${slots.join(', ')}`, () => {
        const src = readFileSync(join(workflowsDir, file), 'utf8')
        const embedded = parsePromptsFromJs(src)
        assert.ok(embedded, `${file}: no PROMPTS constant`)
        const tmpl = embedded[stage]
        assert.ok(typeof tmpl === 'string', `${file}: PROMPTS.${stage} missing`)

        // Extract {{slot}} markers from the template.
        const found = [...tmpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
        const foundSorted = [...new Set(found)].sort()

        // Every declared slot must appear at least once.
        for (const s of slots) {
          assert.ok(
            found.includes(s),
            `${file}: ${stage} template is missing slot {{{${s}}}}`
          )
        }

        // No unexpected slots.
        for (const s of foundSorted) {
          assert.ok(
            slots.includes(s),
            `${file}: ${stage} template has unexpected slot {{{${s}}}}`
          )
        }
      })
    }
  }
})
