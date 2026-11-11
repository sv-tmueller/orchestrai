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
 * It is pure.
 *
 * The rule behind the reading: a word the guard cannot read is unknown, and
 * unknown is denied where the worst reading is one of the entries above. A
 * method word that expands counts as a write. A repo path made of variables
 * (`repos/$REPO`) counts as a repo path. A literal `protection` or
 * `rulesets` segment denies a write whatever expands before it. A path whose
 * literal tail is something else (`repos/$REPO/statuses/$SHA`) passes.
 *
 * A dash word that expands in `gh pr merge` (`--$F`, `"--adm$in"`) is denied
 * as an admin merge, and in `gh repo edit` as a visibility change. A value
 * that expands after a literal flag (`--match-head-commit=$SHA`) and a word
 * that is entirely an expansion (`"$PR"`) are not flags and pass.
 *
 * The current branch is unknown after any earlier git command in the same
 * line (nested and wrapped ones included), the way it is after a `cd`, unless
 * that command is one of these, which never change which branch is checked
 * out: add, commit, status, fetch, pull, merge, log, diff, show, tag, stash,
 * reset, restore, rm, mv, rev-parse, remote, config, ls-remote, ls-files,
 * describe, cherry-pick, revert, clean, blame, grep, format-patch, apply, am,
 * gc, notes, shortlog, cat-file, diff-tree, for-each-ref, rev-list,
 * merge-base, update-index, push. A git command with no readable subcommand,
 * or one whose subcommand expands, makes it unknown too. Then a push with no
 * refspec, or of HEAD or @, is denied. A push that names its destination is
 * judged by that name. A word in the remote position of a push that expands
 * is unknown as well: an unquoted `$REMOTE` can hold "origin main", and the
 * parser does not record whether a word was quoted, so a quoted one is
 * denied too.
 *
 * A `gh api` write is denied as branch-rule when its repos path has a literal
 * `protection` segment anywhere after the repo part, or when `branches/<name>/`
 * is followed by a segment that expands.
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
 *   The group reads the words of a command line as written. A spelling that
 *   only shows its meaning when the shell runs it is covered only where this
 *   header says so. These are not covered:
 *   - A flag hidden entirely inside a variable or substitution, such as
 *     `gh pr merge 12 $(echo --admin)` or `gh repo edit $(echo --visibility)`.
 *   - REST calls outside `gh api` (curl, wget, httpie), and `gh api graphql`
 *     mutations.
 *   - REST ways to write to the default branch (git/refs, contents, merges).
 *     GitHub's rule stops these on a set-up repo.
 *   - Changing or renaming the default branch, and renaming or archiving a
 *     repo. A default-branch change can move the branch out from under the
 *     rule, so the owner decides in a later batch whether the list takes it.
 *   - What the parser cannot see into: scripts, aliases and functions; xargs,
 *     find -exec and git submodule foreach; a heredoc fed to a shell; a
 *     command piped into a shell (echo '...' | bash) or handed to one with
 *     <<<; $(...) inside an unquoted heredoc; abbreviated long options such
 *     as --mirr; push settings from -c or git config; the PowerShell tool.
 *   - Nothing was cut from the sub-plan's "Cut to fit" list: every entry and
 *     every parser feature in the plan is built.
 */

import { commandName } from '../shell.mjs'

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])

const API_VALUE_FLAGS = new Set([
  '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache',
])

const hit = (entry, reason) => ({ entry, reason })

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// Skips the global options and returns the subcommand and where it stands.
function readGit(command) {
  const words = command.words
  let elsewhere = command.afterCd
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

const keepsBranch = (git) => typeof git.sub === 'string' && !git.subExpands && KEEPS_BRANCH.has(git.sub)

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
    if (push.branchUnknown || typeof facts.currentBranch !== 'string') out.unknown = true
    else out.branches.push(facts.currentBranch)
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

  const def = facts.defaultBranch
  if (push.all || push.mirror) {
    return hit('push-default', `${push.all} pushes every branch, the default branch${typeof def === 'string' ? ` (${def})` : ''} included. Push your feature branch by name and open a PR.`)
  }
  const dest = pushDestinations(push, facts)
  if (dest.wild) {
    return hit('push-default', 'A wildcard destination can reach the default branch. Push your feature branch by name and open a PR.')
  }
  if (dest.unknown) {
    return hit('push-default', 'The guard cannot tell which branch this push writes to (no branch named, a variable, another folder, or a branch switch earlier in the line). Name the feature branch in the command.')
  }
  if (dest.branches.length > 0 && typeof def !== 'string') {
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

const expanding = (text) => /[$`]/.test(text)

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
  const addField = (value) => {
    const name = (value ?? '').replace(/^=/, '').split('=')[0]
    fields.push({ name, unknown: expanding(name) })
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
      addField(words[++j]?.text)
    } else if (/^--(raw-field|field)=/.test(t)) {
      body = true
      addField(t.slice(t.indexOf('=') + 1))
    } else if (/^-[fF]./.test(t)) {
      body = true
      addField(t.slice(2))
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
      endpoint = t
    }
  }

  const verb = methodUnknown ? 'UNKNOWN' : (method ?? (body ? 'POST' : 'GET')).toUpperCase()
  const path = endpoint === null
    ? null
    : endpoint.replace(/^https?:\/\/[^/]+\//, '').replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return { verb, path, fields, input }
}

// Where a `gh api` path points, as far as the literal parts say.
function classifyPath(path) {
  const segments = path.split('/')
  if (expanding(segments[0])) return 'unknown'
  const [root] = segments

  if (root === 'repos') {
    for (let k = 2; k < segments.length; k++) {
      if (segments[k] === 'rulesets' && (k === 2 || k === 3)) return 'rules'
      // A literal `protection` anywhere after the repo part.
      if (segments[k] === 'protection') return 'rules'
    }
    // branches/<name>/ followed by a segment that expands could be `protection`.
    for (let j = 2; j < segments.length; j++) {
      if (segments[j] !== 'branches') continue
      for (let m = j + 2; m < segments.length; m++) {
        if (expanding(segments[m])) return 'rules'
      }
    }
    // repos/<owner>/<name>, or repos/<one word that holds both>
    if (segments.length === 3 || (segments.length === 2 && expanding(segments[1]))) return 'repo'
  }
  if (root === 'orgs' && segments[2] === 'rulesets') return 'rules'
  return 'other'
}

function checkApi(words, from) {
  const { verb, path, fields, input } = readApi(words, from)
  if (path === null || verb === 'GET' || verb === 'HEAD') return null

  const kind = classifyPath(path)
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
  i++
  // `gh api` keeps its own flags, so they are not skipped after the group.
  if (group === 'api') return { group, sub: null, next: i }
  skipFlags()
  return { group, sub: words[i]?.text, next: i + 1 }
}

function checkGh(command) {
  const { group, sub, next } = readGh(command.words)
  if (group === 'api') return checkApi(command.words, next)

  const all = command.words.slice(1).map((w) => w.text)
  // A word that starts with a dash and whose flag name expands (--$F, "--adm$in")
  // could be the flag that matters. A value that expands after a literal flag
  // name, and a word that is entirely an expansion, are not flags.
  const hiddenFlag = command.words.slice(1).some((w) => w.expands && w.text.startsWith('-') && expanding(w.text.split('=')[0]))
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
        if (git.sub === 'push') found = checkPush(command, git, ctx.facts, switched)
        if (!keepsBranch(git)) switched = true
      } else if (name === 'gh') {
        found = checkGh(command)
      }
      if (found) return found
    }
    return null
  },
}
