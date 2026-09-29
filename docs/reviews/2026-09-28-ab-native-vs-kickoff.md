# A/B test: native plan-and-execute vs the kickoff pipeline - 2026-09-28

Numbers, hashes and raw judge output are in
`docs/reviews/2026-09-28-ab-native-vs-kickoff-data.json`.
Protocol (frozen, do not edit): `docs/reviews/2026-09-28-ab-native-vs-kickoff-protocol.md`,
commit `919fb64` (2026-09-28T22:03:49+02:00). Issue #400. Arm PRs: #413
(pipeline), #414 (native). Scratch issues: #411 (pipeline), #412 (native).
The lead closes the scratch issues and PRs after this report's PR is
approved (architect sub-plan on #400, section 8, Part 2 step (9)).

Task: #362, "Fail CI when seat or skill behavior changes without a version
bump" (T2 in the protocol), replayed from base `1b4b8c5f` against reference
PR #386 (merge commit `0a34bf2e`). One pair, both arms headless, per the
owner's delta on #400: no supervised arm, no T1 replay, budget capped at $40.

## Applying the decision rule

The protocol's decision rule (section 9) is pre-registered and applied here
exactly as written.

**Validity.** Both arms reached their end state. Arm A (pipeline): PR #413
marked ready, tip `1ccb1e0`. Arm B (native): the fourth fixed invocation
completed with the work pushed, tip `2035958`. PR #414 was opened ready for
review during run 2, then converted back to a draft during run 4; the fixed
final prompt asked for a draft, so this is not an invalidity. Neither arm
hit `--max-budget-usd`. The contamination sweep found no READ exposure on
either arm (see "Contamination" below). Both arms are valid.

**Rule 1** applies immediately: this run has one pair, and the rule requires
at least two valid pairs before it scores a quality verdict. **Result:
INCONCLUSIVE (insufficient pairs).** The numbers below are reported without
a verdict, as the rule requires.

## Per-pair comparison (descriptive, not a verdict)

**Quality.** P(d) = acceptance criteria missed + non-goals violated + 1 if
`npm test` fails. Both diffs pass all three acceptance criteria, violate
neither non-goal, and `npm test` exits 0 at both tips (arm A 382/382, arm B
399/399). **P(X) = P(Y) = 0.**

- Q1(d) = must-fix findings in the fresh `tm-review-changes` pass, plus
  P(d). Pass 1 found 0 must-fix findings on both candidates. **Q1(X) =
  Q1(Y) = 0.**
- Q2(d) = must-fix findings the reconciliation pass attributes to d, plus
  P(d). The reconciliation pass found 11 flaws total and rated none of them
  must-fix. **Q2(X) = Q2(Y) = 0.**

Neither diff's Q1 and Q2 are both higher than the other's, so **the pair is
comparable on quality**, by the rule's own test.

**Pass 1 verdict** (fresh `tm-review-changes`, per arm): X (native) approve;
Y (pipeline) approve.

Unblinded: **X = arm B (native), Y = arm A (pipeline)** (mapping posted on
#400 after all three passes were saved; `sha256(mapping.json)` matches the
hash posted before judging).

**Cost, three ways.**

| Measure | Arm A (pipeline) | Arm B (native) | Ratio (B/A) | Band |
| --- | --- | --- | --- | --- |
| `token-report.mjs` (list price, output estimated from visible chars/4, excludes thinking) | $4.72 | $2.94 | R = 0.62 | 0.5-2 |
| Actual (CLI `total_cost_usd`, last result event per session id, includes thinking) | $6.29 | $4.46 | R(actual) = 0.71 | 0.5-2 |
| Adjusted (below) | $4.72 | $4.17 | adjusted R = 0.88 | 0.5-2 |

The actual figures take the last result event's `total_cost_usd` per session
id, not a sum across invocations: in a `--resume` chain that field is
already cumulative for the whole session, so summing every invocation's
value double-counts the earlier ones. Arm A ran two sessions (session 1:
run1+run2, last value $3.1532; session 2: run3, last value $3.1359; total
$6.2892, rounded $6.29). Arm B ran one session across all four invocations
(last value, run4, $4.4609, rounded $4.46).

**How adjusted R was computed**, per the rule ("scale arm B's Opus output
estimate by the actual-to-estimated output ratio measured on arm A's
headless lead session(s)"):

1. Arm A's actual output tokens: the last invocation's `modelUsage` per
   session, summed across both sessions (not every invocation, for the same
   cumulative-count reason as the cost figure above): session 1 (run2) opus
   40,131 + sonnet 28,560, plus session 2 (run3) opus 32,646 + sonnet
   37,026 = **138,363**.
2. Arm A's `token-report.mjs`-estimated output tokens for the same two
   sessions (its "Output (est.)" column total, both models; token-report
   already reports one estimate per session, so no cumulative-count issue
   here): 18,367 (first session) + 18,433 (resumed session) = **36,800**.
3. Ratio = 138,363 / 36,800 = **3.7599**.
4. Arm B's `token-report.mjs`-estimated Opus output tokens: **22,387**.
   Scaled: 22,387 x 3.7599 = **84,172**.
5. Repricing: arm B's non-output cost components (input, cache read, cache
   write 5m/1h) are unaffected by the scale and sum to $2.4911. Output cost
   at the opus rate ($20 / 1M tokens) on the scaled tokens: 84,172 / 1e6 x
   20 = $1.6834. Adjusted arm B cost = 2.4911 + 1.6834 = **$4.1745**.
6. Adjusted R = 4.1745 / 4.72 (arm A's unadjusted `token-report.mjs` cost,
   the rule scales only arm B) = **0.8844**, rounded 0.88.

Pooling arm A's lead and subagent output to build the scale factor is one
reading of "arm A's headless lead session(s)"; it is not the only one.
Lead-only takes each result event's top-level `usage.output_tokens` (per
invocation). Opus-only takes the last result event's `modelUsage` opus
entry per session (cumulative). Both divide by token-report's per-session
estimate rows. Lead-only: 6,119 + 8,089 + 15,527 = 29,735 actual, over
the lead role's estimated rows, 5,571 + 6,195 = 11,766 (ratio 2.527x,
adjusted R 0.767). Opus-only: `modelUsage`
claude-opus-5-5 entries, 40,131 + 32,646 = 72,777 actual, over the by-model
table's opus rows, 9,626 + 8,293 = 17,919 (ratio 4.061x, adjusted R 0.913).
Both land in the same 0.5-2 band as the reading used above.

