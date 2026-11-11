/**
 * Pins how tm-new-project hands the owner the guard command (issue #507,
 * follow-up to PR #506).
 *
 * The skill never runs `/tm-repo-guard`. It prints the command with the
 * repo's full name filled in, and the owner types it. Four clauses carry
 * that claim: section 1 names both uses of the full name, the Already set up
 * report prints the command, section 4 prints it with the name filled in, and
 * section 5 says the skill never runs the guard. Each clause is pinned as an
 * exact phrase, so a clause swapped for its opposite fails.
 *
 * Each pin is searched between a start anchor and an end anchor (`null` means
 * end of file), so a phrase that moves to the wrong section fails too.
 * Whitespace is collapsed first, so re-wrapping a line cannot break the test.
 * A deliberate rewording means updating the pin.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const skillPath = join(__dir, '..', '..', 'skills', 'tm-new-project', 'SKILL.md')

const text = readFileSync(skillPath, 'utf8').replace(/\s+/g, ' ')

const PINS = [
  ['section 1 names both uses of the full name', '## 1. Detect state', '**Already set up:**',
    "The repo's full name, for the guard command (the Already set up report and section 4): `gh repo view --json nameWithOwner -q .nameWithOwner`."],
  ['the Already set up report prints the guard command', '**Already set up:**', 'Otherwise, continue through sections 2-4',
    'Merge rule: not checked here. Type /tm-repo-guard apply <owner>/<name> to check and apply it.'],
  ['section 4 prints the guard command with the name filled in', '## 4. Print human-only steps', '## 5. Report',
    "the owner types: /tm-repo-guard apply <owner>/<name> with this repo's full name from section 1 filled in."],
  ['the skill never runs the guard itself', '## 5. Report', null,
    'It never runs `/tm-repo-guard`, `repo-guard.mjs` or its `--confirm` step either: it prints the command and the owner types it.'],
]

function once(anchor) {
  const count = text.split(anchor).length - 1
  assert.equal(count, 1, `anchor "${anchor}" not found or not unique (${count} hits); update the anchor to the reworded text`)
  return text.indexOf(anchor)
}

for (const [name, start, end, phrase] of PINS) {
  test(name, () => {
    const from = once(start)
    let to = text.length
    if (end !== null) {
      to = once(end)
      assert.ok(from < to, `anchor "${start}" does not come before "${end}"; update the anchor to the reworded text`)
    }
    const section = text.slice(from, to)
    assert.ok(section.includes(phrase), `between "${start}" and "${end}" the text no longer contains: ${phrase}`)
  })
}
