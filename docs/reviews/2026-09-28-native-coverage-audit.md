# Native coverage audit: orchestrai vs. Claude Code - 2026-09-28

## Bottom line

Claude Code's native mechanics caught up with a large part of orchestrai's
plumbing since this repo's design was written. Subagent frontmatter now
carries `model`, `effort`, `isolation: worktree`, and `skills` fields
directly, worktrees get automatic locking and a periodic cleanup sweep, and
dynamic workflows are the native runtime this repo's own `tm-` workflows
already execute on: `tm-review-changes.js` and its siblings are
`export const meta` scripts calling `agent()`/`parallel()`/`phase()`, the
same primitive the docs describe, not an architecture merely shaped like it.

Once frontmatter and the workflow runtime are counted as native, what's
left as this repo's own layer splits into two kinds. One is a pin layer on
top of native fields: `tier:` in each agent's frontmatter, resolved to a
concrete model and effort through a swappable adapter table
(`.claude/adapters/claude-code.json`, plus `codex.json` and `hermes.json`
for other hosts), enforced by `effort-policy.test.mjs`. The other is
process state that GitHub, not Claude Code, has to remember: sizing, the
lean track, the plan-status block, parking, fix-round caps, and batch
tracking issues that survive a crashed session. Neither has a full native
equivalent as of this audit, though several pieces now have partial ones
(detailed in the table).

One data point needs a careful reading. `docs/reviews/2026-07-13-ab-plan-status-parser.md`
ran this repo's own `tm-review-changes` workflow, not a third-party
product, as an independent check against both arms of a paired trial. It
caught a shared suffix-parsing flaw that the in-pipeline tester and
reviewer stages missed on both arms, rating it should-fix on the
full-pipeline diff and must-fix on the solo-developer diff. The source
itself calls this "illustrative, not conclusive": one paired run, and part
of the should-fix/must-fix gap is critic-severity variance between the two
passes, not purely a code-quality difference. That is evidence an
independent, dimension-fanned pass catches things the bespoke tester and
reviewer stages miss; it is not evidence that a specific external product
does, since the pass that did the catching here already runs on the native
workflow primitive this audit rates thin below. GitHub Code Review, the
cloud product with a similar fan-out-plus-verify shape, is a separate
thing: a research preview available only on Team and Enterprise plans, at
roughly $15-25 per review billed as usage credits. This team runs on Max
or Pro, where the comparable native options are the local `/code-review`
command (no extra cost) and, for a deeper cloud pass, `/code-review ultra`
(3 free runs per account, then $5-25 each).

## Feature comparison

