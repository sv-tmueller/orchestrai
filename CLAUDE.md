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
  math. Locked unless explicitly revisited. (see NEW-PROJECT-SETUP)
- `docs/operations/` - how to run, deploy, and operate the system: environments,
  CI/CD, runbooks, secrets policy. (see NEW-PROJECT-SETUP)
- `docs/plans/` - implementation plans, one per task as `<issue-number>-<slug>.md`.
- `docs/superpowers/specs/` - approved designs from brainstorming, as
  `YYYY-MM-DD-<topic>-design.md`.

When code and a doc disagree, the code wins and the doc is corrected in the same PR.

## Team process

The generic team process guidance lives in `.claude/team-guide.md` and loads via the import below:

@.claude/team-guide.md

## Code style

Add project-specific style rules here and remove this line before the first implementation session.

## Repo layout

```
docs/
  architecture/      stack and policy decisions, data model, domain math (see NEW-PROJECT-SETUP);
                       also dated codebase maps from /tm-map-codebase
  operations/        run/deploy/operate: environments, CI/CD, runbooks (see NEW-PROJECT-SETUP)
  plans/             implementation plans, <issue-number>-<slug>.md
  reviews/           dated codebase-review reports from /tm-review-codebase
  superpowers/specs/ approved designs, YYYY-MM-DD-<topic>-design.md
  team-architecture.md  flat-star agent-team diagrams and rationale
e2e/                 end-to-end tests; structure depends on the app (see NEW-PROJECT-SETUP)
```

`e2e/` holds the tests that exercise the deployed system end to end. Its shape
depends on the application: a web app uses Playwright specs plus fixtures and
helpers; a CLI or service uses its own driver. In CI, e2e runs on ready-for-review
PRs and on pushes to main; draft PRs run cheaper checks instead (see the CI cost
policy in `.claude/team-guide.md`). It is the safety net unit tests cannot be: a
branch can be unit-green and still break the full stack.

## Useful commands

Record the exact commands once the project is scaffolded, so future sessions do
not rediscover them.

```bash
# install
# dev / run
# typecheck
# lint
npm test          # unit tests (node:vm, zero deps); run before commit
# e2e             (run before pushing full-stack changes)
# gh issue create
# gh pr create --draft
```
