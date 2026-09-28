# Native coverage audit: orchestrai vs. Claude Code - 2026-09-28

## Bottom line

This repo was built on Claude Code's native mechanics from its own first
commits on them, not catching up to native later: subagent frontmatter has
carried `model`, `effort`, `isolation: worktree`, and `skills` fields since
the agent team's introducing commit, and `tm-review-changes.js` and its
siblings have been `export const meta` scripts calling
`agent()`/`parallel()`/`phase()` since the workflow runtime's own
introducing commit, the same primitive the docs describe, not an
architecture merely shaped like it. What has caught up since, with
evidence of change over time, is narrower: worktrees now get automatic
locking and a periodic cleanup sweep.

Once frontmatter and the workflow runtime are counted as native, what's
left as this repo's own layer splits into two kinds. One is a pin layer on
top of native fields: `tier:` in each agent's frontmatter, resolved to a
concrete model and effort through a swappable adapter table
(`.claude/adapters/claude-code.json`, plus `codex.json` and `hermes.json`
for other hosts), enforced by `effort-policy.test.mjs`. The other is
process state, split by where it lives: on GitHub (sizing, the lean track,
parking, fix-round caps, and a batch tracking issue) or only in the run
itself (the plan-status block, printed in the lead session before each
dispatch, not stored anywhere). `/batch` and Projects are the closest native analogs to a
tm-advisor/tm-kickoff run: `/batch` takes one plan approval and then runs
implementer subagents unattended, and Projects coordinates a stream of
work across days with an Overview pane showing what needs the user.
Neither writes that state to a GitHub issue the way this repo does. The
gap is where the record lives and who can read it: a batch issue sits next
to the PRs it tracks, readable from any GitHub client or another host's
CLI, while `/batch`'s plan lives in the session and Projects' record lives
at claude.ai/code. Neither has a full native equivalent as of this audit,
though several pieces now have partial ones (detailed in the table).

One data point from `docs/reviews/2026-07-13-ab-plan-status-parser.md`
needs a precise reading, beyond the cost-and-catch comparison already
collected in `docs/why-the-team.md`. That report ran this repo's own
`tm-review-changes` workflow, not a third-party product, as an independent
pass against two diffs of the same task: one from the full kickoff
pipeline, with its own tester and reviewer stages, one from a single
developer dispatch with neither. `tm-review-changes` caught a shared
suffix-parsing flaw in both diffs. The pipeline diff's own tester and
reviewer stages missed it; the solo diff had no such stages to miss it in
the first place. That is evidence an independent pass, itself running on
the native workflow primitive this audit rates thin below, catches
something the bespoke tester and reviewer stages, and a lone developer
dispatch, do not, in one paired run. It is not evidence about GitHub Code
Review, the cloud product with a similar fan-out-plus-verify shape: the
a/b never ran it. That product is a research preview available only on
Team and Enterprise plans, at roughly $15-25 per review in usage credits.
This team runs on Max or Pro, where the comparable native options are the
local `/code-review` command (no extra cost, catching power against this
specific flaw untested) and, for a deeper cloud pass, `/code-review ultra`
(3 free runs per account, then $5-25 each).

## Feature comparison

