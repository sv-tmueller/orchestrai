---
name: tm-setup
description: Adopt orchestrai in the current repo. Creates the flow labels, checks the plugins, adds the missing docs folders on a branch with a PR, and sets the merge rule through tm-repo-guard after you confirm. Safe to re-run. User-invocable only.
disable-model-invocation: true
---

You are reading this because the user typed the command, so this skill is
already loaded. Do not call the Skill tool for it. Start with the first step
below.

This runs `NEW-PROJECT-SETUP.md` in the current repo. Every step is safe to
re-run: it checks first and skips what is in place. Never install a plugin,
write a settings file, or push to main. Keep a list as you go: done, already
in place, left for the owner.

## 1. Labels

Create the six labels the flow uses (`--force` makes a second run a no-op).
Keep these lines identical to the ones in `.claude/skills/tm-kickoff/SKILL.md`:

```
gh label create "size:S"      --color "c2e0c6" --description "Under 1 hour. One focused change." --force
gh label create "size:M"      --color "BFD4F2" --description "1 to 3 hours." --force
gh label create "size:L"      --color "F9D0C4" --description "4 to 6 hours. Split or checkpoint." --force
gh label create "size:XL"     --color "D93F0B" --description "About 8 hours. Too big. Split it." --force
gh label create "in-progress" --color "FBCA04" --description "Package dispatched by /kickoff; resume, do not restart." --force
gh label create "needs-human" --color "B60205" --description "Agent loop exhausted or blocked; human decision needed." --force
```

## 2. Plugins

Read only. The config dir is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when unset.
Look for `orchestrai@orchestrai` and `superpowers@claude-plugins-official` in
`<config dir>/plugins/installed_plugins.json`, and check neither is set to
`false` under `enabledPlugins` in `<config dir>/settings.json` or
`.claude/settings.json`. A missing file means not installed.

For each one that is missing or off, print the commands and tell the owner to
type them. Do not run them:

```
/plugin marketplace add sv-tmueller/orchestrai
/plugin install orchestrai@orchestrai
/plugin marketplace add anthropics/claude-plugins-official
/plugin install superpowers@claude-plugins-official
```

## 3. Docs tree

The folders are `docs/architecture/`, `docs/operations/`, `docs/plans/`,
`docs/reviews/` and `docs/superpowers/specs/`. If all exist, skip this step.

Otherwise, from the default branch, create the branch `chore/docs-tree`, add
the missing folders each with an empty `.gitkeep`, commit
(`chore: add the docs folders`), push the branch, and open a PR with
`gh pr create`. Never push to the default branch. Print the PR URL.

## 4. Merge rule

Run plan mode for this repo's full name (`gh repo view --json nameWithOwner
--jq .nameWithOwner`):

```
node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-repo-guard/repo-guard.mjs" apply <owner/name>
```

Then follow the `apply <repo>` steps in `.claude/skills/tm-repo-guard/SKILL.md`
from step 1: show the plan, ask the owner, and apply only on the owner's own
yes. Do not add logic of your own here. If it refuses the repo, say why and
point to "By hand: merge rule" in `NEW-PROJECT-SETUP.md`.

## 5. Report

Print what was done, what was already in place, and what is left for the owner:

- Plugins to install, if step 2 found any missing.
- The docs PR to merge, if step 3 opened one.
- Decide the e2e approach and scaffold `e2e/`.
- Write the first architecture note under `docs/architecture/`.
- File the first issues: brainstorm with `superpowers:brainstorming`, or run
  `/tm-advisor <the need>`.
