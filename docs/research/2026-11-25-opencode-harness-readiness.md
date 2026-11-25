# Harness readiness: mixed models today, and what opencode would take

Issue #430, part of batch #603. Dated 2026-11-25.

The question that started this: can the judgment seats (architect, reviewer)
run on a Claude model with strong reasoning and effort, while the worker
seats run on a different model such as glm or deepseek? And what would it
take to run the orchestrator on the opencode harness?

Short answers:

- Yes, on Claude Code today, with no new code. Select the adapter table
  `claude-code-split.json` with `CLAUDE_CODE_ADAPTER_TABLE` and export two
  settings variables. Part 1 has the steps.
- opencode is not needed for that. It would add a second way to host the
  seats, not a new capability. Part 3 sizes what an adapter would take.

## How to read this note

Repo statements name the file they come from, and were checked against that
file on the branch that adds this note. "Tested" means a test in this repo
covers it. "Run" means a dated doc in this repo records a live run. Where
neither is true the text says "configured in the table, not run here".

opencode statements were read from its public documentation and its public
repository on 2026-11-25. They were not run: opencode is not installed on the
build machine and nothing here was installed or executed. Each opencode
statement carries its source link. Where the docs do not answer a point the
text says "not found in the docs". The docs read are the OpenCode v2 docs
([docs index](https://opencode.ai/docs/llms.txt)). A V1 build uses different
config keys ([migrate from V1](https://opencode.ai/docs/migrate-v1/)), so
check the installed version before trusting a key name below.

## Part 1: Claude judgment seats and glm or deepseek workers, today

### What the table does

`.claude/adapters/claude-code-split.json` is the table for this split. It sets
`dispatch: "subprocess"`, so every seat the lead dispatches runs as its own
headless `claude -p` process (`docs/architecture/adapter-interface.md`,
"Host implementations"). Resolved from the table on this branch (checked with
`DRY_RUN=true` and `resolveSeat` from
`.claude/adapters/claude-code-subprocess.mjs`):

| Role | Tier | Model | Effort | Provider | Settings placeholder |
|---|---|---|---|---|---|
| architect | judgment | `opus` | xhigh | anthropic | `$CLAUDE_CODE_ANTHROPIC_SETTINGS` |
| reviewer | judgment | `opus` | xhigh | anthropic | `$CLAUDE_CODE_ANTHROPIC_SETTINGS` |
| developer | worker, per-role override | `vllm/release/glm-5-3` | high | vllm | `$CLAUDE_CODE_NORIS_SETTINGS` |
| tester | worker | `vllm/release/deepseek-v41-flash` | max | vllm | `$CLAUDE_CODE_NORIS_SETTINGS` |
| docs-writer | worker | `vllm/release/deepseek-v41-flash` | max | vllm | `$CLAUDE_CODE_NORIS_SETTINGS` |
| fact-checker | worker | `vllm/release/deepseek-v41-flash` | max | vllm | `$CLAUDE_CODE_NORIS_SETTINGS` |
| perf-investigator | worker | `vllm/release/deepseek-v41-flash` | max | vllm | `$CLAUDE_CODE_NORIS_SETTINGS` |

So glm is on the developer seat and deepseek is on the other worker seats. To
change which is which, edit the `roles` map (the developer entry is the
override shape the interface doc describes: a role value may be a tier string
or an object with `tier`, `model`, `effort`, `settings`).

Where the edited table lives matters, because the spawn module loads a table
only from the plugin's own `.claude/adapters/` folder, by bare file name
(`loadAdapterTable` in `claude-code-subprocess.mjs`):

- A copy with a new name in a project's `.claude/adapters/` breaks the run.
  `CLAUDE_CODE_ADAPTER_TABLE=my-split.json` fails with ENOENT (checked on this
  branch).
- A copy with the same name in a project's `.claude/adapters/` shadows the
  plugin table at the gate. Its `model`, `effort` and `settings` values reach
  the seats as dispatch options. It must keep each tier's `provider`, because
  the options carry no provider and the module reads it from its own table
  (`SKILL.md`, "Subprocess seat dispatch", "Which seat binding reaches the
  seat"). Swapping glm and deepseek between roles, both on `vllm`, is a change
  of this safe kind.
- A change of provider needs a new table in the template's own
  `.claude/adapters/`. That also puts it under the adapter-table and
  effort-policy tests, which read every `*.json` in that folder.

The lead session itself is not spawned by the adapter. It runs on whatever
model the main window uses. The smoke run record says so in section 1
(`docs/reviews/2026-11-07-subprocess-seats-smoke.md`).

### Steps

1. Prepare two Claude Code settings profiles: one for the paid Anthropic
   route, one for the endpoint that serves glm and deepseek. This repo does not
   say what is inside them: no file here sets an endpoint URL or a credential,
   by design (`expandSettings` in `claude-code-subprocess.mjs` says the table
   carries a placeholder, "never an absolute path and never a token"). The
   Claude Code settings docs say `--settings` takes inline JSON or a file path
   and that a settings file can hold an `env` block
   ([settings](https://code.claude.com/docs/en/settings)). Which variables
   point `claude` at your endpoint is for you to take from the Claude Code
   docs and your endpoint's docs. The model IDs in the table must be IDs your
   endpoint serves.
2. Export the table name and both placeholders before starting the lead
   session. Each placeholder holds a settings file path or an inline JSON
   object (`expandSettings`).

   ```
   export CLAUDE_CODE_ADAPTER_TABLE=claude-code-split.json
   export CLAUDE_CODE_ANTHROPIC_SETTINGS=/path/to/anthropic-settings.json
   export CLAUDE_CODE_NORIS_SETTINGS=/path/to/selfhosted-settings.json
   ```

   `CLAUDE_CODE_ADAPTER_TABLE` is a bare `*.json` file name, default
   `claude-code.json` (`.claude/skills/tm-kickoff/SKILL.md`, "Adapter table
   (once per run)"). If a placeholder is unset, the dispatch throws and the
   package parks rather than loading no profile (SKILL.md, "Subprocess seat
   dispatch", "Settings").
3. Run `/tm-kickoff <issues>` as usual. The gate reads the table once, sees
   `dispatch: subprocess`, and sends every lead-executed seat through
   `dispatchSeat`. One table applies to the whole run, all packages included.
4. Optional offline check before a live run: the same one-liner SKILL.md gives,
   with `DRY_RUN=true`, returns a synthetic report and spawns nothing. It proves
   the table loads and the role resolves. It does not prove the endpoint works.

Seat failures follow respawn-once-then-park: one respawn on the same binding,
then the package parks (`adapter-interface.md`, "Retry variants").

### Rules the table lives under

- Mixed providers are allowed in one table. `adapter-interface.md`, "Adapter
  table": the table-level `effort_ceiling` and `forbidden_efforts` carry the
  paid baseline (xhigh, max forbidden). Each tier is then resolved from its own
  `provider`. A paid tier keeps the baseline. A self-hosted tier (provider
  `vllm` or `custom`) is exempt and may run at `max`. The
  `claude-code-split.json` worker tier relies on this, which is why the
  judgment seats stay at xhigh while the workers run at max. The exempt set is
  `SELF_HOSTED_PROVIDERS` in `claude-code-subprocess.mjs`. The interface doc
  names only `vllm`, so it is behind the code on this point.
- "Better reasoning and effort" on the judgment seats has a ceiling: on a paid
  provider, `max` is forbidden, and `buildArgv` throws if a paid tier asks for
  it. xhigh is the most the table allows there.
- Fable cannot go in the table. `.claude/team-guide.md`, "Model policy": no
  part of the machinery pins Fable, and the effort-policy test fails if a table
  pins it. Fable is only the owner's own `/model` choice for the main window,
  which is the lead, not a seat. Opus is the table's judgment model.
- If glm or deepseek come from a paid hosted API instead of a self-hosted
  endpoint, the provider is outside the exempt set (`vllm`, `custom`). Then the
  paid policy applies to that tier: set a provider outside that set and an
  effort at or below xhigh. This is a provider change, so it needs a new table
  in the template's `.claude/adapters/`, covered by the adapter-table and
  effort-policy tests. A same-name project copy cannot do it. If it changes a
  tier's provider, the module still uses the plugin's `vllm` binding: `max` is
  not blocked and the paid seats are recorded unpriced (`SKILL.md`, "Which
  seat binding reaches the seat"; `forbiddenEffortsForTier` and `captureUsage`
  in `claude-code-subprocess.mjs`). The exemption set lives in
  `effort-policy.test.mjs` and is mirrored by `SELF_HOSTED_PROVIDERS` in the
  module. The effort-policy test has a fixture case that keeps a table without
  a self-hosted provider on the paid policy. A hosted-provider table was not
  written or run here.
- Workflow stages are not covered. The workflow scripts in
  `.claude/workflows/*.js` pass `TIER_MODELS[tier]` and `TIER_EFFORTS[tier]`
  to their `agent()` calls. Those are inline maps that copy `claude-code.json`
  (opus, sonnet; for example `tm-review-changes.js`), because the workflow
  runtime has no imports, and `effort-policy.test.mjs` checks them against that
  table. So `tm-review-changes` and the other workflows run on Claude models
  whatever table the run selects. `adapter-interface.md` still calls this
  future Phase B work, so it is behind the code (#314).

### The per-stage alternative: `.orchestrai/columns.json`

A target repo can put `.orchestrai/columns.json` on its default branch to pick
provider, model and effort per stage (`SKILL.md`, "Remote stage dispatch
(columns.json)"; validator `.claude/skills/tm-kickoff/columns.mjs`). It is a
weaker fit for this question, for three reasons read from the validator and the
skill:

- A column runs in the lead only when its runner is `vps` and its provider kind
  is `anthropic`. Any other column, a `vllm` provider included, gets
  `execute: runner:<id>`: the lead posts a JOB comment and waits for a runner's
  poller to claim the stage. Checked on this branch: a `vps` column on a `vllm`
  provider validates and prints `"execute":"runner:vps"`. The poller is not in
  this repo, so whether it exists for you is outside what this note can say.
- Effort in a column is one of `low`, `medium`, `high`, `xhigh`. `max` is not
  accepted.
- A `vllm` provider needs a `base_url` in the file. The credential and the rest
  of the Claude Code profile do not come from this file.

When the column is `lead`, its model and effort replace the table's tier values
for that dispatch (SKILL.md, "Subprocess seat dispatch", "columns.json"). The
two can be combined, with one catch. A `lead` column must have provider kind
`anthropic` (`executeFor` in `columns.mjs`), but `SKILL.md` names only `model`
and `effort` as replaced, so on a worker stage the seat keeps the table's
settings for that role, which point at the self-hosted endpoint. A Claude model
from the column would then be sent to that endpoint. Use a `lead` column only
on a stage whose seat settings point at the paid route.

### What is tested, run, and what needs your endpoints

| Claim | Status | Where |
|---|---|---|
| The split table has opus xhigh on a non-vllm provider, vllm workers at max, a per-role override, and the paid baseline at table level | Tested | `.claude/workflows/__tests__/adapter-table.test.mjs`, `effort-policy.test.mjs` |
| `buildArgv` binds model, effort, settings and cwd per seat; failure detection, respawn and park behave | Tested against a stub binary (`CLAUDE_BIN`), no live endpoint | `.claude/workflows/__tests__/claude-code-subprocess.test.mjs` |
| One scratch package ran end to end on the split table: opus architect and reviewer, glm-5-3 developer, deepseek-v41-flash tester, reports parsed, usage captured, vllm seats recorded unpriced | Run once on 2026-11-07, one package at a time | `docs/reviews/2026-11-07-subprocess-seats-smoke.md` |
| Timeout kill and respawn-then-park on a live seat | Run, in the same smoke run | same file, section 4 |
| Your two settings profiles, your model IDs, your credentials | Not tested here: needs your endpoints | Part 1, steps 1 and 2 |
| A paid hosted glm or deepseek provider | Configured nowhere, not run here | n/a |
| Parallel packages on the split table | Not run: the smoke run was one package at a time | smoke record, section 1 |

An earlier design in this repo calls routing the Claude CLI to a non-Claude
model a trap, for four reasons: prompt caching stops working, the Workflow tool
breaks or degrades, extended thinking breaks, and a gateway that serves one
model to every request collapses the per-seat model policy
(`docs/superpowers/specs/2026-07-08-codex-readiness-design.md`, section 2). The
subprocess table is a different shape: the lead stays on Claude and only the
seat processes talk to the other endpoint. The smoke record logs cache-read
token counts for the vllm seats, but this repo holds no measurement of cost,
cache behaviour or extended thinking on that endpoint.

## Part 2: Hermes and opencode against the adapter interface

The interface asks every host for three operations: `spawn` (one seat, pinned
tier and effort, report or null), `detectFailure`, and `retry`, plus an adapter
table mapping tiers and roles to bindings (`adapter-interface.md`). The
Hermes side below is read from `docs/architecture/hermes-adapter.md`,
`.claude/adapters/hermes-adapter.mjs`, `hermes.json` and `hermes-openrouter.json`.
The opencode side is read from the docs and was not run. Source keys for the
opencode column: [run](https://opencode.ai/docs/cli/commands/),
[cli](https://opencode.ai/docs/cli/), [agents](https://opencode.ai/docs/agents/),
[models](https://opencode.ai/docs/models/),
[providers](https://opencode.ai/docs/providers/),
[config](https://opencode.ai/docs/config/),
[permissions](https://opencode.ai/docs/permissions/),
[instructions](https://opencode.ai/docs/instructions/),
[tools](https://opencode.ai/docs/tools/),
[skills](https://opencode.ai/docs/skills/),
[api](https://opencode.ai/docs/api/), [sdk](https://opencode.ai/docs/build/sdk/).

| Need | Hermes (repo) | opencode (docs, not run) |
|---|---|---|
| Headless one-shot run of a seat | `hermes -z "<prompt>"` prints only the final response. Adapter adds `--yolo --accept-hooks` because no TTY can answer a prompt (`hermes-adapter.mjs`, `buildArgv`). Run live: batch #437 e2e, per the code comment. | `opencode run "<message>"` sends a message and prints the reply without the interactive UI, described as designed for scripts and CI jobs ([cli](https://opencode.ai/docs/cli/), "Automation"). That it exits when done: not found in the docs. Whether stdin is read: not found in the docs. |
| Per-seat model | `-m <model>` per spawn, from the table tier or an override. | `--model provider/model`, with an optional `#variant` suffix ([run](https://opencode.ai/docs/cli/commands/), [models](https://opencode.ai/docs/models/)). An agent can also carry its own `model` ([agents](https://opencode.ai/docs/agents/)). |
| Per-seat provider | `--provider <p>` per spawn; the endpoint and key live in `~/.hermes/config.yaml` (`hermes-adapter.md`, "Model and provider config"). | The provider is the first segment of the model reference ([models](https://opencode.ai/docs/models/)). Providers are defined in a `providers` object. A custom OpenAI-compatible endpoint takes `package`, `settings.baseURL`, `env` and `models` ([providers](https://opencode.ai/docs/providers/)). A DeepSeek or Z.AI/GLM entry: not found in the docs; the custom route is the documented path. |
| Per-seat effort | `--reasoning <effort>` per spawn. Hermes accepts `ultra` above `max`, so the adapter forbids it (`hermes-adapter.mjs`). | No `--effort` flag found. A variant is a named option on a model, often a reasoning level, and its names come from the model catalog, so `low`, `high` and `max` are not available for every model; an unknown variant is a resolution error ([models](https://opencode.ai/docs/models/)). `settings.reasoningEffort` can be set on a provider, model or variant (same page). |
| Different providers in one run | Per spawn, so the seats of one run can differ (`hermes.json` is all `custom`, `hermes-openrouter.json` all `openrouter`; a mixed Hermes table is not in the repo). | Several providers can be defined in one config ([providers](https://opencode.ai/docs/providers/)). Per-seat choice by `--model` on each run ([run](https://opencode.ai/docs/cli/commands/)). Credentials: `/connect`, `env` names or `{env:NAME}` values ([providers](https://opencode.ai/docs/providers/), [config](https://opencode.ai/docs/config/)). The run page advises a private server (`--standalone`) so it receives the provider key passed in the environment ([run](https://opencode.ai/docs/cli/commands/)); by default one shared background server serves all CLI commands of a user ([cli](https://opencode.ai/docs/cli/)). |
| Instruction file | The adapter prepends the role contract from `.claude/adapters/prompts/<role>.md` to the task in the `-z` prompt (`spawn`). Whether Hermes itself loads `AGENTS.md`: not found in this repo. The prompts tell the seat to follow `AGENTS.md`. | `AGENTS.md` is the main file, global and project; `CLAUDE.md` is read only in a directory that has no `AGENTS.md`; no `@` import support found in the docs; other files load only through the `instructions` key ([instructions](https://opencode.ai/docs/instructions/)). Whether it is loaded in a headless run: not found in the docs. With no global `~/.config/opencode/AGENTS.md`, opencode reads `~/.claude/CLAUDE.md` instead, so a Claude Code user's global file would reach the seat too. For this repo that means the root `AGENTS.md` loads and the root `CLAUDE.md` does not. `AGENTS.md` uses no `@` imports and tells the reader to read `.claude/process-core.md` itself, so the same file works. |
| Skills in the repo | Not found in this repo for Hermes seats beyond the `~/.hermes/skills/` install in `hermes-adapter.md`. | `.claude/skills` is read as a compatibility location ([skills](https://opencode.ai/docs/skills/)). `OPENCODE_DISABLE_CLAUDE_CODE=1` skips `.claude` skills and `CLAUDE.md` files ([instructions](https://opencode.ai/docs/instructions/)). The same page says the server reads the variable when it starts, and by default one shared background server serves all CLI commands of a user ([cli](https://opencode.ai/docs/cli/)). `--standalone` runs a private server, and `opencode service set env` passes a variable to the server process ([run](https://opencode.ai/docs/cli/commands/)). Inference from these three pages: a value set per spawn takes effect only with `--standalone`, and `service set env` is a setting of the shared server, not of one spawn. Otherwise a seat inside this repo would see the `tm-*` skills. |
| Subagents and delegation | No seat gets the `delegation` toolset, so no seat can re-delegate: flat-star is enforced by omission (`hermes.json`, `_seats_comment`). | A `subagent` tool starts a background child session, default depth one ([tools](https://opencode.ai/docs/tools/)). A `subagent` permission can deny `*` ([agents](https://opencode.ai/docs/agents/)). The built-in `general` agent denies subagents ([permissions](https://opencode.ai/docs/permissions/)). A setting that removes the tool outright: not found in the docs. |
| Permission modes | `--yolo` approves everything. `-t file,terminal` limits tools but cannot express read-only, since `terminal` implies write (`hermes.json`, `hermes-adapter.md`). Read-only is a prompt rule. | Ordered `allow`, `ask`, `deny` rules per action and resource, last match wins, no match means `ask`. An agent's rules are appended after the global ones ([permissions](https://opencode.ai/docs/permissions/)). `--auto` auto-approves what is not explicitly denied ([run](https://opencode.ai/docs/cli/commands/)). What an `ask` does with no `--auto`: not found in the docs. Denying `edit` is expressible, but the base policy allows `shell` ([permissions](https://opencode.ai/docs/permissions/)), and the seats need shell for git and gh, so a shell write stays possible: read-only is still partly a prompt rule (inference from the two pages). |
| Working directory | Process `cwd` plus `TERMINAL_CWD` in the environment. Hermes v0.20.0 has no `--in` flag (`hermes-adapter.mjs`, `runHermes`). | `run` has no directory flag in the docs read. Config is searched from the current directory upward ([config](https://opencode.ai/docs/config/)). The SDK and API take a directory (`location`) per session ([sdk](https://opencode.ai/docs/build/sdk/), [api](https://opencode.ai/docs/api/)). Whether a spawn `cwd` is enough for `run`: not found in the docs. |
| Output a report parser can read | stdout is the final response; `parseReport` in `role-contract-parser.mjs` keys on `STATUS:`, `VERDICT:` and the architect opener. No structured-output parameter. | `opencode run` prints the reply; `--format json` emits newline-delimited JSON ([run](https://opencode.ai/docs/cli/commands/)). The JSON event shape: not found in the docs. A structured-output parameter: not found in the docs ([api](https://opencode.ai/docs/api/), [sdk](https://opencode.ai/docs/build/sdk/)). The shared parser would work on the final text only if that text can be picked out. |
| Exit codes and failure signals | `detectFailure`: nonzero exit, empty stdout, a provider error in either stream (`HTTP nnn`, quota, rate limit, unauthorized, invalid key), or a report missing its required field. 30 minute timeout, then kill. | Exit codes: not found in the docs for any command ([run](https://opencode.ai/docs/cli/commands/)). Provider-error text on stderr or stdout: not found in the docs. The HTTP API returns typed errors with status codes ([api](https://opencode.ai/docs/api/)). The failure rules would have to come from a probe. |
| Retry | Within-tier `fallback_model` where the table declares one, else judgment retries on worker; the retry prompt carries a notice (`hermes-adapter.mjs`, `retry`). | Retry is the adapter's job on every host, so the table row has no opencode feature to compare. Whether opencode has its own provider fallback: not found in the docs. |
| Cost and usage | Not captured by the Hermes adapter in the code read. | `opencode stats` has `--cost` and `--models` flags ([run](https://opencode.ai/docs/cli/commands/)). Usage in a `run` result: not found in the docs. |
| Install and binary override | `HERMES_BIN` for tests, so CI never calls a real install. | Several install routes (script, npm, Homebrew, binary, Docker) ([intro](https://opencode.ai/docs/), [repo](https://github.com/anomalyco/opencode)). The adapter would add its own `OPENCODE_BIN`, as the other two do. |

### What this says

- opencode has the pieces a seat needs on paper: a one-shot run, a per-run
  model with provider, per-agent permission rules, an instruction file that is
  this repo's `AGENTS.md`, and a documented custom OpenAI-compatible provider.
  That fits the glm and deepseek case.
- The gaps are all in the part an adapter lives on: exit codes, the shape of
  the JSON output, the working directory for `run`, and what an unanswered
  `ask` does. None of these can be settled from the docs. They need one probe
  on a machine with opencode installed (package 1 below).
- Effort is the least settled mapping. The interface speaks of `high`,
  `xhigh` and `max`; opencode speaks of model-specific variants. A table
  would have to name the variant for each tier and the effort policy would
  have to know what the variant means for that model.
- The two harnesses differ most on read-only and flat-star. Hermes enforces
  flat-star by leaving a toolset out. opencode would enforce it with a deny
  rule on `subagent`, and the docs name no setting that removes the tool.

## Part 3: A proposal for an opencode adapter, as packages

Proposed, not filed. Each is `size:S` or `size:M`. Packages 1, 4 and 6 need a
machine with opencode installed and live endpoints, which the build machine
does not have, so a kickoff run on it would park them. The live runs are their
own packages for that reason, as #461 was split from #453: the adapter
packages meet their acceptance with stub binaries and fixtures on the build
machine. The packages run in the order of their dependencies, and each leaves
`main` green with `npm test`.

One decision comes before filing: is opencode a host for seats under a Claude
Code lead (as the Codex design planned for its worker seat), or the host of the
whole team including the lead? Packages 1 to 6 serve both. Package 7 is the
first that differs. The current kickoff gate stops a run whose table host is
not `claude-code` (`SKILL.md`, "Adapter table (once per run)"), so either
choice needs a gate change.

### Package 1: record an opencode run probe (size:S)

Scope. On a machine with opencode installed and one provider connected, run a
small fixed set of one-shot runs and record what happens in a dated research
entry. Cover: the `--format json` event shape; the exit code and stderr for a
bad model, a bad key, an unreachable endpoint and a timeout; whether a spawn
`cwd` selects the project for `opencode run`; whether `AGENTS.md` loads in a
headless run; whether `~/.claude/CLAUDE.md` loads when no global opencode
`AGENTS.md` exists; what an `ask` does with and without `--auto`; whether a
`deny` on `subagent` blocks the tool; what `OPENCODE_DISABLE_CLAUDE_CODE=1`
skips, and whether a value set per spawn takes effect with the shared
background server, with `--standalone`, and with `opencode service set env`;
whether usage appears in the output. Run it against a glm or deepseek endpoint
and a Claude model. No adapter code and no repo change beyond the entry.

Acceptance.
- Every "not found in the docs" cell in Part 2 is replaced by an observed fact
  or by "no answer from the probe", with the command and output excerpt.
- The entry names the opencode version run.

Depends on: nothing. Needs a machine with opencode installed and live
endpoints (the owner's).

### Package 2: opencode adapter table and effort policy (size:S)

Scope. Add `.claude/adapters/opencode.json` (host `opencode`) with the tiers,
roles and per-role override shape of `claude-code-split.json`, plus a variant
name per tier, and extend `adapter-table.test.mjs` and `effort-policy.test.mjs`
so the new host is covered, including the self-hosted exemption for a
`custom` or `vllm` provider and the paid baseline for the rest. Record in the
architecture doc how a tier effort maps to an opencode variant, using what
package 1 found.

Acceptance.
- `npm test` passes with the new table, and a table that lifts the ceiling on a
  paid provider fails the effort-policy test.
- The effort-to-variant mapping is in `docs/architecture/` with the probe as its
  source.

Depends on: package 1.

### Package 3: opencode worker seat adapter (size:M)

Scope. The smallest useful adapter, a worker seat, as the Codex readiness
design planned (option 4). Add `.claude/adapters/opencode-adapter.mjs`
exporting `spawn`, `detectFailure` and `retry` for the worker tier: argv built
from the table (`run`, `--model` with variant, `--auto` only if package 1 shows
it is needed, JSON format only if it helps), the seat `cwd` as the spawn
option, and `--standalone` on every run when package 1 confirms that
`OPENCODE_DISABLE_CLAUDE_CODE=1` turns off the `.claude` skills and `CLAUDE.md`
fallback: the server reads the variable when it starts, so a per-spawn value
needs a private server (otherwise the owner sets it once with
`opencode service set env`, and the adapter doc says so). It reuses
`role-contract-parser.mjs` and the shared role prompts. Failure rules come from
package 1's exit codes. Retry is respawn-once-then-park, as in
`claude-code-subprocess.mjs`, unless package 1 shows a cheaper tier worth
falling to. An `OPENCODE_BIN` override and `DRY_RUN=true` keep the tests
offline. Add `docs/architecture/opencode-adapter.md` and a status line in
`adapter-interface.md`.

Acceptance.
- A test file runs the adapter against a stub binary: argv per tier, a clean
  report, each failure class from package 1, respawn then park, and a model
  pin that cannot reach a forbidden effort.
- If package 1 confirms the need, the stub test asserts that the argv carries
  `--standalone` and the environment carries the variable on every spawn.

Depends on: packages 1 and 2. No live endpoint needed.

### Package 4: live run of the opencode tester seat (size:S)

Scope. One live run of the tester seat through the adapter on a glm or
deepseek model against a real PR, recorded in a dated `docs/reviews/` entry
that names the opencode version, the table and any trap the stub tests missed.
Traps are fixed or filed as their own issues, not fixed inside the run.

Acceptance.
- The run returns a parsed `VERDICT`.
- The entry is committed.

Depends on: package 3. Needs a machine with opencode installed and live
endpoints (the owner's), so it does not run on the build machine.

### Package 5: opencode judgment seats (size:M)

Scope. Add the architect and reviewer to the adapter, with a Claude model on
the judgment tier through opencode's Anthropic provider. Write the permission
rules per role: deny `edit` where the role contract is read-only, deny
`subagent` for every seat to keep flat-star, and keep `shell` for git, gh and
the checks. Add a test that every seat's rules deny `subagent`. The architect
and reviewer reports go through the same parser.

Acceptance.
- The stub-binary tests assert the deny rules reach each seat's invocation for
  all seven roles.
- The architect and reviewer reports from fixtures parse through the shared
  parser.

Depends on: package 3. No live endpoint needed.

### Package 6: live run of the opencode reviewer seat (size:S)

Scope. One live reviewer run on opencode against a scratch PR, recorded in a
dated entry as package 4 is. It also checks on a live seat that the `subagent`
deny holds.

Acceptance.
- The run returns an `APPROVE` or `CHANGES_REQUESTED` verdict.
- The entry is committed.

Depends on: packages 4 and 5. Needs a machine with opencode installed and live
endpoints (the owner's), so it does not run on the build machine.

### Package 7: kickoff gate and dispatch for the opencode host (size:M)

Scope. Make the kickoff gate accept a table whose host is `opencode` and add
the dispatch section that calls the adapter, following "Subprocess seat
dispatch" for the package worktree, the timeout, the settings placeholders and
the respawn-then-park rule. If the owner chose opencode as the lead host too,
this package grows past `size:M` and should be split along that line: seats
first, lead second. The skill change goes template-first.

Acceptance.
- A skill text test pins the new gate rule and the dispatch section, as the
  existing `kickoff-*-text.test.mjs` tests do for theirs.
- A `DRY_RUN=true` pipeline run on the opencode table reaches a ready PR with
  synthetic reports.

Depends on: packages 3 and 5. No live endpoint needed.

Order and size: 1 (S), 2 (S), 3 (M), 4 (S), 5 (M), 6 (S), 7 (M). About four to
five working sessions once package 1 is done. Package 1 is the one that moves
the estimate, since every other package takes its failure rules from it.

## Recommendation

Do not file anything for opencode yet. Run Part 1 first: it answers the
original question with the code that exists, and the smoke run shows it works
for one package. If a second harness is still wanted after that, start with
package 1. It costs one short session on a machine with opencode, and it turns
the unknowns in Part 2 into facts before any adapter code is written.

## Sources

Repo files (all read on the branch for this note):
`docs/architecture/adapter-interface.md`, `docs/architecture/hermes-adapter.md`,
`docs/architecture/codex-adapter.md`, `docs/architecture/role-contracts.md`,
`.claude/adapters/claude-code-split.json`, `claude-code-vllm.json`,
`hermes.json`, `hermes-openrouter.json`, `claude-code-subprocess.mjs`,
`hermes-adapter.mjs`, `role-contract-parser.mjs`,
`.claude/skills/tm-kickoff/SKILL.md`, `.claude/skills/tm-kickoff/columns.mjs`,
`.claude/team-guide.md`, `AGENTS.md`,
`docs/reviews/2026-11-07-subprocess-seats-smoke.md`,
`docs/superpowers/specs/2026-07-08-codex-readiness-design.md`.

External pages, read 2026-11-25, not run: the opencode docs pages linked
above, the [repository README](https://github.com/anomalyco/opencode), and the
[Claude Code settings page](https://code.claude.com/docs/en/settings).
