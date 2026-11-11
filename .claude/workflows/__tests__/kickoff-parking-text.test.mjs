/**
 * Pins the text tm-kickoff posts on the issue when a repair parks a PR
 * (issue #525, batch #520).
 *
 * A parked repair stays with the owner. The text says the pipeline posts no
 * more verdicts on it, and points to `/tm-repo-guard statuses <repo> <pr>`,
 * which prints the commands that record both verdicts and queue the merge. The
 * guard runs none of them and neither does the lead. Eight clauses carry that.
 * Each is pinned as an exact phrase. One guard test fails if the old claim
 * "for you" comes back anywhere in the step. One cross-check calls the real
 * guard with no arguments, so the command named in the text keeps the usage
 * the text relies on.
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
import { runStatuses } from '../../skills/tm-repo-guard/repo-guard.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const skillPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'SKILL.md')

const text = readFileSync(skillPath, 'utf8').replace(/\s+/g, ' ')

const START = '3. Post on the issue: `Parked: PR #<pr>: <reason>.`'
const END = '4. Apply the routing rules\' "Parking" step'
const COMMAND = '`/tm-repo-guard statuses <repo> <pr>`'

const PINS = [
  ['the pipeline does not pick the PR up again and posts no more verdicts',
    'The pipeline does not pick this PR up again, and it posts no more verdicts on it.'],
  ['the owner brings the branch up to date and merges it',
    'To finish it, bring the branch up to date and merge it yourself.'],
  ['the merge needs both statuses as success on the new head',
    'The merge needs `orchestrai/test` and `orchestrai/review` as `success` on the new head.'],
  ['the guard prints the commands and runs none of them',
    `${COMMAND} prints the commands that record both verdicts on that head and queue the merge; it runs none of them.`],
  ['the owner runs the commands in their own shell after checking the head',
    'Run them yourself, in your own shell, and only once you have checked the new head: they record that you verified and reviewed it.'],
  ['the command is run again after a later push',
    'After any later push, run the command again.'],
  ['the lead fills in the repo and the PR number, with a fallback',
    'In that text `<pr>` is the PR number and `<repo>` is what `gh repo view --json nameWithOwner --jq .nameWithOwner` prints; if that read fails, post `<repo>` as it is.'],
  ['the lead never runs the guard or a command it prints',
    'The lead never runs `/tm-repo-guard statuses` or a command it prints.'],
]

function once(anchor) {
  const count = text.split(anchor).length - 1
  assert.equal(count, 1, `anchor "${anchor}" not found or not unique (${count} hits); update the anchor to the reworded text`)
  return text.indexOf(anchor)
}

function step3() {
  const from = once(START)
  const to = once(END)
  assert.ok(from < to, `anchor "${START}" does not come before "${END}"; update the anchor to the reworded text`)
  return text.slice(from, to)
}

for (const [name, phrase] of PINS) {
  test(name, () => {
    assert.ok(step3().includes(phrase), `between "${START}" and "${END}" the text no longer contains: ${phrase}`)
  })
}

test('nothing in the step says something posts the verdicts for you', () => {
  assert.doesNotMatch(step3(), /for you/i)
})

test('the guard answers the bare command with its usage line, before any gh call', () => {
  const run = () => { throw new Error('no gh call expected') }
  assert.deepEqual(runStatuses(run, []), {
    code: 2,
    text: 'usage: repo-guard.mjs statuses <repo> <pr>\n',
  })
})

test('the step names the command the guard accepts', () => {
  assert.ok(step3().includes(COMMAND), `the step no longer contains ${COMMAND}`)
})
