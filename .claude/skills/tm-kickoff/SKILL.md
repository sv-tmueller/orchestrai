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
gh label create "phase:architect" --color "C5DEF5" --description "The architect stage currently holds this issue." --force
gh label create "phase:developer" --color "C5DEF5" --description "The developer stage currently holds this issue." --force
gh label create "phase:tester"    --color "C5DEF5" --description "The tester stage currently holds this issue." --force
gh label create "phase:reviewer"  --color "C5DEF5" --description "The reviewer stage currently holds this issue." --force
gh label create "track:lean"   --color "D4C5F9" --description "The package runs the lean track (no sub-plan, no tester)." --force
gh label create "runner"       --color "BFDADC" --description "Marks a runner presence issue." --force
gh label create "runner:on"    --color "0E8A16" --description "The runner is switched on and claims work." --force
gh label create "runner:off"   --color "E99695" --description "The runner is switched off and claims nothing." --force
```

`--force` upserts: it creates each label when absent and sets identical values when present, so a second run (including the advisor→kickoff double-run in a batch) is a true no-op and exits 0.

The runner-derived labels (`run:<runner>` and `claimed:<runner>`) are not
listed above: runner ids come from each repo's `columns.json`, so the lead
creates them on demand at first use, with the same `--force` upsert. The
poller keeps `runner:on`/`runner:off`; the others are the lead's or the
poller's per the design's label table (relai
`2026-11-04-agent-board-design.md` section 6).

**Adapter table (once per run).** Resolve the adapter table and its dispatch
mode before any dispatch:

- The file name is `CLAUDE_CODE_ADAPTER_TABLE`, default `claude-code.json`, a
  bare `*.json` name with no path.
- Project shadowing: a table under the project's `.claude/adapters/` with the
  same bare file name beats the plugin's copy in
  `${CLAUDE_PLUGIN_ROOT:-.claude}/adapters/`. Resolve the winning path once
  and keep it for the run.
- Read the winning table's `dispatch` field once. `agent` (the default, and
  the value when the field is absent) runs today's pipeline byte-for-byte
  unchanged. `subprocess` switches every lead-executed seat dispatch in the
  run to the spawn module; see "Subprocess seat dispatch (adapter tables)"
  in section 3.

One table per run; all packages in the run use it. A table that cannot be
read, or whose host is not `claude-code`, stops the run before any dispatch:
post the one-line reason and report it, rather than parking each package for
a problem none of them caused.

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
  complete: classify it with `gh pr view <n> --json state,autoMergeRequest` and
  skip it. `state` `MERGED` means merged. A set `autoMergeRequest` means queued
  and waiting on checks. Anything else means waiting for a human merge. The
  exception is a PR whose latest review comment carries the
  `Model: sonnet (run-long fallback)` marker: it owes an Opus review and
  re-enters at the reviewer stage (see "Limit deaths" below). Apart from that
  exception, a ready PR whose issue still carries `in-progress` stopped inside
  step 7. Classify it the
  same way, remove `in-progress` and any `phase:*` label, and post no
  statuses and queue nothing. If it classifies as waiting for a human merge,
  give the reason "step 7 interrupted". If the issue carries `in-progress` but
  has no open PR and no branch on origin, clear the label and restart from the
  developer stage.
  Otherwise (a PR or branch exists) read the sub-plan comment and the PR
  comments (verdicts and fix rounds live there) to find the stage it stopped at,
  and re-enter there; re-enter at the tester only when the stage cannot be
  determined from the PR comments. Skip the architect when a sub-plan comment or
  a `Track: lean` comment exists. A lean package (a `Track: lean` comment and no
  later `Track: full` comment) re-enters at the developer or the reviewer, never
  the tester; when its stage cannot be determined from the PR comments, re-enter
  at the reviewer.
- Remote resume: two label pairs name a waiting package. `phase:<stage>`
  together with `run:<r>` re-enters the waiting list for that stage; it
  never re-dispatches the seat, and sweep it through the poll below on the
  first cycle. `claimed:<r>` means a runner is executing the stage: wait for
  that stage's report comment (the header named in "Remote stage dispatch"
  below), do not resume anything else. Neither case ever runs the stage on
  the VPS by itself.
- Dependencies: parse literal `Blocked by: #N` lines in issue bodies. An
  issue whose blocker is not merged waits for a later wave.

