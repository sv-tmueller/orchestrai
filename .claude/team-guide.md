# Team guide

Generic process guidance for the orchestrator team. Project specifics live in each repo's CLAUDE.md.

## Workflow defaults

Standing preferences for this project:

- Effort: high session default. It governs only the lead; every agent seat
  pins its own effort (see Model policy).
- Permission mode: Auto (acceptEdits) during development (user-controlled;
  mode reference: docs/team-guide-rationale.md).
- Superpowers: use relevant skills proactively (brainstorming, writing-plans,
  test-driven-development, subagent-driven-development, executing-plans,
  verification-before-completion).
- Parallel work: fan out subagents for independent research or implementation
  streams. Default to parallel over serial.
- Session hygiene: compact, `/clear` or restart before lead-session context
  reaches the hundreds of thousands of tokens, and prefer fresh short-lived
  dispatches per issue. Measured baseline: docs/team-guide-rationale.md.

## Agent team

The light flow: a developer per issue, then a reviewer only for bigger or
risky work. The flow, the review gate, the merge gate and the resume rules
live once, in `docs/architecture/light-flow.md`; the lead routes every
handoff, and GitHub holds the state that makes a dropped session resumable.
Diagrams and rationale: `docs/team-architecture.md`.

- `developer` - one issue end to end in an isolated worktree.
- `reviewer` - spec pass then quality pass, read-only. Runs for `size:M` or
  larger, for a diff on a risky path, or after `DONE_WITH_CONCERNS`.
- `architect` - advisory, read-only, on demand only: splits an `L` issue,
  settles a developer and reviewer dispute. It is not a pipeline stage.
- `fact-checker` - audits claims in a report or PR description against
  reproducible evidence, read-only (verdict taxonomy:
  `.claude/agents/fact-checker.md`). Dispatch when claims matter but carry
  no evidence; a CONTRADICTED claim is never dropped, it goes back to the
  agent that made it.
- `docs-writer` - authors or updates user-facing docs from a gap analysis.
  Dispatch on demand (for example after `tm-map-codebase`) when docs are
  missing or stale.
- `perf-investigator` - measures a baseline and target for a reported
  slowness before anyone touches code. Dispatch only for a package whose job
  is specifically a performance investigation.

The plan is the issue body (`## Approach`); no separate sub-plan is posted.
Refine and size issues first (`/tm-grill-me` stress-tests the plan,
`/tm-advisor` file only turns it into sized issues); mark dependencies with
a literal `Blocked by: #N` line in the body. Then `/tm-kickoff <issues>`
(user-typed only) runs unblocked issues up to 3 at a time to ready PRs. On a
repo set up for it, the lead queues the merge; elsewhere a human merges.

The default branch requires the CI checks plus `orchestrai/review`, and
does not require an up to date branch. Labels: the `size:*` set,
`in-progress` (dispatched; resume, do not restart) and `needs-human`
(parked: question, blocker, or exhausted fix loop). Nothing else.

## Operating model (advisor)

`/tm-advisor` (user-typed only) runs the lead session as the user's advisor: it
refines a raw need into a batch of work packages, gets one sign-off, then
runs the team uninterrupted and reports (mechanics:
`.claude/skills/tm-advisor/SKILL.md`; the flow: `docs/architecture/light-flow.md`).
The rules that matter session-wide:

- A batch is up to 6 independent `size:S`/`size:M` issues, run through the
  kickoff flow 3 at a time. A merge is queued by the lead on a repo set up
  for auto merge, and otherwise stays human; dependent work waits for the
  next batch.
- One sign-off per batch, with two approval outcomes: dispatch (file the
  batch and package issues, then run) or file only (package issues to
  the backlog, no batch issue, no run). Nothing lands on GitHub before it.
- The escalation line is scope. Within the signed-off scope and acceptance
  criteria the advisor decides and logs the decision on the batch issue.
  Scope or acceptance-criteria changes, new dependencies or costs,
  irreversible or outward-facing actions, and conflicts with
  `docs/architecture/` park as `needs-human`.
- Each batch has a tracking issue (title `Batch: <slug>`): the approved
  contract, the decision log, parked questions, the final report. Dropped
  sessions resume from it.

## Model policy

Opus at xhigh in every judgment seat: architect, reviewer, workflow critics.
The lead runs Opus at high. Efficient workers everywhere else. The lever is
where each model runs, not raw effort everywhere. Rationale:
docs/team-guide-rationale.md. The lead-model move:
docs/reviews/2026-09-23-lead-model-comparison.md. Moving the team between Max
and Pro: docs/operations/plan-downgrade-runbook.md.

- Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
  Opus (the `opus` alias, Opus 5.5 as of 2026-09-23) at high effort, the
  same model family as the judgment seats. High moved down from xhigh on
  2026-11-25 (owner decision): it scored 19.67/20 against 20/20 at 0.48x the
  cost on refinement (docs/reviews/2026-09-28-lead-effort-comparison.md); the
  run phase was not measured, and in the light flow it is mostly routing and
  gate checks. Comparable quality to Fable at
  under half the cost per run, at low confidence
  (docs/reviews/2026-09-23-lead-model-comparison.md). Shared blind spot: a
  systematic Opus-class mistake would go uncaught by any seat in the flow
  (report section 8). No lead fallback is prescribed if Opus itself is
  unavailable (report section 9).
