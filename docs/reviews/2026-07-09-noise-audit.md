# Read-only noise audit - 2026-07-09

Inventory only. Every entry below is a candidate; deciding what to actually
cut, merge, or update happens in a later batch. This audit made no edits
other than adding this file. `tm-to-issues` is excluded (removed by the
sibling package #234).

Every "affected references" list is aggregated per file, not per line, and
every path was confirmed against a live grep hit before being listed here.

Each candidate carries four fields: What it is / Why it reads as noise /
Recommended action (`cut` | `merge` | `update` | `keep`) / Affected
references.

Dead references get a fifth flag: **live** (a current, non-dated surface;
actionable as update/cut) or **historical** (inside a dated snapshot -
`docs/reviews/*`, dated maps, old specs, `docs/plans/*` - preserved by batch
policy, so the only correct action there is keep).

## 1. Overlapping or rarely-used skills

### 1.1 `tm-review-changes` vs `tm-review-codebase`

- **What it is:** two review workflows exposed as thin wrapper skills. Both
  run a fixed set of Sonnet workers plus one Fable critic (the "worked
  example" pattern from `docs/team-guide-rationale.md`).
- **Why it reads as noise:** two "review" commands in the skill list can look
  like the same job done twice.
- **Verified:** they are scoped differently, not duplicated. `tm-review-changes`
  reviews only the current diff across five fixed dimensions (bugs, security,
  style, docs-drift, perf) and takes a base ref. `tm-review-codebase` audits
  the whole repo: a Sonnet scout splits it into N areas (capped at a
  ceiling), one worker per area plus one repo-wide architecture worker, then
  a critic that writes a dated report. Different trigger points (per-PR vs
  periodic full-repo), different inputs, different report shapes.
- **Recommended action:** keep.
- **Affected references:** `.claude/skills/tm-review-changes/SKILL.md`,
  `.claude/skills/tm-review-codebase/SKILL.md`,
  `.claude/workflows/tm-review-changes.js`,
  `.claude/workflows/tm-review-codebase.js`, `docs/team-guide-rationale.md`.

### 1.2 `tm-map-codebase` vs `tm-review-codebase`

- **What it is:** two full-repo workflows that share the same scout/worker/
  critic shape (`docs/team-guide-rationale.md`: "`tm-map-codebase` reuses the
  same scout/worker/critic shape").
- **Why it reads as noise:** near-identical scaffolding code (scout prompt,
  area-splitting logic, ceiling handling) in two workflow files can look like
  accidental duplication.
- **Verified:** the shared shape is documented and intentional, and the
  outputs are functionally distinct. `tm-review-codebase` produces findings
  with severities per area plus a repo-wide architecture pass (agent count
  N + 3). `tm-map-codebase` drops the architecture worker and produces a
  purely descriptive map (purpose, entry points, data/control flow, no
  findings, no severities) (agent count N + 2). The workflow files themselves
  say so: `tm-review-codebase.js` notes "This list stays at five and does not
  track tm-review-changes.js's dimension list", and `tm-map-codebase.js`
  states in its description "This is a map, not a review: no findings, no
  severities, no recommendations."
- **Recommended action:** keep. The code-shape overlap is a deliberate,
  documented reuse pattern, not noise; splitting it out into a shared helper
  is a refactor question for a later batch, not a noise-audit finding.
- **Affected references:** `.claude/skills/tm-map-codebase/SKILL.md`,
  `.claude/skills/tm-review-codebase/SKILL.md`,
  `.claude/workflows/tm-map-codebase.js`,
  `.claude/workflows/tm-review-codebase.js`, `docs/team-guide-rationale.md`.

### 1.3 `tm-new-project` (with `NEW-PROJECT-SETUP.md`)

- **What it is:** the once-per-repo adoption skill (creates the workflow
  labels and docs tree, prints the human-only setup steps) and its checklist
  doc.
- **Why it reads as noise:** this repo (orchestrai) already has its labels
  and docs tree; the skill and its checklist have no live job to do here, so
  they sit in the tree unused by the project that ships them.
- **Verified:** this is not an oversight. `docs/architecture/operating-model.md`
  section 3 already records the decision: orchestrai's identity as a plugin
  (not a template) is settled, and "`NEW-PROJECT-SETUP.md` and
  `.claude/skills/tm-new-project/` remain physically present in the tree...
  Removing them is deferred to the usability batch, not this change."
- **Recommended action:** keep as-is; the cut is already scheduled elsewhere
  (the usability batch referenced in `operating-model.md`). This audit does
  not re-schedule it or act on it.
- **Affected references:** `.claude/skills/tm-new-project/SKILL.md`,
  `NEW-PROJECT-SETUP.md`, `docs/architecture/operating-model.md`, `README.md`.

## 2. Stale or duplicated docs

### 2.1 The three dated codebase-review reports (06-13, 06-14, 06-30)

- **What it is:** three full-repo review reports in `docs/reviews/`, all
  titled "Codebase review - <date>", roughly two to three weeks apart.
- **Why it reads as noise:** three same-titled reports in one folder can look
  like repeated, redundant snapshots of the same audit.
- **Verified:** they are not duplicates. Each has a distinct verdict section
  with different concrete findings (06-13 is the pre-rename baseline and
  carries an explicit "Historical record" banner mapping its old `/kickoff`-
  style paths to today's `tm-` names; 06-14's must-fix is a truthy-check bug
  in `tm-review-codebase.js`'s area ceiling; 06-30's must-fix is a
  non-anchored `gh pr list --search` false-positive in the kickoff gate).
  Each is a legitimate point-in-time snapshot, not a copy of the last one.
- **Recommended action:** keep (historical record; all three are dated
  snapshots under `docs/reviews/`).
- **Affected references:** `docs/reviews/2026-06-13-codebase-review.md`,
  `docs/reviews/2026-06-14-codebase-review.md`,
  `docs/reviews/2026-06-30-codebase-review.md`.

### 2.2 The two awesome-claude-agents docs

- **What it is:**
  `docs/research/2026-07-04-awesome-claude-agents-adoption.md` (research, one
  day earlier) and `docs/reviews/2026-07-05-awesome-claude-agents-survey.md`
  (a survey, one day later), both mining the same external repo
  (`vijaythecoder/awesome-claude-agents`) for the same issue (#163).
- **Why it reads as noise:** same source repo, same issue, one day apart,
  filed in two different `docs/` subtrees - looks like a duplicate or a
  misfile.
- **Verified:** not a duplicate. The survey doc has its own "Relation to the
  prior research doc" section: the prior doc read `agents/orchestrators/*`
  and two `agents/universal/`/`agents/specialized/` files; the survey doc
  explicitly covers `agents/core/`, "the one agent group the prior research
  pass on this same source repo did not read", and states "None of the four
  duplicates the prior doc's five process ideas." Complementary passes over
  disjoint parts of the same source, not two copies of the same analysis.
- **Minor note (not a separate candidate):** the survey doc's placement under
  `docs/reviews/` is a loose fit against this repo's own stated purpose for
  that folder ("dated codebase-review reports from /tm-review-codebase" per
  `CLAUDE.md`'s Repo layout) - it is a manual survey of an external repo, not
  a `tm-review-codebase` output. `docs/reviews/2026-06-30-orchestration-comparison.md`
  has the same loose fit (a research comparison, not a `tm-review-codebase`
  report). Both are dated files; relocating historical files retroactively is
  out of scope for this audit.
- **Recommended action:** keep (historical record; both are dated, and
  verified as complementary rather than duplicate).
- **Affected references:**
  `docs/research/2026-07-04-awesome-claude-agents-adoption.md`,
  `docs/reviews/2026-07-05-awesome-claude-agents-survey.md`.

### 2.3 `tm-docs-writer` / `tm-optimize` naming in the survey doc

- **What it is:** two adoption-candidate names proposed in
  `docs/reviews/2026-07-05-awesome-claude-agents-survey.md` ("Adaptation: a
  `tm-docs-writer` execution seat...", "Adaptation:... `tm-optimize`..."). The
  agents that were actually built from these proposals now ship as
  `docs-writer` and `perf-investigator` (`.claude/agents/docs-writer.md`,
  `.claude/agents/perf-investigator.md`), not under the proposed names.
- **Why it reads as noise:** grepping the repo for `tm-docs-writer` or
  `tm-optimize` returns exactly one file, which can look like a dead
  reference to a skill that was never built.
- **Verified:** these are proposal-stage names in a survey doc, not dead
  references. Nothing else in the repo points at "`tm-docs-writer`" or
  "`tm-optimize`" expecting them to resolve; the shipped agents correctly
  carry their final names elsewhere. The survey doc's naming is a snapshot of
  what was proposed on 2026-07-05, not a stale pointer.
- **Recommended action:** keep (historical record; the proposal names are
  correctly distinct from, and do not need to track, the shipped agent
  names).
- **Affected references:**
  `docs/reviews/2026-07-05-awesome-claude-agents-survey.md`.

## 3. Dead references

### 3.1 `tm-sync-template`

- **What it is:** a skill name for the old machinery-sync role, deprecated by
  `docs/superpowers/specs/2026-06-16-process-guidance-rehoming-design.md`
  ("Process guidance moves user-global; tm-sync-template is deprecated"). No
  `.claude/skills/tm-sync-template/` directory exists.
- **Why it reads as noise:** roughly 33 hits across the docs tree for a skill
  that no longer exists.
- **Live-vs-historical:** historical only. All hits are in dated files:
  `docs/plans/98-tm-install-team.md` (2),
  `docs/reviews/2026-06-13-codebase-review.md` (1),
  `docs/reviews/2026-06-14-codebase-review.md` (7),
  `docs/reviews/2026-06-30-codebase-review.md` (11),
  `docs/superpowers/specs/2026-06-15-tm-install-team-design.md` (8),
  `docs/superpowers/specs/2026-06-16-process-guidance-rehoming-design.md` (4).
  Zero hits in README.md, CLAUDE.md, `.claude/team-guide.md`, or any live
  skill/agent/workflow file.
- **Recommended action:** keep (historical record only; nothing live to
  update or cut).
- **Affected references:** `docs/plans/98-tm-install-team.md`,
  `docs/reviews/2026-06-13-codebase-review.md`,
  `docs/reviews/2026-06-14-codebase-review.md`,
  `docs/reviews/2026-06-30-codebase-review.md`,
  `docs/superpowers/specs/2026-06-15-tm-install-team-design.md`,
  `docs/superpowers/specs/2026-06-16-process-guidance-rehoming-design.md`.

### 3.2 `tm-install-team`

- **What it is:** a skill (and its file, `.claude/skills/tm-install-team/SKILL.md`)
  that synced the team into a user-global config dir. Retired and deleted by
  issue #143 ("Rebrand plugin to orchestrai... and retire tm-install-team"),
  replaced by the plugin-marketplace install flow documented in README.md's
  "Getting the team into your repos".
- **Why it reads as noise:** roughly 45 hits for a skill and a file path that
  no longer exist anywhere in the tree.
- **Live-vs-historical:** historical only. All hits are in dated files:
  `docs/architecture/2026-07-05-codebase-map.md` (1, a dated map),
  `docs/plans/37-review-codebase.md` (3),
  `docs/plans/98-tm-install-team.md` (17),
  `docs/reviews/2026-06-30-codebase-review.md` (8),
  `docs/superpowers/specs/2026-06-13-review-codebase-design.md` (1),
  `docs/superpowers/specs/2026-06-15-tm-install-team-design.md` (9),
  `docs/superpowers/specs/2026-06-16-process-guidance-rehoming-design.md` (6).
  Zero hits in README.md, CLAUDE.md, `.claude/team-guide.md`, or any live
  skill/agent/workflow file (confirmed also by issue #143's own acceptance
  criterion: "`.claude/skills/tm-install-team/` does not exist; no current
  doc instructs running it").
- **Recommended action:** keep (historical record only; nothing live to
  update or cut).
- **Affected references:** `docs/architecture/2026-07-05-codebase-map.md`,
  `docs/plans/37-review-codebase.md`, `docs/plans/98-tm-install-team.md`,
  `docs/reviews/2026-06-30-codebase-review.md`,
  `docs/superpowers/specs/2026-06-13-review-codebase-design.md`,
  `docs/superpowers/specs/2026-06-15-tm-install-team-design.md`,
  `docs/superpowers/specs/2026-06-16-process-guidance-rehoming-design.md`.

### 3.3 `.tm-team-version` stamp file (and its pre-rename name `.claude/template-version`)

- **What it is:** a version-stamp file the old `tm-install-team` sync flow
  read to compute a diff against the template. Never present in the tree
  (`find . -name ".tm-team-version"` returns nothing); its pre-rename name,
  `.claude/template-version`, is likewise absent.
- **Why it reads as noise:** the file is referenced as if it exists, but was
  never actually shipped in this repo (design/plan artifact of a mechanism
  that was retired before or as it landed).
- **Live-vs-historical:** historical only. `.tm-team-version` hits:
  `docs/plans/98-tm-install-team.md` (6),
  `docs/superpowers/specs/2026-06-15-tm-install-team-design.md` (2).
  `.claude/template-version` hits (pre-rename name for the same idea):
  `docs/reviews/2026-06-13-codebase-review.md`,
  `docs/reviews/2026-06-14-codebase-review.md`. Zero hits in any live surface.
- **Recommended action:** keep (historical record only).
- **Affected references:** `docs/plans/98-tm-install-team.md`,
  `docs/superpowers/specs/2026-06-15-tm-install-team-design.md`,
  `docs/reviews/2026-06-13-codebase-review.md`,
  `docs/reviews/2026-06-14-codebase-review.md`.

### 3.4 Pre-tm-rename skill/workflow paths (`.claude/skills/kickoff/SKILL.md`, `.claude/workflows/review-codebase.js`)

- **What it is:** unprefixed paths (`kickoff`, `review-codebase.js`) from
  before the project-wide `tm-` rename (commit 6940104). The files now live
  at `.claude/skills/tm-kickoff/SKILL.md` and
  `.claude/workflows/tm-review-codebase.js`.
- **Why it reads as noise:** paths that resolve to nothing in the current
  tree, referenced as if they were current.
- **Live-vs-historical:** historical only, and self-flagged as such. Both
  paths appear only in `docs/reviews/2026-06-13-codebase-review.md` and
  `docs/reviews/2026-06-14-codebase-review.md`; the 06-13 report carries an
  explicit banner: "All skill and workflow paths in this report... predate
  the tm- rename (commit 6940104). Their current equivalents carry the `tm-`
  prefix... The finding headers and text are preserved verbatim." Zero hits
  in any live surface.
- **Recommended action:** keep (historical record only; the reports already
  document their own staleness).
- **Affected references:** `docs/reviews/2026-06-13-codebase-review.md`,
  `docs/reviews/2026-06-14-codebase-review.md`.

### 3.5 `docs/operations/` and `e2e/` declared in live docs but absent from the tree

- **What it is:** `CLAUDE.md`'s "Repo layout" section and
  `.claude/team-guide.md`'s "Tests" section both name `docs/operations/` and
  `e2e/` as parts of the standard layout ("how to run, deploy, and operate the
  system", "End-to-end tests live in `e2e/` and gate deployment"). Neither
  directory exists anywhere in the tree.
- **Why it reads as noise:** these are live, non-dated surfaces pointing at
  paths with nothing behind them, which looks the same shape as the dead refs
  above.
- **Why it is different from 3.1-3.4:** this is not a pointer to something
  that was removed; it is a declared taxonomy category that has never been
  populated. `CLAUDE.md` itself says "There is no application runtime, so
  install, dev, typecheck, and lint are N/A" - this repo has no deploy target
  and no full-stack code to end-to-end test yet, so the categories are
  legitimately empty rather than broken.
- **Live-vs-historical:** live (`CLAUDE.md`, `.claude/team-guide.md` are both
  live, non-dated surfaces).
- **Recommended action:** keep as a placeholder taxonomy entry for now;
  flagged for visibility only. Whether to add a stub, add a caveat sentence,
  or leave as-is is a decision for a later batch once it is clear whether
  this repo will ever have an ops surface or an e2e suite.
- **Affected references:** `CLAUDE.md`, `.claude/team-guide.md`.

## Summary table

| Candidate | Action |
|---|---|
| `tm-review-changes` vs `tm-review-codebase` | keep |
| `tm-map-codebase` vs `tm-review-codebase` | keep |
| `tm-new-project` + `NEW-PROJECT-SETUP.md` | keep (cut already scheduled elsewhere) |
| Three dated codebase-review reports (06-13/06-14/06-30) | keep |
| Two awesome-claude-agents docs (research 07-04 / survey 07-05) | keep |
| `tm-docs-writer` / `tm-optimize` naming in the survey doc | keep |
| `tm-sync-template` dead ref | keep (historical) |
| `tm-install-team` dead ref | keep (historical) |
| `.tm-team-version` / `.claude/template-version` dead ref | keep (historical) |
| Pre-tm-rename paths (`kickoff`, `review-codebase.js`) | keep (historical) |
| `docs/operations/` and `e2e/` (declared, unpopulated) | keep (live placeholder, flagged) |
