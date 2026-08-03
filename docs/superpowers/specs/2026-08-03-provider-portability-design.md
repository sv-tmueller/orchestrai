# Provider portability: what in `.claude/` is Claude-Code-bound

Date: 2026-08-03
Status: assessment, informational. Affirms `docs/architecture/operating-model.md`;
does not reopen the substrate decision. The phases in the proposal are
contingent on a revisit trigger firing, not an approved roadmap.

## 1. Question and method

Issue #300 asks which artifacts under `.claude/` are genuinely tied to
Claude Code, and which are host-neutral process that only happens to live
there today. This matters only if a revisit trigger from
`docs/superpowers/specs/2026-07-08-codex-readiness-design.md` fires; that
document rejected a full host-and-model abstraction as premature and
sanctioned exactly one re-entry path (a subscription-authed Codex worker
seat, driven by the Claude lead). This assessment does not re-derive that
research. Where it maps a Codex equivalent, it cites that document's
mapping (personas Markdown -> TOML, skills near-identical, MCP and slash
commands map across, no deterministic fan-out primitive for the Workflow
tool). Where a mapping was not covered there, the cell reads "unknown,
re-verify per 2026-07-08" rather than inventing one from fresh research.

Row generation was mechanical: `find .claude -type f | sort` first, one row
per result, before any artifact was read. That produced 28 files at the time
of writing (agents, skills, their templates, the plugin manifest, settings,
team-guide, the three workflow scripts, and their tests). Completeness is
checked by construction, not by memory: every `.claude/...` path this doc
names is diffed back against that same `find` list (see section 5).

## 2. Verdict, in one line

Bound only at a thin shell. A `SKILL.md` body is neutral procedure; its
frontmatter is the adapter. Most rows below carry the same shape: a small
Claude-Code-specific header wrapped around process content that does not
itself name a host.

## 2a. Why this does not reopen the substrate decision

`docs/architecture/operating-model.md` locks the substrate (Claude Code
plus the Claude model family) and defers the port; the sanctioned re-entry
path is a single Codex worker seat, not a rewrite of this team's host. That
lock is not touched here: this document adds no code, changes no runtime
behavior, and proposes no port. It only sorts existing files into two
buckets so a future revisit (if one is ever triggered) does not have to
redo that sorting from scratch. If any phase in section 7 is ever picked
up, it still has to clear the same bar `docs/superpowers/specs/2026-07-08-codex-readiness-design.md`
set: keep the Claude side's caching, Workflow tool, and per-seat model
policy fully intact, and treat a non-Anthropic seat as an addition, not a
replacement.

## 2b. The neutral core, enumerated

This is not hypothetical; each item below is a real mechanism already in
use, not a design goal:

- GitHub issues and PRs as the durable state a dropped session resumes from.
- Git branches and worktrees as the isolation unit per package.
- Conventional Commits, imperative mood, a body that explains why.
- T-shirt sizing (`size:S` through `size:XL`) and the re-label-if-bigger rule.
- The flat-star choreography (sub-plan, develop, test, review, PR ready)
  and each seat's report contract (STATUS/BRANCH/PR/CHECKS lines, VERDICT
  lines, and so on).
- Test-driven development for logic with a right answer.
- The CI cost policy (staged jobs, pinned timeouts, concurrency
  cancellation, draft-PR skip for build/e2e).
- The writing-style rules (no em dashes, no AI-cliche phrases, comments
  only for non-obvious whys).

Root `AGENTS.md` already carries this subset today, self-contained, with no
`@` import syntax and no tool names in it. That is the existing proof that
the neutral core is not speculative.

## 3. Coupling surfaces

Seven surfaces account for every bound row below:

1. Distribution/manifest (plugin manifest, settings' enabled-plugins map,
   the superpowers dependency)
2. Agent frontmatter schema (tools, model, effort, worktree isolation,
   namespaced skill references)
3. Skill frontmatter (the model-invocation guard flag, the argument-hint
   field)
4. Tool names in prose (the Skill tool, the Workflow tool, the Agent tool,
   plus the Read/Grep/Glob/Bash/Write/Edit/TodoWrite/WebFetch vocabulary)
5. Workflow runtime API (`export const meta`, `agent(prompt, opts)`,
   `log()`, `phase()`, `parallel()`, `args`)
