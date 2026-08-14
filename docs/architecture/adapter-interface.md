# Adapter interface

The minimal interface a host adapter must implement. Derived from the
existing `criticWithFallback` pattern in the workflow scripts, which is
the proto-interface already in production.

Status: specification-only as of Phase A (#313). The three operations
(spawn, detectFailure, retry) are defined here as prose; the existing
`criticWithFallback` function in the workflow scripts is the
proto-implementation that will be extracted into this interface in
Phase C (Hermes adapter, #315) and Phase D (Codex adapter, #316).
Until then, the workflow scripts call `agent()` directly and inline
their own fallback logic.

See `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
section 3.2 for the design rationale.

## Interface

Three operations. Every host adapter implements them.

### spawn(role, task, opts) -> report | null

Dispatch a role agent with a pinned tier and effort. Returns the
agent's structured report, or null on failure/skip.

Parameters:
- `role`: `"architect" | "developer" | "tester" | "reviewer" |
  "fact-checker" | "docs-writer" | "perf-investigator"`
- `task`: string. The full prompt, including the prefixed `JOB:` line
  for roles that use job types (architect).
- `opts`: object with:
  - `tier`: `"judgment" | "worker"` (resolved to a model+effort pair
    via the adapter table)
  - `effort`: `"high" | "xhigh"` (the tier's default, or an override)
  - `schema`: optional JSON Schema for structured report collection
  - `isolation`: optional, `"worktree"` when the role needs branch
    isolation

Returns: the agent's report object matching the schema, or null when
the agent errors out, returns nothing, or is skipped mid-run.

Host implementations:
- Claude Code: the Agent tool (for pipeline dispatch) or the Workflow
  tool's `agent()` function (for workflow scripts). The `model` and
  `effort` opts map to the Agent tool's `model` and `effort` params.
- Hermes: `delegate_task` with `output_schema` for structured reports.
  Model and effort set via the Hermes model/provider config.
- Codex: `codex exec` with a TOML persona selecting the model. Report
  collected from stdout or a written file.

### detectFailure(report) -> bool

Return true if the report indicates the agent could not complete. This
generalizes what `criticWithFallback` does today with `if (first)`: a
null return, an empty output, an error sentinel, or a quota-exhaustion
signal all count as failure.

The detection is host-specific because failure manifests differently
per host: Claude Code returns null, Hermes returns an error in the
delegated task result, Codex returns a nonzero exit code or empty
stdout. The adapter translates its host's failure signal into a boolean.

### retry(task, opts, fallbackTier) -> report

Re-dispatch the same task with a degraded model tier. Log the fallback.
Never re-dispatch an unchanged prompt without modifying something: the
retry notice appended to the prompt counts, matching the existing
rule in `tm-kickoff/SKILL.md` ("Never re-dispatch an unchanged prompt;
something in the task must change first").

The fallback ladder is tier-level, not model-level: a judgment-tier
failure retries on the worker tier, regardless of which models are
behind those tiers. This generalizes the existing Opus-to-Sonnet
fallback.

The retry must:
1. Log that a fallback occurred (visible in the run output).
2. Flag the fallback in the report (a `modelFallback` marker, as
   `criticWithFallback` does today).
3. Preserve the original task's schema and effort.
4. Append a retry notice to the prompt explaining the fallback.

## Adapter table

Each host has an adapter table mapping tiers to concrete models and
efforts. The Claude Code table lives at
`.claude/adapters/claude-code.json`. The table also carries the
role-to-tier assignment, so adding a new role means adding a row to
the `roles` map, not editing the process layer.

Adding a new model means editing the host's tier map in the adapter
table. On this branch the workflow scripts still pin literal model
names in their agent() calls; the effort-policy test resolves each
pinned model through the adapter table to verify it matches the
declared tier. A future phase (Phase B, issue #314) introduces
inline TIER_MODELS/TIER_EFFORTS maps in the workflow scripts so the
scripts reference tiers, not model names, at the callsite.

## Spec format

Each workflow's fan-out is encoded as a JSON spec file under
`.claude/workflows/specs/`. The Claude Code JS renderer embeds a
matching `SPEC` constant; a future Hermes or Codex renderer reads the
JSON directly. The spec-sync test asserts the two stay in sync.

Top-level fields:

- `name`: the workflow identifier (matches the JS filename stem).
- `description`: one paragraph, no tool names or model names.
- `phases`: array of `{ title, detail, tier }`. Ordered list of phases
  the workflow progresses through. `tier` is the model tier for that
  phase.
- `stages`: object mapping stage names to stage descriptors. Each
  stage descriptor has:
  - `phase`: which phase this stage belongs to.
  - `tier`: `"judgment"` or `"worker"` (never `"lead"`).
  - `parallelism`: `"single"` (one agent), `"fixed-list"` (N agents,
    N known at spec-write time), or `"dynamic-list"` (N agents, N
    determined at runtime by the previous stage's output).
  - `schema`: the name of the JSON Schema constant the stage uses.
  - `fallback`: `null`, or `{ from_tier, to_tier, preserve_effort }`
    describing the retry behavior on failure.
  - `label`: for `single` stages, the literal label string used in
    agent() calls. Used by the render-path test to map recorded
    calls back to their SPEC stage.
  - `item_label_prefix`: for `fixed-list` and `dynamic-list` stages,
    the prefix concatenated with each item to form the agent() label.
  - `item_label`: for `single` stages that use a descriptive label
    rather than a literal (e.g. `architecture`).
  - `items_source`: for `dynamic-list` stages, the path in the
    previous stage's output that yields the item list (e.g.
    `scout_result.areas`).
  - `items_key`: for `fixed-list` stages, the name of the data array
    in the SPEC that enumerates the items.
  - `items_cap`: for `dynamic-list` stages, the name of the args
    field that caps the item count (e.g. `args.areas`).
  - `items_default_cap`: for `dynamic-list` stages, the default cap
    when the args field is absent (e.g. `24`).

Stages do not carry `effort` or `model`; those are resolved from the
tier via the adapter table at render time.

The JSON spec files carry only `name`, `description`, `phases`, and
`stages`. Data arrays (dimensions, area lists), schema objects, and
default args stay inlined in the JS because the runtime has no
imports; the specs.test.mjs sync test compares only the four
synced fields.

## What the interface does not specify

- How the host isolates work (worktrees, branches, containers). That
  is the adapter's implementation detail. The interface only declares
  `isolation: "worktree"` as a hint; the adapter decides the mechanism.
- How the host collects the report (inline return, file, stdout). The
  interface specifies the return shape; the transport is the adapter's
  concern.
- How the host authenticates to its model provider. Subscription auth,
  API keys, or local inference are all transparent to the interface.
