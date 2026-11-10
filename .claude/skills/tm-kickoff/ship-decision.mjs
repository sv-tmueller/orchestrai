#!/usr/bin/env node
// Ship decision for step 7 of the kickoff pipeline (issue #474).
//
// At the end of a package the lead reads the PR head and the repo's auto
// merge setup, then asks this script which verdict statuses to post and
// whether to queue the merge. The rules are deterministic, so they live here
// rather than in the lead's head. The script makes no gh calls: the lead does
// every read and every GitHub write, so each write stays a visible command.
//
// Exports are pure; main() is the only part that touches argv, stdout, or
// process.exit.
//
// Done when: the CLI prints one JSON object and exits 0, or prints one line
// on stderr and exits 2 on a usage error.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SHA_RE = /^[0-9a-f]{40}$/i
const TRACKS = ['full', 'lean']
const MAX_DESCRIPTION = 140

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

// 'yes' when every requirement holds, 'no' when one is known to be missing,
// 'unknown' when a failed read leaves it open. Unknown is treated as not
// set up by the caller: a failed read never queues a merge.
function setUp({ autoMerge, branchProtected, branchRules }) {
  if (autoMerge === false) return 'no'
  if (autoMerge === 'unknown') return 'unknown'
  if (branchProtected === true || (Number.isInteger(branchRules) && branchRules > 0)) {
    return 'yes'
  }
  return branchProtected === 'unknown' || branchRules === 'unknown' ? 'unknown' : 'no'
}

function clip(text) {
  return text.length <= MAX_DESCRIPTION ? text : text.slice(0, MAX_DESCRIPTION)
}

// Returns { sha, statuses, queue, reason }. Throws with a one-line message
// on a malformed input; main() turns that into exit 2.
export function decide(input) {
  const { track, verdictCommit, head } = input
  if (!TRACKS.includes(track)) fail('track must be full or lean')
  if (typeof head !== 'string' || !SHA_RE.test(head)) fail('head must be a 40-hex SHA')
  const fallbackReview = triState('fallbackReview', input.fallbackReview)
  if (fallbackReview === 'unknown') fail('fallbackReview must be true or false')
  const state = {
    autoMerge: triState('autoMerge', input.autoMerge),
    branchProtected: triState('branchProtected', input.branchProtected),
    branchRules: normalizeRules(input.branchRules),
  }
  const sha = head.toLowerCase()

  // The verdicts were earned on another commit (or there is none): post
  // nothing and leave the merge to a human.
  if (
    typeof verdictCommit !== 'string' ||
    !SHA_RE.test(verdictCommit) ||
    verdictCommit.toLowerCase() !== sha
  ) {
    return { sha, statuses: [], queue: false, reason: 'head-moved' }
  }

  const statuses = [
    {
      context: 'orchestrai/test',
      state: 'success',
      description: clip(track === 'lean' ? 'skipped (lean)' : 'Tester PASS'),
    },
    fallbackReview
      ? {
          context: 'orchestrai/review',
          state: 'pending',
          description: clip('review owed: approved under the run-long fallback, re-review on the configured model'),
        }
      : {
          context: 'orchestrai/review',
          state: 'success',
          description: clip('Reviewer APPROVE'),
        },
  ]

  if (fallbackReview) return { sha, statuses, queue: false, reason: 'review-owed' }
  const ready = setUp(state)
  if (ready === 'yes') return { sha, statuses, queue: true, reason: 'queued' }
  return {
    sha,
    statuses,
    queue: false,
    reason: ready === 'unknown' ? 'set-up-unknown' : 'not-set-up',
  }
}

const USAGE =
  'usage: ship-decision.mjs --track full|lean --verdict-commit <sha|none> --head <sha> ' +
  '--fallback-review true|false --auto-merge true|false|unknown ' +
  '--branch-protected true|false|unknown --branch-rules <n>|unknown'

function flag(argv, name) {
  const idx = argv.indexOf(name)
  if (idx === -1 || idx + 1 >= argv.length) fail(`missing ${name}`)
  return argv[idx + 1]
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

export function main(argv) {
  let result
  try {
    result = decide({
      track: flag(argv, '--track'),
      verdictCommit: flag(argv, '--verdict-commit'),
      head: flag(argv, '--head'),
      fallbackReview: parseBool('--fallback-review', flag(argv, '--fallback-review')),
      autoMerge: parseBool('--auto-merge', flag(argv, '--auto-merge')),
      branchProtected: parseBool('--branch-protected', flag(argv, '--branch-protected')),
      branchRules: parseRules(flag(argv, '--branch-rules')),
    })
  } catch (err) {
    process.stderr.write(`${err.message} (${USAGE})\n`)
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
}
