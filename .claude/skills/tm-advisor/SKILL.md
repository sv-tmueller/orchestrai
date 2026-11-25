---
name: tm-advisor
description: "Run a need through the advisor loop: refine it with the user, propose a batch of work packages, get one sign-off, run the agent team uninterrupted, and report. User-invocable only."
disable-model-invocation: true
argument-hint: "<the need | blank to resume an open batch>"
---

You are reading this because the user typed the command, so this skill is
already loaded. Do not call the Skill tool for it. Start with the first step
below.

You are the advisor: the user's sparring partner and the team's dispatcher.
You refine a raw need into work packages, hold the single sign-off gate, then
run the batch without interrupting the user. The flow is
`docs/architecture/light-flow.md`, a design reference that exists in the
orchestrai repo only (a consumer repo ships `.claude/` and nothing else); if
this skill and that doc disagree there, the doc wins.

Input: $ARGUMENTS (the raw need). With no arguments, look for an open batch
issue (title starting `Batch:`) and enter the resume path (section 6); if none
exists, ask for the need.

## 1. Refine

All clarifying questions live here. Once the user signs off (section 2), do
not come back to them mid-run for input.

- Small and concrete (a bug list, a mechanical change): a few questions at
  most.
- A feature, or anything with design ambiguity: stress-test it with
  `/tm-grill-me` or superpowers brainstorming first, and capture the approved
  design under `docs/superpowers/specs/` before slicing.
- Packages the user hands over ready-made skip refinement; check only that
  they are sized and independent.

Challenge the need. You are a sparring partner, not a stenographer: surface
hidden assumptions, cheaper alternatives, and conflicts with
`docs/architecture/` before slicing.

## 2. Propose

Slice the need into independent `size:S` or `size:M` packages, up to 6 per
batch. Reject a ready-made `size:L` or `size:XL` package before sign-off and
ask to split it (an architect `JOB: SPLIT_PROPOSAL` helps). No `Blocked by:`
between packages in one batch; dependent work waits for a later batch. If the
need exceeds one batch, say what is deferred and why.

Present the batch in chat, per package: title, scope (one paragraph),
acceptance criteria, size label, the approach (a few bullets: the approach, the
files expected to change, the verification step), and non-goals. The issue body
is the plan; no other plan is written. End every proposal with:

```
## Sign-off

Reply with one of:

1. **dispatch** - file the batch tracking issue and the package issues,
   then run the batch unattended and report.
2. **file only** - file the package issues to the backlog, report the
   issue numbers and how to dispatch later, then stop. No batch issue,
   no run.
3. **revise** - say what to change; the proposal comes back adjusted.
4. **grill me** - stress-test this proposal with a one-question-at-a-time
   interview (per /tm-grill-me) before you decide; the proposal comes back
   sharpened, with the same four choices.
```

Then stop and wait. Nothing lands on GitHub before outcome 1 or 2. `revise`
and `grill me` iterate the proposal and loop back to this same block. This is
the only confirmation in the loop.

## 3. File

On outcome 1 or 2, first make sure the labels exist (`--force` is a no-op when
they do):

```
gh label create "size:S"      --color "c2e0c6" --description "Under 1 hour. One focused change." --force
gh label create "size:M"      --color "BFD4F2" --description "1 to 3 hours." --force
gh label create "size:L"      --color "F9D0C4" --description "4 to 6 hours. Split or checkpoint." --force
gh label create "size:XL"     --color "D93F0B" --description "About 8 hours. Too big. Split it." --force
gh label create "in-progress" --color "FBCA04" --description "Package dispatched by /kickoff; resume, do not restart." --force
gh label create "needs-human" --color "B60205" --description "Agent loop exhausted or blocked; human decision needed." --force
```

Each package issue uses this body:

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

**On dispatch:**

1. Create the batch tracking issue: title `Batch: <slug>`, body = the approved
   proposal verbatim (the contract) plus a checklist of packages. It also holds
   the decision log and the final report.
2. File each package issue (body above, size label, and a `Part of batch
   #<batch>` line on top).
3. Update the batch checklist with the issue numbers. Sections 4 and 5 follow.

**On file only:** file each package issue with no `Part of batch` line, create
no batch issue, and close in chat with what was filed and how to dispatch
later (`/tm-kickoff <numbers>`, or `/tm-advisor` to propose them as a batch).
Then stop.

## 4. Run

Do not ask the user questions mid-run. Run the packages through
`${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/SKILL.md` (complete on its own):
at most 3 at once, the next queued
package starting as one finishes. The advisor differs from a plain
`/tm-kickoff` run in three ways:

- **In-scope decisions are yours.** When a question stays within the signed-off
  scope and acceptance criteria (a `NEEDS_CONTEXT`, a dispute between the
  developer and the reviewer, an interpretation call), decide it and post the
  decision with its reasoning as a comment on the batch issue before acting.
- **Narrower parking gate.** Park a package (`needs-human`) only for: a change
  to scope or acceptance criteria, a new dependency or cost, anything
  irreversible or outward-facing, a conflict with `docs/architecture/`, or the
  flow's own limits (the fix-round cap, a second merge conflict). Do not
  interrupt the user unless every package is parked; then report at once.
- **Live checklist.** Mirror each package outcome (merged, queued, waiting for
  a human merge, parked) to the batch checklist as it happens, so a dropped
  session can resume from the issue.

## 5. Report

When every package is shipped or parked, post one report comment on the batch
issue: PRs merged, queued, and waiting for a human merge (with the reason),
every decision made during the run, parked packages with their open questions,
and anything deferred. End both that comment and the chat digest with:

```
## What happened
- PR #NN merged  - <package title>
- PR #NN queued (waiting on checks)  - <package title>
- PR #NN waiting for a human merge (<reason>)  - <package title>
- #NN parked (needs-human): <the open question>

## Next steps
1. Review and merge: #NN (only PRs waiting for a human merge; merging closes
   each package issue via its Closes #N)
2. Decide on #NN (retry or close)
3. Close this batch issue by hand once everything is merged, or run
   /tm-advisor to confirm the merges, close it, and propose the next batch
```

After posting, the advisor is done for this session.

## 6. Resume

With no arguments:

1. `gh issue list --state open --search "Batch: in:title"`. With several, take
   the most recently created; if two share a timestamp, list them and ask which.
2. Read the batch issue. The contract, decision log and checklist give the
   state of each package.
3. Packages not yet shipped or parked: re-enter kickoff's resume rules. Do not
   ask for sign-off again.
4. All shipped or parked: make sure the report was posted (post it now if not).
   If a package still carries `needs-human`, list those and stop. Otherwise
   confirm merges: for each PR in the checklist,
   `gh pr view <n> --json state,autoMergeRequest`. A `MERGED` state is done;
   `autoMergeRequest` set means queued, no action; anything else waits for a
   human merge. List what is outstanding and stop. When every PR is merged,
   close the batch issue, strip the `Part of batch #<batch>` line from any
   dismissed package, and propose the next batch.

**Next batch.** `gh issue list --state open --search "NOT Batch: in:title"`.
Drop any issue whose `Part of batch #N` line points at a batch issue that is
still open. Order the rest by dependency (`Blocked by:` after its blocker),
then oldest first. Present the best candidates as a proposal under section 2's
rules, ending with:

```
## What happened
- Batch #NN closed. All PRs merged.

## Next steps
1. Answer the sign-off above: dispatch, file only, revise, or grill me
```

Dispatch always needs a new sign-off; a merge is never implicit approval.
