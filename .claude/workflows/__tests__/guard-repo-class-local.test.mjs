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

import { lookupRepoClass, nodeRepoClassLocal, parseGitHubRemote, defaultStateDir } from '../../guard/repo-class.mjs'

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

  test('a read of a path that is not a readable file throws, only a missing file is null', () => {
    const { read } = nodeRepoClassLocal()
    const dir = fresh('a-dir')
    mkdirSync(dir)
    assert.throws(() => read(dir))
    const blocker = fresh('blocker-read')
    writeFileSync(blocker, 'a file, not a folder')
    assert.throws(() => read(join(blocker, 'x.json')))
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

  // A stub `git` first on PATH prints the environment it got, so the test needs
  // no translated git. The parent sets another locale to prove the override.
  test('runs git with LC_ALL=C and LANG=C on top of the inherited environment', () => {
    const bin = fresh('stub-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "%s|%s|%s" "$LC_ALL" "$LANG" "$KEEP_ME"\n', { mode: 0o755 })
    const names = ['PATH', 'LC_ALL', 'LANG', 'KEEP_ME']
    const before = Object.fromEntries(names.map((n) => [n, process.env[n]]))
    try {
      process.env.PATH = bin
      process.env.LC_ALL = 'de_DE.UTF-8'
      process.env.LANG = 'de_DE.UTF-8'
      process.env.KEEP_ME = 'inherited'
      const res = nodeRepoClassLocal().git(['remote'])
      assert.equal(res.code, 0)
      assert.equal(res.stdout, 'C|C|inherited')
    } finally {
      for (const n of names) {
        if (before[n] === undefined) delete process.env[n]
        else process.env[n] = before[n]
      }
    }
  })
})

