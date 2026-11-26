# Adapter interface

The minimal interface a host adapter must implement. It began as the
`criticWithFallback` pattern in the removed workflow scripts.

Status: the Hermes adapter is implemented as of Phase C (#315), rebuilt
on subprocess spawn in #351, and the Codex adapter as of Phase D (#316).
The Codex adapter has never been live-tested. The three operations
(spawn, detectFailure, retry) are defined here as prose. The Hermes adapter lives at
`.claude/adapters/hermes-adapter.mjs` and spawns a `hermes` subprocess
per seat. It previously used `delegate_task`, which takes no model
override, no working directory, and no output schema, so none of the
tier bindings actually reached the seat (#351). The Codex adapter lives at `.claude/adapters/codex-adapter.mjs`
and uses `codex exec` for spawn.

The report parser is shared, not per adapter: `role-contract-parser.mjs`
holds `parseReport` and `hasProviderError`, because the markers
(`STATUS:`, `VERDICT:`, the architect opener) are host-neutral per
`role-contracts.md`. Both host adapters import it; a second copy would
drift from the contract silently.

See `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
section 3.2 for the design rationale.

## Interface

Three operations. Every host adapter implements them.

### spawn(role, task, opts) -> report | null

Dispatch a role agent with a pinned tier and effort. Returns the
agent's structured report, or null on failure/skip.

Parameters:
- `role`: `"architect" | "developer" | "reviewer" |
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
- Claude Code, in-process (the default): the Agent tool. The `model` and
  `effort` opts map to the Agent tool's `model` and `effort` params. This is `claude-code.json`, whose `dispatch` is
  absent; all seats share the lead's process and directory.
- Claude Code, subprocess (`dispatch: "subprocess"`, issue #453): one
  headless `claude -p` process per seat, so each seat gets its own model,
  endpoint, effort pin, and working directory. Lives at
  `.claude/adapters/claude-code-subprocess.mjs`; the variant tables
  `claude-code-vllm.json` and `claude-code-split.json` select it, and
  `CLAUDE_CODE_ADAPTER_TABLE` picks the table for the run. The seat runs
  with `--model`, `--effort`, `--permission-mode auto`, and
  `--output-format json`; its working directory is the lead-owned package
  worktree, passed as the `cwd` option of node's `spawn` (there is no flag
  for it). The adapter starts the seat with `spawn`, not `execFile`
  (#467), so it can close the seat's stdin: stdin is `/dev/null` and
  stdout and stderr are pipes. Every
  orchestrai plugin key is disabled in `--settings`, because a second
  account-synced copy otherwise loads silently. Two environment escapes
  are set per seat: `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` (a custom model
  ID is not recognized as effort-capable, so `--effort` is dropped
  without it) and `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (a phantom
  background child otherwise hangs a finished-looking run). The report,
  the token counts, and the cost line are read from the JSON envelope on
  stdout; a self-hosted model's usage is recorded unpriced.
- Hermes: a `hermes -z` subprocess per seat, with `-m`/`--provider` for
  the model, `--reasoning` for the effort, and `-t` for the tool surface.
  Hermes v0.20.0 has no `--in` flag: the working directory is execFile's
  `cwd`. The report is parsed from stdout; Hermes documents no
  structured-output parameter.
- Codex: `codex exec` with a TOML persona selecting the model. Report
  collected from stdout or a written file.

### detectFailure(report) -> bool

Return true if the report indicates the agent could not complete: a
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
2. Flag the fallback in the report (a `modelFallback` marker).
3. Preserve the original task's schema and effort.
4. Append a retry notice to the prompt explaining the fallback.

Retry variants. The tier ladder above is the Hermes adapter's shape. A
Claude Code subprocess seat has no cheap degenerate tier to fall to (the
split table's worker tier is a self-hosted model, not a lesser copy of a
judgment model), so its retry is respawn-once-then-park instead: one
respawn on the same binding, and a second failure returns null so the
stage's fix-cap rules park the package. The respawn prompt names the
failure and tells the seat to check what the dead attempt left on origin
before redoing work, which is what satisfies the no-unchanged-prompt
rule. This variant supersedes the tier ladder for the subprocess spawn
mode only; the in-process agent path keeps the ladder.

## Adapter table

Each host has an adapter table mapping tiers to concrete models and
efforts. The Claude Code table lives at
`.claude/adapters/claude-code.json`. The table also carries the
role-to-tier assignment, so adding a new role means adding a row to
the `roles` map, not editing the process layer.

A role value is either a tier string (the common case) or an object
naming a tier plus per-role overrides of `model`, `effort`, and
`settings`. The override wins over the tier default, so a project can
put one role on a stronger model without adding a tier. Both shapes are
valid; the adapter-table test accepts either. The `dispatch` field
selects the spawn mode (`"agent"` when absent, `"subprocess"` for the
per-seat process mode described above).

The effort policy is per tier. `effort_ceiling` and `forbidden_efforts`
state the table-level baseline, and each tier is resolved from its own
`provider`: a paid-API tier keeps the baseline, a self-hosted one (the
`vllm` provider) is exempt and may run at `max`. A mixed table therefore
carries the paid baseline at the top level while its self-hosted tier
lifts the ceiling. The effort-policy test holds the exemption authority
(its `SELF_HOSTED_HOSTS` and `SELF_HOSTED_PROVIDERS` sets); the runtime
guard in the subprocess adapter mirrors it.

Adding a new model means editing the host's tier map in the adapter
table.

A target repo's `.orchestrai/columns.json`, when present, overrides the
per-stage model and effort at lead dispatch time (and names the runner that
executes the stage); the adapter table stays the resolution source for every
repo without that file.

## What the interface does not specify

- How the host isolates work (worktrees, branches, containers). That
  is the adapter's implementation detail. The interface only declares
  `isolation: "worktree"` as a hint; the adapter decides the mechanism.
- How the host collects the report (inline return, file, stdout). The
  interface specifies the return shape; the transport is the adapter's
  concern.
- How the host authenticates to its model provider. Subscription auth,
  API keys, or local inference are all transparent to the interface.
