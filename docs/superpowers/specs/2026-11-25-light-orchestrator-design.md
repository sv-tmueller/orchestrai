# Light orchestrator design

Date: 2026-11-25. Status: approved by the owner (merge gate: option A).

## Intent

The team pipeline costs far too many tokens. A colleague built the relai MVP
through `/tm-advisor` plus `/tm-kickoff`, and it used two weeks of token limit
for work that should take about half a day. The owner wants the orchestrator
lighter and less strict: developer subagents stay, a reviewer runs only on
bigger work, the tester goes, and planning happens once instead of twice.

This replaces the current pipeline. It does not trim it in place.

## Where the tokens go today

- `tm-kickoff/SKILL.md` is 1,271 lines (72 KB, about 18k tokens), loaded into
  the lead on every run, on top of `team-guide.md` (15 KB) and
  `tm-advisor/SKILL.md` (15 KB). Most of it covers runners, columns, repair
  passes, ship-decision statuses, the token report and plan-status blocks.
- Every package runs four fresh agents in series: architect sub-plan,
  developer, tester, reviewer. Each re-reads the repo. Every fix round runs
  test and review again. Architect and reviewer run Opus at xhigh.
- Planning happens up to three times: the advisor refines and proposes, the
  architect writes a sub-plan per issue, and the team guide asks for a full
  plan in `docs/plans/` outside kickoff.
- The lean track (no architect, no tester) is narrow (`size:S`, 150 lines,
  no `.claude/` paths), so most work runs the full track.
- The reviewer files a "Follow-ups from PR #N" issue for every should-fix
  nit. 8 of the 11 open issues on 2026-11-25 are such follow-ups, and each one
  becomes another full pipeline run.

## Goals

- One planning step. The plan lives in the issue body.
- Per package: developer, then a reviewer only for bigger or risky work.
- The lead's instructions are short: each Claude skill (advisor, kickoff)
  under about 200 lines.
- A dropped session can still resume from GitHub state.
- The Hermes side follows the same light flow, kept ready for future use.

## Non-goals

- Changing the seat adapters (`hermes-adapter.mjs`, `codex-adapter.mjs`,
  `claude-code-subprocess.mjs`, the adapter tables, renderers, prompts
  sync). They dispatch one seat and stay as they are, except where a
  deleted role (tester) must be removed from their tables.
- Changing the guard (`.claude/guard/`), `tm-repo-guard` CI templates, or the
  `tm-review-*`, `tm-map-codebase`, `tm-security-audit` workflows.
- New features. This is a removal and rewrite.

## Anti-goals

- A light flow that quietly ships broken code: the developer must still run
  the check suite, and CI must still gate the merge.
- Re-growing the old rule set in new words. If a rule exists only to cover a
  rare edge case, it does not go in the skill.
- Drift between the Claude flow and the Hermes driver: both point at one short
  flow doc.

## Approaches considered

1. Short prose skills on both harnesses, delete the Hermes driver. Least code,
   but weaker local models drift from prose more than Claude does.
2. **Chosen.** Short prose skills on Claude, a slimmed Hermes driver that
   enforces the same flow in code. Flexible where the owner works today,
   enforced where a future weaker model may need it. One flow doc both
   implement.
3. One shared driver for both, Claude seats as `claude -p` subprocesses. No
   drift, but rigid (the opposite of the goal) and it gives up in-session
   subagents and worktrees on Claude.

The owner picked 2.

## The flow

One short doc, `docs/architecture/light-flow.md`, states the flow below. Both
the Claude skills and the Hermes driver follow it and link to it.

### Advisor (refine and sign off)

1. Refine the need with the user (unchanged in spirit; `/tm-grill-me` stays
   available).
2. Propose a batch: up to 6 issues, each sized `S` or `M`, with the issue
   body as the plan (template below). `L` and `XL` are split before the
   proposal.
3. One sign-off: dispatch, or file only.
4. File the issues. Dispatch runs the kickoff flow on them.

The batch tracking issue (`Batch: <slug>`) stays: contract, decision log,
final report. It is how a dropped advisor session resumes.

### Issue body template (the one plan)

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

An issue filed by hand without an `## Approach` section gets one from the
lead before dispatch (a short comment, same bullets). No architect stage.

### Kickoff (per issue)

Up to 3 packages run at once; the next queued one starts when one finishes.

1. Label `in-progress`. Dispatch the developer with the issue number.
2. The developer works in its worktree, TDD, runs the full check suite,
   pushes, opens the PR (draft), and reports `STATUS`, `PR`, `CHECKS`,
   `NOTES` (the current report contract minus the sub-plan references).
3. Review gate. A reviewer runs when any of these holds:
   - the issue is `size:M` or larger;
   - the diff touches a risky path: `.claude/agents`, `.claude/skills`,
     `.claude/workflows`, `.github/workflows`, dependency manifests or
     lockfiles;
   - the developer reported `DONE_WITH_CONCERNS`.
   Otherwise the lead checks the developer's `CHECKS` (all exit 0) and moves
   on.
4. Reviewer verdict. `APPROVE`: ship. `CHANGES_REQUESTED`: a fresh developer
   dispatch fixes the must-fix findings, then one re-review. At most 2 fix
   rounds, then park as `needs-human`.
5. Ship: mark the PR ready, and queue auto merge where the repo allows it
   (see "Merge gate" below). Remove `in-progress`.

Should-fix and nit findings go in the review comment on the PR and are not
carried further. The reviewer never files follow-up issues. The lead files
one only for a real bug found outside the PR's scope.

### What the lead does not do any more

