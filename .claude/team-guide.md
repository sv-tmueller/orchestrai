# Team guide

Generic process guidance for the orchestrator team. Project specifics live in each repo's CLAUDE.md.

## Workflow defaults

Standing preferences for this project:

- Effort: xhigh session default. It governs only the lead; every agent seat
  pins its own effort (see Model policy).
- Permission mode: Auto (acceptEdits) during development (user-controlled;
  mode reference: docs/team-guide-rationale.md).
- Superpowers: use relevant skills proactively (brainstorming, writing-plans,
  test-driven-development, subagent-driven-development, executing-plans,
  verification-before-completion).
- Parallel work: fan out subagents for independent research or implementation
  streams. Default to parallel over serial.
- Session hygiene: bound lead-session context growth before it reaches the
  hundreds of thousands of tokens (compact, `/clear`, or restart), and prefer
  fresh short-lived dispatches per issue over one long session across many
  tasks. Measured baseline and the compact-or-clear estimate:
  docs/team-guide-rationale.md.

## Agent team

The template ships the role agents in `.claude/agents/` and a set of skills;
the lead session routes every handoff and GitHub holds the state that makes
a dropped session resumable (flat-star model, diagram, and per-package
pipeline: `docs/team-architecture.md`).

- `architect` - advisory, read-only: sub-plans, split proposals, arbitration.
- `developer` - one issue end to end in an isolated worktree.
- `tester` - independent verification on the branch, read-only.
- `reviewer` - spec pass then quality pass, read-only.
- `fact-checker` - audits claims in a report or PR description against
  reproducible evidence, read-only (verdict taxonomy:
  `.claude/agents/fact-checker.md`). Dispatch when claims matter but carry
  no evidence; a CONTRADICTED claim is never dropped, it goes back to the
  agent that made it.
- `docs-writer` - authors or updates user-facing docs (README, guides, API
  docs) from a gap analysis. Dispatch on demand (for example after
  `tm-map-codebase`) when docs are missing or stale.
- `perf-investigator` - establishes a measured baseline and target for a
  reported slowness before anyone touches code, read-only except for
  measurement and profiling. Dispatch only for a package whose job is
  specifically a performance investigation, outside the per-package pipeline
  (handoff choreography: `docs/team-architecture.md`).

Refine and size issues in discussion first (`/tm-grill-me` stress-tests the
plan, `/tm-advisor` file only turns it into sized issues); mark dependencies
with a literal `Blocked by: #N` line in the issue body. Then `/tm-kickoff <issues>` (user-typed only;
it does not auto-trigger) runs unblocked issues in parallel waves to ready PRs.
Under `/tm-kickoff` the sub-plan comment substitutes for the full plan in `docs/plans/`.
Merging stays human and gates the next wave. Caps, routing,
and report contracts live in `.claude/skills/tm-kickoff/SKILL.md` and the agent
files; they are not repeated here.

### Plan-status block before dispatch

Before the lead spawns any subagent that works a plan or sub-plan, it prints
a short status block: which steps are done, which step the new subagent is
about to work on, which steps remain. This covers every tm-kickoff and
tm-advisor pipeline stage, plus ad-hoc dispatches when a plan exists.

```
Plan status (issue #42):
  [x] 1. sub-plan
  [x] 2. develop
  [>] 3. test   <- dispatching tester
  [ ] 4. review
  [ ] 5. PR ready
```

`[x]` marks a done step, `[>]` the current step (suffixed
`<- dispatching <agent>`), `[ ]` a remaining step. A fix round annotates the
current item, for example `[>] 3. test (fix round 2/3)`. In the tm- flows
the items are the pipeline stages (the skills pin them); an ad-hoc
plan-backed dispatch uses the active plan's own steps as items.

An ad-hoc dispatch with no plan behind it prints one fixed line instead:
`Dispatching <agent>: <purpose>`. Agents spawned inside workflow scripts are
excluded; the workflow progress tree already covers them.

When one message dispatches agents for several packages, print one block per
package, consecutively, in the same shape. No combined-table variant.

Labels: `in-progress` (package dispatched; resume, do not restart) and
`needs-human` (parked: question, blocker, or exhausted fix loop), on top of
the sizing set.

## Operating model (advisor)

`/tm-advisor` (user-typed only) runs the lead session as the user's advisor: it
refines a raw need into a batch of work packages, gets one sign-off, then
runs the team uninterrupted and reports (mechanics:
`.claude/skills/tm-advisor/SKILL.md`). The rules that matter session-wide:

- A batch is up to 6 independent `size:S`/`size:M` issues, run through the
  kickoff pipeline 3 at a time. Merging stays human; dependent work waits
  for the next batch.
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

Fable 5 in the one seat nothing backstops (the lead), Opus 5 at xhigh in the
backstopped judgment seats (architect, reviewer, workflow critics), efficient
workers everywhere else. The lever is where each model runs, not raw effort
everywhere. Rationale: docs/team-guide-rationale.md.
Moving the team between Max and Pro: docs/operations/plan-downgrade-runbook.md.

- Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
  Fable 5 (`claude-fable-5`) at xhigh effort. Affordable only because the
  lead stays on the bounded tm- machinery. Fable costs 2x Opus 5 per
  token. The premium is bounded in aggregate, not per batch
  (docs/research/2026-07-06-token-burn-investigation.md, driver 3).