Record the run start now for the wave-end token report (see "Token report
(wave end)").

## 2. Wave plan

Wave 1 is the issues with no open blockers; wave 2 is the issues blocked only
by wave 1, and so on. Present the plan (issues, sizes, parallelism, expected
PRs, and each package's predicted track and why; see "Pipeline tracks" in
section 3) and stop for the user's confirmation. This is the only
confirmation in a run; after it, run the wave unattended with no questions to
the user mid-run.
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
annotate fix rounds on the current item, and mark a stage skipped by the lean
track (see "Pipeline tracks" below) as `[-]`. When a stage goes to a runner
instead of a local agent dispatch (see "Remote stage dispatch (columns.json)"
below), annotate the current item `<- handed to runner <r> (waiting)` in
place of `<- dispatching <agent>`; on resume-from-wait, annotate it like the
other resumes. When dispatching agents for several packages in one message,
print one block per package.

Run up to 3 packages concurrently; dispatch their agents in parallel. When
the queue is larger (up to 6 in an /tm-advisor batch), start the next queued
package as one finishes. Worktree isolation keeps packages apart. A package
waiting on a runner (see "Remote stage dispatch (columns.json)" below) does
not hold one of the 3 slots: park it in the waiting list the moment it hands
off, take the next queued package, and keep polling it alongside the others.
Within a package the stages are serial.

Set the stage's `phase:<stage>` label at every handoff below, including the
all-VPS run, and keep the current stage's label through a fix round. Remove
it when the package ships (step 7) or parks.

1. Architect: SUB_PLAN for the issue (prefix the message with `JOB: SUB_PLAN`).
   When the issue body already carries signed-off batch decisions, the batch
   decision log, or links a plan or spec, name that plan source in the
   dispatch as a pointer; the architect still decides whether it returns a
   delta. Post it as an issue comment. On NEEDS_DECISION: inside an
   /tm-advisor batch, decide it yourself when it stays within the signed-off
   scope, logging the decision on the batch issue; outside an /tm-advisor
   batch, park the package (below) and surface the question in the wave-end
   report, then continue the others.
2. Label the issue `in-progress`. Dispatch the developer with the issue
   number and the sub-plan.
3. On DONE or DONE_WITH_CONCERNS: dispatch the tester with the branch and
   issue number, forwarding any concerns from NOTES.
4. On FAIL: post the tester's report as a PR comment with the round number,
   then send the findings verbatim to a fresh developer dispatch ("issue
   #<n>, branch <branch>: fetch it, work detached on it, fix exactly
   these"), then re-test.
5. On PASS: post the tester's report as a PR comment, not only the verdict,
   then dispatch the reviewer with the PR, the issue number, and the
   tester's UNTESTED CLAIMS, if any.
6. On CHANGES_REQUESTED: post the report as a PR comment with the round
   number, then send the must-fix findings to a fresh developer dispatch in
   the same format as step 4, then re-test, then re-review forwarding the
   tester's UNTESTED CLAIMS from the new re-test (not the previous round's
   claims).
7. On APPROVE, with the last tester verdict PASS: ship, in this order. If
   the last tester verdict is not PASS (fix round not yet re-tested),
   complete the test loop first before shipping. The statuses post on every
   repo; only the queue depends on the repo being set up for auto merge.
   After a PR is queued, run a repair pass (see "Repair (queued PRs behind
   the default branch)" below).
   1. Read the head: `gh pr view <pr> --json headRefOid --jq .headRefOid`.
   2. Read the setup now, never from an earlier run. A read that fails or
      prints `null` is passed as `unknown` and never parks the package.
      - `gh api 'repos/{owner}/{repo}' --jq '.allow_auto_merge, .default_branch'`
        (`gh repo view --json` has no auto merge field, so use the REST call).
      - `gh api 'repos/{owner}/{repo}/branches/<default>' --jq .protected`
      - `gh api 'repos/{owner}/{repo}/rules/branches/<default>' --jq length`
        Read both: protection can come from classic branch protection or
        from rulesets.
   3. Run `node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/ship-decision.mjs"
      --track full|lean --verdict-commit <sha|none> --head <sha>
      --fallback-review true|false --auto-merge true|false|unknown
      --branch-protected true|false|unknown --branch-rules <n>|unknown`. It
      makes no gh calls and prints `{ sha, statuses, queue, reason }`. On a
      nonzero exit, post no statuses, skip sub-steps 4 and 6, mark the
      PR ready (sub-step 5), and continue at sub-step 7 with the reason
      "ship-decision error".
      - Verdict commit, full track: the last tester PASS `COMMIT`. The
        reviewer runs right after that PASS with nothing pushed between.
      - Verdict commit, lean track: the SHA on the reviewer's `CHECKS` line.
      - Verdict commit, carried: the new head, only as the "Repair (queued PRs
        behind the default branch)" subsection defines it.
      - A lead-verified ship has no APPROVE on the new head and the head
        differs from the tester's PASS commit, so pass `none`. The script
        reports `head-moved`: nothing is posted and nothing is queued.
      - `--fallback-review`: pass `true` exactly when the approving
        review's PR comment carries the `Model: sonnet (run-long fallback)`
        marker, otherwise `false`. The marker is the only test. The kind of
        seat or column that ran the review does not decide it.
   4. Post each entry of `statuses` (none when `reason` is `head-moved`)
      on the `sha` field of the script's output, not on the head you read
      and not on the verdict commit you passed in:
      `gh api -X POST 'repos/{owner}/{repo}/statuses/<script sha>' -f state=<state> -f context=<context> -f description='<description>'`
      A later post with the same context replaces the earlier one on that
      commit, so a review owed from an earlier run clears in place. If a
      status post exits nonzero, do not retry it, post the remaining
      entries, and record "status post failed: <context>".
   5. Mark the PR ready: `gh pr ready <pr>`.
   6. Queue the merge only if `queue` is true and every status post exited 0:
      `gh pr merge <pr> --squash --auto --match-head-commit <script sha>`,
      with the same `sha` field as in sub-step 4. If it exits nonzero, do
      not retry, never `--admin`, and never merge without `--auto`. Record
      "queue refused: <first stderr line>". The PR stays ready and is
      reported as waiting for a human merge. This is not a park. If a
      status post failed, do not queue: the PR stays ready and is reported
      as waiting for a human merge.
   7. Remove `in-progress` and any `phase:*` label, and post a summary
      comment on the issue, including should-fix findings and untested
      claims for the human review. Add one outcome line. It opens with
      "statuses on `<sha7>`" (the first 7 characters of the script's
      `sha`), or with "no statuses" when nothing was posted (`head-moved`,
      or a ship-decision error). Then it says either queued, or waiting for
      a human merge with its reason. The reason is the script's `reason`,
      except that "status post failed: <context>", "queue refused: <first
      stderr line>" or "ship-decision error" replaces it when one of them
      was recorded. The script's `queued` is never reported for a PR that
      was not queued. Inside a batch, mirror it to the batch issue.

Routing rules:

- Seat reports are capped by the seat contracts. Route on the short report
  as it stands. Where steps 4, 5, and 6 post a tester or reviewer report as
  a PR comment, post it verbatim; that comment is the full evidence record.
  Do not expand it, and do not re-dispatch a seat to get a longer version.
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
- A seat dispatch that returns empty, or returns text with no
  contract-shaped report (`STATUS:`, `VERDICT:`, the architect job header,
  or `NEEDS_DECISION:`), and is not a limit death (as defined in "Limit
  deaths" below, which takes priority), is an empty or stalled return,
  not a legitimate verdict: it gets a `SendMessage` resume, not a
  re-dispatch. See "Limit deaths (run-long fallback and resume)" below.
- Never re-dispatch an unchanged prompt; something in the task must change
  first.
- Cap: 3 fix rounds per stage, counted from the PR comments. Tester and
  reviewer each have their own independent counter. A step-6 re-test FAIL
  (tester fails after a reviewer fix round) re-enters the step-4 loop and
  increments the tester counter. On exhaustion of either counter, park the
  package.
- Parking: post the reason on the issue, apply `needs-human` (remove
  `in-progress` and any `phase:*` label if present), and move on to the
  other packages.
- Inside an /tm-advisor batch, mirror lead decisions and package outcomes
  (merged, queued, waiting for a human merge, parked) to the batch tracking
  issue as they happen.

### Fix rounds (exact text and lead-verified rounds)

1. **Exact text.** Any fix text the lead writes into a dispatch (arbitration
   outcomes, lead decisions, NEEDS_CONTEXT answers) is the complete, exact
   replacement text. When a sentence or list changes, quote the whole
   resulting sentence or list. Never use `...`, "etc.", "for example A, B,
   ..." or "keep the rest". A behavior fix that cannot be stated as text is
   forwarded verbatim, with no partial text. If a reviewer finding contains a
   placeholder, the lead writes out the full text, and the round is not
   lead-verified.
2. **When a round is lead-verified.** All must hold:
   - (a) every finding came from the reviewer, quotes complete replacement
     text, and was forwarded unchanged;
   - (b) the reviewer ran its quality pass (`STAGE: quality`; a `STAGE:
     spec` report never qualifies);
   - (c) the fix is not executable code or configuration (JSON, YAML,
     frontmatter);
   - (d) the diff contains only that text;
   - (e) CI is green.
3. **What the lead checks.**
   - Before the fix dispatch, record `gh pr view <pr> --json headRefOid` as
     `<base>`. With a tester stage, `<base>` must equal the last tester PASS
     `COMMIT`. After DONE, read it again as `<head>`. DONE_WITH_CONCERNS
     falls back.
   - Run `git fetch origin <branch>` and
     `git merge-base --is-ancestor <base> <head>`.
   - Run `git diff --stat <base> <head>`. Any file beyond the findings'
     files means fall back.
   - Run `git diff <base> <head>`. Every changed line must be the reviewer
     text or the text it replaces, ignoring whitespace and wrapping.
   - Run `gh pr checks <pr> --watch --fail-fast` with the output redirected,
     so only the exit code counts. It must be 0, and `headRefOid` must be
     unchanged.
4. **Log line.** Posted on the PR, repeated in the step 7 summary, and,
   inside an /tm-advisor batch, mirrored to the batch issue:
   ```
   Lead-verified round <r>/3 (reviewer findings <n, n>): verbatim reviewer text only, <base7>..<head7>, CI green on <head7>. No re-test, no re-review.
   ```
   The `Lead-verified` prefix is also the resume marker. On resume it
   means the round passed only while `<head7>` still matches the PR head;
   then continue at step 7. Otherwise re-test and re-review.
5. **Every other fix** takes re-test and re-review: all tester FAIL rounds,
   mixed or lead- or developer-worded rounds, any failed check, and CI that
   is red, pending or reports no checks.
6. **Counters and step 7.**
   - A lead-verified round counts as one reviewer fix round, and the tester
     counter does not move.
   - A failed check adds no round; the same round continues on the normal
     loop.
   - A round 3/3 that passes ships.
   - A passed round satisfies step 7 and section 4 without a re-test or a
     new APPROVE.
   - A lead-verified ship has no APPROVE on the new head, so step 7's commit
     check fails: it posts nothing and queues nothing, and the PR waits for a
     human merge.
7. **Lean track.** Where a package has no tester stage, the round skips only
   the re-review, the base is the head the reviewer reviewed, and CI green
   on the new head replaces the reviewer's check results.

### Limit deaths (run-long fallback and resume)

A limit death is an agent dispatch that dies on an exhausted quota (the
limit error, or an empty return while the model is exhausted), not a normal
verdict. This is lead policy layered on top of the per-dispatch `retry` in
`docs/architecture/adapter-interface.md`; it changes no agent contract.

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
- Post every fallback verdict as a PR comment, APPROVE included. That
  comment and every fallback sub-plan comment carry the marker line
  `Model: sonnet (run-long fallback)` in the comment header, next to the
  round number where there is one. The report body stays verbatim; the
  marker never goes inside it.

**Re-run on Opus.** "Once quota returns" means the next run: probing Opus
mid-run would contradict "the run never goes back to Opus." The debt is the
Opus review of the PR head. A Sonnet sub-plan or arbitration is covered by
that review and is not re-run by itself.

- In the next run, it is an ordinary review. While the latest review
  comment on a PR carries the marker, post every reviewer verdict on it as a
  PR comment, APPROVE included; an unmarked latest review comment clears the
  debt.
- On CHANGES_REQUESTED, run `gh pr ready --undo`, then the normal fix loop.
- A fallback APPROVE posts a pending "review owed" status and is not queued
  (step 7). The next run's APPROVE posts the success status and queues the
  merge on a repo that is set up for it.

**Resume before respawn.** After a limit death (once the lead can dispatch
again) or an empty or stalled return (at once), it makes one `SendMessage`
to the same agent ID, with a nudge to finalize its report. The plan-status
block is annotated `(resumed)`.

- Respawn fresh if the agent cannot be addressed, `SendMessage` errors, or
  the resumed agent dies again or returns nothing usable.
- A judgment seat's Opus-limit death skips the resume and goes straight to
  the Sonnet respawn: a resumed agent keeps its exhausted model.
- The nudge is new input; a resume with no new content is what the
  unchanged-prompt rule forbids.
- The respawn prompt adds one line naming the limit death or the empty
  return and what the dead attempt left on origin.

**Counters.** A quota or limit death, or an empty or stalled return, is not
a finding. It posts no round comment and never advances a fix-round
counter. The resumed or respawned dispatch keeps the same round number. A
fallback verdict counts as a normal round. If any attempt in the resume or
respawn sequence is a limit death, the Limit deaths rules apply from
then on. Bound: for non-limit empty returns only, one resume per stage
attempt: the fresh respawn gets no resume, and if it also comes back
empty or stalled, park the package (see "Parking" in the routing rules
above). Limit deaths have no such bound.

### Pipeline tracks (lean and full)

The numbered pipeline above is the full track, the default for every
package. A package qualifies for the lean track only on `size:S` and a
diff that avoids `.claude/agents`, `.claude/skills`, `.claude/workflows`
and executable code. Everything else, and every `size:M`, runs full.
When in doubt, full.

- **Before dispatch.** Predict the track from the issue body and state it
  and why in the wave plan or advisor proposal.
- **Track comment.** For a lean package, post `Track: lean - <reason;
  expected paths; verification: reviewer runs the check suite>` on the
  issue, and set the `track:lean` label at the same time. It is both the
  sub-plan checkpoint and the resume marker: skip the architect stage.
- **Stages.** Skip step 1 (architect). The developer dispatch (step 2)
  says "lean track: no sub-plan, the issue body is the spec". A lean card
  never carries `phase:architect` or `phase:tester`: only `phase:developer`
  and `phase:reviewer`.
- **Diff check.** Before every lean reviewer dispatch (after DONE or
  DONE_WITH_CONCERNS, after each fix round, and on resume), check
  `gh pr diff <n> --name-only`. If eligibility is broken, post
  `Track: full - <reason; the paths that broke eligibility>` on the issue
  and continue on the full track from step 3 (tester).
- **Review.** Otherwise skip steps 3-4 (tester) and dispatch the reviewer
  (step 5) with the PR, branch, issue and "lean track", forwarding any
  NOTES from the developer. On CHANGES_REQUESTED (a failing check counts),
  a developer fix round (step 6), then re-review. There is no re-test.
- **Done.** Step 7's "last tester verdict PASS" becomes: APPROVE and
  every `CHECKS` exit code is 0. The verdict commit is the SHA on the
  `CHECKS` line, and the test status is a success marked "skipped (lean)".
  Only the reviewer's fix-round counter applies; the cap of 3 is unchanged.
- **Plan-status.** Keep the five items. A skipped stage (the architect,
  and the tester) shows as `[-] <n>. <stage> skipped (lean)`. After a
  track change to full, the architect item stays
  `[-] 1. sub-plan skipped (lean)` and the tester item runs as normal
  (`[>] 3. test   <- dispatching tester`).

### Repair (queued PRs behind the default branch)

A queued PR waits for its checks, and the default branch can move on while it
waits. This pass brings such a PR up to date and, when its own changes are
untouched, carries the verdicts to the new head so the merge can fire again.
It writes to GitHub only through the commands below. In this text `<default>`
is the PR's base branch (`baseRefName`), `<V>` is the head the verdict
statuses sit on, and `<H>` is the head after the update.

**Repair set.** The open PRs of this run's packages that are queued
(`autoMergeRequest` set), plus the PR currently in repair. A queued PR that an
earlier, dropped session queued belongs to the set too. Step 7 queues a merge
only on a set-up repo, so on any other repo the set is empty and nothing here
runs.

**Pass.** For each PR in the set run
`gh pr view <pr> --json state,autoMergeRequest,mergeStateStatus,headRefOid,baseRefName`.

- `MERGED`: drop it from the set.
- `UNKNOWN`: read it again at the next pass.
- If the slot is free, start a repair on the first PR, in the order queued,
  whose `mergeStateStatus` is `BEHIND` (clean attempt) or `DIRTY` (straight
  to the conflict path, no update call).

**Triggers.** Run a pass after step 7 queues a PR, when the slot frees, and at
wave end, repeated every 60 s until the repair pass has settled (section 4).
When several packages ship in the same turn, finish step 7 for all of them,
then run one pass.

**The slot.** There is one per run, so only one PR is updated at a time. It is
held from the start marker until the PR has merged, parked, or is waiting for a
human merge. After a re-queue it is held until `gh pr checks <pr>` stops
exiting 8 (pending) and one more 60 s cycle passes with no merge, so the next
update cannot land just before this PR merges. While it is held, no other
update or conflict path starts, and the lead keeps routing the other packages.
A conflict path also takes the next free one of the 3 package slots, ahead of
packages not yet started.

**Clean attempt.** In this order:

1. Precondition: both statuses are `success` on `<V>`. This needs
   `gh api 'repos/{owner}/{repo}/commits/<V>/status' --jq '[.statuses[] |
   select((.context=="orchestrai/test" or .context=="orchestrai/review") and
   .state=="success")] | length'` to print 2. Otherwise take the conflict path
   with the reason `statuses missing on <V7>`, before any write.
2. Post on the PR: `Repair (clean update) from <V40>: behind <default>.`
3. If `autoMergeRequest` is set, run `gh pr merge <pr> --disable-auto`. The
   repair never relies on the old request.
4. Update: `gh api -X PUT 'repos/{owner}/{repo}/pulls/<pr>/update-branch' -f
   expected_head_sha=<V>`. This is always a merge update and is pinned to
   `<V>`. A conflict or a moved head returns 422 and a nonzero exit. Do not
   use `gh pr update-branch`: it pins to its own read of the head.
5. The call is asynchronous. Read `headRefOid` every 60 s, up to 10 minutes,
   until it differs from `<V>`. That value is `<H>`.
6. `git fetch origin`, then
   `node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/same-changes.mjs"
   --from <V> --head <H> --default-ref origin/<default>`. It makes no gh
   calls and prints `{ result, reason }`. Carry the verdicts only on exit 0
   with `identical`. Every other result, and exit 2, takes the conflict path.
7. Wait for checks to appear. Every 60 s, up to 10 minutes, run
   `gh pr view <pr> --json headRefOid,statusCheckRollup --jq '.headRefOid,
   (.statusCheckRollup | length)'` and continue once the count is above 0.
   Still 0 after 10 minutes means "no checks reported", which is not green.
   Then every 60 s run `gh pr checks <pr> > /dev/null 2>&1` and read only the
   exit code: 8 is pending, 0 is green, anything else is red. The head must
   still be `<H>` throughout.
8. Carry the verdicts through step 7, running sub-steps 1 to 4 and 6 only,
   with `<H>` as the verdict commit (sub-step 3 names it). Sub-step 1 must
   read `<H>`. Work out `--track` and `--fallback-review` as step 7 does. Skip
   sub-step 5 (the PR is already ready) and sub-step 7 (the outcome line
   below replaces it). `ship-decision.mjs` is unchanged.
9. Post the outcome on the PR and on the issue, and mirror it to the batch
   issue: `Repair (clean update) <V7>..<H7>: same changes, CI green on <H7>,
   statuses carried; <merged|queued|waiting for a human merge (<reason>)>.`
   Classify it with `gh pr view <pr> --json state,autoMergeRequest` read
   after sub-step 6: `MERGED` is merged, a set `autoMergeRequest` is queued,
   anything else is waiting for a human merge, with the script's `reason`, or
   "queue refused: <first stderr line>" or "status post failed: <context>" as
   sub-step 6 records. None of these parks the PR, none is retried, and none
   counts as a repair.

**Conflict path.** It starts on `DIRTY`, on any update refusal, and on any
failed condition above. The reason is exactly one of:

- `conflicts with <default>`
- `update refused: <first stderr line>`
- `update did not land in 10 minutes`
- `head moved during the repair`
- `no checks reported on <H7>`
- `CI red on <H7>`
- `own changes differ (same-changes: <result>)`
- `same-changes error`
- `statuses missing on <V7>`

In order:

1. Count (below). A `Repair (conflict)` marker already on the PR means park.
2. Post on the PR: `Repair (conflict) from <head40>: <reason>.` (`<head40>` is
   the PR head when the path starts.) Mirror it to the batch issue.
3. If `autoMergeRequest` is set, run `gh pr merge <pr> --disable-auto`. Then
   run `gh pr ready --undo <pr>` and label the issue `in-progress` and
   `phase:developer`.
4. Dispatch the developer in the fix-round format: "issue #<n>, branch
   <branch>: fetch it, work detached on it. Repair: <reason>. Merge
   `origin/<default>` into it with a merge commit (no rebase, no force push),
   resolve any conflict so both sides' changes hold, fix what fails, run the
   full check suite, and push. If nothing needs a change, push nothing and say
   so in NOTES." Annotate the plan-status item `(repair)`. The developer is
   dispatched in every conflict-path case.
5. Continue from step 3: tester, then reviewer. On the lean track the lean
   reviewer's check run stands in for the re-test, and the lean diff check
   still applies. Fix-round counters carry on from the PR comments with no
   reset.
6. Ship again through step 7 in full. On a repair re-ship, sub-step 7's
   summary covers the repair round only. Findings from the first ship are not
   repeated, filed or posted again.
7. Free the slot under the rule above.

**Count.** The number of `Repair (conflict)` markers on the PR. A clean update
does not count, because it dispatches no agent and changes no reviewed line. A
resumed run reads the same markers.

**Resume.** A PR whose latest `Repair (clean update) from` marker has no later
outcome line joins the repair set. Take `<V>` from the marker. If the head is
still `<V>`, update again (same attempt, no new marker). Otherwise take the
head as `<H>` and continue at the same-changes step. A draft PR with
`in-progress` whose latest stage comment is a `Repair (conflict)` marker goes
back to the developer with that reason; the gate's resume rule for draft PRs
handles it.

**Parking.** A second conflict-path repair is not started. Instead:

1. If `autoMergeRequest` is set, run `gh pr merge <pr> --disable-auto`.
2. Post on the issue: `Parked: PR #<pr> needs a second repair: <reason>. One
   repair per PR; the first: <link to the Repair (conflict) marker>.`
3. Apply the routing rules' "Parking" step: `needs-human` on, `in-progress`
   and `phase:*` off.
4. Mirror it to the batch issue and free the slot. The run carries on with the
   next pass and the other packages.

The repair queues a merge only through sub-step 6 of step 7. Its other merge
command is `--disable-auto`. Never `--admin`, and never a merge without
`--auto`. If `--match-head-commit` is ignored together with `--auto`, the
required statuses, which exist only on `<H>`, still hold any later commit.

### Remote stage dispatch (columns.json)

A repo configures which runner executes each stage in
`.orchestrai/columns.json` on its default branch (design sections 5 and 6).
The lead reads it from its checkout before each seat dispatch.

**Read it.** Run

```
node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/columns.mjs" \
  --file <checkout>/.orchestrai/columns.json
```

- Exit 0 with `{"absent":true}`: no file, so use the adapter table as today
  and treat every runner as `vps`. relai shows stage names only.
- Exit 0 with the summary: `{ stage: { runner, provider, kind, model,
  effort, execute } }`. `execute` is `lead` when `runner` is `vps` and
  `kind` is `anthropic`, otherwise `runner:<id>`.
- Nonzero exit: the file is invalid. Post the one-line report on the issue,
  park the package (see Parking), and move on. This is the same stop as a
  sizing mismatch; relai shows an "invalid columns.json" note.

Read it before every seat dispatch in this pipeline, fix rounds and
arbitration included, so a mid-run edit to the file takes effect at the next
handoff. A package whose column is `lead` needs no extra step.

**A column whose `execute` is `lead`.** Dispatch the seat as today, with
that column's `model` and `effort` in place of the adapter table's tier
values.

**A column whose `execute` is `runner:<r>`.** Hand the stage off; never run
it locally on its own. A missing file means every column is `lead`.

1. Set `phase:<stage>` and `run:<r>` (create `run:<r>` with the same
   `--force` upsert if this repo has never used it).
2. Post a JOB comment on the issue: `JOB: <job>`, then the branch, provider,
   model and effort. `<job>` is the seat's own job token: `SUB_PLAN`,
   `SPLIT_PROPOSAL` or `ARBITRATION` for an architect handoff, otherwise the
   stage name (`developer`, `tester`, `reviewer`). No `Dependency
   environment:` line: the VPS path is useless to a remote runner.
3. Add the package to the waiting list. It leaves the concurrency cap
   immediately, so the next queued package starts and this one holds no
   slot. Print its plan-status item as
   `[>] <n>. <stage>   <- handed to runner <r> (waiting)`.

**The waiting list.** One 60 s cycle covers every waiting issue, with no
timeout; the package waits indefinitely (design principle 5, no automatic
fallback). Each cycle, for every waiting issue run
`gh issue view <n> --comments --json labels,comments` and continue it when:

- a report comment for that stage is newer than the JOB comment. Match the
  stage's own header exactly: `SUB_PLAN`, `SPLIT_PROPOSAL`, `ARBITRATION` or
  `NEEDS_DECISION:` for the architect, `STATUS:` for the developer,
  `VERDICT:` for the tester and the reviewer. A `claimed:<r>` gone with no
  report yet still means waiting; step 4 of the design's handoff posts the
  report before clearing the labels;
- the owner swapped it to `run:vps` (see below).

Otherwise leave it waiting. The lead keeps polling across waves: a wave
where every package waits on a runner is not over, and no wave-end report is
posted while any package is waiting.

**Swap to `run:vps`.** The owner replaces `run:<r>` with `run:vps` on the
issue. The lead acts on the column's provider kind:

- if it is `anthropic`, remove `run:vps` and dispatch the seat locally with
  the column's model and effort, as in the `lead` case above;
- otherwise leave `run:vps` in place and keep waiting. The swap only reroutes
  to the VPS poller, which lists issues carrying `run:vps` and claims the
  stage like any other runner (design section 7, WP3); clearing the label
  would make the job unclaimable.

**Resume.** The two label pairs of the gate's "Remote resume" case: an issue
with `phase:<stage>` and `run:<r>` re-enters the waiting list; `claimed:<r>`
waits for that stage's report comment. Neither re-dispatches a seat.

**Report routing.** When the poll sees the stage's report comment, treat it
exactly as the local dispatch's return: an architect `SUB_PLAN` is posted as
an issue comment (step 1), a tester or reviewer `VERDICT:` as a PR comment
verbatim (steps 4, 5 and 6), a developer `STATUS:` is the routing input only.
Then route as normal for that stage: architect like step 1, developer like
step 3, tester like steps 4 and 5, reviewer like steps 6 and 7. Annotate the
plan-status item like any other resume.

### Subprocess seat dispatch (adapter tables)

This section applies only when the gate resolved the run's adapter table with
`dispatch: subprocess`; an `agent` table runs the pipeline above unchanged.
In this mode every lead-executed seat runs as its own headless `claude -p`
process through `.claude/adapters/claude-code-subprocess.mjs`, so worker and
judgment seats carry their own per-seat model, endpoint, effort, and working
directory. Read "agent dispatch" above as "seat dispatch" here: the routing
rules, fix-round caps, parking, plan-status blocks, and lean-track
eligibility are unchanged. Only the execution and the failure ladder differ.
A `runner:<r>` column is untouched by this mode: it still hands the stage off
(see "Remote stage dispatch" above), and the seat never runs locally.

**Package worktree.** Before the developer seat, the lead creates and owns
the package worktree, keyed by issue number so the path is stable across
every seat and every fix round. The pipeline is resume-first (an
`in-progress` package re-enters at its stopped stage), so creation is
idempotent: an existing worktree is reused, never re-added. After
`git fetch origin`, run this from the lead's main checkout:

```
git worktree prune                     # drop unlocked entries whose directory is gone
if [ ! -d .worktrees/pkg-<n> ] \
  && git worktree list --porcelain | grep -q "worktrees/pkg-<n>$"; then
  git worktree unlock .worktrees/pkg-<n> 2>/dev/null || true  # prune skips locked entries
  git worktree prune
fi
if git worktree list --porcelain | grep -q "worktrees/pkg-<n>$" \
  && [ -d .worktrees/pkg-<n> ]; then
  :                                    # registered and present: reuse, no add
elif git show-ref --verify --quiet refs/heads/<type>/<n>-<slug> \
  || git show-ref --verify --quiet refs/remotes/origin/<type>/<n>-<slug>; then
  git worktree add .worktrees/pkg-<n> <type>/<n>-<slug>   # branch exists, check it out
else
  git worktree add .worktrees/pkg-<n> -b <type>/<n>-<slug> origin/main
fi
```

The guard is trustworthy only if it checks the directory itself, not just the
porcelain entry. A registration whose directory was deleted by hand (a
`rm -rf .worktrees/pkg-<n>` outside the pipeline) still appears in the
porcelain list, so a porcelain-only guard takes the reuse arm, exits 0, and
leaves the package with no worktree; the seats then spawn with a missing cwd
and the package parks. Two steps handle it. The leading `prune` drops an
unlocked registration whose directory is gone. A *locked* registration
survives `prune` silently (prune skips locked entries), so the `unlock` step
runs when the directory is missing but the entry is still listed, then prunes
again; after that the guarded reuse arm checks both the porcelain entry and
`-d .worktrees/pkg-<n>`, so a locked-gone case falls through to an `add` that
recreates the directory. That `unlock` only runs on the residual listed but
directory-missing entry, and its failure is swallowed (`2>/dev/null ||
true`), so the ordinary hand-deleted case is unchanged.

One narrow state stays loud rather than silent. A stale registration whose
directory still holds content (for example the gitdir admin directory under
`.git/worktrees/pkg-<n>` was removed, or only the worktree's `.git` file was
deleted) is pruned, but the follow-up `add` then aborts with `fatal:
'.worktrees/pkg-<n>' already exists`. This fails loudly with git's own
error, and the operator resolves it by removing the leftover directory by
hand. The pipeline does not try to remove a directory it did not create.

`<type>` is `feat` or `fix` and `<slug>` is the issue's short slug. The
branch-existence branch is the resume case: a worktree removed without a
`prune` leaves its branch behind, and a plain `-b` add then dies with
"a branch named ... already exists". Adding the existing branch resolves it
locally, or, when only `origin/<type>/<n>-<slug>` exists, creates a
tracking branch at origin's head. The `$` anchor keeps `pkg-1` from matching
its `pkg-10` sibling in the porcelain list. Every seat of the package runs
with `cwd` there: the developer, the tester, the reviewer, arbitration, and
every fix round. The one seat outside it is step 1's architect: its SUB_PLAN
or SPLIT_PROPOSAL dispatch runs from the lead's checkout, because the
worktree does not exist yet and the seat is read-only.

**Invocation.** The module has no CLI, so the lead drives it with this
one-liner. `TM_SEAT_TASK` carries the task text, its `JOB:` prefix included,
read from a temp file so a multi-line task needs no shell escaping; the role
contract is prepended module-side from `.claude/adapters/prompts/`, so the
lead never composes the prompt itself.

```
CLAUDE_CODE_ADAPTER_TABLE=<table> \
  TM_SEAT_ROLE=<role> TM_SEAT_TASK="$(cat <task file>)" \
  TM_SEAT_CWD=<worktree path> \
  TM_SEAT_MODEL=<model> TM_SEAT_EFFORT=<effort> \
  TM_SEAT_SETTINGS='$CLAUDE_CODE_NORIS_SETTINGS' \
  [TM_SEAT_TIER=<tier>] [TM_SEAT_TIMEOUT_MS=<ms>] \
  node --input-type=module -e '
import { pathToFileURL } from "node:url";
const p = (process.env.CLAUDE_PLUGIN_ROOT || ".claude") + "/adapters/claude-code-subprocess.mjs";
const { dispatchSeat } = await import(pathToFileURL(p).href);
const e = process.env;
const opts = { cwd: e.TM_SEAT_CWD };
for (const k of ["tier", "model", "effort", "settings"]) { const v = e["TM_SEAT_" + k.toUpperCase()]; if (v) opts[k] = v; }
if (e.TM_SEAT_TIMEOUT_MS) opts.timeoutMs = Number(e.TM_SEAT_TIMEOUT_MS);
console.log(JSON.stringify(await dispatchSeat(e.TM_SEAT_ROLE, e.TM_SEAT_TASK, opts)));
'
```

Run it from the lead's checkout and print the returned JSON. The result is
`{ report, attempts, failure, parked }`: route `report` exactly as the Agent
tool's return (`STATUS:`, `VERDICT:`, the architect job header,
`NEEDS_DECISION:`), and park the package when `parked` is set. With
`DRY_RUN=true` the module returns a synthetic report and spawns nothing,
which is how the invocation is checked offline.

