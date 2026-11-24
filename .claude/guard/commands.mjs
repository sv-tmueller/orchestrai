/**
 * Readers for git and gh command lines, shared by the guard's rule groups
 * (issue #587, batch #592). They take a parsed command (see shell.mjs) and
 * find the subcommand, so each group does not copy them.
 *
 * - `readGit(command)` takes the parsed command, because it needs `afterCd`
 *   and `env`. It returns `{ sub, subExpands, index, elsewhere }`: the
 *   subcommand word, whether it expands, the index of that word in
 *   `command.words`, and whether the command runs in another folder (`-C`,
 *   `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`, or
 *   `command.afterCd`, which the parser sets after a `cd` earlier in the
 *   line, after `env -C` or `sudo -D`, and after an exported `GIT_DIR` or
 *   `GIT_WORK_TREE`).
 * - `readGh(words)` takes `command.words`. It returns
 *   `{ group, groupExpands, sub, subExpands, next }`. For `gh api`, `sub` is
 *   null and `next` is the index of the first word after `api`.
 *
 * Pure, and imports nothing.
 */

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])

// Skips the global options and returns the subcommand and where it stands.
export function readGit(command) {
  const words = command.words
  let elsewhere = command.afterCd || (command.env ?? []).some((n) => n === 'GIT_DIR' || n === 'GIT_WORK_TREE')
  let i = 1
  while (i < words.length && words[i].text.startsWith('-')) {
    const flag = words[i].text
    const name = flag.split('=')[0]
    if (name === '-C' || name === '--git-dir' || name === '--work-tree') elsewhere = true
    i += GIT_GLOBAL_VALUE_FLAGS.has(flag) ? 2 : 1
  }
  return { sub: words[i]?.text, subExpands: words[i]?.expands === true, index: i, elsewhere }
}

// gh's own flags (-R <repo>, --repo <repo>, any other dash word) may stand
// between `gh`, the group and the subcommand.
export function readGh(words) {
  let i = 1
  const skipFlags = () => {
    while (i < words.length && words[i].text.startsWith('-') && words[i].text.length > 1) {
      i += words[i].text === '-R' || words[i].text === '--repo' ? 2 : 1
    }
  }
  skipFlags()
  const group = words[i]?.text
  const groupExpands = words[i]?.expands === true
  i++
  // `gh api` keeps its own flags, so they are not skipped after the group.
  if (group === 'api') return { group, groupExpands, sub: null, subExpands: false, next: i }
  skipFlags()
  return { group, groupExpands, sub: words[i]?.text, subExpands: words[i]?.expands === true, next: i + 1 }
}
