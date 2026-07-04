# Advisor operating model (CEO + advisor + autonomous team)

Status: approved design, 2026-06-12. Grilled and signed off decision by
decision in session. Implemented: `/tm-advisor` skill, CLAUDE.md "Operating
model" section, /tm-kickoff amendments (issue #36).

## Goal

Let the user act as CEO: state a need, sign off once, and get 2-4 hours of
uninterrupted autonomous work back as ready PRs, with every step and decision
documented. The existing agent team (architect, developer, tester, reviewer
under /tm-kickoff) stays as the execution layer. The new piece is the advisor:
a sparring partner that turns raw needs into signed-off work package batches
and runs them without further interruption.

## Roles

- **CEO (the user).** States needs, signs off batches, merges PRs, decides
  escalations. May also define packages directly in plan mode and hand them
  to the advisor ready-made; the advisor then files and dispatches without
  re-refining.
- **Advisor (the main session).** Not a subagent. Refines needs with the CEO,
  proposes batches, files issues, orchestrates /tm-kickoff waves, decides
  in-scope questions, keeps the batch record, reports.
- **Team (existing).** architect, developer, tester, reviewer per
  `.claude/agents/`, orchestrated as in `.claude/skills/tm-kickoff/SKILL.md`.

## Decisions

### 1. Batch = one wave; merging stays human

A signed-off batch contains only independent issues (no `Blocked by:`
between them), so the run never stalls on a merge. No agent merges to
`main`; dependent work becomes the seam between batches. "Uninterrupted"
means within a batch.

Rejected: auto-merging blockers (AI-approved code reaching `main` without
human eyes), stacked branches (retargeting plumbing, ripple on mid-chain
changes), full auto-merge.

### 2. Sign-off: approve the proposal, then file

The advisor refines the need, then presents the batch in chat: per package
a title, scope, acceptance criteria, size, and explicit non-goals. One
approval covers filing the issues AND dispatching. Nothing lands on GitHub
before the yes; the CEO decides once per batch.

Refinement depth is proportional: a small need gets a few clarifying
questions; a feature with design ambiguity gets /tm-grill-me and, if warranted,
a spec doc first.

**Amendment (2026-07-04, batch #152).** The sign-off offers two approval
outcomes plus revise. Dispatch works as above. File only files the package
issues to the backlog per the tm-to-issues conventions, with no batch
tracking issue and no `Part of batch #` line, reports the issue numbers
and how to dispatch later (/tm-kickoff or a future /tm-advisor batch),
and stops. Rejected: a batch issue marked "filed, not dispatched"; it adds
resume semantics and hides the issues from the next-batch backlog scan.

### 3. Escalation line: scope

During a run the advisor decides anything within the signed-off scope and
acceptance criteria (interpretation questions, approach trade-offs,
arbitrations), logging each decision and its reasoning on the batch issue.

It parks a package (`needs-human`) only for:

- changes to scope or acceptance criteria
- new dependencies or costs
- irreversible or outward-facing actions
- conflicts with decisions in `docs/architecture/`

### 4. Batch tracking issue

Each dispatch creates one GitHub issue for the batch holding: the approved
proposal (the contract), links to the package issues, every advisor decision
with reasoning, parked questions, and the final report. A dropped session
resumes from it. Closed when all batch PRs are merged. Package-level detail
stays on package issues and PRs as today.

### 5. Capacity: up to 6 packages, 3 concurrent

A batch holds up to 6 independent size:S/M packages, run as a queue with at
most 3 concurrent (the existing kickoff cap protects context and quota).
The advisor proposes fewer when the need is small.

### 6. Lifecycle: report, then resume on re-invocation

At batch end the advisor posts the report to the batch issue and the chat
digest, then it is done for that session (a session cannot watch PRs across
turns). When the user merges and re-invokes `/tm-advisor` with no arguments, it
reads the batch issue, confirms the PRs merged, closes the batch issue, and
proposes the next batch from the backlog (open issues not part of any batch -
no `Part of batch #` line and no `Batch:` title prefix - ordered by dependency
then creation date). Dispatch still requires sign-off;
merging is never implicit approval. A new session reconstructs state from
the open batch issue.

**Amendment (2026-07-04, batch #160).** Manual closure of the batch
issue is valid. The batch issue is a run record; the user may close it
by hand once every PR is merged. Re-running /tm-advisor is optional
bookkeeping (confirm merges, close the batch issue, release parked
issues) plus the next-batch proposal, not a required step. To make the
hand-close safe, the backlog scan treats an issue whose
`Part of batch #N` line points at a closed batch as backlog; only
membership in an open batch excludes an issue.

### 7. Parking pings: hold for the report

Parked packages are logged on the batch issue; the CEO sees them in the
end-of-batch report. Exception: if ALL packages park, the advisor pings
immediately, since nothing is progressing.

### 8. Codification

- A new user-invocable skill (`/tm-advisor`) encoding the loop:
  intake, refine, propose, sign-off, file issues + batch issue, run kickoff
  waves, report, resume.
- A short "Operating model" section in CLAUDE.md defining the advisor role
  and the escalation line.
- Minor /tm-kickoff amendments: batch queue of up to 6, in-scope
  NEEDS_DECISION routed to the advisor instead of parking, decisions and
  verdicts mirrored to the batch issue.

Unchanged: the 3-fix-rounds-per-stage cap, the role agents and their model
routing, sizing rules, and the human merge gate.