describe('defaultStateDir with the real environment', () => {
  test('ends in orchestrai', () => {
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

  test('the organization list is written with mode 0600 in a folder with mode 0700', () => {
    const dir = newRepo('org-modes', 'https://github.com/acme/widget-api.git')
    const stateDir = fresh('state')
    const run = (args) => {
      assert.deepEqual(args, ['api', 'repos/acme/widget-api'])
      const owner = { login: 'acme', type: 'Organization' }
      const info = { full_name: 'acme/widget-api', html_url: 'https://github.com/acme/widget-api', owner, default_branch: 'main' }
      return { code: 0, stdout: JSON.stringify(info), stderr: '' }
    }
    const got = lookupRepoClass({ folder: dir, sessionId: 'sess-1', run, local: nodeRepoClassLocal(), stateDir })
    assert.equal(got.repoClass, 'organization')
    const file = join(stateDir, 'organization-repos.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { repos: ['acme/widget-api'] })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(stateDir).mode & 0o777, 0o700)
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

  test('a pushurl for another repo makes the repo personal-not-set-up with no gh call', () => {
    const dir = newRepo('pushurl', 'https://github.com/acme/widget-api.git')
    git(dir, 'config', 'remote.origin.pushurl', 'https://github.com/octo/widget-api-fork.git')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.match(got.detail, /push/)
    assert.equal(calls.length, 0)
  })

  test('a pushInsteadOf rewrite to another repo counts as a different push URL', () => {
    const dir = newRepo('push-rewrite', 'https://github.com/acme/widget-api.git')
    git(dir, 'config', 'url.https://github.com/octo/other-name.pushInsteadOf', 'https://github.com/acme/widget-api.git')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.source, 'fallback')
    assert.equal(calls.length, 0)
  })

  test('a pushurl on GitHub with a fetch URL elsewhere is personal-not-set-up with no gh call', () => {
    const dir = newRepo('push-to-github', 'https://example.invalid/x/y.git')
    git(dir, 'config', 'remote.origin.pushurl', 'https://github.com/octo/widget-api.git')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.equal(calls.length, 0)
  })

  test('a pushInsteadOf rewrite to GitHub with a fetch URL elsewhere is personal-not-set-up with no gh call', () => {
    const dir = newRepo('push-rewrite-to-github', 'https://example.invalid/x/y.git')
    git(dir, 'config', 'url.https://github.com/octo/widget-api.git.pushInsteadOf', 'https://example.invalid/x/y.git')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.equal(calls.length, 0)
  })

  test('a pushurl on another non-GitHub host leaves no-github-repo', () => {
    const dir = newRepo('push-elsewhere', 'https://example.invalid/x/y.git')
    git(dir, 'config', 'remote.origin.pushurl', 'https://other.example.invalid/x/y.git')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(got.source, 'local')
    assert.equal(calls.length, 0)
  })

  test('a pushurl equal to the fetch URL leaves the lookup as it was', () => {
    const dir = newRepo('pushurl-same', 'https://github.com/octo/widget-api.git')
    git(dir, 'config', 'remote.origin.pushurl', 'git@github.com:octo/widget-api.git')
    const { got, calls } = offlineLookup(dir, { stateDir: fresh('state') })
    assert.equal(got.owner, 'octo')
    assert.equal(got.repo, 'widget-api')
    assert.deepEqual(calls, [['api', 'repos/octo/widget-api']])
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

// ---------------------------------------------------------------------------
// The remote parser against git itself
// ---------------------------------------------------------------------------

// `git fetch-pack --diag-url <url>` prints, with no network, the host git takes
// from an ssh, git or scp-like remote. git reads these differently from a URL
// parser: it decodes %XX and strips [...] first, and ssh splits the user from the
// host at the last @. Git has no https transport in fetch-pack, so https remotes
// are not in this table.
const ACCEPTED_HOSTS = ['github.com', 'github.com.', 'ssh.github.com']

function gitsHost(url) {
  const res = spawnSync('git', ['fetch-pack', '--diag-url', url], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (res.status !== 0) return { error: res.stderr.trim() }
  const field = (name) => new RegExp(`^Diag: ${name}=(.*)$`, 'm').exec(res.stdout)?.[1]
  const withPort = field('hostandport')
  const text = field('userandhost') ?? withPort
  if (text === undefined) return { error: `no host in: ${res.stdout}` }
  const host = text.slice(text.lastIndexOf('@') + 1)
  return { host: (withPort === undefined ? host : host.replace(/:\d+$/, '')).toLowerCase() }
}

const probe = gitsHost('ssh://git@github.com/o/r')
const SKIP = probe.error === undefined ? false : `this git has no usable "fetch-pack --diag-url": ${probe.error}`
const isGitHub = (url) => {
  const parsed = parseGitHubRemote(url)
  return parsed !== null && !parsed.invalid
}

describe('parseGitHubRemote against git fetch-pack --diag-url', { skip: SKIP }, () => {
  const sameAsGit = [
    // git sends all five of these to example.invalid
    'ssh://example.invalid%2F@github.com/some-org/shared',
    'ssh://[example.invalid]@github.com/some-org/shared',
    'ssh://[example.invalid:22]@github.com/some-org/shared',
    '[example.invalid]@github.com:some-org/shared',
    'git://example.invalid%2F@github.com/some-org/shared',
    // look-alikes
    'ssh://git@example.invalid?@ssh.github.com:443/o/r.git',
    'ssh://example.invalid#@github.com/o/r',
    'git://example.invalid#@github.com/o/r',
    'ssh://github.com?x/o/r',
    'ssh://github.com#x/o/r',
    'ssh://git@github.com:22#/o/r',
    'ssh://git@example.invalid:/o/r',
    'ssh://git@github.com:x/o/r',
    'ssh://git@github.com.example.invalid/o/r',
    'ssh://ssh.github.com.example.invalid/o/r',
    'ssh://www.github.com/o/r',
    'ssh://git@api.github.com/o/r',
    'ssh://git@github.com../o/r',
    'git@github.com@example.invalid:o/r',
    'git@notgithub.com:o/r',
    'git@www.github.com:o/r',
    // the accepted hosts
    'ssh://git@github.com/o/r.git',
    'ssh://git@ssh.github.com:443/o/r.git',
    'ssh://git@github.com./o/r',
    'ssh://git@GITHUB.COM:22/o/r',
    'ssh://git@github.com:/o/r',
    'ssh://git@ssh.github.com:/o/r',
    'git://github.com/o/r',
    'git://github.com./o/r',
    'git://github.com:9418/o/r',
    'git+ssh://git@github.com/o/r',
    'ssh+git://git@github.com/o/r',
    'git@github.com:o/r',
    'git@GITHUB.COM:o/r',
    'github.com:o/r',
    'git@ssh.github.com:o/r',
    // the scp-like form with a hash in the user part
    'example.invalid#@github.com:o/r',
  ]

  for (const url of sameAsGit) {
    test(`says GitHub exactly when git's host is GitHub: ${url}`, () => {
      const seen = gitsHost(url)
      assert.equal(seen.error, undefined, `git refused ${url}`)
      assert.equal(isGitHub(url), ACCEPTED_HOSTS.includes(seen.host), `git's host is ${seen.host}`)
    })
  }

  // git decodes or strips these in the host, so the parser cannot read the real
  // host. It must still never say GitHub for a host git sends elsewhere.
  for (const url of ['ssh://%67ithub.com/o/r', 'ssh://git@[github.com]:22/o/r', '[github.com]:o/r', 'ssh://[example.invalid]/o/r', 'ssh://%65xample.invalid/o/r']) {
    test(`never says GitHub for a host git sends elsewhere: ${url}`, () => {
      const seen = gitsHost(url)
      assert.equal(seen.error, undefined, `git refused ${url}`)
      if (!ACCEPTED_HOSTS.includes(seen.host)) assert.equal(isGitHub(url), false, `git's host is ${seen.host}`)
      assert.deepEqual(parseGitHubRemote(url), { invalid: true })
    })
  }
})