| Feature | Where it lives | Native equivalent | Remaining gap | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Role-agent frontmatter (model, effort, isolation, skills) | `.claude/agents/architect.md`, `developer.md`, `tester.md`, `reviewer.md`, `fact-checker.md`, `docs-writer.md`, `perf-investigator.md` (frontmatter) | Subagent frontmatter fields `model`, `effort`, `isolation: worktree`, `skills` - [Subagents](https://code.claude.com/docs/en/sub-agents) | The frontmatter mechanism itself is native, field for field, and has been since this repo's first agent files. Only the prompt content (verdict taxonomies, two-pass review order, the TDD-skill preload) is still bespoke. | thin | Native does the frontmatter syntax; this repo's value is the written role contracts, not the pinning fields. |
| Per-seat tier pinning (`tier:` in each agent, resolved through an adapter table, enforced by a policy test) | `.claude/agents/*.md` `tier:` field, `.claude/adapters/claude-code.json` (plus `codex.json`, `hermes.json` for other hosts), `.claude/workflows/__tests__/effort-policy.test.mjs` | Partial: model aliases (`opus`, `sonnet`) resolve to a concrete model per provider and are overridable per alias with `ANTHROPIC_DEFAULT_OPUS_MODEL`/`ANTHROPIC_DEFAULT_SONNET_MODEL`, and an organization's `availableModels`/`deniedModels` allowlist applies to the subagent `model` field - [Model config, "Model aliases" and "Environment variables"](https://code.claude.com/docs/en/model-config), [Model config, "Restrict model selection"](https://code.claude.com/docs/en/model-config) | Both are single-host indirections: neither resolves anything across Claude Code, codex, and hermes at once, and Claude Code's own frontmatter `model:` still takes a literal value (`tester.md` reads `model: sonnet`). `effort-policy.test.mjs` checks that value against the adapter table as a consistency check on Claude Code, not a runtime resolution; the adapter table is what lets the same `tier:` render a different model and effort per host. | keep | Model aliases and the allowlist operate inside one host. Keep rests on the adapter table rendering the same `tier:` to a different model and effort per host, and on the test that fails an agent or workflow stage carrying no pin at all, neither of which any native mechanism does. |
| Deterministic worktree isolation and cleanup | `isolation: worktree` on developer/tester/reviewer; "Worktree cleanup (deterministic)" in `.claude/skills/tm-kickoff/SKILL.md` | `isolation: worktree` subagent field plus automatic worktree locking, a periodic cleanup sweep, origin-safety checks before removal, and, since v2.1.203, isolation checks that block an edit, a command whose working directory resolves to the main checkout, or a git redirect aimed at it - [Worktrees, "How Claude Code enforces isolation"](https://code.claude.com/docs/en/worktrees), [Sub-agents, "Write subagent files"](https://code.claude.com/docs/en/sub-agents) | Native's sweep is age-based (`cleanupPeriodDays`), not synchronous. `/tm-kickoff` needs the worktree gone right after a package ships or parks, not on the next sweep, so the next wave doesn't collide. | thin | Native now supplies the field, the lock, most of the safety check, and the command and git-redirect blocks that stop exactly the leak `/tm-kickoff`'s wave-end HEAD repair (`git switch <default>`, SKILL.md) exists to reverse. Keep the immediate per-package trigger; the HEAD-repair step is the thinning target now that native blocks a dispatched agent's command from resolving into the main checkout. |
| The `tm-` review/audit workflows as a scripted orchestration layer | `.claude/workflows/tm-review-changes.js`, `tm-review-codebase.js`, `tm-map-codebase.js` | Dynamic workflows: the JS runtime these scripts already execute on - `export const meta`, `agent()`/`pipeline()`/`parallel()`/`phase()`, resumability, a progress view via `/workflows`, and concurrency caps - [Dynamic workflows](https://code.claude.com/docs/en/workflows) | The fan-out-plus-critic architecture is a native runtime capability, not an alternative to one. What's still bespoke: a versioned `SPEC` object mirrored to a JSON spec file and checked by `specs.test.mjs`, per-host renderers (codex, hermes) reading that same spec, a tier-to-model resolution hard-pinned in-script and enforced by `effort-policy.test.mjs` (a native `agent()` call takes whatever model the script author writes, with no checked-in enforcement), and fixed review dimensions instead of Claude drafting a fresh script per run. | thin | The orchestration primitive is native now, and more capable (resumable, capped, prompt-cache staggering, a built-in progress view). The versioned, spec-synced, policy-enforced script on top is a real but modest gap-filler, not a unique capability. |
| Tester stage (independent verification, full check suite, adversarial input) | `.claude/agents/tester.md` | Three partial analogs: local `/code-review --fix` (finds issues and applies them to the working tree in one pass, without running a check itself), the workflows pattern "keep fixing until a check passes" (a script runs a checker and iterates until it's green or two rounds in a row make no progress), and `/batch` (each subagent implements its unit and runs its own tests before publishing) - [Code Review](https://code.claude.com/docs/en/code-review), [Dynamic workflows, "Keep fixing until a check passes"](https://code.claude.com/docs/en/workflows), [Commands, `/batch`](https://code.claude.com/docs/en/commands) | The workflows pattern already runs a check and loops a fix until it passes or stalls, and `/batch` already has the implementer run its own tests. Neither ties either behavior to a seat independent from the one that wrote the code, or to a fix-round count scoped to a GitHub issue. | keep | The catching power isn't in running a check or looping a fix; native does both now, one of them (`/batch`) through the implementer testing itself. It's in a seat separate from the implementer, reporting its own PASS/FAIL, with a capped fix-round count (3 per stage, `.claude/skills/tm-kickoff/SKILL.md`) tied to the issue, which no native path provides. |
| Reviewer stage (spec-compliance pass, then quality pass) | `.claude/agents/reviewer.md` | Locally, `/code-review` (correctness plus reuse/simplification/efficiency cleanups, no extra cost); at higher assurance and cost, GitHub Code Review (research preview, Team/Enterprise only, ~$15-25/review in usage credits) or `/code-review ultra` (3 free cloud runs per account on Pro/Max, then $5-25/review) - [Code Review](https://code.claude.com/docs/en/code-review), [Ultrareview pricing](https://code.claude.com/docs/en/ultrareview) | The quality pass (correctness, simplicity, style) documents the same scope as the free local `/code-review`. The spec-compliance pass (matching a diff against a specific issue's acceptance criteria) has no native equivalent: the local `/code-review` reads a repo's `CLAUDE.md`; only the cloud GitHub Code Review also reads a repo's `REVIEW.md`. Neither reads a linked GitHub issue's acceptance criteria. | thin | The free local `/code-review` documents the same scope this repo's quality pass covers, so that half overlaps on paper. Its catching power against a flaw this repo's own stages miss is untested: the only measured comparison (`docs/reviews/2026-07-13-ab-plan-status-parser.md`) ran `tm-review-changes`, not `/code-review`, as the independent pass. |
| Token/cost report per role and model, posted to the issue | `.claude/skills/tm-kickoff/token-report.mjs` | `/usage` (attribution by skill, subagent, plugin, and MCP server, toggled between the last 24 hours and the last 7 days) - [Manage costs](https://code.claude.com/docs/en/costs), and `--output-format json`'s `total_cost_usd` plus a per-model cost breakdown - [Headless mode](https://code.claude.com/docs/en/headless) | Native's attribution is a percentage view computed from local session history on this machine over a fixed 24-hour or 7-day window, not a per-role dollar table for one run scoped to a GitHub issue; `total_cost_usd` gives one run's total but no per-role split. | thin | Most of the underlying need (see what a run cost, per model, roughly per role) is now answerable between `/usage` and `total_cost_usd`. The scripted, postable per-role dollar table for one run's window is a real but narrow gap-filler for a workflow built around GitHub-issue state rather than an interactive session. |
| Batch tracking issue (contract, decision log, parked questions, final report) | `.claude/skills/tm-advisor/SKILL.md` | Three partial analogs: `/batch` (bundled skill: decomposes work into 5-30 independent units, one plan approval, then one background worktree subagent per unit that implements, runs tests, and publishes its change), agent teams (experimental: a shared task list coordinated by a lead across teammate sessions), and Projects (public beta on Pro/Max: one ongoing conversation that starts parallel cloud threads under shared instructions, keeps going with the machine off, and shows in an Overview pane which threads are ready for review or waiting on the user) - [Commands, `/batch`](https://code.claude.com/docs/en/commands), [Skills, bundled skills](https://code.claude.com/docs/en/skills), [Agent teams](https://code.claude.com/docs/en/agent-teams), [Run agents in parallel](https://code.claude.com/docs/en/agents), [Claude Projects](https://code.claude.com/docs/en/claude-projects), [Interactive mode, "Task list"](https://code.claude.com/docs/en/interactive-mode) | `/batch`'s one-approval-then-run shape is the closest native analog to a batch's single sign-off, but its plan and state live in the session, with no durable, GitHub-linked contract, decision log, or parked-questions record. Agent teams' task list directory persists locally across a session resume; in-process teammates themselves are not restored, so the lead has to respawn them, but the tasks they were working from are still there. Projects tracks a stream of work over days or weeks and keeps going with the machine off, but its record lives at claude.ai/code, not a GitHub issue, and depends on a beta rollout the account may not have reached yet; `CLAUDE_CODE_TASK_LIST_ID` shares a task list across sessions without making it GitHub-durable. | thin | `/batch` and Projects between them cover most of the day-to-day job: unattended execution after one sign-off, and a pane showing what's ready or waiting. Neither gives a GitHub-resident record: a batch issue sits on GitHub next to the PRs it tracks and the human merge gate that reviews them, and any host reading that repo (Claude Code, codex, hermes) reads the same issue. `/batch`'s state lives in one session; Projects' record lives at claude.ai/code and depends on a rollout the account may not have. |
| Architect (`SUB_PLAN`, `SPLIT_PROPOSAL`, `ARBITRATION`) | `.claude/agents/architect.md` | Plan mode (same-session pause-for-approval), plus two narrower native pieces: the `opusplan` model setting (Opus for plan-mode reasoning, Sonnet for execution) and the built-in read-only Plan subagent (research agent for plan mode; Write and Edit denied) - [Common workflows, "Plan before editing"](https://code.claude.com/docs/en/common-workflows), [Model config, "`opusplan` model setting"](https://code.claude.com/docs/en/model-config), [Sub-agents, built-in subagents](https://code.claude.com/docs/en/sub-agents) | `opusplan` and the Plan subagent already give a same-session, higher-tier, read-only research pass before an edit. Neither is a distinct agent that arbitrates between two other agents' disagreement, and neither carries size-label governance tied to a GitHub issue; `opusplan` only changes which model plans and which executes within one session, it doesn't add a second seat. | keep | Once `opusplan` and the Plan subagent are counted, the read-only higher-tier research gap narrows to configuration. What's left for architect, cross-agent arbitration and issue-linked size governance, has no native equivalent. |
| Lean track (skip pipeline stages by issue size and diff path) | `.claude/skills/tm-kickoff/SKILL.md`, "Pipeline tracks" | none found | n/a | keep | No native concept of skipping stages of a multi-stage pipeline based on a GitHub issue's size label and its diff's touched paths. |
| Plan-status block (done/current/remaining line printed before each dispatch) | `.claude/team-guide.md`, "Plan-status block before dispatch" | Partial: the native task list (pending, in progress, complete states, toggled with Ctrl+T) and the `/workflows` progress view (per-phase agent counts, token totals, elapsed time) - [Interactive mode, "Task list"](https://code.claude.com/docs/en/interactive-mode), [Dynamic workflows, "Watch the run"](https://code.claude.com/docs/en/workflows) | Both the native task list and the `/workflows` progress view show what's running now. Neither prints a done/current/remaining block annotated with a fix-round number before a new dispatch, and neither is scoped to a GitHub issue's own pipeline stages. The block only ever covers the lead's own ad-hoc dispatches (developer, tester, reviewer, architect run outside a `tm-` workflow script); `team-guide.md` already excludes dispatches inside a workflow script from the block, on the reasoning that the workflow progress view already covers them. | keep | Nothing here is actually thinned: the one case where a native progress view already existed, agents spawned inside a workflow script, was already outside the block's scope by this repo's own rule. For the case the block does cover, the lead's own ad-hoc dispatches, no native mechanism prints a done/current/remaining status annotated with a fix round before a new one starts. |
| Parking (`needs-human` label: question, blocker, or exhausted fix loop) | `.claude/team-guide.md`, "Labels" | Partial: agent view's "needs input" state (a dedicated top section with the exact question and a footer count of agents waiting on you), and Projects' "Waiting on you" group in its Overview pane (threads that need a reply or approval, or that failed) - [Agent view](https://code.claude.com/docs/en/agent-view), [Claude Projects](https://code.claude.com/docs/en/claude-projects) | Agent view's "needs input" covers a pending question, permission decision, or prompt only the user can answer; an unattended session stays listed there whether its process is running or has exited, but nothing persists past that account's own sessions. Projects' "Waiting on you" persists across days and devices, but it's scoped to that project's own cloud threads, not a repo-wide GitHub label, and depends on the Projects beta reaching the account. Neither has an equivalent for a blocker found with no pending question, or an exhausted fix-round cap, and neither is a persisted GitHub label another session, on another host, can pick up hours or days later. | keep | The label survives across sessions, machines, and hosts, and covers cases neither native partial does: a blocker with no question, an exhausted fix loop. Agent view's indicator lasts only as long as the session; Projects' lasts longer but stays inside one project's own threads on one account. |
| Shared dependency environment (once-per-run read-only build passed to several seats) | `.claude/skills/tm-kickoff/SKILL.md`, "Dependency environment (once per run)" | Partial: a `.worktreeinclude` file (copies gitignored files into every new worktree automatically) and a `WorktreeCreate` hook (replaces worktree creation entirely, so it can install dependencies itself) - [Worktrees, "Copy gitignored files into worktrees"](https://code.claude.com/docs/en/worktrees), [Worktrees, "Non-git version control"](https://code.claude.com/docs/en/worktrees) | Both act per worktree at creation time. Neither builds one dependency environment once and hands its path to several seats read-only for a run, which is what avoids each seat installing its own. | keep | Native gives a per-worktree copy-or-hook mechanism, not a single shared, read-only build reused across a run's seats. |
| Fix-round caps (capped, issue-scoped fix rounds; a "lead-verified" low-risk round) | `.claude/skills/tm-kickoff/SKILL.md`, "Cap: 3 fix rounds per stage" | Partial: the workflows pattern "keep fixing until a check passes" stops itself after a script-defined stall condition, such as two rounds in a row making no progress - [Dynamic workflows, "Keep fixing until a check passes"](https://code.claude.com/docs/en/workflows) | The workflows pattern caps by lack of progress within one script's run, not by a fixed round count, and it isn't scoped to a GitHub issue or split into a tester counter and a reviewer counter. It has no equivalent for a lead-verified low-risk fix round. | keep | The stall condition is real but different: a workflow script stops itself on stalled progress; this repo caps each stage at a fixed 3 rounds, counts the tester and reviewer separately, ties the count to the issue, and adds a lead-verified low-risk round. No native mechanism does the issue-scoped counting or the lead-verified round. |

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
Frontmatter fields and the fan-out-plus-critic runtime were never gaps
this repo filled itself; the repo has run on both since its own first
commits on them (see the bottom line above). What has newly caught up,
with evidence of change over time, is narrower: automatic worktree
locking and the isolation checks blocking edits and git redirects aimed
at the main checkout, and, for part of the batch jobs, one-approval
unattended execution and a cross-session progress view. What's left as
this repo's own value splits the same way as the bottom line above:
process state that lives on GitHub (sizing, the lean track, parking,
fix-round caps, and a batch issue that any host reads from the same
place as the PRs and the merge gate it tracks), and process state that
lives only in the run itself (the plan-status block for the lead's own
ad-hoc dispatches, and a shared dependency environment, a per-run build
on the lead's machine, deleted when the run ends).
