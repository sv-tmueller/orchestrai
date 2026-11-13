/**
 * Tests for the real file-system adapter of the repo guard (issue #512).
 *
 * `repo-guard.test.mjs` uses fakes only. This file calls the real
 * `nodeLocal()`. Every path sits under a fresh temp dir. The adapter tests use
 * just `isDir`, `real` and `read`. The Check test (issue #542) sets `home` to
 * a temp dir and `envDir` to null, so nothing here looks at the real home
 * folder or the real environment.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  realpathSync,
  rmSync,
  readdirSync,
  readFileSync,
  lstatSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nodeLocal, collectConfigDirs, renderConfigDirs } from '../../skills/tm-repo-guard/repo-guard.mjs'

const { isDir, real, read } = nodeLocal()

let base

before(() => {
  base = mkdtempSync(join(tmpdir(), 'repo-guard-local-'))
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('nodeLocal isDir', () => {
  test('is true for a dir and false for a plain file', () => {
    const dir = join(base, 'dir')
    const file = join(base, 'file')
    mkdirSync(dir)
    writeFileSync(file, 'x')
    assert.equal(isDir(dir), true)
    assert.equal(isDir(file), false)
  })

  test('is false for a path that is not there', () => {
    assert.equal(isDir(join(base, 'missing')), false)
  })

  test('is false for a path under a plain file (ENOTDIR)', () => {
    const file = join(base, 'under-file')
    writeFileSync(file, 'x')
    assert.equal(isDir(join(file, 'projects')), false)
  })

  test('throws for a dangling link, naming the broken link', () => {
    const dangling = join(base, 'dangling')
    symlinkSync(join(base, 'nowhere'), dangling)
    assert.throws(() => isDir(dangling), /broken link/)
  })

  test('throws ELOOP for a link that points to itself', () => {
    const loop = join(base, 'loop')
    symlinkSync(loop, loop)
    assert.throws(() => isDir(loop), { code: 'ELOOP' })
  })

  test('throws EACCES for a path inside a dir with mode 000', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('chmod cannot block root')
    const locked = join(base, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      assert.throws(() => isDir(join(locked, 'projects')), { code: 'EACCES' })
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})

describe('nodeLocal real', () => {
  test('resolves a link to a dir to the target', () => {
    const target = join(base, 'target')
    const alias = join(base, 'alias')
    mkdirSync(target)
    symlinkSync(target, alias)
    assert.equal(real(alias), realpathSync(target))
  })
})

describe('nodeLocal read', () => {
  test('gives null for a missing file and throws EISDIR for a dir', () => {
    assert.equal(read(join(base, 'no-such-file')), null)
    const dir = join(base, 'read-dir')
    mkdirSync(dir)
    assert.throws(() => read(dir), { code: 'EISDIR' })
  })
})

describe('nodeLocal has no write function', () => {
  test('the adapter offers exactly the read-only functions and two plain values', () => {
    assert.deepEqual(Object.keys(nodeLocal()).sort(), ['envDir', 'home', 'isDir', 'names', 'read', 'real'])
  })
})

// Check must not write to a config dir (issue #542). The tree is a temp home
// with invented dir names; the record covers every path, so a new, removed or
// changed file or dir shows up.
describe('Check on a real disk is read-only', () => {
  const NEWEST = 'c'.repeat(40)
  const treeRecord = (root) => {
    const out = []
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        const st = lstatSync(path)
        if (st.isDirectory()) {
          out.push([path, 'dir', st.mtimeMs])
          walk(path)
        } else {
          out.push([path, 'file', st.size, st.mtimeMs, createHash('sha256').update(readFileSync(path)).digest('hex')])
        }
      }
    }
    walk(root)
    return out
  }
  const put = (home, name, files) => {
    mkdirSync(join(home, name, 'projects'), { recursive: true })
    mkdirSync(join(home, name, 'plugins'), { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(home, name, file), text)
  }

  test('three fixture dirs: nothing is created, removed or changed, and the warning is printed', () => {
    const home = mkdtempSync(join(base, 'home-'))
    const bypass = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } })
    const installed = JSON.stringify({
      version: 2,
      plugins: { 'orchestrai@orchestrai': [{ scope: 'user', installPath: '/made/up', version: 'x', gitCommitSha: NEWEST }] },
    })
    const markets = JSON.stringify({ orchestrai: { source: { source: 'github', repo: 'acme/agent-kit' }, autoUpdate: true } })
    put(home, '.claude-alpha', { 'settings.json': bypass, 'plugins/installed_plugins.json': installed, 'plugins/known_marketplaces.json': markets })
    put(home, '.claude-beta', { 'settings.json': bypass })
    put(home, '.claude-gamma', { 'settings.json': '{ "env": { "TOKEN": "sk-invented-0001" ' })

    const before = treeRecord(home)
    const calls = []
    const run = (args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify({ sha: NEWEST }), stderr: '' }
    }
    const result = collectConfigDirs(run, { ...nodeLocal(), home, envDir: null })
    const text = renderConfigDirs(result)
    const after = treeRecord(home)

    assert.deepEqual(after, before)
    assert.ok(before.length > 0)
    assert.deepEqual(calls, [['api', 'repos/acme/agent-kit/commits/HEAD']])
    assert.ok(
      text.includes(
        '  warning: bypass default on and plugin not installed: the guard would not load here (only the orchestrai@orchestrai copy is read)'
      )
    )
    assert.match(text, /^~\/\.claude-alpha: plugin installed, auto update on, bypass default on, at the newest commit$/m)
    assert.match(text, /^~\/\.claude-gamma: .*bypass default unknown \(could not read settings\.json: not valid JSON\)/m)
    assert.ok(!text.includes('sk-invented'))
    assert.equal(result.failed, true)
  })
})
