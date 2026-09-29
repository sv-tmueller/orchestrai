// CI check (issue #412): fail a PR that changes plugin behavior without
// changing the plugin.json version. Installed copies keep the old behavior
// until the version changes, so an unbumped change never reaches them.
//
// Exports are pure (isGuarded, check); main() is the only part that runs
// git, reads the environment, or calls process.exit.
//
// Usage: node scripts/check-version-bump.mjs --base <ref>
// CI passes HEAD^1, the base tip, on the pull_request merge commit.
// Labels come from PR_LABELS as a JSON array of names.
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

export function check({ changedFiles, baseVersion, headVersion, labels }) {
  const guarded = changedFiles.filter(isGuarded)
  if (guarded.length === 0) {
    return { ok: true, message: 'no guarded plugin paths changed' }
  }
  if (baseVersion !== headVersion) {
    return { ok: true, message: `plugin version ${baseVersion} -> ${headVersion}` }
  }
  if (labels.includes(SKIP_LABEL)) {
    return { ok: true, message: `plugin version unchanged, skipped by the ${SKIP_LABEL} label` }
  }
  return {
    ok: false,
    message: [
      `plugin version unchanged at ${baseVersion}, but guarded plugin paths changed:`,
      ...guarded.map((f) => `  ${f}`),
      `Bump "version" in ${PLUGIN_JSON}, or add the ${SKIP_LABEL} label`,
      'if the change does not affect behavior.',
    ].join('\n'),
  }
}

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' })
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
  // Without --no-renames, a file moved out of a guarded path lists only its
  // new, unguarded path, and the removal from the plugin goes unseen.
  const changedFiles = git('diff', '--name-only', '--no-renames', base, 'HEAD')
    .split('\n')
    .filter(Boolean)
  const result = check({
    changedFiles,
    baseVersion: versionAt(base),
    headVersion: versionAt('HEAD'),
    labels: JSON.parse(process.env.PR_LABELS || '[]'),
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
