# Lead effort comparison: Opus 5.5 at high vs xhigh - 2026-09-28

Issue #404, batch #403 (P1). Pre-registered protocol and its round-2
amendment: [2026-09-28-lead-effort-comparison-protocol.md](2026-09-28-lead-effort-comparison-protocol.md).
Per-run data, judge scores, and hashes:
[2026-09-28-lead-effort-comparison-data.json](2026-09-28-lead-effort-comparison-data.json).
Reused xhigh arm (O1-O3): #358's own files, unedited by this PR.

## 1. Bottom line

**Switch the lead's advisor refinement (sections 1-2 only) to `--effort
high`.** Round 1 (H1-H3) delivered 0 valid runs (a 429 and two contamination-
gate hits) and reported "insufficient evidence." Per a decision logged on
batch #403
([comment 5872761987](https://github.com/sv-tmueller/orchestrai/issues/403#issuecomment-5872761987)),
one more round ran (H4-H6, amendment 1 to the protocol, a trial root with no
2026-09-23 sibling to sweep into). All three round-2 runs were valid; the
judge ran over O1-O3 plus H4-H6 and both decision-rule conditions held:

- **Score gap:** xhigh mean 20.0/20 (O1, O2, O3 all scored 20), high mean
  19.67/20 (H4 20, H5 20, H6 19). Gap 0.33, inside the 1.0-point ceiling.
- **Cost ratio:** xhigh mean cost $2.2008/run, high mean cost $1.0581/run.
  Ratio 0.48, inside the 0.80x ceiling (high-effort runs cost well under
  half of xhigh's).

Both hold, so the pre-registered rule's answer is **switch**. Per the
protocol's own "if switch" clause, only `.claude/team-guide.md` is edited,
and only a refinement-only note: advisor sections 1-2 may run at `high`,
flipped back to `xhigh` before replying "dispatch." `tiers.lead` in
`.claude/adapters/claude-code.json` and `SEAT_EXPECTATIONS` in
`effort-policy.test.mjs` are untouched, both guarded and outside this
package's contract.

The batch's deferred run-phase measurement ("only if P1 shows high holds on
refinement," issue #403) **is now triggered**: this trial's own scores show
high holding within the rule's own band. Whether to act on that trigger is
outside this package's non-goals (run-phase decisions); it is flagged here
for whoever picks up that follow-on measurement.

**Total list-price spend, both rounds: $8.6144074** (round 1: $2.5095844,
all invalidated; round 2: $6.104823, comprising $3.174341 across H4-H6 plus
$2.930482 for the judge), against round 2's own $35 cap (round 1's spend is
not counted against it, per the amendment). The reused O1-O3 runs cost
nothing new today; their original $6.60 was #358's own spend.

## 2. Per-run table

All 9 launches (3 reused xhigh, 6 new high-effort), from `data.json`.
Score is the fresh judge pass (section 5); H1-H3 were invalidated before
blinding, so they were never judged and carry no score. Denials, spawns,
and word count are unscored context, not inputs to the decision rule.
Wall-clock and turns for H1-H3 are short because each died or was cut off
early (section 3); H4-H6's gate detail (effort, contamination) is in
section 4.

| Run | Arm | Score | Cost (list) | Output tok | Thinking tok | Wall | Turns | Denials | Spawns | Words |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | xhigh | 20/20 | $2.7167 | 59,608 | 46,740 | 9m50s | 49 | 1* | 0 | 2,689 |
| O2 | xhigh | 20/20 | $1.9748 | 48,801 | 38,320 | 7m38s | 36 | 1* | 0 | 2,439 |
| O3 | xhigh | 20/20 | $1.9110 | 42,594 | 32,069 | 7m24s | 38 | 2* | 0 | 2,628 |
| H1 | high | invalid, not scored | $0.1806 | 556 | 20 | 0m11s | 4 | 1 | 0 | n/a |
| H2 | high | invalid, not scored | $1.0894 | 15,184 | 8,169 | 2m52s | 26 | 1 | 0 | 1,622 |
| H3 | high | invalid, not scored | $1.2395 | 22,462 | 13,990 | 4m14s | 37 | 1 | 0 | 1,790 |
| H4 | high | 20/20 | $0.9441 | 16,999 | 10,431 | 3m08s | 22 | 1 | 0 | 1,900 |
| H5 | high | 20/20 | $1.1041 | 20,984 | 12,759 | 3m51s | 30 | 1 | 0 | 1,976 |
| H6 | high | 19/20 | $1.1261 | 22,353 | 13,645 | 4m23s | 33 | 1 | 0 | 2,023 |

* Raw recount from the #358 run logs (`result.permission_denials`);
#358's data.json recorded 0 for these runs.

## 3. Round 1 (H1-H3): what killed each high-effort run

**H1 - HTTP 429, individual spend limit.** Died at 4 turns, `is_error: true`,
`terminal_reason: "api_error"`, `api_error_status: 429`, `result`: "You've
hit your individual spend limit · run /usage-credits to raise it, or visit
claude.ai/admin-settings/usage · your session limit resets 4:50pm
(Europe/Berlin)." Cost $0.1806318 before failing. Per the protocol's "If
blocked" clause, marked invalid, not replaced; the developer stopped
launching further runs. On resume, the developer's own `date` command read
2026-09-28T14:52:04Z, past the reset time (14:50 UTC), independently
confirming the reset before H2 launched. Same class of availability event
as #358's F3 (an individual/session spend limit, not a per-model quota
message).

**H2 and H3 - contamination gate, a structural gap.** Both issued a `Glob`
call with `path` set to `/Users/TM/.cache/orchestrai-lead-trial` (the
parent enclosing both the 2026-09-23 and 2026-09-28 roots):

- H2: `{"pattern": "**/issues-open.json", "path":
  "/Users/TM/.cache/orchestrai-lead-trial"}`, and the result actually
  returned three matches, two under the 2026-09-23 sibling root
  (`_snapshot/issues-open.json` and `judge-repo/_snapshot/issues-open.json`,
  a real leak: the run learned a `judge-repo/` directory exists in the old
  root).
- H3: `{"pattern": "**/_snapshot*", "path":
  "/Users/TM/.cache/orchestrai-lead-trial"}`, and the result was "No files
  found."

Both were marked invalid, applying the gate's literal text (the input's
scope) rather than an effect-based reading, so H3 is not excused by its
pattern happening to match nothing. `--allowedTools` grants `Glob` by name
with no path restriction, unlike the `Bash(...)` entries, which restrict by
literal command-string prefix; a run that calls `Glob` with an absolute
path one level above its own trial root can sweep in a sibling directory
with nothing in the allowlist able to stop it. Not fixed for round 2 (see
section 4); reported here as a finding for any future trial reusing this
allowlist.

**A separate, non-invalidating hit:** H3 also read
`/Users/TM/.hermes/skills/autonomous-ai-agents/orchestrai/SKILL.md`, the
same `~/.hermes` filesystem-jail class #358 documented on F1, O1, and F2.
Not on this protocol's forbidden-path list, so it did not invalidate H3 on
its own.

Round 1 total: 0 of 3 valid, short of the decision rule's 2-valid floor, so
round 1's own result was "insufficient evidence, keep xhigh" with no judge
pass (skipped below that floor).

## 4. Round 2 (H4-H6): amendment and results

Decision to run one more round, logged on batch #403: round 1 measured
nothing and spend ($2.51) was far under the signed-off $10-20. Amendment 1
(full text in the protocol file) moved the trial root to
`~/.cache/orchestrai-lead-trial-r2/2026-09-28/`, a parent directory with no
2026-09-23 sibling, structurally removing the sweep that invalidated H2 and
H3, while leaving every other gate (including the contamination gate
itself, unchanged) and the frozen CLI block in place. The Glob-allowlist
gap itself was deliberately **not** fixed: tightening `--allowedTools`
mid-trial would change the high-effort arm's tool conditions relative to
O1-O3, which already ran under the unrestricted allowlist.

All three round-2 runs completed cleanly and passed every gate, including
the contamination gate: each run did issue at least one `Glob` call scoped
one level above its own trial root
(`/Users/TM/.cache/orchestrai-lead-trial-r2`), the same pattern as H2/H3,
but that parent directory contains only `2026-09-28`, so there was nothing
outside the run's own data for it to reach. No run read `~/.hermes`. No em
dashes or banned phrases in any of the three final messages.

Cost, wall-clock, turns, and denials for H4-H6 are in section 2's per-run
table. Gate detail (not part of that table): all three passed the effort
gate (H4 29 turns, H5 42 turns, H6 46 turns, all `perTurnEffort: high`) and
the contamination gate (clear on every run).

## 5. Judge

One fresh Sonnet judge pass (`claude-sonnet-5`, xhigh, `--output-format
json`), run outside both lead trial roots
(`~/.cache/orchestrai-judge/2026-09-28/judge-repo`), over all 6 valid
outputs: O1, O2, O3 (xhigh, reused from #358) plus H4, H5, H6 (high, round
2). $2.9304820000000005, 92 turns, 3 permission denials, parsed as valid
JSON on the first attempt, no retry needed.

**Redaction:** model names/IDs, `Generated with`/`Co-Authored-By` lines,
and every `redact.txt` host, checked against all 6 outputs. Nothing
matched in any of the 6 (same as #358's own experience with F1/F2/O1-O3):
no model self-identification, no attribution lines, no real-host mentions.
The new normalization step (run dates later than the snapshot, trial-root
paths) also found nothing to replace in H4-H6.

**Manual self-identification pass:** all 6 redacted files checked for
missed self-identification (a run naming its own capabilities or context
window); nothing found.

**Labels**, by sorted sha256 of the 6 redacted files: R1=H4, R2=O1, R3=O2,
R4=O3, R5=H5, R6=H6.

**Blinding-breach scan:** the judge's own CLI session log
(`~/.claude-work/projects/-Users-TM--cache-orchestrai-judge-2026-09-28-judge-repo/<SID>.jsonl`)
scanned for any tool input path under `orchestrai-lead-trial/`: 0 hits.

**Unblinding** happened only after the scores above were committed to
`data.json` (commit `5fd7648`).

### Scores

Scores are in section 2's per-run table. Label mapping (sorted sha256 of
the 6 redacted files): O1=R2, O2=R3, O3=R4, H4=R1, H5=R5, H6=R6.

**Judge-stability check** (not used in the decision rule, reported for
context): #358's own judge scored O1=20, O2=19, O3=20. This trial's fresh
pass scored O1=20, O2=20, O3=20, a 1-point move on O2 only, in the
direction that narrows this trial's own already-small gap. Both passes
agree O1 and O3 at 20/20.

## 6. Decision rule, applied

Per the protocol (unchanged from round 1) and amendment 1:

- Valid runs: xhigh (O1, O2, O3), high (H4, H5, H6). Both arms clear the
  2-valid floor (3 each), so the judge ran and the rule's substantive
  branches apply.
- **Condition 1 (score):** mean xhigh 20.0, mean high 19.6667, gap 0.3333.
  0.3333 <= 1.0: **holds**.
- **Condition 2 (cost):** mean xhigh cost $2.2008358667, mean high cost
  $1.0581136667, ratio 0.4807780910. 0.4808 <= 0.80: **holds**.
- Both hold: **switch**.

Cost recomputed independently for one round-2 run (H5), against the Opus
5.5 row of the (unchanged) price table: 32x$4 + 61,920x$8 + 944,692x$0.20 +
20,984x$20, all /1e6 = $0.000128 + $0.49536 + $0.1889384 + $0.41968 =
$1.1041064, matching `total_cost_usd` exactly.

## 7. Recommendation

**Switch.** `.claude/team-guide.md`'s Model policy section gets one
refinement-only note: `/tm-advisor` sections 1 (Refine) and 2 (Propose) may
run at `--effort high` instead of the session default `xhigh`, citing this
report; flip back to `xhigh` before replying "dispatch" (sections 3-6, and
every other seat, are unaffected and stay at their existing pins).
`tiers.lead` in `.claude/adapters/claude-code.json` and
`SEAT_EXPECTATIONS` in `effort-policy.test.mjs` are not touched: both are
guarded, and this package's own non-goals exclude run-phase decisions,
which is what a `tiers.lead` change would actually govern.

This result covers the refine-task only, at n=3 per arm, one task, one
judge model family, the same limitations #358's own report listed for its
Fable-vs-Opus comparison (section 10 there). The batch's deferred run-phase
measurement is now triggered per issue #403's own condition ("only if P1
shows high holds on refinement"); a separate package should measure high
vs. xhigh across the fuller kickoff run phase (parking, arbitration,
dispatch) before extending this refinement-only finding any further.

## 8. Limitations

- **Round 1's own limitations still apply to its own data**, though round
  1 contributes nothing to the final decision: the limit-death pause
  (independently confirmed against the account clock) and the contamination
  gate's literal-vs-effect reading choice for H3 (section 3). Neither
  changes round 2's result.
- **n=3 per arm, one task.** Same statistical caveat #358's own report
  named for its Fable-vs-Opus comparison: a small sample size, one
  refine-task probe, not a general claim about `--effort high` everywhere.
- Ceiling effect: 5 of the 6 judged outputs scored 20/20, and the one lower
  score (H6, 19/20) traces to a single factual error. With both arms at or
  near the rubric's ceiling, the score condition can show that high does
  not fall far below xhigh on this task, but it has little room to detect
  a smaller quality gap.
- **The Glob-allowlist gap is not fixed, by design** (section 4):
  round 2's isolation came from moving the trial root, not from
  restricting the tool. A future trial reusing this same command block
  should expect the same gap and either restrict `Glob`'s path or budget
  for another parent-directory move.
- **Two different trial roots** (`orchestrai-lead-trial/2026-09-28` for
  round 1, `orchestrai-lead-trial-r2/2026-09-28` for round 2) both start
  from the identical `pristine/`, `_snapshot/`, and `task-prompt.md`
  copies (hash-checked), so this is a location change only, not a change
  in frozen inputs.
- **Judge-stability check (section 5)** shows a 1-point move on O2 between
  #358's judge pass and this one; consistent with #358's own limitation
  that a single judge model provides no inter-rater agreement measure.
- **Everything #358's own report already listed as a limitation for O1-O3**
  (cache warmth, headless no-user-turns, the filesystem-jail gap on
  `~/.hermes`, one judge model family) still applies to the reused arm; see
  that report's section 10.

Context: the lead session that ran batch #403, including this package's
dispatches, itself ran at `high`, not the `xhigh` session default in
`.claude/team-guide.md`. `~/.claude-work/settings.json` sets a global
`effortLevel` of `xhigh` and a per-model
`modelSettings.claude-opus-5-5.effortLevel` of `high`, and the lead's CLI
session log records `perTurnEffort` `high` on every turn. The trial runs
were not affected: each valid run passed the per-run effort gate. Whether
to change that setting is the owner's call.

## 9. Reproduction

- BASE, snapshot, task-prompt, rubric hashes: unchanged from #358, listed
  in the protocol file; both trial roots (round 1 and round 2) hash-checked
  against the same values.
- Round 2 trial root layout: sibling structure to round 1's, at a
  different parent, not part of this PR (raw logs, transcripts, and the
  real Hermes provider host are never committed).
- Per-run raw log and stderr hashes, and the judge's own: `data.json`'s
  `runs[].raw_log_sha256` / `stderr_sha256` and `judge.raw_log_sha256` /
  `judge.stderr_sha256`.
- CLI command: the protocol file's "CLI" section (round 1) and amendment 1
  (round 2, path only differs), byte-identical to what ran, `$ID` swapped
  per run.
- Cost formula: section 6 above, reproducible from `data.json`'s `tokens`
  block per run against the Opus 5.5 row of `prices_usd_per_mtok`.
- Judge label-to-run mapping: `data.json`'s `judge.label_to_run_id`,
  reproducible from the sorted sha256 of the 6 redacted `_judge/R#.md`
  files (nothing changed by redaction in any of the 6, so their sha256
  equals their source `.output.md` files' own sha256).
