---
name: tm-ab-test
description: Run a paired A/B comparison of two orchestration-variant arms on the same task. Forks both from one base commit, runs them sequentially (headless or human-supervised), records agent count, wall-clock time, token usage, diff size, and an independent review pass per arm, then writes a dated report and appends one ledger row. User-invocable only.
disable-model-invocation: true
argument-hint: <task-issue-number> <arm-A-name>:headless|supervised <arm-B-name>:headless|supervised
---

You are reading this because the user typed the command, so this skill is
already loaded. Do not call the Skill tool for it. Start with the first step
below.

You are the lead, running a paired comparison, not a new pipeline. Every
step below sequences existing bounded machinery (`/tm-kickoff`, a tm-
workflow, or a single role-agent dispatch); this skill adds no new agent
and no new workflow script.

Input: $ARGUMENTS (the task issue number, then one `<name>:<mode>` pair per
arm; mode is `headless` or `supervised`). With missing or unclear
arguments, ask for the task issue number and, for each arm, its name, a
one-line description of what it varies, and its mode.

An arm is a name, a free-form description, and a mode:

- **headless**: you drive it end to end (a kickoff-pipeline run, a tm-
  workflow, or a single developer dispatch), whichever matches what the arm
  varies.
- **supervised**: the arm needs a session-level setting (ultracode, a
  non-default effort level) that you cannot turn on for yourself. Emit
  `templates/supervised-arm-runbook.md`, filled with this arm's base
  commit and worktree, and hand it to the human. Wait for the filled
  recording checklist before continuing.

## 1. Gate

Ensure the `ab-test` label exists:

```
gh label create "ab-test" --color "5319E7" --description "Scratch issue driving one arm of a tm-ab-test run." --force
```

Record the base commit both arms fork from: `git fetch origin`, then
`git rev-parse origin/main` (or `origin/HEAD` if the default branch is not
`main`). Every arm forks a worktree from this exact commit, and no merge
may land on `main` between arms; a merge mid-run moves the base out from
under the later arm and invalidates the pairing.

## 2. Arm isolation

