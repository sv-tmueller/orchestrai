# AGENTS.md

Orientation for any AGENTS.md-aware worker seat (Codex today; other tools
read this same file) working in this repo. This file is self-contained: it
does not use Claude's `@` import syntax, so read it in full, not just the
headings.

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

## Writing style

Applies to commits, PRs, docs, and comments:

- No em dashes. Use regular hyphens, commas, or parentheses.
- No AI-cliche phrases: "leverage", "robust", "seamless", "comprehensive",
  "elevate", "delve", "in the realm of", "it's worth noting", "moreover",
  "furthermore". Plain, direct English. Short sentences.
- Add a comment only when the why is non-obvious. Do not restate what the
  code does.

Commits follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`,
`test:`, `refactor:`, `perf:`, `build:`, `ci:`. Imperative mood, lowercase,
no period. The body explains why, not what.

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

`.claude/` holds Claude-host machinery (agents, skills, workflows). A
non-Claude seat may read it for context but never executes or modifies it.

## Guardrails

- Every unit of work is a GitHub issue first. Nothing new gets built without
  an issue.
- Branch from `main` per issue: `feat/<issue-number>-<short-slug>` or
  `fix/<issue-number>-<short-slug>`.
- Merge via PR. The PR references the issue with `Closes #N`. One topic per
  PR. Direct pushes to `main` are blocked.
- Never bypass git hooks (`--no-verify`). If a hook fails, fix the cause.
- Do not introduce a new dependency without saying why in the PR body.
- `.claude/` changes are template-first: this repo (sv-tmueller/orchestrai)
  is the template. Machinery changes land here and propagate to other repos
  through the plugin, never as one-off forks in consumer repos.