All three ratios (0.62, 0.71, 0.88) land in the same 0.5-2 band and all put
native cheaper than the pipeline. Rule 5 ("INCONCLUSIVE (cost measurement)"
on a band split) needs the pair to be comparable on quality on *both* of two
pairs, so it cannot apply here regardless of the bands; with one pair, rule 1
already matched and governs the verdict.

**Total spend** (data.json): arms $10.75, judging $6.34, probes $0.72, total
$17.81, under the $40 cap and the $35 pre-judging stop.

## Verdict line

**INCONCLUSIVE (insufficient pairs); owner attention per task: native 0 min
(4 touchpoints), pipeline 0 min (3 touchpoints).**

Owner attention is not measured by this run. Both arms are headless by
construction (the owner's delta on #400 replaced the supervised native arm
with four chained fixed prompts and no one at the keyboard); the touchpoint
counts above are the fixed texts sent to each arm's session, not a time
measurement.

## Reported beside the verdict

**Wall-clock**, per the protocol's own measure (`T1 - T0`, minus any wait on
a usage or spend-limit reset): arm A 1,957 s, arm B 1,310 s. Arm A's run 2
ended in an individual spend-limit error after 830 s; the wait for the reset
(16,021 s, about 4h 27m) is excluded per the protocol and the owner's "wait
for the reset and resume" instruction. Deviation: the run also recorded
summed invocation durations (arm A 1,894 s: run1 83 s, run2 830 s, run3
981 s; arm B 1,231 s: run1 249 s, run2 234 s, run3 406 s, run4 342 s), a
different method from the protocol's `T1 - T0` that undercounts by the gap
between one invocation's end and the next one's launch. Both figures are
given here; the protocol's `T1 - T0` figure is the one that governs.

**Agent count:** arm A 7 subagent transcripts (3 in the first session before
the limit death, 4 in the resumed session: architect, developer, tester,
reviewer roles across the run); arm B 1 (the general-purpose agent spawned
by its own `/code-review` invocation in run 3, one second after that
prompt; arm B has no pipeline seats).

**Permission denials and blocked-on-human time.** Arm A: 1 permission
denial (a tester `Bash` call in run 3 requesting
`dangerouslyDisableSandbox`, denied); arm B: 0. Blocked-on-human time: 0 for
both arms, since both ran headless throughout.

**Diff size** (`git diff --stat` against the base, confirmed by parsing the
blind patches directly): arm A 5 files, +366/-2; arm B 6 files, +487/-2 (one
extra file, `CLAUDE.md`, plus a larger test file).

**Should-fix and nit counts, both passes** (pipeline Y drew more should-fix
in both passes):

| | Pass 1 (fresh `tm-review-changes`) | Reconciliation |
| --- | --- | --- |
| X (native) should-fix | 0 | 1 |
| Y (pipeline) should-fix | 2 | 6 |
| X nits | 1 | 1 |
| Y nits | 0 | 1 |
| Both (recon only) | - | 2 nits, 0 should-fix |

