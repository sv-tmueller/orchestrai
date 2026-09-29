# Ultracode arm on a replayed #379: report - 2026-09-28

Issue #405, batch #403 (P2). Pre-registered protocol and its amendments and
both run results:
[2026-09-28-ultracode-arm-379-protocol.md](2026-09-28-ultracode-arm-379-protocol.md).
No separate data file: every run's identifiers, gates, and cost are
recorded inline in the protocol file's own result sections, in commit
order, per its section 9.

## 1. Bottom line

**One valid, complete arm run exists: run 2 (2026-09-29), the package's n=1
result.** The probe cleared its own park condition (`--effort ultracode`
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
  detail: protocol file, "Arm run 1").
- **Run 2** (`--permission-mode auto`, the owner's own fix, verified in a
  diagnostic before use): **valid and complete.** RC 0, 1996 s wall-clock,
  `total_cost_usd` 12.76833. It authored and ran one `Workflow`
  (`tm-token-report-review`, 7 subagents across 2 phases), produced a full
  product diff (18 files, 1057 insertions, 5 deletions against the base),
  and passed every isolation, contamination, and permission gate,
  including the new zero-`.claude/`-denial gate Amendment 2 added after
  run 1. The background `Workflow` was killed by Claude Code's own
  600-second default wait ceiling before it finished its own review and
  before the arm's session ever saw the result; full detail below and in
  the protocol file's "Arm run 2 result."

**Total list-price spend, all sessions: $17.87343** (probe $0.2866, ten
isolation/permission diagnostics $0.9047, arm run 1 $3.9138, arm run 2
$12.76833). Well inside the $3 probe cap; run 2's own $40 cap was never
approached (it ended on a normal `end_turn`, not the budget cap).

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

## 4. Run 2: metrics (sub-plan section 6)

