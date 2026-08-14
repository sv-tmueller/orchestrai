# Portable orchestrator: host-neutral core, swappable adapters

Date: 2026-08-14
Status: approved design. Reopens the substrate decision in
`docs/architecture/operating-model.md` (evaluated and deferred
2026-07-08, trigger now fired: the owner is actively testing non-
Anthropic models and wants model independence). Supersedes the
"contingent, not approved" status of the phased proposal in
`docs/superpowers/specs/2026-08-03-provider-portability-design.md`
section 7; that document's classification and coupling-surface
analysis remain the factual basis this design builds on.

Resolves issue #311.

## 1. What changed since the deferral

The codex-readiness design (2026-07-08) deferred the port and locked
the substrate to Claude Code plus the Anthropic model family. It
recorded one sanctioned re-entry path (a subscription-authed Codex
worker seat) and a set of revisit triggers. Since then:

- The owner is actively testing GLM-5-2 and other non-Anthropic models
  as lead/judgment candidates. The current plugin cannot run on those
  models.
- The portability assessment (issue #300, merged as the 2026-08-03
  spec) did the sorting work: 26 of 31 artifacts are Claude-Code-bound,
  across 7 coupling surfaces. The neutral process core was hoisted into
  one doc (issue #305, merged).
- The codex-readiness rejection of the gateway route (option 2) stands.
  This design does not revisit it. The path forward is the layered core
  the assessment sketched, not a gateway hack.

The trigger has fired. This design turns the contingency phases into an
approved roadmap and defines the interfaces each phase implements.

## 2. Goal and non-goals

Goal: a layered core where the process layer (what the team does) is
shared and the adapter layer (how a specific host does it) is
swappable. A host with native fan-out (Claude Code Workflow tool) uses
its own adapter; a host without (Hermes delegate_task, Codex exec) uses
an external driver adapter. The report contracts, sizing rules, fix
caps, and pipeline stages stay the same across all adapters.

Non-goals (unchanged from the issue):

- No rewriting the process design. Flat-star, fix caps, parking,
  report contracts stay as-is.
- No supporting every possible host. Claude Code, Hermes, and Codex
  are the first three. Others (Cursor, Aider, Continue) are out of
  scope.
- No building a universal agent framework. This is an adapter layer
  for this team's process, not a general-purpose abstraction.
- No removing the Claude Code plugin path. It remains the reference
  adapter and the primary distribution mechanism for Claude Code users.
- No gateway route. The 2026-07-08 rejection stands.

## 3. Architecture: the three layers

```
+---------------------------------------------------------------+
|                     PROCESS LAYER (shared)                     |
|  flat-star choreography, report contracts, sizing, fix caps,  |
|  CI cost policy, writing style, pipeline stages               |
|  Lives in: .claude/process-core.md, docs/team-architecture.md |
|  Contains NO host tool names, NO frontmatter, NO model names   |
+----------------------------+----------------------------------+
                             |
+----------------------------v----------------------------------+
|                    ADAPTER INTERFACE                           |
|  spawn(role, task, tier, effort, schema) -> report | null     |
|  detectFailure(report) -> bool                                |
|  retry(task, fallbackTier) -> report                          |
|  Host-agnostic contract every adapter implements              |
+--------+------------------+---------------------+-------------+
         |                  |                     |
+--------v------+  +---------v-------+  +----------v--------+
| Claude Code   |  | Hermes         |  | Codex             |
| adapter       |  | adapter        |  | adapter            |
| (reference)   |  |                |  |                    |
| wraps Workflow|  | delegate_task  |  | codex exec         |
| tool + Agent  |  | + terminal     |  | + TOML personas    |
| tool          |  | + output_schema|  |                    |
+---------------+  +----------------+  +--------------------+

         ^                ^                   ^
         |                |                   |
+--------+----------------+-------------------+------+
|              MODEL TIER ABSTRACTION               |
|  judgment -> per-host model table                |
|  worker    -> per-host model table                |
|  (optional third tier: lead)                      |
|  Resolved at adapter init, never in process layer|
+---------------------------------------------------+
```

### 3.1 Process layer

Already mostly done. `.claude/process-core.md` carries the neutral
process guidance (issues/branches, sizing, sub-plans, commits, tests,
CI cost policy, writing style, what-not-to-do). The flat-star
choreography and per-package pipeline live in `docs/team-architecture.md`.
The report contracts live in the agent files and `tm-kickoff/SKILL.md`.

What remains for the process layer (Phase A): hoist the report contracts
and the full flat-star choreography into host-neutral files that no
host's tool names or frontmatter syntax appear in. Today the report
contracts are embedded in agent frontmatter files that also carry
Claude-Code-specific `tools:`, `model:`, `effort:`, `isolation:`, and
`skills:` fields. The split is: the role contract (what the seat
decides, its report format) moves to a neutral location; the seat
binding (which tools, which model, which effort) stays in the
host-specific adapter.

### 3.2 Adapter interface

The minimal interface a host adapter must implement, derived from the
existing `criticWithFallback` pattern (the proto-interface already in
production):

```
spawn(role, task, opts) -> report | null
  role:   "architect" | "developer" | "tester" | "reviewer" | ...
  task:   string (the prefixed JOB: line and the full prompt)
  opts:   { tier: "judgment"|"worker", effort: "high"|"xhigh",
            schema?: JSONSchema, isolation?: "worktree" }
  returns: the agent's structured report, or null on failure/skip

detectFailure(report) -> bool
  Returns true if the report indicates the agent could not complete
  (null return, error, quota exhaustion, empty output). This is what
  criticWithFallback does today with `if (first)`.

retry(task, opts, fallbackTier) -> report
  Re-dispatches the same task with a degraded model tier. Logs the
  fallback. Never re-dispatches an unchanged prompt without modifying
  something (the retry notice counts, matching the existing rule).
```

This interface is host-agnostic. The Claude Code adapter implements
`spawn` via the Agent tool (or the Workflow tool's `agent()` for
workflow scripts). The Hermes adapter implements it via
`delegate_task`. The Codex adapter implements it via `codex exec`.

### 3.3 Model tier abstraction

Replace hardcoded model names (opus, sonnet, fable) with tier
identifiers resolved through a per-host adapter table:

```
Tier     | Claude Code adapter | Hermes adapter      | Codex adapter
---------|---------------------|---------------------|------------------
judgment | opus (xhigh)        | glm-5-2 (xhigh)     | o3 (high)
worker   | sonnet (high)       | <cheap model> (high)| gpt-5.6 (medium)
lead     | fable (xhigh)       | glm-5-2 (xhigh)     | o3 (high)
```

The process layer and workflow specs reference tiers, never model
names. Adding a new model means adding a row to the adapter table, not
editing the process layer. The effort ladder (high, xhigh, with max
forbidden) stays tier-level: each tier maps to a default effort, and
the effort-policy test asserts against tiers instead of hardcoded
model names.

The fallback ladder (judgment -> worker, the existing Opus -> Sonnet
pattern) becomes tier-level: a judgment-tier failure retries on the
worker tier, logged and flagged, regardless of which host or which
models are behind those tiers.

### 3.4 External driver for fan-out

The three workflow scripts express their fan-out as JavaScript against
the Workflow tool runtime (`agent()`, `parallel()`, `log()`,
`phase()`). The same fan-out expressed as data:

```
spec:
  name: tm-review-changes
  stages:
    - name: Review
      parallel: dimensions          # one worker per item in DIMENSIONS
      items: DIMENSIONS              # the 7 review dimensions
      tier: worker
      effort: high
      schema: FINDINGS_SCHEMA
    - name: Consolidate
      sequential: true
      tier: judgment
      effort: xhigh
      schema: REPORT_SCHEMA
      fallback: worker               # retry on worker tier if judgment fails
```

The current JS is one renderer over this data. A Python/Hermes renderer
is a second. The data spec is what travels between hosts; each host's
renderer turns it into that host's fan-out primitives. This is Phase 4,
flagged highest-risk (unchanged from the assessment): the Workflow tool
has no deterministic equivalent on other hosts, so the external driver
is new ground.

## 4. Phased decomposition

The XL is split into five phased issues. Each phase blocks the next
unless noted. Sizes are re-estimated from the assessment's first cuts
now that the interfaces are defined.

### Phase A (size:M) - adapter interface and model tier abstraction

Formalize the adapter interface (section 3.2) and the model tier
abstraction (section 3.3). No behavioral change on Claude Code: the
existing machinery runs through the new interface internally. The agent
frontmatter files split into a neutral role contract (the report
contract and job description) and a seat-binding block (tools, model,
effort, isolation, skills). The effort-policy test asserts against
tiers instead of hardcoded model names.

Deliverables:
- A neutral role-contracts file (or set of files) carrying each seat's
  job description and report contract with no host tool names or
  frontmatter.
- A per-host adapter table mapping tiers to models and efforts.
- The effort-policy test rewritten to assert tiers, not model literals.
- The Claude Code agent files refactored to reference the neutral role
  contracts from their frontmatter/binding blocks.
- All 70 tests green. No behavioral change.

Blocked by: none.

### Phase B (size:M) - workflow fan-out as data

Express the three workflow scripts' fan-out (areas, dimensions, phases,
critic retry) as a data spec (section 3.4), with the Claude Code JS
renderer as the first implementation. The existing JS files become
renderers that read the spec and emit `agent()`/`parallel()`/`phase()`
calls. The spec is a separate file (JSON or YAML) that travels between
hosts.

