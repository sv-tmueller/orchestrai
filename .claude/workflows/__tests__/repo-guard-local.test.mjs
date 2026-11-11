/**
 * Tests for the real file-system adapter of the repo guard (issue #512).
 *
 * `repo-guard.test.mjs` uses fakes only. This file calls the real
 * `nodeLocal()` and uses just `isDir`, `real` and `read`. Every path sits
 * under a fresh temp dir. The tests never use `home`, `envDir` or `names`,
 * so nothing here looks at the home folder.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nodeLocal } from '../../skills/tm-repo-guard/repo-guard.mjs'

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
