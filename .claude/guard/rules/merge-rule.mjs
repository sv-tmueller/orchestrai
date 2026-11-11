/**
 * Merge-rule group of the guard (issue #539, batch #538).
 *
 * Denies the shell commands that go around the merge rule on the default
 * branch. Six entries:
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
 *
 * The group reads commands, not text, so wrappers, substitutions and
 * `bash -c` are seen through (see shell.mjs). It only looks at Bash calls.
 * It is pure.
 *
 * The guard stops carelessness, not intent. GitHub's own rule is the hard
 * stop on a set-up repo.
 *
 * Not covered:
 *   - REST calls outside `gh api` (curl, wget, httpie), and `gh api graphql`
 *     mutations.
 *   - REST ways to write to the default branch (git/refs, contents, merges).
 *     GitHub's rule stops these on a set-up repo.
 *   - Changing or renaming the default branch, and renaming or archiving a
 *     repo. A default-branch change can move the branch out from under the
 *     rule, so the owner decides in a later batch whether the list takes it.
 *   - What the parser cannot see into: scripts, aliases and functions; xargs,
 *     find -exec and git submodule foreach; a heredoc fed to a shell;
 *     $(...) inside an unquoted heredoc; abbreviated long options such as
 *     --mirr; push settings from -c or git config; the PowerShell tool.
 *   - Nothing was cut from the sub-plan's "Cut to fit" list: every entry and
 *     every parser feature in the plan is built.
 */

import { commandName } from '../shell.mjs'

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])

const API_VALUE_FLAGS = new Set([
  '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache',
])

const REPO_PATH = /^repos\/[^/]+\/[^/]+$/
const PROTECTION_PATH = /^repos\/[^/]+\/[^/]+\/branches\/.+\/protection(\/|$)/
const RULESETS_PATH = /^(repos\/[^/]+\/[^/]+|orgs\/[^/]+)\/rulesets(\/|$)/

const hit = (entry, reason) => ({ entry, reason })

// ---------------------------------------------------------------------------
// git push
// ---------------------------------------------------------------------------

// Reads `git [global] push [options] [<repo> [<refspec>...]]`. Returns null
// when the command is not a push.
function readPush(command) {
  const words = command.words
  let elsewhere = command.afterCd
  let i = 1
  while (i < words.length && words[i].text.startsWith('-')) {
    const flag = words[i].text
    const name = flag.split('=')[0]
    if (name === '-C' || name === '--git-dir' || name === '--work-tree') elsewhere = true
    i += GIT_GLOBAL_VALUE_FLAGS.has(flag) ? 2 : 1
  }
  if (words[i]?.text !== 'push') return null

  const push = { elsewhere, force: false, mirror: false, all: null, tags: false, remove: false, positionals: [] }
  let afterDashes = false
  for (let j = i + 1; j < words.length; j++) {
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
  const [, ...rest] = push.positionals
  let refspecs = rest
  if (refspecs[0]?.text === 'tag' && refspecs.length >= 2) {
    refspecs = [{ text: `refs/tags/${refspecs[1].text}`, expands: refspecs[1].expands }, ...refspecs.slice(2)]
  }

  const out = { branches: [], wild: false, unknown: false }
  const current = () => {
    if (push.elsewhere || typeof facts.currentBranch !== 'string') out.unknown = true
    else out.branches.push(facts.currentBranch)
  }

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
    else if (!dst.startsWith('refs/')) out.branches.push(dst)
  }
  return out
}

function checkGit(command, facts) {
  const push = readPush(command)
  if (!push) return null

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
    return hit('push-default', 'The guard cannot tell which branch this push writes to (no branch named, a variable, or another folder). Name the feature branch in the command.')
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

function readApi(words) {
  let method = null
  let body = false
  let input = false
  const fields = []
  let endpoint = null
  const fieldName = (value) => (value ?? '').split('=')[0]

  for (let j = 2; j < words.length; j++) {
    const t = words[j].text
    if (t === '-X' || t === '--method') {
      method = words[++j]?.text ?? null
    } else if (t.startsWith('--method=')) {
      method = t.slice('--method='.length)
    } else if (/^-X./.test(t)) {
      method = t.slice(2)
    } else if (t === '-f' || t === '-F' || t === '--raw-field' || t === '--field') {
      body = true
      fields.push(fieldName(words[++j]?.text))
    } else if (/^--(raw-field|field)=/.test(t)) {
      body = true
      fields.push(fieldName(t.slice(t.indexOf('=') + 1)))
    } else if (/^-[fF]./.test(t)) {
      body = true
      fields.push(fieldName(t.slice(2)))
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

  const verb = (method ?? (body ? 'POST' : 'GET')).toUpperCase()
  const path = endpoint === null
    ? null
    : endpoint.replace(/^https?:\/\/[^/]+\//, '').replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return { verb, path, fields, input }
}

function checkApi(words) {
  const { verb, path, fields, input } = readApi(words)
  if (path === null || verb === 'GET' || verb === 'HEAD') return null

  if (PROTECTION_PATH.test(path) || RULESETS_PATH.test(path)) {
    return hit('branch-rule', 'This changes the branch protection or a ruleset, which is the merge rule itself. Ask the owner to change it.')
  }
  if (REPO_PATH.test(path)) {
    if (verb === 'DELETE') {
      return hit('delete-repo', 'This deletes the repo. Only the owner does that, by hand.')
    }
    if (verb === 'PATCH' && (input || fields.includes('visibility') || fields.includes('private'))) {
      return hit('visibility', 'This may change the repo visibility (or sends a body the guard cannot read). Only the owner does that, by hand.')
    }
  }
  return null
}

function checkGh(command) {
  const [, group, sub] = command.words.map((w) => w.text)
  const rest = command.words.slice(3).map((w) => w.text)

  if (group === 'pr' && sub === 'merge') {
    const admin = rest.some((t) => t === '--admin' || (t.startsWith('--admin=') && t !== '--admin=false'))
    if (admin) return hit('admin-merge', 'An admin merge skips the merge rule. Queue an auto merge once the statuses are on the head.')
  }
  if (group === 'repo' && sub === 'edit' && rest.some((t) => t === '--visibility' || t.startsWith('--visibility='))) {
    return hit('visibility', 'This changes the repo visibility. Only the owner does that, by hand.')
  }
  if (group === 'repo' && sub === 'delete') {
    return hit('delete-repo', 'This deletes the repo. Only the owner does that, by hand.')
  }
  if (group === 'api') return checkApi(command.words)
  return null
}

export const mergeRule = {
  id: 'merge-rule',
  check(ctx) {
    if (!ctx.commands) return null
    for (const command of ctx.commands) {
      const name = commandName(command)
      const found = name === 'git' ? checkGit(command, ctx.facts) : name === 'gh' ? checkGh(command) : null
      if (found) return found
    }
    return null
  },
}
