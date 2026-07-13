# A/B test: plan-status block parser and renderer - 2026-07-13

First real `/tm-ab-test` run (issue #250). Reports are immutable once
written; the summary row lives in `docs/reviews/ab-tests.md`.

Task: #255, `feat: plan-status block parser and renderer` (deliberately
scoped size:M: a zero-dependency parser/renderer for the team-guide
plan-status block, two files, TDD).

Base commit: `72dfa7ed79ccb7bccca0af7ce45488ea9d6fd824` (both arms forked
from here).

Base drift: none. Pre-dispatch gates and post-run merge-base audits all
returned the base commit for both arms.

## Arm A: kickoff-pipeline

Status: run headless.

- Description: the full per-package kickoff pipeline on a scratch issue:
  architect sub-plan, developer, tester, reviewer, PR marked ready. Models
  per policy (Fable architect/reviewer, Sonnet developer/tester). Zero fix
  rounds; every stage passed on round 1.
- Scratch issue: #256
- Branch: `feat/256-plan-status-parser` (tip `4824caa`)
- Draft PR: https://github.com/sv-tmueller/orchestrai/pull/258 (pipeline
  marked it ready; closed unmerged after this report)
- Window: `2026-07-13T04:24:00Z` to `2026-07-13T04:39:23Z`
- Wall-clock: 15m 23s
- Agent/subagent count: 4 subagents (architect, developer, tester,
  reviewer) plus the lead; transcript scan and dispatch log agree
- Token usage: output 17,398; input 158; cache creation 174,459; cache
  read 2,796,069; weighted cost $7.55 ($6.44 Fable, $1.11 Sonnet)
- Diff size: 2 files changed, 350 insertions (module 171, tests 179; 13
  new tests)
- Independent review (tm-review-changes, base `72dfa7e`): approve. 0
  must-fix, 3 should-fix (non-canonical annotation order silently
  mis-parsed; header-only zero-step block accepted; render-path validation
  unpinned by tests), 2 nits.
- Acceptance-criteria drift: none. Tester and reviewer checked the
  criteria line by line; two should-fix quality findings were posted to
  the PR for human review.

## Arm B: developer-dispatch

Status: run headless.

- Description: a single developer dispatch on a scratch issue, nothing
  else. No architect (the developer posts its own sub-plan comment, per
  its contract), no tester, no reviewer; the PR stays draft.
- Scratch issue: #257
- Branch: `feat/257-plan-status-parser` (tip `6f470e2`)
- Draft PR: https://github.com/sv-tmueller/orchestrai/pull/259 (closed
  unmerged after this report)
- Window: `2026-07-13T04:48:17Z` to `2026-07-13T04:54:29Z`
- Wall-clock: 6m 12s
- Agent/subagent count: 1 subagent (developer) plus the lead; transcript
  scan and dispatch log agree
- Token usage: output 4,274; input 75; cache creation 75,683; cache read
  1,949,264; weighted cost $1.80 ($0.97 Fable lead, $0.84 Sonnet)
- Diff size: 2 files changed, 517 insertions (module 206, tests 311; 27
  new tests)
- Independent review (tm-review-changes, base `72dfa7e`):
  changes-requested. 1 must-fix (a step line with the dispatch suffix
  before the fix-round annotation is silently misparsed: the dispatch text
  is absorbed into the title and `dispatching` comes back null), 3
  should-fix (duplicate-step errors quote the wrong source line; the
  dispatch-plus-fix-round combination is accepted but unpinned by any
  test; eight defensive guard branches untested), 0 nits.
- Acceptance-criteria drift: none missed; slightly exceeded (3 round-trip
  cases where the issue asked for 1).

## Headline numbers

| | Arm A: kickoff-pipeline | Arm B: developer-dispatch |
| --- | --- | --- |
| Status | run headless | run headless |
| Wall-clock | 15m 23s | 6m 12s |
| Agents | lead + 4 | lead + 1 |
| Tokens (output) | 17,398 ($7.55 weighted) | 4,274 ($1.80 weighted) |
| Diff size | 2 files, +350 (13 tests) | 2 files, +517 (27 tests) |
| Independent review | approve (0 must-fix, 3 should-fix, 2 nits) | changes-requested (1 must-fix, 3 should-fix) |

## Reading this result

One paired run is illustrative, not conclusive. Treat any directional
difference as a hypothesis for a follow-up run, per the appendix in
`docs/reviews/2026-06-30-orchestration-comparison.md`.

Observations worth carrying into that follow-up:

- The single dispatch was about 2.5x faster and 4x cheaper, and it wrote
  more tests. The pipeline bought two extra quality gates (tester,
  reviewer) whose findings (an overstated docstring guarantee, unpinned
  render-path validation) were real but modest.
- Both implementations contain the same underlying flaw: suffix stripping
  in a fixed order, so the non-canonical ordering `<- dispatching x (fix
  round n/m)` misparses silently. Arm A's independent critic rated it
  should-fix, arm B's rated it must-fix. The verdict gap between the arms
  is therefore partly critic-severity variance, not purely a code-quality
  difference. A follow-up could re-run the two diffs through fresh critic
  passes to separate those effects.
- The in-arm pipeline (tester plus reviewer) did not catch the ordering
  flaw either; only the independent dimension-fanned review passes did,
  on both arms.
- Both developer agents independently made the same process slip (a
  checkout command aimed at the shared repo instead of the dispatched
  worktree) and both self-recovered. That points at the known worktree
  isolation gap documented in tm-kickoff's cleanup section, not at either
  arm's variant.

## Cleanup

- [x] Scratch issues closed (#256, #257).
- [x] Draft PRs closed after both diffs were linked above (#258, #259).
- [x] Branches and worktrees cleaned up per tm-kickoff's deterministic
      cleanup section.
- [x] Original task issue #255 left untouched; a human picks a winner
      from this writeup.
