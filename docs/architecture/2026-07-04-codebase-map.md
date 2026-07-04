# Codebase map, 2026-07-04

## Executive summary

This repository is a reusable Claude Code project template, not an application
with runtime code. Its subject is an "orchestrator team": a set of role agents,
slash-command skills, and bounded orchestration scripts that let a Claude Code
session run a small software team against GitHub issues. Everything the repo
ships is prompt text, configuration, documentation, and a handful of JavaScript
orchestration scripts with a zero-dependency Node test suite. There is no
product source, no build step, and no service to deploy. The single executable
entry point is `npm test`, which runs the workflow policy-lock tests.

The repo has six areas that layer on top of each other. At the base is the
**root docs and manifests** layer (`CLAUDE.md`, `README.md`,
`NEW-PROJECT-SETUP.md`, `package.json`, `.gitignore`,
`.claude-plugin/marketplace.json`). It defines what the repo is, how to
bootstrap a concrete project from it, and how to distribute the team to other
repos either by copying the `.claude/` tree or by installing it as a Claude Code
plugin. `CLAUDE.md` is the first thing a session reads and it pulls in the team
guide by `@`-import.

On top of that sits the **Claude plugin core**: the plugin manifest
(`.claude/.claude-plugin/plugin.json`), project settings (`.claude/settings.json`),
the five role-agent definitions (`architect`, `developer`, `tester`, `reviewer`,
`fact-checker`), and the process document `team-guide.md`. The agents are
prompt files with YAML frontmatter that pins each seat's tools, model, effort,
and isolation. The team guide is the written contract for how they are used:
issue and branch conventions, t-shirt sizing, the sub-plan checkpoint
discipline, the CI cost policy, the flat-star dispatch model, and the full
model policy that decides which model runs in which seat at which effort.

The **Claude skills** area is the slash-command layer (`.claude/skills/<name>/SKILL.md`).
Some skills are self-contained procedures (`tm-grill-me`, `tm-to-issues`,
`tm-new-project`). Three are thin wrappers that hand off to a bounded script
(`tm-map-codebase`, `tm-review-changes`, `tm-review-codebase`). Two are the live
multi-agent orchestrators: `tm-kickoff` fans sized GitHub issues out to the role
agents through a serial per-package pipeline run in parallel waves, and
`tm-advisor` wraps `tm-kickoff` with a refine/propose/sign-off/run/report loop
gated by one human sign-off per batch.

The **bounded orchestration workflows** area holds the three JavaScript scripts
those wrapper skills call (`tm-review-changes.js`, `tm-review-codebase.js`,
`tm-map-codebase.js`) plus the `__tests__` suite that locks in their safety
properties. Each script fans out a fixed or capped number of Sonnet sub-agents
and funnels them through a single Fable critic, so agent count is bounded by
construction and every stage's model and effort are pinned in the script rather
than inherited from the session.

The last two areas are the paper trail. **Plans and specs** (`docs/plans/`,
`docs/superpowers/specs/`) record the design of the repo's own machinery: a
spec captures an approved brainstormed design, and a plan expands it into a
checkbox implementation plan tied to one issue. **Reviews, research, and
architecture record** (`docs/reviews/`, `docs/research/`,
`docs/team-architecture.md`) is the append-only audit trail: dated full-repo
review reports, an orchestration comparison, an external-repo adoption study,
and the living team-architecture diagram. The two review-and-map workflows write
their output into these directories, so the workflows area and the record area
are joined by that write path.

The through-line is that this is a self-hosting template: the machinery under
`.claude/` is designed to build software, and the `docs/` tree shows that same
machinery being used to design and review the machinery itself.

## Component table

| Area | Purpose | Key modules |
| --- | --- | --- |
| Root docs and manifests | The repo's front door and template scaffolding: what the repo is, how to bootstrap a concrete project, and how to distribute the team by copy or plugin install. | `CLAUDE.md`, `README.md`, `NEW-PROJECT-SETUP.md`, `package.json`, `.gitignore`, `.claude-plugin/marketplace.json` |
| Claude plugin core (agents, settings, team guide) | Packages the repo's Claude Code customizations as an installable plugin and defines the five role agents plus the process rules that govern them. | `.claude/.claude-plugin/plugin.json`, `.claude/settings.json`, `.claude/agents/{architect,developer,tester,reviewer,fact-checker}.md`, `.claude/team-guide.md` |
| Claude skills (SKILL.md commands) | The slash-command layer: interview and breakdown procedures, a one-time setup wizard, three workflow wrappers, and the two live orchestrators. | `.claude/skills/{tm-advisor,tm-kickoff,tm-grill-me,tm-to-issues,tm-new-project,tm-map-codebase,tm-review-changes,tm-review-codebase}/SKILL.md`, `tm-new-project/templates/ci.yml` |
| Bounded orchestration workflows and their tests | Three token-bounded multi-agent scripts (diff review, whole-repo review, whole-repo map) plus a policy-lock test suite that reads the real source, frontmatter, and CI template. | `.claude/workflows/tm-review-changes.js`, `tm-review-codebase.js`, `tm-map-codebase.js`; `__tests__/{helpers,effort-policy,ci-template-policy}.test.mjs`; inlined `safeRef`/`parseArgs` helpers |
| Plans and specs (docs/plans, docs/superpowers/specs) | Records the two written design stages (approved spec, then checkbox implementation plan) for the repo's own machinery. | `docs/plans/{37-review-codebase,98-tm-install-team}.md`; `docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`, `2026-06-13-review-codebase-design.md`, `2026-06-15-tm-install-team-design.md`, `2026-06-16-process-guidance-rehoming-design.md` |
| Reviews, research, and architecture record | The append-only audit trail and reference docs: dated review reports, an orchestration comparison, an adoption study, and the living team diagram. | `docs/reviews/{2026-06-13,2026-06-14,2026-06-30}-codebase-review.md`, `docs/reviews/2026-06-30-orchestration-comparison.md`, `docs/research/2026-07-04-awesome-claude-agents-adoption.md`, `docs/team-architecture.md` |

