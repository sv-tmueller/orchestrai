# review-codebase Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/tm-review-codebase` workflow that audits an entire repo (defects and structure), bounded by construction and model-pinned per stage, producing a dated markdown report.

**Architecture:** A Sonnet scout maps the repo into at most N coherent areas (default 24, configurable via `args.areas`). One Sonnet worker reviews each area in depth plus one Sonnet architecture worker audits repo-wide structure, all in one parallel barrier. One Opus critic verifies, dedups, writes the report file, and returns a structured summary. Agents per run = N + 3, independent of repo size.

**Tech Stack:** Claude Code Workflow runtime (plain JS, ESM-style `export const meta` plus a top-level `return`). Models pinned in-script (Sonnet workers, Opus critic). No external dependencies. Spec: `docs/superpowers/specs/2026-06-13-review-codebase-design.md`.

> **Amendment 2026-06-14 (supersedes the gitignore decision below):** review
> reports are tracked documentation, not build output. The `.gitignore` step in
> "File structure" and the rationale for ignoring `reviews/` further down are
> reversed: the report is written to `docs/reviews/` and committed, so the audit
> history stays in the record. The original text is left in place below as the
> point-in-time record of what was decided and why.

---

## Design updates after planning

During implementation the design evolved per discussion and supersedes the code
blocks below where they differ. The shipped `.claude/workflows/tm-review-codebase.js`
and the updated spec are canonical:

- The area count is a ceiling (`MAX_AREAS`, default 24), not a fixed cap of 8. The
  scout sizes N to the repo and the script hard-clamps with
  `areas.slice(0, MAX_AREAS)`, so N + 3 holds by construction and scales with repo
  size up to MAX_AREAS + 3.
- When the repo exceeds the ceiling, the shortfall is reported
  (`coverage.ceilingReached`, `areasDropped`, `suggestedNextAction`), never
  silently dropped.
- `args` is normalized for both object and JSON-string callers.

## Testing approach (read first)

