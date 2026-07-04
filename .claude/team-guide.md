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

Hours are the yardstick, but the reason to keep issues small is the session: a
large issue risks hitting the session limit mid-task and bloats context until
quality drops. Size the issue when you file it, then re-check while planning. If
the full plan shows the work is bigger than its label, re-label and split rather
than push through.

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
  Developer and tester already run the full suite locally, so CI confirms
  results, it does not discover problems.
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
- Permission mode: Auto (acceptEdits) during development (user-controlled).
  <!-- Modes (set with /permissions or settings.json "defaultMode"): default = prompt on
       first use of each tool; acceptEdits = auto-accept edits, prompt other actions
       ("Auto", the mode above); plan = read-only; bypassPermissions = no prompts. -->
- Superpowers: use relevant skills proactively (brainstorming, writing-plans,
  test-driven-development, subagent-driven-development, executing-plans,
  verification-before-completion).
- Parallel work: fan out subagents for independent research or implementation
  streams. Default to parallel over serial.

## Agent team

The template ships five role agents in `.claude/agents/` and a set of skills.
The lead is the main session: subagents cannot call each other, so the
session running `/tm-kickoff` routes every handoff, and GitHub (sub-plan and
verdict comments, draft PRs, labels) holds the state that makes a dropped
session resumable. A diagram of this flat-star model and the per-package
pipeline lives in `docs/team-architecture.md`.

- `architect` - advisory, read-only: sub-plans, split proposals, arbitration.
- `developer` - one issue end to end in an isolated worktree.
- `tester` - independent verification on the branch, read-only.
- `reviewer` - spec pass then quality pass, read-only.
- `fact-checker` - audits the claims in a report or PR description against
  reproducible evidence, read-only. Per-claim verdicts: VERIFIED with the
  command that proves it, CONTRADICTED, UNVERIFIED, or LABELED (the author
  marked it as an assumption). Dispatch it when a report's claims matter but
  carry no evidence; a CONTRADICTED claim is never dropped, it goes back to
  the agent that made it.

Refine and size issues in discussion first (`/tm-grill-me` stress-tests the
plan, `/tm-to-issues` turns it into sized issues); mark dependencies with a
literal `Blocked by: #N` line in the issue body. Then `/tm-kickoff <issues>` (user-typed only;
it does not auto-trigger) runs unblocked issues in parallel waves to ready PRs.
Under `/tm-kickoff` the sub-plan comment substitutes for the full plan in `docs/plans/`.
Merging stays human and gates the next wave. Caps, routing,
and report contracts live in `.claude/skills/tm-kickoff/SKILL.md` and the agent
files; they are not repeated here.

Labels: `in-progress` (package dispatched; resume, do not restart) and
`needs-human` (parked: question, blocker, or exhausted fix loop), on top of
the sizing set.

## Operating model (advisor)

`/tm-advisor` (user-typed only) runs the lead session as the user's advisor: it
refines a raw need into a batch of work packages, gets one sign-off, then
runs the team uninterrupted and reports. The full design is
`docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`; the
mechanics live in `.claude/skills/tm-advisor/SKILL.md`. The rules that matter
session-wide:

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

- Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
  Fable 5 (`claude-fable-5`) at xhigh effort. The lead routes every handoff,
  refines batches, and makes the dispatch decisions, so it gets the strongest
  model. This is affordable only because the lead stays on the bounded tm-
  machinery: Fable's known failure mode is over-spawning under session-wide
  ultracode, which this policy rules out (next bullet). Fable costs 2x Opus
  4.8 per token and weighs correspondingly against Max-plan quota; the lead's
  own token share is small next to the Sonnet-pinned workers, which keeps the
  premium bounded.
- Fallback: Opus 4.8 at xhigh effort. Claude Code has no automatic model
  fallback for the lead or for subagents; the fallback is a procedure. When
  Fable 5 is unavailable, rate-limited, quota-exhausted, or refuses the
  workload, switch the lead with `/model claude-opus-4-8`, and for a longer
  outage flip the `fable` pins to `opus` in the two agent frontmatters
  (`architect`, `reviewer`) and the Fable-critic stage of every `tm-` workflow
  (`tm-review-changes`, `tm-review-codebase`, `tm-map-codebase`). Flip them
  back when Fable returns.
- Cost-based fallback trigger, separate from the availability fallback above:
  if Fable 5 stops being included under the Max-plan subscription and shifts
  to metered API billing, do not switch to Opus automatically. The
  "affordable" reasoning above is weighed against Max-plan quota, not real
  dollars, so it stops applying the moment billing changes. Measure the
  lead's actual $/session cost at API rates first, then decide whether to
  keep Fable or move the lead to Opus 4.8 permanently, and log the decision
  and the measured cost here when made.