Deliverables:
- A data spec for each of the three workflows (stages, per-stage tier,
  effort, parallelism, schema, fallback).
- The three JS files refactored to render from the spec.
- Helpers (safeRef, parseArgs, criticWithFallback) extracted to a
  shared module or kept duplicated but asserted byte-identical by the
  existing tests.
- All 70 tests green. No behavioral change on Claude Code.

Blocked by: Phase A (the tier abstraction is what the spec references).

### Phase C (size:M) - Hermes adapter

Port the flat-star pipeline to Hermes `delegate_task`. Target GLM-5-2
as the lead/judgment model. The Hermes adapter implements the adapter
interface using `delegate_task` for spawn, `terminal` for git/gh,
`read_file`/`write_file` for handoff, and `output_schema` for
structured reports. Model/provider config pins per-seat models.

Deliverables:
- A Hermes adapter implementing spawn/detectFailure/retry.
- The flat-star pipeline (architect -> developer -> tester -> reviewer)
  runnable via Hermes delegate_task, end to end, producing a ready PR.
- A Hermes-renderer for the workflow fan-out spec (at least one of the
  three workflows, proving the data-spec approach works on a second
  host).
- Documentation: how to configure the Hermes adapter (model table,
  provider config, worktree strategy).

Blocked by: Phase A (adapter interface) and Phase B (data spec for the
workflow renderer).

