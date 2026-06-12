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

### Sizing (t-shirt size per issue)

Every issue carries a t-shirt size label, estimated in human working hours:

- `size:S` - under 1 hour. One focused change.
- `size:M` - 1 to 3 hours. Write a sub-plan first.
- `size:L` - 4 to 6 hours. Split into smaller issues, or break into checkpointed
  sub-plans (below).
- `size:XL` - a full day, about 8 hours. Too big to start as one issue. Split it.

Hours are the yardstick, but the reason to keep issues small is the session: a
large issue risks hitting the session limit mid-task and bloats context until
quality drops. Size the issue when you file it, then re-check while planning. If
the full plan shows the work is bigger than its label, re-label and split rather
than push through.

### Sub-plans (checkpoint before deep work)

Before any deep planning or implementation, write a short sub-plan first: a
handful of checkpoint bullets (the approach, the files you expect to touch, the
order, the verification step) posted in the issue or the draft PR. This is cheap
insurance: if the connection drops or the session hits its limit, the next
session reads the checkpoint and resumes instead of restarting. For anything
sized `M` or larger, the sub-plan is also where you confirm the work still fits
one session and decompose it if it does not. Expanding it into a full plan comes
later (see "How to pick up a task").

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

### Code style

Project-specific rules go here. Examples to adapt or delete:

- Strict typing; no escape hatches without a `// reason:` comment.
- Money, units, and identifiers use their dedicated types, never raw primitives.
- No hard-coded user-facing strings; use the i18n layer.

### Writing style (commits, PRs, docs, comments)

- No em dashes. Use regular hyphens, commas, or parentheses.
- No AI-cliche phrases ("leverage", "robust", "seamless", "comprehensive",
  "elevate", "delve", "in the realm of", "it's worth noting", "moreover",
  "furthermore"). Plain, direct English. Short sentences.
- Add a comment only when the why is non-obvious. Do not restate what the code does.

## Workflow defaults

Standing preferences for this project:

- Effort: maximum. Use deepest reasoning.
- Permission mode: Auto (acceptEdits) during development (user-controlled).
  <!-- Modes (set with /permissions or settings.json "defaultMode"): default = prompt on
       first use of each tool; acceptEdits = auto-accept edits, prompt other actions
       ("Auto", the mode above); plan = read-only; bypassPermissions = no prompts. -->
- Superpowers: use relevant skills proactively (brainstorming, writing-plans,
  test-driven-development, subagent-driven-development, executing-plans,
  verification-before-completion).
- Parallel work: fan out subagents for independent research or implementation
  streams. Default to parallel over serial.

## Agent team

The template ships four role agents in `.claude/agents/` and a `/kickoff`
skill. The lead is the main session: subagents cannot call each other, so the
session running `/kickoff` routes every handoff, and GitHub (sub-plan and
verdict comments, draft PRs, labels) holds the state that makes a dropped
session resumable.

- `architect` - advisory, read-only: sub-plans, split proposals, arbitration.
- `developer` - one issue end to end in an isolated worktree.
- `tester` - independent verification on the branch, read-only.
- `reviewer` - spec pass then quality pass, read-only.

Refine and size issues in discussion first (`/grill-me` stress-tests the
plan, `/to-issues` turns it into sized issues); mark dependencies with a
literal `Blocked by: #N` line in the issue body. Then `/kickoff <issues>` (user-typed only; it does not
auto-trigger) runs unblocked issues in parallel waves to ready PRs. Under `/kickoff` the sub-plan comment substitutes for the full plan
in `docs/plans/`. Merging stays human and gates the next wave. Caps, routing,
and report contracts live in `.claude/skills/kickoff/SKILL.md` and the agent
files; they are not repeated here.

Labels: `in-progress` (package dispatched; resume, do not restart) and
`needs-human` (parked: question, blocker, or exhausted fix loop), on top of
the sizing set.

## Operating model (CEO + advisor)

