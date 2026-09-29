// CI check (issue #412): fail a PR that changes plugin behavior without
// changing the plugin.json version. Installed copies keep the old behavior
// until the version changes, so an unbumped change never reaches them.
//
// Exports are pure (isGuarded, check); main() is the only part that runs
// git, reads the environment, or calls process.exit.
//
// Usage: node scripts/check-version-bump.mjs --base <ref>
// <ref> is the branch the PR merges into: CI passes HEAD^1, the base tip,
// on the pull_request merge commit; locally, pass origin/main. Labels come
// from PR_LABELS as a JSON array of names.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SKIP_LABEL = 'skip-version-bump'

const PLUGIN_JSON = '.claude/.claude-plugin/plugin.json'
const GUARDED = ['.claude/agents/', '.claude/skills/', '.claude/workflows/', '.claude/adapters/']
const UNGUARDED = ['.claude/workflows/__tests__/']

export function isGuarded(path) {
  return GUARDED.some((p) => path.startsWith(p)) && !UNGUARDED.some((p) => path.startsWith(p))
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')
  return m && m.slice(1).map(Number)
}

// A downgrade or a reused version is not a bump: installed copies may
// already hold that version cached with other contents.
function isAbove(headVersion, baseVersion) {
  const head = parseVersion(headVersion)
  const base = parseVersion(baseVersion)
  if (!head || !base) return false
  const i = head.findIndex((part, idx) => part !== base[idx])
  return i !== -1 && head[i] > base[i]
}

export function check({ changedFiles, baseVersion, headVersion, labels }) {
  const guarded = changedFiles.filter(isGuarded)
  if (guarded.length === 0) {
    return { ok: true, message: 'no guarded plugin paths changed' }
  }
  if (isAbove(headVersion, baseVersion)) {
    return { ok: true, message: `plugin version ${baseVersion} -> ${headVersion}` }
  }
  if (labels.includes(SKIP_LABEL)) {
    return { ok: true, message: `plugin version not bumped, skipped by the ${SKIP_LABEL} label` }
  }
  return {
    ok: false,
    message: [
      `plugin version ${headVersion ?? '(missing)'} is not an x.y.z above ${baseVersion}, but guarded plugin paths changed:`,
      ...guarded.map((f) => `  ${f}`),
      `Bump "version" in ${PLUGIN_JSON}, or add the ${SKIP_LABEL} label`,
      'if the change does not affect behavior.',
    ].join('\n'),
  }
}

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  if (r.error) {
    throw new Error(`git ${args.join(' ')} failed: ${r.error.message}`)
  }
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  }
  return r.stdout
}

function versionAt(ref) {
  return JSON.parse(git('show', `${ref}:${PLUGIN_JSON}`)).version
}

export function main(argv) {
  const baseIdx = argv.indexOf('--base')
  const base = baseIdx === -1 ? undefined : argv[baseIdx + 1]
  if (!base) {
    throw new Error('usage: check-version-bump.mjs --base <ref>')
  }
  const labels = JSON.parse(process.env.PR_LABELS || '[]')
  if (!Array.isArray(labels)) {
    throw new Error('PR_LABELS must be a JSON array of label names')
  }
  // Files come from the merge base, so a local branch behind <ref> is not
  // blamed for <ref>'s own later changes. The version compares against <ref>
  // itself, the version the merge will land on. On CI's merge commit both
  // are HEAD^1.
  const mergeBase = git('merge-base', base, 'HEAD').trim()
  // -z keeps paths unquoted (core.quotePath would quote non-ASCII ones and
  // hide their .claude/ prefix). Without --no-renames, a file moved out of
  // a guarded path lists only its new, unguarded path.
  const changedFiles = git('diff', '--name-only', '-z', '--no-renames', mergeBase, 'HEAD')
    .split('\0')
    .filter(Boolean)
  const result = check({
    changedFiles,
    baseVersion: versionAt(base),
    headVersion: versionAt('HEAD'),
    labels,
  })
  const log = result.ok ? console.log : console.error
  log(result.message)
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
