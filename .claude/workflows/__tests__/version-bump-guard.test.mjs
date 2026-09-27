/**
 * Guard-lock test for the version-bump guard (issue #362).
 *
 * `.claude/agents/`, `.claude/skills/`, `.claude/workflows/`, and
 * `.claude/adapters/` are the plugin's shipped surface: `/plugin update`
 * pulls a pinned version, so a PR that changes seat, skill, workflow, or
 * adapter behavior without bumping `.claude/.claude-plugin/plugin.json`
 * ships silently to every config dir on the next update. This test locks
 * the pure decision function the CI job and the CLI both call, so the
 * policy lives in one tested place instead of duplicated in YAML.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUARDED,
  EXCLUDED,
  SKIP_LABEL,
  isGuarded,
  checkVersionBump,
} from '../../../scripts/check-version-bump.mjs'

describe('isGuarded', () => {
  test('matches each of the four guarded prefixes', () => {
    assert.equal(isGuarded('.claude/agents/developer.md'), true)
    assert.equal(isGuarded('.claude/skills/tm-kickoff/SKILL.md'), true)
    assert.equal(isGuarded('.claude/workflows/tm-review-changes.js'), true)
    assert.equal(isGuarded('.claude/adapters/claude-code.json'), true)
  })

  test('excludes the workflow test directory, including non-test files in it', () => {
    assert.equal(
      isGuarded('.claude/workflows/__tests__/version-bump-guard.test.mjs'),
      false
    )
    assert.equal(
      isGuarded('.claude/workflows/__tests__/fixtures/sample.json'),
      false
    )
  })

  test('does not guard team-guide, process-core, settings, or plugin.json', () => {
    assert.equal(isGuarded('.claude/team-guide.md'), false)
    assert.equal(isGuarded('.claude/process-core.md'), false)
    assert.equal(isGuarded('.claude/settings.json'), false)
    assert.equal(isGuarded('.claude/.claude-plugin/plugin.json'), false)
  })

  test('does not guard scripts, .github, docs, or README', () => {
    assert.equal(isGuarded('scripts/check-version-bump.mjs'), false)
    assert.equal(isGuarded('.github/workflows/ci.yml'), false)
    assert.equal(isGuarded('docs/plans/362-version-bump-guard.md'), false)
    assert.equal(isGuarded('README.md'), false)
  })

  test('respects the prefix boundary: a sibling file is not a guarded directory', () => {
    assert.equal(isGuarded('.claude/agents-notes.md'), false)
  })

  test('exposes GUARDED, EXCLUDED, and SKIP_LABEL as the documented constants', () => {
    assert.deepEqual(GUARDED, [
      '.claude/agents/',
      '.claude/skills/',
      '.claude/workflows/',
      '.claude/adapters/',
    ])
    assert.deepEqual(EXCLUDED, ['.claude/workflows/__tests__/'])
    assert.equal(SKIP_LABEL, 'skip-version-bump')
  })
})

describe('checkVersionBump', () => {
  test('passes when no guarded files changed', () => {
    const result = checkVersionBump({
      changedFiles: ['README.md', '.claude/team-guide.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: [],
    })
    assert.equal(result.ok, true)
  })

  test('fails when guarded files changed, version is unchanged, and no skip label', () => {
    const result = checkVersionBump({
      changedFiles: ['.claude/agents/developer.md', 'README.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: [],
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.guardedChanged, ['.claude/agents/developer.md'])
    assert.match(result.message, /\.claude\/agents\/developer\.md/)
    assert.match(result.message, /plugin\.json/)
    assert.match(result.message, /skip-version-bump/)
  })

  test('passes when the plugin version changed', () => {
    const result = checkVersionBump({
      changedFiles: ['.claude/agents/developer.md'],
      baseVersion: '2.3.0',
      headVersion: '2.4.0',
      labels: [],
    })
    assert.equal(result.ok, true)
  })

  test('passes when the skip label is present', () => {
    const result = checkVersionBump({
      changedFiles: ['.claude/agents/developer.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: ['skip-version-bump'],
    })
    assert.equal(result.ok, true)
  })

  test('another label alone still fails', () => {
    const result = checkVersionBump({
      changedFiles: ['.claude/agents/developer.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: ['size:S'],
    })
    assert.equal(result.ok, false)
  })

  test('an empty changed-file list passes regardless of version or labels', () => {
    const result = checkVersionBump({
      changedFiles: [],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: [],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.guardedChanged, [])
  })

  test('label parsing tolerates a missing or non-array labels value', () => {
    const missing = checkVersionBump({
      changedFiles: ['.claude/agents/developer.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
    })
    assert.equal(missing.ok, false)

    const malformed = checkVersionBump({
      changedFiles: ['.claude/agents/developer.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: 'skip-version-bump',
    })
    assert.equal(malformed.ok, false)
  })
})
