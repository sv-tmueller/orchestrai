/**
 * Pins the places where tm-kickoff clears and sets `track:lean` (issues
 * #498 and #523, follow-ups to PR #495). The label is on an issue exactly
 * while its package runs the lean track.
 *
 * The label must come off whenever a package ships, parks, switches to the
 * full track, or is resumed after an interrupted ship. It must go back on
 * when a lean package re-enters a stage on resume or starts a repair
 * conflict path. A reworded paragraph that drops one of these leaves a
 * stale or a missing label. There is one test per place, so a failure names
 * the place that lost it.
 *
 * The five older clears are found by an anchor phrase that is not part of
 * the clear itself. Dropping the clear then fails the `track:lean`
 * assertion, not the anchor lookup. That check lets a partial inversion
 * ("do not remove") pass, so the places added by #523 pin their exact
 * clause inside their passage instead. Whitespace is collapsed first, so
 * re-wrapping a line cannot break the test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const skillPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'SKILL.md')

const text = readFileSync(skillPath, 'utf8').replace(/\s+/g, ' ')
const sentences = text.split(/(?<=\.) /)

const PLACES = [
  ['resume of an interrupted step 7', 'Classify it the same way'],
  ['stage-label rule in section 3', 'when the package ships (step 7) or parks'],
  ['step 7 sub-step 7', 'post a summary comment on the issue'],
  ['routing rules, Parking', 'Parking: post the reason on the issue'],
  ['repair, Parking step', `Apply the routing rules' "Parking" step`],
]

for (const [place, anchor] of PLACES) {
  test(`${place} clears track:lean`, () => {
    const count = text.split(anchor).length - 1
    assert.equal(count, 1, `anchor "${anchor}" not found or not unique (${count} hits); update it to the reworded text`)
    const hits = sentences.filter((s) => s.includes(anchor))
    assert.equal(hits.length, 1, `anchor "${anchor}" spans a sentence break; update it to the reworded text`)
    assert.ok(hits[0].includes('`track:lean`'), `sentence no longer mentions track:lean: ${hits[0]}`)
    assert.match(hits[0], /\b(remove|off)\b/i, `sentence mentions track:lean but does not clear it: ${hits[0]}`)
  })
}

// [place, what it does, passage start, next passage start, exact clause]
const CLAUSES = [
  [
    'Diff check, switch to full',
    'clears',
    ' - **Diff check.** ',
    ' - **Review.** ',
    'when the lean check broke it, remove `track:lean`, and continue on the full track from step 3 (tester).',
  ],
  [
    'gate, Resume detection',
    'sets',
    ' - Resume detection: ',
    ' - Remote resume: ',
    'Whenever a lean package re-enters a stage on resume, the owed Opus review above included, set `track:lean` on the issue first: parking and step 7 take it off.',
  ],
  [
    'repair, conflict path step 3',
    'sets',
    ' **Conflict path.** ',
    ' **Count.** ',
    'label the issue `in-progress` and `phase:developer`, plus `track:lean` for a lean package (a `Track: lean` comment and no later `Track: full` comment).',
  ],
]

for (const [place, verb, start, end, clause] of CLAUSES) {
  test(`${place} ${verb} track:lean`, () => {
    const from = text.indexOf(start)
    assert.notEqual(from, -1, `passage start "${start}" not found; update it to the reworded text`)
    assert.equal(text.indexOf(start, from + 1), -1, `passage start "${start}" is not unique`)
    const to = text.indexOf(end, from + start.length)
    assert.notEqual(to, -1, `passage end "${end}" not found after "${start}"`)
    assert.ok(text.slice(from, to).includes(clause), `missing from ${place}: ${clause}`)
  })
}
