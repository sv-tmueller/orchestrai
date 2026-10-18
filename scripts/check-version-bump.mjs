#!/usr/bin/env node
// Version-bump guard for the plugin surface (issue #362).
//
// `.claude/agents/`, `.claude/skills/`, `.claude/workflows/`, and
// `.claude/adapters/` are what `/plugin update` pulls into every config
// dir. A PR that changes one of them without bumping the "version" field
// in `.claude/.claude-plugin/plugin.json` ships silently on the next
// update, with no record of what changed. This script is repo tooling
// (it does not ship as part of the plugin), used from CI and locally.
//
// Usage:
//   node scripts/check-version-bump.mjs <base-ref> <head-ref>
//
// Labels come from the PR_LABELS env var (a JSON array of label names),
// set by the calling CI job from the pull_request event payload.
//
// Zero dependencies: plain Node (child_process), no npm installs.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

// Prefixes that make a changed file "guarded": it is part of the shipped
// plugin surface, so changing it needs either a version bump or the skip
// label. Each entry ends in "/" so a sibling like ".claude/agents-notes.md"
// does not false-positive against ".claude/agents/".
export const GUARDED = [
  '.claude/agents/',
  '.claude/skills/',
  '.claude/workflows/',
  '.claude/adapters/',
]

// Excluded from GUARDED even though it sits under .claude/workflows/: it
// holds the repo's unit tests (and any fixtures alongside them), not
// shipped plugin behavior.
export const EXCLUDED = ['.claude/workflows/__tests__/']

// A PR carrying this label is asserting its guarded change has no behavior
// impact (for example a comment or doc fix inside a skill file), so the
// guard passes without a version bump.
export const SKIP_LABEL = 'skip-version-bump'

/**
 * @param {string} filePath a repo-relative path, forward-slash separated
 * @returns {boolean} true if the path falls under a guarded prefix and is
 *   not carved out by EXCLUDED
 */
export function isGuarded(filePath) {
  if (EXCLUDED.some((prefix) => filePath.startsWith(prefix))) {
    return false
  }
  return GUARDED.some((prefix) => filePath.startsWith(prefix))
}

/**
 * Decide whether a PR's guarded-file changes are covered by a version bump
 * or the skip label.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles repo-relative paths changed by the PR
 * @param {string} input.baseVersion plugin.json "version" at the base ref
 * @param {string} input.headVersion plugin.json "version" at the head ref
 * @param {string[]} [input.labels] the PR's label names
 * @returns {{ok: boolean, guardedChanged: string[], message: string}}
 */
export function checkVersionBump({
  changedFiles = [],
  baseVersion,
  headVersion,
  labels,
} = {}) {
  const guardedChanged = changedFiles.filter(isGuarded)

  if (guardedChanged.length === 0) {
    return {
      ok: true,
      guardedChanged,
      message: 'no guarded .claude/ files changed; version bump not required',
    }
  }

  if (headVersion !== baseVersion) {
    return {
      ok: true,
      guardedChanged,
      message: `plugin.json version changed (${baseVersion} -> ${headVersion})`,
    }
  }

  // Labels can arrive as a malformed or missing value (an empty PR_LABELS
  // env var, a JSON parse failure upstream, a caller passing a bare
  // string). Treat anything that is not an array as "no labels" rather
  // than throwing, so a parsing edge case fails the guard instead of the
  // CI job itself.
  const labelList = Array.isArray(labels) ? labels : []
  if (labelList.includes(SKIP_LABEL)) {
    return {
      ok: true,
      guardedChanged,
      message: `"${SKIP_LABEL}" label present; version bump not required`,
    }
  }

  const fileList = guardedChanged.map((f) => `  - ${f}`).join('\n')
  return {
    ok: false,
    guardedChanged,
    message: [
      'This PR changes guarded .claude/ files (agents, skills, workflows,',
      'or adapters) without bumping the plugin version:',
      '',
      fileList,
      '',
      'Fix it one of two ways:',
      '  1. Bump "version" in .claude/.claude-plugin/plugin.json.',
      `  2. Add the "${SKIP_LABEL}" label if this change has no behavior impact.`,
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function gitDiffNameOnly(baseRef, headRef) {
  const raw = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', baseRef, headRef],
    { encoding: 'utf8' }
  )
  return raw.split('\n').filter(Boolean)
}

function pluginVersionAt(ref) {
  const raw = execFileSync(
    'git',
    ['show', `${ref}:.claude/.claude-plugin/plugin.json`],
    { encoding: 'utf8' }
  )
  return JSON.parse(raw).version
}

export function parseLabelsEnv(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Guarded: importing this module (as the test file does) must have no
// side effects. Only running it directly as `node
// scripts/check-version-bump.mjs <base> <head>` invokes main().
function main() {
  const [baseRef, headRef] = process.argv.slice(2)
  if (!baseRef || !headRef) {
    console.error('usage: node scripts/check-version-bump.mjs <base-ref> <head-ref>')
    process.exitCode = 2
    return
  }

  const changedFiles = gitDiffNameOnly(baseRef, headRef)
  const baseVersion = pluginVersionAt(baseRef)
  const headVersion = pluginVersionAt(headRef)
  const labels = parseLabelsEnv(process.env.PR_LABELS)

  const result = checkVersionBump({ changedFiles, baseVersion, headVersion, labels })
  console.log(result.message)
  if (!result.ok) {
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main()
}