- Fable (main-window user choice only): no part of the machinery, this
  policy included, ever pins Fable or switches to it automatically; a lead
  session on Fable is the user's own `/model` choice for that window.
- Judgment seats (architect, reviewer, workflow critics): Opus at xhigh
  effort is the primary model. The per-call fallback is Sonnet at the same
  xhigh effort. A reviewer that hits a usage limit runs once more on Sonnet,
  and a Sonnet-fallback APPROVE ships like an Opus APPROVE: the lead posts
  `orchestrai/review` the same way and queues the merge the same way. The
  critic stage of every `tm-` workflow (`.claude/workflows/`) already retries
  on sonnet automatically when Opus returns nothing. Nothing in the machinery
  falls back to Fable. If judgment quality visibly degrades on real batches,
  log the observation here.
- Cost-based fallback trigger: superseded by the move to Opus. To revisit
  Fable, re-run the comparison first; never switch on availability alone
  (`docs/reviews/2026-09-23-lead-model-comparison.md`, section 7).
- No session-wide `ultracode` under this policy (a prompt keyword or
  `/effort` menu option, not a slash command). Measured trial:
  `docs/reviews/2026-06-30-orchestration-comparison.md`. Keep `/effort` at
  `xhigh` and use the tm- scripts; use `ultracode` only for a one-off heavy
  task with no tm- script.
- Role agents (frontmatter `model:`): `architect`/`reviewer` run `opus`
  (`sonnet` is the documented per-call fallback); `developer`,
  `fact-checker`, `docs-writer`, `perf-investigator` run `sonnet`
  (`fact-checker` stays on Sonnet, not Haiku). Each agent also pins its own
  effort (`sonnet` -> `high`, `opus` -> `xhigh`), independent of the
  session's `/effort` setting. The `sonnet` -> `high` line is a pin rule for
  seats that run sonnet as their primary model; a per-call sonnet fallback
  on a judgment seat is not one of those pins, so it inherits the seat's
  `xhigh` effort instead.
- Effort ceiling: `xhigh`. Nothing runs at `max`. Effort inherits to any seat
  that does not pin it. The effort-policy test in `npm test` fails any agent
  or workflow stage that omits its pin or reintroduces max, and its guard
  describe fails if fable is pinned on any adapter tier, agent or skill
  frontmatter, or workflow stage (issue #380).
- Workflows: pin worker stages to a cheap model at `high` effort and reserve
  the strong model for synthesis or critique, bounded by construction
  (`.claude/workflows/*.js`; docs/superpowers/specs/2026-06-13-review-codebase-design.md).
- Do not set `CLAUDE_CODE_SUBAGENT_MODEL`. Since Claude Code v2.1.251 it is
  a default, not an override: the per-invocation model parameter and the
  agent definition's `model` frontmatter (including `inherit`) both take
  precedence over it. Flattening every subagent onto one model now takes both
  variables, since `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+) is what
  makes Claude Code ignore the frontmatter and the per-call parameter. Every
  agent file here pins `model:`, so the variable alone is a no-op for those
  seats, and a forced seatbelt downgrades the architect and reviewer too.

## How to pick up a task

1. `gh issue list --state open` to see what is available.
2. Pick an unassigned issue with no unresolved blockers. Check its `size:`
   label; if it is unsized, size it first, and if it is `L` or `XL`,
   decompose it before starting.
3. Read the issue's `## Approach`. A hand-filed issue without one gets a
   short Approach comment first.
4. Create a branch and open a draft PR linking the issue (`Closes #N`).
5. Implement with TDD. If the work turns out bigger than its label, re-label
   and split it into sub-issues before going on.
6. Run the full check suite (typecheck, lint, test, e2e if touched). It must
   pass before requesting review.
7. Mark the PR ready for review.

For a batch of refined, sized issues, `/tm-kickoff` automates this flow per
issue (see "Agent team").

## Repo layout (team)

`.claude/` holds `agents/`, `skills/`, `workflows/`, `adapters/`, and
`settings.json` (full annotated tree: docs/team-guide-rationale.md).

Every skill and workflow built in this repo carries the `tm-` prefix
(`/tm-advisor`, `/tm-kickoff`, `/tm-review-changes`, and so on), marking them
as this project's own commands apart from out-of-the-box and plugin skills.
New project commands follow the same rule: name them `tm-<thing>`.

## What not to do

- Don't improve `.claude/` machinery only in this repo. Change the template
  (sv-tmueller/orchestrai) first, then run `/plugin update` in each config dir
  to pick it up. The config-dir CLAUDE.md imports `process-core.md` and
  `team-guide.md` from the marketplace clone, so both files update
  automatically once the plugin does.
- Don't add a `version` field to `.claude/.claude-plugin/plugin.json` or to
  the plugin entry in `.claude-plugin/marketplace.json`. Without one, Claude
  Code tracks the commit, so every merge to `main` is a new plugin version
  and reaches installed copies on their next update (auto update, or
  `/plugin update`), with no bump. With one, installed copies stay on that
  number until someone changes it.

See `.claude/process-core.md`'s "What not to do" for the branch, merge-gate,
git-hook, and dependency rules.