6. Model vocabulary (per-seat model pinning, the effort ladder, the
   session model command, the Agent tool's per-call model override)
7. Host-path and command coupling in prose (`.claude/` paths, the user
   config CLAUDE.md path, the `@` import syntax, the plugin-update command,
   the session effort command)

Classification stays at role level throughout; no row below quotes a
current model name, so a pending rename of any specific model reference
elsewhere in this repo cannot stale this table.

## 3a. Two worked examples

`.claude/skills/tm-grill-me/SKILL.md` sits at one end: its frontmatter is
just `name` and `description`, fields any `SKILL.md`-shaped host reads the
same way, and its body is a generic interview prompt with no tool name, no
`.claude/` path, and no model reference. Nothing in it would need to change
to run under a different host.

`.claude/workflows/tm-map-codebase.js` sits at the other end: it exists
only because the Workflow tool exists. `export const meta`, `agent()`,
`parallel()`, `log()`, and `phase()` are not conventions this script chose;
they are the runtime it is written against. Per the 2026-07-08 spec, no
other host has a deterministic equivalent, so this file (and its two
siblings) could not be ported, only rebuilt, with an external driver taking
the runtime's place.

Most rows fall between these two poles: a `SKILL.md` guard clause or an
agent's frontmatter block, wrapped around otherwise-portable process
prose, per the "thin shell" framing in section 2.

## 4. Classification table

Verdict: **Neutral** = harness-neutral, **Bound** = Claude-Code-bound.
Codex equivalent is filled only for Bound rows.

| Path | Verdict | Justification | Coupling surface | Codex equivalent |
| --- | --- | --- | --- | --- |
| `.claude/.claude-plugin/plugin.json` | Bound | Plugin manifest (name, version, description, author) is Claude Code's plugin schema. | 1 | unknown, re-verify per 2026-07-08 |
| `.claude/agents/architect.md` | Bound | Frontmatter pins tools/model/effort in the agent schema; body also names specific read-only tools. | 2 | Personas map Markdown -> TOML (2026-07-08 3) |
| `.claude/agents/developer.md` | Bound | Frontmatter adds worktree isolation and a namespaced skill reference on top of tools/model/effort; body names WebFetch, TodoWrite, `gh`, `git`. | 2 | Personas map Markdown -> TOML; isolation/skill fields unknown, re-verify per 2026-07-08 |
| `.claude/agents/docs-writer.md` | Bound | Frontmatter pins tools/model/effort; deliberately has no Bash tool. | 2 | Personas map Markdown -> TOML (2026-07-08 3) |
| `.claude/agents/fact-checker.md` | Bound | Frontmatter pins tools/model/effort/worktree isolation. | 2 | Personas map Markdown -> TOML; isolation unknown, re-verify per 2026-07-08 |
| `.claude/agents/perf-investigator.md` | Bound | Frontmatter pins tools/model/effort/worktree isolation. | 2 | Personas map Markdown -> TOML; isolation unknown, re-verify per 2026-07-08 |
| `.claude/agents/reviewer.md` | Bound | Frontmatter pins tools/model/effort; body names `gh pr diff`, `git diff`. | 2 | Personas map Markdown -> TOML (2026-07-08 3) |
| `.claude/agents/tester.md` | Bound | Frontmatter pins tools/model/effort/worktree isolation and a namespaced skill reference. | 2 | Personas map Markdown -> TOML; isolation/skill fields unknown, re-verify per 2026-07-08 |
| `.claude/settings.json` | Bound | `enabledPlugins` keys the superpowers marketplace plugin; a Claude Code plugin-install mechanism. | 1 | unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-ab-test/SKILL.md` | Bound | Frontmatter carries the model-invocation guard and argument-hint; body guards a redundant Skill tool call and invokes the Workflow tool by name. | 3, 4 | Skills format near-identical (2026-07-08 3); the guard fields and Workflow-tool invocation unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-ab-test/templates/recording-checklist.md` | Bound | One field is a literal Workflow-tool invocation call. | 4 | unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-ab-test/templates/report.md` | Neutral | Pure report template: dates, git refs, prose fields, no tool syntax or host paths. | none | n/a |
| `.claude/skills/tm-ab-test/templates/supervised-arm-runbook.md` | Bound | Instructs turning on a named session-level effort setting, a Claude Code session control. | 7 | unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-advisor/SKILL.md` | Bound | Frontmatter carries the model-invocation guard and argument-hint; body guards the Skill tool and drives Workflow-tool-backed stages. | 3, 4 | Skills format near-identical (2026-07-08 3); guard fields unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-grill-me/SKILL.md` | Neutral | Plain name/description frontmatter only; generic interview prompt with no tool names or host paths (external MIT-licensed source). | none | n/a |
| `.claude/skills/tm-kickoff/SKILL.md` | Bound | Frontmatter carries the model-invocation guard and argument-hint; body guards the Skill tool, dispatches other agents, and names the per-call model-override mechanic. | 3, 4 | Skills format near-identical; the per-call override and guard fields unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-map-codebase/SKILL.md` | Bound | Frontmatter carries the model-invocation guard; body guards the Skill tool and invokes the Workflow tool, resolving the plugin root via an environment variable. | 3, 4 | Skills format near-identical; the Workflow-tool invocation and plugin-root resolution unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-new-project/SKILL.md` | Bound | Frontmatter carries the model-invocation guard; its human-only steps section names the Claude Code plugin marketplace and install commands. | 1, 7 | unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-new-project/templates/ci.yml` | Neutral | A GitHub Actions workflow; nothing in it names Claude Code, an agent, or a tool. | none | n/a |
| `.claude/skills/tm-review-changes/SKILL.md` | Bound | Frontmatter carries the model-invocation guard and argument-hint; body guards the Skill tool and invokes the Workflow tool, resolving the plugin root via an environment variable. | 3, 4 | Skills format near-identical; the Workflow-tool invocation unknown, re-verify per 2026-07-08 |
| `.claude/skills/tm-review-codebase/SKILL.md` | Bound | Same shape as `tm-review-changes/SKILL.md`: guard plus a Workflow-tool invocation keyed to the plugin root. | 3, 4 | Skills format near-identical; the Workflow-tool invocation unknown, re-verify per 2026-07-08 |
| `.claude/team-guide.md` | Bound | Names per-seat model pinning, the effort ladder, the session model command, the Agent tool's per-call override, and the user config's `@` import syntax, alongside genuinely neutral sections (sizing, commits, tests, CI cost policy). | 6, 7 | Model-tier vocabulary and the per-call override mechanic unknown, re-verify per 2026-07-08; its neutral sections are exactly the core cited in section 2 |
| `.claude/workflows/__tests__/ci-template-policy.test.mjs` | Neutral | A `node:test` suite over the CI template's raw text; zero Claude Code API surface. | none | n/a |
| `.claude/workflows/__tests__/effort-policy.test.mjs` | Bound | Asserts the agent-frontmatter model/effort schema and the workflow per-stage model/effort lines; the JS harness is plain `node:test`, but its assertions are schema-specific. | 2, 6 | unknown, re-verify per 2026-07-08 (would need a Codex-side schema to assert against) |
| `.claude/workflows/__tests__/helpers.test.mjs` | Bound | Slices and evaluates the Workflow-tool runtime helpers (`criticWithFallback`, `parseArgs`, `safeRef`) that assume the `agent()`/`log()` runtime globals. | 5 | no equivalent exists (2026-07-08 3: no deterministic fan-out primitive) |
| `.claude/workflows/tm-map-codebase.js` | Bound | A Workflow-tool script: `export const meta`, `phase()`/`agent()`/`parallel()`/`log()` runtime globals, `args`, per-stage model/effort pins. | 5, 6 | no equivalent exists; would be rebuilt as an external driver (2026-07-08 3) |
| `.claude/workflows/tm-review-changes.js` | Bound | Same Workflow-tool runtime API and per-stage model/effort pins. | 5, 6 | no equivalent exists; external driver only (2026-07-08 3) |
| `.claude/workflows/tm-review-codebase.js` | Bound | Same Workflow-tool runtime API and per-stage model/effort pins. | 5, 6 | no equivalent exists; external driver only (2026-07-08 3) |

The three workflow scripts above are the only rows where "no equivalent
exists" is a settled fact rather than an open question; every other unknown
cell is a genuine "not yet researched," not a confirmed gap.

Tally: of the 28 rows in the main table, 24 are Claude-Code-bound and 4 are
harness-neutral (two templates, one skill, one test file). Combined with
the appendix (2 bound, 1 neutral), the repo-wide total assessed here is 26
bound and 5 neutral across 31 rows.

## 5. Appendix: outside the stated scope, included because portability cannot be assessed without them

Root-level artifacts, not under `.claude/`, kept in this separate section
per the lead's decision so they cannot be mistaken for part of the
mechanically generated table above.

| Path | Verdict | Justification | Coupling surface | Codex equivalent |
| --- | --- | --- | --- | --- |
| `.claude-plugin/marketplace.json` (repo root) | Bound | Plugin marketplace manifest (name, owner, renames, plugin source) is Claude Code's marketplace format. | 1 | unknown, re-verify per 2026-07-08 |
| `CLAUDE.md` (repo root) | Bound | Its one binding line is the `@` import of `team-guide.md`; the rest is process prose already mirrored in `AGENTS.md`. | 7 | `AGENTS.md` already carries the neutral subset with no `@` import syntax; no further mapping needed |
| `AGENTS.md` (repo root) | Neutral | Already the portable core: no `@` import syntax, no tool names, explicitly self-contained for "any AGENTS.md-aware worker seat." Its only caveat is a line noting `.claude/` is Claude-host machinery a non-Claude seat only reads. | none | n/a; this is the existing proof point that the neutral core is not hypothetical |

## 6. Completeness check

Every `.claude/...` path this document names is diffed against a fresh
`find .claude -type f | sort` so no artifact in scope is silently missing:

```
comm -23 <(find .claude -type f | sort) <(grep -oE '\.claude/[A-Za-z0-9_./-]+' docs/superpowers/specs/2026-08-03-provider-portability-design.md | sort -u)
```

An empty result means every file `find` returns is named at least once
above. This is a completeness check on paths, not a re-verification of each
row's content.

## 7. Phased proposal (contingent, not approved)

None of these phases is scheduled. Each becomes an issue only if a revisit
trigger from `docs/superpowers/specs/2026-07-08-codex-readiness-design.md`
fires. Sizes are first estimates and may be re-cut once an issue is
actually scoped, same as any other sizing.

**Phase 1** - size:S. Hoist the host-neutral process prose (sizing, commits,
tests, CI cost policy, the flat-star choreography and report contracts)
out of `team-guide.md` into a core doc set referenced by both `CLAUDE.md`
(via `@` import, unchanged) and `AGENTS.md` (via plain reference, since it
cannot use `@` import). This makes the neutral core a single source instead
of two documents that can drift.
Blocked by: none.

**Phase 2** - size:M. Split each `SKILL.md` into a neutral body (the
procedure) and a thin Claude-Code frontmatter adapter (the model-invocation
guard, the argument-hint field). The body becomes the thing a Codex skill
file would reuse near-identically, per the 2026-07-08 mapping.
Blocked by: Phase 1.

**Phase 3** - size:M. Split each agent file into a neutral role contract
(what the seat decides, its report contract) and a seat-binding block
(tools, model, effort, isolation, namespaced skills). The role contract is
what would carry over to a TOML persona; the binding block stays host-specific.
Blocked by: Phase 1.

**Phase 4** - size:M. Express the three workflow scripts' fan-out (areas,
dimensions, phases, the critic-with-fallback retry) as data, with the
current JavaScript as one renderer over that data rather than the only
implementation. Flagged highest-risk of the five: the Workflow tool has no
deterministic fan-out equivalent on any other host today, so this phase is
likely re-sized once someone tries it against a real second renderer.
Blocked by: none.

