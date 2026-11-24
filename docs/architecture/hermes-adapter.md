# Hermes adapter

The Hermes adapter implements the adapter interface (spawn, detectFailure,
retry) for the Hermes Agent host. It lets the orchestrator team run on
Hermes with GLM-5-3 and deepseek-v41-flash (or any configured model)
instead of Claude Code.

See `docs/architecture/adapter-interface.md` for the interface contract
and `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
section 4 Phase C for the design.

## Components

- `.claude/adapters/hermes.json` -- the default adapter table mapping tiers
  to models and efforts for the Hermes host.
- `.claude/adapters/hermes-openrouter.json` -- the OpenRouter variant table
  (see "OpenRouter variant (Kimi K3.1 Pro)").
- `.claude/adapters/hermes-adapter.mjs` -- the adapter module exporting
  `spawn`, `detectFailure`, `retry`, `resolveTier`, and `resolveRole`.
- `.claude/adapters/hermes-pipeline.mjs` -- the pipeline driver: a command
  line (see "Driver command line"), the gate, and the per-package stage
  loop that runs architect, developer, tester, reviewer and ship.
- `.claude/adapters/hermes-renderer.mjs` -- the workflow renderer that
  reads JSON spec files from `.claude/workflows/specs/` and drives the
  adapter's spawn/parallel operations.
- `.claude/workflows/__tests__/hermes-adapter.test.mjs` -- tests for the
  adapter table, interface, and renderer (dry-run mode).
- `.claude/skills/tm-kickoff/SKILL.hermes.md` -- the Hermes variant of the
  pipeline-driver skill. Source for the auto-discovered
  `~/.hermes/skills/autonomous-ai-agents/orchestrai/` skill.
- `.claude/skills/tm-advisor/SKILL.hermes.md` -- the Hermes variant of the
  batch-advisor skill (#346). Source for the auto-discovered
  `~/.hermes/skills/autonomous-ai-agents/tm-advisor/` skill. Loads the
  pipeline via `skill_view(name='orchestrai')` at dispatch time.

## Configuration

### Adapter table

The adapter table at `.claude/adapters/hermes.json` maps the three tiers
(judgment, worker, lead) to concrete models and efforts. The current
configuration targets GLM-5-3 for judgment and lead, and
deepseek-v41-flash for the worker tier:

```json
{
  "tiers": {
    "judgment": { "model": "vllm/release/glm-5-3", "effort": "max" },
    "worker": { "model": "vllm/release/deepseek-v41-flash", "effort": "max" },
    "lead": { "model": "vllm/release/glm-5-3", "effort": "max" }
  }
}
```

All tiers run at `max` effort. The self-hosted vLLM models carry no
token-cost ceiling, so this table lifts the paid-API effort policy
(`effort_ceiling: xhigh`, `forbidden_efforts: ["max"]`) that the
Claude Code and Codex adapter tables keep.

Because Hermes `delegate_task` has a single global model pin
(`delegation.model` in `~/.hermes/config.yaml`), the tier split is realized
mechanically at dispatch time, not by the adapter module: `delegation.model`
pins all delegate_task children to the worker model, and judgment roles
(architect, reviewer) are dispatched as one-shot Hermes subprocess seats
(`hermes chat -q -m <judgment-model> --reasoning max "<prompt>"`)
instead of delegate_task children. The adapter table records the intended
mapping; the pipeline driver (tm-kickoff / tm-advisor) realizes it.

To use a cheaper model for the worker tier, edit the `worker` entry:

```json
"worker": { "model": "<cheaper-model-id>", "effort": "high" }
```

The role-to-tier mapping is identical to the Claude Code adapter table.
Changing which tier a role uses (e.g. moving reviewer from judgment to
worker) means editing the `roles` map in both adapter tables.

### OpenRouter variant (Kimi K3.1 Pro)

A second table, `.claude/adapters/hermes-openrouter.json`, routes all three
tiers to Kimi K3.1 Pro through OpenRouter. It sits next to the self-hosted
table and does not replace it. `hermes.json` stays the default.

| Tier | Model | Provider | Effort | Fallback |
|------|-------|----------|--------|----------|
| judgment | moonshotai/kimi-k3.1-pro | openrouter | xhigh | moonshotai/kimi-k3 |
| worker | moonshotai/kimi-k3.1-pro | openrouter | xhigh | moonshotai/kimi-k3 |
| lead | moonshotai/kimi-k3.1-pro | openrouter | xhigh | moonshotai/kimi-k3 |

Selection. Set `HERMES_ADAPTER_TABLE` to a file name under the adapters
directory before the run. It defaults to `hermes.json`.

```bash
export HERMES_ADAPTER_TABLE=hermes-openrouter.json
```

The lead session is not spawned by the adapter, so select its model yourself:
`hermes ... -m moonshotai/kimi-k3.1-pro --provider openrouter --reasoning xhigh`.
Without `--reasoning` the lead uses `agent.reasoning_effort`, which can be
`max`. Seats spawned
by the adapter take model, provider, and effort from the table.

`HERMES_ADAPTER_TABLE` is read only by the adapter module. It selects the
variant for the programmatic driver (`hermes-pipeline.mjs`) and anything else
that spawns seats through `hermes-adapter.mjs`. The skill-driven
`delegate_task` path ignores it: there, workers follow `delegation.model` and
the provider in `~/.hermes/config.yaml`, and judgment seats use the command
hardcoded in `SKILL.hermes.md`. To run that path on Kimi, set
`delegation.model` to `moonshotai/kimi-k3.1-pro` with provider `openrouter`
and `delegation.reasoning_effort` to `xhigh` (children otherwise inherit the
parent's level, which can be `max`), and dispatch judgment seats with
`-m moonshotai/kimi-k3.1-pro --provider openrouter --reasoning xhigh`.

Effort policy. OpenRouter is a paid provider, so the paid-API policy applies,
unlike the self-hosted default table: `effort_ceiling` is `xhigh` and
`forbidden_efforts` is `["max", "ultra"]`. A seat on this table never runs at
`max`, provided the lead and the skill-path workers are set to `xhigh` as above.

Cost profile (OpenRouter listing, 2026-10-24, USD per 1M tokens, 1M context
for both models):

| Model | Input | Output | Cache read |
|-------|-------|--------|------------|
| moonshotai/kimi-k3.1-pro | 2 | 10 | 0.20 |
| moonshotai/kimi-k3 | 0.239 | 10.8 | 0.21 |

Not for customer repos. The model is not available through OpenRouter EU
in-region routing, so customer code must not go through this table.

The Claude Code host can also run against Kimi, with no table change. That
path is described once, in the README: "Other providers via a profile" under
Zone 1 "Model config".

### Model and provider config

The Hermes config (`~/.hermes/config.yaml`) pins the model and provider.
The adapter table references the model ID that Hermes resolves. For
example, with GLM-5-2 served via a custom provider:

```yaml
model:
  default: vllm/release/glm-5-2
  provider: custom
  base_url: https://your-provider.example.com/v1
  api_key: ${HERMES_CUSTOM_API_KEY}
