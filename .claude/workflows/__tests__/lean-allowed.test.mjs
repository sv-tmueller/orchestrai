/**
 * Tests for the lean check (issues #504 and #589).
 *
 * Before the lead puts a package on the lean track, it asks `lean-allowed.mjs`.
 * The package must be size:S, touch no forced-full path and stay within the
 * line cap, and the repo must allow it: a repo set up for auto merge with no
 * test files must run the full track. Both decisions are pure; the CLI reads
 * the diff and the files of `origin/<default>` with git, so those tests build
 * real temporary git repos with their config isolated and never touch this
 * repo's refs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import {
  leanAllowed,
  blobPaths,
  packageAllowed,
  parseNumstat,
  forcedFull,
  countedLines,
  LINE_CAP,
} from '../../skills/tm-kickoff/lean-allowed.mjs'

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

function flags(
  ref,
  {
    autoMerge = 'true',
    protectedBranch = 'true',
    rules = '0',
    size = 'S',
    diffHead = 'none',
    issuePaths = 'none',
  } = {},
) {
  return [
    '--default-ref', ref,
    '--auto-merge', autoMerge,
    '--branch-protected', protectedBranch,
    '--branch-rules', rules,
    '--size', size,
    '--diff-head', diffHead,
    '--issue-paths', issuePaths,
  ]
}

// Commits the given files on a new branch off the current commit, then goes
// back to main. `change` runs in between, for a rename or a delete.
function branch(dir, name, files, change = () => {}) {
  git(dir, 'checkout', '-q', '-b', name)
  for (const [file, body] of Object.entries(files)) {
    const path = join(dir, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  change()
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', name)
  git(dir, 'checkout', '-q', 'main')
}

function lines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i}\n`).join('')
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

describe('lean-allowed: the package rule', () => {
  const c = (path, added, deleted = 0) => ({ path, added, deleted })
  const pkg = (over) => packageAllowed({ size: 'S', issuePaths: [], changes: 'none', ...over })

  test('the cap is 150 counted lines', () => {
    assert.equal(LINE_CAP, 150)
  })

  test('size S, no diff yet, no issue paths: allowed', () => {
    assert.equal(pkg({}).allowed, true)
  })

  for (const size of ['M', 'L', 'XL', 'none']) {
    test(`size ${size}: not allowed, the reason names the size`, () => {
      const r = pkg({ size })
      assert.equal(r.allowed, false)
      assert.ok(r.reason.includes(size), r.reason)
    })
  }

  test('150 counted lines: allowed', () => {
    assert.equal(pkg({ changes: [c('src/a.ts', 100, 50)] }).allowed, true)
  })

  test('151 counted lines: not allowed, the reason names 151 and 150', () => {
    const r = pkg({ changes: [c('src/a.ts', 100, 50), c('src/b.py', 1)] })
    assert.equal(r.allowed, false)
    assert.ok(r.reason.includes('151') && r.reason.includes('150'), r.reason)
  })

  test('test files and docs do not count', () => {
    const changes = [
      c('src/a.ts', 150),
      c('src/a.test.ts', 900),
      c('docs/x.md', 900),
      c('NOTES.MD', 900),
      c('guide.rst', 900),
      c('page.mdx', 900),
    ]
    assert.equal(countedLines(changes), 150)
    assert.equal(pkg({ changes }).allowed, true)
  })

  test('a .txt file counts as code: build files and pinned lists are plain text', () => {
    assert.equal(countedLines([c('CMakeLists.txt', 900)]), 900)
    assert.equal(pkg({ changes: [c('CMakeLists.txt', 151)] }).allowed, false)
  })

  for (const path of ['requirements-dev.txt', 'api/requirements_test.txt', 'constraints.txt']) {
    test(`forced full, a pinned dependency list: ${path}`, () => {
      assert.equal(forcedFull(path), true)
    })
  }

  for (const path of [' .claude/skills', './.claude/skills/x/SKILL.md', '/.github/workflows/ci.yml', '.claude/agents/']) {
    test(`forced full from an issue path written as ${JSON.stringify(path)}`, () => {
      assert.equal(pkg({ issuePaths: [path] }).allowed, false)
    })
  }

  const NO_COUNT = (path) =>
    `${path} has no line count (binary, or marked binary or -diff), so the line cap cannot be checked`
  const nc = (path) => ({ path, added: null, deleted: null })

  test('a file with no line count: not allowed, the reason names the first such file', () => {
    assert.deepEqual(pkg({ changes: [c('src/a.ts', 1), nc('art/logo.png'), nc('b.bin')] }), {
      allowed: false,
      reason: NO_COUNT('art/logo.png'),
    })
  })

  test('a no-count entry that is a test file or a doc does not block and adds no lines', () => {
    const changes = [nc('src/a.test.js'), nc('docs/shot.md'), c('src/a.ts', 150)]
    assert.equal(countedLines(changes), 150)
    assert.equal(pkg({ changes }).allowed, true)
  })

  test('a mode-only change and an empty file count zero and are allowed', () => {
    assert.equal(pkg({ changes: [c('run.sh', 0, 0), c('src/empty.js', 0, 0)] }).allowed, true)
  })

  test('a forced-full path is reported before a no-count file', () => {
    const r = pkg({ changes: [nc('art/logo.png'), c('package.json', 1)] })
    assert.equal(r.allowed, false)
    assert.equal(r.reason, 'forced-full path: package.json')
  })

  test('a no-count file is reported before the line cap', () => {
    const r = pkg({ changes: [c('src/a.ts', 500), nc('art/logo.png')] })
    assert.equal(r.reason, NO_COUNT('art/logo.png'))
  })

  test('an empty diff: not allowed', () => {
    assert.deepEqual(pkg({ changes: [] }), { allowed: false, reason: 'the diff is empty' })
  })

  test('no diff yet is still allowed', () => {
    assert.equal(pkg({ changes: 'none' }).allowed, true)
  })

  test('the size check comes before the empty diff check', () => {
    assert.ok(pkg({ size: 'M', changes: [] }).reason.includes('size is M'))
  })

  test('the issue path check comes before the empty diff check', () => {
    assert.equal(pkg({ issuePaths: ['.claude'], changes: [] }).reason, 'forced-full path: .claude')
  })

  test('an unreadable diff: not allowed', () => {
    assert.equal(pkg({ changes: 'unknown' }).allowed, false)
  })

  for (const path of [
    '.claude/agents/reviewer.md',
    '.claude/skills/x/SKILL.md',
    '.claude/workflows/a.js',
    '.github/workflows/ci.yml',
    'package.json',
    'apps/web/package.json',
    'pnpm-lock.yaml',
    'uv.lock',
    'go.sum',
    'Package.resolved',
  ]) {
    test(`forced full in the diff: ${path}`, () => {
      const r = pkg({ changes: [c(path, 1)] })
      assert.equal(r.allowed, false)
      assert.ok(r.reason.includes(path), r.reason)
    })
  }

  for (const [written, normalized] of [
    ['.claude', '.claude'],
    ['.github', '.github'],
    ['`.claude/skills/x`', '.claude/skills/x'],
    ['.claude//skills/x', '.claude/skills/x'],
    ['"./.claude/workflows/"', '.claude/workflows'],
    ["'.github/workflows/ci.yml'", '.github/workflows/ci.yml'],
  ]) {
    test(`forced full from the issue path ${written}, the reason names ${normalized}`, () => {
      const r = pkg({ issuePaths: [written] })
      assert.equal(r.allowed, false)
      assert.equal(r.reason, `forced-full path: ${normalized}`)
    })
  }

  test('the issue path src is a parent of nothing forced: allowed', () => {
    assert.equal(pkg({ issuePaths: ['src'] }).allowed, true)
  })

  test('an issue path that is empty after normalization throws', () => {
    for (const path of ['``', '""', '/', './', '  ']) {
      assert.throws(() => pkg({ issuePaths: [path] }), /issuePaths/, JSON.stringify(path))
    }
  })

  test('an issue path that is not a plain repo-relative path throws', () => {
    for (const path of [
      '.claude/./skills/x',
      '.claude/skills/../skills/x',
      'src/*.js',
      '**/package.json',
      'src\\a.js',
      'src/a`b.js',
    ]) {
      assert.throws(() => pkg({ issuePaths: [path] }), /issuePaths/, JSON.stringify(path))
    }
  })

  test('an issue path with spaces around the name inside backticks is trimmed', () => {
    const r = pkg({ issuePaths: ['` .claude `'] })
    assert.equal(r.allowed, false)
    assert.ok(r.reason.includes('.claude'), r.reason)
  })

  test('a space inside a directory name is a legal issue path', () => {
    assert.equal(pkg({ issuePaths: ['Generic Scripted REST API/x.js'] }).allowed, true)
  })

  test('paths from the diff are not normalized', () => {
    assert.equal(pkg({ changes: [c('.claude', 1)] }).allowed, true)
  })

  test('forced full from the issue paths, directory named without a slash', () => {
    const r = pkg({ issuePaths: ['.claude/skills'] })
    assert.equal(r.allowed, false)
    assert.ok(r.reason.includes('.claude/skills'), r.reason)
  })

  test('near misses are not forced full', () => {
    for (const path of [
      '.claude/skills-notes.md',
      'docs/.github/workflows/x.yml',
      '.claude/settings.json',
      'src/package.json.ts',
    ]) {
      assert.equal(forcedFull(path), false, path)
    }
  })

  test('the manifest names come from the repo guard, not a copy', () => {
    const src = readFileSync(scriptPath, 'utf8')
    assert.match(src, /MANIFESTS/)
    assert.doesNotMatch(src, /'pyproject\.toml'/)
  })

  test('malformed input throws', () => {
    assert.throws(() => pkg({ size: 's' }), /size/)
    assert.throws(() => pkg({ issuePaths: 'src/a.js' }), /issuePaths/)
    assert.throws(() => pkg({ changes: 'nope' }), /changes/)
    assert.throws(() => pkg({ changes: [{ path: 'a', added: -1, deleted: 0 }] }), /changes/)
  })
})