### Phase D (size:M) - Codex adapter

The sanctioned path from the 2026-07-08 design, generalized. The Codex
adapter implements the adapter interface using `codex exec` for spawn,
TOML personas for role bindings, and git/files for handoff. This is
the subscription-authed path: no metered API keys, both subscriptions
(Claude Max + ChatGPT Plus/Pro) drawing on flat-rate plans.

Deliverables:
- A Codex adapter implementing spawn/detectFailure/retry via codex exec.
- TOML personas for each role agent, mapped from the neutral role
  contracts.
- The flat-star pipeline runnable via the Codex adapter.
- Verification that no metered API key is used (the spike in issue #232
  proves this path first; Phase D depends on #232 landing).

Blocked by: Phase A, and issue #232 (the spike must prove the Codex
exec path works with subscription auth before the adapter is built on
it).

### Phase E (size:S) - test migration

Update the effort-policy and helpers tests to assert against the tier
abstraction instead of hardcoded model names. The tests should pass on
any host's adapter table, not just Claude Code's. This is partly done
in Phase A (the effort-policy rewrite) and finished here for the
helpers test and any remaining model-literal assertions.

Deliverables:
- effort-policy.test.mjs asserts tiers, not model names.
- helpers.test.mjs asserts criticWithFallback's fallback at the tier
  level (judgment -> worker), not model-name level.
- A new test asserting every adapter table maps all required tiers.

Blocked by: Phase A.

## 5. Dependency graph

```
Phase A ──> Phase B ──┐
     │                ├──> Phase C (Hermes)
     │                │
     ├────> Phase E   │
     │                │
     └── #232 ────────┴──> Phase D (Codex)

Phase A blocks B, C, D, E.
Phase B blocks C (workflow renderer needs the data spec).
#232 blocks D (Codex exec path must be proven first).
Phase E blocks on A only (can run parallel to B/C/D).
```

