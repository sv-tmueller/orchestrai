# AGENTS.md

Orientation for every agent working in this repo, on any harness, whether it
runs as the lead or as a worker seat. Claude Code reads this file through an
import in `CLAUDE.md`; other harnesses read it directly. The file uses no `@`
import syntax, so it names the one doc that completes it,
`.claude/process-core.md` (see Guardrails).

## What this repo is

orchestrai is a personal AI-team-orchestrator plugin, applied across the
user's own repos. It is not a template for spinning up new, unrelated
projects; see `docs/architecture/operating-model.md` for that identity
decision and the README for the user-facing pitch.

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

## Code style

Follow the "Writing style" section in `.claude/process-core.md` for commits,
PRs, docs, and comments. The JS in this repo follows the zero-dependency test
style (see "Useful commands").

## Repo layout

```
docs/
  architecture/      stack and policy decisions, data model, domain math;
                       also dated codebase maps
  operations/        run/deploy/operate: environments, CI/CD, runbooks
  plans/             implementation plans, <issue-number>-<slug>.md
  reviews/           dated codebase-review reports
  superpowers/specs/ approved designs, YYYY-MM-DD-<topic>-design.md
  team-architecture.md  flat-star agent-team diagrams and rationale
```

`.claude/` holds the team machinery (agents, skills, adapters, and the unit tests under `workflows/`) and
the process docs; the README says which hosts run the team.
`.claude/process-core.md` is normative for every seat (see Guardrails).

## Useful commands

```bash
npm test          # unit tests (node:vm, zero deps); run before commit
# gh issue create
# gh pr create --draft
```

`npm test` runs the unit tests with Node's built-in test runner. There are zero
runtime dependencies and no application runtime, so install, dev, typecheck,
and lint are N/A.

## Guardrails

Read `.claude/process-core.md` in full unless your harness has already loaded
it (a Claude Code session has, through `CLAUDE.md`). It covers issues and
branches, sizing, planning, commits, tests, CI cost policy, writing style, and
the neutral what-not-to-do rules (no direct push to `main`, full check suite
before merge, no `--no-verify`, no undeclared dependency). It applies to every
seat unchanged.

- `.claude/` changes are template-first: this repo (sv-tmueller/orchestrai)
  is the template. Machinery changes land here and propagate to other repos
  through the plugin, never as one-off forks in consumer repos.