`/advisor` (user-typed only) runs the lead session as the user's advisor: it
refines a raw need into a batch of work packages, gets one sign-off, then
runs the team uninterrupted and reports. The full design is
`docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`; the
mechanics live in `.claude/skills/advisor/SKILL.md`. The rules that matter
session-wide:

- A batch is up to 6 independent `size:S`/`size:M` issues, run through the
  kickoff pipeline 3 at a time. Merging stays human; dependent work waits
  for the next batch.
- One sign-off per batch covers filing the issues and dispatching. Nothing
  lands on GitHub before it.
- The escalation line is scope. Within the signed-off scope and acceptance
  criteria the advisor decides and logs the decision on the batch issue.
  Scope or acceptance-criteria changes, new dependencies or costs,
  irreversible or outward-facing actions, and conflicts with
  `docs/architecture/` park as `needs-human`.
- Each batch has a tracking issue (title `Batch: <slug>`): the approved
  contract, the decision log, parked questions, the final report. Dropped
  sessions resume from it.

## Model policy

A strong orchestrator with efficient workers. The lever is where each model
runs, not raw effort everywhere.

- Orchestrator (the lead session, including `/kickoff`): Opus 4.8 at max
  effort. Opus does not over-spawn under ultracode the way Fable 5 does, and it
  weighs less against Max-plan quota. Keep the lead here.
- `ultracode`: use it as a per-prompt keyword, never as a session-wide effort
  setting. Session-wide turns every task into a workflow and chains several per
  request; the keyword scopes orchestration to the one task that needs it.
- Role agents (set in each agent's frontmatter `model:`): `developer` and
  `tester` run `sonnet` (efficient implementation and verification);
  `architect` and `reviewer` run `opus` (the judgment roles).
- Workflows: pin worker stages to a cheap model in the script and reserve the
  strong model for synthesis or critique. The `review-changes` workflow in
  `.claude/workflows/` is the worked example: a fixed set of Sonnet reviewers
  plus one Opus critic, bounded by construction so it cannot fan out into the
  100-agent review that an unpinned session model produces.
- Do not set `CLAUDE_CODE_SUBAGENT_MODEL`. It overrides both the per-call model
  and the frontmatter `model:`, flattening every subagent to one model and
  defeating the split above. Use it only as a temporary per-session seatbelt
  (for example `claude-sonnet-4-6` before one heavy ad-hoc run), knowing it
  downgrades the reviewer too.

## How to pick up a task

1. `gh issue list --state open` (add `--label phase:<current>` if you use phase
   labels) to see what is available.
2. Pick an unassigned issue with no unresolved blockers. Check its `size:` label;
   if it is unsized, size it first, and if it is `L` or `XL`, decompose it before
   starting.
3. Post a short sub-plan on the issue (the checkpoint bullets above).
4. Create a branch and open a draft PR linking the issue (`Closes #N`). This puts
   the in-progress work in front of the user from minute one.
5. Expand the sub-plan into a full plan via `superpowers:writing-plans`, saved to
   `docs/plans/<issue-number>-<slug>.md`. If the plan reveals the issue is bigger
   than its label, re-label and split it into sub-issues before implementing.
6. Implement with TDD per the plan.
7. Run the full check suite (typecheck, lint, test, e2e if touched). It must pass
   before requesting review.
8. Mark the PR ready for review.

For a batch of refined, sized issues, `/kickoff` automates this flow per
issue, with the sub-plan comment standing in for step 5's full plan (see
"Agent team").

## Repo layout

```
.claude/
  agents/            role agents: architect, developer, tester, reviewer
  skills/            project skills: /advisor, /kickoff
  workflows/         bounded orchestration scripts (review-changes)
  settings.json      project settings; enables the superpowers plugin
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
- Don't improve `.claude/` machinery only in this repo. Change the template
  (sv-tmueller/claude-template) first, then `/sync-template` it back here;
  local-only edits are overwritten by the next sync.
- Don't introduce a new dependency without saying why in the PR body.
- (Add project-specific traps here: the mistakes that quietly break this codebase.)

## When in doubt

Ask. A 30-second clarifying question beats a 30-minute wrong direction.
