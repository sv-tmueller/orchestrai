# AGENTS.md

Orientation for any AGENTS.md-aware worker seat (Codex today; other tools
read this same file) working in this repo. The full instructions are this
file plus the one doc it names, `.claude/process-core.md`: no Claude `@`
import syntax here, so read both files in full, not just the headings.

## What this repo is

orchestrai is a personal AI-team-orchestrator plugin, applied across the
user's own repos. It is not a template for spinning up new, unrelated
projects. See `docs/architecture/operating-model.md` for that identity
decision.

A non-Claude worker seat in this repo is exactly that: a worker, driven by
the Claude lead session per
`docs/superpowers/specs/2026-07-08-codex-readiness-design.md`. It does not
run the `tm-` machinery, does not dispatch other agents, and does not act as
lead. It receives a task, does the work on its assigned branch, and hands
results back through git and files.

## How to run tests

```bash
npm test
```

This runs the unit tests with Node's built-in test runner. There are zero
runtime dependencies. There is no application runtime, so install, dev,
typecheck, and lint are N/A. Run `npm test` before any commit.

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

`.claude/` holds Claude-host machinery (agents, skills, workflows) plus one
process doc, `.claude/process-core.md`. A non-Claude seat may read the
machinery for context but never executes or modifies it; `process-core.md`
is different, it is normative for this seat too (see Guardrails).

## Guardrails

Read `.claude/process-core.md` in full: it covers issues and branches,
sizing, sub-plans, commits, tests, CI cost policy, writing style, and the
neutral what-not-to-do rules (no direct push to `main`, full check suite
before merge, no `--no-verify`, no undeclared dependency). It applies to
this seat unchanged.

- `.claude/` changes are template-first: this repo (sv-tmueller/orchestrai)
  is the template. Machinery changes land here and propagate to other repos
  through the plugin, never as one-off forks in consumer repos.
