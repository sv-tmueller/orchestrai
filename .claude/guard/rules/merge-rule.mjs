/**
 * Merge-rule group of the guard (issue #539, batch #538).
 *
 * Denies the shell commands that go around the merge rule on the default
 * branch. Seven entries:
 *
 *   push-default  a push to the default branch, in any spelling, or a push
 *                 whose destination cannot be known
 *   force-push    a blind force push: --force, -f in a short cluster, a `+`
 *                 refspec, --mirror. `--force-with-lease` to a named branch
 *                 that is not the default branch passes, because the
 *                 developer seat pushes that way. To the default branch it is
 *                 a push-default.
 *   admin-merge   `gh pr merge --admin`
 *   branch-rule   a write to branch protection or to rulesets, through `gh api`
 *   visibility    `gh repo edit --visibility`, or a PATCH of the repo that
 *                 sets visibility or private (or sends a body it cannot read)
 *   delete-repo   `gh repo delete`, or a DELETE of the repo through `gh api`
 *   api-unknown   a write through `gh api` to an endpoint the guard cannot
 *                 read because it starts with a variable or a substitution
 *
 * The group reads commands, not text, so wrappers, substitutions and
 * `bash -c` are seen through (see shell.mjs). It only looks at Bash calls.
 * It is pure. Branch facts are short names (`main`, not `origin/main`); a
 * null or empty branch fact counts as unknown.
 *
 * The rule behind the reading: a word the guard cannot read is unknown, and
 * unknown is denied where the worst reading is one of the entries above. A
 * method word that expands counts as a write. A repo path made of variables
 * (`repos/$REPO`) counts as a repo path. A literal `protection` or
 * `rulesets` segment denies a write whatever expands before it. A path whose
 * literal tail is something else (`repos/$REPO/statuses/$SHA`) passes. Whether
 * a word expands is the parser's flag (shell.mjs); only inside an expanding
 * word does the group look at which segment holds the variable.
 *
 * A git subcommand that expands is read as a possible push. A gh group that
 * expands is read as both `pr` and `repo`, and a gh subcommand that expands
 * as `merge`, `edit` and `delete`.
 *
 * A dash word that expands in `gh pr merge` (`--$F`, `"--adm$in"`) is denied
 * as an admin merge, and in `gh repo edit` as a visibility change. A value
 * that expands after a literal flag (`--match-head-commit=$SHA`) and a word
 * that is entirely an expansion (`"$PR"`) are not flags and pass.
 *
 * The current branch is unknown after any earlier git command in the same
 * line (nested and wrapped ones included), the way it is after a `cd`, unless
 * that command is one of these, which never change which branch is checked
 * out: add, commit, status, fetch, pull, merge, log, diff, show, tag, stash
 * (except `stash branch`), reset, restore, rm, mv, rev-parse, remote, config,
 * ls-remote, ls-files, describe, cherry-pick, revert, clean, blame, grep,
 * format-patch, apply, am, gc, notes, shortlog, cat-file, diff-tree,
 * for-each-ref, rev-list, merge-base, update-index, push. A git command with
 * no readable subcommand, or one whose subcommand expands, makes it unknown
 * too. Then a push with no refspec, or of HEAD or @, is denied. A push that
 * names its destination is judged by that name. A word in the remote position
 * of a push that expands is unknown as well: an unquoted `$REMOTE` can hold
 * "origin main", and the parser does not record whether a word was quoted, so
 * a quoted one is denied too.
 *
 * The folder of a push is unknown after a `cd`, `-C`, `--git-dir`,
 * `--work-tree`, `GIT_DIR=` or `GIT_WORK_TREE=` assigned in front of the
 * command, `env -C` or `sudo -D`. It is also unknown for every command after
 * an `export`, `declare -x` or `typeset -x` of `GIT_DIR` or `GIT_WORK_TREE`
 * earlier in the line, the way it is after a `cd`. A plain `GIT_DIR=x;`
 * assignment is not exported and does not count. A bare push there is denied.
 *
 * The parser decodes the ANSI-C escapes in `$'...'` (hex, octal, `\u`, `\U`
 * and the single-letter ones, and a NUL ends the string), so a word spelled
 * `$'\u0072epos'` is read as `repos`. A word spelled that way still counts as
 * expanding. An escape it does not know is kept as written.
 *
 * A `gh api` write is denied as branch-rule when its repos path has a literal
 * `protection` segment anywhere after the repo part, when `branches/<name>/`
 * is followed by a segment that expands, or when the segment right after a
 * literal owner (and after the name, or after an expanding name) expands, or
 * for `orgs` right after the org.
 *
 * The guard stops carelessness, not intent. GitHub's own rule is the hard
 * stop on a set-up repo.
 *
 * A push with a variable in its destination:
 *   A push with a variable in its destination (HEAD:refs/heads/$BRANCH) is
 *   denied even when it would be harmless, because the guard cannot tell
 *   which branch the variable holds. The fix is to write the branch name out
 *   in the command.
 *
 * Not covered:
 *   The group reads Bash calls only. It looks at a command only when its name
 *   is git or gh once the wrappers and shells in shell.mjs are taken off, and
 *   it reads the words as written. A word that expands is denied only where
 *   this header says so; anywhere else it passes. These are not covered:
 *   - MCP tools (`mcp__*`) and the PowerShell tool.
 *   - A flag hidden entirely inside a variable or substitution, such as
 *     `gh pr merge 12 $(echo --admin)` or `gh repo edit $(echo --visibility)`.
 *   - A whole command held in a variable (`$CMD push origin main`,
 *     `eval "$CMD"`). A git or gh group or subcommand in a variable is read.
 *   - `set -a`, or a sourced file, that exports `GIT_DIR` or `GIT_WORK_TREE`
 *     before the push. Only `export`, `declare -x` and `typeset -x` are read.
 *   - `gh pr checkout` earlier in the line, which changes the current branch
 *     the way `git checkout` does. Only git commands are tracked.
 *   - `gh api` writes to a path that has a variable where a resource word
 *     would stand when the owner and name are one variable (`repos/$REPO/$X`),
 *     or the owner is a variable and the name a literal (`repos/$O/widget/$X`).
 *   - REST calls outside `gh api` (curl, wget, httpie), and `gh api graphql`
 *     mutations. REST pulls/<n>/merge, and transferring a repo.
 *   - REST ways to write to the default branch (git/refs, contents, merges).
 *     GitHub's rule stops these on a set-up repo.
 *   - Changing or renaming the default branch, and renaming or archiving a
 *     repo. A default-branch change can move the branch out from under the
 *     rule, so the owner decides in a later batch whether the list takes it.
 *   - What the parser cannot see into: scripts, aliases and functions; xargs,
 *     find -exec and git submodule foreach; programs shell.mjs does not unwrap
 *     (watch, flock, caffeinate, direnv exec); a heredoc fed to a shell; a
 *     command piped into a shell (echo '...' | bash) or handed to one with
 *     <<<; $(...) inside an unquoted heredoc and inside ${...}; a `case`
 *     pattern's `)` inside $(...); a substitution in an assignment prefix or
 *     a redirect target, which bash runs before its command but the parser
 *     lists after it (this matters only for the branch and folder tracking);
 *     abbreviated long options such as --mirr; push settings from -c or git
 *     config.
 */

