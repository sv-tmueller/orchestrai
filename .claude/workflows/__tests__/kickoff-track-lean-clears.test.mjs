/**
 * Pins the five places where tm-kickoff clears `track:lean` (issue #498,
 * follow-up to PR #495).
 *
 * The label must come off whenever a package ships, parks, or is resumed
 * after an interrupted ship. A reworded paragraph that drops the clear
 * leaves a stale label on the issue. There is one test per place, so a
 * failure names the place that lost it.
 *
 * Each place is found by an anchor phrase that is not part of the clear
 * itself. Dropping the clear then fails the `track:lean` assertion, not the
 * anchor lookup. Whitespace is collapsed first, so re-wrapping a line
 * cannot break the test.
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
