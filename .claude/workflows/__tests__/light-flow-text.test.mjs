/**
 * Pins the light flow doc (docs/architecture/light-flow.md), the one source
 * the Claude kickoff and advisor skills and the Hermes driver follow, and
 * the two Claude skills that implement it.
 *
 * The pins cover the parts that must not drift: the section headings other
 * files link to, the review gate, the fix-round cap, the issue body
 * template, the merge gate and the conflict rule. Whitespace is collapsed
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

  test('stays under 130 lines', () => {
    assert.ok(raw.split('\n').length < 130)
  })

  test('ties orchestrai/review to the head the reviewer tested', () => {
    assert.ok(text.includes('starts with the head SHA'), 'CHECKS line starts with the SHA')
    assert.ok(text.includes('equals the PR head'), 'status posted only when the SHA equals the PR head')
  })

  test('queues auto merge only on a protected default branch', () => {
    assert.ok(text.includes('allow_auto_merge'))
    assert.ok(text.includes('default branch is protected'))
    assert.ok(text.includes('waiting for a human merge'))
  })

  test('does not carry a behind-main rule, and says a conflict goes to a developer', () => {
    assert.ok(!text.includes('update-branch'), 'update-branch rule is gone')
    assert.ok(!/\bstrict\b/.test(text), 'main protection is no longer strict')
    assert.ok(text.includes('DIRTY'))
    assert.ok(text.includes('merge main and resolve'))
    assert.ok(text.includes('review gate runs again'))
  })

  test('says how an issue is sized, resumed and unblocked, and what a red CHECKS line does', () => {
    assert.ok(text.includes('sizes an unsized issue itself'), 'the lead sizes an unsized issue')
    assert.ok(text.includes('closingIssuesReferences'), 'how to find the PR on a resume')
    assert.ok(text.includes('starts in the same run'), 'a blocker that merges mid-run')
    assert.match(text, /did not exit 0[^.]*fix round[^.]*counts toward the cap/)
    assert.ok(text.includes('Sonnet'), 'the Sonnet fallback')
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
    assert.ok(kickoff.includes('approved by reviewer'))
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

  test('kickoff queues auto merge only on a protected default branch', () => {
    assert.ok(kickoff.includes('allow_auto_merge'))
    assert.ok(kickoff.includes('--jq .protected'))
    assert.ok(kickoff.includes('rules/branches/<default> --jq length'))
    assert.ok(kickoff.includes('waiting for a human merge'))
  })

  test('kickoff has no behind-main rule and sends a DIRTY PR to a developer', () => {
    assert.ok(!kickoff.includes('update-branch'), 'update-branch rule is gone')
    assert.ok(!/\bBEHIND\b/.test(kickoff), 'BEHIND is no longer handled')
    assert.ok(kickoff.includes('`DIRTY`'))
    assert.ok(kickoff.includes('merge origin/main and resolve'))
    assert.ok(kickoff.includes('review gate runs again'))
  })

  test('kickoff sends a gate-skipped package with a red CHECKS line back as a fix round', () => {
    assert.match(kickoff, /did not exit 0[^.]*fix round/)
    assert.match(kickoff, /red checks` first[^.]*counts toward the cap of 2/)
  })

  test('kickoff sizes an unsized issue itself and splits only L and XL', () => {
    assert.match(kickoff, /Unsized: you size it[^.]*S or M[^.]*label it/)
    assert.match(kickoff, /`size:L` or `size:XL`: do not run it\. Ask the architect for a `JOB: SPLIT_PROPOSAL`/)
  })

  test('kickoff resumes an in-progress issue or an open PR, and says how to find the PR', () => {
    assert.match(kickoff, /`in-progress` or an open PR[^.]*resumes/)
    assert.ok(kickoff.includes('gh pr list --state open --limit 100 --json number,headRefName,closingIssuesReferences'))
  })

  test('kickoff starts a blocked issue in the same run once its blocker merges', () => {
    assert.match(kickoff, /blocker merges during the run[^.]*start/i)
  })

  test('kickoff ships a Sonnet-fallback APPROVE like any APPROVE', () => {
    assert.ok(kickoff.includes('A Sonnet-fallback `APPROVE` ships like any `APPROVE`'))
  })

  test('kickoff prunes worktrees at wave end, and never force-removes a dirty one', () => {
    assert.ok(kickoff.includes('git worktree prune'))
    assert.ok(kickoff.includes('.claude/worktrees/agent-*'))
    assert.ok(kickoff.includes('git branch -r --contains <sha>'))
    assert.ok(kickoff.includes('Never force-remove a dirty one'))
  })

  test('kickoff is complete on its own and names the flow doc as a design reference only', () => {
    assert.ok(kickoff.includes('complete on its own'))
    assert.ok(kickoff.includes('orchestrai repo only'))
  })

  test('advisor reaches kickoff through the plugin root', () => {
    const advisor = advisorRaw.replace(/\s+/g, ' ')
    assert.ok(advisor.includes('${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/SKILL.md'))
    assert.ok(advisor.includes('orchestrai repo only'))
  })

  test('the size:M label no longer promises a sub-plan, in either skill', () => {
    assert.ok(!kickoffRaw.includes('Write a sub-plan first'))
    assert.ok(!advisorRaw.includes('Write a sub-plan first'))
    assert.ok(kickoffRaw.includes('"size:M"'))
    assert.ok(advisorRaw.includes('"size:M"'))
  })

  test('tm-ab-test points at kickoff wave end and marks the removed token-report script', () => {
    const ab = read('tm-ab-test')
    assert.ok(ab.replace(/\s+/g, ' ').includes('SKILL.md\'s "6. Wave end" section'))
    assert.ok(!ab.includes('Worktree cleanup (deterministic)'))
    assert.ok(ab.includes('(script removed in #630)'))
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

describe('docs follow the light flow (#633)', () => {
  const root = join(__dir, '..', '..', '..')
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const flat = (rel) => read(rel).replace(/\s+/g, ' ')

  test('team-guide.md shrank and links the flow doc instead of restating it', () => {
    const guide = read('.claude/team-guide.md')
    assert.ok(guide.split('\n').length < 200, 'under 200 lines (was 284)')
    assert.ok(guide.includes('docs/architecture/light-flow.md'))
  })

  test('team-guide.md carries none of the removed pipeline vocabulary', () => {
    const guide = read('.claude/team-guide.md')
    for (const word of [
      /\btester\b/i,
      /plan-status/i,
      /phase:/,
      /track:lean/,
      /runner/i,
      /claimed:/,
      /review owed/i,
      /flagged and re-run/i,
      /dependency environment/i,
      /Limit deaths/,
    ]) {
      assert.ok(!word.test(guide), `team-guide.md still matches ${word}`)
    }
  })

  test('team-guide.md says a Sonnet-fallback APPROVE ships like an Opus one', () => {
    assert.match(flat('.claude/team-guide.md'), /Sonnet[^.]*APPROVE[^.]*ships like/)
  })

  test('the architect is on demand and the review status is the only verdict status', () => {
    const guide = flat('.claude/team-guide.md')
    assert.match(guide, /architect[^.]*on demand/)
    assert.ok(guide.includes('orchestrai/review'))
  })

  test('the docs the flow touches name no tester, plan-status, phase: or orchestrai/test', () => {
    for (const rel of [
      'NEW-PROJECT-SETUP.md',
      'docs/team-architecture.md',
      'docs/team-guide-rationale.md',
      'docs/why-the-team.md',
      'docs/architecture/operating-model.md',
      'docs/architecture/role-contracts.md',
      'docs/architecture/adapter-interface.md',
      'docs/architecture/codex-adapter.md',
      'docs/operations/plan-downgrade-runbook.md',
    ]) {
      // The A/B report's file name is a real path, so it is not a mention of the old block.
      const src = read(rel).replaceAll('ab-plan-status-parser', '')
      for (const word of [/\btester\b/i, /orchestrai\/test/, /plan-status/i, /\bphase:/]) {
        assert.ok(!word.test(src), `${rel} still matches ${word}`)
      }
    }
  })

  test('process-core makes the issue body the plan, and names no agent or skill', () => {
    const core = flat('.claude/process-core.md')
    assert.ok(!/sub-plan/i.test(core), 'process-core still asks for a sub-plan')
    assert.ok(core.includes('### Plan in the issue (checkpoint before deep work)'))
    assert.ok(core.includes('`## Approach`'))
    assert.ok(core.includes('`size:M` - 1 to 3 hours.'))
    assert.ok(core.includes('`size:L` - 4 to 6 hours. Split into smaller issues, or checkpoint the plan in steps (below).'))
    assert.ok(!core.includes('How to pick up a task'))
    // The CI section's worked-example path and `cancel-in-progress` were there before the light flow.
    const named = core.replace('.claude/skills/tm-repo-guard/templates/ci.yml', '').replace('cancel-in-progress', '')
    for (const word of [/\barchitect\b/i, /\bdeveloper\b/i, /\bkickoff\b/i, /\btm-/, /in-progress/]) {
      assert.ok(!word.test(named), `process-core matches ${word}`)
    }
    assert.ok(!/sub-plans/.test(flat('AGENTS.md')), 'AGENTS.md still says sub-plans')
  })

  test('README describes the light flow outside its Hermes sections', () => {
    const readme = read('README.md')
    const end = readme.indexOf('## Zone 2')
    assert.ok(end > 0, 'README has a Hermes section')
    const head = readme.slice(0, end)
    assert.ok(head.includes('docs/architecture/light-flow.md'))
    for (const word of [/\btester\b/i, /orchestrai\/test/, /brought up to date/, /lean-allowed/, /dependency environment/i]) {
      assert.ok(!word.test(head), `README head still matches ${word}`)
    }
  })

  test("the fact-checker counts a developer CHECKS line only when the developer is not the claim's author", () => {
    for (const rel of [
      '.claude/agents/fact-checker.md',
      '.claude/adapters/prompts/fact-checker.md',
      'docs/architecture/role-contracts.md',
    ]) {
      assert.ok(
        flat(rel).includes("only when the developer is not the claim's author"),
        `${rel} lacks the self-evidence rule`
      )
    }
  })

  test('no seat is told about a dependency environment, because the light flow never passes one', () => {
    for (const rel of [
      '.claude/agents/developer.md',
      '.claude/adapters/prompts/developer.md',
      'docs/architecture/role-contracts.md',
      '.claude/team-guide.md',
      'README.md',
    ]) {
      assert.ok(!/dependency environment/i.test(read(rel)), `${rel} still mentions it`)
    }
  })

  test('the kickoff skill counts red-checks fix rounds toward the cap and finds the PR by closing reference', () => {
    const kickoff = flat('.claude/skills/tm-kickoff/SKILL.md')
    assert.ok(kickoff.includes('Fix round <k>: red checks'))
    assert.match(kickoff, /Rounds used[^.]*`CHANGES_REQUESTED` review comments plus[^.]*`Fix round <k>: red checks` comments[^.]*cap of 2/)
    assert.ok(kickoff.includes('Do not search the body text: it also matches a PR that only mentions the number.'))
    assert.ok(!kickoff.includes('<n> in:body'), 'a bare "<n> in:body" search matches any PR that mentions the number')
    assert.ok(kickoff.includes('closingIssuesReferences'))
  })

  test('the flow doc finds the PR by closing reference too, and counts red-checks rounds', () => {
    const doc = flat('docs/architecture/light-flow.md')
    assert.ok(!doc.includes('<n> in:body'))
    assert.ok(doc.includes('closingIssuesReferences'))
    assert.ok(doc.includes('Fix round <k>: red checks'))
    assert.match(doc, /Rounds used[^.]*`CHANGES_REQUESTED` review comments plus[^.]*`Fix round <k>: red checks` comments[^.]*cap of 2/)
    assert.ok(doc.includes('Do not search the body text: it also matches a PR that only mentions the number.'))
  })
})
