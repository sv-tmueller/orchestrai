# Native coverage audit: orchestrai vs. Claude Code - 2026-09-28

## Bottom line

This repo has used native subagent frontmatter and the native workflow
runtime since it first adopted each; neither was a gap it filled
itself. Subagent frontmatter carries `model`, `effort`,
`isolation: worktree`, and `skills` fields, and the three `tm-`
workflow scripts have been `export const meta` scripts calling
`agent()`/`parallel()`/`phase()` since each was first written, the same
primitive the docs describe, not an architecture merely shaped like it.
What has caught up since is narrower, dated where the table below cites
it: worktrees now get automatic locking, a periodic cleanup sweep, and
isolation checks blocking an edit or a git redirect aimed at the main
checkout, plus, since v2.1.203, a check blocking a command whose
working directory resolves there, and, for part of the batch jobs,
one-approval unattended execution and a cross-session progress view.

The table ends at 12 keep, 2 thin (worktree isolation and cleanup, the
reviewer stage), and 0 cut. The 12 keeps are not 12 things native lacks.
One, role-agent frontmatter, is a native feature used as shipped; it is
keep only because nothing on it is left to thin. One, the `tm-` workflows,
runs on the native runtime as shipped and is keep for the bespoke pieces on
top of it. The other ten are this repo's own layer, each with at most a
partial native analog, in three kinds. One is a pin layer on top of native
fields: `tier:` in each agent's frontmatter, resolved to a concrete model
and effort through a swappable adapter table
(`.claude/adapters/claude-code.json`, plus `codex.json` and `hermes.json`
for other hosts), enforced by `effort-policy.test.mjs`. Another is separate
seats with written role contracts: a tester apart from the implementer, and
an architect that arbitrates between agents. The third is process state,
split by where it lives: on GitHub (sizing, the lean track, parking,
fix-round caps, a batch tracking issue, and the per-role token report) or
only in the run itself (the plan-status block, printed in the lead session
before each dispatch, not stored anywhere, and a shared dependency
environment, a per-run build on the lead's machine, deleted when the run
ends). `/batch` and Projects are the closest native analogs to a
tm-advisor/tm-kickoff run: `/batch` takes one plan approval and then runs
implementer subagents unattended, and Projects coordinates a stream of work
across days with an Overview pane showing what needs the user. Neither
writes that state to a GitHub issue the way this repo does. The gap is
where the record lives and who can read it: a batch issue sits next to the
PRs it tracks, readable from any GitHub client or another host's CLI, while
`/batch`'s plan lives in the session and Projects' record lives at
claude.ai/code. None of the three kinds has a full native equivalent as of
this audit, though several pieces now have partial ones (detailed in the
table).

One data point from `docs/reviews/2026-07-13-ab-plan-status-parser.md`
needs a precise reading, beyond the cost-and-catch comparison already
collected in `docs/why-the-team.md`. That report ran this repo's own
`tm-review-changes` workflow, not a third-party product, as an independent
pass against two diffs of the same task: one from the full kickoff
pipeline, with its own tester and reviewer stages, one from a single
developer dispatch with neither. `tm-review-changes` caught a shared
suffix-parsing flaw in both diffs. The pipeline diff's own tester and
reviewer stages missed it; the solo diff had no such stages to miss it in
the first place. That is evidence an independent pass, itself a `tm-`
script running on the native workflow runtime, catches something the
bespoke tester and reviewer stages, and a lone developer dispatch, do not,
in one paired run. It is not evidence about GitHub Code Review, the cloud
product with a similar fan-out-plus-verify shape: the a/b never ran it.
That product is a research preview available only on Team and Enterprise
plans, at roughly $15-25 per review in usage credits. This team runs on Max
or Pro, where the comparable native options are the local `/code-review`
command (no extra cost, catching power against this specific flaw untested)
and, for a deeper cloud pass, `/code-review ultra` (3 free runs per
account, then $5-25 each).

## Feature comparison