Pass 1 on Y also carried 2 dismissed findings (a duplicate of the label-
trigger should-fix, and an out-of-scope CLAUDE.md doc-completeness note).

**In-arm fix rounds and parks.** Arm A: architect sub-plan, then one tester
FAIL on fix round 1 of 3 followed by a PASS, then reviewer APPROVE with
should-fix notes; no formal park occurred (the arm reached a ready PR). Arm
B: plan approved as given, `/code-review` surfaced several findings, the fix
pass applied some and declined others with stated reasons, left the PR as a
draft per its own fixed final prompt (that prompt never asked for "ready").

**Limit event.** Arm A run 2 hit the owner's individual spend limit at
$2.62 into that invocation's own spend (run 2's cumulative session total was
$3.15, of which run 1 already accounted for $0.53), after 830 s, ending the
session with an error status. Arm A resumed through kickoff's own resume
path in a new session with the fixed prompt `/tm-kickoff #411`; the resumed
kickoff skipped its usual wave-plan confirmation stop, treating the resume
itself as the go-ahead, so no confirmation text was sent for that leg. Arm B
had no limit event.

**Base-era pipeline.** Arm A ran inside a base clone whose project-level
`.claude/` is the pipeline as it stood one commit before #362 merged: it
lacks #395, #397 and #398. None of those changes a seat's core job
(protocol section 2), but arm A's numbers reflect that older pipeline, not
the one on current `main`. Erratum: the base commit `1b4b8c5f` is #384's
own merge commit (protocol section 1), so arm A ran with #384 already in
place; protocol section 2 still lists #384 among the missing changes, which
contradicts section 1 and is wrong.

**Contamination.** No READ exposure on either arm; every GitHub-numbered hit
in both transcripts was the arm's own scratch issue or PR (#411/#413 for
arm A, #412/#414 for arm B). One notable coincidence: both arms
independently named the script `scripts/check-version-bump.mjs`, which is
also the reference solution's (#386) script name. The base checkout carries
no mention of that name and neither transcript shows a read of the
reference, so this is recorded as a naming coincidence (an obvious name for
the job, not evidence of contamination), not a READ or even a MENTION-level
hit on the reference itself.

