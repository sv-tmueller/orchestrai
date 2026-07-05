# CLAUDE.md

Orientation for Claude Code sessions in this repo. Read this first.

## What this repo is

orchestrai is a personal AI-team-orchestrator plugin, applied across the
user's own repos. It is not a template for spinning up new, unrelated
projects; see `docs/architecture/operating-model.md` for that identity
decision and the README for the user-facing pitch.

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

## Team process

The generic team process guidance lives in `.claude/team-guide.md` and loads via the import below:

@.claude/team-guide.md

## Code style

Follow the "Writing style" section in `.claude/team-guide.md` for commits,
PRs, docs, and comments. The JS in this repo follows the zero-dependency test
style (see "Useful commands").

## Repo layout

```
docs/
  architecture/      stack and policy decisions, data model, domain math;
                       also dated codebase maps from /tm-map-codebase
  operations/        run/deploy/operate: environments, CI/CD, runbooks
  plans/             implementation plans, <issue-number>-<slug>.md
  reviews/           dated codebase-review reports from /tm-review-codebase
  superpowers/specs/ approved designs, YYYY-MM-DD-<topic>-design.md
  team-architecture.md  flat-star agent-team diagrams and rationale
```

## Useful commands

```bash
npm test          # unit tests (node:vm, zero deps); run before commit
# gh issue create
# gh pr create --draft
```

There is no application runtime, so install, dev, typecheck, and lint are N/A.
