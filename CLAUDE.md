# CLAUDE.md

Orientation for Claude Code sessions in this repo. Read this first.

## What this repo is

Describe in 2-3 sentences what this project does, who uses it, and its current
status (pre-implementation, MVP 1.0, in production). Point to the README for the
user-facing pitch and to the current implementation plan under `docs/plans/`.

Keep the status honest. If nothing is scaffolded yet, say so, so future sessions
do not assume a toolchain or test suite that does not exist.

## Working principles

The four principles in `~/.claude/CLAUDE.md` apply here: think before coding,
simplicity first, surgical changes, goal-driven execution. This file does not
repeat them; it adds only what is specific to this project.

## Where decisions live

Read these before proposing changes that touch their area:

- `docs/architecture/` - stack and policy decisions, the data model, the domain
  math. Locked unless explicitly revisited.
- `docs/operations/` - how to run, deploy, and operate the system: environments,
  CI/CD, runbooks, secrets policy.
- `docs/plans/` - implementation plans, one per task as `<issue-number>-<slug>.md`.
- `docs/superpowers/specs/` - approved designs from brainstorming, as
  `YYYY-MM-DD-<topic>-design.md`.

When code and a doc disagree, the code wins and the doc is corrected in the same PR.

## How we work

### Issues and branches

- Every unit of work is a GitHub issue first. Nothing new gets built without an issue.
- Branch from `main` per issue: `feat/<issue-number>-<short-slug>` or
  `fix/<issue-number>-<short-slug>`.
- Merge via PR. Direct pushes to `main` are blocked.
- The PR references the issue with `Closes #N`. One topic per PR.

### Sub-plans (checkpoint before deep work)

Before any deep planning or implementation, write a short sub-plan first: a
handful of checkpoint bullets (the approach, the files you expect to touch, the
order, the verification step) posted in the issue or the draft PR. This is cheap
insurance. If the connection drops or the session hits its limit, the next
session reads the checkpoint and resumes instead of restarting.

Only after that short sub-plan is committed do you expand it into a full plan via
`superpowers:writing-plans`, saved to `docs/plans/<issue-number>-<slug>.md` and
linked in the issue.

### Commits

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`,
  `perf:`, `build:`, `ci:`.
- Imperative mood, lowercase, no period.
- The body explains why, not what.

### Tests

- Logic that has a right answer (math, parsing, business rules) is TDD: write the
  failing test against known inputs first, then the code.
- Integration clients are tested against saved fixtures, not live endpoints.
- End-to-end tests live in `e2e/` and gate deployment (see Repo layout). Run them
  locally before pushing any change that touches the full stack. Unit-green is not
  e2e-green.
- Record the exact "run before commit" and "run before PR" commands under Useful
  commands once the project is scaffolded.

### Code style

Project-specific rules go here. Examples to adapt or delete:

- Strict typing; no escape hatches without a `// reason:` comment.
- Money, units, and identifiers use their dedicated types, never raw primitives.
- No hard-coded user-facing strings; use the i18n layer.
- No new dependency without a why in the PR body.

### Writing style (commits, PRs, docs, comments)

- No em dashes. Use regular hyphens, commas, or parentheses.
- No AI-cliche phrases ("leverage", "robust", "seamless", "comprehensive",
  "elevate", "delve", "in the realm of", "it's worth noting", "moreover",
  "furthermore"). Plain, direct English. Short sentences.
- Add a comment only when the why is non-obvious. Do not restate what the code does.

## Workflow defaults

Standing preferences for this project:

- Effort: maximum. Use deepest reasoning.
- Permission mode: bypass during development (user-controlled).
- Superpowers: use relevant skills proactively (brainstorming, writing-plans,
  test-driven-development, subagent-driven-development, executing-plans,
  verification-before-completion).
- Parallel work: fan out subagents for independent research or implementation
  streams. Default to parallel over serial.

## How to pick up a task

1. `gh issue list --state open` (add `--label phase:<current>` if you use phase
   labels) to see what is available.
2. Pick an unassigned issue with no unresolved blockers.
3. Post a short sub-plan on the issue (the checkpoint bullets above).
4. Create a branch and open a draft PR linking the issue (`Closes #N`). This puts
   the in-progress work in front of the user from minute one.
5. Expand the sub-plan into a full plan via `superpowers:writing-plans`, saved to
   `docs/plans/<issue-number>-<slug>.md`.
6. Implement with TDD per the plan.
7. Run the full check suite (typecheck, lint, test, e2e if touched). It must pass
   before requesting review.
8. Mark the PR ready for review.

## Repo layout

```
docs/
  architecture/      stack and policy decisions, data model, domain math
  operations/        run/deploy/operate: environments, CI/CD, runbooks
  plans/             implementation plans, <issue-number>-<slug>.md
  superpowers/specs/ approved designs, YYYY-MM-DD-<topic>-design.md
e2e/                 end-to-end tests (structure depends on the app)
```

`e2e/` holds the tests that exercise the deployed system end to end. Its shape
depends on the application: a web app uses Playwright specs plus fixtures and
helpers; a CLI or service uses its own driver. Wire it into CI as a required job
and as a pre-deploy gate. It is the safety net unit tests cannot be: a branch can
be unit-green and still break the full stack.

## Useful commands

Record the exact commands once the project is scaffolded, so future sessions do
not rediscover them.

```bash
# install
# dev / run
# typecheck
# lint
# test            (run before commit)
# e2e             (run before pushing full-stack changes)
# gh issue create
# gh pr create --draft
```

## What not to do

- Don't push directly to `main`. Open a PR.
- Don't merge a PR that has not run the full check suite, including e2e if the
  change touches the stack.
- Don't bypass git hooks (`--no-verify`). If a hook fails, fix the cause.
- Don't introduce a new dependency without saying why in the PR body.
- Don't add a comment that restates the code. Add one only when the why is
  non-obvious.
- (Add project-specific traps here: the mistakes that quietly break this codebase.)

## When in doubt

Ask. A 30-second clarifying question beats a 30-minute wrong direction.
