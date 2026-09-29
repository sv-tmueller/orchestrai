# A/B test: native plan-and-execute vs the kickoff pipeline - 2026-09-28

Save as `docs/reviews/2026-09-28-ab-native-vs-kickoff.md`. Numbers, hashes and
raw judge output are in `docs/reviews/2026-09-28-ab-native-vs-kickoff-data.json`.
Protocol (frozen, do not edit): `docs/reviews/2026-09-28-ab-native-vs-kickoff-protocol.md`,
commit `919fb64` (2026-09-28T22:03:49+02:00). Issue #400. Arm PRs: #413
(pipeline), #414 (native). Scratch issues: #411 (pipeline), #412 (native).
The lead closes the scratch issues and PRs after this report's PR is
approved (protocol section 8, step 9).

Task: #362, "Fail CI when seat or skill behavior changes without a version
bump" (T2 in the protocol), replayed from base `1b4b8c5f` against reference
PR #386 (merge commit `0a34bf2e`). One pair, both arms headless, per the
owner's delta on #400: no supervised arm, no T1 replay, budget capped at $40.

## Applying the decision rule

The protocol's decision rule (section 9) is pre-registered and applied here
exactly as written.

**Validity.** Both arms reached their end state. Arm A (pipeline): PR #413
marked ready, tip `1ccb1e0`. Arm B (native): the fourth fixed invocation
completed with the work pushed, tip `2035958` (PR #414 left as a draft, which
is arm B's own fixed prompt's instruction, not an invalidity). Neither arm
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

Unblinded: **X = arm B (native), Y = arm A (pipeline)** (mapping posted on
#400 after all three passes were saved; `sha256(mapping.json)` matches the
hash posted before judging).

**Cost, three ways.**

| Measure | Arm A (pipeline) | Arm B (native) | Ratio (B/A) | Band |
| --- | --- | --- | --- | --- |
| `token-report.mjs` (list price, output estimated from visible chars/4, excludes thinking) | $4.72 | $2.94 | R = 0.62 | 0.5-2 |
| Actual (CLI `total_cost_usd`, sum of result events, includes thinking) | $6.82 | $10.52 | R(actual) = 1.54 | 0.5-2 |
| Adjusted (below) | $4.72 | $4.25 | adjusted R = 0.90 | 0.5-2 |

**How adjusted R was computed**, per the rule ("scale arm B's Opus output
estimate by the actual-to-estimated output ratio measured on arm A's
headless lead session(s)"):

1. Arm A's actual output tokens, summed across every model in every
   invocation of both its sessions (result-event `modelUsage`): run1 opus
   6,119 + run2 opus 40,131 + run2 sonnet 28,560 + run3 opus 32,646 + run3
   sonnet 37,026 = **144,482**.
2. Arm A's `token-report.mjs`-estimated output tokens for the same two
   sessions (its "Output (est.)" column total, both models): 18,367 (first
   session) + 18,433 (resumed session) = **36,800**.
3. Ratio = 144,482 / 36,800 = **3.9261**.
4. Arm B's `token-report.mjs`-estimated Opus output tokens: **22,387**.
   Scaled: 22,387 x 3.9261 = **87,894.5**.
5. Repricing: arm B's non-output cost components (input, cache read, cache
   write 5m/1h) are unaffected by the scale and sum to $2.4911. Output cost
   at the opus rate ($20 / 1M tokens) on the scaled tokens: 87,894.5 / 1e6 x
   20 = $1.7579. Adjusted arm B cost = 2.4911 + 1.7579 = **$4.2490**.
6. Adjusted R = 4.2490 / 4.72 (arm A's unadjusted `token-report.mjs` cost,
   the rule scales only arm B) = **0.9002**.

All three ratios (0.62, 1.54, 0.90) land in the same 0.5-2 band, so rule 5
("INCONCLUSIVE (cost measurement)" on a band split) does not trigger. With
one pair only, rule 1 already governs the verdict regardless.

## Verdict line

**INCONCLUSIVE (insufficient pairs); owner attention per task: native 0 min
(4 touchpoints), pipeline 0 min (3 touchpoints).**

Owner attention is not measured by this run. Both arms are headless by
construction (the owner's delta on #400 replaced the supervised native arm
with four chained fixed prompts and no one at the keyboard); the touchpoint
counts above are the fixed texts sent to each arm's session, not a time
measurement.

