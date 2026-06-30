# Sonnet 5 orchestrator comparison: team pipeline vs. ultracode - 2026-06-30

Related: #122 (batch), #123 (package), #119 (the Model-policy clarification this extends).

## Bottom line

Keep Sonnet-5-led sessions on the team/workflow machinery at max effort by
default, the same default `.claude/team-guide.md` already sets for Opus-led
sessions. The reason does not depend on anything we have not measured: the
team pipeline pins judgment-heavy stages (architect, reviewer, and the
critic stage in both `tm-review-*` workflows) to Opus regardless of which
model leads the session. Ultracode-authored workflows do not pin per-stage
models by default and run on the session model throughout. So a Sonnet-5-led team
pipeline run still gets Opus-quality review; a Sonnet-5-led ultracode run
does not escalate at all. That gap holds whether or not Sonnet 5 turns out to
over-spawn under ultracode, which is a separate, currently open question this
report does not answer. The recommendation below is provisional and should be
revisited once real data exists (see the appendix).

## What this compares

Two ways to run Sonnet 5 as this template's lead session:

1. **Team pipeline at max effort.** Dispatch through the four role agents in
   `.claude/agents/` (architect, developer, tester, reviewer) and the two
   bounded scripts in `.claude/workflows/` (`tm-review-changes.js`,
   `tm-review-codebase.js`), the way `/tm-kickoff` and `/tm-advisor` already
   do.
