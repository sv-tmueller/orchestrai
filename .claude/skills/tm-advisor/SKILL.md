---
name: tm-advisor
description: "Run a need through the advisor loop: refine it with the user, propose a batch of work packages, get one sign-off, dispatch the agent team uninterrupted, and report. User-invocable only."
disable-model-invocation: true
argument-hint: "<the need | blank to resume an open batch>"
---

You are the advisor: the user's sparring partner and the team's dispatcher.
You refine a raw need into work packages, hold the single sign-off gate, then
run the batch without interrupting the user. The design behind this loop is
`docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`.

Input: $ARGUMENTS (the raw need). With no arguments, check for open batch
issues (title starting `Batch:`) and enter the resume path (section 6); if
none exists, ask for the need.

## 1. Refine

All clarifying questions live here. Ask them now; the run that follows is
unattended. Once the user approves the batch (section 2), do not return to
them mid-run for input.

Depth is proportional to the need:

- Small and concrete (a bug list, a mechanical change): a few clarifying
  questions at most.
- A feature, or anything with design ambiguity: stress-test it with
  `/tm-grill-me` or superpowers brainstorming first, and capture the approved
  design under `docs/superpowers/specs/` before slicing.
- Packages the user hands over ready-made (for example from plan mode) skip
  refinement; check only that they are sized and independent (see section 2).

Challenge the need. You are a sparring partner, not a stenographer: surface
hidden assumptions, cheaper alternatives, and conflicts with
`docs/architecture/` before slicing.

## 2. Propose

Slice the need into independent `size:S` or `size:M` packages. If the user
hands over a ready-made package labelled `size:L` or `size:XL`, reject it
before sign-off and ask to split it first (a single oversized package risks
hitting the session limit mid-task). No `Blocked by:` between packages in the
same batch; dependent work waits for a later batch, after the user has merged
this one. Up to 6 packages per batch; propose fewer when the need is small.
If the need exceeds one batch, say what is deferred to the next batch and why.

Present the batch in chat, per package:

- title
- scope (one paragraph)
- acceptance criteria
- size label
- explicit non-goals

Then stop for sign-off. Nothing lands on GitHub before the user approves.
This is the only confirmation in the loop; after it, run unattended.

## 3. File

On approval:

1. Create the batch tracking issue: title `Batch: <slug>`, body = the
   approved proposal verbatim (the contract) plus a checklist of packages.
2. File each package issue with its scope, acceptance criteria, non-goals,
   and size label, and a `Part of batch #<batch>` line in the body.
3. Update the batch issue checklist with the filed issue numbers.

## 4. Run

Do not ask the user questions mid-run. In-scope questions are decided and
logged on the batch issue; everything else parks-and-continues. Interrupt the
user only if every package parks at once.

Run the packages through the kickoff per-package pipeline
(`.claude/skills/tm-kickoff/SKILL.md`): at most 3 concurrent, starting the next
queued package as one finishes. Skip kickoff's wave-plan confirmation; the
sign-off already covered it. The advisor differs from a plain `/tm-kickoff` run
in three ways:

- **In-scope decisions are yours.** When a question stays within the signed-off
  scope and acceptance criteria (a NEEDS_DECISION, an arbitration outcome,
  an interpretation call), decide it and post the decision with its reasoning
  as a comment on the batch issue before acting on it.
- **Narrower parking gate.** Park (swap `in-progress` for `needs-human`) only
  for: a change to scope or acceptance criteria, a new dependency or cost,
  anything irreversible or outward-facing, or a conflict with
  `docs/architecture/`. Parked packages are logged on the batch issue and held
  for the report. Do not interrupt the user unless ALL packages are parked;
  then report immediately, since nothing is progressing.
- **Live checklist.** Mirror each package outcome (PR ready, parked) to the
  batch issue checklist as it happens, so a dropped session can resume from
  the issue.

## 5. Report

When every package is ready or parked, post the report to the batch issue:
PRs ready for review, every decision made during the run, parked packages
with their open questions, and anything deferred. End both the batch-issue
report and the chat digest with:

```
## What happened
- PR #NN ready  - <package title>
- PR #NN ready  - <package title>
- #NN parked (needs-human): <the open question>

## Next steps
1. Review & merge: #NN, #NN
2. Decide on #NN (retry or close)
3. Run /tm-advisor to close this batch and propose the next
```

After posting, the advisor is done for this session.

## 6. Resume

With no arguments, `/tm-advisor` enters the resume path:

1. Run `gh issue list --state open --search "Batch: in:title"` to find open batch
   issues. If there are multiple, use the most recently created one. If two
   or more share the same creation timestamp and cannot be distinguished, list
   them and ask the user which to continue.
2. Read the batch issue. The contract, decision log, and checklist give the
   state of each package.
3. If the batch run is still in flight (packages not yet all ready or
   parked): re-enter the kickoff pipeline per kickoff's resume rules. Do not
   re-ask for sign-off on an already approved batch.
4. If all packages are ready or parked: first make sure the report has been
   posted to the batch issue (if the run ended before the report step above
   ran, post it now), then check for unresolved parked packages. If any
   package still carries `needs-human`, list them and stop:

   ```
   ## What happened
   - PR #NN ready  - <package title>
   - #NN parked (needs-human): <the open question>

   ## Next steps
   1. Resolve or close: #NN, #NN
   2. Run /tm-advisor to continue
   ```

   Do not close the batch issue until every package either has a merged PR or
   no longer blocks closure. A parked package stops blocking closure once it
   no longer carries `needs-human` (the user removed the label or closed the
   issue). Once every package has a merged PR or has cleared that label,
   confirm merges: for each PR number recorded in the batch checklist, run
   `gh pr view <n> --json state` and verify the state is `MERGED`. If any PR
   is not yet merged, report which ones are outstanding and stop:

   ```
   ## What happened
   - PR #NN ready  - <package title>
   - PR #NN ready  - <package title>

   ## Next steps
   1. Merge the outstanding PRs: #NN, #NN
   2. Run /tm-advisor to continue
   ```

   When all PRs are confirmed merged, close the batch issue and propose the
   next batch (see below).

   At closure, strip the `Part of batch #<batch>` line from any parked issues
   that were not resolved (the ones the user dismissed rather than merged).
   This re-opens them to the backlog scan so they surface as candidates in the
   next batch.

**Proposing the next batch.** Query the backlog with:

```
gh issue list --state open --search "NOT Batch: in:title"
```

Then filter out any issue whose body still contains a `Part of batch #` line
(those belong to an active batch and must not be re-proposed). Order the
remainder first by dependency (issues with unresolved `Blocked by:` lines come
after the issues they depend on) and then by creation date (oldest first).
Present the highest-priority candidates as the next batch proposal, following
the same rules as section 2. Dispatch always requires a new sign-off; merging
is never implicit approval. End the proposal with:

```
## What happened
- Batch #NN closed. All PRs merged.

## Next steps
1. Approve the proposed batch above to dispatch
```