This repo has no JS toolchain and no unit-test harness (`tm-review-changes` ships none). Workflow scripts run only inside the Claude Code workflow runtime: they use runtime-injected globals (`agent`, `parallel`, `phase`, `args`) and a top-level `return`, so `node --check` cannot even parse them (the top-level return is illegal outside the runtime's function wrapper). 

The authoritative test is a live run, the same gate `tm-review-changes` and the repo's own CLAUDE.md rely on ("e2e is the safety net unit tests cannot be"). So the order is: write the whole script, run it once on this repo to confirm it works and stays bounded, and only then commit. That is test-then-commit, with an e2e run standing in for the unit test.

## File structure

- Create: `.claude/workflows/tm-review-codebase.js` - the workflow. One file, one responsibility, sibling to `tm-review-changes.js`. Around 150 lines.
- Modify: `CLAUDE.md` - two one-line touch-ups (model-policy worked example, repo-layout workflow list).
- ~~Modify: `.gitignore` - ignore generated `reviews/` output.~~ (Reversed by Amendment 2026-06-14: reports are tracked documentation committed to `docs/reviews/`.)
- No change needed to propagation: `.claude/workflows/` is included in the copy set for `/tm-install-team`, so the new workflow reaches consumers on the next install.

## Conventions to match (from tm-review-changes.js)

- `export const meta` with `name`, `description`, and a `phases` array; each phase carries `title`, `detail`, and `model`.
- Schemas are plain JSON Schema objects with `additionalProperties: false` and explicit `required`.
- Each `agent()` call passes `{ label, phase, model, schema }`. Workers are pinned `sonnet`, the critic `opus`.
- Coverage is tracked by detecting null-padded entries from `parallel()` (a worker that errors or is skipped resolves to `null`), so the critic is told what was not covered. This mirrors the existing tm-review-changes coverage handling.

---

## Task 1: Implement the tm-review-codebase workflow

**Files:**
- Create: `.claude/workflows/tm-review-codebase.js`

> **This task is superseded.** The workflow has shipped. The four code blocks
> below predate the final implementation and diverge from it (default ceiling 8
> instead of 24, missing `ceilingReached`/`suggestedNextAction` in the schema
> and consolidate prompt, missing args normalization). Use the shipped file as
> the source of truth:
>
> `.claude/workflows/tm-review-codebase.js`
>
> Do not implement from the code blocks below. The "Design updates after
> planning" section above documents the three divergences. The blocks are kept
> as a point-in-time record only.

## Task 2: Validate by live run, then commit

**Files:** none changed; this is the green gate.

- [ ] **Step 1: Run the workflow on this repo**

Invoke via the Workflow tool:

```
Workflow({ name: 'tm-review-codebase' })
```

Expected:
- The progress tree shows three phases: `Scout` (1 agent), `Review` (areas + 1 agents), `Consolidate` (1 agent).
- Total agents = number of areas + 3. On this small template repo expect a handful of areas (for example `.claude/agents`, `.claude/skills`, `.claude/workflows`, `docs`), so well under the cap, and `dropped` empty.
- A file `docs/reviews/<today>-codebase-review.md` exists, organized into severity sections (must-fix, then should-fix, then nit), each organized by area, ending with a Coverage section.
- The returned object validates against `REPORT_SCHEMA` (has `verdict`, `summary`, `reportPath`, `mustFix`, `coverage`).

- [ ] **Step 2: Confirm the report file landed**

Run: `ls docs/reviews/ && head -40 docs/reviews/*-codebase-review.md`
Expected: the dated report prints, with a verdict line and findings.

If no file was written, the consolidate agent lacks file tools in this runtime. Fallback: add a `markdown` string field to `REPORT_SCHEMA`, have the critic return the rendered report instead of writing it, and write the file from the returned `markdown` in the session that invoked the workflow. Re-run Step 1.

- [ ] **Step 3: Exercise the cap and coverage path**

Run: `Workflow({ name: 'tm-review-codebase', args: { areas: 2 } })`
Expected: the scout returns 2 areas and a non-empty `dropped`; the report's Coverage section lists the dropped paths; `coverage.areasDropped` is non-empty. This proves coverage is never silently truncated.

- [ ] **Step 4: Commit the workflow**

```bash
git add .claude/workflows/tm-review-codebase.js
git commit -m "feat: add bounded full-codebase review workflow

tm-review-changes only sees the branch diff. tm-review-codebase audits the
whole repo for defects and structure while staying bounded: a Sonnet scout
caps the repo at N areas, Sonnet workers review each area plus repo-wide
structure, and an Opus critic writes a dated report. Agents per run are
N + 3 regardless of repo size.

Closes #37

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 3: Update docs and gitignore

**Files:**
- Modify: `CLAUDE.md` (model-policy worked example; repo-layout workflow list)
- ~~Modify: `.gitignore`~~ (Reversed by Amendment 2026-06-14; see below.)

- [ ] **Step 1: Extend the model-policy worked example**

In `CLAUDE.md`, the "Model policy" section, find the Workflows bullet that ends:

```
  `.claude/workflows/` is the worked example: a fixed set of Sonnet reviewers
  plus one Opus critic, bounded by construction so it cannot fan out into the
  100-agent review that an unpinned session model produces.
```

Append one sentence to that bullet:

```
  `tm-review-codebase` applies the same discipline to a whole-repo audit: a Sonnet
  scout caps the repo at N areas, Sonnet workers review each area plus repo-wide
  structure, and one Opus critic consolidates, so the agent count is N + 3
  regardless of repo size.
```

- [ ] **Step 2: Update the repo-layout workflow list**

In the "Repo layout" code block, change:

```
  workflows/         bounded orchestration scripts (tm-review-changes)
```

to:

```
  workflows/         bounded orchestration scripts (tm-review-changes, tm-review-codebase)
```

- ~~[ ] **Step 3: Ignore generated review output**~~

  ~~Append to `.gitignore`:~~

  ```
  /reviews/
  ```

  ~~Reasoning: the report is a generated artifact, like a build output. Keeping `reviews/` untracked stops audits from being committed by accident here and in downstream repos. A user who wants to keep a specific report can `git add -f` it.~~

  > **Reversed by Amendment 2026-06-14:** reports are tracked documentation,
  > not build output. They are written to `docs/reviews/` and committed so the
  > audit history stays in the record. Do NOT add `/reviews/` to `.gitignore`.

- [ ] **Step 4: Confirm propagation via tm-install-team**

The `.claude/workflows/` directory is included in `tm-install-team`'s copy set. No additional change needed; the new workflow reaches consumers on the next `/tm-install-team` run.

- [ ] **Step 5: Commit the docs**

```bash
git add CLAUDE.md
git commit -m "docs: list tm-review-codebase in model policy and repo layout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 4: Open the PR

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/37-review-codebase
```

- [ ] **Step 2: Open a PR linking the issue**

```bash
gh pr create --title "feat: full-codebase review workflow (/tm-review-codebase)" \
  --body "Adds a bounded, model-pinned /tm-review-codebase workflow (scout + capped area workers + architecture worker + Opus critic) that audits the whole repo and writes a dated report. Verified by live runs (default and areas:2 to exercise the coverage path).

Spec: docs/superpowers/specs/2026-06-13-review-codebase-design.md
Plan: docs/plans/37-review-codebase.md

Closes #37"
```

Note: pushing and opening a PR are outward-facing. Confirm with the user before running Task 4 if they have not already authorized it.

---

## Self-review (filled in during planning)

- **Spec coverage:** Scout, area workers, architecture worker, and Opus critic are all in Task 1. The N+3 bound is asserted in Task 2 Step 1. The markdown report and coverage section are in the shipped workflow and verified in Task 2 Steps 2-3. The CLAUDE.md and sync-template notes from the spec are Task 3. The `area`/`dimension` finding fields and the `coverage`/`reportPath` summary fields are in the shipped workflow schemas. The "verified by live run" decision matches the spec's testing note. No spec section is left unimplemented.
- **Placeholder scan:** No TBD/TODO. Every code step shows complete code; every command shows expected output.
- **Type/name consistency:** `MAP_SCHEMA`, `FINDINGS_SCHEMA`, `REPORT_SCHEMA`, `FINDING`, `AREA` are defined once and referenced consistently. `areas`, `areaResults`, `archResult`, `reviewedAreas`, `workersFailed`, `scoutDropped`, `raw`, `repoMap`, `coverageNote` are each defined before use. The phase names (`Scout`, `Review`, `Consolidate`) match `meta.phases`.
