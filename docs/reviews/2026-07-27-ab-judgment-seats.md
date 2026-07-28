# A/B test: Opus 5 vs Fable 5 in the judgment seats - 2026-07-27

Task: #286, `ab-test: Opus 5 vs Fable 5 in the judgment seats (reviewer and
architect)`. This is the capability comparison batch #283 deferred and the
revisit trigger named in
`docs/research/2026-07-24-opus-5-vs-fable-5-judgment-seats.md` section 9.

Base commit: `c0fb64e` (both arms ran against this repo state; it includes
PR #285, the seat flip itself).

Base drift: none. The pre-dispatch gate before each arm and a post-run check
all returned `c0fb64e`. The arms produced no branches, so the checklist's
fork-point audit does not apply.

Design note: unlike the first ledger entry, the arms here are judgment
dispatches, not code-producing pipelines. Each arm ran the same two
single-agent dispatches with byte-identical prompts, differing only in the
Agent tool's per-call `model` pin: a reviewer pass on PR #285 against issue
#284, and an architect SUB_PLAN on that arm's own scratch copy of issue
#224. Both reviewers were instructed to read only the issue body, the
sub-plan comment, and the diff, so neither saw the pipeline's own review
comments. Diff size, draft PR, and the independent tm-review-changes pass
are N/A throughout: the arms produce prose verdicts, not diffs.

## Arm A: fable

Status: run headless.

- Description: both judgment dispatches pinned to Fable 5 at xhigh (the
  seat assignment PR #285 retired).
- Scratch issue: #287 (architect half; the reviewer half reads PR #285 and
  needs no scratch issue).
- Branch: none (judgment dispatches, no code).
- Draft PR: none.
- Window: `2026-07-27T21:13:45Z` to `2026-07-27T21:20:10Z`.
- Wall-clock: 6m25s (reviewer 3m12s, architect 2m24s, sequential).
- Agent/subagent count: 2 (cross-checked against the token-burn script's
  session list for the window: reviewer `agent-a699611b10efca96d`, architect
  `agent-a01e0bb494a6aabd3`, both `claude-fable-5`).
- Token usage (token-burn script, per subagent session): reviewer peak
  context 53,919, cache_read 412,571, cache_creation 53,917; architect peak
  38,132, cache_read 201,327, cache_creation 36,230. Agent-tool reported
  totals: reviewer 55,156, architect 44,056 subagent tokens.
- Diff size: N/A (no code produced).
- Independent review: N/A (no diff to review).
- Acceptance-criteria drift: none against the dispatch prompts.

Outputs, summarized (full text in the appendix):

- Reviewer: APPROVE. All seven acceptance criteria verified, `npm test`
  re-run on the PR head (70/70), the two extra SKILL.md files judged
  in-spec. One nit: the comma-plus-"that" clause in the research addendum
  at line 134.
- Architect: a complete, plausible sub-plan for the token-burn re-measure.
  Names the pre-trim first day as a confounder, puts a data-availability
  sanity check first in the work order, recommends re-labeling S to M, and
  adds a harness-aware note about keeping the arm labels symmetric. It did
  not, however, run any probe: the plan assumes the measurement data
  exists.

## Arm B: opus

Status: run headless.

- Description: both judgment dispatches pinned to Opus 5 at xhigh (the seat
  assignment PR #285 shipped).
- Scratch issue: #288 (architect half).
- Branch: none.
- Draft PR: none.
- Window: `2026-07-27T21:20:24Z` to `2026-07-27T21:29:13Z`.
- Wall-clock: 8m49s (reviewer 3m52s, architect 4m04s, sequential).
- Agent/subagent count: 2 (cross-checked the same way: reviewer
  `agent-a0d28544ce6edef74`, architect `agent-a65facdc4d7c42f17`, both
  `claude-opus-5`).
- Token usage (token-burn script, per subagent session): reviewer peak
  context 69,418, cache_read 630,086, cache_creation 69,416; architect peak
  49,673, cache_read 627,985, cache_creation 47,775. Agent-tool reported
  totals: reviewer 71,505, architect 55,523 subagent tokens.
- Diff size: N/A.
- Independent review: N/A.
- Acceptance-criteria drift: none against the dispatch prompts.

Outputs, summarized (full text in the appendix):

- Reviewer: CHANGES_REQUESTED. Found the same nit as arm A plus three
  findings no prior pass caught: (must-fix) the Model policy's opening
  thesis sentence, "The strongest model in every plan/decision seat", now
  contradicts the shipped bullets beneath it; (should-fix) the new
  tm-kickoff sentence "Sonnet is never a judgment fallback for these seats"
  is absolute and contradicts the team-guide ladder's both-down case;
  (should-fix) `effort-policy.test.mjs` line 5's docstring still says
  "fable seats run xhigh" when no seat pins fable anymore. It also
  correctly declined to flag two dated frozen artifacts.
- Architect: returned NEEDS_DECISION instead of a plan, after running
  three read-only probes of the token-burn script. The probes show the
  measurement is currently impossible: the transcript store was rebuilt on
  2026-07-25/26, every window before 2026-07-26 returns zero usage lines,
  and a third transcript root sits outside the script's `PROJECT_ROOTS`.
  It offered two costed options (record the blocker and re-file with
  `Not before: 2026-08-09`, or re-target to the single closed day with a
  peaks-only comparison) and flagged that the baseline report's
  "reproduces exactly regardless of when the script runs" claim is now
  false and needs an addendum.

## Headline numbers

| | Arm A: fable | Arm B: opus |
| --- | --- | --- |
| Status | run headless | run headless |
| Wall-clock | 6m25s | 8m49s |
| Agents | 2 | 2 |
| Tokens (Agent-tool totals) | 99,212 | 127,028 |
| Peak context (reviewer / architect) | 53,919 / 38,132 | 69,418 / 49,673 |
| Diff size | N/A | N/A |
| Reviewer verdict | APPROVE, 1 nit | CHANGES_REQUESTED, 1 must-fix, 2 should-fix, 1 nit |
| Architect outcome | full sub-plan, data assumed present | NEEDS_DECISION, data absence proven by probe |

## Reading this result

One paired run is illustrative, not conclusive. Treat any directional
difference between the arms as a hypothesis for a follow-up run, not a
settled outcome, per the appendix in
`docs/reviews/2026-06-30-orchestration-comparison.md`.

Observations a reader will want checked before drawing conclusions:

- The opus reviewer's must-fix (team-guide line 186) is verifiable directly
  against the file, independent of which model found it. So is the
  opus architect's data-absence claim, by re-running the three probe
  commands quoted on #288. Neither depends on trusting the arm.
- The fable arm was cheaper (78% of the tokens) and faster (73% of the
  wall-clock). The opus arm did more verification work per dispatch
  (test re-runs, grep sweeps, script probes), which is where the extra
  time and tokens went. Depth of investigation is a behavior difference,
  not a like-for-like price difference.
- The comparison direction is unusual: the vendor ranks Fable 5 above
  Opus 5, yet the deeper-probing outputs here came from the opus arm.
  One run cannot say whether that is model capability, dispatch-to-dispatch
  variance, or prompt fit. A human picks the winner.

## Cleanup

- [x] Scratch issues closed (#287, #288), each holding its arm's architect
      output for the record.
- [x] Draft PRs: none existed.
- [x] Branches and worktrees: none created by the arms.
- [x] Original task issues left untouched (#224 unlabeled and uncommented;
      PR #285 received no arm comments). A human picks a winner from this
      writeup.

## Appendix: full arm outputs

### Arm A reviewer (fable) on PR #285

Pass 1 (spec): all seven acceptance criteria verified against the diff and
PR head tree, including an `npm test` run on an extracted copy of the head
(70/70) and confirmation that `EFFORT_BY_MODEL` is untouched. The two
SKILL.md files outside the sub-plan's enumerated list were judged in-spec
because the issue mandates the reversed ladder and the prose agree in the
same PR. Non-goals honored.

Pass 2 (quality): the three `criticWithFallback` copies verified
byte-identical by hash; added prose passes the style rules.

Verdict: APPROVE. Findings: (1, nit)
`docs/research/2026-07-24-opus-5-vs-fable-5-judgment-seats.md:134` uses a
restrictive "that" after a comma; change to "which this document rejected".

### Arm A architect (fable) on #287

Full sub-plan preserved as the arm's comment on #287: window selection with
the pre-trim day named as a confounder, unmodified-script constraint,
JSON-derived comparison set, report structure with named confounders,
privacy bound, verification steps, and a size recommendation (re-label S to
M, symmetrically across both arm scratch issues). Data availability is step
1 of its work order but was not probed during planning.

### Arm B reviewer (opus) on PR #285

Verification performed: exported the branch, ran `npm test` (70/70,
`EFFORT_BY_MODEL` unchanged), re-ran the sub-plan's verification grep, and
confirmed no test was weakened (both-null throw test and the byte-identical
sync test intact).

Pass 1 (spec): all seven acceptance criteria implemented; the two extra
SKILL.md files in scope, not creep; non-goals held. One gap: the Model
policy's thesis sentence was not rewritten.

Verdict: CHANGES_REQUESTED. Findings: (1, must-fix)
`.claude/team-guide.md:186` still opens with "The strongest model in every
plan/decision seat", now false for three of the four decision seats and in
direct contradiction with the PR's own addendum; an agent reading only the
summary would put Fable back in the architect seat. (2, should-fix)
`.claude/skills/tm-kickoff/SKILL.md:131-132` says "Sonnet is never a
judgment fallback for these seats", contradicting the team-guide ladder's
flagged both-down case; scope the sentence to the per-call rule. (3,
should-fix) `.claude/workflows/__tests__/effort-policy.test.mjs:5` docstring
still says "fable seats run xhigh"; no seat pins fable after this PR. (4,
nit) same line-134 grammar fix as arm A. Informational: two dated frozen
artifacts still describe the old seats and are correctly left alone.

### Arm B architect (opus) on #288

Returned NEEDS_DECISION with evidence. Probes run (script unmodified,
read-only): the issue's window and the baseline window both return "deduped
usage lines counted: 0"; an all-time probe shows usage lines on 2026-07-26
and 2026-07-27 only. Environment delta: transcript roots rebuilt
2026-07-25/26, 6 project dirs vs the baseline's 48, 65.7 MB vs 801.6 MB,
project paths renamed, and `~/.claude-work/projects` outside the script's
`PROJECT_ROOTS` with nothing older than 07-26. Options offered: (A) record
the blocker as a dated report and re-file with `Not before: 2026-08-09`;
(B) re-target to the single closed day 2026-07-26, peaks-only, refusing the
totals comparison. Common to both: an addendum correcting the baseline
report's reproducibility claim, script stays byte-identical, size:S holds.
Also flagged, correctly, that whichever option is chosen must be given to
both arms identically to keep a pairing valid.
