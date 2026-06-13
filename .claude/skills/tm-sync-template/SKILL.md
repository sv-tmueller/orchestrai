---
name: tm-sync-template
description: Pull the latest claude-template machinery and process updates into this repo and open a PR. Works in repos created from any template version, including repos with no .claude/ at all. User-invocable only.
disable-model-invocation: true
argument-hint: "[template-repo]"
---

Sync this repo with its template. Repos created from a GitHub template share
no git history with it, so this is a managed copy and judgment merge, not a
git merge.

Template repo: $ARGUMENTS (default `sv-tmueller/claude-template`).

## 1. Get the delta

Clone the template to /tmp (full history; it is small). Read
`.claude/template-version` here:

- Stamp present and valid in the clone's history: the delta is
  `git log --oneline <stamp>..HEAD` and `git diff <stamp> HEAD` in the
  template clone. Only files in that diff are in scope.
- No stamp, or unknown SHA (legacy repo): unknown-base mode. Every template
  file is in scope; be conservative on prose.

If the delta is empty, say so and stop.

## 2. File classes, in scope only

- Machinery (`.claude/agents/`, `.claude/skills/`, `.claude/workflows/`): three-way
  guard before copying. Get the three versions: old = `git show <stamp>:<path>` in
  the template clone; new = the checked-out file in the template clone (HEAD);
  local = the file in this repo. If local == old, overwrite with new. If local
  differs from BOTH old and new, the file was modified locally; do not overwrite,
  list it in the PR as a conflict for the user. (If local already matches new, no
  action needed.) In unknown-base mode (no stamp), the old version does not exist
  so the three-way test cannot run; treat every machinery file as a conflict, do
  not overwrite, list it in the PR. Never delete local agents or skills the
  template does not have.
- `.claude/settings.json`: merge by key. Template-shipped keys (such as its
  `enabledPlugins` entries) update; project keys (permissions, hooks, env)
  stay.
- Prose (`CLAUDE.md`, `README.md`, `.gitignore`): apply only the template's
  delta hunks, by judgment, into the project's customized text. Never
  clobber project content. In unknown-base mode, port template sections that
  are clearly missing; when unsure, leave the file alone and note it in the
  PR.
- `NEW-PROJECT-SETUP.md`: skip if the project deleted it after bootstrap.

## 3. Non-file state

- Ensure the workflow labels exist (`size:S/M/L/XL`, `in-progress`,
  `needs-human`); create missing ones with `gh label create`.
- If a user-scope copy of this skill exists on this machine (under
  `$CLAUDE_CONFIG_DIR/skills/` or `~/.claude/skills/`) and is older than the
  template's copy, update it too; it is the bootstrap for repos that do not
  carry this skill yet.

## 4. Ship it

1. Write the template clone's HEAD SHA to `.claude/template-version`.
2. Per the project's process: file a `size:S` issue ("sync template to
   `<short-sha>`"), branch `chore/<n>-sync-template`, commit
   (`chore: sync template to <short-sha>`).
3. Run the project's check suite if one exists.
4. Open a PR with `Closes #<n>`. The body lists the template commits
   applied, the files touched per class, and any conflicts or skipped prose
   from the guards above. Merging stays with the user.
