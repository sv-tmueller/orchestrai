/**
 * Role contract sync test (issue #313, review #320 finding 3).
 *
 * Asserts that the report contract text in each agent file
 * (.claude/agents/<role>.md) matches the corresponding section in
 * docs/architecture/role-contracts.md, and that key normative rules
 * from the agent files are present in role-contracts.md.
 *
 * The agent files are the host-specific binding; role-contracts.md is
 * the neutral source of truth. Drift in report contracts is caught by
 * exact text comparison. Normative rules are checked by asserting that
 * specific sentinel phrases from the agent files appear in
 * role-contracts.md (paraphrase is allowed; outright omission is not).
 *
 * ROLES is derived from readdirSync(agentsDir), so a new agent file
 * is automatically included.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const agentsDir = join(__dir, '..', '..', 'agents')
const rcPath = join(__dir, '..', '..', '..', 'docs', 'architecture', 'role-contracts.md')
const promptsDir = join(__dir, '..', '..', 'adapters', 'prompts')

const ROLES = readdirSync(agentsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))

// Normalize: trim trailing spaces per line, strip host-specific paths.
function normalize(text) {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .map((l) => l.replace(/~\/\.claude\/[^\s)]*/g, ''))
    .join('\n')
    .trim()
}

// Extract the report contract from an agent file.
function extractReportFromAgent(role) {
  const src = readFileSync(join(agentsDir, `${role}.md`), 'utf8')
  for (const heading of ['## Report contract', '## Output contract']) {
    const idx = src.indexOf(heading)
    if (idx >= 0) {
      const start = idx + heading.length
      const nextH = src.indexOf('\n## ', start)
      const end = nextH >= 0 ? nextH : src.length
      return normalize(src.slice(start, end))
    }
  }
  return null
}

// Extract the report contract from role-contracts.md for a given role.
function extractReportFromRC(role) {
  const src = readFileSync(rcPath, 'utf8')
  const roleHeading = `## ${role}\n`
  const roleIdx = src.indexOf(roleHeading)
  if (roleIdx < 0) return null

  const nextRoleIdx = src.indexOf('\n## ', roleIdx + roleHeading.length)
  const roleSection = nextRoleIdx >= 0
    ? src.slice(roleIdx, nextRoleIdx)
    : src.slice(roleIdx)

  const rcIdx = roleSection.indexOf('### Report contract')
  if (rcIdx < 0) return null

  const start = rcIdx + '### Report contract'.length
  const nextSubIdx = roleSection.indexOf('\n### ', start)
  const end = nextSubIdx >= 0 ? nextSubIdx : roleSection.length
  return normalize(roleSection.slice(start, end))
}

// Sentinel phrases from agent files that MUST appear in role-contracts.md.
// These are the normative rules that were dropped in round 1 (review #320
// finding 3). Paraphrase is tolerated by checking lowercase containment
// of distinctive fragments.
const SENTINEL_RULES = {
  'fact-checker': [
    'one status per claim',
    'never assign a status from memory',
    'never silently drop a claim',
    'never soften a contradi',
  ],
  'architect': [
    'four principles',
  ],
  'developer': [
    'fix exactly the numbered findings',
  ],
  'reviewer': [
    'a non-zero exit is a must-fix',
    'runs the check suite itself',
  ],
}

