#!/usr/bin/env node
// Lean check for the kickoff pipeline (issues #504 and #589).
//
// Decides whether a package may run the lean track (no architect, no tester).
// It holds the whole rule, so the lead runs it and follows the answer:
//
//   1. the package: `size:S`, no forced-full path, at most LINE_CAP counted
//      lines (packageAllowed);
//   2. the repo: on a repo set up for auto merge that has no test files, a
//      lean merge would rest on the reviewer alone, so lean is off there
//      (leanAllowed).
//
// It makes no gh calls: the lead does the setup reads and the fetch, and this
// script reads the diff and the files of the default ref with git, and counts
// test files with the repo guard's own rule.
//
// Exports are pure; main() is the only part that touches argv, stdout, git,
// or process.exit.
//
// Done when: the CLI prints one JSON object and exits 0, or prints one line
// on stderr and exits 2 on a usage error. A diff or a file list that cannot
// be read is a decision input (not allowed), not a usage error.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { countTestFiles, MANIFESTS, NODE_LOCKFILES } from '../tm-repo-guard/repo-guard.mjs'

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

// Measured on four repos (design doc of 2026-11-16): up to this many counted
// lines, the tester found no code defect on a size:S change.
export const LINE_CAP = 150

const SIZES = ['S', 'M', 'L', 'XL', 'none']

// A mistake in these reaches beyond the diff: the pipeline's own seats and
// skills, and the CI a lean merge depends on.
const FORCED_FULL_DIRS = ['.claude/agents', '.claude/skills', '.claude/workflows', '.github/workflows']

// The repo guard knows the manifests and the Node lockfiles. These are the
// lockfiles and pinned lists of its other stacks.
const OTHER_DEPENDENCY_FILES = ['uv.lock', 'poetry.lock', 'requirements.txt', 'go.sum', 'Package.resolved']
const DEPENDENCY_FILES = new Set([
  ...MANIFESTS,
  ...NODE_LOCKFILES.map(([name]) => name),
  ...OTHER_DEPENDENCY_FILES,
])

const DOC_FILE = /\.(md|mdx|txt|rst)$/i

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function forcedFull(path) {
  if (FORCED_FULL_DIRS.some((dir) => path === dir || path.startsWith(dir + '/'))) return true
  return DEPENDENCY_FILES.has(baseName(path))
}

// Added plus deleted lines outside test files and docs.
export function countedLines(changes) {
  let n = 0
  for (const { path, added, deleted } of changes) {
    if (countTestFiles([path]) > 0 || DOC_FILE.test(path)) continue
    n += added + deleted
  }
  return n
}

// Parses `git diff --numstat -z --no-renames` output: entries are
// NUL-separated, each one `<added>\t<deleted>\t<path>`. A binary file has `-`
// for both counts and counts as zero lines; its path still goes through the
// path rule.
export function parseNumstat(text) {
  const changes = []
  for (const entry of text.split('\0')) {
    if (entry === '') continue
    const match = entry.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/)
    if (!match) fail('not a numstat entry')
    const count = (v) => (v === '-' ? 0 : Number(v))
    changes.push({ path: match[3], added: count(match[1]), deleted: count(match[2]) })
  }
  return changes
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

function normalizeChanges(changes) {
  if (changes === 'none' || changes === 'unknown') return changes
  const ok =
    Array.isArray(changes) &&
    changes.every(
      (c) => c !== null && typeof c === 'object' && typeof c.path === 'string' && isCount(c.added) && isCount(c.deleted),
    )
  return ok ? changes : fail('changes must be a list of { path, added, deleted }, none or unknown')
}

// The package half of the rule. Returns { allowed, reason }, and throws with
// a one-line message on a malformed input. `issuePaths` are the paths the
// issue body names. `changes` is the parsed diff, 'none' before the developer
// has pushed (so the line cap cannot apply yet), or 'unknown' when the diff
// could not be read.
export function packageAllowed(input) {
  const size = SIZES.includes(input.size) ? input.size : fail(`size must be one of ${SIZES.join(', ')}`)
  const { issuePaths } = input
  if (!Array.isArray(issuePaths) || !issuePaths.every((p) => typeof p === 'string')) {
    fail('issuePaths must be an array of strings')
  }
  const changes = normalizeChanges(input.changes)

  if (size !== 'S') {
    return { allowed: false, reason: `size is ${size}, and the lean track needs size:S` }
  }
  const diffPaths = Array.isArray(changes) ? changes.map((c) => c.path) : []
  const forced = [...issuePaths, ...diffPaths].find(forcedFull)
  if (forced !== undefined) return { allowed: false, reason: `forced-full path: ${forced}` }
  if (changes === 'unknown') return { allowed: false, reason: 'the diff could not be read' }
  if (changes !== 'none') {
    const counted = countedLines(changes)
    if (counted > LINE_CAP) {
      return { allowed: false, reason: `${counted} counted lines, over the cap of ${LINE_CAP}` }
    }
  }
  return { allowed: true, reason: 'the package passes the size, path and line rules' }
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
