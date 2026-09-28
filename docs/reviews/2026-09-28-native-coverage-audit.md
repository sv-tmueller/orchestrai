# Native coverage audit: orchestrai vs. Claude Code - 2026-09-28

## Bottom line

Claude Code's native mechanics caught up with a large part of orchestrai's
plumbing since this repo's design was written. Subagent frontmatter now
carries `model`, `effort`, `isolation: worktree`, and `skills` fields
directly, worktrees get automatic locking and a periodic cleanup sweep, and
"dynamic workflows" give a JavaScript fan-out-plus-critic primitive that is
architecturally the same shape as this repo's `tm-review-changes.js`. Where
orchestrai still earns its keep is the process layer that GitHub, not
Claude Code, has to remember: sizing, the lean track, the plan-status
block, parking, fix-round caps, and batch tracking issues that survive a
crashed session. None of that has a native equivalent as of this audit.
The one uncomfortable data point: the a/b test in
`docs/reviews/2026-07-13-ab-plan-status-parser.md` found that this repo's
own tester-plus-reviewer pipeline missed a real bug that only an
independent, dimension-fanned review caught, on both arms. Native Code
Review's "fleet of specialized agents plus a verification pass" is that
same shape of independent check, continuously tuned by Anthropic on real
usage. That is a real argument for leaning on it rather than assuming the
bespoke pipeline stages add unique catching power.

## Feature comparison

