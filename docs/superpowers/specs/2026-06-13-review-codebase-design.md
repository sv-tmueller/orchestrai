# review-codebase workflow - design

Date: 2026-06-13
Status: approved (brainstorming), ready for implementation plan

> **Amendment 2026-06-14:** the report is tracked, not gitignored. The original
> plan (#37) classed it as a generated build artifact and ignored `reviews/`; that
> call is reversed. A codebase-review report is documentation, so it is written to
> `docs/reviews/` and committed, and the audit history stays part of the record.
> The "Report contract" path below is updated to match; the original reasoning is
> preserved in plan #37 as the point-in-time record.

## Context

`/tm-review-changes` reviews the branch diff: a fixed set of Sonnet workers, one per
dimension, plus one Opus critic. It is bounded because a diff is small. It cannot
see anything the diff does not touch.

Sometimes a full pass over the whole codebase is needed, not just the branch:
auditing an inherited or drifting repo, a pre-release sweep, or finding latent
defects and structural problems that no recent diff would surface.

A naive "review everything" is unbounded. A whole repo does not fit one agent's
context, and the dimension-per-worker shape of tm-review-changes does not scale (a
single "bugs" worker cannot read an entire repo). This workflow ships in the
template and runs in downstream repos of unknown size, so the bound has to hold
regardless of how large the target repo is.

## Goals

- A `/tm-review-codebase` workflow that reviews an entire repo (or a named subtree).
- Bounded by construction and model-pinned per stage, the same discipline as
  `tm-review-changes`, so it never inherits an expensive session model or fans out
  into a 100-agent review.
- Surfaces both latent defects and whole-repo structural problems.
- Produces a durable, dated markdown report plus a short chat summary.

## Non-goals

- No GitHub issue creation. Turn must-fix findings into issues with `/tm-to-issues`
  afterward.
- No auto-fix. Workers are read-only; the only file written is the report.
- No per-file fan-out, no loops, no history or blame analysis.

## Decisions

Three choices were settled during brainstorming:

1. Focus: both defects and structure (not just the tm-review-changes lens, not
   structure-only).
2. Bounding: a scout maps the repo into a capped set of areas; one worker reviews
   each area in depth, plus one dedicated worker audits repo-wide structure.
3. Output: a markdown report file plus a chat summary.

## Architecture

Four stages. The fan-out unit is the repo area, not the dimension.

```
scout (sonnet, 1 agent)
  git ls-files, skip vendored/build dirs, group into <=N coherent areas
  ranked by importance; emit areas[] + dropped[] (overflow beyond the cap)

review (parallel, sonnet):
  area#1 ... area#N   depth: each reads its area's files in full and reviews
                      the defect checklist, returning findings
  architecture        breadth: reads layout, imports, manifests, and
                      duplication / dead-code suspects from signatures and
                      the scout map, not full file bodies

consolidate (opus, 1 agent)
  verify, dedup (including cross-area), set severities, decide verdict,
  write the markdown report, return a structured summary
```

The architecture worker receives the scout's repo-map for global context; area
workers receive only their own name and paths. Scout and all workers are pinned
to Sonnet (cheap, parallel). The critic is pinned to Opus
(synthesis and judgment). This is the model split the CLAUDE.md model policy
prescribes; tm-review-codebase becomes a second worked example next to
tm-review-changes.

### Stages in detail

- Scout (Sonnet): enumerates source files via `git ls-files`, skips vendored and
  build directories (node_modules, dist, build, vendor, .git, and similar),
  groups files into at most N coherent areas (by module and directory, sized to
  fit a worker's context), and ranks areas by importance (size and centrality).
  Returns `areas[]` (name, paths/globs, rationale) and `dropped[]` (anything not
  assigned because the repo exceeded the cap). Schema-validated.
- Area workers (Sonnet, one per area): read the area's files in full and report
  findings across the defect checklist. Read-only.
- Architecture worker (Sonnet, one): reviews the repo at the structural level
  using signatures, imports, manifests, and the scout map rather than full
  bodies, so it fits context. Read-only.
- Critic (Opus, one): verifies findings against the code, drops false positives
  and out-of-scope items, merges duplicates (including the same problem found in
  two areas), sets final severities, decides the verdict, writes the report file,
  and returns the structured summary.

## Bounding guarantee

Agents per run = 1 (scout) + (N + 1) (area workers + architecture worker) + 1
(critic) = N + 3. N is the number of areas, sized by the scout to the repo and
hard-clamped in-script to a ceiling `MAX_AREAS` (default 24), so the count scales
with repo size but never exceeds MAX_AREAS + 3 (27 by default). A small repo uses
far fewer; the scout is told to size N to the codebase, not pad to the ceiling.
There is no per-file fan-out and no loop. The ceiling is overridable per run via
`args.areas`.

The clamp is structural (`areas.slice(0, MAX_AREAS)`), so the bound holds even if
the scout returns more areas than asked. When the repo is too big for MAX_AREAS
areas, the leftover is reported, not silently skipped: `coverage.ceilingReached`
is set, `coverage.areasDropped` lists the uncovered paths, and
`coverage.suggestedNextAction` tells the caller to re-run with a higher `areas`
cap or a scoped `path`. This is the same no-silent-truncation discipline as the
tm-review-changes coverage fix.

## What each reviewer looks for

Area workers reuse the five tm-review-changes dimensions, worded for whole files
rather than a diff, reusing the existing briefs where possible for consistency:

- bugs (adversarial correctness, edge cases, error paths, races, resource leaks)
- security (untrusted input to a sink, authn/authz gaps, secrets, weak crypto,
  dependency risk)
- scope and simplicity (speculative abstraction, dead configurability, code that
  could be much smaller)
- tests (behavior with no test pinning it, logic lacking a test, untested
  integration points)
- style (CLAUDE.md code and writing style)

The architecture worker covers the whole-repo concerns a diff cannot show:

- module boundaries and layering, and where they have drifted
- duplication across modules
- dead or orphaned code
- dependency health (unused, outdated, or risky dependencies)
- test-coverage gaps at the suite level

## Report contract

The critic writes `docs/reviews/<YYYY-MM-DD>-codebase-review.md`, organized into
severity sections (must-fix, then should-fix, then nit), each organized by area,
ending with a coverage section that lists areas reviewed, areas dropped by the
cap, and any worker that failed to return. The chat shows a short verdict and
summary plus the report path.

The finding shape reuses the tm-review-changes `FINDING` (file, line, severity,
problem, fix) and adds `area` and `dimension`. The returned summary reuses the
tm-review-changes `REPORT_SCHEMA` shape (verdict, summary, mustFix, shouldFix, nits,
dismissed) and adds a `coverage` object (areas reviewed, areas dropped,
`ceilingReached`, `suggestedNextAction`, failed workers) and `reportPath`.

## Mechanics and constraints

- Workflow scripts cannot call `Date.now()` or touch the filesystem. The report
  date is stamped by the critic agent (it runs `date +%F`), and the critic agent
  writes the report file itself, since the script cannot. Area and architecture
  workers stay read-only.
- Optional args: `path` (scope to a subdirectory, default the whole repo),
  `areas` (override the ceiling, default 24). args may arrive as an object or, via
  some callers, as a JSON string, so the script normalizes both. Both have safe
  defaults so `/tm-review-codebase` with no args works in any repo.

## Template and process notes

- The workflow lives at `.claude/workflows/tm-review-codebase.js`. It must be
  synced to consumers with `/tm-sync-template`.
- CLAUDE.md needs a one-line addition in the model-policy section
  (tm-review-codebase as a second bounded example) and in the workflow list.
- Per the repo process this is a GitHub issue first. It fits the
  `feat/33-efficient-model-routing` theme or stands as its own issue, then spec
  (this document) to plan to implementation.
- Verification is a real run of `/tm-review-codebase` on this template repo,
  confirming the agent count stays at N + 3 and the report is coherent. JS
  workflows have no unit-test harness, so the run is the test.

## Out of scope

GitHub issue creation, auto-fix, per-file fan-out, and history or blame analysis
are deliberately excluded. The report is the deliverable.