**Timeout.** 30 minutes per seat, the module default. Narrow it per dispatch
with `TM_SEAT_TIMEOUT_MS` only when a stage is known short; a killed seat
fails loudly and enters the respawn below.

**Settings.** The table's `settings` value is a pointer the module expands
from the run's own environment (for example
`$CLAUDE_CODE_NORIS_SETTINGS`), never an absolute path. Pin it in single
quotes in the invocation, `TM_SEAT_SETTINGS='$CLAUDE_CODE_NORIS_SETTINGS'`:
the module must receive the literal placeholder, and unquoted the shell
expands the pointer first, so the module throws "neither a $VAR placeholder
nor valid JSON" instead of dispatching. The variable must be exported before
the seat dispatch; when it is unset the module throws rather than silently
loading no profile, so the dispatch fails and the package parks.

**Which seat binding reaches the seat.** The module's `loadAdapterTable`
reads only the plugin's adapters directory, by bare file name, so a
project-shadowed table never reaches a seat on its own. The gate's
shadow-aware resolution reaches the seats through explicit dispatch opts
instead: the lead reads the resolved (possibly shadowed) table's role or tier
binding and passes `model`, `effort`, and `settings` into the dispatch. Pass
`TM_SEAT_TIER` only when that tier also exists in the plugin table, since the
module resolves an unknown tier by throwing. A shadowed table must keep the
plugin table's provider: opts carries no provider, so the effort ceiling is
always read from the module's own binding. Without this bridge a shadowed
table would silently not reach the seats.

