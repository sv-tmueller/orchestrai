/**
 * Tests for inlined workflow helpers.
 *
 * Strategy: read each .js source as text, slice out the helper function by
 * name, and evaluate it in a node:vm context. This means the test runs the
 * ACTUAL inlined code with zero drift - no hand-copied version to maintain.
 *
 * Two targets are inline expressions (not extractable functions): the
 * covered/dropped partition in tm-review-changes.js and the scoutDropped
 * union in tm-review-codebase.js. Those are tested as logic kernels - the
 * test captures the expression's shape, not the real source text. This is
 * the one honest seam; it is documented below and called out in the PR.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import assertLoose from 'node:assert'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dir, '..')

// ---------------------------------------------------------------------------
// Helper: slice a named function out of a JS source file and evaluate it in a
// vm context. Returns the function value.
// ---------------------------------------------------------------------------
function loadFn(filename, fnName) {
  const src = readFileSync(join(workflowsDir, filename), 'utf8')
  // Match "function <fnName>(" - handles single-line bodies too.
  const startRe = new RegExp(`function ${fnName}\\s*\\(`)
  const startMatch = startRe.exec(src)
  if (!startMatch) throw new Error(`${fnName} not found in ${filename}`)

  // Walk forward from the opening brace to find the matching closing brace.
  let pos = startMatch.index
  let depth = 0
  let started = false
  while (pos < src.length) {
    if (src[pos] === '{') { depth++; started = true }
    if (src[pos] === '}') depth--
    pos++
    if (started && depth === 0) break
  }
  const fnSrc = src.slice(startMatch.index, pos)

  const ctx = createContext({})
  runInContext(fnSrc, ctx)
  return runInContext(fnName, ctx)
}

// ---------------------------------------------------------------------------
// Slice a named function's source text (for byte-identity assertions).
// ---------------------------------------------------------------------------
function sliceFnSrc(filename, fnName) {
  const src = readFileSync(join(workflowsDir, filename), 'utf8')
  const startRe = new RegExp(`function ${fnName}\\s*\\(`)
  const startMatch = startRe.exec(src)
  if (!startMatch) throw new Error(`${fnName} not found in ${filename}`)
  let pos = startMatch.index
  let depth = 0
  let started = false
  while (pos < src.length) {
    if (src[pos] === '{') { depth++; started = true }
    if (src[pos] === '}') depth--
    pos++
    if (started && depth === 0) break
  }
  return src.slice(startMatch.index, pos)
}

// ===========================================================================
// 1. safeRef
// ===========================================================================
describe('safeRef', () => {
  const safeRef = loadFn('tm-review-changes.js', 'safeRef')

  test('returns a valid ref unchanged', () => {
    assert.equal(safeRef('origin/main', 'fallback'), 'origin/main')
    assert.equal(safeRef('main', 'fallback'), 'main')
    assert.equal(safeRef('feat/68-foo', 'fallback'), 'feat/68-foo')
    assert.equal(safeRef('HEAD~3', 'fallback'), 'HEAD~3')
  })

  test('returns fallback for empty string', () => {
    assert.equal(safeRef('', 'fallback'), 'fallback')
  })

  test('returns fallback for null', () => {
    assert.equal(safeRef(null, 'fallback'), 'fallback')
  })

  test('returns fallback for undefined', () => {
    assert.equal(safeRef(undefined, 'fallback'), 'fallback')
  })

  test('returns fallback for non-string (number)', () => {
    assert.equal(safeRef(42, 'fallback'), 'fallback')
  })

  test('returns fallback for non-string (object)', () => {
    assert.equal(safeRef({}, 'fallback'), 'fallback')
  })

  // The .. case is the bug that motivated this issue.
  test('returns fallback for ".." (path traversal)', () => {
    assert.equal(safeRef('..', 'fallback'), 'fallback')
  })

  test('returns fallback for ref containing ".." as substring', () => {
    assert.equal(safeRef('origin..HEAD', 'fallback'), 'fallback')
  })

  test('returns fallback for shell metacharacter $', () => {
    assert.equal(safeRef('$HOME', 'fallback'), 'fallback')
  })

  test('returns fallback for shell metacharacter ;', () => {
    assert.equal(safeRef('ref;rm -rf .', 'fallback'), 'fallback')
  })

  test('returns fallback for shell metacharacter backtick', () => {
    assert.equal(safeRef('ref`cmd`', 'fallback'), 'fallback')
  })

  test('returns fallback for shell metacharacter &', () => {
    assert.equal(safeRef('ref&cmd', 'fallback'), 'fallback')
  })

  test('the two copies (tm-review-changes.js and tm-review-codebase.js) are byte-identical', () => {
    const a = sliceFnSrc('tm-review-changes.js', 'safeRef')
    const b = sliceFnSrc('tm-review-codebase.js', 'safeRef')
    assert.equal(a, b, 'safeRef diverged between the two workflow files')
  })

  test('the third copy (tm-map-codebase.js) is byte-identical to tm-review-codebase.js', () => {
    const a = sliceFnSrc('tm-review-codebase.js', 'safeRef')
    const b = sliceFnSrc('tm-map-codebase.js', 'safeRef')
    assert.equal(a, b, 'safeRef diverged in tm-map-codebase.js')
  })
})

// ===========================================================================
// 2. parseArgs (tm-review-codebase.js only)
// ===========================================================================
describe('parseArgs', () => {
  // parseArgs returns plain-data objects. Objects created inside the vm
  // context carry the vm's Object.prototype rather than the host's, so
  // assert.deepEqual (strict) rejects them. assertLoose.deepEqual uses
  // structural comparison and accepts them correctly.
  const parseArgs = loadFn('tm-review-codebase.js', 'parseArgs')

  test('returns an object argument unchanged', () => {
    const obj = { path: 'src', areas: 5 }
    assertLoose.deepEqual(parseArgs(obj), obj)
  })

  test('parses a valid JSON string', () => {
    assertLoose.deepEqual(parseArgs('{"path":"src","areas":5}'), { path: 'src', areas: 5 })
  })

  test('returns {} for an empty string', () => {
    assertLoose.deepEqual(parseArgs(''), {})
  })

  test('returns {} for a whitespace-only string', () => {
    assertLoose.deepEqual(parseArgs('   '), {})
  })

  test('returns {} for malformed JSON', () => {
    assertLoose.deepEqual(parseArgs('{bad json}'), {})
  })

  test('returns {} for null', () => {
    assertLoose.deepEqual(parseArgs(null), {})
  })

  test('returns {} for undefined', () => {
    assertLoose.deepEqual(parseArgs(undefined), {})
  })

  test('returns {} for a number', () => {
    assertLoose.deepEqual(parseArgs(42), {})
  })

  test('returns array for array input (object branch, no Array.isArray guard)', () => {
    // Arrays satisfy typeof === 'object', so parseArgs returns them as-is.
    // This documents the current behaviour; a future hardening may change it.
    const arr = [1, 2]
    assertLoose.deepEqual(parseArgs(arr), arr)
  })

  test('is byte-identical between tm-review-codebase.js and tm-map-codebase.js', () => {
    const a = sliceFnSrc('tm-review-codebase.js', 'parseArgs')
    const b = sliceFnSrc('tm-map-codebase.js', 'parseArgs')
    assert.equal(a, b, 'parseArgs diverged in tm-map-codebase.js')
  })
})

// ===========================================================================
// 3. MAX_AREAS coercion expression (tm-review-codebase.js line 49)
//
// The expression is:
//   Number.isInteger(opts.areas) && opts.areas > 0 ? opts.areas : 24
//
// NOTE: This is an inline expression, not an extractable function. This is a
// logic-test: the kernel matches the source expression but is not evaluated
// from the live source. See PR for rationale.
// ===========================================================================
describe('MAX_AREAS coercion logic', () => {
  function maxAreas(areas) {
    // Logic kernel of: tm-review-codebase.js line 49
    //   const MAX_AREAS = Number.isInteger(opts.areas) && opts.areas > 0 ? opts.areas : 24
    const opts = { areas }
    return Number.isInteger(opts.areas) && opts.areas > 0 ? opts.areas : 24
  }

  test('valid positive integer passes through', () => {
    assert.equal(maxAreas(5), 5)
    assert.equal(maxAreas(1), 1)
    assert.equal(maxAreas(100), 100)
  })

  test('0 falls back to 24', () => {
    assert.equal(maxAreas(0), 24)
  })

  test('negative falls back to 24', () => {
    assert.equal(maxAreas(-1), 24)
  })

  test('non-numeric string falls back to 24', () => {
    assert.equal(maxAreas('abc'), 24)
  })

  test('numeric string "5" falls back to 24 (not an integer per Number.isInteger)', () => {
    assert.equal(maxAreas('5'), 24)
  })

  test('float falls back to 24', () => {
    assert.equal(maxAreas(3.5), 24)
  })

  test('null falls back to 24', () => {
    assert.equal(maxAreas(null), 24)
  })

  test('undefined falls back to 24', () => {
    assert.equal(maxAreas(undefined), 24)
  })
})

// ===========================================================================
// 4a. covered/dropped partition (the covered/dropped partition after the
// Review phase, tm-review-changes.js)
//
// Logic kernel:
//   const covered = DIMENSIONS.filter((_, i) => reviews[i])
//   const dropped = DIMENSIONS.filter((_, i) => !reviews[i])
//
// NOTE: Inline expressions, not extractable functions. Logic-test only.
// See PR for rationale.
// ===========================================================================
describe('covered/dropped partition', () => {
  const DIMS = ['bugs', 'security', 'scope', 'tests', 'style']

  function partition(reviews) {
    // Logic kernel of the covered/dropped partition after the Review phase, tm-review-changes.js
    const covered = DIMS.filter((_, i) => reviews[i])
    const dropped = DIMS.filter((_, i) => !reviews[i])
    return { covered, dropped }
  }

  test('all present: all covered, none dropped', () => {
    const reviews = DIMS.map(() => ({ findings: [] }))
    const { covered, dropped } = partition(reviews)
    assert.deepEqual(covered, DIMS)
    assert.deepEqual(dropped, [])
  })

  test('all null: none covered, all dropped', () => {
    const reviews = DIMS.map(() => null)
    const { covered, dropped } = partition(reviews)
    assert.deepEqual(covered, [])
    assert.deepEqual(dropped, DIMS)
  })

  test('null hole at index 1 drops that dimension', () => {
    // reviews[1] is null -> 'security' drops
    const reviews = [{ findings: [] }, null, { findings: [] }, { findings: [] }, { findings: [] }]
    const { covered, dropped } = partition(reviews)
    assert.deepEqual(covered, ['bugs', 'scope', 'tests', 'style'])
    assert.deepEqual(dropped, ['security'])
  })

  test('null hole at index 4 (last) drops that dimension', () => {
    const reviews = [{ findings: [] }, { findings: [] }, { findings: [] }, { findings: [] }, null]
    const { covered, dropped } = partition(reviews)
    assert.deepEqual(covered, ['bugs', 'security', 'scope', 'tests'])
    assert.deepEqual(dropped, ['style'])
  })
})

// ===========================================================================
// 4b. scoutDropped union (tm-review-codebase.js lines 172-174)
//
// Logic kernel:
//   const scriptOverflow = allAreas.slice(MAX_AREAS).map((a) => a.name)
//   const scoutSelfDropped = scoutFailed ? [] : Array.isArray(map.dropped) ? map.dropped : []
//   const scoutDropped = scoutSelfDropped.concat(scriptOverflow)
//
// NOTE: Inline expressions, not extractable functions. Logic-test only.
// See PR for rationale.
// ===========================================================================
describe('scoutDropped union', () => {
  function buildScoutDropped({ allAreas, maxAreas, scoutFailed, mapDropped }) {
    // Logic kernel of: tm-review-codebase.js lines 172-174
    const scriptOverflow = allAreas.slice(maxAreas).map((a) => a.name)
    const scoutSelfDropped = scoutFailed ? [] : Array.isArray(mapDropped) ? mapDropped : []
    const scoutDropped = scoutSelfDropped.concat(scriptOverflow)
    return scoutDropped
  }

  const area = (name) => ({ name })

  test('neither overflow nor self-dropped: empty union', () => {
    const result = buildScoutDropped({
      allAreas: [area('a'), area('b')],
      maxAreas: 5,
      scoutFailed: false,
      mapDropped: [],
    })
    assert.deepEqual(result, [])
  })

  test('self-dropped only: union equals self-dropped', () => {
    const result = buildScoutDropped({
      allAreas: [area('a')],
      maxAreas: 5,
      scoutFailed: false,
      mapDropped: ['x', 'y'],
    })
    assert.deepEqual(result, ['x', 'y'])
  })

  test('overflow only: union equals overflow names in order', () => {
    const result = buildScoutDropped({
      allAreas: [area('a'), area('b'), area('c')],
      maxAreas: 1,
      scoutFailed: false,
      mapDropped: [],
    })
    assert.deepEqual(result, ['b', 'c'])
  })

  test('both: self-dropped comes first, then overflow', () => {
    const result = buildScoutDropped({
      allAreas: [area('a'), area('b'), area('c')],
      maxAreas: 1,
      scoutFailed: false,
      mapDropped: ['x'],
    })
    // scoutSelfDropped ['x'] concat scriptOverflow ['b','c'] -> ['x','b','c']
    assert.deepEqual(result, ['x', 'b', 'c'])
  })

  test('scout failed: self-dropped is empty even if map.dropped has content', () => {
    const result = buildScoutDropped({
      allAreas: [],
      maxAreas: 5,
      scoutFailed: true,
      mapDropped: ['x', 'y'],
    })
    assert.deepEqual(result, [])
  })

  test('map.dropped is not an array when scout did not fail: treated as empty', () => {
    const result = buildScoutDropped({
      allAreas: [],
      maxAreas: 5,
      scoutFailed: false,
      mapDropped: null,
    })
    assert.deepEqual(result, [])
  })
})
