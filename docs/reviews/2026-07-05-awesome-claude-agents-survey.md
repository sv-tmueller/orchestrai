# Survey: awesome-claude-agents - 2026-07-05

Related: #163 (package), #197 (batch).

**Source:** https://github.com/vijaythecoder/awesome-claude-agents
**Author:** vijaythecoder
**License:** MIT (confirmed against the cloned `LICENSE`)
**Surveyed commit:** `2050f3c60fcfea497f7b6b3ec6566cc316367a7e`
**Survey date:** 2026-07-05
**Prior work on the same source:** `docs/research/2026-07-04-awesome-claude-agents-adoption.md`
(issue #163, batch #169). See "Relation to the prior research doc" below.

## Bottom line

Most of this repo does not transfer. It ships 22 stack-specialist agents plus
three orchestrator agents built around a peer-routing model our operating
model deliberately rejects (see "Their model vs ours"). Their `code-reviewer`
duplicates our `reviewer`, their `tech-lead-orchestrator` duplicates our lead,
and the specialized/ tree is stack-specific noise unless the user's own repos
match that stack. Four things are worth taking, each a small, concrete gap in
what our five seats and three workflows already cover: a dedicated doc-writing
seat, a dedicated performance-investigation seat, a small report-format
enrichment for `tm-review-codebase.js`'s report, and a habit (fetch current
library docs before implementing against an unfamiliar API) worth adding to
`developer.md`. None of these require a new orchestration pattern; each fits
the flat star as a lead-routed dispatch or a workflow-prompt edit. All four
are new: they come from `agents/core/`, the one agent group the prior research
pass on this same source repo did not read (see below).

## Relation to the prior research doc

