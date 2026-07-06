# Team guide rationale

Evidence and rationale relocated from `.claude/team-guide.md`. The operative
rules live there; this file holds the why and the numbers. Organized by
source section, each chunk headed by the rule it supports.

## Workflow defaults

### Permission mode reference

<!-- Modes (set with /permissions or settings.json "defaultMode"): default = prompt on
     first use of each tool; acceptEdits = auto-accept edits, prompt other actions
     ("Auto", the mode above); plan = read-only; bypassPermissions = no prompts. -->

### Session hygiene: measured baseline and estimate

Supports: "bound lead-session context growth before it reaches the hundreds
of thousands of tokens... prefer fresh short-lived dispatches per issue over
one long session across many tasks."

Before (measured): the top 15 lead-session peaks per turn all exceed 570,000
tokens, the highest is 1,634,150; orchestrai's own top lead session is
583,848, already below those plan-wide peaks because the kickoff pipeline
dispatches fresh sessions per issue. After (estimate, not a measurement):
assuming a 200,000-token compact-or-clear threshold, the worst measured turn
shrinks about 8.2x (about 88% less) and the top-15 floor shrinks about 2.9x
(about 65% less) per turn. Cache-read volume on those turns drops by roughly
the same factors, since the peaks are almost all cache_read (hit ratios
0.9266 to 0.9891). The estimate assumes the threshold holds exactly and
ignores compaction's own one-time cost
(docs/research/2026-07-06-token-burn-investigation.md).

## Agent team

No relocated chunks; the fact-checker verdict taxonomy lives in
`.claude/agents/fact-checker.md` and the dispatch choreography lives in
`docs/team-architecture.md`. Both pointers are inline in team-guide.md.

## Repo layout (team)

### Full annotated tree

Supports: "`.claude/` holds `agents/`, `skills/`, `workflows/`, and
`settings.json`."

```
.claude/
  agents/            role agents: architect, developer, tester, reviewer,
                       fact-checker, docs-writer, perf-investigator
  skills/            project skills: /tm-advisor, /tm-grill-me, /tm-kickoff, /tm-new-project, /tm-to-issues
  workflows/         bounded orchestration scripts (tm-review-changes, tm-review-codebase, tm-map-codebase)
  settings.json      project settings; enables the superpowers plugin
                       enabledPlugins is template-managed;
                       permissions, hooks, env, and defaultMode are project-owned
```

## Sizing

### Session-risk rationale

Supports: "Size the issue when you file it, then re-check while planning."

Hours are the yardstick, but the reason to keep issues small is the session:
a large issue risks hitting the session limit mid-task and bloats context
until quality drops.

## Model policy

### Orchestrator: aggregate vs. per-batch token share

Supports: "Fable costs 2x Opus 4.8 per token and weighs correspondingly
against Max-plan quota. The premium is bounded in aggregate, not per batch."

Across the 14-day, 25-project aggregate, Fable's own token share stays small
(5.5% raw, 18.7% weighted proxy), but within a single kickoff batch it flips:
in batch #201, Fable-priced roles (lead, architect, reviewer) took 57.5% raw
and 93.3% weighted proxy of that batch's tokens
(docs/research/2026-07-06-token-burn-investigation.md, driver 3).

### Cost-based fallback trigger: why it is quota, not dollars

Supports: "if Fable 5 stops being included under the Max-plan subscription
and shifts to metered API billing, do not switch to Opus automatically."

The "affordable" reasoning behind the orchestrator's model choice is weighed
against Max-plan quota, not real dollars, so it stops applying the moment
billing changes to metered API rates.

### Ultracode: mechanism and the measured trial

Supports: "No session-wide `ultracode`, ever, under this policy."

As a session setting, `ultracode` sends `xhigh` reasoning (one notch below
`max`) and has Claude author a dynamic workflow for every substantive task;
those invented workflows carry no per-stage model pinning, so every stage
would run at Fable rates, and Fable over-spawns under exactly this shape. The
measured trial behind this rule (288 agents attempted by an unbounded
dynamic workflow against the bounded `tm-review-codebase` script's 9, spend
cap exhausted) is in `docs/reviews/2026-06-30-orchestration-comparison.md`.
(Source: code.claude.com/docs/en/model-config.md, "Adjust effort level".)

### Role agents: execution vs. decision roles, and why fact-checker stays on Sonnet

Supports: "`developer`, `tester`, `fact-checker`, `docs-writer`, and
`perf-investigator` run `sonnet`... The `fact-checker` stays on Sonnet, not
Haiku."

Code generation, verification, claim auditing, doc authoring, and
measurement are execution roles, not decision roles. The `sonnet` alias
resolves to Sonnet 5. The `fact-checker` stays on Sonnet rather than Haiku
because claim extraction is the step that fails silently: a model that
misses an unsupported claim defeats the role's purpose, and the agent runs
rarely enough that the cost difference does not matter.

### Effort ceiling: the DeepSWE evidence

Supports: "Effort ceiling: `xhigh`. Nothing runs at `max`."

Evidence (DeepSWE v1.1 leaderboard, July 2026): Fable 5 at max scores the
same as at high for roughly 1.8x the cost, and Sonnet 5 at max is dominated
by Fable 5 at every plotted effort level. Effort inherits to any seat that
does not pin it, so the old session-wide max ran the Sonnet workers at the
chart's worst value point.

### Workflows: the three worked examples

Supports: "pin worker stages to a cheap model at `high` effort in the
script and reserve the strong model for synthesis or critique."

The `tm-review-changes` workflow in `.claude/workflows/` is the worked
example: a fixed set of Sonnet reviewers plus one Fable critic pinned to
xhigh effort, bounded by construction so it cannot fan out into the
100-agent review that an unpinned session model produces. `tm-review-codebase`
applies the same discipline to a whole-repo audit: a Sonnet scout splits the
repo into N areas (sized to the repo, capped at a ceiling), Sonnet workers
review each area plus repo-wide structure, and one Fable critic consolidates.
The agent count is N + 3, so it scales with repo size up to the ceiling and
never fans out unboundedly. `tm-map-codebase` reuses the same
scout/worker/critic shape for a purely descriptive map (purpose, entry
points, data and control flow, no findings): it drops the architecture
worker, so the agent count is N + 2, bounded and scaling with repo size the
same way.

### CLAUDE_CODE_SUBAGENT_MODEL: what it overrides

Supports: "Do not set `CLAUDE_CODE_SUBAGENT_MODEL`. It flattens every
subagent to one model, defeating the split above."

It overrides both the per-call model and the frontmatter `model:`,
flattening every subagent to one model and defeating the split above.
