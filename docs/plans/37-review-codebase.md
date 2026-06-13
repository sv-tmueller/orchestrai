# review-codebase Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/review-codebase` workflow that audits an entire repo (defects and structure), bounded by construction and model-pinned per stage, producing a dated markdown report.

**Architecture:** A Sonnet scout maps the repo into at most N coherent areas (default 8). One Sonnet worker reviews each area in depth plus one Sonnet architecture worker audits repo-wide structure, all in one parallel barrier. One Opus critic verifies, dedups, writes the report file, and returns a structured summary. Agents per run = N + 3, independent of repo size.

**Tech Stack:** Claude Code Workflow runtime (plain JS, ESM-style `export const meta` plus a top-level `return`). Models pinned in-script (Sonnet workers, Opus critic). No external dependencies. Spec: `docs/superpowers/specs/2026-06-13-review-codebase-design.md`.

---

## Design updates after planning

During implementation the design evolved per discussion and supersedes the code
blocks below where they differ. The shipped `.claude/workflows/review-codebase.js`
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

This repo has no JS toolchain and no unit-test harness (`review-changes` ships none). Workflow scripts run only inside the Claude Code workflow runtime: they use runtime-injected globals (`agent`, `parallel`, `phase`, `args`) and a top-level `return`, so `node --check` cannot even parse them (the top-level return is illegal outside the runtime's function wrapper). 

The authoritative test is a live run, the same gate `review-changes` and the repo's own CLAUDE.md rely on ("e2e is the safety net unit tests cannot be"). So the order is: write the whole script, run it once on this repo to confirm it works and stays bounded, and only then commit. That is test-then-commit, with an e2e run standing in for the unit test.

## File structure

- Create: `.claude/workflows/review-codebase.js` - the workflow. One file, one responsibility, sibling to `review-changes.js`. Around 150 lines.
- Modify: `CLAUDE.md` - two one-line touch-ups (model-policy worked example, repo-layout workflow list).
- Modify: `.gitignore` - ignore generated `reviews/` output.
- No change needed: `.claude/skills/sync-template/SKILL.md` already copies `.claude/workflows/`, so the new workflow propagates to downstream repos automatically.

## Conventions to match (from review-changes.js)

- `export const meta` with `name`, `description`, and a `phases` array; each phase carries `title`, `detail`, and `model`.
- Schemas are plain JSON Schema objects with `additionalProperties: false` and explicit `required`.
- Each `agent()` call passes `{ label, phase, model, schema }`. Workers are pinned `sonnet`, the critic `opus`.
- Coverage is tracked by detecting null-padded entries from `parallel()` (a worker that errors or is skipped resolves to `null`), so the critic is told what was not covered. This mirrors the existing review-changes coverage handling.

---

## Task 1: Implement the review-codebase workflow

**Files:**
- Create: `.claude/workflows/review-codebase.js`

Write the file in four contiguous blocks (meta + args + schemas, then scout, then review, then consolidate). The complete file is below; add it in order so the script reads top to bottom.

- [ ] **Step 1: Write meta, args, and schemas**

```js
export const meta = {
  name: 'review-codebase',
  description:
    'Token-bounded full-repo review: a Sonnet scout maps the repo into a capped set of areas, Sonnet workers review each area plus repo-wide structure, and one Opus critic verifies, writes a dated report, and consolidates. Models are pinned per stage in-script, so it never inherits an expensive session model and the agent count does not grow with repo size.',
  phases: [
    { title: 'Scout', detail: 'one Sonnet agent maps the repo into <=N areas', model: 'sonnet' },
    { title: 'Review', detail: 'one Sonnet worker per area plus one architecture worker', model: 'sonnet' },
    { title: 'Consolidate', detail: 'one Opus critic verifies, writes the report, consolidates', model: 'opus' },
  ],
}

// Bounded by construction. The scout caps the number of areas at CAP, so a run is
// exactly 1 scout + (CAP area workers + 1 architecture worker) + 1 critic = CAP + 3
// agents, regardless of repo size. There is no per-file fan-out and no loop.
// Models are pinned per stage, so a Fable or Opus session never leaks into the
// scout or the workers.
//
// Invoke with optional args:
//   Workflow({ name: 'review-codebase', args: { path: 'src', areas: 8 } })

const root = (args && args.path) || '.'
const CAP = (args && args.areas) || 8

const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    dimension: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'string', description: 'line number or range, or "n/a"' },
    severity: { type: 'string', enum: ['must-fix', 'should-fix', 'nit'] },
    problem: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['area', 'dimension', 'file', 'line', 'severity', 'problem', 'fix'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { findings: { type: 'array', items: FINDING } },
  required: ['findings'],
}

const AREA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'directories or globs that make up this area',
    },
    why: { type: 'string', description: 'why this is one coherent area and how it ranks' },
  },
  required: ['name', 'paths', 'why'],
}

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    areas: { type: 'array', items: AREA },
    dropped: {
      type: 'array',
      items: { type: 'string' },
      description: 'paths left uncovered because the area cap was reached',
    },
  },
  required: ['areas', 'dropped'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes-requested'] },
    summary: { type: 'string' },
    reportPath: { type: 'string' },
    mustFix: { type: 'array', items: FINDING },
    shouldFix: { type: 'array', items: FINDING },
    nits: { type: 'array', items: FINDING },
    dismissed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { problem: { type: 'string' }, why: { type: 'string' } },
        required: ['problem', 'why'],
      },
      description: 'findings judged false-positive or out of scope, with the reason',
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        areasReviewed: { type: 'array', items: { type: 'string' } },
        areasDropped: { type: 'array', items: { type: 'string' } },
        workersFailed: { type: 'array', items: { type: 'string' } },
      },
      required: ['areasReviewed', 'areasDropped', 'workersFailed'],
    },
  },
  required: ['verdict', 'summary', 'reportPath', 'mustFix', 'coverage'],
}

const scope = `Work from the repo root scoped to "${root}". List source files with \`git ls-files -- ${root}\` (it already respects .gitignore); ignore vendored and generated trees (node_modules, dist, build, vendor, .git, coverage) and lockfiles.`

const dimensions = `Review across these dimensions:
- bugs: adversarial correctness. Logic errors, wrong or missing edge-case handling, broken error paths, races and ordering bugs, off-by-one, misused or wrongly-assumed APIs, null and boundary handling, resource leaks.
- security: untrusted input reaching a sink (injection, path traversal, SSRF, unsafe deserialization), missing authn or authz, secrets or credentials in code or logs, unsafe defaults, weak crypto, risky dependencies.
- scope: speculative abstraction, dead configurability, code that could be much smaller.
- tests: behavior with no test pinning it, logic with a right answer lacking a test, integration points with no fixture coverage.
- style: project code and writing style (em dashes, AI-cliche phrases, hard-coded user-facing strings, raw primitives where dedicated types exist, comments that restate code).`
```

- [ ] **Step 2: Append the scout stage**

```js
phase('Scout')
const map = await agent(
  `You map a repository into coherent review areas. You do not review code in this step.\n\n${scope}\n\nGroup the files into at most ${CAP} areas. An area is a set of files that belong together (a module, package, or directory subtree) and is small enough to read in one pass. Rank areas by importance: size and how central they are to the system. If the repo needs more than ${CAP} areas to cover fully, cover the ${CAP} most important and put every path you leave out in "dropped". Return areas (name, paths, why) and dropped.`,
  { label: 'scout', phase: 'Scout', model: 'sonnet', schema: MAP_SCHEMA }
)

const areas = map && Array.isArray(map.areas) ? map.areas : []
const scoutDropped = map && Array.isArray(map.dropped) ? map.dropped : []
```

- [ ] **Step 3: Append the review stage**

```js
phase('Review')
const repoMap = areas.map((a) => `- ${a.name}: ${a.paths.join(', ')}`).join('\n')

const reviewThunks = areas.map((a) => () =>
  agent(
    `You review one area of a codebase and report findings only. You never edit.\n\nArea: ${a.name}\nPaths: ${a.paths.join(', ')}\n\nRead these files in full, with surrounding context where needed. ${dimensions}\n\nReport every finding with area ("${a.name}"), dimension, file, line, severity (must-fix | should-fix | nit), the problem, and the required fix. If the area is clean, return an empty findings array. Stay within your area.`,
    { label: `area:${a.name}`, phase: 'Review', model: 'sonnet', schema: FINDINGS_SCHEMA }
  )
)

reviewThunks.push(() =>
  agent(
    `You audit a repository's structure and report findings only. You never edit. Use dimension "architecture".\n\n${scope}\n\nRead the directory layout, module boundaries, imports, and dependency manifests. Read signatures and imports rather than full file bodies, so you can hold the whole tree in view. The area map is:\n${repoMap}\n\nFlag: module boundaries and layering that have drifted, the same logic duplicated across modules, dead or orphaned code, dependency health (unused, outdated, risky), and test-coverage gaps at the suite level. Report each finding with area (the module name or "repo"), dimension ("architecture"), file, line or "n/a", severity, the problem, and the fix.`,
    { label: 'architecture', phase: 'Review', model: 'sonnet', schema: FINDINGS_SCHEMA }
  )
)

const reviews = await parallel(reviewThunks)
const areaResults = reviews.slice(0, areas.length)
const archResult = reviews[areas.length]

// parallel() null-pads a worker that errors or is skipped. Track which workers
// actually returned so the critic knows where coverage is partial.
const reviewedAreas = areas.filter((_, i) => areaResults[i]).map((a) => a.name)
const workersFailed = areas
  .filter((_, i) => !areaResults[i])
  .map((a) => a.name)
  .concat(archResult ? [] : ['architecture'])

const raw = areaResults
  .filter(Boolean)
  .flatMap((r) => r.findings)
  .concat(archResult ? archResult.findings : [])
```

- [ ] **Step 4: Append the consolidate stage and return**

```js
phase('Consolidate')
const coverageNote =
  (workersFailed.length
    ? ` These workers did not return, so their scope is NOT covered: ${workersFailed.join(', ')}.`
    : '') +
  (scoutDropped.length
    ? ` The scout could not fit the whole repo in ${CAP} areas; these paths were not reviewed: ${scoutDropped.join(', ')}.`
    : '')

const report = await agent(
  `You are the senior reviewer consolidating a full-codebase review. The workers below produced the raw findings.${coverageNote}\n\nVerify each finding against the actual code, drop false positives and anything out of scope, merge duplicates (including the same problem found in two areas), and set a final severity. You may add a finding only if it is a clear must-fix the workers missed. Only must-fix findings block: verdict is changes-requested if any remain, approve otherwise. Record every dropped finding under dismissed with the reason.\n\nThen write the report file. Run \`date +%F\` for today's date, make the reviews/ directory if it does not exist, and write reviews/<date>-codebase-review.md: verdict and summary first, then must-fix, should-fix, and nit findings grouped by area, then a final "Coverage" section listing the areas reviewed, the paths the scout dropped, and the workers that failed. Set reportPath to the file you wrote.\n\nReturn the structured summary. Set coverage.areasReviewed to ${JSON.stringify(reviewedAreas)}, coverage.areasDropped to ${JSON.stringify(scoutDropped)}, and coverage.workersFailed to ${JSON.stringify(workersFailed)}.\n\nRaw findings (JSON):\n${JSON.stringify(raw, null, 2)}`,
  { label: 'consolidate', phase: 'Consolidate', model: 'opus', schema: REPORT_SCHEMA }
)

return report
```

- [ ] **Step 5: Re-read the whole file**

Read `.claude/workflows/review-codebase.js` start to finish. Confirm braces, parens, and template-literal backticks are balanced, the four blocks are in order, and every schema referenced (`MAP_SCHEMA`, `FINDINGS_SCHEMA`, `REPORT_SCHEMA`) is defined above its use. Do not commit yet; validation is Task 2.

## Task 2: Validate by live run, then commit

**Files:** none changed; this is the green gate.

- [ ] **Step 1: Run the workflow on this repo**

Invoke via the Workflow tool:

```
Workflow({ name: 'review-codebase' })
```

Expected:
- The progress tree shows three phases: `Scout` (1 agent), `Review` (areas + 1 agents), `Consolidate` (1 agent).
- Total agents = number of areas + 3. On this small template repo expect a handful of areas (for example `.claude/agents`, `.claude/skills`, `.claude/workflows`, `docs`), so well under the cap, and `dropped` empty.
- A file `reviews/<today>-codebase-review.md` exists, grouped by severity then area, ending with a Coverage section.
- The returned object validates against `REPORT_SCHEMA` (has `verdict`, `summary`, `reportPath`, `mustFix`, `coverage`).

- [ ] **Step 2: Confirm the report file landed**

Run: `ls reviews/ && head -40 reviews/*-codebase-review.md`
Expected: the dated report prints, with a verdict line and findings.

If no file was written, the consolidate agent lacks file tools in this runtime. Fallback: add a `markdown` string field to `REPORT_SCHEMA`, have the critic return the rendered report instead of writing it, and write the file from the returned `markdown` in the session that invoked the workflow. Re-run Step 1.

- [ ] **Step 3: Exercise the cap and coverage path**

Run: `Workflow({ name: 'review-codebase', args: { areas: 2 } })`
Expected: the scout returns 2 areas and a non-empty `dropped`; the report's Coverage section lists the dropped paths; `coverage.areasDropped` is non-empty. This proves coverage is never silently truncated.

- [ ] **Step 4: Commit the workflow**

```bash
git add .claude/workflows/review-codebase.js
git commit -m "feat: add bounded full-codebase review workflow

review-changes only sees the branch diff. review-codebase audits the whole
repo for defects and structure while staying bounded: a Sonnet scout caps
the repo at N areas, Sonnet workers review each area plus repo-wide
structure, and an Opus critic writes a dated report. Agents per run are
N + 3 regardless of repo size.

Closes #37

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Task 3: Update docs and gitignore

**Files:**
- Modify: `CLAUDE.md` (model-policy worked example; repo-layout workflow list)
- Modify: `.gitignore`

- [ ] **Step 1: Extend the model-policy worked example**

In `CLAUDE.md`, the "Model policy" section, find the Workflows bullet that ends:

```
  `.claude/workflows/` is the worked example: a fixed set of Sonnet reviewers
  plus one Opus critic, bounded by construction so it cannot fan out into the
  100-agent review that an unpinned session model produces.
```

Append one sentence to that bullet:

```
  `review-codebase` applies the same discipline to a whole-repo audit: a Sonnet
  scout caps the repo at N areas, Sonnet workers review each area plus repo-wide
  structure, and one Opus critic consolidates, so the agent count is N + 3
  regardless of repo size.
```

- [ ] **Step 2: Update the repo-layout workflow list**

In the "Repo layout" code block, change:

```
  workflows/         bounded orchestration scripts (review-changes)
```

to:

```
  workflows/         bounded orchestration scripts (review-changes, review-codebase)
```

- [ ] **Step 3: Ignore generated review output**

Append to `.gitignore`:

```
/reviews/
```

Reasoning: the report is a generated artifact, like a build output. Keeping `reviews/` untracked stops audits from being committed by accident here and in downstream repos. A user who wants to keep a specific report can `git add -f` it.

- [ ] **Step 4: Confirm sync-template needs no change**

Run: `grep -n "workflows" .claude/skills/sync-template/SKILL.md`
Expected: the machinery copy list already includes `.claude/workflows/`. No edit needed; the new workflow propagates on the next `/sync-template`.

- [ ] **Step 5: Commit the docs**

```bash
git add CLAUDE.md .gitignore
git commit -m "docs: list review-codebase in model policy and repo layout

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
gh pr create --title "feat: full-codebase review workflow (/review-codebase)" \
  --body "Adds a bounded, model-pinned /review-codebase workflow (scout + capped area workers + architecture worker + Opus critic) that audits the whole repo and writes a dated report. Verified by live runs (default and areas:2 to exercise the coverage path).

Spec: docs/superpowers/specs/2026-06-13-review-codebase-design.md
Plan: docs/plans/37-review-codebase.md

Closes #37"
```

Note: pushing and opening a PR are outward-facing. Confirm with the user before running Task 4 if they have not already authorized it.

---

## Self-review (filled in during planning)

- **Spec coverage:** Scout, area workers, architecture worker, and Opus critic are all in Task 1. The N+3 bound is asserted in Task 2 Step 1. The markdown report and coverage section are in Task 1 Step 4 and verified in Task 2 Steps 2-3. The CLAUDE.md and sync-template notes from the spec are Task 3. The `area`/`dimension` finding fields and the `coverage`/`reportPath` summary fields are in the Task 1 schemas. The "verified by live run" decision matches the spec's testing note. No spec section is left unimplemented.
- **Placeholder scan:** No TBD/TODO. Every code step shows complete code; every command shows expected output.
- **Type/name consistency:** `MAP_SCHEMA`, `FINDINGS_SCHEMA`, `REPORT_SCHEMA`, `FINDING`, `AREA` are defined once and referenced consistently. `areas`, `areaResults`, `archResult`, `reviewedAreas`, `workersFailed`, `scoutDropped`, `raw`, `repoMap`, `coverageNote` are each defined before use. The phase names (`Scout`, `Review`, `Consolidate`) match `meta.phases`.
