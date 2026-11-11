/**
 * Pins the tm-kickoff text around the lean check (issue #510, follow-up to
 * PR #509).
 *
 * The skill tells the lead which command to run and what to do with the
 * answer. Two things can drift without a test failing: the command in the
 * skill can stop matching the flags the script accepts, and a reworded
 * clause can flip what the lead does with the answer.
 *
 * The first test runs the script with the flags the skill names. The other
 * tests pin one exact clause each, scoped to its bullet, so a failure names
 * the clause that changed. Whitespace is collapsed first, so re-wrapping a
 * line cannot break a test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const __dir = dirname(fileURLToPath(import.meta.url))
const claudeDir = join(__dir, '..', '..')
const skillPath = join(claudeDir, 'skills', 'tm-kickoff', 'SKILL.md')

const text = readFileSync(skillPath, 'utf8').replace(/\s+/g, ' ')

// The text of one top-level bullet, from its bold label to the next bullet.
function bullet(label) {
  const marker = ` - **${label}.** `
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `bullet "${label}" not found`)
  assert.equal(text.indexOf(marker, start + 1), -1, `bullet "${label}" is not unique`)
  const end = text.indexOf(' - **', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

test('Lean check: the command the skill gives is one the script accepts', () => {
  const leanCheck = bullet('Lean check')
  const match = leanCheck.match(/`node "\$\{CLAUDE_PLUGIN_ROOT:-\.claude\}\/([^"]+)" ([^`]+)`/)
  assert.ok(match, 'the node command span was not found in the Lean check bullet')

  const script = join(claudeDir, match[1])
  const tokens = match[2].split(' ')
  assert.equal(tokens.length % 2, 0, `flags are not in flag/value pairs: ${match[2]}`)
  const pairs = []
  for (let i = 0; i < tokens.length; i += 2) pairs.push([tokens[i], tokens[i + 1]])

  // `unknown` for the ref keeps git out of the run, so cwd does not matter.
  const concrete = (v) => (v === '<n>' ? '2' : v === 'origin/<default>' ? 'unknown' : v)
  const base = pairs.map(([flag, value]) => [flag, concrete(value.split('|')[0])])

  for (let k = 0; k < pairs.length; k++) {
    for (const choice of pairs[k][1].split('|')) {
      const argv = base.flatMap(([flag, value], j) => [flag, j === k ? concrete(choice) : value])
      const r = spawnSync(process.execPath, [script, ...argv], { cwd: tmpdir(), encoding: 'utf8' })
      assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
      assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['allowed', 'reason'], argv.join(' '))
    }
  }

  assert.ok(leanCheck.includes('prints `{ allowed, reason }`'), 'the output shape is not named')
})

// The skill holds no copy of the script's reason strings. It hands the
// script's `reason` through, and adds one literal fallback of its own.
const CLAUSES = [
  [
    'Lean check',
    'a read that fails or prints `null` is passed as `unknown` and counts as set up',
  ],
  ['Lean check', 'Pass `--default-ref unknown` when the first read or the fetch failed'],
  [
    'Lean check',
    "When `allowed` is false the package runs full with the script's `reason`; a nonzero exit runs full with the reason `lean-allowed error`",
  ],
  [
    'Track comment',
    'For a lean package, run the lean check first. If it allows the lean track, post `Track: lean - ',
  ],
  [
    'Track comment',
    "If it does not, post `Track: full - <the lean check's reason>` instead, set no label",
  ],
  [
    'Diff check',
    'Before every lean reviewer dispatch (after DONE or DONE_WITH_CONCERNS, after each fix round, and on resume)',
  ],
  ['Diff check', 'if the paths still pass, run the lean check'],
  ['Diff check', "or `Track: full - <the lean check's reason>` when the lean check broke it"],
]

for (const [label, clause] of CLAUSES) {
  test(`${label}: ${clause.slice(0, 60)}`, () => {
    assert.ok(bullet(label).includes(clause), `missing from "${label}": ${clause}`)
  })
}