| Feature | Where it lives | Native equivalent | Remaining gap | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| Role-agent pinning (model, effort, isolation, skills) | `.claude/agents/architect.md`, `developer.md`, `tester.md`, `reviewer.md`, `fact-checker.md`, `docs-writer.md`, `perf-investigator.md` (frontmatter) | Subagent frontmatter fields `model`, `effort`, `isolation: worktree`, `skills` - [Subagents](https://code.claude.com/docs/en/sub-agents) | The frontmatter mechanism itself is now native, field for field. Only the prompt content (verdict taxonomies, two-pass review order, the TDD-skill preload) is still bespoke. | thin | Native does the pinning; this repo's value is the written role contracts, not the pinning syntax. |
| Deterministic worktree isolation and cleanup | `isolation: worktree` on developer/tester/reviewer; "Worktree cleanup (deterministic)" in `.claude/skills/tm-kickoff/SKILL.md` | `isolation: worktree` subagent field plus automatic worktree locking, a periodic cleanup sweep, and origin-safety checks before removal - [Worktrees](https://code.claude.com/docs/en/worktrees) | Native's sweep is age-based (`cleanupPeriodDays`), not synchronous. `/tm-kickoff` needs the worktree gone right after a package ships or parks, not on the next sweep, so the next wave doesn't collide. | thin | Native now supplies the field, the lock, and most of the safety check by itself. Keep only the immediate per-package trigger; drop the manually re-implemented safety logic where it duplicates native's. |
| Fixed-fan-out-plus-critic review workflows | `.claude/workflows/tm-review-changes.js`, `tm-review-codebase.js`, `tm-map-codebase.js` | Dynamic workflows: a JS script with `agent()`, `pipeline()`, `parallel()`, `phase()`, per-stage model selection, resumability, a progress view, and concurrency caps - [Dynamic workflows](https://code.claude.com/docs/en/workflows) | Native workflows are ephemeral scripts Claude writes per run unless separately saved as a command; model choice per `agent()` call is whatever the script author puts in, not enforced by a checked-in policy test. This repo's workflows are versioned, spec-synced (`specs.test.mjs`), and hard-pin tier-to-model per `team-guide.md`. | thin | The architecture (worker fan-out, single critic that verifies and merges) is now a native primitive, and a more mature one (resumable, capped, with prompt-cache staggering). The versioned, policy-enforced script is a real but modest gap-filler, not a unique capability. |
| Tester stage (independent verification, full check suite, adversarial input) | `.claude/agents/tester.md` | `/code-review` (local, correctness-focused single pass) and GitHub Code Review (cloud, multi-agent fleet plus a verification pass that checks candidates against actual code behavior) - [Code Review](https://code.claude.com/docs/en/code-review) | Neither native option runs the project's actual check suite or reports an exit code; both are read-only diff review. Neither ties a verdict to a GitHub issue's fix-round counter or a resumable `STATUS`/`VERDICT` contract. | keep | Running `npm test` (or the full stack) and reporting a machine-parseable PASS/FAIL that drives an automated fix loop has no native equivalent; native review products review code, they don't execute it. |
| Reviewer stage (spec-compliance pass, then quality pass) | `.claude/agents/reviewer.md` | Same as above: `/code-review` and GitHub Code Review, which already fan out specialized agents and verify candidates before reporting - [Code Review](https://code.claude.com/docs/en/code-review) | The quality pass (correctness, simplicity, style) overlaps heavily with what native Code Review already does, and does it with continuous tuning from user 👍/👎 feedback that this repo's static prompt doesn't get. The spec-compliance pass (matching a diff against a specific issue's acceptance criteria) has no native equivalent; native reads `CLAUDE.md`/`REVIEW.md`, not a linked issue. | thin | `docs/reviews/2026-07-13-ab-plan-status-parser.md` found the in-pipeline tester-plus-reviewer missed a flaw that only an independent, dimension-fanned pass caught, on both arms - the same shape of check native Code Review already runs. That is a concrete reason to doubt the bespoke quality pass adds catching power beyond what native already offers. |
| Token/cost report per role and model, posted to the issue | `.claude/skills/tm-kickoff/token-report.mjs` | `/usage` (per-model breakdown, attribution percentages by skill/subagent/plugin/MCP server) and `--output-format json`'s `total_cost_usd` - [Manage costs](https://code.claude.com/docs/en/costs) | Native's attribution is a live, in-session percentage view; it doesn't reconstruct a dollar table from saved transcripts after the fact, and it doesn't post a persisted markdown artifact to a GitHub issue. | thin | Most of the underlying need (see what a run cost, per model, roughly per role) is now answerable with `/usage` alone. The scripted, postable artifact is a real but narrow gap-filler for a workflow built around GitHub-issue state rather than an interactive session. |
| Batch tracking issue (contract, decision log, parked questions, final report) | `.claude/skills/tm-advisor/SKILL.md` | Agent teams (experimental): a shared task list coordinated by a lead across teammate sessions - [Agent teams](https://code.claude.com/docs/en/agent-teams) | Agent teams are explicitly experimental, disabled by default, limited to one team per session, and the task list does not survive a session resume for in-process teammates (documented limitation: "No session resumption with in-process teammates"). A batch issue is a plain GitHub issue; it survives any crash indefinitely. | keep | No documented native feature offers durable, cross-session batch state. Agent teams is the closest analog and names its own resumption gap in the docs. |
| Architect (`SUB_PLAN`, `SPLIT_PROPOSAL`, `ARBITRATION`) | `.claude/agents/architect.md` | Plan mode: Claude reads and proposes a plan before editing, with your approval gating the edit - [Common workflows, "Plan before editing"](https://code.claude.com/docs/en/common-workflows) | Plan mode is a same-session, same-model pause-for-approval mechanic. It has no concept of a separate, higher-tier read-only seat, no arbitration between two other agents' disagreement, and no size-label governance tied to a GitHub issue. | keep | Plan mode covers "look before you edit" for one session. It does not cover cross-agent arbitration or a durable, issue-linked size check. |
| Lean track, plan-status block, parking, dependency environment, fix-round caps | `.claude/skills/tm-kickoff/SKILL.md`, `.claude/team-guide.md` | none found | n/a | keep | No native concept of skipping stages by issue size, a human-readable pipeline-status block printed before each dispatch, a `needs-human` parking label, a once-per-run read-only shared dependency build, or a "lead-verified" low-risk fix round. Checked: subagents, common workflows, agent teams, dynamic workflows, hooks, skills, plugins, costs, headless mode. None of those pages describes this. |

## Method and limits

Checked on 2026-09-28 against the current published docs at
`code.claude.com/docs/en/*`, fetched live for this audit:
[overview](https://code.claude.com/docs/en/overview),
[sub-agents](https://code.claude.com/docs/en/sub-agents),
[common-workflows](https://code.claude.com/docs/en/common-workflows),
[hooks](https://code.claude.com/docs/en/hooks),
[worktrees](https://code.claude.com/docs/en/worktrees),
[code-review](https://code.claude.com/docs/en/code-review),
[skills](https://code.claude.com/docs/en/skills),
[headless](https://code.claude.com/docs/en/headless),
[agent-teams](https://code.claude.com/docs/en/agent-teams),
[costs](https://code.claude.com/docs/en/costs),
[workflows](https://code.claude.com/docs/en/workflows), and
[plugins/overview](https://code.claude.com/docs/en/plugins/overview).
Every native-equivalent claim in the table above is backed by one of
these pages; nothing is asserted from training-data memory.

On the orchestrai side, each row is checked against the actual file it
names: `.claude/agents/*.md` frontmatter, `.claude/workflows/tm-*.js`,
`.claude/skills/tm-kickoff/SKILL.md`, `.claude/skills/tm-kickoff/token-report.mjs`,
`.claude/skills/tm-advisor/SKILL.md`, and `.claude/team-guide.md`, plus the
prior measurement `docs/reviews/2026-07-13-ab-plan-status-parser.md`.

Limits worth naming plainly:

- Claude Code's docs describe the product as of the fetch date above; both
  the product and this repo's machinery change. A row marked "keep" today
  can become "thin" after the next Claude Code release, and vice versa.
- Several native features cited here are marked experimental
  (agent teams) or "research preview" (GitHub Code Review) in their own
  docs. Their maturity, not just their existence, is part of each verdict.
- This audit compares documented behavior, not measured behavior. It does
  not re-run the a/b test; it cites the prior report's result as evidence,
  not as something re-verified here.
- "No documented native equivalent found" means the checked pages above
  did not describe one. It does not rule out an undocumented or
  newly-shipped feature this audit missed.
