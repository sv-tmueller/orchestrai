# Team guide

Generic process guidance for the orchestrator team. Project specifics live in each repo's CLAUDE.md.

## How we work

### Issues and branches

- Every unit of work is a GitHub issue first. Nothing new gets built without an issue.
- Branch from `main` per issue: `feat/<issue-number>-<short-slug>` or
  `fix/<issue-number>-<short-slug>`.
- Merge via PR. Direct pushes to `main` are blocked.
- The PR references the issue with `Closes #N`. One topic per PR.

### Sizing (t-shirt size per issue)

Every issue carries a t-shirt size label, estimated in human working hours:

- `size:S` - under 1 hour. One focused change.
- `size:M` - 1 to 3 hours. Write a sub-plan first.
- `size:L` - 4 to 6 hours. Split into smaller issues, or break into checkpointed
  sub-plans (below).
- `size:XL` - a full day, about 8 hours. Too big to start as one issue. Split it.

Size the issue when you file it, then re-check while planning. If the full
plan shows the work is bigger than its label, re-label and split rather than
push through (rationale: docs/team-guide-rationale.md).

### Sub-plans (checkpoint before deep work)

Before any deep planning or implementation, write a short sub-plan first: a
handful of checkpoint bullets (the approach, the files you expect to touch, the
order, the verification step) posted in the issue or the draft PR. This is cheap
insurance: if the connection drops or the session hits its limit, the next
session reads the checkpoint and resumes instead of restarting. For anything
sized `M` or larger, the sub-plan is also where you confirm the work still fits
one session and decompose it if it does not. Expanding it into a full plan comes
later (see "How to pick up a task").

### Commits

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`,
  `perf:`, `build:`, `ci:`.
- Imperative mood, lowercase, no period.
- The body explains why, not what.

### Tests

- Logic that has a right answer (math, parsing, business rules) is TDD: write the
  failing test against known inputs first, then the code.
- Integration clients are tested against saved fixtures, not live endpoints.
- End-to-end tests live in `e2e/` and gate deployment (see Repo layout). Run them
  locally before pushing any change that touches the full stack. Unit-green is not
  e2e-green.

### CI cost policy

- Agents verify locally first; CI is the final gate, not the first check.
- e2e in CI runs on ready-for-review PRs and on pushes to `main` only. Draft
  PRs run cheaper checks instead (typecheck, lint, unit).
- Every CI job pins `timeout-minutes`. A `concurrency` group with
  `cancel-in-progress: true` is mandatory on every workflow.
- Making a repo public to escape the free-minutes limit is forbidden. Fix the
  workflow instead.
- See the CI template under `.claude/skills/tm-new-project/` for the worked
  example.

### Writing style (commits, PRs, docs, comments)

- No em dashes. Use regular hyphens, commas, or parentheses.
- No AI-cliche phrases ("leverage", "robust", "seamless", "comprehensive",
  "elevate", "delve", "in the realm of", "it's worth noting", "moreover",
  "furthermore"). Plain, direct English. Short sentences.
- Add a comment only when the why is non-obvious. Do not restate what the code does.

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
current item, for example `[>] 3. test (fix round 2/3)`.

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

The strongest model in every plan/decision seat, efficient workers everywhere
else. The lever is where each model runs, not raw effort everywhere.
Rationale: docs/team-guide-rationale.md.

- Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
  Fable 5 (`claude-fable-5`) at xhigh effort. Affordable only because the
  lead stays on the bounded tm- machinery. Fable costs 2x Opus 4.8 per
  token. The premium is bounded in aggregate, not per batch
  (docs/research/2026-07-06-token-burn-investigation.md, driver 3).
- Fallback: Opus 4.8 at xhigh effort (a procedure, not automatic). When
  Fable 5 is unavailable, rate-limited, quota-exhausted, or
  refuses the workload, switch the lead with `/model claude-opus-4-8`; for a
  longer outage flip the `fable` pins to `opus` in the `architect` and
  `reviewer` frontmatters and the Fable-critic stage of every `tm-` workflow
  (`.claude/workflows/`). Flip back when Fable returns. For a single
  role-agent dispatch hitting Fable quota mid-batch, dispatch that one agent
  with a per-call Opus override (the Agent tool's `model` param) instead of
  flipping every pin. The ladder is Fable -> Opus; Sonnet is never a fallback
  for a judgment seat, and only steps in, flagged, if Opus is also down, with
  the review re-run on a judgment model afterward.
- Cost-based fallback trigger: if Fable 5 stops being included under the
  Max-plan subscription and shifts to metered API billing, do not switch to
  Opus automatically. Measure the lead's actual $/session cost at API rates
  first, then decide whether to keep Fable or move to Opus 4.8 permanently,
  logging the decision and cost here.
- No session-wide `ultracode` under this policy (a prompt keyword or
  `/effort` menu option, not a slash command). Measured trial:
  `docs/reviews/2026-06-30-orchestration-comparison.md`. Keep `/effort` at
  `xhigh` and use the tm- scripts; use `ultracode` only for a one-off heavy
  task with no tm- script, preferring an Opus lead for that prompt.
- Role agents (frontmatter `model:`): `architect`/`reviewer` run `fable`
  (`opus` is the documented fallback); `developer`, `tester`,
  `fact-checker`, `docs-writer`, `perf-investigator` run `sonnet`
  (`fact-checker` stays on Sonnet, not Haiku). Each agent also pins its own
  effort (`sonnet` -> `high`, `fable` -> `xhigh`), independent of the
  session's `/effort` setting.
- Effort ceiling: `xhigh`. Nothing runs at `max`. Effort inherits to any seat
  that does not pin it. The effort-policy test in `npm test` fails any agent
  or workflow stage that omits its pin or reintroduces max.
- Workflows: pin worker stages to a cheap model at `high` effort and reserve
  the strong model for synthesis or critique, bounded by construction so it
  cannot fan out unboundedly (`.claude/workflows/*.js`;
  docs/superpowers/specs/2026-06-13-review-codebase-design.md). A
  cheaper-led session still gets Fable-quality judgment; a Fable-led session
  never pays Fable rates for worker stages.
- Do not set `CLAUDE_CODE_SUBAGENT_MODEL`. It flattens every subagent to one
  model, defeating the split above. Use only as a temporary seatbelt (e.g.
  `claude-sonnet-4-6` before one heavy ad-hoc run); it downgrades the
  architect and reviewer too.

## How to pick up a task

1. `gh issue list --state open` (add `--label phase:<current>` if you use phase
   labels) to see what is available.
2. Pick an unassigned issue with no unresolved blockers. Check its `size:` label;
   if it is unsized, size it first, and if it is `L` or `XL`, decompose it before
   starting.
3. Post a short sub-plan on the issue (the checkpoint bullets above).
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

- Don't push directly to `main`. Open a PR.
- Don't merge a PR that has not run the full check suite, including e2e if the
  change touches the stack.
- Don't bypass git hooks (`--no-verify`). If a hook fails, fix the cause.
- Don't improve `.claude/` machinery only in this repo. Change the template
  (sv-tmueller/orchestrai) first, then run `/plugin update` in each config dir
  to pick it up. The config-dir CLAUDE.md imports `team-guide.md` from the
  marketplace clone, so that file updates automatically once the plugin does.
- Don't introduce a new dependency without saying why in the PR body.
<!-- Add project-specific traps here: the mistakes that quietly break this codebase. -->

## When in doubt

Ask. A 30-second clarifying question beats a 30-minute wrong direction.
