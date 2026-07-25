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
 *
 * loadFn() accepts an optional sandbox object so a function whose free
 * variables are workflow runtime globals (agent, log) can be run with stub
 * implementations instead of throwing ReferenceError.
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
function loadFn(filename, fnName, sandbox = {}) {
  const src = readFileSync(join(workflowsDir, filename), 'utf8')
  // Match "function <fnName>(", optionally preceded by "async" - handles
  // single-line bodies too. The async keyword must stay inside the slice, or
  // runInContext throws on the function's first await.
  const startRe = new RegExp(`(?:async\\s+)?function ${fnName}\\s*\\(`)
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

  const ctx = createContext(sandbox)
  runInContext(fnSrc, ctx)
  return runInContext(fnName, ctx)
}

// ---------------------------------------------------------------------------
// Slice a named function's source text (for byte-identity assertions).
// ---------------------------------------------------------------------------
function sliceFnSrc(filename, fnName) {
  const src = readFileSync(join(workflowsDir, filename), 'utf8')
  const startRe = new RegExp(`(?:async\\s+)?function ${fnName}\\s*\\(`)
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

// ===========================================================================
// 5. criticWithFallback (issue #267)
//
// The helper's only free variables are the workflow runtime globals `agent`
// and `log`. Supplying stubs as the vm sandbox runs the actual shipped code,
// not a hand-copied version.
// ===========================================================================
describe('criticWithFallback', () => {
  const FILES = ['tm-review-changes.js', 'tm-review-codebase.js', 'tm-map-codebase.js']
  const baseOpts = { label: 'consolidate', phase: 'Consolidate', model: 'fable', effort: 'xhigh', schema: { type: 'object' } }

  test('happy path: first agent call succeeds, result returned unchanged', async () => {
    const calls = []
    const logs = []
    const sandbox = {
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts })
        return { verdict: 'approve' }
      },
      log: (msg) => logs.push(msg),
    }
    const criticWithFallback = loadFn('tm-review-changes.js', 'criticWithFallback', sandbox)

    const result = await criticWithFallback('the prompt', baseOpts)

    assert.deepEqual(result, { verdict: 'approve' })
    assert.equal(calls.length, 1)
    assert.equal(logs.length, 0)
    assert.equal('modelFallback' in result, false)
  })

  test('first call returns null, retries on opus and succeeds', async () => {
    const calls = []
    const logs = []
    const sandbox = {
      agent: async (prompt, opts) => {
        calls.push({ prompt, opts })
        return calls.length === 1 ? null : { verdict: 'approve' }
      },
      log: (msg) => logs.push(msg),
    }
    const criticWithFallback = loadFn('tm-review-changes.js', 'criticWithFallback', sandbox)

    const result = await criticWithFallback('the prompt', baseOpts)

    assert.equal(calls.length, 2)
    const secondOpts = calls[1].opts
    assert.equal(secondOpts.model, 'opus')
    assert.equal(secondOpts.effort, baseOpts.effort)
    assert.equal(secondOpts.label, baseOpts.label)
    assert.equal(secondOpts.phase, baseOpts.phase)
    assert.equal(secondOpts.schema, baseOpts.schema)
    assert.ok(calls[1].prompt.includes('the prompt'), 'second prompt still carries the original prompt')
    assert.ok(calls[1].prompt.length > 'the prompt'.length, 'second prompt carries an added notice')
    assert.equal(result.verdict, 'approve')
    assert.equal(result.modelFallback, 'fable -> opus')
    assert.ok(logs.length >= 1, 'log() must be called to surface the fallback')
  })

  test('both calls return null: throws naming the label and both models', async () => {
    const sandbox = {
      agent: async () => null,
      log: () => {},
    }
    const criticWithFallback = loadFn('tm-review-changes.js', 'criticWithFallback', sandbox)

    let threw = null
    try {
      await criticWithFallback('the prompt', baseOpts)
    } catch (err) {
      threw = err
    }
    assert.ok(threw, 'expected criticWithFallback to throw when both attempts return null')
    // vm-realm errors are not `instanceof` the host's Error, so assert on the
    // message rather than the error's prototype chain.
    assert.match(threw.message, /consolidate/)
    assert.match(threw.message, /fable/)
    assert.match(threw.message, /opus/)
  })

  test('is byte-identical across all three workflow files', () => {
    const a = sliceFnSrc('tm-review-changes.js', 'criticWithFallback')
    const b = sliceFnSrc('tm-review-codebase.js', 'criticWithFallback')
    const c = sliceFnSrc('tm-map-codebase.js', 'criticWithFallback')
    assert.equal(a, b, 'criticWithFallback diverged between tm-review-changes.js and tm-review-codebase.js')
    assert.equal(b, c, 'criticWithFallback diverged between tm-review-codebase.js and tm-map-codebase.js')
  })

  test('every workflow file wires the critic call through criticWithFallback', () => {
    // Assert on 'await criticWithFallback(', not the bare function name: the
    // declaration line ('async function criticWithFallback(...') also matches
    // the bare name, so that substring is present even if the call site were
    // reverted to `await agent(`. The declaration has no `await`, so this
    // string only matches an actual call.
    for (const file of FILES) {
      const src = readFileSync(join(workflowsDir, file), 'utf8')
      assert.ok(src.includes('await criticWithFallback('), `${file} does not call criticWithFallback(`)
    }
  })
})
