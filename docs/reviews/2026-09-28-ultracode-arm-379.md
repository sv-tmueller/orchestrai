# Ultracode arm on a replayed #379: report - 2026-09-28

Issue #405, batch #403 (P2). Pre-registered protocol and its amendments and
both run results:
[2026-09-28-ultracode-arm-379-protocol.md](2026-09-28-ultracode-arm-379-protocol.md).
No separate data file: every run's identifiers, gates, and cost are
recorded inline in the protocol file's own result sections, in commit
order, per its section 9.

## 1. Bottom line

**One valid arm run exists: run 2 (2026-09-29), the package's n=1 result. It
passed every pre-registered gate but did not finish: Claude Code's 600-second
background-task ceiling ended the session while its review workflow ran,
before the lead's stated wrap-up.** The probe cleared its own park condition
(`--effort ultracode`
activates cleanly in headless `-p` mode). The $40-capped arm then ran
twice against the pre-merge #379 replay (base
`aba6cb4eb93074b54f1324a90269e570b7755d5b`, frozen batch #371 transcript
input):

- **Run 1** (`--permission-mode dontAsk`): completed, but a built-in
  Claude Code protection on writes to `.claude/` (a protected path, like
  `.git`) silently denied 7 of 9 `Write` calls and the only `Edit` call.
  Since #379's entire deliverable lives under `.claude/`, the run ended
  with nothing committed and no real product diff. **Invalid as evidence
  about ultracode**, kept here as the documented first attempt (full
  detail: protocol file, "Arm run 1"). The pre-registered rules gave no
  retry for this case: only a 429 or a wall-clock kill gets one (section
  8), a gate failure is "invalid, not replaced" (section 4), and section 8
  (a) treats even a capped run with an empty diff as the n=1 result. Run 2
  exists because the owner chose option (a) on the park question, which
  also set aside the issue's non-goal of more than one ultracode run.
- **Run 2** (`--permission-mode auto`, Amendment 2's fix, verified in a
  $0.27 diagnostic before use, launched by the owner from their own
  terminal): **valid under the gates, cut short (section 5).** RC 0, 1996 s wall-clock,
  `total_cost_usd` 12.76833. It authored and ran one `Workflow`
  (`tm-token-report-review`, 7 subagents across 2 phases), produced a full
  product diff (18 files, 1057 insertions, 5 deletions against the base),
  and passed every isolation, contamination, and permission gate,
  including the new zero-`.claude/`-denial gate Amendment 2 added after
  run 1. The background `Workflow` was killed by Claude Code's own
  600-second default wait ceiling before it finished its own review and
  before the arm's session ever saw the result; full detail below and in
  the protocol file's "Arm run 2 result."

AC 2: run 2's Write, Edit, and Bash writes, from the lead and all 7
workflow subagents, stayed inside `repo/`. Run 1 wrote one scratch script
outside its clone (`/tmp/tm-survey/survey.mjs`). No setting in either run
blocks writes outside the clone, so run 2's clean record is observed, not
enforced.

**Total list-price spend, all sessions: $17.87343** (probe $0.2866, ten
isolation/permission diagnostics $0.9047, arm run 1 $3.9138, arm run 2
$12.76833). The probe ($0.2866) stayed well inside its $3 cap, and run 2
($12.77) stayed well inside its $40 cap. This
figure covers only the arm-under-test; it excludes `tm-review-changes`
(section 7), which ran later in the lead's own session and cannot be
priced with the merged, non-recursive `token-report.mjs` (reported in
tokens instead, section 7).

`tm-review-changes` has since run on run 2's diff (section 7): **approve**,
0 must-fix, 1 should-fix (untested failure paths), 4 nits. AC 4 is met.

## 2. Probe (AC 1)

Full detail, gates, and the evidence-(a)-absent/evidence-(b)-present
reasoning are in the protocol file's "Probe result" section; summarized
here. Session `935bb48c-1f0d-424b-bcc5-bf70ee52981a`: 48 seconds, 9 turns,
$0.2866, `terminal_reason: "completed"`. No `Workflow` tool call (evidence
(a) absent: the model judged the trivial probe task too small for a
dynamic workflow). Evidence (b) present in the first assistant turn: an
explicit, non-team-guide-derived self-reference to ultracode's own
task-sizing guidance. Per the protocol, evidence (b) alone clears the
park condition. The probe's own plugin-off gate failed (the `orchestrai`
plugin was still loaded); this led directly to Amendment 1, before the arm
ran. Run 2 later gives the probe's missing case for free: it authored a
real `Workflow` for a substantive task, so evidence (a) is now also
established for at least one task shape.