**columns.json.** Subprocess mode changes only how the lead executes a
`lead` column. When a column hands the stage to a `runner:<r>`, the handoff
is unchanged and no local seat runs. For a `lead` column, the column's
`model` and `effort` ride as explicit dispatch opts (`TM_SEAT_MODEL`,
`TM_SEAT_EFFORT`) in place of the adapter table's tier binding, exactly as
they replace the tier values in the `agent` path.

**Respawn, then park.** The send-a-message resume ladder in "Limit deaths"
is replaced for subprocess seats by the module's own one-respawn policy:
`dispatchSeat` spawns once, and on any failure class respawns exactly once
with a prompt line naming the failure and telling the seat to check what the
dead attempt left on origin (branch, commits, PR) before redoing work. If
the respawn also fails, the result carries `parked`: park the package with
that reason. State the precedence in both directions:

- The "Limit deaths" run-long Opus-to-Sonnet fallback covers Agent-tool
  quota deaths. It does not fire for a subprocess seat, which has no Agent
  tool call to die on and no per-call model override to switch. A subprocess
  seat that hits a provider limit is a failure like any other: one respawn,
  then park.
- Agent dispatches keep the existing resume and limit-death rules unchanged.
  A run whose gate resolved `agent` never enters this section.

**Token usage.** `report.usage` carries the seat's raw counts
(`inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`, `priced`).
Self-hosted `vllm/*` models are recorded unpriced (`costUsd` null, `priced`
false); they are never priced. Collect each dispatch's usage for the wave-end
report (see "Token report (wave end)" below).

