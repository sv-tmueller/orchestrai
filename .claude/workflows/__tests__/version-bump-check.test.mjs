/**
 * Version bump check (issue #411).
 *
 * CI fails a PR that changes seat or skill behavior (anything under
 * .claude/agents/, .claude/skills/, .claude/workflows/ outside __tests__/,
 * or .claude/adapters/) without also bumping the plugin version, unless the
 * PR carries the skip-version-bump label. This file covers the pure
 * decision functions (isGuarded, decide) and the CLI end to end against
 * real temp git repos, in the same shape CI invokes it (base ref = HEAD^1
 * of a --no-ff merge commit).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { isGuarded, decide } from '../../../scripts/check-version-bump.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dir, '..', '..', '..', 'scripts', 'check-version-bump.mjs')

describe('isGuarded', () => {
  const guardedCases = [
    '.claude/agents/developer.md',
    '.claude/skills/tm-kickoff/SKILL.md',
    '.claude/workflows/tm-review-changes.js',
    '.claude/workflows/prompts/critic.md',
    '.claude/workflows/specs/foo.md',
    '.claude/adapters/codex.js',
  ]

  for (const path of guardedCases) {
    test(`${path} is guarded`, () => {
      assert.equal(isGuarded(path), true)
    })
  }

  const unguardedCases = [
    '.claude/workflows/__tests__/version-bump-check.test.mjs',
    '.claude/workflows/__tests__/fixtures/sample.json',
    '.claude/team-guide.md',
    '.claude/process-core.md',
    '.claude/settings.json',
    '.claude/.claude-plugin/plugin.json',
    'docs/architecture/role-contracts.md',
    'scripts/check-version-bump.mjs',
    '.claude/agentsX/rogue.md',
  ]

  for (const path of unguardedCases) {
    test(`${path} is not guarded`, () => {
      assert.equal(isGuarded(path), false)
    })
  }
})

describe('decide', () => {
  const base = { baseVersion: '2.3.0', headVersion: '2.3.0', labels: [] }

  test('passes when no guarded files changed', () => {
    const result = decide({ ...base, changedFiles: ['docs/foo.md', 'scripts/test.mjs'] })
    assert.equal(result.pass, true)
  })

  test('fails on guarded files with the version unchanged and no labels', () => {
    const result = decide({ ...base, changedFiles: ['.claude/agents/developer.md'] })
    assert.equal(result.pass, false)
  })

  test('fails on guarded files with only unrelated labels', () => {
    const result = decide({
      ...base,
      changedFiles: ['.claude/skills/tm-kickoff/SKILL.md'],
      labels: ['size:M', 'phase:dev'],
    })
    assert.equal(result.pass, false)
  })

  test('passes when the version changed', () => {
    const result = decide({
      changedFiles: ['.claude/agents/developer.md'],
      baseVersion: '2.3.0',
      headVersion: '2.4.0',
      labels: [],
    })
    assert.equal(result.pass, true)
  })

  test('passes when the skip-version-bump label is present', () => {
    const result = decide({
      ...base,
      changedFiles: ['.claude/agents/developer.md'],
      labels: ['skip-version-bump'],
    })
    assert.equal(result.pass, true)
  })
})

describe('CLI', () => {
  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'version-bump-check-'))
    const git = (args) =>
      spawnSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })

    git(['init', '-q', '-b', 'main'])
    git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'init'])
    return { dir, git }
  }

  function writePluginJson(dir, version) {
    mkdirSync(join(dir, '.claude', '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'orchestrai', version }, null, 2) + '\n'
    )
  }

  // Builds a base commit (with plugin.json at baseVersion, plus anything
  // `seedBase` adds), a PR-branch commit applying `applyChange` (which
  // receives the repo dir and the `git` helper, so it can `git mv` a file
  // seeded in the base commit), and a --no-ff merge commit onto main, then
  // runs the script with HEAD^1 (the exact shape CI uses on a PR's
  // test-merge commit). Returns the spawnSync result.
  function runCase({ baseVersion, seedBase, applyChange, env = {} }) {
    const { dir, git } = makeRepo()
    const commit = (msg) =>
      git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', msg])

    writePluginJson(dir, baseVersion)
    if (seedBase) seedBase(dir)
    git(['add', '-A'])
    commit('base: seed plugin.json')

    git(['checkout', '-q', '-b', 'pr-branch'])
    applyChange(dir, git)
    git(['add', '-A'])
    commit('pr: apply change')

    git(['checkout', '-q', 'main'])
    git([
      '-c', 'user.name=test', '-c', 'user.email=test@example.com',
      'merge', '--no-ff', '-q', '-m', 'merge pr-branch', 'pr-branch',
    ])

    return spawnSync(process.execPath, [scriptPath, 'HEAD^1'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
  }

  function guardedChange(dir) {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'changed behavior\n')
  }

  test('no bump: exits 1', () => {
    const result = runCase({ baseVersion: '2.3.0', applyChange: guardedChange })
    assert.equal(result.status, 1)
  })

  test('bump: exits 0', () => {
    const result = runCase({
      baseVersion: '2.3.0',
      applyChange: (dir) => {
        guardedChange(dir)
        writePluginJson(dir, '2.4.0')
      },
    })
    assert.equal(result.status, 0)
  })

  test('skip-version-bump label: exits 0', () => {
    const result = runCase({
      baseVersion: '2.3.0',
      applyChange: guardedChange,
      env: { PR_LABELS: '["skip-version-bump"]' },
    })
    assert.equal(result.status, 0)
  })

  test('rename out of .claude/skills/: exits 1', () => {
    // Seed the guarded file in the base commit (unchanged content), then
    // git mv it to an unguarded path in the PR commit. Git sees this as a
    // rename, which is exactly the case --no-renames guards against: without
    // that flag, the diff would show only the new, unguarded path and the
    // guarded change would slip through undetected.
    const result = runCase({
      baseVersion: '2.3.0',
      seedBase: (dir) => {
        mkdirSync(join(dir, '.claude', 'skills', 'tm-foo'), { recursive: true })
        writeFileSync(join(dir, '.claude', 'skills', 'tm-foo', 'SKILL.md'), 'skill\n')
      },
      applyChange: (dir, git) => {
        mkdirSync(join(dir, 'docs'), { recursive: true })
        git(['mv', join('.claude', 'skills', 'tm-foo', 'SKILL.md'), join('docs', 'SKILL.md')])
      },
    })
    assert.equal(result.status, 1)
  })

  test('only __tests__ changed: exits 0', () => {
    const result = runCase({
      baseVersion: '2.3.0',
      applyChange: (dir) => {
        mkdirSync(join(dir, '.claude', 'workflows', '__tests__'), { recursive: true })
        writeFileSync(join(dir, '.claude', 'workflows', '__tests__', 'new.test.mjs'), 'test\n')
      },
    })
    assert.equal(result.status, 0)
  })
})
