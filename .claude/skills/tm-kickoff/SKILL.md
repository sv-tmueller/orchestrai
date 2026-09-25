---
name: tm-kickoff
description: Fan refined, sized GitHub issues out to the agent team. Runs each work package through implement, test, and review to a ready PR, in parallel waves. User-invocable only.
disable-model-invocation: true
argument-hint: <issue numbers | label:<name>>
---

You are reading this because the user typed the command, so this skill is
already loaded. Do not call the Skill tool for it. Start with the first step
below.

You are the lead and the message bus. Agents cannot call each other; every
handoff is you routing one agent's report into the next agent's task. Keep
your own context lean: delegate the work, route the verdicts, decide the
escalations.

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
gh label create "in-progress"  --color "FBCA04" --description "Package dispatched by /kickoff; resume, do not restart." --force
gh label create "needs-human"  --color "B60205" --description "Agent loop exhausted or blocked; human decision needed." --force
```

`--force` upserts: it creates each label when absent and sets identical values when present, so a second run (including the advisor→kickoff double-run in a batch) is a true no-op and exits 0.

For each issue, `gh issue view <n> --comments`, and
`gh pr list --state open --limit 100 --json number,isDraft,closingIssuesReferences --jq '.[] | select(.closingIssuesReferences[]?.number == <n>)'`
to find an existing PR.

- Closed issues and issues labeled `needs-human` are skipped and listed in
  the report; resuming a `needs-human` package is the user's call.
- The issue must be sized. Unsized: park it (below); never guess a size.
- `size:L` or `size:XL` stops kickoff for that issue: dispatch the architect
  for a SPLIT_PROPOSAL (prefix the message with `JOB: SPLIT_PROPOSAL`) and
  post it on the issue, unless a proposal comment already exists, then report
  it to the user.
- Resume detection: an issue with an open PR or the `in-progress` label is
  resumed, not restarted. A ready (non-draft) open PR means the package is
  complete: report it as awaiting merge and skip it, unless its latest
  review comment carries the `Model: sonnet (run-long fallback)` marker, in
  which case it owes an Opus review and re-enters at the reviewer stage (see
  "Limit deaths" below). If the issue carries `in-progress` but has no open
  PR and no branch on origin, clear the label and restart from the developer
  stage. Otherwise (a PR or branch exists) read the sub-plan comment and the
  PR comments (verdicts and fix rounds live there) to find the stage it
  stopped at, and re-enter there; re-enter at the tester only when the stage
  cannot be determined from the PR comments. Skip the architect when a
  sub-plan comment exists.
- Dependencies: parse literal `Blocked by: #N` lines in issue bodies. An
  issue whose blocker is not merged waits for a later wave.

## 2. Wave plan

Wave 1 is the issues with no open blockers; wave 2 is the issues blocked only
by wave 1, and so on. Present the plan (issues, sizes, parallelism, expected
PRs) and stop for the user's confirmation. This is the only confirmation in a
run; after it, run the wave unattended with no questions to the user mid-run.
Inside an /tm-advisor batch the batch sign-off replaces this confirmation; do
not ask twice.

## 3. Per-package pipeline

The run does not stop to ask the user. In-scope questions are decided and
logged; everything else parks-and-continues. Interrupt the user only if every
package parks at once.

Before every agent dispatch in this pipeline, including fix-round
re-dispatches and arbitration dispatches, print the
plan-status block described in team-guide.md. The items are fixed to the
five pipeline stages below (sub-plan, develop, test, review, PR ready);
annotate fix rounds on the current item. When dispatching agents for several
packages in one message, print one block per package.

Run up to 3 packages concurrently; dispatch their agents in parallel. When
the queue is larger (up to 6 in an /tm-advisor batch), start the next queued
package as one finishes. Worktree isolation keeps packages apart. Within a
package the stages are serial:

1. Architect: SUB_PLAN for the issue (prefix the message with `JOB: SUB_PLAN`).
   Post it as an issue comment. On NEEDS_DECISION: inside an /tm-advisor batch,
   decide it yourself when it stays within the signed-off scope, logging the
   decision on the batch issue; outside an /tm-advisor batch, park the package
   (below) and surface the question in the wave-end report, then continue the
   others.
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
   number, then send the must-fix findings to a fresh developer dispatch in
   the same format as step 4, then re-test, then re-review forwarding the
   tester's UNTESTED CLAIMS from the new re-test (not the previous round's
   claims).
7. On APPROVE, with the last tester verdict PASS: mark the PR ready (`gh pr
   ready`), remove `in-progress`, and post a summary comment on the issue,
   including should-fix findings and untested claims for the human review. If
   the last tester verdict is not PASS (fix round not yet re-tested), complete
   the test loop first before shipping.

Routing rules:

- NEEDS_CONTEXT: answer from the issue, the sub-plan, and the repo docs. If
  you cannot, park the package.
- BLOCKED: park the package (below) immediately; BLOCKED means the developer
  cannot proceed, not a disagreement.
- Developer pushes back on a finding: dispatch the architect for ARBITRATION
  (prefix the message with `JOB: ARBITRATION`). Post the outcome as a PR
  comment and include it in the next dispatch; an overruled finding is settled,
  do not re-raise it.
- If the architect's sub-plan says the work exceeds the size label, stop
  that package and report it (re-label and split per CLAUDE.md "Sizing").
- An architect or reviewer dispatch dies on an Opus limit: see "Limit
  deaths (run-long fallback and resume)" below. Workflow critic stages
  recover on their own (criticWithFallback, also sonnet); this rule covers
  lead dispatches only.
