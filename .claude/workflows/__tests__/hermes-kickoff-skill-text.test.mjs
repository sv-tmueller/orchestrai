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
 *
 * The skill also carries one command of its own, the split proposal. A third
 * half takes it out of the skill text and runs it against a stand-in for the
 * hermes binary, one case per reply, because its accept rule is code.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { LABELS, USAGE, formatReport } from '../../adapters/hermes-pipeline.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const claudeDir = join(__dir, '..', '..')
const raw = readFileSync(join(claudeDir, 'skills', 'tm-kickoff', 'SKILL.hermes.md'), 'utf8')
const text = raw.replace(/\s+/g, ' ')
const repoRoot = join(claudeDir, '..')

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

  test('it asks the user whether to run after the dry run', () => {
    assert.ok(text.includes('ask whether to run'), 'the dry-run confirmation question is missing')
  })

  test('it forbids the OpenRouter variant on a customer repo', () => {
    assert.ok(text.includes('Never do that on a customer repo'))
  })

  test('it checks for an existing split proposal before asking for one', () => {
    assert.match(raw, /select\(startswith\("SPLIT_PROPOSAL"\)\)/)
  })

  test('its one write is a split-proposal comment posted from a file', () => {
    assert.ok(text.includes('gh issue comment <n> --body-file'))
  })

  test('it lists the three exit codes of the driver', () => {
    for (const code of [0, 1, 2]) assert.match(raw, new RegExp(`^- ${code}:`, 'm'), `the exit code ${code} bullet is missing`)
  })

  test('it says what to do when the driver file is not in the repo', () => {
    assert.ok(text.includes('`.claude/adapters/hermes-pipeline.mjs` is not there'))
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

// The split-proposal command, as the skill carries it: a fenced block that
// starts with `node --input-type=module -e '`, the script between the single
// quotes, then the task text in double quotes.
function splitCommand() {
  const block = raw.match(/^([ \t]*)```\n\1node --input-type=module -e '([^']*)' "([^"]*)"\n\1```$/m)
  assert.ok(block, 'the split-proposal command block is missing from the skill')
  const [, indent, script, task] = block
  const dedent = (str) => str.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n')
  return { script, task: dedent(task).replace('<n>', '605') }
}

describe('thin Hermes kickoff skill: the split-proposal command', () => {
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-split-stub-'))
    writeFileSync(join(dir, 'hermes-stub.sh'), '#!/bin/sh\nd=$(dirname "$0")\ncat "$d/reply.txt"\nexit "$(cat "$d/code")"\n')
    chmodSync(join(dir, 'hermes-stub.sh'), 0o755)
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  // Runs the command as the lead would, with the stand-in as the hermes binary.
  // DRY_RUN and the table choice are removed from the environment so the real
  // path runs, and the stand-in answers instead of a model.
  function run(reply, code = 0) {
    writeFileSync(join(dir, 'reply.txt'), reply)
    writeFileSync(join(dir, 'code'), String(code))
    const { script, task } = splitCommand()
    const env = { ...process.env, HERMES_BIN: join(dir, 'hermes-stub.sh') }
    delete env.DRY_RUN
    delete env.HERMES_ADAPTER_TABLE
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, task], { cwd: repoRoot, env, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.error, undefined, `the command did not run: ${r.error}`)
    return r
  }

  const PROPOSAL = 'SPLIT_PROPOSAL\n\nPart 1: the table.\nPart 2: the adapter.\n'

  test('a proposal with a body prints trimmed and exits 0', () => {
    const r = run(PROPOSAL)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `${PROPOSAL.trim()}\n`)
    assert.ok(r.stdout.startsWith('SPLIT_PROPOSAL'))
  })

  test('leading blank lines and spaces are trimmed, so the check for an existing proposal finds it', () => {
    const r = run(`\n\n  ${PROPOSAL}`)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.startsWith('SPLIT_PROPOSAL'), `stdout starts with ${JSON.stringify(r.stdout.slice(0, 20))}`)
  })

  test('a one-line proposal after a colon is accepted', () => {
    const r = run('SPLIT_PROPOSAL: split it in two\n')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'SPLIT_PROPOSAL: split it in two\n')
  })

  test('a bare SPLIT_PROPOSAL with no body exits 1 and prints nothing', () => {
    const r = run('SPLIT_PROPOSAL\n')
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
  })

  test('SPLIT_PROPOSAL: with no body exits 1 and prints nothing', () => {
    const r = run('SPLIT_PROPOSAL:\n')
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
  })

  test('a SUB_PLAN reply exits 1, prints nothing and leaves the reply on stderr', () => {
    const r = run('SUB_PLAN\n\nApproach: extend the table.\n')
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes('Approach: extend the table.'), r.stderr)
  })

  test('a kind that comes only from a trailing json block is refused', () => {
    const r = run('Here is my proposal for the split.\n\n```json\n{"KIND":"SPLIT_PROPOSAL"}\n```\n')
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
  })

  test('an empty reply exits 1 with no report on stderr', () => {
    const r = run('')
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes('no report'), r.stderr)
  })

  test('a stand-in that exits 3 gives exit 1 and prints nothing', () => {
    const r = run(PROPOSAL, 3)
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
  })

  test('the check for an existing proposal and the command rule start with the same word', () => {
    const word = raw.match(/select\(startswith\("(\w+)"\)\)/)?.[1]
    const rule = splitCommand().script.match(/\/\^(\w+)/)?.[1]
    assert.ok(word, 'the existing-proposal check is missing')
    assert.equal(rule, word, 'the command must accept the word the existing-proposal check looks for')
  })
})
