---
name: tm-new-project
description: "Run the once-per-repo new-project setup as a guided flow: create the workflow labels, the docs tree, and fill the CLAUDE.md placeholders by interview; print the human-only steps (branch protection, CI, design-plugin vetting); and retire NEW-PROJECT-SETUP.md once its checklist is done. User-invocable only."
disable-model-invocation: true
---

Run the setup in `NEW-PROJECT-SETUP.md` against the current repo (the cwd):
automate what can be automated, print exact commands for what cannot, and
retire the checklist file once it is done. Idempotent: each section below
checks its own precondition and skips what is already done, so re-running
after a partial setup only finishes what is left.

## 1. Detect state

Check, in this repo:

- The three CLAUDE.md placeholder sentinels (exact-string match against
  `CLAUDE.md`):
  - `Describe in 2-3 sentences what this project does`
  - `Add project-specific style rules here`
  - `Record the exact commands once the project is scaffolded`
- The five docs dirs: `docs/architecture`, `docs/operations`, `docs/plans`,
  `docs/reviews`, `docs/superpowers/specs`.
- `NEW-PROJECT-SETUP.md` at the repo root.

**Already set up:** all three sentinels absent, all five dirs present, and no
`NEW-PROJECT-SETUP.md`. Stop here; do not run sections 2-7. Also check
whether the six canonical labels exist (`gh label list`), skipping that check
with a note if there is no GitHub remote or `gh` auth. Missing labels are
noted in the report but do not block the exit or get created. Report:

    Already set up: no CLAUDE.md placeholders, docs tree present, no
    NEW-PROJECT-SETUP.md. Nothing to do.
    Labels: <all present | missing: <names> | not checked: <reason>>

**No CLAUDE.md** (a config-dir or plugin install into a repo this template
never seeded): skip section 4 (interview), with a note; this skill does not
author a CLAUDE.md from scratch. Sections 2, 3, and 5 do not depend on
CLAUDE.md and still run. Section 6 (clean up) depends only on
`NEW-PROJECT-SETUP.md`'s presence, not on CLAUDE.md; see section 6.

Otherwise, continue through sections 2-7 below. Each checks its own
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

## 4. CLAUDE.md interview

Skip this section, with a note, if there is no `CLAUDE.md` (see section 1) or
if none of the three sentinels are present (already filled in). Otherwise,
for each sentinel still present, ask the user and replace only that
placeholder text, leaving the rest of the file untouched:

- **"What this repo is"** (`Describe in 2-3 sentences...` sentinel): ask what
  the project does, who uses it, and its current status (pre-implementation,
  MVP, in production). Write 2-3 sentences.
- **"Useful commands"** (`Record the exact commands...` sentinel): ask for
  the real install, dev, typecheck, lint, test, and e2e commands, delete the
  caption sentence (both wrapped lines), and fill the `bash` block with
  them.
- **"Code style"** (`Add project-specific style rules here` sentinel): first
  ask for the project's tech stack (languages, frameworks, key libraries),
  recorded from the answer, not detected by scanning any manifest. Then ask
  for any project-specific style rules. Replace the placeholder with style
  rules appropriate to that stack, plus any the user gave; if there is
  neither a stack nor rules, delete the placeholder as before.

## 5. Print human-only steps

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
`/plugin install superpowers@claude-plugins-official`.

(Optional, UI projects only) Enable the design plugins. They are not on by
default, so the template stays generic. Vet the two third-party plugins
before enabling them in a project others build on; their install steps live
in their repos and may change.

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

## 6. Clean up

Only when `NEW-PROJECT-SETUP.md` exists at the repo root (if it is already
gone, skip this section, nothing to do). The human-only steps in section 5
are still open at this point, so confirm with the user before touching
anything: tell them branch protection, CI, and first-slice-of-work are
manual and still outstanding, and ask whether to clean up anyway. On
confirmation, mirroring `NEW-PROJECT-SETUP.md` section 7's order:

1. Remove every `(see NEW-PROJECT-SETUP)` pointer from `CLAUDE.md`, in
   "Where decisions live" and "Repo layout" (there is no fixed count; remove
   every occurrence, not a specific number). If `CLAUDE.md` does not exist,
   there is nothing to remove; go straight to step 2.
2. Delete `NEW-PROJECT-SETUP.md`.

## 7. Report

Report, in this order:

- Labels: created, already present, or skipped (and why).
- Docs dirs: created, already present.
- CLAUDE.md: sections filled, sections already filled (skipped), or skipped
  entirely (no CLAUDE.md).
- The human-only steps from section 5, so the user has them without
  re-reading this file.
- Clean up: pointers removed and file deleted, or skipped (why: no
  `NEW-PROJECT-SETUP.md`, or the user declined).

All changes are left uncommitted for the user to review and commit. This
skill never runs `git commit`.