- No session-wide `ultracode`, ever, under this policy. There is no
  `/ultracode` slash command: it is either a keyword you type in a prompt or
  the `ultracode` option in the `/effort` menu. As a session setting it sends
  `xhigh` reasoning (one notch below `max`) and has Claude author a dynamic
  workflow for every substantive task; those invented workflows carry no
  per-stage model pinning, so every stage would run at Fable rates, and Fable
  over-spawns under exactly this shape. The measured trial behind this rule
  (287 agents attempted by an unbounded dynamic workflow against the bounded
  `tm-review-codebase` script's 9, spend cap exhausted) is in
  `docs/reviews/2026-06-30-orchestration-comparison.md`. Keep `/effort` at
  `xhigh` and use the tm- scripts; reach for the `ultracode` keyword only for a
  one-off heavy task with no tm- script, and prefer dropping the lead to Opus
  4.8 for that one prompt. (Source: code.claude.com/docs/en/model-config.md,
  "Adjust effort level".)
- Role agents (set in each agent's frontmatter `model:`): `architect` and
  `reviewer` run `fable` (the plan/decision roles; `opus` is the documented
  fallback); `developer`, `tester`, and `fact-checker` run `sonnet`, which
  resolves to Sonnet 5 (code generation, verification, and claim auditing
  are execution roles, not decision roles). The `fact-checker` stays on
  Sonnet rather than Haiku because claim extraction is the step that fails
  silently: a model that misses an unsupported claim defeats the role's
  purpose, and the agent runs rarely enough that the cost difference does
  not matter. Each agent also pins its own effort in frontmatter (`sonnet`
  seats `high`, `fable` seats `xhigh`), so seat effort never depends on the
  session's `/effort` setting.
- Effort ceiling: `xhigh`. Nothing runs at `max`. Evidence (DeepSWE v1.1
  leaderboard, July 2026): Fable 5 at max scores the same as at high for
  roughly 1.8x the cost, and Sonnet 5 at max is dominated by Fable 5 at every
  plotted effort level. Effort inherits to any seat that does not pin it, so
  the old session-wide max ran the Sonnet workers at the chart's worst value
  point. The effort-policy test in `npm test` fails any agent or workflow
  stage that omits its pin or reintroduces max.
- Workflows: pin worker stages to a cheap model at `high` effort in the script
  and reserve the strong model for synthesis or critique. The `tm-review-changes`
  workflow in `.claude/workflows/` is the worked example: a fixed set of Sonnet
  reviewers plus one Fable critic pinned to xhigh effort, bounded by construction so it
  cannot fan out into the 100-agent review that an unpinned session model
  produces. `tm-review-codebase` applies the same discipline to a whole-repo
  audit: a Sonnet scout splits the repo into N areas (sized to the repo,
  capped at a ceiling), Sonnet workers review each area plus repo-wide
  structure, and one Fable critic consolidates. The agent count is N + 3, so
  it scales with repo size up to the ceiling and never fans out unboundedly.
  `tm-map-codebase` reuses the same scout/worker/critic shape for a purely
  descriptive map (purpose, entry points, data and control flow, no
  findings): it drops the architecture worker, so the agent count is N + 2,
  bounded and scaling with repo size the same way.
  Because every stage is pinned, a cheaper-led session (for example Sonnet 5
  as lead) still gets Fable-quality judgment, and a Fable-led session never
  pays Fable rates for worker stages.
- Do not set `CLAUDE_CODE_SUBAGENT_MODEL`. It overrides both the per-call model
  and the frontmatter `model:`, flattening every subagent to one model and
  defeating the split above. Use it only as a temporary per-session seatbelt
  (for example `claude-sonnet-4-6` before one heavy ad-hoc run), knowing it
  downgrades the architect and reviewer too.

## How to pick up a task

1. `gh issue list --state open` (add `--label phase:<current>` if you use phase
   labels) to see what is available.
2. Pick an unassigned issue with no unresolved blockers. Check its `size:` label;
   if it is unsized, size it first, and if it is `L` or `XL`, decompose it before
   starting.
3. Post a short sub-plan on the issue (the checkpoint bullets above).
4. Create a branch and open a draft PR linking the issue (`Closes #N`). This puts
   the in-progress work in front of the user from minute one.
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

```
.claude/
  agents/            role agents: architect, developer, tester, reviewer
  skills/            project skills: /tm-advisor, /tm-grill-me, /tm-kickoff, /tm-new-project, /tm-to-issues
  workflows/         bounded orchestration scripts (tm-review-changes, tm-review-codebase, tm-map-codebase)
  settings.json      project settings; enables the superpowers plugin
                       enabledPlugins is template-managed;
                       permissions, hooks, env, and defaultMode are project-owned
```

Every skill and workflow built in this repo carries the `tm-` prefix
(`/tm-advisor`, `/tm-kickoff`, `/tm-review-changes`, and so on). The prefix
marks them as this project's own commands, so they are easy to tell apart from
the out-of-the-box and plugin skills (superpowers and the like) in the same
list. New project commands follow the same rule: name them `tm-<thing>`.

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
