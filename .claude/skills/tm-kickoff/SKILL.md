---
name: tm-kickoff
description: Fan refined, sized GitHub issues out to the agent team. Runs each work package through a developer, and a reviewer for bigger or risky work, to a ready PR. User-invocable only.
disable-model-invocation: true
argument-hint: <issue numbers | label:<name>>
---

You are reading this because the user typed the command, so this skill is
already loaded. Do not call the Skill tool for it. Start with the first step
below.

You are the lead and the message bus. Agents cannot call each other; every
handoff is you routing one agent's report into the next agent's task. Keep
your own context lean: delegate the work, route the verdicts, decide the
escalations. The flow is `docs/architecture/light-flow.md`; this skill is how
you run it. If the two disagree, the flow doc wins.

Packages to run: $ARGUMENTS (issue numbers, or `label:<name>` to select by
label). With no arguments, ask which issues to run. For `label:<name>`, run
`gh issue list --state open --label '<name>'` and use the issue numbers it
returns.

The run does not stop to ask the user. In-scope questions are decided and
logged; everything else parks and continues. Interrupt the user only if every
package parks at once.

## 1. Prepare

Create the labels the flow uses (`--force` makes a second run a no-op):

```
gh label create "size:S"      --color "c2e0c6" --description "Under 1 hour. One focused change." --force
gh label create "size:M"      --color "BFD4F2" --description "1 to 3 hours. Write a sub-plan first." --force
gh label create "size:L"      --color "F9D0C4" --description "4 to 6 hours. Split or checkpoint." --force
gh label create "size:XL"     --color "D93F0B" --description "About 8 hours. Too big. Split it." --force
gh label create "in-progress" --color "FBCA04" --description "Package dispatched by /kickoff; resume, do not restart." --force
gh label create "needs-human" --color "B60205" --description "Agent loop exhausted or blocked; human decision needed." --force
```

Then read each issue (`gh issue view <n> --comments`) and check it:

- Unsized, or `size:L` or `size:XL`: do not run it. Ask the architect for a
  `JOB: SPLIT_PROPOSAL` and report the split.
- An open `Blocked by: #N` line: skip it until #N has merged.
- An issue with no `## Approach` section in the body or the comments: you write
  one as an issue comment (a few bullets: the approach, the files expected to
  change, the verification step). The lead never dispatches a developer with no
  plan.

Run up to 3 packages at once and start the next queued one when one finishes.
Worktree isolation keeps packages apart. Within a package the steps are serial.

## 2. Per package

1. Label the issue `in-progress`. Dispatch the `developer` with the issue number.
2. Route the developer's report:
   - `DONE` or `DONE_WITH_CONCERNS`: go to the review gate.
   - `NEEDS_CONTEXT`: answer from the issue and the repo docs. If you cannot,
     park the package.
   - `BLOCKED`: park the package.
   - The work is bigger than its size label: park the package and say so.
3. Review gate. Dispatch the `reviewer` when any of these holds:
   - the issue is `size:M` or larger;
   - the diff (`gh pr diff <pr> --name-only`) touches `.claude/agents`,
     `.claude/skills`, `.claude/workflows`, `.github/workflows`, or a
     dependency manifest or lockfile;
   - the developer reported `DONE_WITH_CONCERNS`.

   Otherwise check that every command on the developer's `CHECKS` line exited
   0, post a PR comment `Review not required (size S)`, and ship.
4. Reviewer dispatch: give it the PR number and the issue number. Post its
   report verbatim as a PR comment, the next one numbered `Review round <k>`.
   - `APPROVE`: ship.
   - `CHANGES_REQUESTED`: dispatch a fresh developer with `issue #<n>, branch
     <branch>: fetch it, work detached on it, fix exactly these:` and the
     must-fix findings, then review again. At most 2 fix rounds. If the second
     re-review still asks for changes, park the package.
5. Ship (below).

A developer who disputes a finding: you decide. Ask the architect
(`JOB: ARBITRATION`) when unsure, post the outcome as a PR comment, and pass it
on in the next dispatch. An overruled finding is settled.

Should-fix findings and nits stay in the review comment and go no further. The
reviewer never files follow-up issues. File one yourself only for a real bug
found outside the PR's scope.

Do not send a seat the same prompt twice. A seat that returns nothing, or text
with no `STATUS:` or `VERDICT:` report, gets a `SendMessage` asking for its
report, not a new dispatch. A reviewer that dies on a usage limit is dispatched
again once on the `sonnet` model; say so in the PR comment.

## 3. Review gate on a resume

A session can drop at any point. Read GitHub state only:

- `in-progress` and no PR: restart the developer.
- A PR and no review comment: run the review gate (step 3). On a size S issue
  this still means the gate, not a new developer dispatch.
- A review comment (`Review round <k>`, or `Review not required`): continue
  from its verdict. Count the `CHANGES_REQUESTED` comments for the fix-round
  cap.

## 4. Ship

1. Read the head: `gh pr view <pr> --json headRefOid --jq .headRefOid`.
2. The reviewer's `CHECKS` line starts with the head SHA it tested. Post
   `orchestrai/review` only when that SHA equals the PR head. If the head moved
   since, do not post: dispatch the reviewer again on the new head. With no
   reviewer, the SHA is the head you just read.
   ```
   gh api -X POST 'repos/{owner}/{repo}/statuses/<sha>' -f state=success -f context=orchestrai/review -f description='approved by reviewer'
   ```
   For a package the gate skipped, use `-f description='not required (size S)'`.
   Do not wait for CI: auto merge waits for every required context.
3. `gh pr ready <pr>`.
4. If `gh api 'repos/{owner}/{repo}' --jq .allow_auto_merge` is `true`, queue the
   merge: `gh pr merge <pr> --squash --auto --match-head-commit <sha>`. Never
   `--admin`, and never merge without `--auto`. If the repo does not allow it or
   the call fails, leave the PR ready and report it as waiting for a human
   merge. That is not a park.
5. Remove `in-progress`. Post a short summary comment on the issue: the PR,
   the verdict, and queued or waiting for a human merge.

### A queued PR that falls behind main

The protection on `main` is strict, so a queued PR can fall behind it. Before
the wave ends, check each queued PR that has not merged
(`gh pr view <pr> --json mergeStateStatus,headRefOid`). For `BEHIND`, the lead
runs `gh api -X PUT repos/{owner}/{repo}/pulls/<n>/update-branch -f expected_head_sha=<head>`,
reads the new head, re-posts `orchestrai/review` on the new head as in step 2
(the approval carries over a clean merge from main), and queues auto merge
again with that head. If the update conflicts, a developer dispatch resolves it
(`issue #<n>, branch <branch>: merge origin/main and resolve the conflicts`),
then the review gate runs again on the new head. A second conflict parks the
package.

## 5. Park

Post the reason on the issue, add `needs-human`, remove `in-progress`, and move
on to the other packages. Inside an `/tm-advisor` batch, mirror each outcome
(merged, queued, waiting for a human merge, parked) to the batch issue as it
happens, so a dropped session can resume from it.

## 6. Wave end

When every package is shipped or parked, print:

```
## What happened
- PR #NN queued  - <package title>
- PR #NN waiting for a human merge (<reason>)  - <package title>
- #NN parked (needs-human): <the open question>

## Next steps
1. Review and merge: #NN (only PRs waiting for a human merge)
2. Decide on #NN (retry or close)
```