`docs/research/2026-07-04-awesome-claude-agents-adoption.md` mined this same
source repo one day earlier, for the same issue (#163) under an earlier batch
(#169). Its file list read `agents/orchestrators/*` (all three) and two
`agents/universal/` and `agents/specialized/` files in full
(`backend-developer.md`, `django-backend-expert.md`), plus a `model:`-only
spot-check of four more: `code-reviewer.md`, `react-nextjs-expert.md`,
`python-expert.md`, and `api-architect.md`. It never opened `agents/core/`
(`code-archaeologist`, `documentation-specialist`, `performance-optimizer`)
beyond that spot-check of `code-reviewer.md`, and never opened
`docs/dependencies.md` or the remaining `agents/universal/` files
(`frontend-developer.md`, `tailwind-css-expert.md`). Candidates 1 through 3
(`documentation-specialist`, `performance-optimizer`, `code-archaeologist`)
come from that unread `agents/core/` ground. Candidate 4 draws on
`docs/dependencies.md` (also unread) plus the sampled `django-backend-expert.md`
and `python-expert.md`, both of which the prior doc did touch (the former read
in full, the latter spot-checked for `model:` only), but only for its own
model-pin and framework-specialist analysis, never for a "fetch current docs"
habit. None of the four duplicates the prior doc's five process ideas or its
framework-specialist evaluation.

Where the two docs cover the same files, they do not land on the same
verdicts. The prior doc's own verdicts were Adapt, not reject: it treats
`project-analyst`'s stack-detection idea as worth adopting in a scoped-down
form (record the stack as a `tm-new-project` interview answer, not a
code-scanning agent, until a concrete consumer exists), the
`team-configurator` in-place-rewrite pattern as worth keeping in mind for a
future canonical doc with no current driver, and the
`tech-lead-orchestrator` `Task N -> AGENT: @name` routing-map table as worth
reusing only if a framework-specialist layer ever ships. It never evaluates
`code-reviewer` for duplication at all: that file gets two procedural
mentions only, in the tech-lead-orchestrator worked example and a
`model:`-only spot-check.

This survey's own verdicts, in "Considered and rejected" below, are stated on
its own terms and are not a restatement of the prior doc's Adapt calls:
`tech-lead-orchestrator` duplicates the lead session's own routing role,
`project-analyst` stack detection is unnecessary because agents already
orient by reading `docs/architecture/` and the plugin runs against the
user's own known repos, `team-configurator` conflicts with
`docs/architecture/operating-model.md`'s retirement of the
template/auto-scaffold path, and `code-reviewer` duplicates `reviewer` and
`tm-review-changes.js`. The prior doc's Adapt verdicts are conditional (worth
it later, if a driver or consumer shows up); this survey's verdicts are
current-state rejections given how this repo orients and operates today, so
the two land differently on `project-analyst` and `team-configurator` rather
than agreeing. `code-reviewer` has no prior verdict to compare against. The
prior doc has the fuller reasoning behind its own verdicts, including the
file-count discrepancy in their own README (24 claimed vs. 33 on disk) and
the "adopt-with-constraints" analysis of the specialized/ layer.

One place the two need reconciling rather than just agreeing: the prior doc's
central blocker for the framework-specialist layer is "this repo is a
template for spinning up new, unrelated projects... there is no Django or
React code living in this repo." That framing is the identity
`docs/architecture/operating-model.md` retired (merged after the prior
research doc, per `git log`): orchestrai is now "a personal AI-team-orchestrator
plugin, applied across the user's own repos," not a template for generating
new ones. That doesn't flip the prior doc's bottom-line recommendation (don't
pre-build a stack-specific catalog here), because the argument still holds
under the new identity: purpose 5 ("a portable structure the user can apply
across any of their repos") means specialized agents would belong in
whichever of the user's *other* repos has a fixed stack, not in orchestrai
itself, which still has no application stack of its own to specialize for.
It does mean the prior doc's stated reason should be read as superseded
phrasing pointing at a conclusion that still stands for an updated reason,
not as settled fact under the current identity docs.

## What was surveyed

Read in full: `README.md` (170 lines), `CLAUDE.md` (262 lines), and all three
files under `docs/` (`best-practices.md`, `creating-agents.md`,
`dependencies.md`, 356 lines together). Read in full: all 4 agents in
`agents/core/`, all 3 in `agents/orchestrators/`, all 4 in `agents/universal/`
(11 agent files, 896 lines together). Sampled, one or two per stack, out of
the 22 files in `agents/specialized/`: `django/django-backend-expert.md`,
`react/react-component-architect.md`, and `python/python-expert.md`. The
remaining 19 specialized files were not read; they follow the same template
shape as the three sampled (a stack-expert system prompt with heavy inline
code examples, no delegation restrictions, no model pin), which is why the
selection criteria treat that tree as noise by default.

## Their model vs ours

Their `CLAUDE.md` mandates a single routing path: the main Claude session must
invoke `tech-lead-orchestrator` for any multi-step task, use only the exact
agents it names in its "Agent Routing Map," and never pick an agent by its own
judgment. Agents cannot call each other directly (a Claude Code constraint
they share with us), so their coordination model routes through the main
session the same structural way ours does. The difference is what's fixed and
what's improvised:

- **Routing authority.** Their tech-lead is itself an agent the main session
  must consult and obey; ours has no such intermediary; the lead session is
  the router, full stop, and consults `architect` only for approach
  decisions, never for "which agent handles this."
- **Model pins.** Across all 33 agent files, exactly one (`tech-lead-orchestrator`)
  pins a model (`opus`), and it has no effort pin. Every other agent inherits
  whatever model the session is running under. Our five seats and every
  workflow stage pin both model and effort in the frontmatter or the
  `agent()` call, so a Sonnet-led session and a Fable-led session get
  identical judgment quality on judgment-heavy stages (team-guide.md, "Model
  policy").
- **Fan-out bound.** Their tech-lead caps parallelism at "maximum 2 agents in
  parallel" as a written instruction the model is trusted to follow. Our
  `tm-review-codebase.js` and `tm-map-codebase.js` hard-clamp their area
  count in script logic (`areas.slice(0, MAX_AREAS)`), so the bound holds
  even if a worker ignores the prompt. Their bound is a convention; ours is
  enforced by code.
- **Tool inheritance.** Their docs recommend omitting the `tools` field so
  agents "inherit everything," including `Write`, `Edit`, and `WebFetch`, and
  treat restriction as an exception for "security-sensitive" agents only.
  Our default runs the other way: `architect`, `tester`, `reviewer`, and
  `fact-checker` are read-only by tool restriction, and only `developer`
  writes code. Full-tool-by-default is the more open posture; the risk that
  posture accepts (a review agent that can also edit) is exactly what our
  four read-only seats are built to rule out.

None of this makes their model wrong for what it is: a single-session tool
meant to be dropped into any repo and self-configure. It just does not fit a
plugin whose identity is a bounded, resumable, per-seat-pinned pipeline
(`docs/architecture/operating-model.md`).

## Adoption candidates

### 1. `tm-docs-writer` (from `agents/core/documentation-specialist.md`)

Their `documentation-specialist` drafts and updates READMEs, API specs, and
architecture guides from a gap analysis of what documentation is missing, with
concrete templates (README skeleton, OpenAPI stub, architecture-guide
excerpt). We have no seat dedicated to authoring polished, user-facing docs:
`developer` writes whatever docs a given issue needs as a side effect, and
`tm-map-codebase.js` produces an internal architecture map for contributors,
not README or guide-quality prose for readers. Purpose 3 of the operating
model ("produce research and docs to support any piece of work or decision")
names this as a first-class output, but nothing currently owns it as a
dedicated seat. Adaptation: a `tm-docs-writer` execution seat (`sonnet`,
`high` effort, per the model policy: authoring is execution, not judgment),
tools restricted to `Read, Grep, Glob, Write, Edit` (no `Bash`, since it only
needs to read code and write markdown), dispatched by the lead on demand
rather than folded into every issue's pipeline. Its delegation cues in the
source ("Need structure overview of X" to `code-archaeologist`) become a
lead-routed handoff: the lead dispatches `tm-docs-writer` after a
`tm-map-codebase` run when the map's findings warrant a user-facing doc.
Suggested size: **S**.

### 2. `tm-optimize` (from `agents/core/performance-optimizer.md`)

Their `performance-optimizer` establishes a before/after metrics discipline
(baseline P50/P95, profile, fix, re-measure, report a Δ table) and aims for a
minimum measured improvement, not just a plausible-looking change. Our closest
coverage is the `perf` dimension in `tm-review-changes.js`, which flags
performance regressions a diff introduces but never establishes a baseline or
measures an improvement; it is a review lens, not an investigation. The gap is
real when an issue is specifically "this is slow, fix it": nothing currently
tells the developer to measure before touching code. Adaptation: not a new
generic seat, but a narrow, on-demand worker in the same spirit as
`fact-checker` (outside the per-package pipeline, dispatched only when a
package's job is specifically a performance investigation): `sonnet`,
`high` effort, `Read, Grep, Glob, Bash` (profiling and measurement only, no
edit access), producing a baseline-and-target report the lead hands to
`developer` before implementation and to `tester` for the after-measurement.
Bounded by construction the same way `fact-checker` is: one worker, one
report, no fan-out. Suggested size: **M** (needs a small workflow or agent
file plus a defined report schema, more than a prompt edit).

### 3. Report health-score header (from `agents/core/code-archaeologist.md`)

Their `code-archaeologist` report format opens with a compact "Health Score
(0-10)" and "Top 3 Risks" before the detailed sections. Our
`tm-review-codebase.js` critic already writes "the verdict and summary first"
into its dated report file, but nothing gives a reader who only skims the top
of the file a fast severity or risk signal across runs over time.
`tm-review-changes.js`'s critic writes no report file at all (it returns a
structured `verdict`/`summary`/`mustFix`/`shouldFix`/`nits` object, with no
`reportPath` and no prose section to extend), and `tm-map-codebase.js`'s
critic writes no verdict either (its schema is `summary`, `reportPath`,
`openQuestions`, `coverage`, and its prompt explicitly rules out findings,
severities, and recommendations, per the map's no-findings contract). This
candidate targets `tm-review-codebase.js` only. Adaptation: add two short
fields to that critic's report prompt (not a new schema property, just two
more sentences in the existing "verdict and summary first" instruction) - a
one-line health impression and up to three named top risks, written directly
into the report's opening section. This is a prompt-only change to one
existing file, not a new seat or schema. Suggested size: **S**.

### 4. "Fetch current docs before implementing" step (from `docs/dependencies.md` and the sampled specialized agents)

Their Context7-MCP note and the sampled `django-backend-expert.md` /
`python-expert.md` both instruct the agent to fetch current framework
documentation (via Context7 MCP or WebFetch) before writing code against an
unfamiliar API, specifically to avoid generating code against a stale
training-data version of a fast-moving library. `developer.md` has no
equivalent instruction today; nothing stops it from implementing against a
remembered but outdated API shape. Adaptation: add a short instruction to
`developer.md`'s orientation step: when an issue touches a library or API the
developer is not confident is current, WebFetch the library's own docs before
writing code against it. `developer.md`'s `tools:` line
(`Read, Grep, Glob, Bash, Write, Edit, TodoWrite`) does not list `WebFetch`
today, and an explicit tools list excludes everything unlisted, so adoption
adds `WebFetch` to that line alongside the instruction text. No new seat, a
doc-only edit to one existing agent file. Suggested size: **S**.

## Considered and rejected

- **`tech-lead-orchestrator`** (`agents/orchestrators/tech-lead-orchestrator.md`) - duplicates the lead session's own routing role; adopting it would mean routing through an agent instead of the lead, which is the nested-tree pattern our flat star exists to avoid.
- **`code-reviewer`** (`agents/core/code-reviewer.md`) - duplicates `reviewer` and `tm-review-changes.js`'s bugs/security/scope/tests/style dimensions; its severity-tagged table format is already matched by our findings schema.
- **`project-analyst`** (`agents/orchestrators/project-analyst.md`) - stack detection for an unfamiliar repo; our agents orient by reading `docs/architecture/` first, and the plugin runs against the user's own known repos, not fresh unknown ones.
- **`team-configurator`** (`agents/orchestrators/team-configurator.md`) - auto-writes an "AI Team Configuration" section into CLAUDE.md; conflicts with `docs/architecture/operating-model.md`'s retirement of the template/auto-scaffold path and with CLAUDE.md being a locked policy doc, not agent-generated.
- **`backend-developer` / `frontend-developer`** (`agents/universal/`) - polyglot generic implementers; duplicate `developer`, which already detects and follows a repo's existing stack.
- **`api-architect`** (`agents/universal/api-architect.md`) - contract-first API design as a standalone deliverable; the concrete value (calling out API-contract details up front) already fits inside `architect`'s existing `JOB: SUB_PLAN`, not a new seat.
- **`tailwind-css-expert`** (`agents/universal/tailwind-css-expert.md`) - stack-specific to Tailwind; noise unless a given target repo actually uses it, and then it is no more than `developer` with a framework-specific prompt.
- **The 22-file `agents/specialized/` tree** - framework experts (Laravel, Django, Rails, React, Vue) organized one file per concern; each is `developer` with a stack-specific system prompt and inline code examples, not a qualitatively new capability. Relevant only if a specific target repo uses that exact stack, and even then the gain is a longer prompt, not a new seat.
- **"Router vs expert" description-writing pattern** (`docs/best-practices.md`) - their advice tunes agent `description` text so Claude's auto-invocation picks the right agent from conversation cues. We don't use auto-invocation; the lead dispatches agents explicitly by type, so this guidance has no seat to attach to.

## Next step

The user picks which, if any, of the four candidates above to adopt. No
issues are filed as part of this package; #163 is the survey itself.
