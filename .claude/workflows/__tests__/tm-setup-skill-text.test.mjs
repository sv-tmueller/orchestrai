/**
 * Pins the tm-setup skill (issue #648).
 *
 * `/tm-setup` runs the new-project checklist in the current repo. The skill is
 * plain text the lead follows, so these tests pin what must not drift: the
 * frontmatter, the label lines (one wording shared with tm-kickoff), the
 * hand-off to tm-repo-guard, the never-do rules, and the pointers from the
 * checklist, the README and the team guide.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = join(__dir, '..', '..', '..')
const read = (...p) => readFileSync(join(root, ...p), 'utf8')
const collapse = (s) => s.replace(/\s+/g, ' ')

const raw = read('.claude', 'skills', 'tm-setup', 'SKILL.md')
const text = collapse(raw)
const kickoff = read('.claude', 'skills', 'tm-kickoff', 'SKILL.md')

const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
const labelLines = (s) => s.split('\n').filter((l) => l.startsWith('gh label create '))

describe('tm-setup frontmatter', () => {
  test('names itself and is user-invocable only', () => {
    assert.match(frontmatter, /^name: tm-setup$/m)
    assert.match(frontmatter, /^disable-model-invocation: true$/m)
    assert.match(frontmatter, /^description: .{20,}$/m)
    assert.match(frontmatter, /User-invocable only\.?"?$/m)
  })

  test('opens like the other user-typed skills', () => {
    assert.ok(
      text.includes('You are reading this because the user typed the command, so this skill is already loaded. Do not call the Skill tool for it.')
    )
  })
})

describe('tm-setup step 1: labels', () => {
  test('has the six label lines and each matches tm-kickoff character for character', () => {
    const mine = labelLines(raw)
    assert.equal(mine.length, 6)
    assert.deepEqual(mine, labelLines(kickoff))
  })

  test('every label line is idempotent (--force)', () => {
    for (const l of labelLines(raw)) assert.ok(l.endsWith('--force'), l)
  })
})

describe('tm-setup the other steps', () => {
  test('plugins step is a read-only check that prints the /plugin commands', () => {
    assert.ok(text.includes('installed_plugins.json'))
    assert.ok(text.includes('/plugin marketplace add sv-tmueller/orchestrai'))
    assert.ok(text.includes('/plugin install orchestrai@orchestrai'))
    assert.ok(text.includes('/plugin install superpowers@claude-plugins-official'))
  })

  test('docs step names every folder of the docs tree and a .gitkeep', () => {
    for (const dir of ['docs/architecture/', 'docs/operations/', 'docs/plans/', 'docs/reviews/', 'docs/superpowers/specs/']) {
      assert.ok(text.includes(dir), `missing ${dir}`)
    }
    assert.ok(text.includes('.gitkeep'))
  })

  test('merge step runs repo-guard apply and defers to the tm-repo-guard apply steps', () => {
    assert.ok(raw.includes('node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-repo-guard/repo-guard.mjs" apply <owner/name>'))
    assert.ok(text.includes('`.claude/skills/tm-repo-guard/SKILL.md`'))
    assert.ok(!text.includes('--confirm'), 'the skill must not carry its own confirm logic')
  })

  test('report step lists the manual steps left', () => {
    for (const w of ['e2e', 'architecture note', '/tm-advisor']) assert.ok(text.includes(w), `missing ${w}`)
  })
})

describe('tm-setup never rules', () => {
  test('never installs plugins, writes settings, or pushes to main', () => {
    assert.ok(text.includes('Never install a plugin'))
    assert.ok(text.includes('write a settings file'))
    assert.ok(text.includes('push to main'))
  })
})

describe('tm-setup is short', () => {
  test('stays well under tm-kickoff', () => {
    assert.ok(raw.split('\n').length <= 110, `${raw.split('\n').length} lines`)
  })
})

describe('pointers to tm-setup', () => {
  test('NEW-PROJECT-SETUP.md leads with /tm-setup', () => {
    assert.ok(collapse(read('NEW-PROJECT-SETUP.md')).slice(0, 600).includes('`/tm-setup`'))
  })

  test('README lists /tm-setup', () => {
    assert.ok(read('README.md').includes('/tm-setup'))
  })

  test('team guide mentions /tm-setup', () => {
    assert.ok(read('.claude', 'team-guide.md').includes('/tm-setup'))
  })
})
