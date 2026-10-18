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
(judgment, worker, lead) to concrete models and efforts. The current
configuration targets GLM-5-3 for judgment and lead, and
deepseek-v41-flash for the worker tier:

```json
{
  "tiers": {
    "judgment": { "model": "vllm/qsu/glm-5-3", "effort": "max" },
    "worker": { "model": "vllm/qsu/deepseek-v41-flash", "effort": "max" },
    "lead": { "model": "vllm/qsu/glm-5-3", "effort": "max" }
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

The test suite always runs in dry-run mode; live runs require a Hermes
session with the model provider configured.

## Live mode

In a live Hermes session, `spawn` delegates to `delegate_task` with an
`output_schema` for structured report collection. The `delegate_task`
global must be available in the runtime (it is injected by the Hermes
agent framework). Standalone Node.js execution without `DRY_RUN=true`
will throw, because `delegate_task` is not defined outside a Hermes
session.

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
