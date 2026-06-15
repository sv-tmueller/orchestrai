# tm-install-team: install the team into user config dirs

Status: approved design, 2026-06-15. Brainstormed and signed off decision by
decision in session. Issue #98. Not yet implemented.

## Goal

Make the orchestrator team (agents, `tm-*` skills, review workflows) available
in repos you do not want to commit it to, above all an organization's private
repo worked under the `claude-work` account. The team should appear in every
repo under a config dir, with nothing written into any working tree, and the
same command should both install and update it.

A new user-invocable skill, `/tm-install-team`, copies the team from the local
template checkout into one or more user config dirs. It is the user-scope
counterpart to `tm-sync-template`, which syncs the team into a repo and opens a
PR.

## The model this rests on

Two facts from the Claude Code docs govern the whole design:

- **Scope precedence (highest wins):** managed (org IT policy) > project
  (team committed in a repo's `.claude/`) > user (team in a config dir). A
  same-named agent, skill, or workflow in a higher scope shadows the lower one.
- **Config dirs are isolated per alias:** `claude-personal` ->
  `~/.claude-personal`, `claude-work` -> `~/.claude-work`. Installing into one
  does nothing for the other.

So a user-scope install is the default team for every repo under that config
dir, and a repo that carries its own committed team transparently overrides the
user-scope copy where present. The two never conflict.

Plugins were rejected as the delivery vehicle for two verified reasons: the
Workflow scripts (`tm-review-*.js`) are not a pluginnable component, and plugin
skills are namespaced (`/plugin:tm-advisor`), which would break the bare-name
cross-references between the `tm-*` skills. User scope keeps bare names, so the
cross-references keep working unchanged.

## Use cases

| Repo | Team committed in repo? | Team comes from | Action |
|------|-------------------------|-----------------|--------|
| Personal public, template-merged | Yes | repo `.claude/` (project) | keep fresh with `tm-sync-template`, or strip it and rely on user scope to avoid publishing the machinery |
| Personal private, template-merged | Yes | repo `.claude/` (project) | same, committing is low-cost since not public |
| Org private, no template | No | config dir (user) | `/tm-install-team ~/.claude-work` + enable superpowers there; nothing committed |

The intended end state is full user scope: install into both `~/.claude-personal`
and `~/.claude-work`, then strip the now-redundant committed team from personal
repos (see Follow-up). The template repo itself keeps its `.claude/`; it is the
source of truth.

## Decisions

### 1. A new skill, not a mode in tm-sync-template

`tm-sync-template` is built around a repo: clone the template, three-way merge
against a version stamp, file an issue, open a PR. A config-dir install has no
git, no PR, and no issue. Folding a no-git mode into that skill would split it
across two output models and hurt clarity. `tm-install-team` does one job.

Rejected: a `--target` mode inside `tm-sync-template`.

### 2. Source is the local checkout

The skill copies from the current repo's `.claude/{agents,skills,workflows}`.
This repo is the canonical template (`origin = sv-tmueller/claude-template`), so
cloning the remote to read what is already checked out is redundant. The user
runs `git pull` first when they want the latest.

Rejected: cloning the canonical remote every run (the temp-dir dance
`tm-sync-template` needs because it can run inside a consuming repo).

### 3. One or more target config dirs per run

The argument is one or more config dirs: `/tm-install-team ~/.claude-personal
~/.claude-work`. With no argument it defaults to the active session's
`$CLAUDE_CONFIG_DIR`. Each target is resolved to an absolute path, echoed, and
confirmed before any write, which satisfies the standing rule not to touch
`~/.claude-work` casually. Install and update are the same command: re-running
updates each target in place.

Rejected: a single target only (would force two separate runs for the common
personal + work case).

### 4. Conflict handling is diff-and-confirm

Per file in each target: absent -> copy; identical -> skip; different -> list it
and ask before overwriting. The skill writes `<target>/.tm-team-version` (the
installed template SHA) for visibility on the next run. This is deliberately
simpler than `tm-sync-template`'s three-way merge, because config-dir copies are
deploy targets, not files you hand-edit.

Rejected: porting the full three-way merge (heavier, and the precise
local-edit detection it buys is not worth it for deploy targets).

### 5. Superpowers is detect-and-instruct, never auto-enabled

After copying, the skill checks each target config for `superpowers` in
`enabledPlugins`; if absent, it prints the exact enable commands. It does not
edit `settings.json` or run `/plugin`. The team's `developer` and `tester`
agents declare `skills: superpowers:...` and `tm-advisor` leans on superpowers
brainstorming, so an unenabled superpowers is a likely cause of the team
degrading in a fresh config dir. Enabling it is the one manual step left.

Rejected: registering the marketplace and writing `enabledPlugins` for the
user. `/plugin` is not cleanly scriptable from a skill, and a partial write
risks a half-configured state.

### 6. The skill never touches a repo

`tm-install-team` writes only to target config dirs. Removing the committed team
from consuming personal repos is separate work (see Follow-up); the skill does
not do it.

## What it installs (additive)

- `.claude/agents/*.md` -> `<target>/agents/`
- `.claude/skills/tm-*` -> `<target>/skills/`
- `.claude/workflows/*.js` -> `<target>/workflows/` (skips `__tests__/`)

## Non-goals

- Never writes to the org repo or the current working tree.
- Does not install or enable plugins (detect + instruct only).
- Does not clone the canonical remote.
- Does not modify or revert consuming repos.
- Does not change where the team writes work artifacts (plans, specs, PRs)
  inside a consuming repo.

## Verification

The skill is prose (no code logic), so it is verified by a dry run against a
throwaway temp dir, never `~/.claude-work`:

1. Run against an empty temp dir; confirm `agents/`, `skills/`, `workflows/`
   land with the expected files and `.tm-team-version` is written.
2. Re-run; confirm identical files are skipped (idempotent).
3. Edit one target file, re-run; confirm it is reported as a conflict and not
   clobbered.
4. Pass two temp dirs in one run; confirm each is handled independently.
5. With no `superpowers` in a target config, confirm the enable instructions
   print.

The dry run proves the copy mechanics, not that the team loads from a config
dir. That loading is documented: user-scope workflows are read from
`~/.claude/workflows/` and are "available in every project," and
`CLAUDE_CONFIG_DIR` relocates every `~/.claude` path (so the real location is
`<config-dir>/workflows/`); skills and agents load from the same user dir.
Because the revert follow-up is destructive, confirm it once empirically before
that step: in a real session under the target config (for example a
`claude-work` session) opened in a repo that does not carry the team, check that
`/tm-advisor` is offered, an agent dispatches, and a `tm-review-*` workflow is
found. Sources: `code.claude.com/docs/en/workflows.md`,
`code.claude.com/docs/en/claude-directory.md`.

## Follow-up work (not this issue)

- **Revert the committed team from personal repos.** Once `tm-install-team`
  ships and the team is installed into both config dirs, the committed
  `.claude/{agents,skills,workflows}` in personal consuming repos is redundant
  and can be removed (`git rm -r ...` + PR per repo). Keep each repo's
  `CLAUDE.md`. Do not strip the template repo. This is a dependent batch: it
  must come after this issue is merged, the install has been run, and a smoke
  test (see Verification) has confirmed the team loads from the config dir, or
  the repos would be stranded. It needs the list of personal repos
  (`gh repo list`).
- **tm-sync-template Section 3 cleanup.** `tm-sync-template` keeps a user-scope
  copy of itself current as a bootstrap. Once `tm-install-team` manages the
  whole team user-scope, that step is redundant and can be dropped. Surgical,
  left out of this issue.
