---
name: tm-install-team
description: Install or update the orchestrator team (agents, tm- skills, review workflows) into one or more user config dirs, so the team is available in every repo under that config without committing anything to the repo. User-invocable only.
disable-model-invocation: true
argument-hint: "[config-dir ...]"
---

Install the team into user config dirs. This copies the team from THIS template
checkout into each target config dir's `agents/`, `skills/`, and `workflows/`,
so every session under that config has the team in every repo, with nothing
written into any repo working tree. Install and update are the same command:
re-run to pull a newer template version.

Run this from a checkout of the template (`sv-tmueller/claude-template`). Run
`git pull` first if you want the latest; the source is this working tree, not a
clone.

Targets: $ARGUMENTS (one or more config dirs, for example
`~/.claude-personal ~/.claude-work`). If empty, default to the active
`$CLAUDE_CONFIG_DIR`. Treat each target independently: run sections 1-6 once per
target.

## 1. Guard: confirm source and targets

- Confirm the source. This repo must carry the team: check that
  `.claude/agents/`, `.claude/skills/`, `.claude/workflows/`, and
  `.claude/team-guide.md` all exist here. If not, stop; you are not in the
  template checkout.
- Resolve each target to an absolute path (expand a leading `~`). For each,
  print the resolved path and the list of items that will be written, then ask
  the user to confirm before any write. Never write to a target the user has
  not confirmed in this run. The work config dir is sensitive; explicit
  confirmation is required.

## 2. Copy the team into each target (additive, no silent clobber)

For each confirmed target T, create `T/agents`, `T/skills`, `T/workflows` if
they are missing (`mkdir -p`), then process these source items:

- `.claude/agents/*.md`    -> `T/agents/<name>`     (files)
- `.claude/skills/tm-*` EXCEPT `tm-install-team`
  -> `T/skills/<name>` (whole skill directories: the operational skills
  tm-advisor, tm-grill-me, tm-kickoff, tm-new-project, tm-to-issues. The
  excluded skill maintains the template and is run only from a template
  checkout, so installing it into a consuming config dir would be a footgun.)
- `.claude/workflows/*.js` -> `T/workflows/<name>`   (files; skip the
  `.claude/workflows/__tests__/` directory)
- `.claude/team-guide.md`  -> `T/team-guide.md`      (file)

Decide per item by comparing source SRC to destination DST:

- DST missing: copy it (`cp` for a file, `cp -R` for a skill directory).
- DST present and identical (`diff -rq SRC DST` prints nothing): skip it.
- DST present and different: do NOT overwrite. Add it to a conflict list for T.

After walking every item, if T has conflicts, list them and ask the user
whether to overwrite each with the template version. These are
template-managed deploy copies, so overwrite is usually correct, but confirm.
Overwrite only the items the user approves.

## 3. Stamp the version

Read the old stamp first if present (`cat T/.tm-team-version`) and remember it
for the report. Then write the template HEAD SHA to `T/.tm-team-version`:

    git rev-parse HEAD > T/.tm-team-version

## 4. Print team-guide import instruction (detect and instruct, do not mutate)

`team-guide.md` lands at `T/team-guide.md`. For the guidance to load in every
session under T, the user must add one import line to `T/CLAUDE.md`. Check
whether `T/CLAUDE.md` already contains `@team-guide.md`. If it does not, print
the following instruction (and note it is required for the team guide to load):

    Add this line to T/CLAUDE.md so the team guide loads in every session under
    this config dir:

        @team-guide.md

    Do not let install-team edit CLAUDE.md itself.

Replace `T` in the printed instruction with the resolved path. Do not edit
`T/CLAUDE.md` yourself.

Note: if the user has an existing user-global `tm-sync-template` skill at
`T/skills/tm-sync-template`, it can be removed: the skill is deprecated and no
longer installed. Run `rm -rf T/skills/tm-sync-template` once.

## 5. Check superpowers (detect and instruct, do not mutate)

The team's `developer` and `tester` agents declare `skills: superpowers:...`
in frontmatter and `tm-advisor` uses superpowers brainstorming, so the team
needs superpowers enabled in each target config. Check whether it is:
`grep -r superpowers T/settings.json T/.claude.json` (either file may be
absent). If superpowers is not found, print these exact steps for the user to
run in a session launched under that config dir, and note they are required
for the team to work fully:

    /plugin marketplace add anthropics/claude-plugins-official
    /plugin install superpowers@claude-plugins-official

Do not edit `settings.json` and do not run `/plugin` yourself.

## 6. Report

For each target, report: the resolved path; files copied (including
`team-guide.md`); files skipped as identical; conflicts, and for each whether
it was overwritten or left; whether the team-guide import instruction was
printed; the version stamp as `old -> new` (or `none -> new` on first install);
and whether superpowers needs enabling. End with one line: re-run
`/tm-install-team <targets>` after `git pull` to update.

This skill never writes to any repo working tree. Removing a now-redundant
committed team from a consuming repo is separate manual work
(`git rm -r .claude/agents .claude/skills .claude/workflows` plus a PR) and
never applies to this template repo.
