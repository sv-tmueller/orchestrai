# Team guide

Generic process guidance for the orchestrator team. Project specifics live in each repo's CLAUDE.md.

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

The template ships four role agents in `.claude/agents/` and a set of skills.
The lead is the main session: subagents cannot call each other, so the
session running `/tm-kickoff` routes every handoff, and GitHub (sub-plan and
verdict comments, draft PRs, labels) holds the state that makes a dropped
session resumable. A diagram of this flat-star model and the per-package
pipeline lives in `docs/team-architecture.md`.

- `architect` - advisory, read-only: sub-plans, split proposals, arbitration.
- `developer` - one issue end to end in an isolated worktree.
- `tester` - independent verification on the branch, read-only.
- `reviewer` - spec pass then quality pass, read-only.

Refine and size issues in discussion first (`/tm-grill-me` stress-tests the
plan, `/tm-to-issues` turns it into sized issues); mark dependencies with a
literal `Blocked by: #N` line in the issue body. Then `/tm-kickoff <issues>` (user-typed only;
it does not auto-trigger) runs unblocked issues in parallel waves to ready PRs.
Under `/tm-kickoff` the sub-plan comment substitutes for the full plan in `docs/plans/`.
Merging stays human and gates the next wave. Caps, routing,
and report contracts live in `.claude/skills/tm-kickoff/SKILL.md` and the agent
files; they are not repeated here.

Labels: `in-progress` (package dispatched; resume, do not restart) and
`needs-human` (parked: question, blocker, or exhausted fix loop), on top of
the sizing set.

## Operating model (advisor)

`/tm-advisor` (user-typed only) runs the lead session as the user's advisor: it
refines a raw need into a batch of work packages, gets one sign-off, then
runs the team uninterrupted and reports. The full design is
`docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`; the
mechanics live in `.claude/skills/tm-advisor/SKILL.md`. The rules that matter
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

- Orchestrator (the lead session, including `/tm-kickoff`): Opus 4.8 at max
  effort. Opus does not over-spawn under ultracode the way Fable 5 (`claude-fable-5`) does, and it
  weighs less against Max-plan quota. Keep the lead here.
- Sonnet 5 as orchestrator (provisional): if the lead session runs Sonnet 5
  instead of Opus 4.8, keep it on the team and workflow machinery at max
  effort by default too, not session-wide ultracode. The team pipeline pins
  judgment-heavy stages (architect, reviewer, and the critic stage in both
  `tm-review-*` workflows) to Opus regardless of which model leads, so a
  Sonnet-5-led run still gets Opus-quality review; a Sonnet-5-led ultracode
  run does not escalate by default, since ultracode workflows do not pin
  per-stage models unless told to. Whether Sonnet 5 also over-spawns under
  ultracode the way Fable 5 does is untested. This default is provisional,
  pending real data: see
  `docs/reviews/2026-06-30-orchestration-comparison.md` for the reasoning and
  a methodology to validate it.
- `ultracode`: use it as a per-prompt keyword, not as a session-wide effort
  setting, and not as a substitute for the team machinery above. There is no
  `/ultracode` slash command: it is either a keyword you type in a prompt or
  the `ultracode` option in the `/effort` menu. As a session setting it sends
  `xhigh` reasoning (one notch below `max` on Opus 4.8's `low < medium < high
  < xhigh < max` ladder) and has Claude plan a dynamic workflow for every
  substantive task, chaining several per request; as a keyword it scopes that
  orchestration to the one task you type it on. The workflows it invents have
  no per-stage model pinning, so their stages run on whichever model is
  leading the session, not the Sonnet workers the `tm-review-*` scripts pin.
  Session-wide `ultracode` is therefore unbounded and buys less reasoning
  than `max` for more cost on Opus: keep `/effort` at `max`, and use the
  keyword only for a one-off heavy task with no tm- script. (Source:
  code.claude.com/docs/en/model-config.md, "Adjust effort level".)
- Role agents (set in each agent's frontmatter `model:`): `developer` and
  `tester` run `sonnet` (efficient implementation and verification);
  `architect` and `reviewer` run `opus` (the judgment roles).
- Workflows: pin worker stages to a cheap model in the script and reserve the
  strong model for synthesis or critique. The `tm-review-changes` workflow in
  `.claude/workflows/` is the worked example: a fixed set of Sonnet reviewers
  plus one Opus critic, bounded by construction so it cannot fan out into the
  100-agent review that an unpinned session model produces.
  `tm-review-codebase` applies the same discipline to a whole-repo audit: a Sonnet
  scout splits the repo into N areas (sized to the repo, capped at a ceiling),
  Sonnet workers review each area plus repo-wide structure, and one Opus critic
  consolidates. The agent count is N + 3, so it scales with repo size up to the
  ceiling and never fans out unboundedly.
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

For a batch of refined, sized issues, `/tm-kickoff` automates this flow per
issue, with the sub-plan comment standing in for step 5's full plan (see
"Agent team").

## Repo layout (team)

```
.claude/
  agents/            role agents: architect, developer, tester, reviewer
  skills/            project skills: /tm-advisor, /tm-grill-me, /tm-install-team, /tm-kickoff, /tm-to-issues
  workflows/         bounded orchestration scripts (tm-review-changes, tm-review-codebase)
  settings.json      project settings; enables the superpowers plugin
                       enabledPlugins is template-managed;
                       permissions, hooks, env, and defaultMode are project-owned
```

Every skill and workflow built in this repo carries the `tm-` prefix
(`/tm-advisor`, `/tm-kickoff`, `/tm-review-changes`, and so on). The prefix
marks them as this project's own commands, so they are easy to tell apart from
the out-of-the-box and plugin skills (superpowers and the like) in the same
list. New project commands follow the same rule: name them `tm-<thing>`.

## What not to do

- Don't push directly to `main`. Open a PR.
- Don't merge a PR that has not run the full check suite, including e2e if the
  change touches the stack.
- Don't bypass git hooks (`--no-verify`). If a hook fails, fix the cause.
- Don't improve `.claude/` machinery only in this repo. Change the template
  (sv-tmueller/claude-template) first, then re-run `/tm-install-team` in the
  config dirs to distribute the update; local-only edits in a config dir are
  overwritten by the next install.
- Don't introduce a new dependency without saying why in the PR body.
<!-- Add project-specific traps here: the mistakes that quietly break this codebase. -->

## When in doubt

Ask. A 30-second clarifying question beats a 30-minute wrong direction.