```

The adapter does not authenticate to the model provider itself; that is
handled by the Hermes runtime config. The adapter table only declares
which model ID each tier uses.

### Isolation strategy

Hermes does not have a native worktree concept. The adapter relies on git
branch isolation: each role agent works on a branch, and handoff happens
through files in the repo. The `isolation: "worktree"` hint from the
interface is interpreted as "create a branch" on Hermes, not a git
worktree. For parallel stages, each delegated task works on the same
branch (read-only) and the results are merged by the consolidate stage.

## Dry-run mode

Set `DRY_RUN=true` to exercise the adapter and renderer without live API
calls. In dry-run mode, `spawn` returns synthetic reports shaped to
satisfy the schema, so the full fan-out (scout, parallel workers, critic
with fallback) can be tested offline.

```bash
DRY_RUN=true npm test
```

The test suite makes no live calls: it runs in dry-run mode, against stubs,
or against saved fixtures. Live runs require a Hermes session with the model
provider configured.

## Live mode

In live mode `spawn` runs one `hermes` subprocess per seat:

```
hermes -z "<role prompt + task>" -m <model> --provider <p> \
  --reasoning <effort> -t <toolsets> --in <worktree> --yolo --accept-hooks
```

`-z` prints only the final response, so the report is parsed from stdout
by `parseReport`, keyed by role against the contracts in
`docs/architecture/role-contracts.md`. Hermes documents no
structured-output parameter, so there is no schema to pass.

This runs as ordinary Node: `hermes` is a CLI reached through
`child_process`, with no host-injected globals. A Hermes lead session is
therefore not required. `node hermes-pipeline.mjs` plus `hermes -z`
workers is the whole team, and the Hermes skill is one way to launch it
rather than the only way.

Set `HERMES_BIN` to point at a different binary; tests use it so CI never
shells out to a real install.

The adapter never passes `-w`. Hermes' worktree mode registers an
`atexit` cleanup that force-removes the worktree and deletes its branch
unless there are unpushed commits, and it names branches from a UUID
rather than `<type>/<issue>-<slug>`. The driver creates one worktree per
package instead (`worktreePlan` and `ensureWorktree` in
`hermes-pipeline.mjs`) and passes it as `--in`.

`-t` restricts the tool surface but cannot express read-only: every seat
needs `terminal` for git, gh, and the check suite, and terminal implies
write capability. Read-only stays a prompt-level contract on this host.
What `-t` does enforce is flat-star: no seat gets the `delegation`
toolset, so no seat can re-delegate.

## Driver command line

```
node .claude/adapters/hermes-pipeline.mjs <arg>...
```

Each argument is an issue number or `label:<name>`. A label selects the open
issues carrying it (the first 100). Numbers and labels mix, and the package
list is all of them in argument order with duplicates dropped. The driver
works on the repo in the current directory, since `gh` and `git` find the
repo from there. It never merges.

The gate reads each issue and decides one outcome per package: `run`,
`resume`, `wait`, `complete`, `park`, `stop` or `skip`. The first matching
rule wins: closed, `needs-human`, `size:L` or `size:XL`, no size label,
a ready PR, a draft PR, `in-progress` with no PR, and then a plain run. A run
starts at the developer when the issue has a sub-plan comment (a comment with
a line that is exactly `SUB_PLAN`), and at the architect when it has none. An
unmerged `Blocked by: #N` blocker turns a run or resume into a wait. Only
wave 1 runs, because a later wave's blocker cannot be merged during the run.

