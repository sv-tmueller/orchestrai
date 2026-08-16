# Process core

Harness-neutral process guidance: it should hold for a solo contributor or a
different agent stack, not just this one team. Team-specific process guidance
(the agent roster, the advisor model, model policy, how to pick up a task)
lives in `.claude/team-guide.md`.

## How we work

### Issues and branches

- Every unit of work is a GitHub issue first. Nothing new gets built without an issue.
- Branch from `main` per issue: `feat/<issue-number>-<short-slug>` or
  `fix/<issue-number>-<short-slug>`.
- Merge via PR. Direct pushes to `main` are blocked.
- The PR references the issue with `Closes #N`. One topic per PR.

### Sizing (t-shirt size per issue)

Every issue carries a t-shirt size label, estimated in human working hours:

- `size:S` - under 1 hour. One focused change.
- `size:M` - 1 to 3 hours. Write a sub-plan first.
- `size:L` - 4 to 6 hours. Split into smaller issues, or break into checkpointed
  sub-plans (below).
- `size:XL` - a full day, about 8 hours. Too big to start as one issue. Split it.

Size the issue when you file it, then re-check while planning. If the full
plan shows the work is bigger than its label, re-label and split rather than
push through (rationale: docs/team-guide-rationale.md).

### Sub-plans (checkpoint before deep work)

Before any deep planning or implementation, write a short sub-plan first: a
handful of checkpoint bullets (the approach, the files you expect to touch, the
order, the verification step) posted in the issue or the draft PR. This is cheap
insurance: if the connection drops or the session hits its limit, the next
session reads the checkpoint and resumes instead of restarting. For anything
sized `M` or larger, the sub-plan is also where you confirm the work still fits
one session and decompose it if it does not. Expanding it into a full plan comes
later (see "How to pick up a task" in .claude/team-guide.md).

### Commits

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`,
  `perf:`, `build:`, `ci:`.
- Imperative mood, lowercase, no period.
- The body explains why, not what.

### Tests

- Logic that has a right answer (math, parsing, business rules) is TDD: write the
  failing test against known inputs first, then the code.
- Integration clients are tested against saved fixtures, not live endpoints.
- End-to-end tests live in `e2e/` and gate deployment. Run them locally before
  pushing any change that touches the full stack. Unit-green is not e2e-green.

### CI cost policy

- Agents verify locally first; CI is the final gate, not the first check.
- e2e in CI runs on ready-for-review PRs and on pushes to `main` only. Draft
  PRs run cheaper checks instead (typecheck, lint, unit).
- Every CI job pins `timeout-minutes`. A `concurrency` group with
  `cancel-in-progress: true` is mandatory on every workflow.
- Making a repo public to escape the free-minutes limit is forbidden. Fix the
  workflow instead.
- See the CI template under `.claude/skills/tm-new-project/` for the worked
  example.

### Writing style (commits, PRs, docs, comments)

- No em dashes. Use regular hyphens, commas, or parentheses.
- No AI-cliche phrases ("leverage", "robust", "seamless", "comprehensive",
  "elevate", "delve", "in the realm of", "it's worth noting", "moreover",
  "furthermore"). Plain, direct English. Short sentences.
- Add a comment only when the why is non-obvious. Do not restate what the code does.

## What not to do

- Don't push directly to `main`. Open a PR.
- Don't merge a PR that has not run the full check suite, including e2e if the
  change touches the stack.
- Don't bypass git hooks (`--no-verify`). If a hook fails, fix the cause.
- Don't introduce a new dependency without saying why in the PR body.

## When in doubt

Ask. A 30-second clarifying question beats a 30-minute wrong direction.