| Metric | Value |
| --- | --- |
| Session | `ae287ce2-613e-4077-9de8-9d9681a2ca3b` |
| Result | RC 0, `stop_reason: end_turn`, wall-clock 1996 s (33.3 min) |
| Cost (measured, list price) | $12.76833 |
| Agents spawned | 8 (1 lead + 7 workflow subagents) |
| Workflows authored | 1: `tm-token-report-review` (2 phases: Review x4 dimensions, Verify x up to 4 skeptics; 7 of 8 possible agent slots dispatched, 1 skipped by design) |
| Model, all 8 agents | `claude-opus-5-5` (uniform; no per-model pin) |
| Effort, lead | `ultracode` (`--effort ultracode`, session-wide) |
| Effort, 7 subagents | `high`, explicit (`perTurnEffort` in every subagent transcript, matching the workflow source's `effort: 'high'` on both `agent()` calls) |
| Diff size | 18 files changed, 1057 insertions(+), 5 deletions(-) vs base |
| `npm test` at the arm's tip (scoring copy) | 361 tests, 0 failures |

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
subagents, about two-thirds of the run's real spend. The arm's *own*
`token-report.mjs` (a different file, under `.claude/scripts/`, chosen
independently of the reference) does recurse, and its own source comment
names this exact scenario: "workflow agents write to
subagents/workflows/<run>/agent-*.jsonl". Run against the same session it
reports 8 agents, 215 calls, $7.48 input cost, $1.25 output estimate
($8.73 total). The remaining gap to the measured $12.76833 is thinking
tokens (135,422 across the session), which the visible-output estimate
excludes by design and states as a limitation. In short: the tool this
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
exceeding the ceiling. So roughly 650 s (33%) of the total wall-clock is
dead time: the CLI waiting on a background task with nothing left for the
lead to do.

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
did not get to fix.

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

## 7. `tm-review-changes`: blocked, not run

Attempted once, from this developer's own session, against a committed
copy of the arm's diff, with the permission stance the sub-plan specifies
(default permission mode, read-only tools, plugin off, no `gh`, no web).
This developer's own sandbox denied the command before it could launch,
on the same class of ground as the developer's earlier `[Auto-Mode
Bypass]` denials in the park comment: a permission check refused to run a
command line naming `git` operations inside a child-process argument
string, even though those arguments were a `--allowedTools` allowlist for
the child, not a git invocation by this session itself. Per the sub-plan's
own instruction, no reword, split, or retry was attempted.

**Unreviewed.** The scoring copy is at
`/private/tmp/claude-501/-Users-TM-Desktop-github-orchestrai/c5168e00-8b3d-486c-9ad3-d2f4cd14cb6a/scratchpad/arm2-copy`,
committed at base `aba6cb4eb93074b54f1324a90269e570b7755d5b`. That path is
this session's own scratch directory and may not persist; recreating it is
cheap (`cp -R` from the still-intact
`~/.cache/orchestrai-ultracode-arm/2026-09-28/repo`, `git add -A`, one
throwaway commit). The workflow file that would run is
`.claude/workflows/tm-review-changes.js`, unchanged by the arm, at commit
`41f3fc595578bc2ea141ac5a9703999e1eb52e33` (blob
`0f940c3f2314a0846d0db3ffb164bc4684ebe73e`).

## 8. Verdict on "No session-wide ultracode"

The team-guide's rule rests on a 2026-06-30 trial measuring over-spawning
under a Sonnet-5-led ultracode session. This package adds one same-model,
single-arm data point on Opus 5.5, against a real, previously-merged task,
with a completed run:

- Ultracode activates and runs headlessly on Opus 5.5 (the probe, and run
  2's own `--effort ultracode`).
- On a substantive, real task, ultracode did author a dynamic `Workflow`
  and fan out 7 subagents across 2 phases, all but one either completing
  or nearly completing before a harness-level timeout ended the run. This
  is evidence *for* ultracode's own orchestration working as documented,
  not against it.
- The fan-out pinned its own worker stages to a lower effort (`high`
  against the parent's `xhigh`/ultracode) but not a cheaper model; the
  spend it added ($8.49 of the run's $12.77, on the arm's own accounting)
  bought a real review pass that found one confirmed, live defect in the
  arm's own deliverable, which the run never got to fix because Claude
  Code's own 600-second background-task ceiling killed it first, not
  because the workflow was unproductive.
- The account's own plugin-off and read-boundary isolation mechanisms
  needed non-obvious fixes to work at all in headless mode (Amendment 1),
  and a built-in protected-path rule under `dontAsk` mode produced a false
  negative on run 1, unrelated to ultracode (Amendment 2).
- The tool this same issue built to measure spend does not, in its merged
  form, see a workflow's own fanned-out subagents at all; only the arm's
  own (non-reference) version of that tool does. Any future cost
  accounting for an ultracode-authored workflow needs the recursive
  lookup, or it will silently under-report by the workflow's whole share.

This is one illustrative run (n=1), not a statistically powered trial. It
does not contradict "no session-wide ultracode" outright (a single
observation of productive fan-out is not the same claim the 2026-06-30
trial made about over-spawning, and this run's own background-task kill
shows a real, separate operational cost of running a multi-agent
`Workflow` headlessly and unattended). But it also does not confirm the
rule the way run 1 alone would have (run 1 measured a harness
protected-path block, not ultracode). Read together, this package's
evidence is: ultracode-driven fan-out on Opus 5.5 is real, can be
productive, and carries a harness-level unattended-run risk (the
background-task ceiling) this protocol had not previously named. No
`team-guide.md` edit: this single run does not contradict the existing
rule, but the finding is new enough to flag rather than file away
silently.

## 9. Files, order, constraints

Per the protocol's section 9: this report and the protocol file (with its
two amendments and two run-result sections) are the only two files this
package adds to `docs/`. No `ab-tests.md` row (not a paired comparison).
No `.claude/` changes and no `team-guide.md` edit. `npm test` is green in
this developer's own checkout throughout, and separately green (361
tests) in the scoring copy of the arm's own diff.
