#!/usr/bin/env node
// Fails CI when a guarded .claude/ path changes without a plugin version
// bump (issue #411). Installed copies of the plugin are cached by version,
// so a behavior change under an unbumped version silently keeps the old
// behavior for everyone who has not reinstalled.
//
// Exports are pure (isGuarded, decide); main() is the only part that
// touches argv, git, or process.exit.

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'

const PLUGIN_JSON_PATH = '.claude/.claude-plugin/plugin.json'

// Guarded: agent, skill, workflow, and adapter files carry the plugin's
// actual behavior. The one exclusion is .claude/workflows/__tests__/,
// which is test code, not behavior. Everything else (team-guide.md,
// process-core.md, settings.json, plugin.json itself, docs/, scripts/) is
// deliberately not guarded; see the issue #411 sub-plan for the signed-off
// list.
const GUARDED_PREFIXES = [
  '.claude/agents/',
  '.claude/skills/',
  '.claude/workflows/',
  '.claude/adapters/',
]

const EXCLUDED_PREFIXES = ['.claude/workflows/__tests__/']

// Prefixes include a trailing slash so they match on a directory boundary:
// ".claude/agentsX/foo.md" does not start with ".claude/agents/".
export function isGuarded(path) {
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  return GUARDED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

// "Version changed" means the version string differs between base and
// head. There is no semver ordering check: a downgrade or a no-op edit to
// the string both count as "changed" for this purpose.
export function decide({ changedFiles, baseVersion, headVersion, labels }) {
  const guardedFiles = changedFiles.filter(isGuarded)
  if (guardedFiles.length === 0) return { pass: true, guardedFiles }
  if (baseVersion !== headVersion) return { pass: true, guardedFiles }
  if (labels.includes('skip-version-bump')) return { pass: true, guardedFiles }
  return { pass: false, guardedFiles }
}

function readVersionAt(ref) {
  const text = execFileSync('git', ['show', `${ref}:${PLUGIN_JSON_PATH}`], { encoding: 'utf8' })
  return JSON.parse(text).version
}

function readChangedFiles(baseRef) {
  const text = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', `${baseRef}...HEAD`],
    { encoding: 'utf8' }
  )
  return text.split('\n').filter(Boolean)
}

function buildFailureMessage({ guardedFiles, baseVersion, headVersion }) {
  return [
    'Guarded .claude/ paths changed without a plugin version bump:',
    ...guardedFiles.map((file) => `  - ${file}`),
    '',
    `${PLUGIN_JSON_PATH} version: ${baseVersion} (base) -> ${headVersion} (head)`,
    '',
    'Fix by either:',
    `  - bumping "version" in ${PLUGIN_JSON_PATH}, or`,
    '  - adding the skip-version-bump label if this change has no behavior impact.',
  ].join('\n')
}

export function main(argv) {
  const [baseRef] = argv
  if (!baseRef) {
    throw new Error('usage: node scripts/check-version-bump.mjs <base-ref>')
  }

  const changedFiles = readChangedFiles(baseRef)
  const baseVersion = readVersionAt(baseRef)
  const headVersion = readVersionAt('HEAD')
  const labels = JSON.parse(process.env.PR_LABELS || '[]')

  const result = decide({ changedFiles, baseVersion, headVersion, labels })
  if (!result.pass) {
    console.error(buildFailureMessage({ guardedFiles: result.guardedFiles, baseVersion, headVersion }))
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