describe('lean-allowed: parseNumstat', () => {
  test('reads counts and paths from -z output', () => {
    assert.deepEqual(parseNumstat('3\t1\tsrc/a.ts\x0010\t0\tb.md\x00'), [
      { path: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'b.md', added: 10, deleted: 0 },
    ])
  })

  test('a binary entry has no counts, not zero counts', () => {
    assert.deepEqual(parseNumstat('-\t-\tart/logo.png\x00'), [
      { path: 'art/logo.png', added: null, deleted: null },
    ])
  })

  test('a 0 0 entry keeps its zero counts', () => {
    assert.deepEqual(parseNumstat('0\t0\trun.sh\x00'), [{ path: 'run.sh', added: 0, deleted: 0 }])
  })

  test('keeps a tab, a newline and non-ASCII inside a path', () => {
    assert.deepEqual(parseNumstat('1\t0\tdir\twith\ttab/fü\nr.js\x00'), [
      { path: 'dir\twith\ttab/fü\nr.js', added: 1, deleted: 0 },
    ])
  })

  test('empty output is an empty list', () => {
    assert.deepEqual(parseNumstat(''), [])
  })

  test('an entry that is not numstat throws', () => {
    assert.throws(() => parseNumstat('garbage\x00'), /numstat/)
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

describe('lean-allowed: the CLI with a diff', () => {
  const BASE = { 'README.md': 'x', 'src/a.test.js': 'x' }

  function decide(dir, opts) {
    const r = run(dir, ...flags('main', opts))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stderr, '')
    return JSON.parse(r.stdout)
  }

  test('no diff yet, size S: allowed', (t) => {
    const dir = makeRepo(t, BASE)
    assert.deepEqual(decide(dir, {}), { allowed: true, reason: 'test files found' })
  })

  test('size M: not allowed', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'src/a.js': lines(10) })
    const out = decide(dir, { size: 'M', diffHead: 'feat' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('size is M'), out.reason)
  })

  test('a 10-line code change on the branch: allowed', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'src/a.js': lines(10) })
    assert.equal(decide(dir, { diffHead: 'feat' }).allowed, true)
  })

  test('a 151-line code change: not allowed, the reason has 151', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'src/a.js': lines(151) })
    const out = decide(dir, { diffHead: 'feat' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('151'), out.reason)
  })

  test('900 lines of tests and docs plus 10 of code: allowed', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', {
      'src/a.js': lines(10),
      'src/b.test.js': lines(450),
      'docs/guide.md': lines(450),
    })
    assert.equal(decide(dir, { diffHead: 'feat' }).allowed, true)
  })

  test('a change under .github/workflows: not allowed', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { '.github/workflows/ci.yml': lines(3) })
    const out = decide(dir, { diffHead: 'feat' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('.github/workflows/ci.yml'), out.reason)
  })

  test('an issue path under .claude/skills: not allowed', (t) => {
    const dir = makeRepo(t, BASE)
    const out = decide(dir, { issuePaths: 'src/a.js,.claude/skills' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('.claude/skills'), out.reason)
  })

  test('issue paths with a space after the comma: still not allowed', (t) => {
    const dir = makeRepo(t, BASE)
    const out = decide(dir, { issuePaths: 'src/a.js, .claude/skills' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('.claude/skills'), out.reason)
  })

  test('diff.relative set and run from a subdirectory: still sees the whole diff', (t) => {
    const dir = makeRepo(t, { ...BASE, 'docs/guide.md': 'x' })
    branch(dir, 'feat', { '.github/workflows/ci.yml': lines(3) })
    git(dir, 'config', 'diff.relative', 'true')
    const r = run(join(dir, 'docs'), ...flags('main', { diffHead: 'feat' }))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).allowed, false)
  })

  test('main moved on by 400 lines after the branch point: still allowed', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'src/a.js': lines(10) })
    writeFileSync(join(dir, 'src', 'other.js'), lines(400))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'main moves on')
    assert.equal(decide(dir, { diffHead: 'feat' }).allowed, true)
  })

  test('a 100-line file renamed with no edit: not allowed', (t) => {
    const dir = makeRepo(t, { ...BASE, 'src/big.js': lines(100) })
    branch(dir, 'feat', {}, () => git(dir, 'mv', 'src/big.js', 'src/huge.js'))
    const out = decide(dir, { diffHead: 'feat' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('200'), out.reason)
  })

  test('a binary file added: not allowed, no line count', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'art/logo.bin': Buffer.from([0, 1, 2, 0, 255]) })
    assert.deepEqual(decide(dir, { diffHead: 'feat' }), {
      allowed: false,
      reason:
        'art/logo.bin has no line count (binary, or marked binary or -diff), so the line cap cannot be checked',
    })
  })

  test('a 5000-line source file marked -diff in the same diff: not allowed', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'huge.js': lines(5000), '.gitattributes': 'huge.js -diff\n' })
    // Git reads the attributes from the checkout, so stay on the branch the
    // way a developer's worktree does.
    git(dir, 'checkout', '-q', 'feat')
    const out = decide(dir, { diffHead: 'feat' })
    assert.equal(out.allowed, false)
    assert.ok(out.reason.includes('huge.js has no line count'), out.reason)
  })

  test('a diff head equal to the default ref: empty diff, not allowed', (t) => {
    const dir = makeRepo(t, BASE)
    assert.deepEqual(decide(dir, { diffHead: 'main' }), { allowed: false, reason: 'the diff is empty' })
  })

  for (const path of ['.claude', '.github', '`.claude/skills/x`', '.claude//skills/x']) {
    test(`the issue path ${path}: not allowed`, (t) => {
      const dir = makeRepo(t, BASE)
      assert.equal(decide(dir, { issuePaths: path }).allowed, false)
    })
  }

  test('a diff head that does not exist: not allowed, exit 0', (t) => {
    const dir = makeRepo(t, BASE)
    assert.deepEqual(decide(dir, { diffHead: 'origin/nope' }), {
      allowed: false,
      reason: 'the diff could not be read',
    })
  })

  test('--default-ref unknown with a diff head: not allowed, exit 0', (t) => {
    const dir = makeRepo(t, BASE)
    branch(dir, 'feat', { 'src/a.js': lines(10) })
    const r = run(dir, ...flags('unknown', { diffHead: 'feat' }))
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { allowed: false, reason: 'the diff could not be read' })
  })

  test('set up, no test files, small code change: not allowed with the repo reason', (t) => {
    const dir = makeRepo(t, { 'README.md': 'x' })
    branch(dir, 'feat', { 'src/a.js': lines(10) })
    assert.deepEqual(decide(dir, { diffHead: 'feat' }), { allowed: false, reason: NO_TESTS })
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
  test('a bad size', () => expectUsage(flags('main', { size: 's' })))
  test('an empty diff head', () => expectUsage(flags('main', { diffHead: '' })))
  test('a diff head that starts with a dash', () =>
    expectUsage(flags('main', { diffHead: '--output=x' })))
  test('an empty issue path list', () => expectUsage(flags('main', { issuePaths: '' })))
  test('an empty issue path in the list', () => expectUsage(flags('main', { issuePaths: 'a,,b' })))
  test('a blank issue path in the list', () => expectUsage(flags('main', { issuePaths: 'a, ,b' })))
  test('an issue path that is only a pair of backticks', () =>
    expectUsage(flags('main', { issuePaths: '``' })))
  test('an issue path with a dot segment', () =>
    expectUsage(flags('main', { issuePaths: '.claude/./skills/x' })))
  test('an issue path with a glob character', () =>
    expectUsage(flags('main', { issuePaths: 'src/*.js' })))
})
