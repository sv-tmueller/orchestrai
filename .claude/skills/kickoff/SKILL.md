---
name: kickoff
description: Fan refined, sized GitHub issues out to the agent team. Runs each work package through implement, test, and review to a ready PR, in parallel waves. User-invocable only.
disable-model-invocation: true
argument-hint: <issue numbers | label:<name>>
---

You are the lead and the message bus. Agents cannot call each other; every
handoff is you routing one agent's report into the next agent's task. Keep
your own context lean: delegate the work, route the verdicts, decide the
escalations.

Packages to run: $ARGUMENTS (issue numbers, or `label:<name>` to select by
label). With no arguments, ask which issues to run.

## 1. Gate

For each issue, `gh issue view <n> --comments`, and
`gh pr list --state open --search "Closes #<n>"` to find an existing PR.

- Closed issues and issues labeled `needs-human` are skipped and listed in
  the report; resuming a `needs-human` package is the user's call.
- The issue must be sized. Unsized: park it (below); never guess a size.
- `size:L` or `size:XL` stops kickoff for that issue: dispatch the architect
  for a SPLIT_PROPOSAL and post it on the issue, unless a proposal comment
  already exists, then report it to the user.
- Resume detection: an issue with an open PR or the `in-progress` label is
  resumed, not restarted. A ready (non-draft) open PR means the package is
  complete: report it as awaiting merge and skip it. Otherwise read the
  sub-plan comment and the PR comments (verdicts and fix rounds live there)
  to find the stage it stopped at, and re-enter there; when in doubt,
  re-enter at the tester. Skip the architect when a sub-plan comment exists.
- Dependencies: parse literal `Blocked by: #N` lines in issue bodies. An
  issue whose blocker is not merged waits for a later wave.

## 2. Wave plan

Wave 1 is the issues with no open blockers; wave 2 is the issues blocked only
by wave 1, and so on. Present the plan (issues, sizes, parallelism, expected
PRs) and stop for the user's confirmation. This is the only confirmation in a
run; after it, run the wave unattended. Inside an /advisor batch the batch
sign-off replaces this confirmation; do not ask twice.

## 3. Per-package pipeline

Run up to 3 packages concurrently; dispatch their agents in parallel. A
larger queue (up to 6 inside an /advisor batch) starts the next package as
one finishes. Worktree isolation keeps packages apart. Within a package the
stages are serial:

1. Architect: SUB_PLAN for the issue. Post it as an issue comment. On
   NEEDS_DECISION: inside an /advisor batch, decide it yourself when it stays
   within the signed-off scope, logging the decision on the batch issue;
   otherwise park the package (below) and continue the others.
2. Label the issue `in-progress`. Dispatch the developer with the issue
   number and the sub-plan.
3. On DONE or DONE_WITH_CONCERNS: dispatch the tester with the branch and
   issue number, forwarding any concerns from NOTES.
4. On FAIL: post the tester's report as a PR comment with the round number,
   then send the findings verbatim to a fresh developer dispatch ("issue
   #<n>, branch <branch>: fetch it, work detached on it, fix exactly
   these"), then re-test.
5. On PASS: post the verdict as a PR comment, then dispatch the reviewer
   with the PR, the issue number, and the tester's UNTESTED CLAIMS, if any.
6. On CHANGES_REQUESTED: post the report as a PR comment with the round
   number, then the same fix loop with the must-fix findings, then re-test,
   then re-review.
7. On APPROVE with the full suite green: mark the PR ready (`gh pr ready`),
   remove `in-progress`, and post a summary comment on the issue, including
   should-fix findings and untested claims for the human review.

Routing rules:

- NEEDS_CONTEXT: answer from the issue, the sub-plan, and the repo docs. If
  you cannot, park the package.
- BLOCKED, or the developer pushes back on a finding: dispatch the architect
  for ARBITRATION. Post the outcome as a PR comment and include it in the
  next dispatch; an overruled finding is settled, do not re-raise it.
- If the architect's sub-plan says the work exceeds the size label, stop
  that package and report it (re-label and split per CLAUDE.md "Sizing").
- Never re-dispatch an unchanged prompt; something in the task must change
  first.
- Cap: 3 fix rounds per stage, counted from the PR comments. On exhaustion,
  park the package.
- Parking: post the open question or the exact state to the issue or PR,
  swap `in-progress` for `needs-human`, and move on to the other packages.
- Inside an /advisor batch, mirror lead decisions and package outcomes
  (PR ready, parked) to the batch tracking issue as they happen.

## 4. Wave end

Definition of done per package: tester PASS on the full suite, reviewer
APPROVE, PR ready with `Closes #N`, summary comment posted.

Report to the user: PRs ready for review, packages parked (`needs-human`,
with their open questions), and issues deferred to later waves or stopped at
the gate. The next wave needs this wave merged, and merging is the user's to
do, so end with: "merge these PRs, then run /kickoff again."
