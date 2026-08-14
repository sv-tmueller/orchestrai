# Codex adapter

The Codex adapter implements the adapter interface (spawn, detectFailure,
retry) for the OpenAI Codex host. It lets the orchestrator team run on
Codex with subscription auth (ChatGPT Plus/Pro), no metered API keys.

See `docs/architecture/adapter-interface.md` for the interface contract,
`docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
section 4 Phase D for the design, and
`docs/research/2026-08-14-codex-subscription-auth-spike.md` for the
verified auth path.

## Components

- `.claude/adapters/codex.json` -- the adapter table mapping tiers to
  models and efforts for the Codex host.
- `.claude/adapters/codex-adapter.mjs` -- the adapter module exporting
  `spawn`, `detectFailure`, `retry`, `resolveTier`, and `resolveRole`.
- `.claude/adapters/codex-renderer.mjs` -- the workflow renderer that
  reads JSON spec files and drives the adapter's spawn operations.
- `.claude/adapters/personas/*.toml` -- TOML personas for each role,
  mapped from the neutral role contracts.
- `.claude/workflows/__tests__/codex-adapter.test.mjs` -- tests for the
  adapter table, interface, renderer, and personas (dry-run mode).

## Authentication

The Codex adapter uses ChatGPT subscription auth exclusively. No
metered API keys are needed:

- `ANTHROPIC_API_KEY`: not used (Codex is an OpenAI host)
- `OPENAI_API_KEY`: not used (subscription auth via ~/.codex/auth.json)
- `CODEX_API_KEY`: not used (not a real key; the adapter uses OAuth tokens)

The spike (docs/research/2026-08-14-codex-subscription-auth-spike.md)
verified that `codex exec` runs with `auth_mode: chatgpt` in
`~/.codex/auth.json`, with `OPENAI_API_KEY: null` (no metered key
stored), and all three metered env vars unset.

## Configuration

### Adapter table

The adapter table at `.claude/adapters/codex.json` maps the three tiers
to concrete models:

```json
{
  "tiers": {
    "judgment": { "model": "o3", "effort": "high" },
    "worker": { "model": "gpt-5.6", "effort": "medium" },
    "lead": { "model": "o3", "effort": "high" }
  }
}
```

The judgment and lead tiers use o3 (high reasoning effort); the worker
tier uses gpt-5.6 (medium reasoning effort). These are
subscription-available models, not metered-only.

### TOML personas

Each role has a TOML persona under `.claude/adapters/personas/`. The
personas are mapped from the neutral role contracts
(docs/architecture/role-contracts.md), not copied from the Claude Code
frontmatter. Each persona carries:

- `description`: the role's job description (from role-contracts.md)
- `jobs`: the job types the role handles
- `report_contract`: the report format the role must return
- `constraints`: the role's constraints (read-only, never edits, etc.)

Personas do NOT carry model or effort; those are resolved from the
adapter table at dispatch time.

### Sandbox mode

`codex exec` runs in a sandbox. By default, the adapter uses `read-only`
sandbox for roles that don't write (reviewer, tester, fact-checker,
architect) and `workspace-write` for roles that do (developer,
docs-writer). Override via the `isolation` opt.

## Dry-run mode

Set `DRY_RUN=true` to exercise the adapter and renderer without live
codex exec calls. The test suite always runs in dry-run mode.

## Live mode

In live mode, `spawn` invokes `codex exec` via `execSync` with:
- `-m <model>` for model selection
- `-s <sandbox>` for sandbox mode
- `-c model_reasoning_effort="<level>"` for reasoning effort

The report is parsed from stdout. The parser strips the codex header
block and the "tokens used" footer, leaving the agent's response text.

## Volatility checklist

Before running the Codex adapter in production, re-verify the
volatility checklist from the codex-readiness design (section 10):
- ChatGPT subscription pricing and model availability
- `codex exec` auth defaults (confirm auth_mode stays chatgpt)
- Model coverage per auth path (o3, gpt-5.6 available on subscription)
