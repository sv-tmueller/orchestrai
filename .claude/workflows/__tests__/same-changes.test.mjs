/**
 * Tests for the repair check "same changes" (issue #482).
 *
 * When the lead brings a queued PR up to date with the default branch, it asks
 * `same-changes.mjs` whether the PR's own changes are still the ones that were
 * reviewed. The script runs git only, so these tests build real temporary git
 * repos under the temp directory. They never touch this repo's refs, index or
 * worktree: every git call runs in the temp repo with its config isolated.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { normalizeDiff } from '../../skills/tm-kickoff/same-changes.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'same-changes.mjs')

// Isolated git: no user or system config, a fixed identity, and none of the
// GIT_* location variables a parent git hook could leave in the environment.
const GIT_ENV = (() => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name]
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
})()

function gitRaw(cwd, ...args) {
  return spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}

function git(cwd, ...args) {
  const r = gitRaw(cwd, ...args)
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`)
  }
  return r.stdout.trim()
}

function lines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`)
}

// Replaces one line (1-based) of a file.
function editLine(dir, name, lineNo, text) {
  const path = join(dir, name)
  const all = readFileSync(path, 'utf8').split('\n')
  all[lineNo - 1] = text
  writeFileSync(path, all.join('\n'))
}

function commitAll(dir, message) {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

// A repo with `main` at M0 (a.txt of 20 lines, b.txt) and a PR commit V on top
// of M0 that edits a.txt line 3. HEAD is left detached at V.
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'same-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), lines(20).join('\n'))
  writeFileSync(join(dir, 'b.txt'), 'b one\nb two')
  const m0 = commitAll(dir, 'base')
  git(dir, 'checkout', '-q', '--detach')
  editLine(dir, 'a.txt', 3, 'line 3 from the PR')
  const v = commitAll(dir, 'pr change')
  return { dir, m0, v }
}

// Adds a commit on main, then returns to the PR commit, detached.
function advanceMain(repo, edit) {
  git(repo.dir, 'checkout', '-q', 'main')
  edit(repo.dir)
  const tip = commitAll(repo.dir, 'main moves')
  git(repo.dir, 'checkout', '-q', '--detach', repo.v)
  return tip
}

// Merges main into the PR commit the way "update branch" does and returns the
// new head. `edit` runs between the merge and the commit.
function mergeMain(repo, edit) {
  git(repo.dir, 'checkout', '-q', '--detach', repo.v)
  git(repo.dir, 'merge', '--no-commit', '--no-ff', 'main')
  if (edit) edit(repo.dir)
  git(repo.dir, 'add', '-A')
  git(repo.dir, 'commit', '-q', '-m', 'merge main')
  return git(repo.dir, 'rev-parse', 'HEAD')
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  })
}

function check(repo, head, from = repo.v) {
  const r = run(repo.dir, '--from', from, '--head', head, '--default-ref', 'main')
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout.trim().split('\n').length, 1)
  const out = JSON.parse(r.stdout)
  assert.equal(typeof out.reason, 'string')
  return out.result
}

describe('same-changes: the four acceptance cases', () => {
  test('unchanged: the head is the verdict commit', (t) => {
    const repo = makeRepo(t)
    assert.equal(check(repo, repo.v), 'identical')
  })

  test('only the base changed: main moved in another file', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    assert.equal(check(repo, mergeMain(repo)), 'identical')
  })

  test('only the base changed: main moved in the same file, away from the PR lines', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'a.txt', 18, 'line 18 from main'))
    assert.equal(check(repo, mergeMain(repo)), 'identical')
  })

  // Line 5 sits inside the default three lines of diff context around the PR's
  // line 3, so only a zero-context diff keeps it out of the comparison.
  test('only the base changed: main moved in the same file, next to the PR lines', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'a.txt', 5, 'line 5 from main'))
    assert.equal(check(repo, mergeMain(repo)), 'identical')
  })

  test('changed: a commit on top of the verdict commit', (t) => {
    const repo = makeRepo(t)
    editLine(repo.dir, 'a.txt', 10, 'line 10 extra')
    assert.equal(check(repo, commitAll(repo.dir, 'extra')), 'changed')
  })

  test('changed: a clean merge that carries one extra line', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    const head = mergeMain(repo, (dir) => editLine(dir, 'a.txt', 10, 'line 10 extra'))
    assert.equal(check(repo, head), 'changed')
  })

  test('conflict resolved: main and the PR edit the same line', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'a.txt', 3, 'line 3 from main'))
    git(repo.dir, 'checkout', '-q', '--detach', repo.v)
    const merge = gitRaw(repo.dir, 'merge', '--no-commit', '--no-ff', 'main')
    assert.equal(merge.status, 1, 'the merge must conflict')
    editLine(repo.dir, 'a.txt', 3, 'line 3 from main and the PR')
    const head = commitAll(repo.dir, 'merge main, resolved')
    assert.equal(check(repo, head), 'conflict-resolved')
  })
})

describe('same-changes: further cases', () => {
  test('changed: main made the same change as the PR, so its own diff shrinks', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'a.txt', 3, 'line 3 from the PR'))
    assert.equal(check(repo, mergeMain(repo)), 'changed')
  })

  test('changed: the head does not contain the verdict commit (rebased)', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    git(repo.dir, 'checkout', '-q', '--detach', 'main')
    git(repo.dir, 'cherry-pick', repo.v)
    const head = git(repo.dir, 'rev-parse', 'HEAD')
    assert.equal(check(repo, head), 'changed')
  })

  test('changed: an added edit that only changes whitespace', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    const head = mergeMain(repo, (dir) => editLine(dir, 'a.txt', 3, 'line 3 from the PR '))
    assert.equal(check(repo, head), 'changed')
  })

  // Hunk headers are cut to `@@`, so the same added line at another position
  // gives an equal own diff. Only the merge-tree comparison catches it.
  test('changed: the PR added line sits somewhere else after the update', (t) => {
    const repo = makeRepo(t)
    const path = join(repo.dir, 'a.txt')
    git(repo.dir, 'checkout', '-q', '--detach', repo.m0)
    const original = readFileSync(path, 'utf8').split('\n')
    writeFileSync(path, [...original.slice(0, 3), 'added by the PR', ...original.slice(3)].join('\n'))
    const v = commitAll(repo.dir, 'pr adds a line')
    const moved = { ...repo, v }
    advanceMain(moved, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    const head = mergeMain(moved, (dir) => {
      writeFileSync(join(dir, 'a.txt'), [...original.slice(0, 10), 'added by the PR', ...original.slice(10)].join('\n'))
    })
    assert.equal(check(moved, head), 'changed')
  })

  test('identical: a whitespace-only PR change survives a clean update', (t) => {
    const repo = makeRepo(t)
    git(repo.dir, 'checkout', '-q', '--detach', repo.m0)
    editLine(repo.dir, 'a.txt', 3, 'line 3 ')
    const v = commitAll(repo.dir, 'trailing space')
    const moved = { ...repo, v }
    advanceMain(moved, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    assert.equal(check(moved, mergeMain(moved)), 'identical')
  })

  test('identical: main moves on again after the update', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    const head = mergeMain(repo)
    advanceMain({ ...repo, v: head }, (dir) => editLine(dir, 'b.txt', 2, 'b two moved'))
    assert.equal(check(repo, head), 'identical')
  })

  test('the script never changes refs, the index or the worktree', (t) => {
    const repo = makeRepo(t)
    advanceMain(repo, (dir) => editLine(dir, 'b.txt', 1, 'b one moved'))
    const head = mergeMain(repo)
    const snapshot = () =>
      [
        git(repo.dir, 'for-each-ref'),
        git(repo.dir, 'rev-parse', 'HEAD'),
        git(repo.dir, 'status', '--porcelain'),
      ].join('\n')
    const before = snapshot()
    check(repo, head)
    assert.equal(snapshot(), before)
  })
})

describe('same-changes: usage errors exit 2 with one stderr line and no stdout', () => {
  function assertUsageError(dir, ...args) {
    const r = run(dir, ...args)
    assert.equal(r.status, 2, `stdout: ${r.stdout}`)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr)
  }

  test('an unknown flag', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', repo.v, '--head', repo.v, '--default-ref', 'main', '--extra', 'x')
  })

  test('a duplicate flag', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', repo.v, '--from', repo.v, '--head', repo.v, '--default-ref', 'main')
  })

  test('a missing flag', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', repo.v, '--head', repo.v)
  })

  test('a flag with no value', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', repo.v, '--head', repo.v, '--default-ref')
  })

  test('a SHA that does not resolve', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', 'f'.repeat(40), '--head', repo.v, '--default-ref', 'main')
  })

  test('a ref that does not resolve', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', repo.v, '--head', repo.v, '--default-ref', 'no-such-branch')
  })

  test('a value that looks like a git option', (t) => {
    const repo = makeRepo(t)
    assertUsageError(repo.dir, '--from', repo.v, '--head', repo.v, '--default-ref', '--all')
  })

  test('a directory that is not a git repo', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'same-changes-empty-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assertUsageError(dir, '--from', 'a'.repeat(40), '--head', 'a'.repeat(40), '--default-ref', 'main')
  })
})

describe('normalizeDiff', () => {
  test('drops index lines and cuts hunk headers down to @@', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -3 +3 @@ line 2',
      '-line 3',
      '+line 3 changed',
      '',
    ].join('\n')
    assert.equal(
      normalizeDiff(text),
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@',
        '-line 3',
        '+line 3 changed',
        '',
      ].join('\n'),
    )
  })

  test('keeps whitespace in changed lines', () => {
    assert.notEqual(normalizeDiff('+a \n'), normalizeDiff('+a\n'))
  })

  test('does not treat a changed line that looks like an index line as one', () => {
    assert.equal(normalizeDiff('+index 1..2\n'), '+index 1..2\n')
    assert.equal(normalizeDiff('+@@ -1 +1 @@\n'), '+@@ -1 +1 @@\n')
  })
})