describe('role contract sync', () => {
  test('role-contracts.md exists', () => {
    assert.ok(readFileSync(rcPath, 'utf8').length > 0)
  })

  test('agent files exist for every role', () => {
    assert.deepEqual(
      [...ROLES].sort(),
      ['architect', 'developer', 'docs-writer', 'fact-checker', 'perf-investigator', 'reviewer'],
      'the role list is the six roles of the light flow; the tester is gone'
    )
  })

  for (const role of ROLES) {
    test(`${role}: agent report contract matches role-contracts.md`, () => {
      const agentContract = extractReportFromAgent(role)
      assert.ok(agentContract, `${role}.md: no "## Report contract" or "## Output contract" section found`)

      const rcContract = extractReportFromRC(role)
      assert.ok(rcContract, `role-contracts.md: no "### Report contract" under "## ${role}"`)

      assert.equal(
        agentContract,
        rcContract,
        `${role}: report contract in agent file does not match role-contracts.md.\n` +
          `Normalize both copies to identical text.`
      )
    })
  }

  // LESSONS channel sentinel (issue #393): the report contract gained an
  // optional LESSONS line, byte-identical across all three copies (agent
  // file, role-contracts.md, and the Hermes prompt, for the reviewer).
  const lessonRoles = ['reviewer']

  function lessonLines(text) {
    return text.split('\n').filter((l) => l.startsWith('LESSONS:'))
  }

  for (const role of lessonRoles) {
    test(`${role}: agent file has exactly one LESSONS line`, () => {
      assert.equal(lessonLines(extractReportFromAgent(role)).length, 1)
    })

    test(`${role}: Hermes prompt has exactly one LESSONS line`, () => {
      const promptSrc = readFileSync(join(promptsDir, `${role}.md`), 'utf8')
      assert.equal(lessonLines(promptSrc).length, 1)
    })
  }

  test('role-contracts.md has exactly one LESSONS line', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    assert.equal(lessonLines(rcSrc).length, 1)
  })

  test('all three LESSONS lines are byte-identical and start with "LESSONS: <optional"', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const allLines = [
      ...lessonRoles.map((role) => lessonLines(extractReportFromAgent(role))[0]),
      ...lessonRoles.map(
        (role) => lessonLines(readFileSync(join(promptsDir, `${role}.md`), 'utf8'))[0]
      ),
      ...lessonLines(rcSrc),
    ]

    assert.equal(allLines.length, 3, `expected 3 LESSONS lines, found ${allLines.length}`)
    for (const line of allLines) {
      assert.equal(line, allLines[0], 'LESSONS line differs across the three copies')
    }
    assert.ok(
      allLines[0].startsWith('LESSONS: <optional'),
      `LESSONS line does not start with "LESSONS: <optional": ${allLines[0]}`
    )
  })

  // The rule for where should-fix findings and nits go is one paragraph,
  // byte-identical in role-contracts.md, the reviewer agent file, and the
  // reviewer prompt the adapters load. In the light flow they stay in the
  // review comment, and the reviewer never files follow-up issues.
  test('reviewer: the findings-routing paragraph is identical in all three copies', () => {
    const paragraphOf = (path) => {
      const src = readFileSync(path, 'utf8')
      const start = src.indexOf('Only must-fix findings block:')
      assert.ok(start >= 0, `${path}: paragraph "Only must-fix findings block:" not found`)
      const end = src.indexOf('\n\n', start)
      return src.slice(start, end >= 0 ? end : src.length)
    }
    const doc = paragraphOf(rcPath)
    const agent = paragraphOf(join(agentsDir, 'reviewer.md'))
    const prompt = paragraphOf(join(promptsDir, 'reviewer.md'))

    assert.equal(agent, doc, 'reviewer.md paragraph differs from role-contracts.md')
    assert.equal(prompt, doc, 'adapters/prompts/reviewer.md paragraph differs from role-contracts.md')
    assert.ok(doc.includes('never file follow-up issues'), 'paragraph lacks "never file follow-up issues"')
    assert.ok(!doc.includes('auto merge'), 'the follow-up-issue routing for auto merge repos is gone')
  })

  // The reviewer has no tester stage in front of it, so it runs the check
  // suite itself on every dispatch and reports it in a CHECKS line with the
  // developer's shape. The claims input and the CLAIMS line went with the
  // tester.
  test('reviewer: the CHECKS line is identical in all three copies and has the developer shape', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const roleIdx = rcSrc.indexOf('## reviewer\n')
    assert.ok(roleIdx >= 0, 'role-contracts.md: "## reviewer" section not found')
    const nextIdx = rcSrc.indexOf('\n## ', roleIdx + '## reviewer\n'.length)
    const copies = {
      'role-contracts.md': rcSrc.slice(roleIdx, nextIdx >= 0 ? nextIdx : rcSrc.length),
      'reviewer.md': readFileSync(join(agentsDir, 'reviewer.md'), 'utf8'),
      'adapters/prompts/reviewer.md': readFileSync(join(promptsDir, 'reviewer.md'), 'utf8'),
    }
    const checksLines = {}
    for (const [name, src] of Object.entries(copies)) {
      checksLines[name] = src.split('\n').filter((l) => l.startsWith('CHECKS:'))
      assert.equal(checksLines[name].length, 1, `${name}: expected exactly one CHECKS line, found ${checksLines[name].length}`)
      assert.ok(!/^CLAIMS:/m.test(src), `${name}: the CLAIMS line is gone with the tester`)
    }
    for (const name of ['reviewer.md', 'adapters/prompts/reviewer.md']) {
      assert.equal(checksLines[name][0], checksLines['role-contracts.md'][0], `${name}: CHECKS line differs from role-contracts.md`)
    }
    const line = checksLines['role-contracts.md'][0]
    assert.ok(
      line.includes('each check command and its exit code, e.g. `npm test` -> 0'),
      `CHECKS line lacks the developer shape: ${line}`
    )
    assert.ok(!/n\/a/.test(line), 'the reviewer always runs the checks, so CHECKS is never n/a')
    assert.ok(
      line.startsWith('CHECKS: <full head SHA you tested>; '),
      `CHECKS line does not start with the tested head SHA: ${line}`
    )
  })

  // The three reviewer copies, as one map, for the rules below.
  function reviewerCopies() {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const roleIdx = rcSrc.indexOf('## reviewer\n')
    const nextIdx = rcSrc.indexOf('\n## ', roleIdx + '## reviewer\n'.length)
    return {
      'role-contracts.md': rcSrc.slice(roleIdx, nextIdx >= 0 ? nextIdx : rcSrc.length),
      'reviewer.md': readFileSync(join(agentsDir, 'reviewer.md'), 'utf8'),
      'adapters/prompts/reviewer.md': readFileSync(join(promptsDir, 'reviewer.md'), 'utf8'),
    }
  }

  test('reviewer: all three copies say an environment failure is not a finding', () => {
    for (const [name, src] of Object.entries(reviewerCopies())) {
      const flat = src.replace(/\s+/g, ' ')
      assert.match(flat, /environment[^.]*is not a finding/, `${name} lacks the environment-failure rule`)
      assert.ok(flat.includes('rerun it once in a clean setup'), `${name} lacks the clean-setup rerun`)
    }
  })

  test('reviewer: all three copies tell it to start the CHECKS line with the tested head SHA', () => {
    for (const [name, src] of Object.entries(reviewerCopies())) {
      const flat = src.replace(/\s+/g, ' ')
      assert.ok(flat.includes('Start the CHECKS line with the full SHA of the head you tested'), name)
      assert.ok(flat.includes('git rev-parse HEAD'), `${name} does not name git rev-parse HEAD`)
    }
  })

  test('reviewer: the agent file and the prompt list git rev-parse and the headRefName lookup', () => {
    const copies = reviewerCopies()
    for (const name of ['reviewer.md', 'adapters/prompts/reviewer.md']) {
      const flat = copies[name].replace(/\s+/g, ' ')
      assert.ok(flat.includes('`git rev-parse`'), `${name}: git rev-parse is not on the command list`)
      assert.ok(
        flat.includes('`gh pr view <n> --json headRefName`'),
        `${name}: the headRefName lookup is not on the command list`
      )
    }
  })

  // The Codex personas are one-line summaries of the contracts. They lag
  // silently, so pin the parts that changed with the light flow.
  test('codex personas match the light flow contracts', () => {
    const personas = join(__dir, '..', '..', 'adapters', 'personas')
    const architect = readFileSync(join(personas, 'architect.toml'), 'utf8')
    assert.ok(!/SUB_PLAN/.test(architect), 'architect.toml still carries SUB_PLAN')
    assert.match(architect, /jobs = "SPLIT_PROPOSAL, ARBITRATION"/)
    assert.ok(!/Start with SUB_PLAN/.test(architect))
    const reviewer = readFileSync(join(personas, 'reviewer.toml'), 'utf8')
    assert.ok(!/sub-plan/i.test(reviewer), 'reviewer.toml still names a sub-plan')
    assert.match(reviewer, /report_contract = [^\n]*CHECKS/, 'reviewer.toml report contract lacks CHECKS')
    assert.ok(/head SHA/.test(reviewer), 'reviewer.toml does not mention the head SHA on CHECKS')
  })

  // The reviewer carries no tester, lean-track or follow-up-issue wording in
  // any of its three copies.
  test('reviewer: no copy mentions the tester, the lean track or a tester claims input', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const roleIdx = rcSrc.indexOf('## reviewer\n')
    const nextIdx = rcSrc.indexOf('\n## ', roleIdx + '## reviewer\n'.length)
    const copies = {
      'role-contracts.md': rcSrc.slice(roleIdx, nextIdx >= 0 ? nextIdx : rcSrc.length),
      'reviewer.md': readFileSync(join(agentsDir, 'reviewer.md'), 'utf8'),
      'adapters/prompts/reviewer.md': readFileSync(join(promptsDir, 'reviewer.md'), 'utf8'),
    }
    for (const [name, src] of Object.entries(copies)) {
      for (const word of [/\btester\b/i, /lean track/i, /untested claim/i, /sub-plan/i]) {
        assert.ok(!word.test(src), `${name} still matches ${word}`)
      }
    }
  })

  // The developer's spec is the issue's Approach section; no sub-plan
  // comment is read or posted any more.
  test('developer: no copy mentions a sub-plan comment, and DEVIATIONS reads from the Approach', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const roleIdx = rcSrc.indexOf('## developer\n')
    const nextIdx = rcSrc.indexOf('\n## ', roleIdx + '## developer\n'.length)
    const copies = {
      'role-contracts.md': rcSrc.slice(roleIdx, nextIdx >= 0 ? nextIdx : rcSrc.length),
      'developer.md': readFileSync(join(agentsDir, 'developer.md'), 'utf8'),
      'adapters/prompts/developer.md': readFileSync(join(promptsDir, 'developer.md'), 'utf8'),
    }
    for (const [name, src] of Object.entries(copies)) {
      assert.ok(!/sub-plan/i.test(src), `${name} still names a sub-plan`)
      assert.ok(src.includes('## Approach'), `${name} does not name the issue's Approach section`)
      assert.ok(
        src.includes("DEVIATIONS: <anything done differently from the issue's Approach, or \"none\">"),
        `${name}: DEVIATIONS line does not read from the issue's Approach`
      )
    }
  })

  // The architect is on demand only: split proposals and disputes. There is
  // no per-issue SUB_PLAN job.
  test('architect: no copy carries the SUB_PLAN job', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const roleIdx = rcSrc.indexOf('## architect\n')
    const nextIdx = rcSrc.indexOf('\n## ', roleIdx + '## architect\n'.length)
    const copies = {
      'role-contracts.md': rcSrc.slice(roleIdx, nextIdx >= 0 ? nextIdx : rcSrc.length),
      'architect.md': readFileSync(join(agentsDir, 'architect.md'), 'utf8'),
      'adapters/prompts/architect.md': readFileSync(join(promptsDir, 'architect.md'), 'utf8'),
    }
    for (const [name, src] of Object.entries(copies)) {
      assert.ok(!/SUB_PLAN/.test(src), `${name} still carries SUB_PLAN`)
      assert.ok(!/plan holds, no additions/.test(src), `${name} still carries the one-line plan form`)
      assert.ok(/SPLIT_PROPOSAL/.test(src) && /ARBITRATION/.test(src), `${name} lost a remaining job`)
    }
  })

  // Normative rule presence checks for roles with sentinel rules.
  for (const [role, phrases] of Object.entries(SENTINEL_RULES)) {
    for (const phrase of phrases) {
      test(`${role}: role-contracts.md contains "${phrase}"`, () => {
        const rcText = readFileSync(rcPath, 'utf8').toLowerCase()
        assert.ok(
          rcText.includes(phrase.toLowerCase()),
          `role-contracts.md is missing the normative rule "${phrase}" ` +
            `that ${role}.md prescribes; restore it in host-neutral wording`
        )
      })
    }
  }
})
