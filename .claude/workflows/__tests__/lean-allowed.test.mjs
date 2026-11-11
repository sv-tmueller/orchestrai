/**
 * Tests for the lean check (issue #504).
 *
 * Before the lead puts a package on the lean track, it asks `lean-allowed.mjs`
 * whether the repo allows it: a repo set up for auto merge with no test files
 * must run the full track. The decision is pure; the CLI lists the files of
 * `origin/<default>` with git, so those tests build real temporary git repos
 * with their config isolated and never touch this repo's refs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { leanAllowed, blobPaths } from '../../skills/tm-kickoff/lean-allowed.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dir, '..', '..', 'skills', 'tm-kickoff', 'lean-allowed.mjs')

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

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`)
  }
  return r.stdout.trim()
}

// A repo whose `main` holds the given files. Returns the directory.
function makeRepo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'lean-allowed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'commit.gpgsign', 'false')
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

// Adds an index entry without a file on disk, so a newline or non-ASCII name
// never meets the file system (newline support, macOS Unicode normalization).
function addEntry(dir, mode, sha, path) {
  git(dir, 'update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`)
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  })
}

function flags(ref, { autoMerge = 'true', protectedBranch = 'true', rules = '0' } = {}) {
  return [
    '--default-ref', ref,
    '--auto-merge', autoMerge,
    '--branch-protected', protectedBranch,
    '--branch-rules', rules,
  ]
}

const SET_UP = { autoMerge: true, branchProtected: true, branchRules: 0 }
const NOT_SET_UP = { autoMerge: false, branchProtected: false, branchRules: 0 }

const NO_TESTS = 'no test files, and the repo counts as set up for auto merge'
const UNREADABLE =
  'the file list could not be read, and the repo counts as set up for auto merge'

describe('lean-allowed: the decision', () => {
  test('not set up: allowed with no test files', () => {
    assert.deepEqual(leanAllowed({ ...NOT_SET_UP, paths: ['README.md'] }), {
      allowed: true,
      reason: 'not set up for auto merge',
    })
  })

  test('not set up: allowed when the file list could not be read', () => {
    assert.deepEqual(leanAllowed({ ...NOT_SET_UP, paths: 'unknown' }), {
      allowed: true,
      reason: 'not set up for auto merge',
    })
  })

  test('auto merge on but no protection and no rules: not set up', () => {
    const out = leanAllowed({
      autoMerge: true,
      branchProtected: false,
      branchRules: 0,
      paths: ['README.md'],
    })
    assert.deepEqual(out, { allowed: true, reason: 'not set up for auto merge' })
  })

  test('auto merge off with protection and rules: not set up', () => {
    const out = leanAllowed({
      autoMerge: false,
      branchProtected: true,
      branchRules: 3,
      paths: ['README.md'],
    })
    assert.deepEqual(out, { allowed: true, reason: 'not set up for auto merge' })
  })

  test('set up by protection, with a test file: allowed', () => {
    const out = leanAllowed({ ...SET_UP, paths: ['README.md', 'src/a.test.js'] })
    assert.deepEqual(out, { allowed: true, reason: 'test files found' })
  })

  test('set up by rules, no test files: not allowed', () => {
    const out = leanAllowed({
      autoMerge: true,
      branchProtected: false,
      branchRules: 2,
      paths: ['README.md'],
    })
    assert.deepEqual(out, { allowed: false, reason: NO_TESTS })
  })

  test('set up, file list unreadable: not allowed', () => {
    assert.deepEqual(leanAllowed({ ...SET_UP, paths: 'unknown' }), {
      allowed: false,
      reason: UNREADABLE,
    })
  })

  test('a failed read counts as set up, as in Fix rounds rule 8', () => {
    const cases = [
      { autoMerge: 'unknown', branchProtected: false, branchRules: 0 },
      { autoMerge: false, branchProtected: 'unknown', branchRules: 0 },
      { autoMerge: false, branchProtected: false, branchRules: 'unknown' },
      { autoMerge: true, branchProtected: 'unknown', branchRules: 'unknown' },
    ]
    for (const reads of cases) {
      assert.deepEqual(
        leanAllowed({ ...reads, paths: ['README.md'] }),
        { allowed: false, reason: NO_TESTS },
        JSON.stringify(reads),
      )
    }
  })

  test('uses the repo guard rule: a Swift Tests file counts', () => {
    const out = leanAllowed({ ...SET_UP, paths: ['ios/AppTests/ModelTests.swift'] })
    assert.equal(out.allowed, true)
  })

  test('uses the repo guard rule: a fixture under __tests__ does not count', () => {
    const out = leanAllowed({ ...SET_UP, paths: ['__tests__/fixtures/data.json'] })
    assert.deepEqual(out, { allowed: false, reason: NO_TESTS })
  })

  test('the script imports the guard rule instead of copying it', () => {
    const source = readFileSync(scriptPath, 'utf8')
    assert.match(
      source,
      /import\s*\{[^}]*\bcountTestFiles\b[^}]*\}\s*from\s*'\.\.\/tm-repo-guard\/repo-guard\.mjs'/,
    )
    assert.doesNotMatch(source, /TEST_FILE_PATTERNS/)
  })

  test('malformed input throws', () => {
    assert.throws(() => leanAllowed({ ...SET_UP, autoMerge: 'yes', paths: [] }), /autoMerge/)
    assert.throws(() => leanAllowed({ ...SET_UP, branchProtected: null, paths: [] }), /branchProtected/)
    assert.throws(() => leanAllowed({ ...SET_UP, branchRules: -1, paths: [] }), /branchRules/)
    assert.throws(() => leanAllowed({ ...SET_UP, branchRules: 1.5, paths: [] }), /branchRules/)
    assert.throws(() => leanAllowed({ ...SET_UP, paths: 'nope' }), /paths/)
    assert.throws(() => leanAllowed({ ...SET_UP, paths: [1] }), /paths/)
    assert.throws(() => leanAllowed({ ...SET_UP }), /paths/)
  })
})

describe('lean-allowed: blobPaths', () => {
  test('keeps blobs and drops submodule entries', () => {
    const text =
      '100644 blob aaa\tREADME.md\0' +
      '160000 commit bbb\tvendor/lib\0' +
      '100755 blob ccc\tbin/run\0'
    assert.deepEqual(blobPaths(text), ['README.md', 'bin/run'])
  })

  test('keeps spaces and tabs inside a path', () => {
    assert.deepEqual(blobPaths('100644 blob aaa\tmy docs/a b.md\0'), ['my docs/a b.md'])
    assert.deepEqual(blobPaths('100644 blob aaa\ta\tb.md\0'), ['a\tb.md'])
  })

  test('handles a trailing NUL and empty input', () => {
    assert.deepEqual(blobPaths('100644 blob aaa\tx.md'), ['x.md'])
    assert.deepEqual(blobPaths('100644 blob aaa\tx.md\0'), ['x.md'])
    assert.deepEqual(blobPaths(''), [])
  })
})

describe('lean-allowed: the CLI on a temp repo', () => {
  test('a test file on the default ref: allowed', (t) => {
    const dir = makeRepo(t, { 'README.md': 'x', 'src/a.test.js': 'x' })
    const r = run(dir, ...flags('main'))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stderr, '')
    assert.equal(r.stdout.trim().split('\n').length, 1)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: true, reason: 'test files found' })
  })

  test('only a README: not allowed', (t) => {
    const dir = makeRepo(t, { 'README.md': 'x' })
    const r = run(dir, ...flags('main'))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: false, reason: NO_TESTS })
  })

  test('run from a subdirectory: still sees the whole tree', (t) => {
    const dir = makeRepo(t, { 'docs/guide.md': 'x', 'src/a.test.js': 'x' })
    const r = run(join(dir, 'docs'), ...flags('main'))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).allowed, true)
  })

  test('reads the ref, not the checkout', (t) => {
    const dir = makeRepo(t, { 'src/a.test.js': 'x' })
    git(dir, 'checkout', '-q', '--detach')
    git(dir, 'rm', '-q', 'src/a.test.js')
    git(dir, 'commit', '-q', '-m', 'drop the test')
    const r = run(dir, ...flags('main'))
    assert.equal(JSON.parse(r.stdout).allowed, true)
  })

  test('a ref that does not exist: unreadable, exit 0', (t) => {
    const dir = makeRepo(t, { 'src/a.test.js': 'x' })
    const r = run(dir, ...flags('origin/main'))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: false, reason: UNREADABLE })
  })

  test('--default-ref unknown: unreadable, git is not called', (t) => {
    const dir = makeRepo(t, { 'src/a.test.js': 'x' })
    // A git call would read this branch, find src/a.test.js and return allowed.
    git(dir, 'branch', 'unknown')
    const r = run(dir, ...flags('unknown'))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: false, reason: UNREADABLE })
  })

  test('a submodule entry named like a test file does not count', (t) => {
    const dir = makeRepo(t, { 'README.md': 'x' })
    addEntry(dir, '160000', git(dir, 'rev-parse', 'HEAD'), 'vendor/lib.test.js')
    git(dir, 'commit', '-q', '-m', 'add a submodule entry')
    assert.match(git(dir, 'ls-tree', '-r', 'main'), /^160000 commit /m)
    const r = run(dir, ...flags('main'))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: false, reason: NO_TESTS })
  })

  test('a newline in a directory and non-ASCII in the file name: test file found', (t) => {
    const dir = makeRepo(t, { 'README.md': 'x' })
    addEntry(dir, '100644', git(dir, 'rev-parse', 'HEAD:README.md'), 'déjà\nvu/café.test.js')
    git(dir, 'commit', '-q', '-m', 'add an odd path')
    const r = run(dir, ...flags('main'))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: true, reason: 'test files found' })
  })

  test('not set up: --default-ref unknown is still allowed', (t) => {
    const dir = makeRepo(t, { 'README.md': 'x' })
    const r = run(
      dir,
      ...flags('unknown', { autoMerge: 'false', protectedBranch: 'false', rules: '0' }),
    )
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: true, reason: 'not set up for auto merge' })
  })
})

describe('lean-allowed: usage errors exit 2 with one stderr line', () => {
  const good = flags('main')

  function expectUsage(args) {
    const dir = mkdtempSync(join(tmpdir(), 'lean-allowed-usage-'))
    try {
      const r = run(dir, ...args)
      assert.equal(r.status, 2, `args ${args.join(' ')}`)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr.trim().split('\n').length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('no arguments', () => expectUsage([]))
  test('an unknown flag', () => expectUsage([...good, '--bogus', 'x']))
  test('a repeated flag', () => expectUsage([...good, '--auto-merge', 'false']))
  test('a missing flag', () => expectUsage(good.slice(2)))
  test('a flag with no value', () => expectUsage([...good.slice(0, -1)]))
  test('a bad tri-state', () => expectUsage(flags('main', { autoMerge: 'maybe' })))
  test('a bad rules count', () => expectUsage(flags('main', { rules: '-1' })))
  test('an empty ref', () => expectUsage(flags('')))
  test('a ref that starts with a dash', () => expectUsage(flags('--output=x')))
})
