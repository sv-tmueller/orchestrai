# Light flow

The one flow the Claude skills (`tm-advisor`, `tm-kickoff`) and the Hermes
driver (`hermes-pipeline.mjs`) both follow. Design:
`docs/superpowers/specs/2026-11-25-light-orchestrator-design.md`.

Per package: a developer, then a reviewer only for bigger or risky work. The
plan lives once, in the issue body. Labels used: `size:*`, `in-progress`,
`needs-human`. Nothing else.

## Advisor

1. Refine the need with the user (`/tm-grill-me` stays available).
2. Propose a batch of up to 6 issues, each sized `S` or `M`, each body written
   to the template below. Split `L` and `XL` before proposing.
3. One sign-off: dispatch, or file only.
4. File the issues. Dispatch runs the kickoff flow on them.

The batch tracking issue (`Batch: <slug>`) holds the contract, the decision
log and the final report. A dropped advisor session resumes from it.

## Issue body

The body is the plan. No other plan is written.

```
## What to build
<the need, in a few sentences>

## Approach
<a few bullets: the approach, the files expected to change, the
verification step>

## Acceptance criteria
- [ ] ...

## Non-goals
- ...
```

An issue filed by hand without an `## Approach` section gets one from the lead
before dispatch, as a short comment with the same bullets. The lead never
dispatches a developer with no plan.

## Kickoff

Up to 3 packages run at once. When one finishes, the next queued one starts.
Per issue:

1. Label `in-progress`. Dispatch the developer with the issue number.
2. The developer works in its own worktree with TDD, runs the full check
   suite, pushes, opens a draft PR, and reports `STATUS`, `PR`, `CHECKS`,
   `NOTES`.
3. Run the review gate (next section).
4. Reviewer verdict. `APPROVE`: ship. `CHANGES_REQUESTED`: a fresh developer
   dispatch fixes the must-fix findings, then one re-review. At most 2 fix
   rounds, then park the package as `needs-human`.
5. Ship: mark the PR ready, queue auto merge where the repo allows it (see
   "Merge gate"), remove `in-progress`.

A developer who disputes a finding, or a third failed fix round, parks the
package as `needs-human`.

Should-fix and nit findings go in the review comment on the PR and are not
carried further. The reviewer never files follow-up issues. The lead files one
only for a real bug found outside the PR's scope.

## Review gate

A reviewer runs when any of these holds:

- the issue is `size:M` or larger;
- the diff touches `.claude/agents`, `.claude/skills`, `.claude/workflows`,
  `.github/workflows`, or a dependency manifest or lockfile;
- the developer reported `DONE_WITH_CONCERNS`.

Otherwise the lead checks that every command on the developer's `CHECKS` line
exited 0 and moves on. The reviewer always runs the check suite once itself.

## Merge gate

`main` requires the CI checks plus `orchestrai/review`. It never requires
`orchestrai/test`: there is no tester to earn it.

- After `APPROVE`, the lead posts `orchestrai/review` = `success` on the PR
  head with one `gh api` call.
- When the gate skipped the reviewer, the lead posts the same status after its
  own `CHECKS` check, with the description `not required (size S)`.
- The lead does not wait for CI before posting. Auto merge waits for every
  required context, CI included.

## Resume

From GitHub state only:

- `in-progress` and no PR: restart the developer.
- A PR and no review comment: run the review gate. On an S issue this still
  means the gate, not a new developer dispatch.
- A review comment: continue from its verdict.

No other resume rules.

## Not in this flow

No architect stage, no tester stage, no plan-status blocks, no `phase:*`,
`track:*`, `runner*`, `run:*` or `claimed:*` labels, no ship-decision script,
no repair pass for PRs behind main, no remote stage dispatch, no wave-end
token report. The architect stays available on demand, to split an `L` issue
or settle a developer and reviewer dispute.