No architect stage, no tester stage, no plan-status blocks, no `phase:*`,
`track:*`, `runner*`, `run:*`, `claimed:*` labels, no ship-decision script,
no repair pass for queued PRs behind main, no remote stage dispatch
(columns), no subprocess seat dispatch from the Claude skill, no wave-end
token report, no dependency-environment step. Parking keeps `needs-human`.

### Resume

From GitHub state only: an issue with `in-progress` and no PR restarts the
developer; with a PR and no review comment, run the review gate; with a
review comment, continue from its verdict. No other resume rules.

## Merge gate

`main` today requires three statuses: `Unit tests` (CI), `orchestrai/test`
and `orchestrai/review` (posted by the lead via `ship-decision.mjs`). With no
tester, `orchestrai/test` cannot be earned. Owner's decision (option A, over
dropping both or faking the test status):

- Drop `orchestrai/test` from the required contexts on every repo that has
  it, and from the `tm-repo-guard` setup docs.
- Keep `orchestrai/review` required. The lead posts it `success` on the PR
  head after an `APPROVE`, or after the lead's own check when no reviewer was
  required (description `not required (size S)`). One `gh api` call, no
  script.
- Auto merge stays where the repo allows it. The lead does not wait for CI
  before posting `orchestrai/review`: auto merge already waits for every
  required context, `Unit tests` included. (Lead's call.)
- Order: the branch protection change (issue 6) lands before the kickoff
  rewrite (issue 2), so no PR is ever blocked on a status nothing posts.
  It covers every repo whose `main` requires `orchestrai/test`, found with
  `gh api`. (Lead's call.)

## Migration (lead's call)

The new skills ignore the old label families (`phase:*`, `track:*`,
`runner*`, `run:*`, `claimed:*`). Issue 6 also deletes those labels from
each affected repo, which removes them from open issues and PRs. Work in
flight under the old pipeline is finished by hand or re-run under the new
one.

## Agents

- `developer`: keep. Drop sub-plan references; the issue's `## Approach`
  section is the spec.
- `reviewer`: keep, Opus at xhigh. Drop the lean-track check-suite section and
  the tester-claims input; it always runs the check suite once itself, since
  there is no tester. Drop follow-up-issue behavior.
- `tester`: delete (agent file, adapter prompt, persona, adapter table rows,
  tests that name it).
- `architect`: keep as on-demand only (splitting an `L` issue, arbitrating a
  developer/reviewer dispute). Never a pipeline stage.
- `fact-checker`, `docs-writer`, `perf-investigator`: unchanged, on demand.

## Hermes driver

Rewrite `hermes-pipeline.mjs` to the same flow: developer, the same review
gate, at most 2 fix rounds, ship, `needs-human` on park, resume from GitHub
state. Remove the architect stage, tester stage, arbitration stage and the
rules that served them. `SKILL.hermes.md` for kickoff and advisor follow the
new flow and find the driver through a root variable with `.claude` as the
default (this absorbs #627). Dry run stays. Target: well under half of
today's 1,132 lines. The reviewer seat runs the judgment tier from the
Hermes adapter table, as today. With no arbitration stage, a developer who
disputes a finding, or a third failed fix round, parks the package as
`needs-human`. (Lead's calls.)

## What gets deleted

- `tm-kickoff/`: `lean-allowed.mjs`, `ship-decision.mjs`, `columns.mjs`,
  `same-changes.mjs`, `token-report.mjs`, `token-prices.json`, and their
  tests (`lean-allowed`, `ship-decision`, `columns-config`, `same-changes`,
  `token-report`, `kickoff-*-text`).
- `.claude/agents/tester.md` and its adapter prompt, persona and tests.
- Sections of `team-guide.md` and `docs/team-architecture.md` that describe
  the old pipeline, plan-status blocks, tracks and runner labels.
- Tests that pin text of removed sections. Tests of what stays (effort
  policy, prompts sync, role-contract sync) are updated, not deleted.

## Backlog

Close on merge of this work, with a pointer to the batch:

- #452 (agent-runner): runners and columns are removed.
- #614 (AGENTS.md follow-ups): `team-guide.md` is rewritten.
- #617, #621, #623, #626, #624, #616: Hermes follow-ups and the advisor port,
  superseded by the driver rewrite.
- #627: absorbed into the driver rewrite.
- #618 (guard `env -S` edge cases): close as won't-fix, low value.

Keep: #549 (plugin-off runbook, unrelated).

## Suggested split (issues, in order)

1. Flow doc `docs/architecture/light-flow.md` plus the issue body template.
   size:S.
2. Rewrite `tm-kickoff/SKILL.md` and `tm-advisor/SKILL.md` to the flow;
   delete the kickoff scripts and their tests. size:M.
3. Agents: delete tester, update developer and reviewer, adapter tables,
   prompts, personas, tests. size:M.
4. Docs: `team-guide.md`, `team-architecture.md`, README, NEW-PROJECT-SETUP,
   `tm-repo-guard` (statuses). size:M. Blocked by 2 and 3.
5. Hermes driver rewrite plus both `SKILL.hermes.md` and the root variable.
   size:M, may need splitting at planning time. Blocked by 1 and 3 (both
   touch the adapter tables).
6. Branch protection change and old-label cleanup on each affected repo
   (owner-approved, since it is outward-facing). size:S. Lands before 2.

Acceptance bar for every issue: `npm test` green.

These are built with the current pipeline only if the owner wants; building
them directly in a session (developer dispatches, one review on 2, 3 and 5)
is cheaper and is the recommendation.

## Left to the builder

- Exact wording and structure of the skills, within the size target.
- Which existing tests to update versus delete, by the rule above.
- How the driver's code is restructured, as long as dry run and resume work.