- Lead-session fallback: Opus 5 at xhigh effort, a manual procedure. Fable is
  lead-session-only: used as the orchestrator when available, and nothing
  else in the machinery calls it. When Fable 5 is unavailable, rate-limited,
  quota-exhausted, or refuses the workload, switch the lead with
  `/model claude-opus-5`. Flip back when Fable returns. This fallback covers
  the lead session only; no other seat pins Fable, so no other pin needs to
  flip alongside it.
- Judgment seats (architect, reviewer, workflow critics): Opus 5 at xhigh
  effort is the primary model, backstopped by the lead and, for architect
  and reviewer, by the human merge gate. The per-call fallback is Sonnet at
  the same xhigh effort. The critic stage of every `tm-` workflow
  (`.claude/workflows/`) already retries on sonnet automatically when Opus
  returns nothing, though each run still burns one doomed Opus dispatch
  before the retry fires. For a single architect or reviewer dispatch
  hitting Opus quota mid-batch, the kickoff routing rules own the response:
  a per-call Sonnet override (the Agent tool's `model` param), flagged in
  the report, logged as a decision on the package issue, with the judgment
  re-run on Opus once quota returns (`.claude/skills/tm-kickoff/SKILL.md`).
  The ladder is Opus -> Sonnet, flagged and re-run; nothing else in the
  machinery falls back to Fable. If judgment quality visibly degrades on
  real batches, log the observation here.
- Cost-based fallback trigger: if Fable 5 stops being included under the
  Max-plan subscription and shifts to metered API billing, do not switch to
  Opus automatically. Measure the lead's actual $/session cost at API rates
  first, then decide whether to keep Fable or move to Opus 5 permanently,
  logging the decision and cost here.
- No session-wide `ultracode` under this policy (a prompt keyword or
  `/effort` menu option, not a slash command). Measured trial:
  `docs/reviews/2026-06-30-orchestration-comparison.md`. Keep `/effort` at
  `xhigh` and use the tm- scripts; use `ultracode` only for a one-off heavy
  task with no tm- script, preferring an Opus lead for that prompt.
- Role agents (frontmatter `model:`): `architect`/`reviewer` run `opus`
  (`sonnet` is the documented per-call fallback); `developer`, `tester`,
  `fact-checker`, `docs-writer`, `perf-investigator` run `sonnet`
  (`fact-checker` stays on Sonnet, not Haiku). Each agent also pins its own
  effort (`sonnet` -> `high`, `opus` -> `xhigh`), independent of the
  session's `/effort` setting. The `sonnet` -> `high` line is a pin rule for
  seats that run sonnet as their primary model; a per-call sonnet fallback
  on a judgment seat is not one of those pins, so it inherits the seat's
  `xhigh` effort instead.
- Effort ceiling: `xhigh`. Nothing runs at `max`. Effort inherits to any seat
  that does not pin it. The effort-policy test in `npm test` fails any agent
  or workflow stage that omits its pin or reintroduces max.
- Workflows: pin worker stages to a cheap model at `high` effort and reserve
  the strong model for synthesis or critique, bounded by construction so it
  cannot fan out unboundedly (`.claude/workflows/*.js`;
  docs/superpowers/specs/2026-06-13-review-codebase-design.md). A
  cheaper-led session still gets Opus-quality judgment; a Fable-led session
  never pays Fable rates for worker stages.
- Do not set `CLAUDE_CODE_SUBAGENT_MODEL`. It flattens every subagent to one
  model, defeating the split above. Use only as a temporary seatbelt (e.g.
  `claude-sonnet-5` before one heavy ad-hoc run); it downgrades the
  architect and reviewer too.

## How to pick up a task

1. `gh issue list --state open` (add `--label phase:<current>` if you use phase
   labels) to see what is available.
2. Pick an unassigned issue with no unresolved blockers. Check its `size:` label;
   if it is unsized, size it first, and if it is `L` or `XL`, decompose it before
   starting.
3. Post a short sub-plan on the issue (the checkpoint bullets in
   `.claude/process-core.md`'s "Sub-plans" section).
4. Create a branch and open a draft PR linking the issue (`Closes #N`).
5. Expand the sub-plan into a full plan via `superpowers:writing-plans`, saved to
   `docs/plans/<issue-number>-<slug>.md`. If the plan reveals the issue is bigger
   than its label, re-label and split it into sub-issues before implementing.
6. Implement with TDD per the plan.
7. Run the full check suite (typecheck, lint, test, e2e if touched). It must pass
   before requesting review.
8. Mark the PR ready for review.

For a batch of refined, sized issues, `/tm-kickoff` automates this flow per
issue, with the sub-plan comment standing in for step 5's full plan (see
"Agent team").

## Repo layout (team)

`.claude/` holds `agents/`, `skills/`, `workflows/`, and `settings.json`
(full annotated tree: docs/team-guide-rationale.md).

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

See `.claude/process-core.md`'s "What not to do" for the branch, merge-gate,
git-hook, and dependency rules.
<!-- Add project-specific traps here: the mistakes that quietly break this codebase. -->