import { commandName } from '../shell.mjs'

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])

const API_VALUE_FLAGS = new Set([
  '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache',
])

const hit = (entry, reason) => ({ entry, reason })

// Branch facts are short names. Null and the empty string both mean unknown.
const branchName = (value) => (typeof value === 'string' && value !== '' ? value : null)

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// Skips the global options and returns the subcommand and where it stands.
function readGit(command) {
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

// Git commands that never change which branch is checked out. After any other
// git command in a line, the current branch is unknown.
const KEEPS_BRANCH = new Set([
  'add', 'commit', 'status', 'fetch', 'pull', 'merge', 'log', 'diff', 'show', 'tag', 'stash', 'reset',
  'restore', 'rm', 'mv', 'rev-parse', 'remote', 'config', 'ls-remote', 'ls-files', 'describe',
  'cherry-pick', 'revert', 'clean', 'blame', 'grep', 'format-patch', 'apply', 'am', 'gc', 'notes',
  'shortlog', 'cat-file', 'diff-tree', 'for-each-ref', 'rev-list', 'merge-base', 'update-index', 'push',
])

function keepsBranch(git, command) {
  if (typeof git.sub !== 'string' || git.subExpands || !KEEPS_BRANCH.has(git.sub)) return false
  if (git.sub !== 'stash') return true
  // `git stash branch <name>` checks out a new branch. The stash verb is the
  // first word after `stash` that is not an option; one that expands is unknown.
  const verb = command.words.slice(git.index + 1).find((w) => !w.text.startsWith('-'))
  return !verb || (!verb.expands && verb.text !== 'branch')
}

// Reads the options and words of `git push [options] [<repo> [<refspec>...]]`.
function readPush(words, from, branchUnknown) {
  const push = { branchUnknown, force: false, mirror: false, all: null, tags: false, remove: false, positionals: [] }
  let afterDashes = false
  for (let j = from; j < words.length; j++) {
    const word = words[j]
    const text = word.text
    if (afterDashes || !text.startsWith('-') || text === '-') {
      push.positionals.push(word)
    } else if (text === '--') {
      afterDashes = true
    } else if (text.startsWith('--')) {
      const name = text.split('=')[0]
      if (PUSH_VALUE_FLAGS.has(name) && !text.includes('=')) j++
      else if (name === '--force') push.force = true
      else if (name === '--mirror') push.mirror = true
      else if (name === '--all' || name === '--branches') push.all = name
      else if (name === '--tags') push.tags = true
      else if (name === '--delete') push.remove = true
    } else {
      for (let k = 1; k < text.length; k++) {
        const letter = text[k]
        if (letter === 'f') push.force = true
        else if (letter === 'd') push.remove = true
        else if (letter === 'o') {
          if (k === text.length - 1) j++
          break
        }
      }
    }
  }
  return push
}

// The branches a push writes to: { branches: [name], wild, unknown }.
function pushDestinations(push, facts) {
  const [remote, ...rest] = push.positionals
  let refspecs = rest
  if (refspecs[0]?.text === 'tag' && refspecs.length >= 2) {
    refspecs = [{ text: `refs/tags/${refspecs[1].text}`, expands: refspecs[1].expands }, ...refspecs.slice(2)]
  }

  const out = { branches: [], wild: false, unknown: false }
  const current = () => {
    const current = branchName(facts.currentBranch)
    if (push.branchUnknown || current === null) out.unknown = true
    else out.branches.push(current)
  }

  if (remote?.expands) out.unknown = true

  if (refspecs.length === 0) {
    if (!push.all && !push.mirror && !push.tags && !push.remove) current()
    return out
  }

  for (const word of refspecs) {
    if (word.expands) {
      out.unknown = true
      continue
    }
    const text = word.text.replace(/^\+/, '')
    let dst
    if (push.remove) {
      dst = text
    } else {
      const colon = text.indexOf(':')
      const src = colon < 0 ? text : text.slice(0, colon)
      dst = colon < 0 ? '' : text.slice(colon + 1)
      if (dst === '') {
        if (src === 'HEAD' || src === '@') {
          current()
          continue
        }
        dst = src
      }
    }
    if (dst.includes('*')) out.wild = true
    else if (dst.startsWith('refs/heads/')) out.branches.push(dst.slice('refs/heads/'.length))
    else if (dst.startsWith('heads/')) out.branches.push(dst.slice('heads/'.length))
    else if (!dst.startsWith('refs/')) out.branches.push(dst)
  }
  return out
}

function checkPush(command, git, facts, switched) {
  const push = readPush(command.words, git.index + 1, git.elsewhere || switched)

  const blind = push.force || push.mirror || push.positionals.slice(1).some((w) => w.text.startsWith('+'))
  if (blind) {
    return hit('force-push', 'A force push overwrites history. Push normally, or use --force-with-lease to your own feature branch.')
  }

  const def = branchName(facts.defaultBranch)
  if (push.all || push.mirror) {
    return hit('push-default', `${push.all} pushes every branch, the default branch${def !== null ? ` (${def})` : ''} included. Push your feature branch by name and open a PR.`)
  }
  const dest = pushDestinations(push, facts)
  if (dest.wild) {
    return hit('push-default', 'A wildcard destination can reach the default branch. Push your feature branch by name and open a PR.')
  }
  if (dest.unknown) {
    return hit('push-default', 'The guard cannot tell which branch this push writes to (no branch named, a variable, another folder, or a branch switch earlier in the line). Name the feature branch in the command.')
  }
  if (dest.branches.length > 0 && def === null) {
    return hit('push-default', 'The default branch is not known, so the guard cannot tell this push from one to it. Retry when it is known, or ask the owner.')
  }
  const onDefault = dest.branches.find((b) => b === def)
  if (onDefault !== undefined) {
    return hit('push-default', `This push writes to the default branch (${onDefault}). Push a feature branch and open a PR.`)
  }
  return null
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

// Whether a word expands is the parser's flag (`word.expands`). Only inside a
// word that does expand is this used, to find which part holds the variable.
const holdsVariable = (text) => /[$`]/.test(text)

// Reads the options and the endpoint of `gh api`, starting at `from`.
function readApi(words, from) {
  let method = null
  let methodUnknown = false
  let body = false
  let input = false
  const fields = []
  let endpoint = null
  const setMethod = (word, text) => {
    method = text.replace(/^=/, '')
    methodUnknown = word.expands
  }
  // `name=value`, `=name=value` (from -f=name=value) or a bare name.
  const addField = (word, value) => {
    const name = (value ?? '').replace(/^=/, '').split('=')[0]
    fields.push({ name, unknown: word?.expands === true && holdsVariable(name) })
  }

  for (let j = from; j < words.length; j++) {
    const word = words[j]
    const t = word.text
    if (t === '-X' || t === '--method') {
      const next = words[++j]
      if (next) setMethod(next, next.text)
    } else if (t.startsWith('--method=')) {
      setMethod(word, t.slice('--method='.length))
    } else if (/^-X./.test(t)) {
      setMethod(word, t.slice(2))
    } else if (t === '-f' || t === '-F' || t === '--raw-field' || t === '--field') {
      body = true
      const next = words[++j]
      addField(next, next?.text)
    } else if (/^--(raw-field|field)=/.test(t)) {
      body = true
      addField(word, t.slice(t.indexOf('=') + 1))
    } else if (/^-[fF]./.test(t)) {
      body = true
      addField(word, t.slice(2))
    } else if (t === '--input') {
      body = input = true
      j++
    } else if (t.startsWith('--input=')) {
      body = input = true
    } else if (API_VALUE_FLAGS.has(t)) {
      j++
    } else if (t.startsWith('-') && t !== '-') {
      // a flag with no value
    } else if (endpoint === null) {
      endpoint = word
    }
  }

  const verb = methodUnknown ? 'UNKNOWN' : (method ?? (body ? 'POST' : 'GET')).toUpperCase()
  const path = endpoint === null
    ? null
    : endpoint.text.replace(/^https?:\/\/[^/]+\//, '').replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return { verb, path, pathExpands: endpoint?.expands === true, fields, input }
}

// Where a `gh api` path points, as far as the literal parts say. `expands` is
// the parser's flag for the endpoint word; without it no segment expands.
function classifyPath(path, expands) {
  const ex = (segment) => expands && holdsVariable(segment)
  const segments = path.split('/')
  const count = segments.length
  if (ex(segments[0])) return 'unknown'
  const [root] = segments

  if (root === 'repos') {
    for (let k = 2; k < count; k++) {
      if (segments[k] === 'rulesets' && (k === 2 || k === 3)) return 'rules'
      // A literal `protection` anywhere after the repo part.
      if (segments[k] === 'protection') return 'rules'
    }
    // branches/<name>/ followed by a segment that expands could be `protection`.
    for (let j = 2; j < count; j++) {
      if (segments[j] !== 'branches') continue
      for (let m = j + 2; m < count; m++) {
        if (ex(segments[m])) return 'rules'
      }
    }
    // The segment right after a literal owner and the name (or after an
    // expanding owner and name) could be `rulesets`. After one expanding word
    // that holds owner and name, or an expanding owner with a literal name,
    // this cannot be told from a resource word, so it is not read.
    if (count >= 4 && ex(segments[3]) && (!ex(segments[1]) || ex(segments[2]))) return 'rules'
    // repos/<owner>/<name>, or repos/<one word that holds both>, or only variables
    if (count === 3 || (count === 2 && ex(segments[1])) || (count >= 2 && segments.slice(1).every(ex))) return 'repo'
  }
  if (root === 'orgs' && (segments[2] === 'rulesets' || (count >= 3 && ex(segments[2])))) return 'rules'
  return 'other'
}

function checkApi(words, from) {
  const { verb, path, pathExpands, fields, input } = readApi(words, from)
  if (path === null || verb === 'GET' || verb === 'HEAD') return null

  const kind = classifyPath(path, pathExpands)
  if (kind === 'unknown') {
    return hit('api-unknown', 'The guard cannot tell which API endpoint this writes to, because it starts with a variable or a substitution. Write the endpoint out in the command.')
  }
  if (kind === 'rules') {
    return hit('branch-rule', 'This changes the branch protection or a ruleset, which is the merge rule itself. Ask the owner to change it.')
  }
  if (kind === 'repo') {
    if (verb === 'DELETE' || verb === 'UNKNOWN') {
      return hit('delete-repo', 'This deletes the repo, or its method is a variable that could. Only the owner does that, by hand.')
    }
    const touchesVisibility = fields.some((f) => f.unknown || f.name === 'visibility' || f.name === 'private')
    if (verb === 'PATCH' && (input || touchesVisibility)) {
      return hit('visibility', 'This may change the repo visibility (or sends a body or a field name the guard cannot read). Only the owner does that, by hand.')
    }
  }
  return null
}

// gh's own flags (-R <repo>, --repo <repo>, any other dash word) may stand
// between `gh`, the group and the subcommand.
function readGh(words) {
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

function checkGhPair(group, sub, command, hiddenFlag) {
  const all = command.words.slice(1).map((w) => w.text)
  if (group === 'pr' && sub === 'merge') {
    const admin = all.some((t) => t === '--admin' || (t.startsWith('--admin=') && t !== '--admin=false'))
    if (admin || hiddenFlag) return hit('admin-merge', 'An admin merge skips the merge rule (or a flag here is a variable that could be --admin). Queue an auto merge once the statuses are on the head.')
  }
  if (group === 'repo' && sub === 'edit' && (hiddenFlag || all.some((t) => t === '--visibility' || t.startsWith('--visibility=')))) {
    return hit('visibility', 'This changes the repo visibility (or a flag here is a variable that could be --visibility). Only the owner does that, by hand.')
  }
  if (group === 'repo' && sub === 'delete') {
    return hit('delete-repo', 'This deletes the repo. Only the owner does that, by hand.')
  }
  return null
}

function checkGh(command) {
  const gh = readGh(command.words)
  if (gh.group === 'api') return checkApi(command.words, gh.next)

  // A word that starts with a dash and whose flag name expands (--$F, "--adm$in")
  // could be the flag that matters. A value that expands after a literal flag
  // name, and a word that is entirely an expansion, are not flags.
  const hiddenFlag = command.words.slice(1).some((w) => w.expands && w.text.startsWith('-') && holdsVariable(w.text.split('=')[0]))
  // A group that expands could be `pr` or `repo`; a subcommand that expands
  // could be `merge`, `edit` or `delete`.
  const groups = gh.groupExpands ? ['pr', 'repo'] : [gh.group]
  const subs = gh.subExpands ? ['merge', 'edit', 'delete'] : [gh.sub]
  for (const group of groups) {
    for (const sub of subs) {
      const found = checkGhPair(group, sub, command, hiddenFlag)
      if (found) return found
    }
  }
  return null
}

export const mergeRule = {
  id: 'merge-rule',
  check(ctx) {
    if (!ctx.commands) return null
    let switched = false
    for (const command of ctx.commands) {
      const name = commandName(command)
      let found = null
      if (name === 'git') {
        const git = readGit(command)
        // A subcommand that expands could be `push`, and then the branch is unknown.
        if (git.sub === 'push' || git.subExpands) found = checkPush(command, git, ctx.facts, switched || git.subExpands)
        if (!keepsBranch(git, command)) switched = true
      } else if (name === 'gh') {
        found = checkGh(command)
      }
      if (found) return found
    }
    return null
  },
}