2. **Ultracode.** The session plans and runs its own ad hoc workflow per
   task, at `xhigh` effort, as documented in the Model-policy section of
   `.claude/team-guide.md` (added by #119).

Both conditions put Sonnet 5 in the lead seat. The question #119 never had to
answer is whether the team pipeline is still the better default once the lead
itself can be Sonnet 5 instead of Opus 4.8, which is what the current
Model-policy section assumes throughout (it discusses Opus's behavior under
ultracode and Fable 5's, never Sonnet 5's).

## What is provable without running anything

The team pipeline's boundedness is structural, not a property of whichever
model happens to be leading:

- `.claude/agents/developer.md` and `tester.md` pin `model: sonnet` in
  frontmatter; `architect.md` and `reviewer.md` pin `model: opus`. These pins
  apply no matter what model the lead session runs.
- `tm-review-changes.js` pins each of its five dimension reviewers to
  `sonnet` and the consolidating critic to `opus`, by explicit `model:`
  arguments on every `agent()` call. A run is always exactly five reviewers
  plus one critic.
- `tm-review-codebase.js` pins its scout, area workers, and architecture
  worker to `sonnet` and its critic to `opus`, and hard-clamps the area count
  to `MAX_AREAS` (default 24) in script logic, not by asking the model to
  behave. A run is `1 scout + (N area workers + 1 architecture worker) + 1
  critic`, with `N <= MAX_AREAS`, however large the repository is.
- The kickoff pipeline itself is a fixed sequence (architect, developer,
  tester, reviewer) with capped fix-loop rounds, and runs at most three
  packages concurrently (`docs/team-architecture.md`).

None of this depends on the lead's model. A Sonnet-5-led `/tm-kickoff` run is
bounded by the same construction as an Opus-led one.

Ultracode's non-pinning is a default, not a constraint the mechanism
enforces. The Workflow runtime supports per-stage model overrides (an
`agent()` call accepts a `model` option, the same mechanism
`tm-review-changes.js` and `tm-review-codebase.js` use to pin their own
stages); an ultracode-authored workflow could set it. Per
`.claude/team-guide.md`'s Model-policy section, it simply does not by
default: as a session setting, ultracode "has Claude plan a dynamic workflow
for every substantial task, chaining several per request," and "the
workflows it invents have no per-stage model pinning, so their stages run on
the session model." There is also no script-level cap on how many workflows
chain. Both are observed default-authoring tendencies, the same epistemic
category as the Sonnet-5 spawning question below, not structural guarantees
the way the team pipeline's pinning is.

## What is new here: the judgment-escalation asymmetry

Under an Opus-led session, "team pipeline vs. ultracode" never raised a
quality question, because Opus is both the lead and the model the team
pipeline would assign to the judgment-heavy stages anyway. Switching an
Opus-led session from the team pipeline to ultracode changes boundedness and
cost, not which model is doing the judging.

Under a Sonnet-5-led session, the two modes diverge in a way #119 did not
need to address. The team pipeline still routes architect sub-plans and PR
review through Opus, regardless of the lead. Ultracode does not: a
Sonnet-5-led ultracode workflow reviews its own work with Sonnet 5, end to
end, because nothing pins the review stage to a stronger model. Choosing
ultracode over the team pipeline on a Sonnet-5-led session therefore gives up
the Opus-quality review the team pipeline provides for free. That cost did
not exist in the Opus-led case and is not mentioned in the current
Model-policy section.

This is a property of how the two modes are wired today, not an inherent
limit of either approach. Nothing stops an ultracode-authored workflow from
pinning a stage to Opus, or a lead session from running on Opus while still
using ultracode; the mechanism allows both. The asymmetry holds for the
specific comparison this report scopes: Sonnet 5 leading, ultracode authoring
with its observed default of not pinning, against the team pipeline as
committed.

## What is genuinely unknown

Two questions this report cannot answer from documentation or code alone:

- **Spawning tendency.** #119 records that Opus stays bounded under
  ultracode and Fable 5 over-spawns. Sonnet 5 has no recorded tendency
  either way. Guessing which side it falls on would be exactly the kind of
  unverified claim CLAUDE.md's principle 1 warns against, so this report
  states the absence of data instead of filling it in.
- **Real cost and quality on a task that needs orchestration.** The
  escalation argument above is structural and holds on any task. But how
  much it matters in practice (wall-clock time, total tokens, defects
  caught) depends on a task large enough to actually need multi-stage
  orchestration. The current backlog has no such task: the open-issue list
  is empty, and every finding in `docs/reviews/2026-06-30-codebase-review.md`
  is size:S. A live comparison run today would measure the case where the
  two modes barely differ, not the case the question is actually about.

For reference, one real data point on the bounded side exists from today's
session: the `tm-review-codebase` run that produced
`docs/reviews/2026-06-30-codebase-review.md` used 9 agents, about 1.03M
subagent tokens, and about 38 minutes wall-clock, scoped to this repository.
That is a real number for one bounded-workflow run. It is not paired with an
ultracode-arm number on the same task and should not be read as one side of
a comparison; no ultracode arm ran.

## Provisional recommendation

Add a Sonnet-5-as-orchestrator clause to the Model-policy section stating:
keep Sonnet-5-led sessions on the team and workflow machinery at max effort
by default, matching the existing Opus default, because the team pipeline's
judgment-escalation guarantee holds regardless of how the spawning question
resolves. Use ultracode the same way it is already scoped for Opus: a
per-prompt escape hatch for a one-off heavy task with no `tm-` script
covering it, not a session-wide default. Mark the clause provisional and
point to this report and its appendix, so it gets revisited once real data
exists rather than treated as settled by reasoning alone.

## Appendix: methodology for empirical validation

This report deliberately runs neither arm live, to avoid presenting one
measured number next to one imagined number as if they were comparable. A
real comparison needs both arms run the same way, by a human-supervised
session, since ultracode is a session-level setting this advisor session
cannot turn on for itself mid-task. Recommended method:

1. **Pick a real task.** Size:M or larger, substantial enough to need more
   than one orchestration decision. Wait for one to exist in the backlog, or
   scope one deliberately; do not use a size:S nit, which both modes will
   handle identically.
2. **Fork two worktrees from the same base commit.** One per arm, so neither
   run affects the other and both start from identical state.
3. **Arm A:** dispatch the task through `/tm-kickoff` in the first worktree.
   Sonnet 5 lead, `/effort max`.
4. **Arm B:** in a fresh session in the second worktree, work the identical
   task with Sonnet 5 and ultracode enabled (either the `/effort` menu's
   `ultracode` option for the session, or the per-prompt keyword on the
   first message). Do not reuse the arm-A session or worktree.
5. **Record, for each arm:** total agent or subagent count, wall-clock time,
   approximate token usage if the harness reports it, diff size (files and
   lines changed), an independent review pass against both diffs using the
   same dimensions (`tm-review-changes` against each, scoped to its own
   base), and whether either arm drifted past the task's acceptance
   criteria.
6. **Treat one paired run as illustrative, not conclusive.** Repeat across a
   few tasks of varying size before trusting a directional result, the same
   caution that applies to any n=1 trial.

## Limitations of this report

This is a reasoned comparison, not a measured one. No live run of either
mode happened as part of producing it. The repository currently has no task
sized to make a live run informative even if one had been attempted. The
recommendation above follows from a structural argument (judgment
escalation) that holds independent of the open spawning-tendency question,
but it is still a provisional default, not a finding, and should be revised
once the appendix's methodology produces real data.
