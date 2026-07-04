# awesome-claude-agents adoption evaluation - 2026-07-04

Credit: this research mines [`vijaythecoder/awesome-claude-agents`](https://github.com/vijaythecoder/awesome-claude-agents)
(MIT), a public collection of Claude Code subagents. Everything below is our
own analysis of their published work, done for issue #163 ("Inspiration for
further development") via batch #169. Our repo stays the master; nothing here
copies their files verbatim.

Retrieval method, so every claim below is traceable: the full file tree via
`gh api repos/vijaythecoder/awesome-claude-agents/git/trees/HEAD?recursive=1`,
confirmed against `gh api repos/vijaythecoder/awesome-claude-agents/contents/agents`;
the README, `CLAUDE.md`, and `docs/best-practices.md` via
`curl https://raw.githubusercontent.com/vijaythecoder/awesome-claude-agents/main/<path>`;
five representative agent files (`team-configurator.md`,
`tech-lead-orchestrator.md`, `project-analyst.md`, `backend-developer.md`,
`django-backend-expert.md`) the same way, plus a spot-check of four more
(`code-reviewer.md`, `react-nextjs-expert.md`, `python-expert.md`,
`api-architect.md`) for the `model:` frontmatter field only. All fetches
succeeded; no fallback to `gh api .../contents` for file bodies was needed
(that endpoint was used only to cross-check the folder listing).

Our own sources, cited by path: `.claude/team-guide.md` (Model policy),
`docs/reviews/2026-06-30-orchestration-comparison.md` (the bounded-vs-ultracode
cost thesis), `docs/team-architecture.md` (flat-star, lead-only-spawner),
`.claude/agents/*`, `.claude/skills/*`, `.claude/workflows/*`, and
`.claude/skills/tm-new-project/SKILL.md`.

## 1. Comparison: philosophy, structure, routing, cost posture

### Philosophy

Their README frames the project as "a team of specialized AI agents" that
"handle any technology stack with expert-level knowledge," installed once
(via symlink into `~/.claude/agents/`) and reused across every project on the
machine. The pitch is breadth: one agent per framework, so any project you
open already has a matching expert.

Our flat-star model (`docs/team-architecture.md`) is narrower by design: five
fixed role agents (architect, developer, tester, reviewer, fact-checker), one
per pipeline function, not per technology. Breadth comes from the developer
role being stack-agnostic, not from adding a developer-per-stack.

### Agent structure

Their tree (`gh api .../git/trees/HEAD?recursive=1`) is:

- `agents/orchestrators/` - 3 agents (`tech-lead-orchestrator`,
  `project-analyst`, `team-configurator`)
- `agents/core/` - 4 agents (code-archaeologist, code-reviewer,
  performance-optimizer, documentation-specialist)
- `agents/universal/` - 4 agents (backend-developer, frontend-developer,
  api-architect, tailwind-css-expert)
- `agents/specialized/` - 22 agents across six framework folders: django (3),
  laravel (2), rails (3), react (2), vue (3), and **python (9)**

That is 33 agent files on disk. The README's own count says "24 specialized
agents" (3 + 13 + 4 + 4, where "13" is laravel+django+rails+react+vue only)
and never mentions the `specialized/python/` folder at all, in either the
folder listing or the total. The README is stale against the actual repo
content: the catalog grew by 9 agents without the top-level count or
narrative being updated. A caution for section 3: an open-ended per-stack
catalog drifts out of sync with its own documentation.

Our structure is 5 agents total, fixed, none of them stack-specific.

### Orchestration and routing

Their routing runs through two of the three orchestrators:

- `project-analyst` scans `package.json`, `composer.json`,
  `requirements.txt`, `go.mod`, `Gemfile`, and build configs, tags
  architecture patterns (MVC, monorepo, etc.) with a confidence score, and
  returns a structured report with a "Specialist Recommendations" section.
- `tech-lead-orchestrator` (the only file of the nine we checked that pins
  `model: opus`) consumes that and returns a strict "Agent Routing Map":
  `Task N: <description> -> AGENT: @agent-<name>`, plus an execution order
  that caps parallel work at 2 but does not cap total sequential agents (the
  worked example in `tech-lead-orchestrator.md` itself fans one feature across
  7 tasks and 4 agents that actually execute them - code-archaeologist,
  django-backend-expert, django-api-developer, react-component-architect -
  with a 5th, code-reviewer, listed under "Available Agents for This Project"
  but never assigned a task). Their `CLAUDE.md` makes following that map
  mandatory ("USE ONLY the agents explicitly recommended by tech-lead",
  "NEVER select agents independently").
- `team-configurator` runs once per project (or after a stack change), reads
  existing `CLAUDE.md`, detects the stack, and rewrites a single
  "AI Team Configuration" section in place, timestamped, while preserving
  everything else in the file.

Our routing is simpler and has no per-project stack-detection step: the lead
session dispatches a fixed sequence (architect, developer, tester, reviewer)
per issue, capped at 3 packages concurrent
(`.claude/skills/tm-kickoff/SKILL.md`), with no framework-aware agent
selection because there is only one developer role to select.

**Correction to keep in this doc:** `tm-new-project`
(`.claude/skills/tm-new-project/SKILL.md`) does not do anything like
`project-analyst`. It detects repo *setup state* only: whether the three
`CLAUDE.md` placeholder sentinels are gone, whether the five `docs/` dirs
exist, and whether the six workflow labels are present. It never inspects
`package.json`, `requirements.txt`, or any other manifest to infer a
technology stack. We do not currently have stack detection anywhere in this
repo.

### Token and cost posture

Their README states the project is "experimental and token-intensive" and
that "multi-agent orchestration can consume 10-50k tokens per complex
feature," with an explicit warning to "monitor your usage." Checking the
`model:` frontmatter field across nine representative files (the five read in
full plus four more spot-checked for this field alone) found exactly one
pin: `tech-lead-orchestrator.md` sets `model: opus`. The other eight
(`team-configurator`, `project-analyst`, `backend-developer`,
`django-backend-expert`, `code-reviewer`, `react-nextjs-expert`,
`python-expert`, `api-architect`) have no `model:` field, so each one runs on
whatever model is leading the session. That is the same shape our own
`docs/reviews/2026-06-30-orchestration-comparison.md` describes as the
ultracode risk: stages with no per-stage model pin inherit the lead's model,
and nothing in their design caps how many stages a run chains (only the "max
2 parallel" rule limits concurrency, not total count).

Our Model policy (`.claude/team-guide.md`) pins every stage explicitly:
`developer`/`tester`/`fact-checker` at `sonnet`, `architect`/`reviewer` at
`fable` (or the documented `opus` fallback), and every workflow script
(`tm-review-changes.js`, `tm-review-codebase.js`) pins each stage in code, not
by convention. `tm-review-codebase.js` also hard-clamps its worker count in
script logic (`MAX_AREAS`), which is the structural difference the
orchestration-comparison report calls out: their bound is a documented
convention ("max 2 parallel"); ours is enforced by construction (an
`agent()` call with a `model` argument and a loop bound in code).

## 2. Process ideas: keep / adapt / reject

| # | Idea (source) | How it maps to us | Verdict |
|---|---|---|---|
| 1 | Stack detection before routing (`project-analyst`) | We have no equivalent. `tm-new-project` detects setup state, not a tech stack (see correction above). A real stack-detection step would only matter if we had stack-specific work to route to, which we do not today (see section 3). | **Adapt** - worth doing, but scoped small: record the stack as an interview answer in `tm-new-project`, not a code-scanning agent, until there is a concrete consumer for the detection (see next-adoptions #1). |
| 2 | In-place, timestamped, prose-preserving section rewrite (`team-configurator`) | We already produce dated, append-only artifacts (`tm-map-codebase` writes a new dated file under `docs/architecture/`, `tm-review-codebase` writes a new dated file under `docs/reviews/`). Their pattern is different: it rewrites one section of one living file in place instead of writing a new file each run. We have no current file that needs "same file, refreshed section" semantics. | **Adapt (flag for later)** - no current driver. Keep the pattern in mind for exactly one shape: a single canonical doc that must reflect the *current* state (not history), if one shows up. Not on the near-term list because principle 2 (no speculative abstractions) rules out building it before a real need exists. |
| 3 | Structured `Task N -> AGENT: @name` routing-map table with an explicit execution order (`tech-lead-orchestrator`) | Our `SUB_PLAN` comments already cover "approach, files, order, verification" in prose, because our roles are fixed (one developer, one tester, one reviewer per issue) - there is nothing to route between. The table earns its keep only if a package ever needs more than the fixed roles. | **Adapt** - reuse the table format only if the framework-specialist layer in section 3 (or any future multi-specialist package) ships; until then this is inert. |
| 4 | Three-phase workflow with a human approval gate before execution (`CLAUDE.md`'s Research -> Approval -> Planning -> Execution) | We already gate execution on a human: `/tm-advisor`'s one sign-off per batch, and `/tm-kickoff`'s draft PR that a human merges. Their pattern validates our existing gate rather than adding a new one. | **Keep** - no change; this is confirmation, not a gap. |
| 5 | Global symlink install (`~/.claude/agents/awesome-claude-agents`), reused across every project on the machine | We distribute via the marketplace plugin and `/plugin update` (`.claude/team-guide.md`, "What not to do": don't improve `.claude/` machinery per-repo, change the template first). A parallel symlink-based distribution channel would compete with that, not extend it. | **Reject** - redundant with, and would undercut, our existing plugin-update distribution path. |

## 3. Framework-specialist layer: a genuine evaluation

**What it would look like.** Their model: one subagent per framework
(`django-backend-expert`, `react-nextjs-expert`, and so on), selected by
`project-analyst` + `tech-lead-orchestrator` instead of a single generic
developer. Grafting that onto our repo would mean either (a) adding N
framework-specific variants of `.claude/agents/developer.md`, selected by a
new stack-detection step before dispatch, or (b) keeping one `developer`
agent but giving it stack-specific prompt sections that only apply when a
detected stack matches.

**Weighed against the cost thesis.** Swapping *which* developer prompt runs
for a given issue does not, by itself, add fan-out: it is still one developer
dispatched per issue, same as today, so it does not violate the
`tm-review-codebase.js`-style bound (`N` capped in code) or the "9 of 297"
argument in `docs/reviews/2026-06-30-orchestration-comparison.md`, which is
about how many agents a run spawns, not how many agent *definitions* exist in
the repo. The risk is different: definition sprawl. Their own repo is the
evidence - 33 agent files against a README that still says 24, because the
`specialized/python/` folder grew without the top-level narrative catching
up. A framework-specialist catalog is not free to maintain even when it adds
no runtime fan-out.

**Weighed against the Model policy.** Any new specialist agent would need the
same treatment `developer`/`tester`/`fact-checker` already get: pin
`model: sonnet` and its own effort in frontmatter, per
`.claude/team-guide.md`. That is mechanically easy to satisfy (it is one
frontmatter line) and does not conflict with the policy. The policy has no
opinion on *how many* sonnet-pinned agents exist, only on which model each
one runs.

**The actual blocker.** This repo is a template for spinning up new,
unrelated projects (see `NEW-PROJECT-SETUP.md` and the placeholder text still
in this repo's own `CLAUDE.md`: "Describe in 2-3 sentences what this project
does" is unfilled). Orchestrai itself has no fixed application stack to
specialize for - there is no Django or React code living in *this* repo for
a `django-backend-expert` to work on. A framework-specialist catalog only
makes sense downstream, inside a project *generated from* this template, once
that project has picked a real stack. Pre-building a Django/Rails/React/Vue
catalog here, for stacks no generated project has chosen yet, is exactly the
speculative work principle 2 rules out ("no abstractions for single-use
code," except here it would be zero-use code).

**Recommendation: adopt-with-constraints.** Do not add a framework-specialist
catalog to this repo's fixed five-role team. Instead, treat the pattern as
something `tm-new-project` could offer *to a generated project*, on demand,
once that project's stack is real: an optional, stack-specific addendum
appended to that project's own `developer` agent prompt (not a new parallel
agent, and not a pre-built catalog), created the first time a concrete stack
and enough work volume justify it, one stack at a time. This keeps the
one-developer-per-issue bound intact, keeps every new prompt sonnet-pinned
per the Model policy, and avoids building 13+ prompts for stacks that may
never be chosen. It is a real yes, scoped down to match how this repo
actually operates, not a rejection dressed as a compromise.

This section stops at the recommendation. Working out the addendum's exact
format, where it lives, and how `tm-new-project` would author it is
implementation design and out of scope for this doc.

## 4. Prioritized next adoptions

1. **(S)** Add an explicit stack question to `tm-new-project`'s `CLAUDE.md`
   interview (section 4 of its `SKILL.md`), so the "Code style" placeholder
   starts from a real, human-given answer instead of staying blank. This is
   recorded, not detected - no code-scanning agent yet. Seeds process idea #1.
2. **(M)** Pilot the adopt-with-constraints specialist addendum on exactly
   one real, generated-project stack once one exists: a short "notes for the
   developer agent" section appended to that project's own `developer`
   prompt, not a new agent file. Measure whether it changes output quality
   before deciding whether a second stack is worth doing. Seeds section 3's
   recommendation.
3. **(S)** If the pilot above ships, borrow the `Task | Agent | Reason`
   routing-map table format (process idea #3) for that project's `SUB_PLAN`
   template, so a package spanning the generic developer and a stack
   addendum stays legible without adding a second dispatched agent.

Items are ordered so each depends on the one before it; none of them is
committed by this doc, and none of them touches this repo's own agents,
skills, workflows, or `CLAUDE.md` (this package's non-goal, verified by the
diff below touching only `docs/research/`).
