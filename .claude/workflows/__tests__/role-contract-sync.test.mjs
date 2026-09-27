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
    'plan holds, no additions',
  ],
  'developer': [
    'dependency manifest or lockfile',
  ],
  'tester': [
    'environment error is never a finding',
  ],
  'reviewer': [
    'a non-zero exit is a must-fix',
    'use a given dependency environment',
  ],
}

describe('role contract sync', () => {
  test('role-contracts.md exists', () => {
    assert.ok(readFileSync(rcPath, 'utf8').length > 0)
  })

  test('agent files exist for every role', () => {
    assert.ok(ROLES.length >= 7, `expected at least 7 role agents, found ${ROLES.length}`)
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
  // optional LESSONS line, byte-identical across all six copies (agent
  // file, role-contracts.md, and the Hermes prompt, for tester and
  // reviewer).
  const lessonRoles = ['tester', 'reviewer']

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

  test('role-contracts.md has exactly two LESSONS lines', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    assert.equal(lessonLines(rcSrc).length, 2)
  })

  test('all six LESSONS lines are byte-identical and start with "LESSONS: <optional"', () => {
    const rcSrc = readFileSync(rcPath, 'utf8')
    const allLines = [
      ...lessonRoles.map((role) => lessonLines(extractReportFromAgent(role))[0]),
      ...lessonRoles.map(
        (role) => lessonLines(readFileSync(join(promptsDir, `${role}.md`), 'utf8'))[0]
      ),
      ...lessonLines(rcSrc),
    ]

    assert.equal(allLines.length, 6, `expected 6 LESSONS lines, found ${allLines.length}`)
    for (const line of allLines) {
      assert.equal(line, allLines[0], 'LESSONS line differs across the six copies')
    }
    assert.ok(
      allLines[0].startsWith('LESSONS: <optional'),
      `LESSONS line does not start with "LESSONS: <optional": ${allLines[0]}`
    )
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

  // Sentinel phrases required in BOTH the agent file and role-contracts.md
  // (stricter than SENTINEL_RULES, which only checks role-contracts.md).
  // Added for issue #381 fix round 1: the one-line `plan holds, no
  // additions` form must state the size check's result (e.g. "fits
  // size:S"), not just name the label, in both files.
  const BOTH_SENTINEL_RULES = {
    architect: ['fits size:'],
  }

  for (const [role, phrases] of Object.entries(BOTH_SENTINEL_RULES)) {
    for (const phrase of phrases) {
      test(`${role}: agent file and role-contracts.md both contain "${phrase}"`, () => {
        const agentText = readFileSync(join(agentsDir, `${role}.md`), 'utf8').toLowerCase()
        const rcText = readFileSync(rcPath, 'utf8').toLowerCase()
        assert.ok(
          agentText.includes(phrase.toLowerCase()),
          `${role}.md is missing the one-line form's size-check wording "${phrase}"`
        )
        assert.ok(
          rcText.includes(phrase.toLowerCase()),
          `role-contracts.md is missing the one-line form's size-check wording "${phrase}"`
        )
      })
    }
  }
})
