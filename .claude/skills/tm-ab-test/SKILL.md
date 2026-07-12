---
name: tm-ab-test
description: Run a paired A/B comparison of two orchestration-variant arms on the same task. Forks both from one base commit, runs them sequentially (headless or human-supervised), records agent count, wall-clock time, token usage, diff size, and an independent review pass per arm, then writes a dated report and appends one ledger row. User-invocable only.
disable-model-invocation: true
argument-hint: <task-issue-number> <arm-A-name>:headless|supervised <arm-B-name>:headless|supervised
---

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

Record the base commit both arms fork from: `git rev-parse origin/main`
(or `origin/HEAD` if the default branch is not `main`). Every arm forks a
worktree from this exact commit.

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

An arm that is not issue-driven (a direct workflow invocation, or a
single-shot developer dispatch you drive by hand) needs no scratch issue;
just record its base commit and window in the checklist.

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

For a supervised arm: hand off per the runbook above and wait.

## 4. Record

Fill one copy of `templates/recording-checklist.md` per arm as it runs
(for a headless arm, you fill it; for a supervised arm, the human fills it
and hands it back). The checklist pins the exact commands for base commit,
window, token usage, agent count, diff size, and the independent review
pass; run each one, do not estimate.

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

## Report to the user

- The report path and its headline-numbers table.
- The ledger row appended.
- Any arm that stayed "not run" (a supervised arm still waiting on a
  human), so the run is clearly incomplete rather than silently dropped.
