/**
 * Tests for the real adapter of the repo class lookup (issue #540).
 *
 * `guard-repo-class.test.mjs` uses fakes only. This file calls the real
 * `nodeRepoClassLocal()` with real git and the real file system. Every folder
 * sits under a fresh temp dir, git reads no global or system config, and there
 * is no network: the gh runner is a stub that always fails, so the answers are
 * the offline ones and the owner and repo come from the git remote.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { lookupRepoClass, nodeRepoClassLocal, defaultStateDir } from '../../guard/repo-class.mjs'

const GIT_ENV = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']
const saved = {}
let base
let nextId = 0

before(() => {
  for (const name of GIT_ENV) saved[name] = process.env[name]
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete process.env[name]
  base = mkdtempSync(join(tmpdir(), 'repo-class-local-'))
})

after(() => {
  for (const name of GIT_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(base, { recursive: true, force: true })
})

const fresh = (label) => join(base, `${label}-${nextId++}`)

function git(cwd, ...args) {
  const res = spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

function newRepo(label, url) {
  const dir = fresh(label)
  mkdirSync(dir)
  git(dir, 'init', '-q')
  if (url !== undefined) git(dir, 'remote', 'add', 'origin', url)
  return dir
}

function offlineLookup(folder, { stateDir, sessionId = 'sess-1', local = nodeRepoClassLocal() } = {}) {
  const calls = []
  const run = (args) => {
    calls.push(args)
    throw new Error('offline')
  }
  const got = lookupRepoClass({ folder, sessionId, run, local, stateDir })
  return { got, calls }
}

describe('nodeRepoClassLocal write and read', () => {
  test('a written file reads back, and a missing file reads as null', () => {
    const { read, write } = nodeRepoClassLocal()
    const path = join(fresh('rt'), 'sessions', 'a.json')
    assert.equal(read(path), null)
    write(path, '{"a":1}\n')
    assert.equal(read(path), '{"a":1}\n')
    write(path, '{"a":2}\n')
    assert.equal(read(path), '{"a":2}\n')
  })

  test('the folder is made with mode 0700 and the file with mode 0600', () => {
    const { write } = nodeRepoClassLocal()
    const root = fresh('modes')
    const path = join(root, 'sessions', 'a.json')
    write(path, 'x')
    assert.equal(statSync(join(root, 'sessions')).mode & 0o777, 0o700)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  test('a write leaves no temp file behind', () => {
    const { write } = nodeRepoClassLocal()
    const dir = join(fresh('tmp'), 'sessions')
    write(join(dir, 'a.json'), 'x')
    write(join(dir, 'a.json'), 'y')
    assert.deepEqual(readdirSync(dir), ['a.json'])
  })

  test('a write into a path that cannot be made throws', () => {
    const { write } = nodeRepoClassLocal()
    const blocker = fresh('blocker')
    writeFileSync(blocker, 'a file, not a folder')
    assert.throws(() => write(join(blocker, 'sessions', 'a.json'), 'x'))
  })
})

describe('nodeRepoClassLocal git', () => {
  test('returns code, stdout and stderr, and does not throw on a nonzero exit', () => {
    const { git: run } = nodeRepoClassLocal()
    const plain = fresh('plain')
    mkdirSync(plain)
    const res = run(['-C', plain, 'remote'])
    assert.notEqual(res.code, 0)
    assert.match(res.stderr, /not a git repository/)
    assert.equal(res.stdout, '')
  })
})

describe('defaultStateDir with the real environment', () => {
  test('is outside the folder it is asked about and ends in orchestrai', () => {
    const dir = defaultStateDir()
    assert.match(dir, /[\\/]orchestrai$/)
  })
})

describe('lookupRepoClass with real git', () => {
  test('a plain folder is no-github-repo', () => {
    const plain = fresh('plain')
    mkdirSync(plain)
    const stateDir = fresh('state')
    const { got, calls } = offlineLookup(plain, { stateDir })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(got.source, 'local')
    assert.equal(calls.length, 0)
    assert.equal(existsSync(stateDir), false)
  })

  test('a repo with an origin on github.com gives owner and repo from the remote', () => {
    const dir = newRepo('origin', 'https://github.com/octo/widget-api.git')
    const stateDir = fresh('state')
    const { got, calls } = offlineLookup(dir, { stateDir })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.equal(got.owner, 'octo')
    assert.equal(got.repo, 'widget-api')
    assert.deepEqual(calls, [['api', 'repos/octo/widget-api']])
  })

  test('a repo and its worktree resolve to the same owner and repo, and share the session entry', () => {
    const dir = newRepo('main-tree', 'git@github.com:octo/widget-api.git')
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'first')
    const wt = fresh('worktree')
    git(dir, 'worktree', 'add', '-q', '-b', 'side', wt)

    const stateDir = fresh('state')
    const first = offlineLookup(dir, { stateDir })
    const second = offlineLookup(wt, { stateDir })
    assert.equal(first.got.owner, 'octo')
    assert.equal(first.got.repo, 'widget-api')
    assert.equal(second.got.owner, 'octo')
    assert.equal(second.got.repo, 'widget-api')
    assert.equal(first.calls.length, 1)
    assert.equal(second.calls.length, 0)
    assert.equal(second.got.source, 'session')

    const stored = JSON.parse(readFileSync(join(stateDir, 'sessions', 'sess-1.json'), 'utf8'))
    assert.deepEqual(Object.keys(stored), ['octo/widget-api'])
  })

  test('an insteadOf rewrite is applied to the remote URL', () => {
    const dir = newRepo('rewrite', 'gh:octo/widget-api')
    git(dir, 'config', 'url.https://github.com/.insteadOf', 'gh:')
    const { got } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.owner, 'octo')
    assert.equal(got.repo, 'widget-api')
  })

  test('a remote that is not on github.com gives no-github-repo and the default branch from its HEAD', () => {
    const dir = newRepo('other-host', 'https://git.example.invalid/octo/widget-api.git')
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(got.defaultBranch, 'trunk')
    assert.equal(calls.length, 0)
  })

  test('a repo with no remote is no-github-repo', () => {
    const { got } = offlineLookup(newRepo('no-remote'), { stateDir: fresh('state') })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(got.defaultBranch, null)
  })

  test('a folder that does not exist throws', () => {
    assert.throws(() => offlineLookup(join(base, 'does-not-exist'), { stateDir: fresh('state') }))
  })
})