## Reported beside the verdict

**Wall-clock** (summed invocation durations, limit waits shown separately):
arm A 1,894 s (run1 83 s, run2 831 s, run3 982 s); arm B 1,231 s (run1 249 s,
run2 234 s, run3 407 s, run4 343 s). Arm A's run 2 ended in an individual
spend-limit error after 831 s; the wait for the reset (16,021 s, about 4h
27m) is excluded from wall-clock per the protocol and the owner's "wait for
the reset and resume" instruction.

**Agent count:** arm A 7 subagent transcripts (3 in the first session before
the limit death, 4 in the resumed session: architect, developer, tester,
reviewer roles across the run); arm B 1 (a subagent the native session
chose to spawn on its own; arm B has no pipeline seats).

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
should-fix notes; one formal park never occurred (the arm reached a ready
PR). Arm B: plan approved as given, `/code-review` surfaced several
findings, the fix pass applied some and declined others with stated reasons,
left the PR as a draft per its own fixed final prompt (that prompt never
asked for "ready").

**Limit event.** Arm A run 2 hit the owner's individual spend limit at
$3.15 into that invocation, after 831 s, ending the session with an error
status. Arm A resumed through kickoff's own resume path in a new session
with the fixed prompt `/tm-kickoff #411`; the resumed kickoff skipped its
usual wave-plan confirmation stop, treating the resume itself as the
go-ahead, so no confirmation text was sent for that leg. Arm B had no limit
event.

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
explicitly excludes thinking tokens. That undercounts real output far more
on a long, thinking-heavy single Opus session (arm B: one session, four
chained invocations, up to 56,028 thinking tokens in its last invocation
alone) than on a pipeline that spreads work across a cheaper Sonnet-heavy
mix (arm A's subagents run Sonnet per the model policy). That asymmetry is
exactly why the actual-cost ratio (1.54, native costs more) and the
list-price-estimate ratio (0.62, native costs less) point in opposite
directions, and why the adjusted-R calculation above exists: it is a
same-method attempt to close part of that gap, not a full accounting of
actual spend.

## The 10 deviations (this run, logged during Part 2)

These are the operational deviations logged while running the arms and
judging, distinct from the protocol's own pre-registered list of departures
from `tm-ab-test` (protocol section 11, decided before any arm ran). 1-5 are
from the #400 "Part 2 setup done" issue comment; 6-10 are from
`~/.cache/orchestrai-ab-400/deviations.txt` (a run-time log, not committed to
the repo).

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
   limit after 831 s ($3.15). After the reset, arm A resumed through
   kickoff's own resume path: a new headless session in the same clone
   (`SID_A2`) with the fixed prompt `/tm-kickoff #411`. The resumed kickoff
   skipped its wave-plan stop, treating the resume as the go-ahead, so no
   confirmation was sent; only that one fixed text was sent. Cost covers
   both session ids; the limit wait is left out of wall-clock.
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

## Confidence

This is a single pair: one task, one run per arm, no replication. Both
judging passes ran on the same model family (`opus[1m]`) as both arms'
authors, which the protocol itself flags as a shared blind spot. The native
arm ran headless throughout, standing in for the owner's real interactive
use with fixed prompts in place of the owner's own judgment at each step;
it is an approximation of native use, not a record of it. No policy change
follows from this report (issue non-goal); it is one illustrative data
point, not a settled comparison between the two ways of working.

## Links

- Protocol (frozen): `docs/reviews/2026-09-28-ab-native-vs-kickoff-protocol.md`, commit `919fb64`.
- Arm A (pipeline): scratch issue #411, PR #413.
- Arm B (native): scratch issue #412, PR #414.
- Raw data and hashes: `docs/reviews/2026-09-28-ab-native-vs-kickoff-data.json`.
- Setup record, deviations 1-5, mapping hash and verbatim judge output: issue #400 comments.

## Cleanup

- [ ] Scratch issues #411 and #412 closed (after this report's PR is approved).
- [ ] Arm PRs #413 and #414 closed (after this report's PR is approved).
- [ ] Base branch `ab/400-base-t2` and the arm/judge clones removed.
- [ ] Original task issue #362 left untouched; it was already closed by
      reference PR #386 before this replay started.
