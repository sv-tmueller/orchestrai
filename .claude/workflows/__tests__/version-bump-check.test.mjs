/**
 * Tests for the version-bump CI check (issue #412).
 *
 * `scripts/check-version-bump.mjs` is repo-only CI tooling, not plugin
 * behavior. It exports pure `isGuarded` and `check` plus a guarded CLI
 * `main()`. The CLI tests build a throwaway git repo with the same shape
 * CI sees on a pull_request run: a merge commit whose first parent is the
 * base tip, checked with `--base HEAD^1`.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

import { isGuarded, check, SKIP_LABEL } from '../../../scripts/check-version-bump.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dir, '..', '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'check-version-bump.mjs')
const ciPath = join(repoRoot, '.github', 'workflows', 'ci.yml')

describe('isGuarded', () => {
  for (const path of [
    '.claude/agents/tester.md',
    '.claude/skills/tm-kickoff/SKILL.md',
    '.claude/skills/tm-new-project/templates/ci.yml',
    '.claude/workflows/tm-review-changes.js',
    '.claude/workflows/prompts/critic.md',
    '.claude/workflows/specs/review.json',
    '.claude/adapters/codex.json',
  ]) {
    test(`guards ${path}`, () => {
      assert.equal(isGuarded(path), true)
    })
  }

  for (const path of [
    '.claude/workflows/__tests__/effort-policy.test.mjs',
    '.claude/workflows/__tests__/fixtures/token-report/lead.jsonl',
    '.claude/team-guide.md',
    '.claude/process-core.md',
    '.claude/settings.json',
    '.claude/.claude-plugin/plugin.json',
    '.claude/agents-old/tester.md',
    'docs/plans/412-version-bump-check.md',
    'README.md',
    'scripts/check-version-bump.mjs',
  ]) {
    test(`does not guard ${path}`, () => {
      assert.equal(isGuarded(path), false)
    })
  }
})

describe('check', () => {
  const agentEdit = ['.claude/agents/tester.md', 'README.md']

  test('fails a guarded change with the version unchanged and no skip label', () => {
    const result = check({
      changedFiles: agentEdit,
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: [],
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /\.claude\/agents\/tester\.md/)
    assert.doesNotMatch(result.message, /README\.md/)
    assert.match(result.message, /\.claude\/\.claude-plugin\/plugin\.json/)
    assert.match(result.message, new RegExp(SKIP_LABEL))
  })

  test('passes a guarded change when the version changed', () => {
    const result = check({
      changedFiles: agentEdit,
      baseVersion: '2.3.0',
      headVersion: '2.4.0',
      labels: [],
    })
    assert.equal(result.ok, true)
    assert.match(result.message, /2\.3\.0 -> 2\.4\.0/)
  })

  test('passes a guarded change with the version unchanged when the skip label is present', () => {
    const result = check({
      changedFiles: agentEdit,
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: ['size:S', SKIP_LABEL],
    })
    assert.equal(result.ok, true)
    assert.match(result.message, new RegExp(SKIP_LABEL))
  })

  test('other labels do not skip the check', () => {
    const result = check({
      changedFiles: agentEdit,
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: ['size:S', 'documentation'],
    })
    assert.equal(result.ok, false)
  })

  test('passes when no guarded path changed', () => {
    const result = check({
      changedFiles: ['.claude/team-guide.md', '.claude/workflows/__tests__/x.test.mjs', 'docs/a.md'],
      baseVersion: '2.3.0',
      headVersion: '2.3.0',
      labels: [],
    })
    assert.equal(result.ok, true)
  })
})

describe('CLI against a PR merge commit', () => {
  let repo

  function git(...args) {
    const r = spawnSync(
      'git',
      [
        '-c', 'user.name=test',
        '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' }
    )
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout
  }

  function write(path, content) {
    mkdirSync(join(repo, dirname(path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }

  function setVersion(version) {
    write('.claude/.claude-plugin/plugin.json', JSON.stringify({ name: 'orchestrai', version }, null, 2) + '\n')
  }

  // Branches a feature off base, applies `change`, and merges it into a
  // fresh copy of base with --no-ff, so HEAD^1 is the base tip as in CI.
  function mergedPr(name, change) {
    git('checkout', '-q', '-b', `feat/${name}`, 'base')
    change()
    git('add', '-A')
    git('commit', '-q', '-m', `feat: ${name}`)
    git('checkout', '-q', '-b', `merge/${name}`, 'base')
    git('merge', '-q', '--no-ff', '-m', `merge ${name}`, `feat/${name}`)
  }

  function run(labels) {
    const env = { ...process.env }
    delete env.PR_LABELS
    if (labels !== undefined) env.PR_LABELS = JSON.stringify(labels)
    return spawnSync(process.execPath, [scriptPath, '--base', 'HEAD^1'], {
      cwd: repo,
      env,
      encoding: 'utf8',
    })
  }

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'version-bump-check-'))
    git('init', '-q', '-b', 'base')
    setVersion('2.3.0')
    write('.claude/agents/tester.md', 'tester\n')
    write('.claude/skills/tm-x/SKILL.md', 'skill\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('exits 1 on an agent edit without a version bump', () => {
    mergedPr('no-bump', () => write('.claude/agents/tester.md', 'tester v2\n'))
    const r = run([])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /\.claude\/agents\/tester\.md/)
  })

  test('exits 0 on the same edit with a version bump', () => {
    mergedPr('bump', () => {
      write('.claude/agents/tester.md', 'tester v2\n')
      setVersion('2.4.0')
    })
    const r = run([])
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

  test('exits 0 on the same edit without a bump when the skip label is present', () => {
    mergedPr('skip', () => write('.claude/agents/tester.md', 'tester v2\n'))
    const r = run([SKIP_LABEL])
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

  test('exits 1 when a skill file moves out of a guarded path without a bump', () => {
    mergedPr('move', () => git('mv', '.claude/skills/tm-x/SKILL.md', 'SKILL.md'))
    const r = run([])
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, /\.claude\/skills\/tm-x\/SKILL\.md/)
  })

  test('exits 1 with a message when --base is missing', () => {
    const r = spawnSync(process.execPath, [scriptPath], { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--base/)
  })
})

describe('repo CI workflow', () => {
  const src = existsSync(ciPath) ? readFileSync(ciPath, 'utf8') : ''
  const jobsBlock = src.split(/\njobs:\n/)[1] ?? ''
  const jobSrc = jobsBlock.split(/^  version-bump:\n/m)[1]
  const nextJobIdx = jobSrc?.search(/^  \w[\w-]*:\n/m) ?? -1
  const body = jobSrc === undefined ? '' : nextJobIdx === -1 ? jobSrc : jobSrc.slice(0, nextJobIdx)

  test('defines a version-bump job', () => {
    assert.ok(jobSrc !== undefined, 'expected a version-bump job in ci.yml')
  })

  test('the version-bump job pins timeout-minutes', () => {
    assert.match(body, /timeout-minutes:\s*\d+/)
  })

  test('the version-bump job fetches the merge commit parent it diffs against', () => {
    assert.match(body, /fetch-depth:\s*2/)
    assert.match(body, /--base HEAD\^1/)
  })

  test('the pull_request trigger re-runs on label changes', () => {
    assert.match(src, /types:\s*\[[^\]]*\blabeled\b[^\]]*\]/)
    assert.match(src, /types:\s*\[[^\]]*\bunlabeled\b[^\]]*\]/)
  })
})
