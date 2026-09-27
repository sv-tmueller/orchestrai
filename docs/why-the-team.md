# Why a team instead of plan-and-execute

The question this doc answers: what does the orchestration team buy over
asking an LLM to just plan and execute a task in one pass? This is not new
benchmarking. It collects what this repo has already measured or reasoned
through, cited inline, and leaves out anything under-supported.

## What the team costs

**A single lead-only dispatch (no subagents).** A paired trial ran the same
refine-and-propose task through `/tm-advisor`'s first two sections on two
lead models, five valid runs scored by an independent judge. Mean cost per
run: $2.20 (Opus 5.5) and $4.88 (Fable 5.1), well under half; mean judge
score 19.67 and 19.0 out of 20, 0.67 points apart, inside the pre-registered
"comparable quality" band
(`docs/reviews/2026-09-23-lead-model-comparison.md`, sections 5 and 8).

**One issue through the full pipeline vs. one developer dispatch alone.** A
separate paired trial ran the same size:M issue two ways from the same base
commit: the full kickoff pipeline (architect, developer, tester, reviewer)
against a single developer dispatch with no other stage. The pipeline took
15m23s, 4 subagents plus the lead, and cost $7.55 in output tokens
(weighted). The lone dispatch took 6m12s, 1 subagent plus the lead, and cost
$1.80. The lone dispatch was about 2.5x faster and 4x cheaper, and wrote
more tests (`docs/reviews/2026-07-13-ab-plan-status-parser.md`).

**One full batch run through the pipeline.** A measured token report over
the session that ran batch #371 (several issues through `/tm-kickoff`, plus
its follow-on sign-off discussion) totals $23.02 at list price: $15.41 on
the Opus seats (lead, architect, reviewer) and $7.61 on the Sonnet seats
(developer, tester), across 915 calls
(`docs/research/2026-09-27-batch-371-token-baseline.md`).

## What it catches that plain plan-and-execute does not

**Independent test and review.** In the same size:M trial above, an
identical, independent review pass (`tm-review-changes`) was run against
both diffs afterward. It found 0 must-fix issues in the full-pipeline diff
(3 should-fix, 2 nits) and 1 must-fix plus 3 should-fix in the diff produced
by the single, unaudited developer dispatch
(`docs/reviews/2026-07-13-ab-plan-status-parser.md`). Neither the
pipeline's own tester and reviewer stages nor the lone dispatch caught the
one flaw both diffs shared (a fixed-order suffix strip that silently
misparses a non-canonical input); only that separate independent audit
pass did, on both diffs, which the report itself flags as a limit of the
pipeline's own in-flow gates, not just an advantage over solo dispatch.

**What a stronger, backstopped judgment seat adds.** A second trial ran the
same reviewer and architect prompts on the same PR and issue, once with
Fable in the seat and once with Opus. Both passes flagged the same nit; the
Opus pass alone verified its findings by rerunning the test suite and
grepping the source, and surfaced three more real problems, one of them a
must-fix (a policy sentence that had gone stale and now contradicted the
document's own updated seat assignments). The Fable architect half wrote a
full, plausible plan without checking whether its own input data existed;
the Opus half ran read-only probes first and reported the plan was not
runnable yet, with evidence (`docs/reviews/2026-07-27-ab-judgment-seats.md`).

**Fix rounds, parking, and resumability.** The pipeline loops a failing test
or review verdict back to the developer for exactly the findings raised,
re-tests, and re-reviews before a human ever sees it; the lead routes every
handoff and writes state (sub-plan comments, PR verdicts, labels) to GitHub
instead of holding it in one session, so a dropped connection resumes from
GitHub instead of restarting a lost session (`docs/team-architecture.md`).
A single plan-and-execute pass has none of this: it succeeds or fails once,
and a dropped session loses the work in flight.

**Bounded fan-out.** The team's workflow scripts pin worker and judgment
model tiers and cap agent counts in code, independent of which model leads.
A live trial pitted this bounded construction against a hand-authored
stand-in for an unbounded, self-directed workflow (the shape a
plan-and-execute session tends toward once it starts chaining steps on its
own): both reviewed the same repository from the same commit. The bounded
run finished cleanly with 9 agents. The unbounded stand-in reached 30
review agents, generated 85 findings, then tried to verify each one with a
3-vote pass (up to 255 agents) and collapsed under repeated organization
spend-limit errors, returning no report. Combined, the two arms used 297
agents and about 5.64M subagent tokens over roughly 51 minutes; the bounded
run accounted for 9 of those (`docs/reviews/2026-06-30-orchestration-comparison.md`,
"Addendum: a measured trial on the spawning-tendency question"). The same
report calls this one trial of a hand-authored construction, not a live
freeform session's own choices, and not a settled result.

## When plain plan-and-execute is the better choice

For a small, well-scoped, low-ambiguity change, a single dispatch is faster
and cheaper, and the quality gap is real but modest: the paired size:M
trial above found should-fix issues in the pipeline's own diff, not
must-fix ones, and the lone dispatch's must-fix finding was a subtle
ordering bug, not a broken feature
(`docs/reviews/2026-07-13-ab-plan-status-parser.md`). If the task does not
need a second, independent pass to be trustworthy, paying for one is waste.

For a one-off heavy task with no existing `tm-` script to cover it, this
repo's own guidance treats an ad hoc self-directed session (what it calls
ultracode: the lead plans and runs its own workflow for the task instead of
the fixed pipeline) as the right tool, not the team pipeline: "a per-prompt
escape hatch for a one-off heavy task with no `tm-` script covering it, not
a session-wide default." The same report's structural argument cuts the
other way once the pipeline's judgment seats and the session's own lead run
the same strong model: since the pipeline routes judgment-heavy stages to
that model regardless of who leads, switching a strong-model-led session to
plan-and-execute mode gives up the pipeline's boundedness without buying
any extra judgment quality
(`docs/reviews/2026-06-30-orchestration-comparison.md`).

## Sources

- `docs/reviews/2026-06-30-orchestration-comparison.md`
- `docs/reviews/ab-tests.md`, and the two reports it links:
  `docs/reviews/2026-07-13-ab-plan-status-parser.md` and
  `docs/reviews/2026-07-27-ab-judgment-seats.md`
- `docs/reviews/2026-09-23-lead-model-comparison.md`
- `docs/research/2026-09-27-batch-371-token-baseline.md`
- `docs/team-architecture.md`