| Feature | Where it lives | Native equivalent | Remaining gap | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Role-agent frontmatter (model, effort, isolation, skills) | `.claude/agents/architect.md`, `developer.md`, `tester.md`, `reviewer.md`, `fact-checker.md`, `docs-writer.md`, `perf-investigator.md` (frontmatter) | Subagent frontmatter fields `model`, `effort`, `isolation: worktree`, `skills` - [Subagents](https://code.claude.com/docs/en/sub-agents) | The frontmatter mechanism itself is native, and the repo adopted each field as it went. Only the prompt content (verdict taxonomies, two-pass review order, the TDD-skill preload) is still bespoke. | keep | Keep: the four fields this row names are native and used as shipped, so nothing is left to thin; what this repo adds is the written role contracts in the prompt bodies. |
| Per-seat tier pinning (`tier:` in each agent, resolved through an adapter table, enforced by a policy test) | `.claude/agents/*.md` `tier:` field, `.claude/adapters/claude-code.json` (plus `codex.json`, `hermes.json` for other hosts), `.claude/workflows/__tests__/effort-policy.test.mjs` | Partial: model aliases (`opus`, `sonnet`) resolve to a concrete model per provider and are overridable per alias with `ANTHROPIC_DEFAULT_OPUS_MODEL`/`ANTHROPIC_DEFAULT_SONNET_MODEL`, an organization's `availableModels`/`deniedModels` allowlist applies to the subagent `model` field, and, for the effort ceiling specifically, the `maxEffortLevel` managed setting caps effort on the client on any plan and provider - [Model config, "Model aliases" and "Environment variables"](https://code.claude.com/docs/en/model-config), [Model config, "Restrict model selection"](https://code.claude.com/docs/en/model-config), [Model config, "Organization effort limits"](https://code.claude.com/docs/en/model-config) | All three work inside one host: none resolves anything across Claude Code, codex, and hermes at once, and Claude Code's own frontmatter `model:` still takes a literal value (`tester.md` reads `model: sonnet`). `effort-policy.test.mjs` checks that value against the adapter table as a consistency check on Claude Code, not a runtime resolution; the adapter table is what lets the same `tier:` render a different model and effort per host. | keep | Keep rests on the adapter table rendering one `tier:` to a different model and effort per host, and on the policy test failing any unpinned seat, neither of which model aliases, the allowlist, or `maxEffortLevel` do across hosts. |
| Deterministic worktree isolation and cleanup | `isolation: worktree` on developer/tester/reviewer; "Worktree cleanup (deterministic)" in `.claude/skills/tm-kickoff/SKILL.md` | `isolation: worktree` subagent field plus automatic worktree locking, a periodic cleanup sweep, origin-safety checks before removal, and isolation checks that block an edit or a git redirect aimed at the main checkout, plus, since v2.1.203, a check blocking a command whose working directory resolves there - [Worktrees, "How Claude Code enforces isolation"](https://code.claude.com/docs/en/worktrees), [Sub-agents, "Write subagent files"](https://code.claude.com/docs/en/sub-agents) | Native's sweep is age-based (`cleanupPeriodDays`), not synchronous. `/tm-kickoff` needs the worktree gone right after a package ships or parks, not on the next sweep, so the next wave doesn't collide. | thin | Native now supplies the field, the lock, most of the safety check, and the command and git-redirect blocks that stop exactly the leak `/tm-kickoff`'s wave-end HEAD repair (`git switch <default>`, SKILL.md) exists to reverse. Keep the immediate per-package trigger; the HEAD-repair step is the thinning target now that native blocks a dispatched agent's command from resolving into the main checkout. |
| The `tm-` review/audit workflows as a scripted orchestration layer | `.claude/workflows/tm-review-changes.js`, `tm-review-codebase.js`, `tm-map-codebase.js` | Dynamic workflows: the JS runtime these scripts already execute on - `export const meta`, `agent()`/`pipeline()`/`parallel()`/`phase()`, resumability, a progress view via `/workflows`, and concurrency caps - [Dynamic workflows](https://code.claude.com/docs/en/workflows) | The fan-out-plus-critic architecture is a native runtime capability, not an alternative to one. What's still bespoke: a versioned `SPEC` object mirrored to a JSON spec file and checked by `specs.test.mjs`, per-host renderers (codex, hermes) reading that same spec, a tier-to-model resolution hard-pinned in-script and enforced by `effort-policy.test.mjs` (a native `agent()` call takes whatever model the script author writes, with no checked-in enforcement), and a fixed shape per script (a fixed dimension list in `tm-review-changes`, a hard-clamped area count in the other two) instead of Claude drafting a fresh script per run. | keep | Keep: the runtime is native and used as shipped, and each piece on top (the checked-in spec the codex and hermes renderers read, the in-script tier pins, and a per-script agent bound: a fixed dimension list in `tm-review-changes`, a hard area ceiling in the other two) has no native replacement, since the size guideline only advises and the runtime's own hard cap is 1,000 agents per run. |
| Tester stage (independent verification, full check suite, adversarial input) | `.claude/agents/tester.md` | Three partial analogs: local `/code-review --fix` (finds issues and applies them to the working tree in one pass, without running a check itself), the workflows pattern "keep fixing until a check passes" (a script runs a checker and iterates until it's green or two rounds in a row make no progress), and `/batch` (each subagent implements its unit and runs its own tests before publishing) - [Code Review](https://code.claude.com/docs/en/code-review), [Dynamic workflows, "Keep fixing until a check passes"](https://code.claude.com/docs/en/workflows), [Commands, `/batch`](https://code.claude.com/docs/en/commands) | The workflows pattern already runs a check and loops a fix until it passes or stalls, and `/batch` already has the implementer run its own tests. Neither ties either behavior to a seat independent from the one that wrote the code, or to a fix-round count scoped to a GitHub issue. | keep | Keep because no cited native page ties check-running or fix-looping to a reporting seat separate from the implementer, or to an issue-scoped round cap enforced in `tester.md` and `SKILL.md`. |
| Reviewer stage (spec-compliance pass, then quality pass) | `.claude/agents/reviewer.md` | Locally, `/code-review` (correctness plus reuse/simplification/efficiency cleanups, no extra cost); at higher assurance and cost, GitHub Code Review (research preview, Team/Enterprise only, ~$15-25/review in usage credits) or `/code-review ultra` (3 free cloud runs per account on Pro/Max, then $5-25/review) - [Code Review](https://code.claude.com/docs/en/code-review), [Ultrareview pricing](https://code.claude.com/docs/en/ultrareview) | The quality pass (correctness, simplicity, style) documents the same scope as the free local `/code-review`. The spec-compliance pass (matching a diff against a specific issue's acceptance criteria) has no native equivalent: the local `/code-review` reads a repo's `CLAUDE.md`; only the cloud GitHub Code Review also reads a repo's `REVIEW.md`. Neither reads a linked GitHub issue's acceptance criteria. | thin | The free local `/code-review` documents the same scope this repo's quality pass covers, so that half overlaps on paper. Its catching power against a flaw this repo's own stages miss is untested: the only measured comparison (`docs/reviews/2026-07-13-ab-plan-status-parser.md`) ran `tm-review-changes`, not `/code-review`, as the independent pass; the quality pass is the drop candidate once a paired run shows local `/code-review` catches as much. |
| Token/cost report per role and model, posted to the issue | `.claude/skills/tm-kickoff/token-report.mjs` | `/usage` (attribution by skill, subagent, plugin, and MCP server, toggled between the last 24 hours and the last 7 days) - [Manage costs](https://code.claude.com/docs/en/costs), and `--output-format json`'s `total_cost_usd` plus a per-model cost breakdown - [Headless mode](https://code.claude.com/docs/en/headless). The `/usage` Session block shows total cost and usage by model for the current session, and resets on `/clear`. | Native's attribution is a percentage view computed from local session history on this machine over a fixed 24-hour or 7-day window, not a per-role token table with per-model dollars for one run scoped to a GitHub issue; the Session block has per-model dollars for the current session only, with no per-role split; `total_cost_usd` gives one run's total but no per-role split. | keep | Keep: native `/usage` shows session totals but resets on `/clear` and is never posted to the issue; this report posts a per-role token table with per-model dollars for one run's window. |
| Batch tracking issue (contract, decision log, parked questions, final report) | `.claude/skills/tm-advisor/SKILL.md` | Three partial analogs: `/batch` (bundled skill: decomposes work into 5-30 independent units, one plan approval, then one background worktree subagent per unit that implements, runs tests, and publishes its change), agent teams (experimental: a shared task list coordinated by a lead across teammate sessions), and Projects (public beta on Pro/Max: one ongoing conversation that starts parallel cloud threads under shared instructions, keeps going with the machine off, and shows in an Overview pane which threads are ready for review or waiting on the user) - [Commands, `/batch`](https://code.claude.com/docs/en/commands), [Skills, bundled skills](https://code.claude.com/docs/en/skills), [Agent teams](https://code.claude.com/docs/en/agent-teams), [Run agents in parallel](https://code.claude.com/docs/en/agents), [Claude Projects](https://code.claude.com/docs/en/claude-projects), [Interactive mode, "Task list"](https://code.claude.com/docs/en/interactive-mode) | `/batch`'s one-approval-then-run shape is the closest native analog to a batch's single sign-off, but its plan and state live in the session, with no durable, GitHub-linked contract, decision log, or parked-questions record. Agent teams' task list directory persists locally across a session resume; in-process teammates themselves are not restored, so the lead has to respawn them, but the tasks they were working from are still there. Projects tracks a stream of work over days or weeks and keeps going with the machine off, but its record lives at claude.ai/code, not a GitHub issue, and depends on a beta rollout the account may not have reached yet; `CLAUDE_CODE_TASK_LIST_ID` shares a task list across sessions without making it GitHub-durable, and, like the task list itself, only fills in when the session has task-tracking tools, which this team's models don't get by default (off unless opted in, for example with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`). | keep | Keep: `/batch` and Projects cover the run's sign-off and status view, not its record; no cited native page writes a contract, decision log, or parked question to a GitHub issue beside the PRs, where any host can resume from it. |
| Architect (`SUB_PLAN`, `SPLIT_PROPOSAL`, `ARBITRATION`) | `.claude/agents/architect.md` | Plan mode (same-session pause-for-approval), plus two narrower native pieces: the `opusplan` model setting (Opus for plan-mode reasoning, Sonnet for execution) and the built-in read-only Plan subagent (research agent for plan mode; Write and Edit denied) - [Common workflows, "Plan before editing"](https://code.claude.com/docs/en/common-workflows), [Model config, "`opusplan` model setting"](https://code.claude.com/docs/en/model-config), [Sub-agents, built-in subagents](https://code.claude.com/docs/en/sub-agents) | `opusplan` and the Plan subagent already give a same-session, higher-tier, read-only research pass before an edit. Neither is a distinct agent that arbitrates between two other agents' disagreement, and neither carries size-label governance tied to a GitHub issue; `opusplan` only changes which model plans and which executes within one session, it doesn't add a second seat. | keep | Once `opusplan` and the Plan subagent are counted, the read-only higher-tier research gap narrows to configuration. What's left for architect, cross-agent arbitration and issue-linked size governance, has no native equivalent. |
| Lean track (skip pipeline stages by issue size and diff path) | `.claude/skills/tm-kickoff/SKILL.md`, "Pipeline tracks" | Partial: two settings, neither about skipping pipeline stages by issue size or diff path - ultracode (`/effort ultracode`) decides per task whether to run a workflow at all, and a size guideline (`workflowSizeGuideline`, or `/config`) advises how many agents one workflow should aim for - [Dynamic workflows, "Let Claude decide with ultracode"](https://code.claude.com/docs/en/workflows), [Dynamic workflows, "Set a size guideline"](https://code.claude.com/docs/en/workflows) | Neither skips a stage of a multi-stage pipeline based on a GitHub issue's own size label or its diff's touched paths; ultracode decides whether to run a workflow at all, not which stages to skip within one, and the size guideline only advises an agent count. | keep | No native concept of skipping stages of a multi-stage pipeline based on a GitHub issue's size label and its diff's touched paths. |
| Plan-status block (done/current/remaining line printed before each dispatch) | `.claude/team-guide.md`, "Plan-status block before dispatch" | Partial: the native task list (pending, in progress, complete states, toggled with Ctrl+T), on by default only on older models and otherwise off unless opted in, for example with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, and the `/workflows` progress view (per-phase agent counts, token totals, elapsed time) - [Interactive mode, "Task list"](https://code.claude.com/docs/en/interactive-mode), [Dynamic workflows, "Watch the run"](https://code.claude.com/docs/en/workflows) | Both the native task list and the `/workflows` progress view show what's running now. Neither prints a done/current/remaining block annotated with a fix-round number before a new dispatch, and neither is scoped to a GitHub issue's own pipeline stages. The block only ever covers the lead's own dispatches outside workflow scripts; `team-guide.md` already excludes dispatches inside a workflow script from the block, on the reasoning that the workflow progress view already covers them. | keep | Keep because no cited native view prints a done/current/remaining status annotated with a fix-round number before a new dispatch. |
| Parking (`needs-human` label: question, blocker, or exhausted fix loop) | `.claude/team-guide.md`, "Labels" | Partial: agent view's "needs input" state (a dedicated top section with the exact question and a footer count of agents waiting on you), and Projects' "Waiting on you" group in its Overview pane (threads that need a reply or approval, or that failed) - [Agent view](https://code.claude.com/docs/en/agent-view), [Claude Projects](https://code.claude.com/docs/en/claude-projects) | Agent view's "needs input" covers a pending question, permission decision, or prompt only the user can answer; an unattended session stays listed there whether its process is running or has exited, but nothing persists past that account's own sessions. Projects' "Waiting on you" persists across days and devices, but it's scoped to that project's own cloud threads, not a repo-wide GitHub label, and depends on the Projects beta reaching the account. Neither has an equivalent for a blocker found with no pending question, or an exhausted fix-round cap, and neither is a persisted GitHub label another session, on another host, can pick up hours or days later. | keep | Keep because the label persists as a repo-wide GitHub artifact across sessions, machines, and hosts, which neither account-scoped native view does. |
| Shared dependency environment (once-per-run read-only build passed to several seats) | `.claude/skills/tm-kickoff/SKILL.md`, "Dependency environment (once per run)" | Partial: a `.worktreeinclude` file (copies gitignored files into every new worktree automatically) and a `WorktreeCreate` hook (replaces worktree creation entirely, so it can install dependencies itself) - [Worktrees, "Copy gitignored files into worktrees"](https://code.claude.com/docs/en/worktrees), [Worktrees, "Non-git version control"](https://code.claude.com/docs/en/worktrees) | Both act per worktree at creation time. `.worktreeinclude` can copy an already-built dependency directory (for example `node_modules`) into every new worktree, so a seat need not install its own there if that directory is kept current outside Claude Code, but it still copies the files anew into each worktree rather than pointing every seat at one shared, read-only path built once for the run. | keep | Native gives a per-worktree copy-or-hook mechanism, not a single shared, read-only build reused across a run's seats. |
| Fix-round caps (capped, issue-scoped fix rounds; a "lead-verified" low-risk round) | `.claude/skills/tm-kickoff/SKILL.md`, "Cap: 3 fix rounds per stage" | Partial: the workflows pattern "keep fixing until a check passes" stops itself after a script-defined stall condition, such as two rounds in a row making no progress - [Dynamic workflows, "Keep fixing until a check passes"](https://code.claude.com/docs/en/workflows) | The workflows pattern caps by lack of progress within one script's run, not by a fixed round count, and it isn't scoped to a GitHub issue or split into a tester counter and a reviewer counter. It has no equivalent for a lead-verified low-risk fix round. | keep | Keep because no cited native mechanism ties a round cap to a GitHub issue, splits it per stage, or adds a lead-verified low-risk round. |

## Method and limits

Checked on 2026-09-28 against the current published docs at
`code.claude.com/docs/en/*`, fetched live for this audit:
[overview](https://code.claude.com/docs/en/overview),
[sub-agents](https://code.claude.com/docs/en/sub-agents),
[common-workflows](https://code.claude.com/docs/en/common-workflows),
[hooks](https://code.claude.com/docs/en/hooks),
[worktrees](https://code.claude.com/docs/en/worktrees),
[code-review](https://code.claude.com/docs/en/code-review),
[ultrareview](https://code.claude.com/docs/en/ultrareview),
[skills](https://code.claude.com/docs/en/skills),
[headless](https://code.claude.com/docs/en/headless),
[agent-teams](https://code.claude.com/docs/en/agent-teams),
[costs](https://code.claude.com/docs/en/costs),
[workflows](https://code.claude.com/docs/en/workflows),
[agents ("Run agents in parallel")](https://code.claude.com/docs/en/agents),
[agent-view](https://code.claude.com/docs/en/agent-view),
[commands](https://code.claude.com/docs/en/commands),
[model-config](https://code.claude.com/docs/en/model-config),
[interactive-mode](https://code.claude.com/docs/en/interactive-mode),
[claude-projects](https://code.claude.com/docs/en/claude-projects), and
[plugins/overview](https://code.claude.com/docs/en/plugins/overview).
Every native-equivalent claim in the table above is backed by one of
these pages, fetched directly for this audit; nothing is asserted from
training-data memory.

On the orchestrai side, each row is checked against the actual file it
names: `.claude/agents/*.md` frontmatter, `.claude/adapters/*.json`,
`.claude/workflows/tm-*.js`, `.claude/workflows/__tests__/effort-policy.test.mjs`,
`.claude/skills/tm-kickoff/SKILL.md`, `.claude/skills/tm-kickoff/token-report.mjs`,
`.claude/skills/tm-advisor/SKILL.md`, and `.claude/team-guide.md`, plus the
prior measurement `docs/reviews/2026-07-13-ab-plan-status-parser.md`.

Limits worth naming plainly:

- Claude Code's docs describe the product as of the fetch date above; both
  the product and this repo's machinery change. A row marked "keep" today
  can become "thin" after the next Claude Code release, and vice versa.
- Several native features cited here are marked experimental
  (agent teams), "research preview" (GitHub Code Review, ultrareview), or
  "public beta" (Projects) in their own docs. Their maturity, not just
  their existence, is part of each verdict.
- This audit compares documented behavior, not measured behavior. It does
  not re-run the a/b test; it cites the prior report's result as evidence,
  not as something re-verified here, and repeats that report's own
  hedge ("illustrative, not conclusive") rather than treating a single
  paired run as settled.
- "No documented native equivalent found" means the checked pages above
  did not describe one. It does not rule out an undocumented or
  newly-shipped feature this audit missed.

The table splits several rows into a native-primitive half and a
repo-specific half: role-agent frontmatter syntax against tier pinning,
and the workflow runtime against the `tm-` scripts built on top of it.
This repo has used native subagent frontmatter and the native workflow
runtime since it first adopted each; neither was a gap it filled itself
(see the bottom line above). What has newly caught up is the same
narrower set, dated where the table above cites it: automatic worktree
locking, a periodic cleanup sweep, and isolation checks blocking an
edit or a git redirect aimed at the main checkout, plus, since
v2.1.203, a check blocking a command whose working directory resolves
there, and, for part of the batch jobs, one-approval unattended
execution and a cross-session progress view. What's left as this
repo's own value splits the same way as the bottom line above: the
pin layer, the separate tester and architect seats, and process state
that lives on GitHub (sizing, the lean track, parking, fix-round caps,
the per-role token report, and a batch issue that any host reads from
the same place as the PRs and the merge gate it tracks) or only in the
run itself (the plan-status block for the lead's own dispatches
outside workflow scripts, and a shared dependency environment, a
per-run build on the lead's machine, deleted when the run ends).
