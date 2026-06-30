# Sonnet 5 orchestrator comparison: team pipeline vs. ultracode - 2026-06-30

Related: #122 (batch), #123 (package), #119 (the Model-policy clarification this extends).

## Bottom line

Keep Sonnet-5-led sessions on the team/workflow machinery at max effort by
default, the same default `.claude/team-guide.md` already sets for Opus-led
sessions. The structural part of this argument needs no live data: the team
pipeline pins judgment-heavy stages (architect, reviewer, and the critic
stage in both `tm-review-*` workflows) to Opus regardless of which model
leads the session. Ultracode-authored workflows do not pin per-stage models
by default and run on the session model throughout. So a Sonnet-5-led team
pipeline run still gets Opus-quality review; a Sonnet-5-led ultracode run
does not escalate by default. That gap holds whether or not Sonnet 5 turns
out to over-spawn under ultracode, which is a separate, currently open
question this report does not answer. Given that open question, this is the
conservative default under uncertainty, not a proven conclusion: the
recommendation below is provisional and should be revisited once real data
exists (see the appendix).

This report does not argue for switching the lead model to Sonnet 5. The
judgment-escalation asymmetry below explains why: the team pipeline's
quality guarantee does not depend on the lead, but the lead's own judgment
work does. Opus 4.8 remains the default lead per the existing policy. What
follows applies only when Sonnet 5 leads for some other reason: a default
change, lower cost, or faster turnaround.

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
for every substantive task, chaining several per request," and "the
workflows it invents have no per-stage model pinning, so their stages run on
whichever model is leading the session." There is also no script-level cap
on how many workflows chain. Both are observed default-authoring
tendencies, the same epistemic category as the Sonnet-5 spawning question
below, not structural guarantees the way the team pipeline's pinning is.

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

## Corollary: the same argument favors keeping Opus as lead

The asymmetry above answers "given Sonnet 5 leads, which orchestration mode
is better." The same fact also answers a prior question: should the lead
switch to Sonnet 5 at all. Since the team pipeline already routes
judgment-heavy stages to Opus regardless of which model leads, switching the
lead itself from Opus to Sonnet 5 buys no quality improvement on that work.
The only place a lead-model choice has no offsetting structural guarantee is
the lead's own judgment: refining an ambiguous request, scope and parking
decisions during a kickoff or advisor run, and any work the lead does
directly instead of delegating (this report and its policy edit, for
instance, written by a Sonnet-5-led session rather than dispatched to a
subagent).

Cost cuts the other way. Sonnet 5 is cheaper per token than Opus 4.8 on the
API: $3/$15 per million input/output tokens standard, $2/$10 introductory
through 2026-08-31, against Opus 4.8's $5/$25 (checked against current API
pricing on 2026-06-30). Whether that translates to a Claude Max-plan
subscription is a separate, unverified question: the existing policy's
"weighs less against Max-plan quota" claim for Opus is about subscription
quota mechanics, not API pricing, and nothing in this report confirms or
refutes it.

Net: the judgment-escalation argument favors keeping Opus 4.8 as the
default lead, the conclusion the existing policy already reaches. This
report's scope stays narrower than that question; it covers only what to do
once Sonnet 5 is already leading.

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
  is otherwise empty, and the findings in
  `docs/reviews/2026-06-30-codebase-review.md` (PR #126, a sibling of this
  one under batch #122) read as small, single-location fixes (the one filed
  so far, #125, is size:S), not the kind of multi-stage work that would
  exercise orchestration choices. A live comparison run today would measure
  the case where the two modes barely differ, not the case the question is
  actually about.

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

## Addendum: a measured trial on the spawning-tendency question

A later session the same day ran a live trial bearing directly on the first
"genuinely unknown" question above. It does not follow the appendix's
paired-worktree, issue-implementation methodology, so it is a different
task shape from what the appendix recommends; it is offered as a real data
point on spawning tendency, not as the paired comparison the appendix calls
for.

**What ran.** Both arms reviewed this repository, concurrently, from the
same base commit:

- **Arm A:** the production `tm-review-codebase` workflow, unchanged - Sonnet
  area/architecture workers, one Opus critic, bounded to `areas + 3` agents
  by construction.
- **Arm B:** a hand-authored stand-in for an ultracode-style dynamic
  workflow - every stage on the session model (Sonnet 5, no per-stage
  pinning), a scout free to pick its own area count with no ceiling, each
  area reviewed by five separate dimension-lens agents instead of one
  integrated pass, and every finding put through 3-vote adversarial
  verification. This mirrors the fan-out and verify patterns ultracode is
  documented to compose by default, authored by the session rather than
  produced by a live ultracode session deciding freely, which is the gap
  between this trial and the appendix's proposed method.

**What happened.** Arm A completed cleanly: 6 areas, 9 agents total
(1 scout + 6 area workers + 1 architecture worker + 1 critic), verdict
approve. Arm B reached 6 areas too (30 review agents) but generated 85 raw
findings before its 3-vote verification stage (up to 255 agents) collapsed
under repeated `"You've hit your org's monthly spend limit"` failures;
synthesis and the planned judging pass both failed for the same reason and
returned no report. Combined, the two arms used 297 agents and about 5.64M
subagent tokens over roughly 51 minutes; Arm A accounted for 9 of those 297
agents. Arm B alone, unfinished, consumed the rest and still produced
nothing usable.

**Reading this against the open questions above.** On spawning tendency:
this is one data point that an unbounded, unpinned construction run on
Sonnet 5 can over-spawn severely, the same failure mode `team-guide.md`
already documents for Fable 5 under ultracode - though, per the caveat
above, this measures the construction's behavior on Sonnet 5, not a live
ultracode session's own free-form choice on Sonnet 5, which the appendix's
methodology would still be needed to confirm directly. On the second
question (whether this repo has a task large enough to make a live
comparison informative): this trial used the same review-task category the
"genuinely unknown" section assumed was too small to differentiate the two
modes, and the two modes did not barely differ - one completed and one
exhausted an organization-wide spend cap. That updates this report's
assumption that a same-day, same-repo trial would necessarily be
uninformative; it does not by itself validate the modes on the
issue-implementation task shape the appendix recommends, which remains
unrun.

This is a single trial, the same caution the appendix already states for
its own proposed method. It does not resolve the spawning-tendency
question on its own, but it is evidence against assuming Sonnet 5 behaves
like Opus here by default.
