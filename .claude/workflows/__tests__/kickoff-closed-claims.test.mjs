/**
 * Pins how tm-kickoff treats an untested claim the review closes with a reason
 * (issue #522, batch #520).
 *
 * The reviewer answers each forwarded claim under `CLAIMS`: `<n>. closed:
 * <reason>` or `<n>. finding <k>`. On a set-up repo only a `closed:` line with
 * a reason in the approving review closes a claim. A closed claim is listed in
 * the summary and never filed. Every other claim is open and goes into the
 * follow-up issue, as today. Fourteen clauses carry that rule. Each is pinned
 * as an exact phrase, so a clause swapped for its opposite fails. Five pins
 * guard text that must not change: the not-set-up wording and the nit rules.
 *
 * Each pin is searched between a start anchor and an end anchor, so a phrase
 * that moves to the wrong place fails too. Whitespace is collapsed first, so
 * re-wrapping a line cannot break the test. A deliberate rewording means
 * updating the pin.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const skillPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'SKILL.md')

const text = readFileSync(skillPath, 'utf8').replace(/\s+/g, ' ')

const S5 = "5. On PASS: post the tester's report as a PR comment"
const S6 = '6. On CHANGES_REQUESTED: post the report as a PR comment'
const SUB7 = 'Whether the repo is set up is decided from the reads of sub-step 2'
const OUT = 'Add one outcome line.'
const OPEN = '**Open.**'
const CLOSED = '**Closed.**'
const NOTHING = '**Nothing open.**'
const ONE = '**One per package.**'

const PINS = [
  ['step 5 forwards the claims to the reviewer', S5, S6,
    "then dispatch the reviewer with the PR, the issue number, and the tester's UNTESTED CLAIMS, if any."],
  ['step 5 numbers the forwarded claims', S5, S6,
    "Number the forwarded claims in the tester's order, here and on every re-review, so the reviewer's `CLAIMS` lines map to them by number."],
  ['a repo that is not set up keeps its wording', SUB7, OUT,
    'On a repo that is not set up, include should-fix findings and untested claims for the human review.'],
  ['a set-up repo files only the open claims', SUB7, OUT,
    'file the open should-fix findings and open untested claims as one follow-up issue (below)'],
  ['a closed claim is listed in the summary and never filed', SUB7, OUT,
    "On a set-up repo, also list each closed untested claim (below) in the summary, verbatim from the tester report, with the reviewer's reason; a closed claim is never filed."],
  ['nits are listed in the summary and never filed', SUB7, OUT,
    "also list the approving review's nits in the summary; nits are never filed."],
  ['claims come from the last tester PASS only', OPEN, CLOSED,
    'Untested claims come from the last tester PASS only, so the lean track has none.'],
  ['ratings come from the approving review only', OPEN, CLOSED,
    'Their ratings come from the `CLAIMS` lines of the approving review this step ships on; ratings from earlier review rounds do not count.'],
  ['a claim that points to a should-fix finding is filed once, as that finding', OPEN, CLOSED,
    'A claim whose line names a should-fix finding of that review (`<n>. finding <k>`) goes in once, as that finding.'],
  ['any other claim is open and goes in as an untested claim', OPEN, CLOSED,
    'Any other claim that review does not close (below) goes in as an untested claim: no line for its number, `closed:` with no reason, a pointer to a nit or to a missing finding, or any other wording.'],
  ['nits never go into the follow-up issue', OPEN, CLOSED,
    'Nits never go in.'],
  ['only a closed line with a reason closes a claim', CLOSED, NOTHING,
    'A claim whose line in the approving review reads `<n>. closed: <reason>`, with a reason after the colon, is closed.'],
  ['a closed claim is listed with its reason and never filed', CLOSED, NOTHING,
    'It is listed in the summary with that reason and never filed.'],
  ['closed claims alone file nothing', NOTHING, ONE,
    'File nothing, even when the summary lists closed untested claims.'],
  ['the follow-up block is for a set-up repo only', OUT, OPEN,
    'The follow-up issue (set-up repo only):'],
  ['Follow-up: none is for when nothing is open', SUB7, OUT,
    'then put `Follow-up: #<m>` in the summary, or `Follow-up: none` when nothing is open.'],
]

function once(anchor) {
  const count = text.split(anchor).length - 1
  assert.equal(count, 1, `anchor "${anchor}" not found or not unique (${count} hits); update the anchor to the reworded text`)
  return text.indexOf(anchor)
}

for (const [name, start, end, phrase] of PINS) {
  test(name, () => {
    const from = once(start)
    const to = once(end)
    assert.ok(from < to, `anchor "${start}" does not come before "${end}"; update the anchor to the reworded text`)
    const section = text.slice(from, to)
    assert.ok(section.includes(phrase), `between "${start}" and "${end}" the text no longer contains: ${phrase}`)
  })
}
