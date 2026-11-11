#!/usr/bin/env node
// Lean check for the kickoff pipeline (issue #504).
//
// On a repo set up for auto merge that has no test files, a lean merge would
// rest on the reviewer alone, so every package runs the full track there. The
// lead asks this script once a package has passed the size and path rule. The
// script decides only that one clause. It makes no gh calls: the lead does the
// setup reads and the fetch, and this script lists the files of the default
// ref with git and counts test files with the repo guard's own rule.
//
// Exports are pure; main() is the only part that touches argv, stdout, git,
// or process.exit.
//
// Done when: the CLI prints one JSON object and exits 0, or prints one line
// on stderr and exits 2 on a usage error. A file list that cannot be read is
// a decision input (not allowed), not a usage error.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { countTestFiles } from '../tm-repo-guard/repo-guard.mjs'

function fail(message) {
  throw new Error(message)
}

function triState(name, value) {
  if (value === true || value === false || value === 'unknown') return value
  return fail(`${name} must be true, false or unknown`)
}

function normalizeRules(value) {
  if (value === 'unknown') return value
  if (Number.isInteger(value) && value >= 0) return value
  return fail('branchRules must be a non-negative integer or unknown')
}

// "Fix rounds" rule 8, word for word: a read that failed counts as set up.
// This is the reverse of ship-decision.mjs, which never queues on a failed read.
function isSetUp({ autoMerge, branchProtected, branchRules }) {
  if (autoMerge === 'unknown' || branchProtected === 'unknown' || branchRules === 'unknown') {
    return true
  }
  return autoMerge === true && (branchProtected === true || branchRules > 0)
}

// Parses `git ls-tree -r -z` output: entries are NUL-separated, each one
// `<mode> <type> <sha>\t<path>`. Submodule entries (type commit) are dropped,
// like the repo guard's own blob filter.
export function blobPaths(text) {
  const paths = []
  for (const entry of text.split('\0')) {
    if (entry === '') continue
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    if (entry.slice(0, tab).split(' ')[1] !== 'blob') continue
    paths.push(entry.slice(tab + 1))
  }
  return paths
}

// Returns { allowed, reason }. Throws with a one-line message on a malformed
// input; main() turns that into exit 2. `paths` is the file list of the
// default branch, or 'unknown' when it could not be read.
export function leanAllowed(input) {
  const state = {
    autoMerge: triState('autoMerge', input.autoMerge),
    branchProtected: triState('branchProtected', input.branchProtected),
    branchRules: normalizeRules(input.branchRules),
  }
  const { paths } = input
  const list =
    Array.isArray(paths) && paths.every((p) => typeof p === 'string')
      ? paths
      : paths === 'unknown'
        ? paths
        : fail('paths must be an array of strings or unknown')

  if (!isSetUp(state)) return { allowed: true, reason: 'not set up for auto merge' }
  if (list === 'unknown') {
    return {
      allowed: false,
      reason: 'the file list could not be read, and the repo counts as set up for auto merge',
    }
  }
  if (countTestFiles(list) === 0) {
    return { allowed: false, reason: 'no test files, and the repo counts as set up for auto merge' }
  }
  return { allowed: true, reason: 'test files found' }
}

const USAGE =
  'usage: lean-allowed.mjs --default-ref <ref>|unknown --auto-merge true|false|unknown ' +
  '--branch-protected true|false|unknown --branch-rules <n>|unknown'

const FLAGS = ['--default-ref', '--auto-merge', '--branch-protected', '--branch-rules']

// Reads argv as flag/value pairs. An unknown flag, a stray argument, a
// repeated flag or a flag with no value is a usage error, so a corrected
// value appended by a caller is never silently ignored.
function parseArgs(argv) {
  const values = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!FLAGS.includes(name)) fail(`unknown argument ${JSON.stringify(name)}`)
    if (values.has(name)) fail(`duplicate ${name}`)
    if (i + 1 >= argv.length) fail(`missing value for ${name}`)
    values.set(name, argv[i + 1])
  }
  for (const name of FLAGS) if (!values.has(name)) fail(`missing ${name}`)
  return values
}

function parseBool(name, value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'unknown') return 'unknown'
  return fail(`${name} must be true, false or unknown`)
}

function parseRules(value) {
  if (value === 'unknown') return value
  if (/^\d+$/.test(value)) return Number(value)
  return fail('--branch-rules must be a non-negative integer or unknown')
}

function parseRef(value) {
  if (value === '' || value.startsWith('-')) fail('--default-ref must be a ref or unknown')
  return value
}

// A local read is never truncated, unlike GitHub's trees API. --full-tree
// lists from the repo root even when the lead runs from a subdirectory.
// Any failure returns 'unknown', which the decision treats as set up and
// no tests, the safe direction.
function listPaths(ref) {
  if (ref === 'unknown') return 'unknown'
  const r = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', ref], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) return 'unknown'
  return blobPaths(r.stdout)
}

export function main(argv) {
  let input
  try {
    const v = parseArgs(argv)
    input = {
      ref: parseRef(v.get('--default-ref')),
      autoMerge: parseBool('--auto-merge', v.get('--auto-merge')),
      branchProtected: parseBool('--branch-protected', v.get('--branch-protected')),
      branchRules: parseRules(v.get('--branch-rules')),
    }
    // Validate the reads before touching git.
    leanAllowed({ ...input, paths: [] })
  } catch (err) {
    process.stderr.write(`${err.message} (${USAGE})\n`)
    process.exit(2)
  }
  const { ref, ...reads } = input
  // The list is only used on a set-up repo, so skip the git call otherwise.
  const needsList = isSetUp(reads)
  const result = leanAllowed({ ...reads, paths: needsList ? listPaths(ref) : [] })
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
}