AC 1 asks about the `ultracode` prompt keyword. The probe did not test it:
the fetched docs describe ultracode as a session setting (`--effort
ultracode`, `/effort ultracode`, or `"ultracode": true`), so the probe and
both arm runs used the flag (protocol, first section). Whether a prompt
keyword does anything stays untested, and the team guide's description of
ultracode as "a prompt keyword or `/effort` menu option" disagrees with
those docs; that needs a follow-up issue, not an edit here.

## 3. Isolation and permission findings (Amendments 1 and 2)

Full detail, verbatim doc quotes, and the exact diagnostic commands are in
the protocol file's "Amendment 1" and "Amendment 2" sections; summarized
here.

1. The plugin-off `--settings` override needed both `orchestrai@orchestrai`
   and `orchestrai@synced` keys together (an account-synced plugin instance
   answers to the second, not the first). Confirmed clean on both arm
   runs' init events.
2. A bare `Read` or `Grep` name in `--allowedTools` bypasses
   `permissions.blockReadsOutsideWorkingDirectories`. Fix, verified: omit
   both from `--allowedTools`; `dontAsk` and `auto` both still
   auto-approve in-working-directory reads without a bare grant, and the
   block setting then correctly denies (not merely fails to find) anything
   outside it.
3. `.claude/` is a built-in protected path, like `.git`. `dontAsk` mode
   hard-denies every protected-path write with no override (confirmed by
   testing an explicit grant, which had no effect); this is what crippled
   run 1, unrelated to ultracode or to contamination. `--permission-mode
   auto` instead routes a protected-path write to a classifier, and in a
   non-interactive `-p` session with nothing to prompt, a classifier block
   "doesn't run and Claude keeps working" rather than hanging. Verified in
   a $0.27 diagnostic before the retry, and confirmed on run 2 itself:
   zero `.claude/`-path denials.