**Phase 5** - size:S. Replace model names in agent frontmatter and workflow
per-stage pins with tiers (judgment, worker), resolved to an actual model
through a per-host adapter table instead of a hard-coded name.
Blocked by: none.

Any actual Codex adapter implementing phases 2-5 against a live Codex
worker seat is Blocked by: #232, the sanctioned spike from
`docs/superpowers/specs/2026-07-08-codex-readiness-design.md` section 9.
None of these five phases requires #232 to be filed as an issue; only
building a working adapter does.

## 8. Non-goals

What this document deliberately does not do, so its scope stays legible:

- It does not re-derive the Codex-capability research from
  `docs/superpowers/specs/2026-07-08-codex-readiness-design.md`. Every
  Codex-equivalent cell either cites that document or says the mapping is
  unknown and needs a re-verify pass, never a fresh guess.
- It does not quote a current model name in any row, so a rename elsewhere
  in this repo (in flight concurrently) cannot make this table stale on
  that axis; every model reference here is a role ("judgment seat", "worker
  seat") or a tier, never a product name.
- It does not touch `docs/architecture/operating-model.md`. If a pointer
  from that file to this one seemed necessary, that would be a scope
  change parked as needs-human, not something this document does on its
  own initiative.
- It does not propose an implementation plan. Section 7 sketches five
  phases at first-cut sizes; none is an approved issue, and none is
  scheduled. A revisit trigger firing is what would turn any of them into
  one.
- It does not audit `docs/`, `NEW-PROJECT-SETUP.md`, or anything outside
  `.claude/` and the three root files in the appendix. Those may carry
  their own host coupling, but assessing them was not asked for here and
  would dilute this table's one job.
