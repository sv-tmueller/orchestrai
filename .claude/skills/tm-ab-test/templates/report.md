# A/B test: <task title> - YYYY-MM-DD

Save as `docs/reviews/YYYY-MM-DD-ab-<task-slug>.md`. Reports are immutable
once written; append the summary row to `docs/reviews/ab-tests.md` instead
of editing this file later.

Task: #<task-issue-number>, `<task title>`.

Base commit: `<base-commit>` (both arms forked from here).

## Arm A: <name>

Status: run headless | run supervised | not run.

- Description: <what this arm varied>
- Scratch issue: #<n> (if issue-driving)
- Branch: `<arm-branch>`
- Draft PR: <url>
- Window: `<start-ISO>` to `<end-ISO>`
- Wall-clock: <duration>
- Agent/subagent count: <n>
- Token usage: <from the token-burn script's JSON output>
- Diff size: <files changed, lines added/removed>
- Independent review (tm-review-changes, base `<base-commit>`): <verdict and summary>
- Acceptance-criteria drift: <none, or what drifted>

## Arm B: <name>

Status: run headless | run supervised | not run.

- Description: <what this arm varied>
- Scratch issue: #<n> (if issue-driving)
- Branch: `<arm-branch>`
- Draft PR: <url>
- Window: `<start-ISO>` to `<end-ISO>`
- Wall-clock: <duration>
- Agent/subagent count: <n>
- Token usage: <from the token-burn script's JSON output>
- Diff size: <files changed, lines added/removed>
- Independent review (tm-review-changes, base `<base-commit>`): <verdict and summary>
- Acceptance-criteria drift: <none, or what drifted>

## Headline numbers

| | Arm A | Arm B |
| --- | --- | --- |
| Status | run headless / run supervised / not run | run headless / run supervised / not run |
| Wall-clock | | |
| Agents | | |
| Tokens | | |
| Diff size | | |
| Independent review | | |

## Reading this result

One paired run is illustrative, not conclusive. Treat any directional
difference between the arms as a hypothesis for a follow-up run, not a
settled outcome, per the appendix in
`docs/reviews/2026-06-30-orchestration-comparison.md`.

## Cleanup

- [ ] Scratch issues closed.
- [ ] Draft PRs closed (after both diffs are linked above).
- [ ] Branches and worktrees cleaned up.
- [ ] Original task issue left untouched; a human picks a winner from this
      writeup.