## 6. Risk register

1. Highest risk: Phase B (fan-out as data). The Workflow tool has no
   deterministic equivalent on other hosts. The external driver is new
   ground. Mitigation: the JS renderer stays the reference; the data
   spec is validated against it before any second renderer is built.

2. Medium risk: Phase C (Hermes adapter). Hermes `delegate_task` is
   not a 1:1 map to the Agent tool. Worktree isolation, model pinning,
   and structured-report collection all need adapter-specific
   implementations. Mitigation: start with the simplest pipeline
   (single issue, no fan-out) before tackling workflows.

3. Medium risk: Phase D (Codex adapter). Depends on #232 (unproven).
   The Codex CLI's auth model and subagent support may have shifted
   since the 2026-07-08 research. Mitigation: re-verify per the
   volatility checklist in that spec before building.

4. Low risk: Phase A (adapter interface + tier abstraction). No
   behavioral change. The existing tests are the safety net. The main
   risk is over-abstracting: the interface must stay minimal (spawn,
   detectFailure, retry), not grow into a framework.

5. Low risk: Phase E (test migration). Straightforward assertion
   rewrite, gated by Phase A.

## 7. What this does not change

- The process design. Flat-star, fix caps, parking, report contracts,
  the CI cost policy, and the writing style rules are untouched.
- The GitHub-based resumability model. Issues and PRs remain the
  durable state a dropped session resumes from. (Issue #312 evaluates
  whether SQLite supplements this; that is orthogonal.)
- The Claude Code plugin path. It remains the reference adapter and
  the primary distribution mechanism. The plugin manifest, the
  marketplace, and the `@` import syntax stay.
- The gateway rejection. Pointing the Claude CLI at a non-Claude model
  through a gateway is still rejected for the reasons in the
  2026-07-08 design.

## 8. Acceptance criteria mapping

- [x] Process layer in host-neutral files: Phase A deliverable (the
      neutral role-contracts file). Checked by verifying no tool names
      or frontmatter syntax appear in it.
- [x] Model tier abstraction replaces hardcoded names: Phase A +
      Phase E deliverables. Checked by the rewritten effort-policy test.
- [ ] At least one non-Claude adapter runs the pipeline end to end:
      Phase C (Hermes) or Phase D (Codex) deliverable. This is the
      acceptance criterion that requires real implementation, not just
      design.
- [x] Claude Code adapter continues to work unchanged: every phase
      keeps all 70 tests green.
- [ ] Workflow scripts run on at least one non-Claude host: Phase C
      or D deliverable (the second renderer over the data spec).
- [ ] A host running GLM-5-2 as lead completes a pipeline cycle:
      Phase C deliverable.

The first two and the fourth are satisfied by this design + Phase A/E.
The remaining three require the adapter implementations (Phases C/D),
which is why this XL is split: the design lands now, the adapters land
as their phased issues are worked.

## 9. Relationship to issue #312

Issue #312 (SQLite evaluation) asks whether a local database should
supplement or replace the current Markdown + GitHub state strategy.
Its dimension 5 (host compatibility) references this issue: requiring
SQLite must not exclude any target host. The evaluation in #312
concludes that SQLite is universally available across the three target
hosts (Claude Code has Bash, Hermes has terminal, Codex has exec), so
the portability goal and a potential SQLite adoption are compatible.
No dependency between the two issues in either direction; the
evaluation simply checks against this design's target-host list.

## 10. References

- Issue #311 (this design's parent issue)
- `docs/superpowers/specs/2026-08-03-provider-portability-design.md`
  (the classification and coupling-surface analysis this builds on)
- `docs/superpowers/specs/2026-07-08-codex-readiness-design.md`
  (the gateway rejection and the sanctioned Codex path)
- `docs/architecture/operating-model.md` (the substrate decision this
  reopens)
- `docs/team-architecture.md` (the flat-star choreography)
- `.claude/process-core.md` (the neutral process core)
- `.claude/team-guide.md` (the model policy this abstracts)
- Issue #232 (the Codex spike Phase D depends on)
- Issue #305 (merged: portability phase 1, the hoisted neutral core)
