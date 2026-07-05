---
name: tm-new-project
description: "Run the once-per-repo plugin-adoption setup as a guided flow: create the workflow labels and the docs tree, then print the human-only steps (branch protection, CI, plugin install, design-plugin vetting). User-invocable only."
disable-model-invocation: true
---

Run the setup in `NEW-PROJECT-SETUP.md` against the current repo (the cwd):
automate what can be automated, print exact commands for what cannot.
Idempotent: each section below checks its own precondition and skips what is
already done, so re-running after a partial setup only finishes what is
left.

## 1. Detect state

Check, in this repo:

- The six canonical labels (`gh label list`): `size:S`, `size:M`, `size:L`,
  `size:XL`, `in-progress`, `needs-human`. Skip this check, with a note, if
  there is no GitHub remote or `gh` auth.
- The five docs dirs: `docs/architecture`, `docs/operations`, `docs/plans`,
  `docs/reviews`, `docs/superpowers/specs`.

**Already set up:** all six labels present (or not checked, for lack of a
remote or `gh` auth) and all five dirs present. Stop here; do not run
sections 2-4. Report:

    Already set up: labels present, docs tree present. Nothing to do.
    Labels: <all present | not checked: <reason>>

Otherwise, continue through sections 2-4 below. Each checks its own
precondition and skips what is already done, so a mixed (partially set up)
state only finishes what is left.

## 2. Labels

Skip this section, with a note, if there is no GitHub remote (`git remote
get-url origin` fails) or `gh` is not authenticated (`gh auth status`
fails). Otherwise run:

```
gh label create "size:S"       --color "c2e0c6" --description "Under 1 hour. One focused change." --force
gh label create "size:M"       --color "BFD4F2" --description "1 to 3 hours. Write a sub-plan first." --force
gh label create "size:L"       --color "F9D0C4" --description "4 to 6 hours. Split or checkpoint." --force
gh label create "size:XL"      --color "D93F0B" --description "About 8 hours. Too big. Split it." --force
gh label create "in-progress"  --color "FBCA04" --description "Package dispatched by /kickoff; resume, do not restart." --force
gh label create "needs-human"  --color "B60205" --description "Agent loop exhausted or blocked; human decision needed." --force
```

`--force` upserts: it creates each label when absent and sets identical
values when present, so re-running this section is a no-op.

## 3. Docs tree

Create the docs dirs that are missing (`mkdir -p`):

```
docs/architecture/
docs/operations/
docs/plans/
docs/reviews/
docs/superpowers/specs/
```

Git does not track empty directories, so a newly created dir will not show up
in `git status` until a file lands inside it. That is expected; do not add
placeholder files just to force tracking.

## 4. Print human-only steps

These need a browser or a human decision; print them, do not run them.

**Branch protection.** In the repo's GitHub settings, protect `main`: block
direct pushes, require a PR, require status checks to pass before merge.

**Tests and CI/CD.** Decide the e2e approach for this app and scaffold
`e2e/`. Copy `templates/ci.yml` (in this skill's directory) to
`.github/workflows/ci.yml` and fill in the real commands. Keep its cost
controls: pinned `timeout-minutes` on every job, a `concurrency` group with
`cancel-in-progress: true`, and e2e/build skipped on draft PRs. Make the
relevant CI jobs required status checks on `main` (the setting above). If
you deploy, make e2e a pre-deploy gate.

**Claude Code plugins.** Accept the superpowers plugin prompt that
`.claude/settings.json` triggers. If no prompt appears (a known gap,
https://github.com/anthropics/claude-code/issues/32606), run
`/plugin marketplace add anthropics/claude-plugins-official`, then
`/plugin install superpowers@claude-plugins-official`.

(Optional, UI projects only) Enable the design plugins. They are not on by
default, so adoption stays generic and free of third-party defaults. Vet the
two third-party plugins before enabling them in a project others build on;
their install steps live in their repos and may change.

- `frontend-design@claude-plugins-official` (official marketplace, like
  superpowers): `/plugin install frontend-design@claude-plugins-official`.
- `ui-ux-pro-max@ui-ux-pro-max-skill`, from
  `nextlevelbuilder/ui-ux-pro-max-skill`:
  `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`, then
  `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`.
- `impeccable@impeccable`, from `pbakaus/impeccable`:
  `/plugin marketplace add pbakaus/impeccable`, then
  `/plugin install impeccable@impeccable`.

**First slice of work.** Brainstorm the first design via
`superpowers:brainstorming`; save the spec to
`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. File the first issues
(`gh issue create`), sized, with `Blocked by: #N` lines for dependencies. For
a single issue: post a short sub-plan, branch, open a draft PR (`Closes #N`),
then expand it to a full plan in `docs/plans/`. For a batch of refined
issues: run `/tm-kickoff` (see team-guide.md "Agent team").

## 5. Report

Report, in this order:

- Labels: created, already present, or skipped (and why).
- Docs dirs: created, already present.
- The human-only steps from section 4, so the user has them without
  re-reading this file.

All changes are left uncommitted for the user to review and commit. This
skill never runs `git commit`.