| Feature | Where it lives | Native equivalent | Remaining gap | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Role-agent frontmatter (model, effort, isolation, skills) | `.claude/agents/architect.md`, `developer.md`, `tester.md`, `reviewer.md`, `fact-checker.md`, `docs-writer.md`, `perf-investigator.md` (frontmatter) | Subagent frontmatter fields `model`, `effort`, `isolation: worktree`, `skills` - [Subagents](https://code.claude.com/docs/en/sub-agents) | The frontmatter mechanism itself is now native, field for field. Only the prompt content (verdict taxonomies, two-pass review order, the TDD-skill preload) is still bespoke. | thin | Native does the frontmatter syntax; this repo's value is the written role contracts, not the pinning fields. |
| Per-seat tier pinning (`tier:` in each agent, resolved through an adapter table, enforced by a policy test) | `.claude/agents/*.md` `tier:` field, `.claude/adapters/claude-code.json` (plus `codex.json`, `hermes.json` for other hosts), `.claude/workflows/__tests__/effort-policy.test.mjs` | none found | n/a | keep | No native mechanism resolves a role to a model and effort through a swappable, host-specific table instead of a hardcoded value, or tests every agent and workflow stage for a missing pin or a forbidden model/effort across hosts. Native frontmatter's `model:` is a direct value with no such indirection. |
| Deterministic worktree isolation and cleanup | `isolation: worktree` on developer/tester/reviewer; "Worktree cleanup (deterministic)" in `.claude/skills/tm-kickoff/SKILL.md` | `isolation: worktree` subagent field plus automatic worktree locking, a periodic cleanup sweep, and origin-safety checks before removal - [Worktrees](https://code.claude.com/docs/en/worktrees) | Native's sweep is age-based (`cleanupPeriodDays`), not synchronous. `/tm-kickoff` needs the worktree gone right after a package ships or parks, not on the next sweep, so the next wave doesn't collide. | thin | Native now supplies the field, the lock, and most of the safety check by itself. Keep only the immediate per-package trigger; drop the manually re-implemented safety logic where it duplicates native's. |
| The `tm-` review/audit workflows as a scripted orchestration layer | `.claude/workflows/tm-review-changes.js`, `tm-review-codebase.js`, `tm-map-codebase.js` | Dynamic workflows: the JS runtime these scripts already execute on - `export const meta`, `agent()`/`pipeline()`/`parallel()`/`phase()`, resumability, a progress view via `/workflows`, and concurrency caps - [Dynamic workflows](https://code.claude.com/docs/en/workflows) | The fan-out-plus-critic architecture is a native runtime capability, not an alternative to one. What's still bespoke: a versioned `SPEC` object mirrored to a JSON spec file and checked by `specs.test.mjs`, per-host renderers (codex, hermes) reading that same spec, a tier-to-model resolution hard-pinned in-script and enforced by `effort-policy.test.mjs` (a native `agent()` call takes whatever model the script author writes, with no checked-in enforcement), and fixed review dimensions instead of Claude drafting a fresh script per run. | thin | The orchestration primitive is native now, and more capable (resumable, capped, prompt-cache staggering, a built-in progress view). The versioned, spec-synced, policy-enforced script on top is a real but modest gap-filler, not a unique capability. |
| Tester stage (independent verification, full check suite, adversarial input) | `.claude/agents/tester.md` | `/code-review` (local, `--fix` applies findings to the working tree) and, at the workflow level, a documented "keep fixing until a check passes" pattern where a script runs a checker and iterates until it's green or stalls - [Code Review](https://code.claude.com/docs/en/code-review), [Dynamic workflows, "Keep fixing until a check passes"](https://code.claude.com/docs/en/workflows) | Both native paths can already run a check and fix in a loop, so "native review products don't execute code" no longer holds. Neither ties that loop to a seat independent from the one that wrote the code, or to a fix-round count scoped to a GitHub issue. | keep | The catching power isn't in running a check; native does that too now. It's in a seat separate from the implementer, reporting its own PASS/FAIL, with a capped fix-round count (3 per stage, `.claude/skills/tm-kickoff/SKILL.md`) tied to the issue, which neither native path provides alone. |
| Reviewer stage (spec-compliance pass, then quality pass) | `.claude/agents/reviewer.md` | Locally, `/code-review` (correctness plus reuse/simplification/efficiency cleanups, no extra cost); at higher assurance and cost, GitHub Code Review (research preview, Team/Enterprise only, ~$15-25/review in usage credits) or `/code-review ultra` (3 free cloud runs per account on Pro/Max, then $5-25/review) - [Code Review](https://code.claude.com/docs/en/code-review), [Ultrareview pricing](https://code.claude.com/docs/en/ultrareview) | The quality pass (correctness, simplicity, style) overlaps with what the free local `/code-review` already does, and, at the paid cloud tier, with continuous tuning from user reactions this repo's static prompt doesn't get. The spec-compliance pass (matching a diff against a specific issue's acceptance criteria) has no native equivalent; native reads `CLAUDE.md`/`REVIEW.md`, not a linked issue. | thin | `docs/reviews/2026-07-13-ab-plan-status-parser.md` found the in-pipeline tester-plus-reviewer missed a flaw that only this repo's own independent `tm-review-changes` pass caught, on both arms (illustrative, not conclusive, per that report). That is a concrete reason to doubt the bespoke quality pass adds catching power the free local `/code-review` doesn't already offer; it is not a reason to lean on the paid GitHub Code Review product, which this Max/Pro team would have to newly pay for. |
| Token/cost report per role and model, posted to the issue | `.claude/skills/tm-kickoff/token-report.mjs` | `/usage` (per-model breakdown, attribution percentages by skill/subagent/plugin/MCP server) and `--output-format json`'s `total_cost_usd` - [Manage costs](https://code.claude.com/docs/en/costs) | Native's attribution is a live, in-session percentage view; it doesn't reconstruct a dollar table from saved transcripts after the fact, and it doesn't post a persisted markdown artifact to a GitHub issue. | thin | Most of the underlying need (see what a run cost, per model, roughly per role) is now answerable with `/usage` alone. The scripted, postable artifact is a real but narrow gap-filler for a workflow built around GitHub-issue state rather than an interactive session. |
| Batch tracking issue (contract, decision log, parked questions, final report) | `.claude/skills/tm-advisor/SKILL.md` | Three partial analogs: `/batch` (bundled skill: decomposes work into 5-30 independent units, one plan approval, then one background worktree subagent per unit that implements, runs tests, and publishes its change), agent teams (experimental: a shared task list coordinated by a lead across teammate sessions), and Projects (public beta on Pro/Max: one ongoing conversation that starts parallel threads under shared instructions and shows which ones need you) - [Commands, `/batch`](https://code.claude.com/docs/en/commands), [Skills, bundled skills](https://code.claude.com/docs/en/skills), [Agent teams](https://code.claude.com/docs/en/agent-teams), [Run agents in parallel](https://code.claude.com/docs/en/agents) | `/batch`'s one-approval-then-run shape is the closest native analog to a batch's single sign-off, but its state lives in the session, with no durable, GitHub-linked contract, decision log, or parked-questions record. Agent teams' task list directory persists locally across a session resume; the documented limitation is narrower than "state doesn't survive resume": in-process teammates themselves aren't restored, so the lead has to respawn them, but the task list they were working from is still there. Projects tracks work over days but its record lives at claude.ai/code, not a GitHub issue, and `CLAUDE_CODE_TASK_LIST_ID` shares a task list across sessions without making it GitHub-durable. | keep | None of the three gives a plain GitHub issue's durability: readable, resumable, and mergeable from any session or machine, indefinitely. A batch issue survives any crash or account change; none of the native analogs above claim that. |
| Architect (`SUB_PLAN`, `SPLIT_PROPOSAL`, `ARBITRATION`) | `.claude/agents/architect.md` | Plan mode (same-session pause-for-approval), plus two narrower native pieces: the `opusplan` model setting (Opus for plan-mode reasoning, Sonnet for execution) and the built-in read-only Plan subagent (research agent for plan mode; Write and Edit denied) - [Common workflows, "Plan before editing"](https://code.claude.com/docs/en/common-workflows), [Model config, "`opusplan` model setting"](https://code.claude.com/docs/en/model-config), [Sub-agents, built-in subagents](https://code.claude.com/docs/en/sub-agents) | `opusplan` and the Plan subagent already give a same-session, higher-tier, read-only research pass before an edit, which narrows what "no separate read-only seat" used to mean. Neither is a distinct agent that arbitrates between two other agents' disagreement, and neither carries size-label governance tied to a GitHub issue; `opusplan` only changes which model plans and which executes within one session, it doesn't add a second seat. | keep | Once `opusplan` and the Plan subagent are counted, the read-only higher-tier research gap narrows to configuration. What's left for architect, cross-agent arbitration and issue-linked size governance, has no native equivalent. |
| Lean track (skip pipeline stages by issue size) | `.claude/skills/tm-kickoff/SKILL.md`, "Pipeline tracks" | none found | n/a | keep | No native concept of skipping stages of a multi-stage pipeline based on a GitHub issue's size label. |
| Plan-status block (done/current/remaining line printed before each dispatch) | `.claude/team-guide.md`, "Plan-status block before dispatch" | Partial: the native task list (pending, in progress, complete states, toggled with Ctrl+T) and the `/workflows` progress view (per-phase agent counts, token totals, elapsed time) - [Interactive mode, "Task list"](https://code.claude.com/docs/en/interactive-mode), [Dynamic workflows, "Watch the run"](https://code.claude.com/docs/en/workflows) | Both show what's running now; neither prints a done/current/remaining block annotated with a fix-round number before a new dispatch, and neither is scoped to a GitHub issue's own pipeline stages. `team-guide.md` already treats the `/workflows` view as sufficient for agents spawned inside a workflow script ("the workflow progress tree already covers them"), so the gap is narrower than "none found" for that subset. | thin | For dispatches that happen inside a `tm-` workflow script, the native progress view already covers it, by this repo's own rule. The block still earns its keep for the lead's own ad-hoc dispatches (developer, tester, reviewer, architect), which run outside any workflow script. |
| Parking (`needs-human` label: question, blocker, or exhausted fix loop) | `.claude/team-guide.md`, "Labels" | Partial: agent view's "needs input" state, listed in a dedicated top section with the exact question and a footer count of agents waiting on you - [Agent view](https://code.claude.com/docs/en/agent-view) | Native's "needs input" covers only the live case of a pending question, permission decision, or prompt only you can answer. It has no equivalent for a blocker found with no pending question, or an exhausted fix-round cap, and it isn't a persisted GitHub label another session can pick up hours or days later. | keep | The label survives across sessions and machines and covers cases native's live-session indicator doesn't (a blocker with no question, an exhausted fix loop). |
| Shared dependency environment (once-per-run read-only build passed to several seats) | `.claude/skills/tm-kickoff/SKILL.md`, "Dependency environment (once per run)" | Partial: a `.worktreeinclude` file (copies gitignored files into every new worktree automatically) and a `WorktreeCreate` hook (replaces worktree creation entirely, so it can install dependencies itself) - [Worktrees, "Copy gitignored files into worktrees"](https://code.claude.com/docs/en/worktrees), [Worktrees, "Non-git version control"](https://code.claude.com/docs/en/worktrees) | Both act per worktree at creation time. Neither builds one dependency environment once and hands its path to several seats read-only for a run, which is what avoids each seat installing its own. | keep | Native gives a per-worktree copy-or-hook mechanism, not a single shared, read-only build reused across a run's seats. |
| Fix-round caps (capped, issue-scoped fix rounds; a "lead-verified" low-risk round) | `.claude/skills/tm-kickoff/SKILL.md`, "Cap: 3 fix rounds per stage" | none found | n/a | keep | No native concept of a capped, issue-scoped fix-round counter or a lead-verified low-risk fix round. |

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
[interactive-mode](https://code.claude.com/docs/en/interactive-mode), and
[plugins/overview](https://code.claude.com/docs/en/plugins/overview).
Every native-equivalent claim in the table above is backed by one of
these pages, fetched directly for this round rather than taken from an
earlier description of them; nothing is asserted from training-data memory.

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

Compared with the first pass, more rows now split into a native-primitive
half and a repo-specific half (role-agent frontmatter vs. tier pinning; the
workflow runtime vs. the `tm-` scripts on top of it; the lean track, the
plan-status block, parking, the dependency environment, and fix-round caps,
previously one combined row). Of those splits, the plan-status block moves
from a blanket "keep" to "thin" for the subset of dispatches that already
happen inside a `tm-` workflow script, while a new "keep" row (tier
pinning) appears alongside it. The overall shape holds: native has closed
the primitive-level gaps (frontmatter fields, the fan-out-plus-critic
runtime, checked-and-fixed loops, a same-session higher-tier planning
pass), and what's left as this repo's own value is consistently the
GitHub-durable, issue-scoped, cross-host process layer wrapped around those
primitives, not the primitives themselves.
