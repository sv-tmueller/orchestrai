# tm-install-team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/tm-install-team` skill that copies/updates the orchestrator team (agents, `tm-*` skills, review workflows) into one or more user config dirs, so the team works in repos it must not be committed to.

**Architecture:** A single user-invocable prose skill, modelled on `tm-sync-template` but with no git, no PR, and a config-dir destination. The source is the local template working tree. Per target it copies additively, detects conflicts by diff (never silently clobbers), stamps the installed SHA, and checks (does not mutate) superpowers enablement.

**Tech Stack:** Markdown skill file (`SKILL.md`) with YAML frontmatter, executed by the model with embedded shell (`cp`, `diff`, `git rev-parse`, `grep`). No code, no dependencies. Spec: `docs/superpowers/specs/2026-06-15-tm-install-team-design.md`.

---

## File structure

- Create: `.claude/skills/tm-install-team/SKILL.md` - the whole skill.
- Modify: `CLAUDE.md` - add `/tm-install-team` to the repo-layout skills list.

No code modules, so no test files. Verification is a dry run of the skill's
shell against throwaway temp dirs (Task 2).

---

### Task 1: Author the skill

**Files:**
- Create: `.claude/skills/tm-install-team/SKILL.md`

- [ ] **Step 1: Write the file with exactly this content**

````markdown
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
`$CLAUDE_CONFIG_DIR`. Treat each target independently: run sections 1-5 once per
target.

## 1. Guard: confirm source and targets

- Confirm the source. This repo must carry the team: check that
  `.claude/agents/`, `.claude/skills/`, and `.claude/workflows/` all exist
  here. If not, stop; you are not in the template checkout.
- Resolve each target to an absolute path (expand a leading `~`). For each,
  print the resolved path and the list of items that will be written, then ask
  the user to confirm before any write. Never write to a target the user has
  not confirmed in this run. The work config dir is sensitive; explicit
  confirmation is required.

## 2. Copy the team into each target (additive, no silent clobber)

For each confirmed target T, create `T/agents`, `T/skills`, `T/workflows` if
they are missing (`mkdir -p`), then process these source items:

- `.claude/agents/*.md`    -> `T/agents/<name>`     (files)
- `.claude/skills/tm-*`    -> `T/skills/<name>`      (whole skill directories)
- `.claude/workflows/*.js` -> `T/workflows/<name>`   (files; skip the
  `.claude/workflows/__tests__/` directory)

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

## 4. Check superpowers (detect and instruct, do not mutate)

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

## 5. Report

For each target, report: the resolved path; files copied; files skipped as
identical; conflicts, and for each whether it was overwritten or left; the
version stamp as `old -> new` (or `none -> new` on first install); and whether
superpowers needs enabling. End with one line: re-run
`/tm-install-team <targets>` after `git pull` to update.

This skill never writes to any repo working tree. Removing a now-redundant
committed team from a consuming repo is separate manual work
(`git rm -r .claude/agents .claude/skills .claude/workflows` plus a PR) and
never applies to this template repo.
````

- [ ] **Step 2: Verify the frontmatter registers**

Run: `head -6 .claude/skills/tm-install-team/SKILL.md`
Expected: `name`, `description`, `disable-model-invocation: true`, and a quoted
`argument-hint` string (quoting matters; an unquoted bracketed value can parse
as a YAML array and silently fail to register).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/tm-install-team/SKILL.md
git commit -m "feat: add tm-install-team skill (#98)"
```

---

### Task 2: Dry-run verification against temp dirs

**Files:** none (runs the skill's shell against throwaway dirs).

This proves the copy, idempotency, conflict detection, multi-target, and
superpowers-check behaviours without touching any real config dir.

- [ ] **Step 1: Set up two empty targets and run the core copy for T1**

```bash
T1=$(mktemp -d); T2=$(mktemp -d); echo "T1=$T1 T2=$T2"
mkdir -p "$T1/agents" "$T1/skills" "$T1/workflows"
cp .claude/agents/*.md "$T1/agents/"
for d in .claude/skills/tm-*; do cp -R "$d" "$T1/skills/"; done
cp .claude/workflows/*.js "$T1/workflows/"
git rev-parse HEAD > "$T1/.tm-team-version"
```

- [ ] **Step 2: Confirm the team landed**

Run:
```bash
ls "$T1/agents" && ls "$T1/skills" && ls "$T1/workflows" && cat "$T1/.tm-team-version"
```
Expected: 4 agent files; the `tm-*` skill dirs (including `tm-install-team`); the
`tm-review-*.js` files and no `__tests__`; a 40-char SHA.

- [ ] **Step 3: Idempotency, identical files are skipped**

Run: `diff -rq .claude/agents "$T1/agents"; diff -rq .claude/workflows/tm-review-changes.js "$T1/workflows/tm-review-changes.js"`
Expected: no output (identical), so a re-run would skip every file.

- [ ] **Step 4: Conflict detection, an edited target file is flagged not clobbered**

Run:
```bash
printf '\nlocal edit\n' >> "$T1/agents/architect.md"
diff -q .claude/agents/architect.md "$T1/agents/architect.md"
```
Expected: `Files ... differ` - this is the conflict the skill lists and asks
about, rather than overwriting.

- [ ] **Step 5: Multi-target independence**

Run:
```bash
mkdir -p "$T2/agents"; cp .claude/agents/*.md "$T2/agents/"; ls "$T2/agents"
```
Expected: T2 populated independently of T1.

- [ ] **Step 6: Superpowers check prints instructions when absent**

Run: `grep -r superpowers "$T1/settings.json" "$T1/.claude.json" 2>/dev/null; echo "exit=$?"`
Expected: no match (`exit=2`), so the skill would print the two enable
commands. (Sanity check the positive case against a real config:
`grep -l superpowers ~/.claude-work/settings.json` prints the path, so the
skill would report superpowers already enabled there.)

- [ ] **Step 7: Clean up**

```bash
rm -rf "$T1" "$T2"
```
Expected: temp dirs removed. No real config dir was touched.

---

### Task 3: Reference the skill in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (repo-layout skills list)

- [ ] **Step 1: Add the skill to the list**

In the `Repo layout` block, change the `skills/` line so it reads:

```
  skills/            project skills: /tm-advisor, /tm-grill-me, /tm-install-team, /tm-kickoff, /tm-sync-template, /tm-to-issues
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: list tm-install-team in repo layout (#98)"
```

---

### Task 4: Open the PR for review

- [ ] **Step 1: Push and mark the draft ready**

```bash
git push -u origin feat/98-tm-install-team
gh pr ready
```

- [ ] **Step 2: Confirm**

Run: `gh pr view --json state,isDraft`
Expected: not draft, open. The PR body should reference `Closes #98`.

---

## Self-review

- **Spec coverage:** new skill (Decision 1) -> Task 1; local-checkout source
  (Decision 2) -> SKILL.md section intro; multi-target (Decision 3) -> SKILL.md
  targets line + Task 2 step 5; diff-and-confirm conflicts (Decision 4) ->
  SKILL.md section 2 + Task 2 steps 3-4; superpowers detect-and-instruct
  (Decision 5) -> SKILL.md section 4 + Task 2 step 6; never touches a repo
  (Decision 6) -> SKILL.md closing line. Verification list in the spec ->
  Task 2 steps 1-7. All covered.
- **Placeholder scan:** none; the full SKILL.md content and every command are
  inline.
- **Consistency:** target variable `T`, stamp file `.tm-team-version`, and the
  agents/skills/workflows source globs are identical across the spec, the
  SKILL.md, and the verification.