- Never re-dispatch an unchanged prompt; something in the task must change
  first.
- Cap: 3 fix rounds per stage, counted from the PR comments. Tester and
  reviewer each have their own independent counter. A step-6 re-test FAIL
  (tester fails after a reviewer fix round) re-enters the step-4 loop and
  increments the tester counter. On exhaustion of either counter, park the
  package.
- Parking: post the reason on the issue, apply `needs-human` (remove
  `in-progress` if present), and move on to the other packages.
- Inside an /tm-advisor batch, mirror lead decisions and package outcomes
  (PR ready, parked) to the batch tracking issue as they happen.

### Limit deaths (run-long fallback and resume)

A limit death is an agent dispatch that dies on an exhausted quota (the
limit error, or an empty return while the model is exhausted), not a normal
verdict. This is lead policy layered on top of the per-dispatch `retry` in
`adapter-interface.md`; it changes no agent contract.

**Run.** One `/tm-kickoff` invocation, or one /tm-advisor batch run up to
its report, is a run. A resumed session is a new run and tries Opus first
again.

**Switch.**

- The first architect or reviewer death on an Opus limit is re-dispatched
  with a per-call Sonnet override (the Agent tool's `model` param, value
  `sonnet`).
- Every later judgment dispatch in the run goes straight to Sonnet.
- An in-flight Opus dispatch that dies the same way after the switch fired
  goes to Sonnet too, with no second decision entry.
- The run never goes back to Opus.
- Frontmatter pins and the session model never change. The xhigh effort pin
  still applies.

**One decision entry per run.** Post it once, when the switch fires: on the
batch issue inside an /tm-advisor batch, otherwise on the package issue
whose dispatch died first.

- Later fallbacks in the same run get no new decision entry.
- Every fallback verdict or sub-plan comment carries the marker line
  `Model: sonnet (run-long fallback)` in the comment header, next to the
  round number. The report body stays verbatim; the marker never goes
  inside it.

**Re-run on Opus.** "Once quota returns" means the next run: probing Opus
mid-run would contradict "the run never goes back to Opus." The debt is the
Opus review of the PR head. A Sonnet sub-plan or arbitration is covered by
that review and is not re-run by itself.

- In the next run, it is an ordinary review.
- On CHANGES_REQUESTED, run `gh pr ready --undo`, then the normal fix loop.

**Resume before respawn.** After a limit death, once the lead can dispatch
again, it makes one `SendMessage` to the same agent ID. The plan-status
block is annotated `(resumed)`.

- Respawn fresh if the agent cannot be addressed, `SendMessage` errors, or
  the resumed agent dies again or returns nothing usable.
- A judgment seat's Opus-limit death skips the resume and goes straight to
  the Sonnet respawn: a resumed agent keeps its exhausted model.
- The respawn prompt adds one line naming the limit death and what the dead
  attempt left on origin.

**Counters.** A quota or limit death is not a finding. It posts no round
comment and never advances a fix-round counter. The resumed or respawned
dispatch keeps the same round number. A fallback verdict counts as a normal
round.

## Worktree cleanup (deterministic)

The `developer` and `tester` run with Agent `isolation: worktree`, but the
isolation does not reliably separate the working tree: a dispatched agent's
`git checkout`/`git switch` can land on the lead's shared checkout. That is the
mechanical cause of the tangle, and it hits every checkout-running agent, not
just one (observed live on issue #78: the `tester`'s `git checkout --detach
FETCH_HEAD` left the lead's checkout detached at the branch tip). The agents
publish to origin, so their work is safe there regardless; what leaks into the
lead's checkout is a moved HEAD, sometimes a local branch, and a worktree
registered under `.claude/worktrees/`. The `developer` fresh path uses a
detached checkout instead of `git switch -c`, so it no longer leaves a stale
local branch (the worst residue, a clobber risk against the good remote branch);
the moved HEAD and the registered worktree are harness-side and cannot be
prevented by agent commands, so the lead reverses them deterministically.

At wave end, with no agents in flight, run from the lead's main checkout:

```
git worktree prune                 # safe anytime; drops entries for gone worktrees
git worktree list                  # expect only the main repo
git status --short --branch        # expect the default branch, clean tree
```

Remove anything still registered under `.claude/worktrees/`
(`git worktree remove --force <path>`). If the lead's HEAD was moved off the
default branch, return to it with `git switch <default>` (the lead's own checkout, the one
place that command is right). Delete a stray local
package branch only when its work is safe on origin (`git ls-remote --exit-code
origin <branch>` succeeds), then `git branch -D <branch>`; never delete a branch
whose commits are not on origin. Do not run `remove` or `branch -D` mid-wave:
they must not touch a worktree another concurrent package is still using.

## 4. Wave end

Definition of done per package: last tester verdict is PASS, reviewer
APPROVE, PR ready with `Closes #N`, summary comment posted.

Before reporting, run the worktree cleanup above (no agents in flight) so the
lead's checkout is left on the default branch with a clean tree.

Report to the user: PRs ready for review, packages parked (`needs-human`,
with their open questions), and issues deferred to later waves or stopped at
the gate. End with:

```
## What happened
- PR #NN ready  - <package title>
- PR #NN ready  - <package title>
- #NN parked (needs-human): <the open question>
- Run-long fallback fired on #NN: judgment switched to Sonnet, see <decision comment link>  (only if the switch fired this run)

## Next steps
1. Review & merge: #NN, #NN
2. Decide on #NN (retry or close)
3. /tm-kickoff #NN to re-review on Opus before merge  (only for packages with an owed Opus review)
4. Run /tm-kickoff to start the next wave
```
