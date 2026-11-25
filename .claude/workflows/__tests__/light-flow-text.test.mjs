/**
 * Pins the light flow doc (docs/architecture/light-flow.md), the one source
 * the Claude kickoff and advisor skills and the Hermes driver follow, and
 * the two Claude skills that implement it.
 *
 * The pins cover the parts that must not drift: the section headings other
 * files link to, the review gate, the fix-round cap, the issue body
 * template, the merge gate and the behind-main rule. Whitespace is collapsed
 * first, so re-wrapping a line cannot break a pin.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const docPath = join(__dir, '..', '..', '..', 'docs', 'architecture', 'light-flow.md')
const skillsDir = join(__dir, '..', '..', 'skills')

const RISKY_PATHS = [
  '.claude/agents',
  '.claude/skills',
  '.claude/workflows',
  '.github/workflows',
]

describe('light flow doc', () => {
  const raw = readFileSync(docPath, 'utf8')
  const text = raw.replace(/\s+/g, ' ')

  test('has the six sections', () => {
    for (const heading of [
      '## Advisor',
      '## Issue body',
      '## Kickoff',
      '## Review gate',
      '## Merge gate',
      '## Resume',
    ]) {
      assert.ok(
        raw.split('\n').some((line) => line.trim() === heading),
        `missing heading ${heading}`
      )
    }
  })

  test('states the review gate', () => {
    assert.ok(text.includes('size:M'), 'size:M')
    for (const path of [
      '.claude/agents',
      '.claude/skills',
      '.claude/workflows',
      '.github/workflows',
      'dependency manifest',
    ]) {
      assert.ok(text.includes(path), `risky path ${path}`)
    }
    assert.ok(text.includes('DONE_WITH_CONCERNS'), 'DONE_WITH_CONCERNS')
  })

  test('caps fix rounds at 2', () => {
    assert.ok(text.includes('2 fix rounds'))
  })

  test('issue body template', () => {
    for (const heading of [
      '## What to build',
      '## Approach',
      '## Acceptance criteria',
      '## Non-goals',
    ]) {
      assert.ok(text.includes(heading), `missing template heading ${heading}`)
    }
  })

  test('stays under 120 lines', () => {
    assert.ok(raw.split('\n').length < 120)
  })

  test('ties orchestrai/review to the head the reviewer tested', () => {
    assert.ok(text.includes('starts with the head SHA'), 'CHECKS line starts with the SHA')
    assert.ok(text.includes('equals the PR head'), 'status posted only when the SHA equals the PR head')
  })

  test('says what happens to a queued PR that falls behind main', () => {
    assert.ok(text.includes('strict'), 'main protection is strict')
    assert.ok(text.includes('gh api -X PUT repos/{owner}/{repo}/pulls/<n>/update-branch'))
    assert.ok(text.includes('re-posts `orchestrai/review` on the new head'))
    assert.ok(text.includes('a developer dispatch resolves it'), 'conflict goes to a developer')
    assert.ok(text.includes('review gate runs again'))
  })
})

describe('claude skills', () => {
  const read = (name) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')
  const kickoffRaw = read('tm-kickoff')
  const kickoff = kickoffRaw.replace(/\s+/g, ' ')
  const advisorRaw = read('tm-advisor')

  test('each skill is under 200 lines', () => {
    assert.ok(kickoffRaw.split('\n').length < 200, 'tm-kickoff')
    assert.ok(advisorRaw.split('\n').length < 200, 'tm-advisor')
  })

  test('kickoff follows the flow doc and states the review gate', () => {
    assert.ok(kickoff.includes('docs/architecture/light-flow.md'))
    for (const path of RISKY_PATHS) assert.ok(kickoff.includes(path), `risky path ${path}`)
    assert.ok(kickoff.includes('dependency manifest or lockfile'))
    assert.ok(kickoff.includes('size:M'))
    assert.ok(kickoff.includes('DONE_WITH_CONCERNS'))
  })

  test('kickoff posts the review status the flow doc names', () => {
    assert.ok(kickoff.includes('orchestrai/review'))
    assert.ok(kickoff.includes('not required (size S)'))
    assert.ok(kickoff.includes('needs-human'))
    assert.ok(kickoff.includes('2 fix rounds'))
  })

  test('kickoff adds an Approach comment to an issue that has none', () => {
    assert.match(kickoff, /no `## Approach` section[^.]*comment/)
    assert.ok(kickoff.includes('never dispatches a developer with no plan'))
  })

  test('kickoff resume runs the gate for a PR with no review comment', () => {
    assert.ok(kickoff.includes('no review comment'))
    assert.match(kickoff, /size S[^.]*gate[^.]*not a new developer dispatch/)
  })

  test('kickoff posts the status only when the reviewed SHA equals the PR head', () => {
    assert.ok(kickoff.includes('equals the PR head'))
    assert.ok(kickoff.includes('starts with the head SHA'))
  })

  test('kickoff updates a queued PR that fell behind main, then re-posts the status', () => {
    assert.ok(kickoff.includes('gh api -X PUT repos/{owner}/{repo}/pulls/<n>/update-branch'))
    assert.ok(kickoff.includes('re-posts `orchestrai/review` on the new head'))
    assert.ok(kickoff.includes('a developer dispatch resolves it'))
    assert.ok(kickoff.includes('review gate runs again'))
  })

  test('the reviewer may get only a PR number, so the lead passes the PR and the issue', () => {
    assert.ok(kickoff.includes('the PR number and the issue number'))
  })

  for (const name of ['tm-kickoff', 'tm-advisor']) {
    test(`${name} carries none of the removed pipeline's vocabulary`, () => {
      const src = read(name)
      for (const word of [
        /\btester\b/i,
        /architect stage/i,
        /SUB_PLAN/,
        /phase:/,
        /track:/,
        /runner/i,
        /claimed:/,
        /ship-decision/,
        /lean-allowed/,
        /Plan status/i,
        /plan-status/i,
        /orchestrai\/test/,
        /token-report/,
      ]) {
        assert.ok(!word.test(src), `${name}/SKILL.md still matches ${word}`)
      }
    })
  }

  test('advisor follows the same flow doc and keeps the sign-off outcomes', () => {
    const advisor = advisorRaw.replace(/\s+/g, ' ')
    assert.ok(advisor.includes('docs/architecture/light-flow.md'))
    assert.ok(advisor.includes('**dispatch**'))
    assert.ok(advisor.includes('**file only**'))
    assert.ok(advisor.includes('Batch: <slug>'))
    for (const heading of ['## What to build', '## Approach', '## Acceptance criteria', '## Non-goals']) {
      assert.ok(advisor.includes(heading), `issue template heading ${heading}`)
    }
  })
})