### Dependency environment (once per run)

The lead builds the dependency environment once per run (a run as defined
in "Limit deaths" above), after the wave-plan confirmation or batch
sign-off and before the first developer dispatch, so every seat that runs
the check suite shares one build instead of paying for it per package.

Build it from CLAUDE.md "Useful commands", against the default branch,
into `mktemp -d "${TMPDIR:-/tmp}/tm-env.XXXXXX"`. Never inside the
checkout or any worktree. Install dependencies only: never install the
project under test into it, editable or not, or a seat would test the
lead's checkout instead of its own branch.

Add `Dependency environment: <absolute path>` to every dispatch that
runs the check suite: developer, tester, and the lean-track reviewer,
including fix rounds, resumes and respawns. The architect and the
full-track reviewer get no line.

After the build, `chmod -R a-w <path>` so the environment is read-only:
no seat installs into it, upgrades it, deletes from it, or changes its
permissions. At run end, after the wave-end or batch report,
`chmod -R u+w <path> && rm -rf <path>`.

A seat builds its own environment, as it did before this rule, when the
line is absent, the path is missing, the branch diff touches a
dependency manifest or lockfile, or a check fails with an environment
error. For the tester, an environment error is never a finding: it
reruns in its own environment first. This changes no report contract.

If CLAUDE.md "Useful commands" has no install step, or marks it N/A, or
the lead's build fails: no line, no park.

