# Hermes adapter

The Hermes adapter implements the adapter interface (spawn, detectFailure,
retry) for the Hermes Agent host. It lets the orchestrator team run on
Hermes with GLM-5-2 (or any configured model) instead of Claude Code.

See `docs/architecture/adapter-interface.md` for the interface contract
and `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
section 4 Phase C for the design.

## Components

- `.claude/adapters/hermes.json` -- the adapter table mapping tiers to
  models and efforts for the Hermes host.
- `.claude/adapters/hermes-adapter.mjs` -- the adapter module exporting
  `spawn`, `detectFailure`, `retry`, `resolveTier`, and `resolveRole`.
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
(judgment, worker, lead) to concrete models and efforts. The default
configuration targets GLM-5-2 for all tiers:

```json
{
  "tiers": {
    "judgment": { "model": "vllm/release/glm-5-2", "effort": "xhigh" },
    "worker": { "model": "vllm/release/glm-5-2", "effort": "high" },
    "lead": { "model": "vllm/release/glm-5-2", "effort": "xhigh" }
  }
}
```

To use a cheaper model for the worker tier, edit the `worker` entry:

```json
"worker": { "model": "<cheaper-model-id>", "effort": "high" }
```

The role-to-tier mapping is identical to the Claude Code adapter table.
Changing which tier a role uses (e.g. moving reviewer from judgment to
worker) means editing the `roles` map in both adapter tables.

### Model and provider config

The Hermes config (`~/.hermes/config.yaml`) pins the model and provider.
The adapter table references the model ID that Hermes resolves. For
example, with GLM-5-2 served via a custom provider:

```yaml
model:
  default: vllm/release/glm-5-2
  provider: custom
  base_url: https://ai.noris.de/v1
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

The test suite always runs in dry-run mode; live runs require a Hermes
session with the model provider configured.

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