**Cost-measurement gap.** `token-report.mjs`'s output-token estimate is
built from visible characters (text plus tool-call JSON) divided by 4, and
explicitly excludes thinking tokens. That undercounts real output on both
arms, somewhat more on arm B's single Opus session (actual output was 4.40x
the estimate) than on arm A's mix of Sonnet (developer, tester) and Opus
(lead, architect, reviewer) invocations (actual output was 3.76x the
estimate). Arm B's four chained invocations carried 12,789 / 2,449 / 26,576
/ 14,214 thinking tokens each in turn (run 3, not the last invocation,
carried the most; the session total of 56,028 is cumulative across all
four, not a single invocation's count). Both the list-price ratio (R 0.62)
and the actual-cost ratio (R(actual) 0.71) already put native cheaper; the
larger undercount on arm B is why the list-price ratio (0.62) shows native
further ahead than the actual figures (0.71) do, and why the adjusted-R
calculation above exists: it is a same-method attempt to close part of that
gap, not a full accounting of actual spend.

## The 11 deviations (this run, logged during Part 2)

These are the operational deviations logged while running the arms and
judging, distinct from the protocol's own pre-registered list of departures
from `tm-ab-test` (protocol section 11, decided before any arm ran). 1-5 are
from the #400 "Part 2 setup done" issue comment; 6-11 are from
`~/.cache/orchestrai-ab-400/deviations.txt` (a run-time log, not committed to
the repo). A twelfth operational deviation, the wall-clock method change, is
logged inline above ("Reported beside the verdict") rather than renumbered
into this list.

1. **Plugin-off settings.** A probe showed a second, synced copy of the
   plugin (`orchestrai@synced`, v2.0.1) still loaded with only
   `orchestrai@orchestrai` disabled. Every arm and judge session therefore
   used `--settings` with both `orchestrai@orchestrai` and
   `orchestrai@synced` set to `false`. Gate verified: the init event listed
   no orchestrai plugin, no orchestrai agents, no `tm-` skills.
2. **Judge `GH_CONFIG_DIR`.** Protocol section 8.5 sets it outside
   `ENV_WRAP` (outside `env -i`), where it would be dropped. At judging it
   went inside `ENV_WRAP` instead.
3. **Clone URL.** The clones used the repo's own https remote, not the ssh
   URL the protocol names.
4. **stdin.** Every headless call got `< /dev/null`, to skip a 3-second
   stdin wait.
5. **Probes.** Two probe sessions (Sonnet low and Haiku, about $0.72
   together) checked that a headless session waits for background
   subagents (it does) and tested the plugin gate. Not part of any arm's
   cost.
6. **Log placement.** Arm A run-1 logs were first written inside the arm A
   clone itself (untracked files the arm noticed and left alone). After
   run 1 they were moved to `~/.cache/orchestrai-ab-400/logs-A/`. All later
   logs went outside the clones.
7. **Limit death and resume.** Arm A run 2 hit the owner's individual spend
   limit after 830 s ($2.62 of run 2's own spend; the session's cumulative
   total at that point was $3.15). After the reset, arm A resumed through
   kickoff's own resume path: a new headless session in the same clone
   (`SID_A2`) with the fixed prompt `/tm-kickoff #411`. The resumed kickoff
   skipped its wave-plan stop, treating the resume as the go-ahead, so no
   confirmation was sent; only that one fixed text was sent. Cost covers
   both session ids; the limit wait is left out of wall-clock. The tester
   subagent running when session 1 died (agent-a6ee70bb, 20:23:41-20:24:31)
   was dispatched again from scratch in session 2, and the fresh lead had to
   rebuild context before continuing; that restart overhead adds cost and
   wall-clock to arm A that a run without a limit death would not carry, so
   it biases all three ratios (R, R(actual) and adjusted R, whose
   denominator is arm A's same token-report cost) toward native looking
   relatively cheaper and faster than a limit-free pipeline run would.
8. **Judge permission mode.** Judge sessions ran with
   `--permission-mode auto` (the protocol names no mode, and the headless
   default mode would deny tool calls the workflow needs); `GH_CONFIG_DIR`
   set inside `env -i` (deviation 2, restated here as it was logged
   alongside this one).
9. **Judge prompt via stdin.** Judge prompts went through stdin, because
   `--disallowedTools` with several comma-joined values swallowed the
   prompt argument on the first launch (that launch failed before any model
   call, no spend).
10. **Shell glob on the first arm-A resume.** The first launch of the arm A
    resume failed in the shell before starting (zsh expanded `opus[1m]` as a
    glob in an eval). No model call, no spend. Relaunched through a helper
    script (`run.sh`) with the same flags.
11. **Reconciliation working directory.** The reconciliation pass ran with
    cwd `$TRIAL/recon` on copied inputs, not `--add-dir "$TRIAL/blind"` as
    protocol section 8.6 names. No number changes (same four files, same
    content), but the command shape departed from the protocol.

## Confidence

This is a single pair: one task, one run per arm, no replication. Pass 1
ran in an opus[1m] session with Sonnet workers as arm B's author and as arm
A's judgment seats (architect, reviewer), though not as arm A's developer,
who wrote on Sonnet. The protocol flags shared model family as a blind
spot; any judge self-preference from it would tend to favor arm B, whose
whole diff came from an Opus session, over arm A, whose whole diff came
from its Sonnet developer. That bias is clean only for the reconciliation
pass (Opus only); pass 1's own worker stage runs on Sonnet, with one Opus
critic consolidating (`tm-review-changes.js`), so most of pass 1's own
spend on both candidates was Sonnet, the same model that wrote arm A's
diff. Two biases point toward native in this run: this judge-family bias,
and deviation 7's restart overhead after arm A's limit death, which lowers
all three cost ratios and lengthens arm A's wall-clock, both in native's
favor, beyond what a limit-free pipeline run would show. The native arm ran
headless throughout, standing in for the owner's real interactive use with
fixed prompts in place of the owner's own judgment at each step; it is an
approximation of native use, not a record of it. No policy change follows
from this report (issue non-goal); it is one illustrative data point, not a
settled comparison between the two ways of working.

## Links

- Protocol (frozen): `docs/reviews/2026-09-28-ab-native-vs-kickoff-protocol.md`, commit `919fb64`.
- Arm A (pipeline): scratch issue #411, PR #413.
- Arm B (native): scratch issue #412, PR #414.
- Raw data and hashes: `docs/reviews/2026-09-28-ab-native-vs-kickoff-data.json`.
- Setup record, deviations 1-5, mapping hash and verbatim judge output: issue #400 comments.

## Cleanup

- [ ] Scratch issues #411 and #412 closed (after this report's PR is approved).
- [ ] Arm PRs #413 and #414 closed (after this report's PR is approved).
- [ ] Base branch `ab/400-base-t2` and the arm/judge clones removed; arm branches deleted.
- [ ] Original task issue #362 left untouched; it was already closed by
      reference PR #386 before this replay started.