## Worktree cleanup (deterministic)

The `developer` and `tester` run with Agent `isolation: worktree`, and so does
the `reviewer`, which checks out the branch on the lean track (see "Pipeline
tracks" above). The isolation does not reliably separate the working tree: a
dispatched agent's `git checkout`/`git switch` can land on the lead's shared
checkout. That is the mechanical cause of the tangle, and it hits every
checkout-running agent, not just one (observed live on issue #78: the
`tester`'s `git checkout --detach FETCH_HEAD` left the lead's checkout detached
at the branch tip). The agents publish to origin, so their work is safe there
regardless; what leaks into the lead's checkout is a moved HEAD, sometimes a
local branch, and a worktree registered under `.claude/worktrees/`. The
`developer` fresh path uses a detached checkout instead of `git switch -c`, so
it no longer leaves a stale local branch (the worst residue, a clobber risk
against the good remote branch); the moved HEAD and the registered worktree are
harness-side and cannot be prevented by agent commands, so the lead reverses
them deterministically.

### Per-package cleanup (PR ready or parked)

**Trigger.** Right after step 7 ships a package, and right after a package is
parked.

**Guard, mapping.** The lead records `worktreePath` and `worktreeBranch` (the
`worktree-agent-<id>` branch) per package for every worktree dispatch, and this
pass touches only those plus the package's own local branch. Anything unmapped
waits for wave end.

In subprocess mode the lead also records the package worktree it created for
the package (`.worktrees/pkg-<n>`, see "Subprocess seat dispatch (adapter
tables)" above) and the `<type>/<n>-<slug>` branch that worktree carries. The
records go in the same per-package mapping, alongside the agent-path fields.
This pass covers both, under the same guards.

**Guard, locks.** A single `--force`, never `--force --force`; a locked
worktree is skipped.

**Guard, lead checkout.** The pass never touches the lead's own checkout: no
switch, no HEAD repair.

**Origin-safety rule.** After `git fetch --prune origin`:
- remove a worktree only if `git -C <path> rev-list HEAD --not --remotes=origin`
  exits 0 and prints nothing;
- delete a branch only if `git rev-list <branch> --not --remotes=origin`
  exits 0 and prints nothing.

Uncommitted files in a removable worktree are discarded on purpose. A missing
path is skipped. Anything that fails a check is left for the backstop. A
package with several worktree dispatches runs the remove pair and the
`worktree-agent-<id>` pair once per recorded worktree.

The same remove/delete pair covers the subprocess package worktree and its
branch, recorded above. Both are origin-published before either runs: the
package worktree's branch is the package branch itself, pushed to origin
under the same `<type>/<n>-<slug>` ref, so the branch delete below is the
one and only delete of that ref. Removing the package worktree is never
allowed to discard commits origin does not have, so the
`rev-list --not --remotes=origin` guard runs there too, unchanged.

```
git fetch --prune origin

git -C <worktreePath> rev-list HEAD --not --remotes=origin   # empty: safe to remove
git worktree remove --force <worktreePath>

git -C .worktrees/pkg-<n> rev-list HEAD --not --remotes=origin  # empty: safe to remove
git worktree remove --force .worktrees/pkg-<n>

git rev-list worktree-agent-<id> --not --remotes=origin      # empty: safe to delete
git branch -D worktree-agent-<id>
git rev-list <package-branch> --not --remotes=origin         # empty: safe to delete
git branch -D <package-branch>

git worktree prune
```

### Wave-end cleanup (backstop)

At wave end, with no agents in flight, run from the lead's main checkout:

```
git worktree prune                 # safe anytime; drops entries for gone worktrees
git worktree list                  # expect only the main repo
git status --short --branch        # expect the default branch, clean tree
```

`git worktree list` lists this run's own live subprocess worktrees under
`.worktrees/` too (`.gitignore` covers only `.claude/worktrees/`), so read
"expect only the main repo" and "clean tree" as tolerating those entries while
the run owns them. Remove anything still registered under `.claude/worktrees/`
only if `git -C <path> rev-list HEAD --not --remotes=origin` exits 0 and prints
nothing (`git worktree remove --force <path>`). The per-package pass above
already removed this run's `.worktrees/pkg-<n>` entries under their guards; a
survivor there is left alone for the human, like any other guarded path, and
named in the wave-end report. If the lead's HEAD was moved off the default
branch, return to it with `git switch <default>` (the lead's own checkout, the one
place that command is right). Delete a stray local branch, including a
leftover `worktree-agent-<id>` branch, only if `git rev-list <branch> --not
--remotes=origin` exits 0 and prints nothing, then `git branch -D <branch>`;
never delete a branch whose commits are not on origin. Mid-wave, only the
per-package pass above runs these, under its guards. Whatever this backstop
keeps is named in the wave-end report.

## Token report (wave end)

At the gate (before any package is dispatched), record the run start:
`date -u +%Y-%m-%dT%H:%M:%S.000Z`.

At wave end, once the worktree cleanup above is done, run:

```
node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/token-report.mjs" \
  --session "${CLAUDE_CODE_SESSION_ID}" --since <run start>
```

and post its output as a comment on each package issue in the wave. This
covers the lead session only; the seats of a subprocess run are not in its
transcript.

**Subprocess seats.** In subprocess mode also post each seat dispatch's raw
usage in the wave-end report, from the `report.usage` each dispatch returned:
`inputTokens`, `outputTokens`, `cacheReadTokens`, and `costUsd`. Self-hosted
`vllm/*` seats are unpriced (`costUsd` null); report their raw counts and say
"unpriced", never a cost. Group the lines per package, one line per seat.

Skip this step entirely inside an advisor batch (`/tm-advisor` posts its own
report; see section 5 of its skill). A wave whose packages are still in the
waiting list has not ended (see "Remote stage dispatch (columns.json)"): run
this and the release below only once none is waiting. On a resumed session,
omit `--since` (there is no reliable run-start timestamp to anchor it to) and
say so in the posted comment. A failed run (missing transcript, script error)
is noted in the wave-end report below and never blocks it.

## 4. Wave end

Definition of done per package: last tester verdict is PASS, reviewer
APPROVE, PR ready with `Closes #N`, the ship decision run, the statuses
posted as it says and the merge queued when it says (or the failed status
post, the refused queue or the ship-decision error recorded as step 7
says, with no retry), summary comment posted. On the lean track,
substitute the reviewer's `CHECKS` line (all exit codes 0) for the tester
verdict; see "Pipeline tracks" above.

The wave ends when every package has shipped or parked and none is waiting
on a runner: a package in the waiting list keeps the run open, and the lead
keeps polling (see "Remote stage dispatch (columns.json)" above).

The wave also ends only when the repair pass has settled (see "Repair
(queued PRs behind the default branch)" above): the slot is free, and every
PR in the repair set has merged, parked, is waiting for a human merge, or is
queued with checks that stopped pending a full cycle ago (reported as
queued). Settle it before the worktree cleanup, because the conflict path
dispatches agents.

Before reporting, run the worktree cleanup above (no agents in flight) so the
lead's checkout is left on the default branch with a clean tree, then post the
token report from "Token report (wave end)" above on each package issue.

Collect the `LESSONS:` lines from the wave's tester and reviewer reports, one
bullet per distinct lesson. This channel ends at the report: promoting a
lesson into `.claude/process-core.md` or `docs/architecture/` is a human
decision. Inside an `/tm-advisor` batch, lessons go in the batch report
instead (its skill section 5).

Report to the user: PRs merged, queued, and waiting for a human merge (with
the reason), packages parked (`needs-human`, with their open questions),
issues deferred to later waves or stopped at the gate, which PRs were
repaired (and how), and any lessons.
Classify each ready PR with the gate's read (`gh pr view <n> --json
state,autoMergeRequest`, see "Resume detection") at report time, so a merge
that landed during the wave shows as merged. A repaired PR's line gets the
suffix `(repaired: clean update)` or `(repaired: conflict resolved)`, as in
the merged example below, on whichever outcome it ended in. End with:

```
## What happened
- PR #NN merged  - <package title>
- PR #NN merged (repaired: clean update)  - <package title>
- PR #NN queued (waiting on checks)  - <package title>
- PR #NN waiting for a human merge (<reason>)  - <package title>
- #NN parked (needs-human): <the open question>
- #NN parked (needs-human): second repair needed: <reason>
- Lesson (#NN, tester|reviewer): <the lesson> (only if a seat reported one)
- Run-long fallback fired on #NN: judgment switched to Sonnet, see <decision comment link> (only if the switch fired this run)

## Next steps
1. /tm-kickoff #NN to re-review on Opus before merge (only for packages with an owed Opus review)
2. Review & merge: #NN, #NN (only the PRs waiting for a human merge)
3. Decide on #NN (retry or close)
4. Run /tm-kickoff to start the next wave
```
