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
The lead sizes an unsized issue itself (S or M, from the body); only L and XL
go to the architect for a split. An issue blocked by #N starts in the same run
once #N merges. Per issue:

1. Label `in-progress`. Dispatch the developer with the issue number.
2. The developer works in its own worktree with TDD, runs the full check
   suite, pushes, opens a draft PR, and reports `STATUS`, `PR`, `CHECKS`,
   `NOTES`.
3. Run the review gate (next section).
4. Reviewer verdict. `APPROVE`: ship. `CHANGES_REQUESTED`: a fresh developer
   dispatch fixes the must-fix findings, then one re-review. At most 2 fix
   rounds, then park the package as `needs-human`. A reviewer that hits a
   usage limit runs once more on Sonnet; its `APPROVE` ships like any other.
5. Ship: mark the PR ready, queue auto merge where the gate allows it (see
   "Merge gate"), remove `in-progress`. At wave end, prune finished agent
   worktrees (skill, section 6).

A developer who disputes a finding: on Claude the lead settles it, asking the
architect when unsure; the Hermes driver parks the package as `needs-human`.

Should-fix and nit findings go in the review comment on the PR and are not
carried further. The reviewer never files follow-up issues. The lead files one
only for a real bug found outside the PR's scope.

## Review gate

A reviewer runs when any of these holds:

- the issue is `size:M` or larger;
- the diff touches `.claude/agents`, `.claude/skills`, `.claude/workflows`,
  `.github/workflows`, or a dependency manifest or lockfile;
- the developer reported `DONE_WITH_CONCERNS`.

Otherwise the lead checks the developer's `CHECKS` line. A command that did not
exit 0 sends the package back to the developer as a fix round, with a PR
comment `Fix round <k>: red checks`; else the lead notes in a PR comment that review was not required.
The reviewer always runs the check suite once itself.

## Merge gate

The default branch requires the CI checks plus `orchestrai/review`. It never
requires `orchestrai/test` (no tester earns it) or an up to date PR.

- The reviewer's `CHECKS` line starts with the head SHA it tested. After
  `APPROVE`, the lead posts `orchestrai/review` = `success` on that SHA with
  one `gh api` call, only when the SHA equals the PR head. If the head moved,
  the reviewer runs again on the new head.
- When the gate skipped the reviewer, the lead posts the same status on the PR
  head after its own `CHECKS` check, with the description
  `not required (size S)`.
- The lead does not wait for CI before posting. Auto merge waits for every
  required context, CI included.
- Auto merge is queued only when `allow_auto_merge` is true and the default
  branch is protected (classic protection or a ruleset); on an unprotected
  branch `--auto` merges before CI. Otherwise the PR is marked ready and
  reported as waiting for a human merge.
- A queued PR that GitHub reports as conflicting (`mergeStateStatus` `DIRTY`)
  goes to a developer dispatch to merge main and resolve, then the review gate
  runs again.

## Resume

From GitHub state only, with no other rules:

- `in-progress` and no PR: restart the developer. Find a PR with
  an open PR whose `closingIssuesReferences` names the issue; a search on
  the body text also matches a PR that only mentions the number.
- A PR and no review comment: run the review gate. On an S issue this still
  means the gate, not a new developer dispatch.
- A review comment: continue from its verdict. The cap counts the
  `CHANGES_REQUESTED` comments and the `Fix round <k>: red checks` comments
  together.

## Not in this flow

No architect stage, no tester stage, no plan-status blocks, no `phase:*`,
`track:*`, `runner*`, `run:*` or `claimed:*` labels, no ship-decision script,
no repair pass beyond the conflict rule, no remote stage dispatch, no
wave-end token report. The architect stays available on demand, to split an
`L` issue or settle a developer and reviewer dispute.