4. The replay clone kept its local `main` branch at `8e60a31`, which
   contains the merged #384, so the reference was reachable with `git show
   main:<path>` under the allowed `Bash(git *)`. The path-based
   contamination gate would not catch that. Checked afterward: no tool
   input in either arm run, or in run 2's 7 workflow subagents, names
   `main`, `.git/`, the merge commit, or the reference file paths. Future
   replays should delete every ref except the detached base.

## 4. Run 2: metrics (sub-plan section 6)

| Metric | Value |
| --- | --- |
| Session | `ae287ce2-613e-4077-9de8-9d9681a2ca3b` |
| Result | RC 0, `stop_reason: end_turn`, wall-clock 1996 s (33.3 min) |
| Cost (measured, list price) | $12.76833 |
| Agents spawned | 8 (1 lead + 7 workflow subagents) |
| Workflows authored | 1: `tm-token-report-review` (2 phases: Review x4 dimensions, Verify x up to 4 skeptics; 7 of 8 possible agent slots dispatched, 1 skipped by design) |
| Model, all 8 agents | `claude-opus-5-5` (uniform; no per-model pin) |
| Effort, lead | `ultracode` via `--effort ultracode`; the lead transcript records `perTurnEffort: xhigh` on every turn, so no logged field tells ultracode from plain `xhigh` |
| Effort, 7 subagents | `high`, explicit (`perTurnEffort` in every subagent transcript, matching the workflow source's `effort: 'high'` on both `agent()` calls) |
| Diff size | 18 files changed, 1057 insertions(+), 5 deletions(-) vs base |
| `npm test` at the arm's tip (scoring copy) | 361 tests, 0 failures |
| #379 ACs met | 6 of 6 on the letter; AC 4 with a confirmed integration gap (section 6) |

The lead ran at ultracode/`xhigh`; the workflow it authored pinned its own
worker stages down to plain `high`, one level under the parent, on the
same model rather than a cheaper one. This is a partial instance of
`team-guide.md`'s "pin worker stages to a cheap model at high effort"
pattern for hand-written workflows (effort pinned, model left uniform),
produced here by the model's own choice under ultracode, not by a human
author following that rule.

**Cost cross-check, a live finding.** The merged reference's own
`token-report.mjs` (`.claude/skills/tm-kickoff/`), run against this exact
session, reports only the lead: 63 calls, an estimated $4.28. Its
subagent lookup is not recursive, so it never reaches
`subagents/workflows/<run-id>/agent-*.jsonl`, and it misses all 7 workflow
subagents, about half of the run's real spend: the result event's lead-only
`usage` block prices at $6.34 list, which leaves about $6.43 of the measured
$12.77 for the workflow (the $4.28 lead figure is a visible-output estimate
without the lead's 74,775 thinking tokens). The arm's *own*
`token-report.mjs` (a different file, under `.claude/scripts/`, chosen
independently of the reference) does recurse, and its own source comment
names this exact scenario: "workflow agents write to
subagents/workflows/<run>/agent-*.jsonl". Run against the same session it
reports 8 agents, 215 calls, $7.48 input cost, $1.25 output estimate
($8.73 total). The remaining $4.04 gap to the measured $12.76833 is all on
the output side: the estimate prices $1.25 of $5.30 measured output cost,
and thinking tokens (135,422 across the session, about $2.71) are most of
what it leaves out, by design and as it states. In short: the tool this
issue built cannot see a workflow-fanned-out run's own cost unless it
recurses into `subagents/workflows/`, and only the arm's own
(non-reference) implementation does.

## 5. Run 2: the 600-second background kill

`Workflow` runs as a background task; Claude Code's own default wait
ceiling for a background task still running when the main turn tries to
end is 600 seconds. The workflow launched about 1346 s (67%) into the
run's 1996 s wall-clock; the transcript's last visible assistant/user
content is 43 s later (the session ending its own turn right after
kicking the review off in the background, `Workflow`'s documented async
pattern). The workflow itself ran for 643 s total before being killed for
exceeding the ceiling. So roughly 600 s (30%) of the total wall-clock is
idle lead time: from the lead's last message at 11:23:13 to the kill at
11:33:14, the CLI only waited on the background task.

At the kill, of the workflow's 7 dispatched agents: the 4 Review-phase
agents (`review:recompute`, `review:spec`, `review:code`,
`review:integration`) had all completed; of the 3 Verify-phase skeptics
dispatched, `verify:spec` and `verify:integration` had completed and
`verify:code` was mid-tool-call (16 calls in). `verify:recompute` was
never dispatched because `review:recompute` found zero findings.
`review:integration`'s finding (the `--session <id>` escape hatch in the
SKILL.md wiring is not practically actionable by the lead) was
**CONFIRMED** by its skeptic; `review:code`'s finding (non-ISO or
no-offset `--since`/`--until` parsed as local time) was still being
checked when the kill happened.

**The lead never consumed the workflow's result.** The transcript ends at
the kill: a `task_notification` (`status: stopped`) immediately followed
by the session's own terminal `result` event, with no further assistant
turn reading the task's output file or acting on it. No commit followed.
This is not one of the protocol's pre-registered end states (section 8:
budget cap, 429, or the 90-minute wall-clock ceiling), so it does not
invalidate the run by itself; it is reported as a finding. For the
fan-out/agent-count reading, it means ultracode's own orchestration did
fan out and mostly finish its work in this run, but the harness's default
background-task patience is shorter than a real multi-agent review
workflow needs, which cost the run its own wrap-up and its three findings
without any of them reaching the record.

## 6. Run 2: scoring against PR #384

Reference: PR #384, merge commit `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589`,
base `aba6cb4eb93074b54f1324a90269e570b7755d5b`. Scored on a copy of the
arm's finished `repo/` (never the trial directory itself), with the arm's
uncommitted working tree committed so `base..HEAD` is its diff, and
`npm test` run at that tip (see section 4's table).

| AC | Status | Evidence |
| --- | --- | --- |
| Written TDD against fixture transcripts; de-duplicated by message id; fixtures include the start-of-response snapshot | Met | `.claude/workflows/__tests__/token-report.test.mjs` (343 lines) against synthetic fixtures under `fixtures/token-report/`; the script dedupes "one call per message id"; the fixture's own doc comment describes a start-of-response-only line plus a later final line for the same id |
| Output grouped by role and by model, including the lead | Met | Manual run against the arm's own session: by-role table has `lead` and `workflow-subagent` rows; by-model table has `claude-opus-5-5` |
| Price table is a data file; unknown models unpriced, never guessed | Met | `.claude/scripts/model-prices.json`; cost is `null` unless `Object.hasOwn(models, call.model)` |
| tm-kickoff and tm-advisor post the report at wave end or batch report | Met, with a caveat | Both SKILL.md files wire the script in; the arm's own review (`review:integration`, CONFIRMED by its skeptic) found the `--session <id>` escape hatch is not practically actionable by the lead as written, a real gap the run never got to fix before the kill |
| #371 baseline recorded under `docs/research/` from a real run | Met | `docs/research/2026-09-29-batch-371-token-baseline.md`, quotes only the script's own aggregate output, reconciles against the issue's own $25-31/53.6M figures and explains the gap (issue drafted mid-way through the #378 refinement) |
| `npm test` is green | Met | 361 tests, 0 failures, at the arm's tip in the scoring copy |

All six ACs are met on the letter; one (posting the report) carries a real,
self-identified integration gap that the run's own review confirmed and
did not get to fix. Deviation from protocol section 5: no separate scoring
session ran; the developer who wrote this report scored the ACs directly
on the scoring copy.

**How the arm's solution differs from the reference (PR #384):**

- Script location: `.claude/scripts/token-report.mjs` (arm) vs
  `.claude/skills/tm-kickoff/token-report.mjs` (reference).
- Price file: `.claude/scripts/model-prices.json` (arm) vs
  `.claude/skills/tm-kickoff/token-prices.json` (reference).
- CLI: the arm's script reads `CLAUDE_CONFIG_DIR` from the environment and
  has no `--config-dir` flag; the reference takes an explicit
  `--config-dir` argument. The arm's script also supports `--json`; the
  reference does not.
- Subagent discovery: the arm's script recurses
  (`readdirSync(subagentDir, { recursive: true })`) and explicitly targets
  workflow-nested transcripts in its own source comment; the reference
  looks only directly in `<session>/subagents/agent-*.jsonl` and misses
  workflow-spawned agents entirely (section 4's cost cross-check).
- Role granularity: the arm buckets every workflow subagent under one
  generic `workflow-subagent` role (from the transcript sidecar's
  `agentType`), rather than by the workflow's own per-dimension labels
  (`review:recompute`, etc.); still grouped by role and model as AC 2
  requires, just coarser than the reference's per-`subagent_type`
  breakdown would be for a `tm-kickoff`-dispatched agent.

**#400 checked:** closed 2026-09-29 with a completed report
(`docs/reviews/2026-09-28-ab-native-vs-kickoff.md`), but that replay is on
issue #362, not #379. No kickoff-arm result exists for #379 to compare
against, so this stays reference-only against PR #384, the protocol's
default.

## 7. `tm-review-changes` on the arm's diff: run and result

**AC 4 is met.** The prior developer dispatch could not launch
`tm-review-changes` as a child CLI session (its own sandbox denied the
command line before it could start, on the same class of ground as its
earlier `[Auto-Mode Bypass]` denials). The lead ran it instead, in-session,
after owner approval, rather than a further child-process attempt:

- The lead made a throwaway git worktree of this repo, detached at base
  `aba6cb4eb93074b54f1324a90269e570b7755d5b`, and applied the arm's diff
  from the previous developer's scoring copy (`git diff --binary aba6cb4
  226de7f`, the arm's uncommitted working tree committed as one throwaway
  commit) as one local commit `858cfc6` (18 files, +1057 -5, matching
  section 4's diff-size figure). It ran the
  workflow in-session from that worktree with `args: { base:
  'aba6cb4eb93074b54f1324a90269e570b7755d5b' }`. No child CLI session was
  launched, and the throwaway worktree has since been removed. This also
  set aside section 6's isolation (fresh headless session, plugin off, no
  gh or web, restricted tools): the review ran with the lead's plugin and
  tools, in a worktree whose refs include the merged #384. Checked
  afterward: no review agent's tool input names the reference script, its
  price table, or the merge commit.
- Workflow version: `.claude/workflows/tm-review-changes.js` is
  byte-identical at the base commit and on `origin/main` (last changed in
  `41f3fc5`), so the production version ran, unmodified in substance.
- One adaptation, logged as a deviation: the current Workflow runtime
  refused the production file both by name ("not found") and by path
  ("`export const meta = { name, description, phases }` must be the FIRST
  statement in the script"), because the file computes `meta` from a
  `SPEC` constant on line 43. The lead ran a copy with `meta` hoisted to a
  literal first statement and every other byte unchanged (self-checked).
  The same computed-`meta` pattern is in all three production workflows
  (`tm-map-codebase.js:54`, `tm-review-changes.js:43`,
  `tm-review-codebase.js:62`), so all three likely fail to load under the
  current Workflow runtime. Whether the runtime or the files are at fault
  is not settled here. It is out of scope for #405 and needs its own
  issue.

**Run stats.** 8 agents (7 Sonnet dimension workers: bugs, security,
scope, tests, style, docs, perf; 1 Opus critic that consolidates), 3 of
the 8 (security, style, docs) returned empty findings, 650,996 ms
wall-clock, 678,834 subagent tokens, 162 tool uses. Journal (one result
line per agent):
`~/.claude-work/projects/-Users-TM-Desktop-github-orchestrai/c5168e00-8b3d-486c-9ad3-d2f4cd14cb6a/subagents/workflows/wf_dbb9188f-59a/journal.jsonl`.

**Verdict: approve.** 0 must-fix, 1 should-fix, 4 nits, 2 dismissed.
`npm test` at the arm's tip: 361 tests, 0 failures (matching section 4 and
section 6's own figure).

- **Should-fix:** the failure path of `main()` (`findLeadTranscript` ->
  `readSession`/`loadPrices` -> `buildReport`, exit 1 with a
  `token-report: <message>` stderr line) has no test. The CLI tests only
  cover argument errors (exit 2). This matters because both SKILL.md
  changes in the diff rely on this script failing gracefully ("If the
  script fails, say so in the report; never hold the report for it."),
  and that exit-code/stderr contract is unverified.
- **Nits:** (1) `parseArgs` takes the next argv element as a flag's value
  even when it is itself a flag (`--session --json` silently sets
  `session` to `"--json"`); (2) `inputTokens()` computes a 5-minute
  cache-write bucket by subtraction with no guard against a negative
  result if a future or malformed usage record ever reports the 1-hour
  figure larger than the total (latent, not observed in about 50k real
  records checked); (3) `AGENT_TOOLS` includes `'Task'` (the older name of
  the Agent tool) with no comment explaining why; (4) the mixed
  priced/unpriced `money()` branch's rendered `+ unpriced` suffix is
  exercised by the fixture but never asserted in the markdown tests.
- **Dismissed:** a micro-optimization (re-parsing cached timestamp strings
  in a hot loop that runs at most a few thousand times) and the "drop
  `Task` entirely" half of the `AGENT_TOOLS` finding (it is genuine
  backward-compatibility, not dead configurability).

**On the missing plugin-version bump.** The critic did not flag that the
diff changes files under `.claude/skills/` without bumping `plugin.json`,
reasoning that `scripts/check-version-bump.mjs` does not exist at the
diff's base and CI does not check versions. Checked independently: this is
accurate, and it is not a divergence the arm introduced. `check-version-
bump.mjs` was added later, by #386 (`0a34bf2`), and does not exist at
`aba6cb4e...`. The merged reference itself, PR #384
(`1b4b8c5f5c95d28f06b417cf862b253bb7e3e589`), also never touched
`plugin.json` despite changing `.claude/skills/tm-advisor/SKILL.md` and
`.claude/skills/tm-kickoff/SKILL.md`. So the arm and the human-accepted
reference behave identically on this point; the critic's non-flag matches
the actual rule in force at that point in history, not a gap specific to
the arm.

**Relation to section 5's killed internal review.** This is a separate pass
from the arm's own `Workflow` (`tm-token-report-review`, section 5), which
the lead never saw finish. Both read the same arm tree, through different
dimensions. The arm's workflow has no overall verdict: it was killed with
`verify:code` unresolved. This pass's should-fix (untested failure path of
`main()`) and the arm's confirmed `--session <id>` finding are different
findings that both touch what happens when the script cannot find the lead
transcript.

**Cost.** Not folded into section 1's or section 4's dollar totals: the
review ran inside the lead's own session
(`c5168e00-8b3d-486c-9ad3-d2f4cd14cb6a`), not in the arm, and the merged
tool cannot price it. `.claude/skills/tm-kickoff/
token-report.mjs` (the merged, non-recursive tool) run against that
session sees only the lead transcript and its one direct developer
dispatch ($6.33 combined); it does not recurse into
`subagents/workflows/wf_dbb9188f-59a/`, so it cannot price the review's own
8 agents at all, the exact limitation section 4 already documents for the
arm's own workflow. The review's own spend is therefore reported in tokens
only: 678,834 subagent tokens, 162 tool calls, 650,996 ms wall-clock
(above), not a list-price dollar figure.

## 8. Verdict on "No session-wide ultracode"

The team-guide's rule cites `docs/reviews/2026-06-30-orchestration-comparison.md`,
whose only trial data is a hand-authored stand-in for an ultracode-style
workflow on Sonnet 5, not a live ultracode session. This package adds the
first live ultracode data point: one single-arm run on Opus 5.5, against a
real, previously merged task:

- Ultracode activates and runs headlessly on Opus 5.5 (the probe, and run
  2's own `--effort ultracode`).
- On a substantive, real task, the session authored one dynamic `Workflow`
  and fanned out 7 subagents across 2 phases; 6 finished and 1 was cut off
  by the 600-second background-task ceiling. This shows ultracode's
  orchestration can fire headlessly on Opus 5.5. No plain-`xhigh` control
  ran, so the authoring is attributed to ultracode by the flag, not by
  comparison.
- The fan-out pinned its own worker stages to a lower effort (`high`
  against the parent's `xhigh`/ultracode) but not a cheaper model. It cost
  about half the run (about $6.43 of $12.77). Its one confirmed finding
  never reached the lead, so that spend changed nothing in the delivered
  diff.
- The account's own plugin-off and read-boundary isolation mechanisms
  needed non-obvious fixes to work at all in headless mode (Amendment 1),
  and a built-in protected-path rule under `dontAsk` mode produced a false
  negative on run 1, unrelated to ultracode (Amendment 2).
- The tool this same issue built to measure spend does not, in its merged
  form, see a workflow's own fanned-out subagents at all; only the arm's
  own (non-reference) version of that tool does. Any future cost
  accounting for an ultracode-authored workflow needs the recursive
  lookup, or it will silently under-report by the workflow's whole share.
- `tm-review-changes` (section 7), run afterward by the lead on the same
  diff, returned **approve**, 0 must-fix, one should-fix (untested failure
  paths in the same script).

This is one illustrative run (n=1), not a statistically powered trial.
**The rule stands.** This run could not contradict it: it ran ultracode on
a one-off heavy task with no tm- script (Skill was disallowed), which is
the exception the rule already allows, not session-wide use across the
tm- flows. What it adds: ultracode fan-out on Opus 5.5 is real and pins its
own worker effort, it cost about half of this run, and in an unattended
headless run its output can be lost to the 600-second background-task
ceiling (both workflows in this package, the arm's own and
`tm-review-changes`, ran past 600 s). Run 1 adds no ultracode evidence: its
writes were blocked before the implementation existed, so it never reached
the review stage where run 2 authored its workflow. No `team-guide.md`
edit.

## 9. Files, order, constraints

Per the protocol's section 9: this report and the protocol file (with its
two amendments and two run-result sections) are the only two files this
package adds to `docs/`. No `ab-tests.md` row (not a paired comparison).
No `.claude/` changes and no `team-guide.md` edit. `npm test` is green in
this developer's own checkout throughout, and separately green (361
tests) in the scoring copy of the arm's own diff.
