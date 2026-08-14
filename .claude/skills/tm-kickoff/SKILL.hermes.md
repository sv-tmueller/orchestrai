---
name: tm-kickoff
description: "Fan refined, sized GitHub issues out to the agent team via Hermes delegate_task. Runs each work package through implement, test, and review to a ready PR. User-invocable only."
---

You are the lead and the message bus. Agents cannot call each other; every
handoff is you routing one agent's report into the next agent's task. Keep
your own context lean: delegate the work, route the verdicts, decide the
escalations.

You are running on Hermes. The role agents are dispatched via delegate_task.
The agent prompts live at .claude/adapters/prompts/<role>.md and are loaded
automatically by the Hermes adapter. The adapter table at
.claude/adapters/hermes.json maps tiers to models (GLM-5-2 for judgment and
lead, a cheaper model for worker when available).

Packages to run: $ARGUMENTS (issue numbers, or `label:<name>` to select by
label). With no arguments, ask which issues to run.

If the packages argument begins with `label:`, run
`gh issue list --state open --label '<name>'` and treat the returned issue
numbers as the packages list before proceeding.

## 1. Gate

Ensure the canonical label set exists on this repo before any dispatch:

```
gh label create "size:S"       --color "c2e0c6" --description "Under 1 hour. One focused change." --force
gh label create "size:M"       --color "BFD4F2" --description "1 to 3 hours. Write a sub-plan first." --force
gh label create "size:L"       --color "F9D0C4" --description "4 to 6 hours. Split or checkpoint." --force
gh label create "size:XL"      --color "D93F0B" --description "About 8 hours. Too big. Split it." --force
gh label create "in-progress"  --color "FBCA04" --description "Package dispatched; resume, do not restart." --force
gh label create "needs-human"  --color "B60205" --description "Agent loop exhausted or blocked; human decision needed." --force
```

For each issue, `gh issue view <n> --comments`, and
`gh pr list --state open --limit 100 --json number,isDraft,closingIssuesReferences --jq '.[] | select(.closingIssuesReferences[]?.number == <n>)'`
to find an existing PR.

- Closed issues and issues labeled `needs-human` are skipped and listed in
  the report; resuming a `needs-human` package is the user's call.
- The issue must be sized. Unsized: park it; never guess a size.
- `size:L` or `size:XL` stops kickoff for that issue: dispatch the architect
  for a SPLIT_PROPOSAL (prefix the message with `JOB: SPLIT_PROPOSAL`) and
  post it on the issue, unless a proposal comment already exists, then report
  it to the user.
- Resume detection: an issue with an open PR or the `in-progress` label is
  resumed, not restarted. A ready (non-draft) open PR means the package is
  complete: report it as awaiting merge and skip it. If the issue carries
  `in-progress` but has no open PR and no branch on origin, clear the label
  and restart from the developer stage. Otherwise (a PR or branch exists)
  read the sub-plan comment and the PR comments to find the stage it stopped
  at, and re-enter there; re-enter at the tester only when the stage cannot
  be determined from the PR comments. Skip the architect when a sub-plan
  comment exists.
- Dependencies: parse literal `Blocked by: #N` lines in issue bodies. An
  issue whose blocker is not merged waits for a later wave.

## 2. Wave plan

Wave 1 is the issues with no open blockers; wave 2 is the issues blocked only
by wave 1, and so on. Present the plan (issues, sizes, parallelism, expected
PRs) and stop for the user's confirmation. This is the only confirmation in a
run; after it, run the wave unattended with no questions to the user mid-run.

## 3. Per-package pipeline

The run does not stop to ask the user. In-scope questions are decided and
logged; everything else parks-and-continues. Interrupt the user only if every
package parks at once.

Run up to 3 packages concurrently via parallel delegate_task dispatches.
Within a package the stages are serial:

### Stage 1: Architect (SUB_PLAN)

Dispatch the architect via delegate_task with the goal:
`JOB: SUB_PLAN\n\nIssue #<n>: <issue title and body>`

Post the resulting sub-plan as an issue comment:
`gh issue comment <n> --body "<sub-plan>"`

On NEEDS_DECISION: park the package and surface the question in the
wave-end report, then continue the others.

### Stage 2: Developer (implement)

Label the issue `in-progress`:
`gh issue edit <n> --add-label in-progress`

Dispatch the developer via delegate_task with the goal:
`Issue #<n>, branch feat/<n>-<slug>: implement per the sub-plan. The sub-plan comment is your spec. Use TDD. Run the full check suite before reporting.`

On DONE or DONE_WITH_CONCERNS: proceed to tester.
On NEEDS_CONTEXT: answer from the issue, the sub-plan, and the repo docs. If
  you cannot, park the package.
On BLOCKED: park the package immediately.

### Stage 3: Tester (verify)

Dispatch the tester via delegate_task with the goal:
`Branch <branch>, issue #<n>: verify the change. Run the full check suite and attack the change.`

On FAIL: post the tester's report as a PR comment with the round number, then
send the findings verbatim to a fresh developer dispatch, then re-test.
On PASS: proceed to reviewer.

### Stage 4: Reviewer (review)

Dispatch the reviewer via delegate_task with the goal:
`PR #<pr>, issue #<n>: review the diff against the issue and sub-plan. Two passes: spec compliance then code quality.`

Forward any UNTESTED CLAIMS from the tester's report.

On CHANGES_REQUESTED: post the report as a PR comment with the round number,
then send the must-fix findings to a fresh developer dispatch, then re-test,
then re-review.
On APPROVE: proceed to ship.

### Stage 5: Ship

On APPROVE with the last tester verdict PASS:
`gh pr ready <pr>` (mark the PR ready for review)
`gh issue edit <n> --remove-label in-progress`
Post a summary comment on the issue.

### Routing rules

- Developer pushes back on a finding: dispatch the architect for ARBITRATION
  (prefix the message with `JOB: ARBITRATION`). Post the outcome as a PR
  comment.
- If the architect's sub-plan says the work exceeds the size label, stop
  that package and report it.
- Never re-dispatch an unchanged prompt; something in the task must change
  first.
- Cap: 3 fix rounds per stage, counted from the PR comments. On exhaustion,
  park the package.
- Parking: post the reason on the issue, apply `needs-human` (remove
  `in-progress` if present), and move on.

## 4. Wave end

Definition of done per package: last tester verdict is PASS, reviewer
APPROVE, PR ready with `Closes #N`, summary comment posted.

Report to the user: PRs ready for review, packages parked (`needs-human`,
with their open questions), and issues deferred to later waves or stopped at
the gate. End with:

```
## What happened
- PR #NN ready  - <package title>
- PR #NN ready  - <package title>
- #NN parked (needs-human): <the open question>

## Next steps
1. Review & merge: #NN, #NN
2. Decide on #NN (retry or close)
3. Run /tm-kickoff to start the next wave
```