An `in-progress` issue with no PR resumes at the developer when a branch named
`<type>/<n>-...` is on origin, on that branch. The developer is told the
branch has no PR, to finish the work and to open the draft PR. Without such a
branch the package runs from the developer. The tester's and reviewer's
reports belong on a PR, so a package with no PR is never resumed past the
developer.

In a live run, a seat that returns nothing, or a report without the field its
stage reads (the architect's text, the developer's PR, the tester's or
reviewer's verdict), stops the package: the result line reads
`parked: <role> seat returned no usable report` and nothing more is written
for it. `runPipeline` with `dryRun` uses placeholders in place of seat
output instead, so the dry-run tests complete.

stdout carries the gate lines, the wave plan and one result line per package.
A package that throws (a failed `git fetch`, `git worktree add` or `gh` write)
does not stop the others: its line reads `#<n> error: <first line of the
message>`, and every other package still runs and reports. Progress, dry-run
notes and errors go to stderr.

`DRY_RUN=true` is the confirmation step. The driver still reads GitHub, but
it creates no label, posts no comment, makes no worktree and starts no seat.
Each skipped write is named on stderr. A run without `DRY_RUN` is the
confirmed run and asks no questions.

Exit codes: 0 when the run finished (parked, stopped, waiting and skipped
packages are outcomes, not failures), 1 when a `gh` or `git` call failed at
the gate, when any package ended with an `error` line, or when something
unexpected happened (a mistyped issue number ends here), and 2 for a usage
error, before any GitHub call.

## Workflow rendering

The renderer (`hermes-renderer.mjs`) reads the same JSON spec files that
the Claude Code JS renderer consumes (via its embedded SPEC constant).
This proves the data-spec approach works on a second host: the spec is
the single source of truth, and each host provides its own renderer.

The renderer handles all three parallelism modes (single, fixed-list,
dynamic-list) and the fallback ladder for stages that declare one. The
prompt templates are minimal in the current implementation; a full
production renderer would interpolate the complete prompt from the
workflow's JS source or a shared prompt template library.
