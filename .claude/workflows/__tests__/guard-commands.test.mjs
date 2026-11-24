/**
 * Tests for the shared git and gh readers (issue #587, batch #592).
 *
 * The merge-rule rows pin what the readers do inside that group. These rows
 * pin the shape of what they return, because later rule groups import them.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseCommandLine } from '../../guard/shell.mjs'
import { readGit, readGh } from '../../guard/commands.mjs'

function commandsOf(line) {
  const parsed = parseCommandLine(line)
  assert.equal(parsed.ok, true, line)
  return parsed.commands
}

describe('readGit', () => {
  test('skips -C and its value, and marks the folder as elsewhere', () => {
    const [command] = commandsOf('git -C x push origin main')
    assert.deepEqual(readGit(command), { sub: 'push', subExpands: false, index: 3, elsewhere: true })
  })

  test('a plain command is here, and its subcommand sits at index 1', () => {
    const [command] = commandsOf('git status')
    assert.deepEqual(readGit(command), { sub: 'status', subExpands: false, index: 1, elsewhere: false })
  })

  test('a subcommand that expands is flagged', () => {
    const [command] = commandsOf('git $SUB origin main')
    assert.deepEqual(readGit(command), { sub: '$SUB', subExpands: true, index: 1, elsewhere: false })
  })

  test('a GIT_DIR assignment in front, or a cd earlier, is elsewhere', () => {
    assert.equal(readGit(commandsOf('GIT_DIR=x git push')[0]).elsewhere, true)
    assert.equal(readGit(commandsOf('cd x; git push')[1]).elsewhere, true)
  })

  test('a line with no subcommand gives an undefined sub', () => {
    const git = readGit(commandsOf('git')[0])
    assert.equal(git.sub, undefined)
    assert.equal(git.subExpands, false)
  })
})

describe('readGh', () => {
  test('skips -R and its value before the group', () => {
    const [command] = commandsOf('gh -R a/b pr merge 12')
    assert.deepEqual(readGh(command.words), { group: 'pr', groupExpands: false, sub: 'merge', subExpands: false, next: 5 })
  })

  test('for api, sub is null and next is the first word after api', () => {
    const [command] = commandsOf('gh api -X POST repos/acme/widget/rulesets')
    assert.deepEqual(readGh(command.words), { group: 'api', groupExpands: false, sub: null, subExpands: false, next: 2 })
  })

  test('a group that expands is flagged', () => {
    const [command] = commandsOf('gh $G view')
    const gh = readGh(command.words)
    assert.equal(gh.groupExpands, true)
    assert.equal(gh.sub, 'view')
  })
})
