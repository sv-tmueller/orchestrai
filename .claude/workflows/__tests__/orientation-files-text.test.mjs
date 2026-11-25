/**
 * Pins the split between the two orientation files (issue #429, batch #603).
 *
 * AGENTS.md is the one orientation file for every harness. CLAUDE.md is a thin
 * import of it plus the Claude-only lines. Five checks keep that split honest:
 * the imports are there and in order, no section is written twice, AGENTS.md
 * still has the "Useful commands" section the developer, the reviewer and the adapter prompts
 * cite, AGENTS.md stays free of Claude's import syntax, and CLAUDE.md points a
 * reader at AGENTS.md from the paragraph that names "Useful commands".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = join(__dir, '..', '..', '..')

const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

const headings = (text) => text.split('\n').filter((l) => /^#{2,3} /.test(l))

test('CLAUDE.md imports AGENTS.md, process-core.md and team-guide.md, in that order', () => {
  const lines = claude.split('\n')
  const at = ['@AGENTS.md', '@.claude/process-core.md', '@.claude/team-guide.md']
    .map((line) => lines.indexOf(line))
  assert.ok(at.every((i) => i >= 0), `an import line is missing: ${at}`)
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the imports are out of order')
})

test('no ## or ### heading appears in both files', () => {
  const inAgents = new Set(headings(agents))
  const shared = headings(claude).filter((h) => inAgents.has(h))
  assert.deepEqual(shared, [])
})

test('AGENTS.md has a Useful commands section whose code block holds a command', () => {
  const m = agents.match(/^## Useful commands\n([\s\S]*?)(?=^## |(?![\s\S]))/m)
  assert.ok(m, 'AGENTS.md has no "## Useful commands" heading')
  const block = m[1].match(/```[^\n]*\n([\s\S]*?)```/)
  assert.ok(block, 'the section has no code block')
  const commands = block[1].split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
  assert.ok(commands.length >= 1, 'the code block holds no command line')
})

test('AGENTS.md uses no @ import syntax', () => {
  // This is the pattern Claude Code follows for imports.
  assert.equal(agents.match(/(?:^|\s)@(?:[^\s\\]|\\ )+/), null)
})

test('the CLAUDE.md paragraph that names Useful commands also names AGENTS.md', () => {
  const paragraph = claude.split(/\n\s*\n/).find((p) => p.includes('Useful commands'))
  assert.ok(paragraph, 'no CLAUDE.md paragraph names "Useful commands"')
  assert.ok(paragraph.includes('AGENTS.md'), 'that paragraph does not name AGENTS.md')
})