For each arm whose work is issue-driven (drives `/tm-kickoff`, or any
machinery that reads an issue's sub-plan comments and PRs), open its own
scratch issue so the two arms never share GitHub state:

```
gh issue create --title "AB #<task-issue>-arm-<a|b>: <task title>" \
  --body "<task issue body, copied verbatim>" \
  --label "ab-test" --label "<task's size label>"
```

Copy the task's size label onto the scratch issue as well as `ab-test`.
Kickoff's sizing gate parks any issue it cannot size, so an unsized scratch
issue stalls the arm.

Branches are namespaced automatically: a developer dispatch on a scratch
issue branches from that issue's own number, so arm A and arm B never
collide on a branch name even when their task titles match.

Every developer-dispatch arm gets a scratch issue, single-shot included.
Per `.claude/agents/developer.md`, a developer dispatch always reads an
issue's sub-plan comment as its spec, derives its branch from that issue's
number, posts a sub-plan comment if none exists, and opens a PR with
`Closes #<n>`. A raw developer arm run on the original task issue would do
all of that on the task issue itself, breaking the "stays untouched"
invariant below. Only a direct workflow invocation, which takes a base ref
instead of an issue, needs no scratch issue; just record its base commit
and window in the checklist.

The original task issue stays untouched throughout: no label, no comment,
until a human reads the report and picks a winner.

## 3. Run the arms, sequentially

Run arm A to completion (including its recording, step 4 below) before
starting arm B. Arms never run concurrently: overlapping arms would
distort wall-clock and token numbers through quota and CPU contention.

For a headless arm: drive it yourself in that arm's own worktree, forked
from the base commit. Before every agent dispatch inside the arm (a
kickoff-pipeline stage, a workflow stage, or a single role-agent dispatch),
print the pre-dispatch plan-status block per issue #249: which of this
run's steps are done, which the dispatch is about to start, which remain.

If an arm, a probe or a judge pass runs as its own `claude -p` process, walk
"Headless `claude -p` checklist" below before launching it.

For a supervised arm: hand off per the runbook above and wait.

## 4. Record

Fill one copy of `templates/recording-checklist.md` per arm as it runs
(for a headless arm, you fill it; for a supervised arm, the human fills it
and hands it back). The checklist pins the exact commands for base commit,
window, token usage, agent count, diff size, and the independent review
pass; run each one, do not estimate. For a `claude -p` arm, record cost per
the checklist's cost items below.

## 5. Report and ledger

Once both arms are recorded, write the report from `templates/report.md`
to `docs/reviews/YYYY-MM-DD-ab-<task-slug>.md`. Mark each arm's status as
run headless, run supervised, or not run. Link both arms' draft-PR diffs.
Then append one row to `docs/reviews/ab-tests.md`: date, task, arms,
headline numbers, and a link to the new report. Never edit a past ledger
row or a past report; the ledger only appends.

## 6. Cleanup

Close each arm's scratch issue and its draft PR once both diffs are linked
in the report. For worktree and branch cleanup, follow `tm-kickoff`
SKILL.md's "Worktree cleanup (deterministic)" section; it is not repeated
here.

## Headless `claude -p` checklist

Applies whenever an arm, a probe or a judge pass runs as its own `claude -p`
process, as in the three trials of 2026-09-28 (#400, #404, #405). It is
separate from the `headless` arm mode above, where you drive the arm in your
own session. Each item gives the trap, the fix (with the gate that proves
the fix held), and the source. Report files are under `docs/reviews/`
(`ab-native-vs-kickoff` is #400, `lead-effort-comparison` is #404,
`ultracode-arm-379` is #405). Use placeholders in anything you write down:
no local paths, no settings values, no provider hosts.

### Before launch

- **Every plugin copy disabled.**
  - Trap: disabling only `orchestrai@orchestrai` left the account-synced copy
    `orchestrai@synced` loaded. Either key alone failed in diagnostics.
  - Fix: pass one `--settings` JSON that sets every orchestrai key the init
    event's `plugins[]` reports to false, merged with your other settings
    keys. Gate: the init event (`type: system`, `subtype: init`) lists zero
    `orchestrai:` skills or agents. If it lists any, fix and relaunch before
    the run counts.
  - Source: #400 report "The 11 deviations" items 1 and 5; #405 report
    section 3 item 1; #405 protocol "Probe result", "Amendment 1" item 1.
- **`dontAsk` silently denies writes under `.claude/`.**
  - Trap: `.claude/` is a built-in protected path. `dontAsk` denies every
    write there, no allow rule overrides it, and the run still ends RC 0
    `completed`. #405 run 1 lost 7 of 9 Writes and its only Edit, committed
    nothing and was invalid ($3.91).
  - Fix: use `--permission-mode auto` for any session that may write
    `.claude/`; keep `dontAsk` for read-only sessions. Never use bypass
    flags. Gate: zero Write or Edit denials on `.claude/` paths in the
    result event's `permission_denials`. Modes:
    https://code.claude.com/docs/en/permission-modes
  - Source: #405 report section 1 and section 3 item 3; #405 protocol
    "Amendment 2". Related: #400 "The 11 deviations" item 8 (the judges
    needed `auto`).
- **The 600 s background ceiling cuts off a workflow.**
  - Trap: a `Workflow` run is a background task. When the main turn ends with
    one still running, `-p` waits up to 600 s of idle time, then stops it and
    drops its partial result. #405 run 2: the review workflow was killed at
    643 s, the lead never read its result, one confirmed finding and the
    planned fix commit were lost, and about 600 of 1,996 s were idle.
    Signature: the stderr line `Background tasks still running after 600s;
    terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait
    indefinitely.`, and a `task_notification` with `status: stopped` just
    before the final `result` event. Judge passes are exposed too:
    `tm-review-changes` took 651 s in #405.
  - Fix (documented, checked 2026-10-01): set
    `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, the ceiling in milliseconds on
    idle waiting for background subagents and workflows after the final turn
    (default `600000`; `0` waits indefinitely; needs Claude Code v2.1.182 or
    later). Idle time restarts each time Claude takes a turn to handle a
    background result. Docs: https://code.claude.com/docs/en/env-vars and
    https://code.claude.com/docs/en/headless#background-tasks-at-exit.
    Set it inside the `env -i` wrapper; anything set outside is dropped (the
    #400 deviation 2 trap, hit with `GH_CONFIG_DIR`). With `0`, keep an outer
    `timeout`. Treat a run that shows the stderr line as cut short. Do not
    rely on a prompt line such as "wait for the workflow"; no trial tested it.
  - Source: #405 report section 5; #405 protocol "Arm run 2 result"; #400
    "The 11 deviations" item 5.
- **The `Glob` allowlist gap.**
  - Trap: `--allowedTools` grants `Glob` by name with no path limit (unlike
    `Bash(...)` entries). In #404 round 1, H2 and H3 globbed one level above
    the trial root and reached a sibling root, leaving 0 of 3 runs valid.
    From #405: a bare `Read` or `Grep` in `--allowedTools` bypasses
    `permissions.blockReadsOutsideWorkingDirectories`, and a diagnostic read
    the reference solution that way.
  - Fix: set `blockReadsOutsideWorkingDirectories: true` in `--settings`.
    Leave `Read` and `Grep` out of `--allowedTools` (in-directory reads are
    still approved); `Glob` can stay, since it respects the block. As a second
    layer, keep the trial root's parent directory empty except for this run.
    Expect some Bash `safetyCheck` denials on computed paths (19 in #405
    run 2); they are friction, not a failure.
  - Source: #404 report sections 3 and 8; #404 protocol "Amendment 1" ("Not
    applied"); #405 report section 3 item 2; #405 protocol section 3 "Known
    gap" and "Amendment 1" item 2.
- **The reference reachable through refs.**
  - Trap: #405's clone kept local `main` at a commit after the merge, so
    `git show main:<path>` exposed the reference. Path-based gates cannot see
    that.
  - Fix: keep only the detached base commit. Gate: `git rev-list --all |
    grep -qx <reference merge sha>` finds nothing.
  - Source: #405 report section 3 item 4; #400 protocol section 2 (clone
    recipe and gate).
- **A spend-limit 429 mid-run.**
  - Trap: it happened in all three trials (#400 arm A run 2, #404 H1, one
    #405 diagnostic). The restart overhead biases the arm that died.
  - Fix: decide in advance whether a 429 run is invalid and not replaced, or
    resumed. Record the reset time, leave the wait out of wall-clock, name
    the bias in the report, and commit each run's record before the next run
    starts.
  - Source: #400 "The 11 deviations" item 7 and "Limit event"; #404 report
    section 3; #405 protocol "Amendment 1", last paragraph.
- **A config-dir effort override.**
  - Trap: the config dir's `settings.json` can keep a per-model `effortLevel`,
    and stream-json has no effort field.
  - Fix: pass `--effort` explicitly and pin `modelSettings` in `--settings`.
    Gate: `perTurnEffort` in `$CLAUDE_CONFIG_DIR/projects/<slug>/<sid>.jsonl`
    has at least one value and every value matches. Ultracode records as
    `xhigh`.
  - Source: #404 protocol "New gates per high run" and report section 8
    "Context"; #405 protocol "Documented ultracode syntax" and section 7.

### Recording cost

- **Cost is cumulative across `--resume`.**
  - Trap: each invocation's `result` event carries `total_cost_usd` and
    `modelUsage` for the whole session so far, so summing across invocations
    double-counts.
  - Fix: take the last `result` event per session id and add only across
    distinct ids. A kickoff resume after a limit death starts a new id (#400
    arm A had two). The top-level `usage` block is per invocation and covers
    the lead only; `modelUsage` also covers subagents.
  - Source: #400 report "Per-pair comparison" (after the "Cost, three ways"
    table) and "Cost-measurement gap"; #405 protocol "Arm run 2 result".
- **`modelUsage` vs `token-report.mjs`.**
  - Trap: the script estimates output as visible characters divided by 4 and
    leaves out thinking. Measured output was 3.76x the estimate on #400 arm A
    and 4.40x on arm B, so the cost ratio read 0.62 on the estimate and 0.71
    measured. A script version that does not read `subagents/workflows/`
    also misses workflow agents: $4.28 reported against $12.77 measured in
    #405.
  - Fix: the measured figure above is the cost of record. Report the script's
    number only as a labeled estimate, and never compare one arm's estimate
    with the other arm's measured figure. Before a workflow run, check that
    the script in use reads `subagents/workflows/`. Enforce spend caps against
    measured cost (#400's $35 stop rule used the estimate).
  - Source: #400 report "Cost-measurement gap" and "How adjusted R was
    computed"; #405 report section 4 "Cost cross-check".

### Judging

- **A judge checkout must reproduce the runs' layout.**
  - Trap: #404's judge copy nested `_snapshot/` inside `judge-repo/`, but in
    the runs it sat next to `repo/`. The judge marked H6's true path claim
    false, which cost H6 its only lost point.
  - Fix: build the judge's checkout so every relative path the runs saw
    resolves the same way. Otherwise normalize those paths during redaction
    and log each replacement.
  - Source: #404 report section 8, "Judge-checkout layout mismatch".

## Report to the user

- The report path and its headline-numbers table.
- The ledger row appended.
- Any arm that stayed "not run" (a supervised arm still waiting on a
  human), so the run is clearly incomplete rather than silently dropped.
