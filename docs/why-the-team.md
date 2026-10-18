# Why a team instead of plan-and-execute

The question this doc answers: what does the orchestration team buy over
asking an LLM to just plan and execute a task in one pass? This is not new
benchmarking. It collects what this repo has already measured or reasoned
through, cited inline, and leaves out anything under-supported.

## What the team costs

**A single lead-only dispatch (no subagents).** A paired trial ran the same
refine-and-propose task through `/tm-advisor`'s first two sections on two
lead models, five valid runs scored by an independent judge. Mean cost per
run was $2.20 (Opus 5.5) and $4.88 (Fable 5.1), well under half. Mean judge
score was 19.67 and 19.0 out of 20, 0.67 points apart, inside the
pre-registered "comparable quality" band, at low confidence
(`docs/reviews/2026-09-23-lead-model-comparison.md`, sections 5 and 8).

**One issue through the full pipeline vs. one developer dispatch alone.** A
separate paired trial ran the same size:M issue two ways from the same base
commit. One arm ran the full kickoff pipeline (architect, developer,
tester, reviewer); the other ran a single developer dispatch with no other
stage. The pipeline took
15m23s, 4 subagents plus the lead, for $7.55 in weighted total cost across
all token classes. The lone dispatch took 6m12s, 1 subagent plus the lead,
for $1.80 the same way. The lone dispatch was about 2.5x faster and 4x
cheaper, and wrote more tests
(`docs/reviews/2026-07-13-ab-plan-status-parser.md`).

**One full batch run through the pipeline.** A measured token report over
the session that ran batch #371, plus its follow-on sign-off discussion,
totals $23.02 at list price across 915 calls. That splits into $15.41 on
the Opus seats (lead, architect, reviewer) and $7.61 on the Sonnet seats
(developer, tester). The total undercounts real usage: output tokens are
estimated from visible text and tool-call input, and the estimate excludes
thinking tokens (`docs/research/2026-09-27-batch-371-token-baseline.md`).

## What it catches that plain plan-and-execute does not

**Independent test and review.** In the same size:M trial above, an
identical, independent review pass (`tm-review-changes`) was run against
both diffs afterward. The full-pipeline diff drew 0 must-fix issues (3
should-fix, 2 nits). The diff from the single, unaudited developer
dispatch drew 1 must-fix plus 3 should-fix. That gap is not a
clean code-quality result. Both diffs share the same underlying flaw: a
fixed-order suffix strip that silently misparses a non-canonical input.
Each arm's independent critic rated that shared flaw differently:
should-fix in the pipeline's diff, must-fix in the solo diff. Part of the
0-vs-1 gap is therefore critic-severity variance, not purely a quality
difference. The pipeline's own tester and reviewer stages did catch two
other issues, real but modest (an overstated docstring guarantee and
unpinned render-path validation). Neither they nor the lone dispatch
caught the shared ordering flaw; only the separate independent audit pass
did, on both diffs. One paired run is illustrative, not conclusive
(`docs/reviews/2026-07-13-ab-plan-status-parser.md`).

**A deeper judgment-seat pass, at higher cost, once.** A second trial ran
the same reviewer and architect prompts once with Fable in the seat and
once with Opus. One pass reviewed the same PR; the other ran an architect
sub-plan, each half on its own scratch copy of the same issue. Both
reviewers re-ran the test suite and flagged the same nit. The Opus
reviewer also re-ran the sub-plan's verification grep and reported three
findings no prior pass caught. One was a must-fix: a policy sentence that
had gone stale and now contradicted the document's own updated seat
assignments. The Opus architect ran three read-only probes of the
token-burn script and reported the plan was not runnable yet, with
evidence. The Fable architect wrote a full, plausible plan without
checking whether its own input data existed. The Fable arm was cheaper
(78% of the tokens) and faster (73% of the wall-clock). One paired run is
illustrative, not conclusive: the vendor ranks Fable above Opus, so this
result cannot separate model capability from dispatch-to-dispatch variance
(`docs/reviews/2026-07-27-ab-judgment-seats.md`).

**Fix rounds, parking, and resumability.** The pipeline loops a failing test
or review verdict back to the developer for exactly the findings raised,
then re-tests and re-reviews before a human ever sees it. This runs up to
3 fix rounds per stage, with the tester and reviewer keeping separate
counters. A package that exhausts either counter, hits a blocker, or needs
a decision only a human can make is parked instead of looping forever. It
gets the `needs-human` label (`docs/team-architecture.md`;
`.claude/skills/tm-kickoff/SKILL.md`'s Cap and Parking bullets). The lead
routes
every handoff and writes state (sub-plan comments, PR verdicts, labels) to
GitHub instead of holding it in one session. A dropped connection
therefore resumes from GitHub instead of restarting a lost session.

**Bounded fan-out.** The team's workflow scripts pin worker and judgment
model tiers and cap agent counts in code, independent of which model leads.
A live trial pitted this bounded construction against a hand-authored
stand-in for an ultracode-style workflow: both reviewed the same repository
from the same commit. The bounded run finished cleanly with 9 agents. The
unbounded stand-in reached 30 review agents and generated 85 findings. It
then tried to verify each one with a 3-vote pass (up to 255 agents) and
collapsed under repeated organization spend-limit errors, returning no
report. Combined, the two arms used 297 agents and about 5.64M subagent
tokens over roughly 51 minutes. The bounded run accounted for 9 of the 297
agents (`docs/reviews/2026-06-30-orchestration-comparison.md`,
"Addendum: a measured trial on the spawning-tendency question"). The same
report calls this one trial of a hand-authored construction, not a live
freeform session's own choices, and not a settled result.

## When plain plan-and-execute is the better choice

For a small, well-scoped, low-ambiguity change, a single dispatch is
faster and cheaper. In the paired size:M trial above, the pipeline's extra
gates (tester, reviewer) caught issues that were real but modest, not the
overall quality gap between the two diffs. The lone dispatch's one
must-fix finding was the same ordering flaw the pipeline's diff carried at
should-fix. Part of that gap is therefore critic-severity variance, not a
clean quality difference (`docs/reviews/2026-07-13-ab-plan-status-parser.md`).
If the task does not need a second, independent pass to be trustworthy,
paying for one is waste.

For a one-off heavy task with no existing `tm-` script to cover it,
`docs/reviews/2026-06-30-orchestration-comparison.md` treats an ad hoc,
self-directed session as the right tool. This repo calls that session
ultracode: the lead plans and runs its own workflow instead of the fixed
pipeline. The report's own words: "a per-prompt escape hatch for a one-off
heavy task with no `tm-` script covering it, not a session-wide default."
That report's structural argument cuts the other way once the pipeline's
judgment seats and the session's own lead run the same strong model. The
pipeline routes judgment-heavy stages to that model regardless of who
leads. Switching a strong-model-led session to ultracode therefore gives
up the pipeline's boundedness without buying any extra judgment quality.

## Sources

- `docs/reviews/2026-06-30-orchestration-comparison.md`
- `docs/reviews/ab-tests.md`, and the two reports it links:
  `docs/reviews/2026-07-13-ab-plan-status-parser.md` and
  `docs/reviews/2026-07-27-ab-judgment-seats.md`
- `docs/reviews/2026-09-23-lead-model-comparison.md`
- `docs/research/2026-09-27-batch-371-token-baseline.md`
- `docs/team-architecture.md`