## Data-flow narrative

Nothing in this repo moves runtime application data; the "data" is prompt text,
configuration, GitHub state, and markdown documents. Data flows along four
paths.

**Session load path.** When a Claude Code session opens in a repo derived from
this template, the harness reads `plugin.json` and `settings.json` to decide
which plugins and settings apply. `CLAUDE.md` is read first and its
`@.claude/team-guide.md` import composes the process rules and model policy into
the session's context. Each `agents/*.md` file's frontmatter configures how the
harness dispatches that agent, and its markdown body becomes that agent's system
prompt. Skills are auto-discovered from `.claude/skills/*/SKILL.md`, with
`disable-model-invocation: true` restricting most of them to explicit user
invocation.

**Orchestration path.** A raw need is refined and sized into GitHub issues
(via `tm-grill-me` and `tm-to-issues`, or via `tm-advisor`'s refine step). Issue
bodies carry `Blocked by: #N` and `Part of batch #N` markers and size labels.
`tm-kickoff` reads those markers to build dependency-ordered waves, then runs
each package through a serial architect to developer to tester to reviewer
pipeline, up to three packages concurrently. Because subagents cannot call each
other, the lead session sequences every dispatch. At each dispatch the lead
passes an agent an issue number, branch, PR number, a `JOB:` line, or a quoted
block to audit; the agent reads repo and GitHub state through its permitted
tools and returns a fixed-format report (a sub-plan, a STATUS block, a VERDICT
block, and so on). The lead relays that result and persists state to GitHub:
sub-plan comments, verdict comments, draft PRs, and labels like `in-progress`
and `needs-human`. GitHub is the durable store that lets a dropped session
resume. `tm-advisor` wraps this same pipeline with a single sign-off gate and a
`Batch: <slug>` tracking issue that holds the approved contract, the decision
log, parked questions, and the final report.

**Bounded-workflow path.** The three wrapper skills pass their argument (a base
ref, a path, or nothing) straight into the Workflow tool, which executes the
matching `.js` script. Inside a script, the `args` value is normalized by
`parseArgs` and sanitized by `safeRef`, then flows through pinned agent stages.
`tm-review-changes` runs seven parallel Sonnet dimension workers over a diff and
funnels their findings into one Fable critic that returns a verdict.
`tm-review-codebase` and `tm-map-codebase` run a Sonnet scout that splits the
repo into at most `MAX_AREAS` areas (the clamp is JS code, not just a prompt
instruction), then one Sonnet worker per area (plus a fixed architecture worker
in the review variant), then one Fable critic. The critic writes a dated
markdown file into `docs/reviews/` (review) or `docs/architecture/` (map) and
returns a structured report with a `coverage` object and a `reportPath`. Failed
or skipped workers are null-padded and filtered so partial coverage is reported
rather than crashing.

**Documentation path.** Specs are written to `docs/superpowers/specs/` from
brainstorming sessions, then expanded into `docs/plans/` implementation plans,
which are ticked off task by task and amended in place rather than rewritten
once the shipped code diverges. Review reports written by the workflows read
earlier reports to state what has shipped and what remains open, so findings
flow forward in time from report to report. The orchestration-comparison report
both reads `team-guide.md`'s model policy and is cited back by it. None of these
documents are parsed programmatically; they are read by later sessions and later
dated reports.

**Test path.** `npm test` feeds the `.test.mjs` glob to Node's built-in test
runner. Those tests read the real source text, agent frontmatter, and CI
template (not mocks or copies) and either assert on that text or evaluate small
extracted function bodies in a `node:vm` context, so a future edit that drops an
effort pin, a CI cost control, or lets the two duplicated helpers diverge fails
the suite.

## Dependency summary

**External tools and services**

- **Claude Code harness.** Supplies agent dispatch, tools and model/effort
  frontmatter enforcement, worktree isolation, plugin and marketplace loading,
  and the Workflow runtime that provides the `agent()`, `parallel()`, `phase()`,
  and `args` globals to the workflow scripts. No import statement supplies these;
  they exist at execution time only.
- **GitHub CLI (`gh`) and GitHub.** Issue, PR, and label operations across the
  agents and the `tm-advisor`, `tm-kickoff`, and `tm-new-project` skills; also
  the source of live verification evidence cited in some review reports and in
  the adoption study.
- **git.** Branch and worktree operations used by the agents and by
  `tm-kickoff`'s cleanup step; git commands also appear inside workflow agent
  prompts (the scripts build the command strings, the agent runs them).
- **Node.js built-in test runner** (`node --test`) plus `node:test`,
  `node:assert`, `node:fs`, `node:vm`, `node:url`, `node:path`, used only by the
  test files. `package.json` declares no npm dependencies.
- **superpowers plugin** (`claude-plugins-official`), enabled in
  `settings.json`. Supplies `test-driven-development` (preloaded by the
  developer agent), `verification-before-completion` (preloaded by the tester
  agent), and `brainstorming`, `writing-plans`, `executing-plans`,
  `subagent-driven-development` referenced throughout the guide, skills, plans,
  and specs.
- **External MIT-licensed skills.** `tm-grill-me` and `tm-to-issues` are adapted
  from `github.com/mattpocock/skills`.
- **External repos referenced by the record area.**
  `vijaythecoder/awesome-claude-agents` is the subject of the adoption study
  (fetched via `gh api` and `raw.githubusercontent.com`);
  `owainlewis/youtube-tutorials` is credited as the source the flat-star diagram
  adapts from. `NEW-PROJECT-SETUP.md` and `README.md` also name optional
  third-party design plugins a consuming repo may install.

**Cross-area dependencies**

- `CLAUDE.md` (root) imports `.claude/team-guide.md` (plugin core) by
  `@`-import, and `.claude-plugin/marketplace.json` (root) points its plugin
  `source` at `.claude/`, resolving to `.claude/.claude-plugin/plugin.json`
  (plugin core).
- The skills area dispatches the plugin-core agents (`tm-kickoff` runs
  architect, developer, tester, reviewer) and calls the workflow scripts (the
  three wrapper skills). The developer and tester agents read `CLAUDE.md`'s
  "Useful commands"; the architect reads `docs/architecture/`.
- The workflow tests reach across areas by reading real files: `effort-policy.test.mjs`
  reads `.claude/agents/*.md` frontmatter (plugin core), and
  `ci-template-policy.test.mjs` reads `.claude/skills/tm-new-project/templates/ci.yml`
  (skills).
- The review and map workflows write into `docs/reviews/` and
  `docs/architecture/`, joining the workflows area to the record area. Review
  reports cross-reference `docs/plans/` and `docs/superpowers/specs/` for
  staleness, and the orchestration-comparison report and `team-guide.md` cite
  each other.
- Plans and specs describe and are declared subordinate to the shipped
  artifacts they document (for example `docs/plans/37-review-codebase.md` versus
  the canonical `.claude/workflows/tm-review-codebase.js`), and they seed the
  skills and guide sections that implement their decisions.
- The six canonical GitHub labels and their `gh label create --force` upsert
  block are duplicated byte-for-byte across `tm-advisor`, `tm-kickoff`, and
  `tm-new-project`; `safeRef` and `parseArgs` are duplicated byte-for-byte
  across the workflow scripts, with byte-identity enforced by
  `helpers.test.mjs`.

## Open questions

- The Workflow runtime that provides `agent()`, `parallel()`, `phase()`, and
  `args` to the three `.js` scripts is not present in the repo and has no import
  statement. It is assumed to be a Claude Code harness-level feature, but its
  exact contract (how `parallel()` schedules and null-pads, how `phase()` drives
  UI, how model and effort pins are honored) could not be confirmed from the
  mapped source and needs a human or the harness docs to verify.
- `.claude/skills/tm-install-team/SKILL.md` is referenced as a shipped artifact
  by `docs/plans/98-tm-install-team.md` and the 2026-06-15 spec, but the skills
  area map does not list a `tm-install-team` skill among the discovered
  `SKILL.md` files. Whether that skill still exists, was renamed, or was folded
  into `tm-new-project` and the process-guidance rehoming could not be
  determined from the maps alone.
- Two of the four specs (`2026-06-12-advisor-operating-model` and
  `2026-06-16-process-guidance-rehoming`) have no matching file in
  `docs/plans/`. The stated reason is that they were implemented without a
  separate checkbox plan, but confirmation that no plan is missing is a human
  check.
- The exact CLI commands for a concrete project (dev, run, typecheck, lint) are
  still placeholders in `CLAUDE.md`; only `npm test` is filled in. This is
  expected for an unbootstrapped template, but any consuming repo needs to fill
  these in.
- `README.md` states an "all rights reserved" license while several ingested and
  adapted sources are MIT-licensed (`mattpocock/skills`,
  `vijaythecoder/awesome-claude-agents`). Whether the repo-level license and the
  attribution of adapted material are fully reconciled is a human/legal check,
  not something determinable from the code.
