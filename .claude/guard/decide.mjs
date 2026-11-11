/**
 * The guard's decision (issue #539, batch #538).
 *
 * `decide(call, facts)` answers allow or deny for one tool call. It is pure:
 * no file system, no process, no network. Nothing calls it yet; the hook that
 * will is a later batch.
 *
 *   call   = { tool, input, mode, folder }
 *   facts  = { repoClass, repo, defaultBranch, currentBranch, enforceList, pluginRoot }
 *   answer = { decision: 'allow' | 'deny', rule, reason, enforced }
 *
 * `enforced` is true when `repo` is on `enforceList` (case-insensitive). Every
 * answer carries it. The caller refuses only when the answer is a deny and
 * `enforced` is true; otherwise it logs.
 *
 * Order of checks (the first that applies wins):
 *   1. a prompting mode: allow `mode`
 *   2. an unknown repo class, or a tool that is not text: deny `invalid-input`
 *   3. an organization repo: allow `organization`
 *   4. Bash with no command text: deny `invalid-input`
 *   5. the /tm-repo-guard command: allow `tm-repo-guard`
 *   6. a repo that is not set up: allow `read`, or deny `not-set-up`
 *   7. a Bash line the parser cannot read: deny `unparseable`
 *   8. each rule group in GROUPS order: deny `<group>/<entry>`
 *   9. nothing applies: allow `no-rule`
 */

import { parseCommandLine } from './shell.mjs'
import { GROUPS } from './groups.mjs'

// Modes where the user is asked before a change. Any other value, a missing
// one included, counts as unattended so a new mode fails closed.
const PROMPTING_MODES = new Set(['default', 'acceptEdits', 'plan'])

const REPO_CLASSES = new Set(['personal-set-up', 'personal-not-set-up', 'organization', 'no-github-repo'])

// Tools that change no file. Everything else is a change, including every
// tool the guard does not know.
const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch',
  'Agent', 'Task', 'TodoWrite', 'Skill',
])

const REPO_GUARD_SCRIPT = 'skills/tm-repo-guard/repo-guard.mjs'
const REPO_GUARD_SKILL_SPELLING = `\${CLAUDE_PLUGIN_ROOT:-.claude}/${REPO_GUARD_SCRIPT}`

function isEnforced(facts) {
  if (typeof facts?.repo !== 'string' || !Array.isArray(facts.enforceList)) return false
  const repo = facts.repo.toLowerCase()
  return facts.enforceList.some((name) => typeof name === 'string' && name.toLowerCase() === repo)
}

// Only the exact single `node <repo guard script> ...` command passes. A line
// that merely contains the name never does.
function isRepoGuardCommand(parsed, pluginRoot) {
  if (!parsed.ok || parsed.commands.length !== 1) return false
  const [command] = parsed.commands
  if (command.nested || command.wrapped || command.afterCd || command.redirects !== 0) return false
  const [runner, script, ...rest] = command.words
  if (runner?.text !== 'node' || !script) return false
  const scripts = [REPO_GUARD_SKILL_SPELLING]
  if (typeof pluginRoot === 'string' && pluginRoot !== '') {
    scripts.push(`${pluginRoot.replace(/\/+$/, '')}/${REPO_GUARD_SCRIPT}`)
  }
  return scripts.includes(script.text) && rest.every((word) => !word.expands)
}

export function decide(call, facts) {
  const enforced = isEnforced(facts)
  const answer = (decision, rule, reason) => ({ decision, rule, reason, enforced })
  const deny = (rule, reason) => answer('deny', rule, reason)
  const allow = (rule, reason) => answer('allow', rule, reason)

  if (typeof call !== 'object' || call === null) {
    return deny('invalid-input', 'The tool call was missing. Pass the tool, its input, the mode and the folder.')
  }

  if (PROMPTING_MODES.has(call.mode)) {
    return allow('mode', 'The permission mode asks the user first, so the guard does nothing.')
  }

  const repoClass = facts?.repoClass
  if (!REPO_CLASSES.has(repoClass) || typeof call.tool !== 'string') {
    return deny('invalid-input', 'The repo class or the tool name was missing or unknown. The guard refuses what it cannot classify.')
  }

  if (repoClass === 'organization') {
    return allow('organization', 'Organization repos are never touched by the guard.')
  }

  const isBash = call.tool === 'Bash'
  if (isBash && typeof call.input?.command !== 'string') {
    return deny('invalid-input', 'The shell call had no command text. Send the command as text.')
  }

  const parsed = isBash ? parseCommandLine(call.input.command) : null

  if (isBash && isRepoGuardCommand(parsed, facts.pluginRoot)) {
    return allow('tm-repo-guard', 'This is the /tm-repo-guard command, which always passes.')
  }

  if (repoClass === 'personal-not-set-up') {
    if (READ_TOOLS.has(call.tool)) {
      return allow('read', 'Reading is allowed in a repo that is not set up.')
    }
    return deny('not-set-up', 'This personal repo is not set up. Run /tm-repo-guard to set it up before changing anything.')
  }

  if (isBash && !parsed.ok) {
    return deny('unparseable', `The shell line could not be read (${parsed.reason}). Rewrite it as plain commands.`)
  }

  const ctx = {
    tool: call.tool,
    input: call.input,
    commands: isBash ? parsed.commands : null,
    facts,
    folder: call.folder,
  }
  for (const group of GROUPS) {
    const hit = group.check(ctx)
    if (hit) return deny(`${group.id}/${hit.entry}`, hit.reason)
  }

  return allow('no-rule', 'No guard rule applies to this call.')
}
