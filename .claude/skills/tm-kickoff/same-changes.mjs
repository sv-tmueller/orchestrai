#!/usr/bin/env node
// "Same changes" check for the repair of a queued PR (issue #482).
//
// A PR that sits in the merge queue falls behind the default branch. The lead
// brings it up to date with a merge, and the verdicts (tester PASS, reviewer
// APPROVE) may carry to the new head only if the PR's own changes are still
// the ones that were reviewed. This script answers that question from git
// alone.
//
// Git only: no gh call, no network, no fetch. The lead fetches first. The one
// write is `git merge-tree --write-tree`, which adds objects to .git and
// changes no ref, index or worktree.
//
// Usage: same-changes.mjs --from <sha> --head <sha> --default-ref <ref>
//   from         the commit the verdicts were earned on
//   head         the PR head after the update
//   default-ref  the default branch as the lead's checkout sees it
//
// Output: one JSON line { result, reason }, exit 0. result is one of
//   identical          the PR's own changes are the same; verdicts may carry
//   changed            something else changed (or the head was rewritten)
//   conflict-resolved  the update needed a conflict resolution
// A usage or git error prints one line on stderr and exits 2. The lead treats
// every result except `identical` with exit 0 as a reason for a new review.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const FLAGS = ['--from', '--head', '--default-ref']
const USAGE = 'usage: same-changes.mjs --from <sha> --head <sha> --default-ref <ref>'
const MAX_DIFF_BYTES = 512 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function runGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_DIFF_BYTES })
  if (r.error) fail(`git could not run: ${r.error.message}`)
  return r
}

function firstLine(text) {
  return text.trim().split('\n')[0]
}

function gitOk(cwd, args) {
  const r = runGit(cwd, args)
  if (r.status !== 0) {
    fail(`git ${args[0]} failed: ${firstLine(r.stderr) || `exit ${r.status}`}`)
  }
  return r.stdout
}

function resolveCommit(cwd, name, value) {
  // A leading dash would be read by git as an option.
  if (typeof value !== 'string' || value === '' || value.startsWith('-')) {
    fail(`${name} must be a commit or ref, got ${JSON.stringify(value)}`)
  }
  const r = runGit(cwd, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`])
  if (r.status !== 0) {
    fail(`${name} does not resolve to a commit: ${value}`)
  }
  return r.stdout.trim()
}

function mergeBase(cwd, a, b) {
  const r = runGit(cwd, ['merge-base', a, b])
  if (r.status !== 0) fail(`no merge base for ${a.slice(0, 7)} and ${b.slice(0, 7)}`)
  return r.stdout.trim()
}

function isAncestor(cwd, ancestor, descendant) {
  const r = runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
  if (r.status === 0) return true
  if (r.status === 1) return false
  return fail(`merge-base --is-ancestor failed: ${firstLine(r.stderr) || `exit ${r.status}`}`)
}

// Drops the `index` lines (blob IDs change with the base) and cuts each hunk
// header to `@@` (line numbers shift when the default branch edits the same
// file elsewhere). Changed lines keep their whitespace: it is meaningful in
// Python and YAML, which is why this does not use `git patch-id`.
export function normalizeDiff(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@ ') ? '@@' : line))
    .join('\n')
}

// -U0 keeps a default-branch edit next to a PR hunk out of the comparison.
// --no-renames makes both sides use the same, simplest file pairing.
function ownDiff(cwd, a, b) {
  const text = gitOk(cwd, [
    'diff', '--binary', '-U0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-renames', a, b, '--',
  ])
  return normalizeDiff(text)
}

export function sameChanges({ from, head, defaultRef, cwd = process.cwd() }) {
  const fromSha = resolveCommit(cwd, '--from', from)
  const headSha = resolveCommit(cwd, '--head', head)
  const refSha = resolveCommit(cwd, '--default-ref', defaultRef)

  if (headSha === fromSha) return { result: 'identical', reason: 'the head did not move' }

  if (!isAncestor(cwd, fromSha, headSha)) {
    return { result: 'changed', reason: 'the head does not contain the verdict commit (rewritten)' }
  }

  const base = mergeBase(cwd, headSha, refSha)
  const oldBase = mergeBase(cwd, fromSha, refSha)

  // What a clean update of the verdict commit onto the default branch would
  // be. A conflict means the head carries a hand-made resolution.
  const merged = runGit(cwd, ['merge-tree', '--write-tree', fromSha, base])
  if (merged.status === 1) {
    return { result: 'conflict-resolved', reason: 'the update needed a conflict resolution' }
  }
  if (merged.status !== 0) {
    fail(`merge-tree failed: ${firstLine(merged.stderr) || `exit ${merged.status}`}`)
  }
  const expectedTree = firstLine(merged.stdout)
  const headTree = gitOk(cwd, ['rev-parse', `${headSha}^{tree}`]).trim()
  if (expectedTree !== headTree) {
    return { result: 'changed', reason: 'the head differs from a clean update of the verdict commit' }
  }

  // "Own changes" is the PR diff GitHub shows, which is what was reviewed.
  if (ownDiff(cwd, oldBase, fromSha) !== ownDiff(cwd, base, headSha)) {
    return { result: 'changed', reason: "the PR's own diff differs from the reviewed one" }
  }
  return { result: 'identical', reason: 'a clean update with the same own changes' }
}

// An unknown flag, a stray argument, a repeated flag or a flag with no value is
// a usage error, so a corrected value appended by a caller is never silently
// ignored.
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

export function main(argv) {
  let out
  try {
    const v = parseArgs(argv)
    out = sameChanges({
      from: v.get('--from'),
      head: v.get('--head'),
      defaultRef: v.get('--default-ref'),
    })
  } catch (err) {
    process.stderr.write(`${firstLine(err.message)} (${USAGE})\n`)
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
}
