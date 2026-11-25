/**
 * Pins the thin Hermes kickoff skill (issue #605).
 *
 * SKILL.hermes.md runs the pipeline driver and reads its output back. It holds
 * no pipeline rule: the gate, the label block, the fix-round loop, the routing
 * and the definition of done live in hermes-pipeline.mjs, and
 * docs/architecture/hermes-adapter.md describes them. Nothing else checks the
 * skill text, so a rule that creeps back in would be a second copy that can
 * drift from the code.
 *
 * Two halves. The kept half fails if the driver command is missing, or if a
 * line the skill tells the lead to read no longer matches the driver (the
 * usage line, the report headings). The absent half has one generated test per
 * marker, and a marker is a word or phrase that only a pipeline rule carries:
 * the label block, the fix-round cap and the routing rules are the three
 * groups. A deliberate change to the skill means updating a marker, not
 * deleting the test.
 *
 * Whitespace is collapsed for the string markers, so re-wrapping a line cannot
 * break the test. The line-anchored patterns run on the raw text. The driver's
 * behaviour is covered in hermes-pipeline.test.mjs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { LABELS, USAGE, formatReport } from '../../adapters/hermes-pipeline.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const claudeDir = join(__dir, '..', '..')
const raw = readFileSync(join(claudeDir, 'skills', 'tm-kickoff', 'SKILL.hermes.md'), 'utf8')
const text = raw.replace(/\s+/g, ' ')

describe('thin Hermes kickoff skill: what it keeps', () => {
  test('it runs the driver in a dry run first, on its own line', () => {
    assert.match(raw, /^DRY_RUN=true node \.claude\/adapters\/hermes-pipeline\.mjs /m, 'the dry-run command line is missing')
  })

  test('it then runs the driver live, on its own line', () => {
    assert.match(raw, /^node \.claude\/adapters\/hermes-pipeline\.mjs /m, 'the live command line is missing')
  })

  test('the command it names is the one the driver prints in its usage line', () => {
    assert.ok(USAGE.startsWith('usage: node .claude/adapters/hermes-pipeline.mjs '), 'the driver usage line changed; update the skill and this test')
  })

  test('it points to the driver description, which exists', () => {
    assert.ok(text.includes('docs/architecture/hermes-adapter.md'), 'the skill must point to docs/architecture/hermes-adapter.md')
    assert.ok(existsSync(join(claudeDir, '..', 'docs', 'architecture', 'hermes-adapter.md')))
  })

  test('the table file it names for the OpenRouter variant exists', () => {
    assert.ok(text.includes('HERMES_ADAPTER_TABLE=hermes-openrouter.json'))
    assert.ok(existsSync(join(claudeDir, 'adapters', 'hermes-openrouter.json')))
  })

  test('it keeps the split proposal step, the lead step after a stop line', () => {
    assert.ok(text.includes('JOB: SPLIT_PROPOSAL'), 'the split-proposal job line is missing')
  })

  test('it names the two report headings the driver prints', () => {
    const lines = formatReport([], [])
    assert.equal(lines[0], '## What happened')
    assert.ok(lines.includes('## Next steps'))
    assert.ok(text.includes('## What happened'), 'the skill must name the first report heading')
    assert.ok(text.includes('## Next steps'), 'the skill must name the last report heading')
  })
})

// One entry per marker: [group, why it must stay out, pattern]. A string is a
// substring of the collapsed text, a regexp runs on the collapsed text unless
// its entry says raw.
const ABSENT = [
  // The label block: the driver creates the labels before the gate.
  ['label block', 'the skill makes no label write', 'label create'],
  ...LABELS.flatMap((l) => [
    ['label block', `the ${l.name} color is part of the label block`, new RegExp(l.color, 'i')],
    ['label block', `the ${l.name} description is part of the label block`, l.description],
  ]),

  // The fix-round cap: the driver counts rounds from the PR comments.
  ['fix-round cap', 'the skill describes no fix-round loop', /fix[ -]?rounds?/i],
  ['fix-round cap', 'the driver counts rounds as n/3; the skill quotes none', /\b\d+\/3\b/],
  ['fix-round cap', 'the cap is a constant of the driver', 'MAX_ROUNDS'],

  // The routing rules: the driver routes every report between the seats.
  ['routing rules', 'the skill states no routing rule', /routing rule/i],
  ['routing rules', 'the skill has no stage headings', /^#{1,6}[ \t]*Stage \d/m, 'raw'],
  ['routing rules', 'the skill dispatches only SPLIT_PROPOSAL, not a sub-plan', 'JOB: SUB_PLAN'],
  ['routing rules', 'the skill dispatches only SPLIT_PROPOSAL, not an arbitration', 'JOB: ARBITRATION'],
  ['routing rules', 'pushback is arbitrated inside the driver', /push(es|ed)?[ -]?back/i],
  ['routing rules', 'the no-unchanged-prompt rule is the driver\'s', 'unchanged prompt'],
  ['routing rules', 'the skill reads driver lines, not seat verdicts', 'CHANGES_REQUESTED'],
  ['routing rules', 'the skill reads driver lines, not seat reports', 'DONE_WITH_CONCERNS'],
  ['routing rules', 'the workers run through the adapter, not delegate_task', 'delegate_task'],
  ['routing rules', 'the skill\'s only write is gh issue comment, not an issue edit', 'gh issue edit'],
  ['routing rules', 'the skill\'s only write is gh issue comment, not a ready mark', 'gh pr ready'],
  ['routing rules', 'the skill\'s only write is gh issue comment, not a PR comment', 'gh pr comment'],
]

describe('thin Hermes kickoff skill: what it must not hold', () => {
  for (const [group, why, marker, mode] of ABSENT) {
    test(`${group}: ${why} (${marker instanceof RegExp ? marker : JSON.stringify(marker)})`, () => {
      const hit = marker instanceof RegExp ? (mode === 'raw' ? raw : text).match(marker) : text.includes(marker) ? [marker] : null
      assert.equal(hit, null, `${group} came back into the skill: ${why}. Found "${hit?.[0]}". The driver enforces this rule; remove it from the skill.`)
    })
  }
})
