/**
 * Hermes agent prompts test (issue #333).
 *
 * Verifies that:
 * 1. All 7 role prompt files exist at .claude/adapters/prompts/.
 * 2. The Hermes adapter's loadPrompt function loads them correctly.
 * 3. Each prompt file contains the key sections from the role contract
 *    (job description and report contract).
 * 4. The prompt files do not contain Claude Code-specific tool names.
 * 5. The Hermes kickoff skill exists.
 * 6. The Hermes advisor skill exists (#346).
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const promptsDir = join(__dir, '..', '..', 'adapters', 'prompts')
const skillsDir = join(__dir, '..', '..', 'skills')

const EXPECTED_ROLES = [
  'architect', 'developer', 'docs-writer', 'fact-checker',
  'perf-investigator', 'reviewer', 'tester',
]

// Claude Code tool names that should NOT appear in the Hermes prompts.
const CLAUDE_CODE_TOOLS = [
  /\bAgent tool\b/i,
  /\bTodoWrite\b/,
  /\bWebFetch\b/,
  /\bSkill tool\b/i,
]

// ===========================================================================
// 1. All 7 prompt files exist
// ===========================================================================
describe('hermes agent prompt files', () => {
  test('prompts directory exists', () => {
    assert.ok(existsSync(promptsDir))
  })

  for (const role of EXPECTED_ROLES) {
    test(`${role}.md exists`, () => {
      assert.ok(
        existsSync(join(promptsDir, `${role}.md`)),
        `missing prompt file: ${role}.md`
      )
    })
  }

  test('prompt file count matches role count', () => {
    const mdFiles = readdirSync(promptsDir).filter((f) => f.endsWith('.md'))
    assert.equal(mdFiles.length, EXPECTED_ROLES.length)
  })
})

// ===========================================================================
// 2. Prompt files contain key sections from the role contract
// ===========================================================================
describe('prompt file content', () => {
  for (const role of EXPECTED_ROLES) {
    const content = readFileSync(join(promptsDir, `${role}.md`), 'utf8')

    test(`${role}.md has a report contract section`, () => {
      assert.ok(
        content.includes('Report contract') || content.includes('Output contract'),
        `${role}.md must contain a "Report contract" or "Output contract" section`
      )
    })

    test(`${role}.md has the role description`, () => {
      // Each prompt starts with a heading and a description line.
      assert.ok(content.length > 100, `${role}.md is suspiciously short`)
      assert.ok(content.startsWith('#'), `${role}.md should start with a heading`)
    })
  }
})

// ===========================================================================
// 3. Prompt files do not contain Claude Code-specific tool names
// ===========================================================================
describe('prompt files are host-neutral', () => {
  for (const role of EXPECTED_ROLES) {
    test(`${role}.md has no Claude Code tool names`, () => {
      const content = readFileSync(join(promptsDir, `${role}.md`), 'utf8')
      for (const pattern of CLAUDE_CODE_TOOLS) {
        assert.ok(
          !pattern.test(content),
          `${role}.md contains a Claude Code tool name: ${pattern}`
        )
      }
    })

    test(`${role}.md does not reference CLAUDE.md`, () => {
      const content = readFileSync(join(promptsDir, `${role}.md`), 'utf8')
      assert.ok(
        !content.includes('CLAUDE.md'),
        `${role}.md references CLAUDE.md; should reference AGENTS.md instead`
      )
    })
  }
})

// ===========================================================================
// 4. The Hermes adapter loads prompt files correctly
// ===========================================================================
describe('hermes adapter prompt loading', () => {
  let loadPrompt

  before(async () => {
    process.env.DRY_RUN = 'true'
    const mod = await import('../../adapters/hermes-adapter.mjs')
    loadPrompt = mod.loadPrompt
  })

  for (const role of EXPECTED_ROLES) {
    test(`loadPrompt("${role}") returns non-empty text`, () => {
      const prompt = loadPrompt(role)
      assert.ok(typeof prompt === 'string')
      assert.ok(prompt.length > 100, `${role} prompt is suspiciously short`)
      assert.ok(prompt.includes('Report contract') || prompt.includes('Output contract'))
    })
  }

  test('loadPrompt caches results', () => {
    const a = loadPrompt('architect')
    const b = loadPrompt('architect')
    assert.strictEqual(a, b, 'loadPrompt should return cached object')
  })
})

// ===========================================================================
// 5. The Hermes kickoff skill exists
// ===========================================================================
describe('hermes kickoff skill', () => {
  test('SKILL.hermes.md exists', () => {
    const skillPath = join(skillsDir, 'tm-kickoff', 'SKILL.hermes.md')
    assert.ok(existsSync(skillPath), 'SKILL.hermes.md not found')
  })

  test('skill references delegate_task', () => {
    const skillPath = join(skillsDir, 'tm-kickoff', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(
      content.includes('delegate_task'),
      'SKILL.hermes.md must reference delegate_task'
    )
  })

  test('skill references the adapter table', () => {
    const skillPath = join(skillsDir, 'tm-kickoff', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(
      content.includes('hermes.json'),
      'SKILL.hermes.md must reference the adapter table'
    )
  })

  test('skill has the 5 pipeline stages', () => {
    const skillPath = join(skillsDir, 'tm-kickoff', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(content.includes('Architect'), 'missing Architect stage')
    assert.ok(content.includes('Developer'), 'missing Developer stage')
    assert.ok(content.includes('Tester'), 'missing Tester stage')
    assert.ok(content.includes('Reviewer'), 'missing Reviewer stage')
    assert.ok(content.includes('Ship'), 'missing Ship stage')
  })
})

// ===========================================================================
// 6. The Hermes advisor skill exists (#346)
// ===========================================================================
describe('hermes advisor skill', () => {
  test('SKILL.hermes.md exists', () => {
    const skillPath = join(skillsDir, 'tm-advisor', 'SKILL.hermes.md')
    assert.ok(existsSync(skillPath), 'SKILL.hermes.md not found')
  })

  test('skill references delegate_task', () => {
    const skillPath = join(skillsDir, 'tm-advisor', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(
      content.includes('delegate_task'),
      'SKILL.hermes.md must reference delegate_task'
    )
  })

  test('skill references the orchestrai skill', () => {
    const skillPath = join(skillsDir, 'tm-advisor', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(
      content.includes("skill_view"),
      'SKILL.hermes.md must reference skill_view to load the pipeline'
    )
  })

  test('skill has the 6 advisor sections', () => {
    const skillPath = join(skillsDir, 'tm-advisor', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(content.includes('## 1. Refine'), 'missing Refine section')
    assert.ok(content.includes('## 2. Propose'), 'missing Propose section')
    assert.ok(content.includes('## 3. File'), 'missing File section')
    assert.ok(content.includes('## 4. Run'), 'missing Run section')
    assert.ok(content.includes('## 5. Report'), 'missing Report section')
    assert.ok(content.includes('## 6. Resume'), 'missing Resume section')
  })

  test('skill has the sign-off block', () => {
    const skillPath = join(skillsDir, 'tm-advisor', 'SKILL.hermes.md')
    const content = readFileSync(skillPath, 'utf8')
    assert.ok(
      content.includes('Sign-off'),
      'SKILL.hermes.md must contain the sign-off block'
    )
  })
})
