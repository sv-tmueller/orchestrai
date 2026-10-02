# Survey: Claude-of-Tanks orchestration - 2026-08-22

Related: #344.

**Source:** https://github.com/Kevin-Liu-01/Claude-of-Tanks
**Author:** Kevin B. Liu
**License:** MIT (confirmed against the cloned `LICENSE`)
**Surveyed commit:** `1099cec7ec2f6bd381e70bb02f9bf6acb72a7f8d`
**Survey date:** 2026-08-22

## Bottom line

The source is a Three.js tank game, not an orchestrator, but it carries a
complete home-grown agent-team architecture built for a different shape of
problem than ours: many long-running parallel agents grinding one measured
metric on a single shared checkout, over weeks. Most of the machinery is
domain hardware (a geometry gate, hash-freezing, a 14-view visual critic) and
does not transfer. Five things do, and each is a small edit against machinery
we already have rather than a new pattern.

The strongest one is adversarial verification of findings. Their evaluation
pass ran one skeptic per major finding whose default stance was "this is wrong
or stale", and refuted 10 of 24 (`HANDOFF.md` section 5.2: "14 confirmed / 10
refuted"). Our two review workflows go worker -> critic with no such stage,
and our `fact-checker` seat only runs on demand, after the fact, against a
finished report. That is a measured 40%-ish false-positive rate in exactly the
place we do not check.

One caution about the source's authority: by its own numbers the loop did not
converge. Seven rounds, round averages 6.8 -> 7.23, pass count stuck at 1-2 of
12 dimensions, the stated exit condition (two consecutive all-clean rounds)
never reached, and the final-judgment workflow written but never run. Mine it
for technique, not for proof that the whole assembly works.

## What was surveyed

Read in full: `AGENTS.md`, `SKILL.md`, `HANDOFF.md`, `.claude/launch.json`,
all seven `.claude/skills/*/SKILL.md` (`spawn-builder`, `spawn-critic`,
`land-round`, `graduate`, `photo-round`, `onboard-oracle`, `oracle-repair`),
`docs/agents/final-judgment.spec.js`, and `skills-lock.json`. Read in part:
`docs/PROGRAM-STATE.md` (sections 0-2, 5-8, 12-13; the file is 9,361 lines).
Directory listings only: `docs/`, `docs/handoff/`, `src/`.

## Their model vs ours

| | Claude-of-Tanks | orchestrai |
|---|---|---|
| Topology | Orchestrator + 6-8 long-lived builder agents, 2 critics max | Flat star, lead routes every handoff, up to 3 packages concurrent |
| Unit of work | A "round" on one vehicle family, no iteration cap | A GitHub issue, sized, with fix-round caps |
| Isolation | Single-owner file convention on one shared checkout | `isolation: worktree` per agent |
| Who commits | Orchestrator only, after re-running every claimed measurement | The developer commits on its own branch |
| State | `docs/PROGRAM-STATE.md`, append-only, 727 KB | Batch tracking issue + package issues on GitHub |
| Quality bar | A measured gate (>=90 every component) plus an independent critic (>=9.0 on 14 views) | Tester PASS plus reviewer APPROVE |
| Agent briefs | Templated by `spawn-builder` / `spawn-critic` skills | Agent frontmatter plus tm-kickoff prose |

The two differences that matter for adoption: they have an objective numeric
oracle we do not (a geometry gate that produces a score without a model in the
loop), and they have no worktree isolation so they had to invent conventions
we get from the harness. Anything that leans on either does not port.

## Adoption candidates

### 1. A `Verify` stage in the review workflows (from `docs/agents/final-judgment.spec.js`)

Their spec fans out one verifier per deduped critical/major finding:

> "Your default stance is that it is WRONG or STALE. Reproduce it against the
> current tree or refute it. [...] Cannot reproduce, already fixed, or the
> evidence does not hold = confirmed:false."

`HANDOFF.md` section 5.2 calls this out as load-bearing: "This
adversarial-verify step is what keeps the reports honest - do not skip it."

Our `.claude/workflows/tm-review-codebase.js` runs Scout -> Review ->
Consolidate, and `tm-review-changes.js` runs Review -> Consolidate. In both,
the Opus critic is asked to verify findings while also consolidating and
writing the report, from the workers' text alone. Nothing re-derives a finding
against the tree.

Concretely: insert a `verify` stage between Review and Consolidate, worker
tier (sonnet/high), fanning out over deduped `must-fix` findings only, capped
the way `MAX_AREAS` already caps the scout, with a two-field schema
(`confirmed`, `note`). Feed confirmed and refuted separately into the critic
so the report can carry a refuted appendix. This is additive to the existing
`SPEC` shape (a new entry in `stages`, `parallelism: 'dynamic-list'`), so the
spec-sync test and the adapter interface absorb it without redesign.

Cost: one extra worker dispatch per must-fix finding, bounded by the cap.
Against a review that currently ships unverified must-fixes to a human, that
is cheap.

### 2. Score-capping hard gates in critic prompts (from `HANDOFF.md` section 5.1)

Their critic prompts carry deterministic caps that override the model's
holistic read: rectangular slab track-runs caps `tank_models` at 6.0, a hull
more than 3 cm below terrain caps `gameplay_feel` at 5.0, perf budgets unmet
at dsf2 forces `performance_budget` below the pass bar. The point is that a
known-unacceptable condition cannot be averaged away by an otherwise good
impression.

Our `FINDING.severity` enum (`must-fix` / `should-fix` / `nit`) is pure model
judgment with no such floor. We have repo rules that are objectively checkable
and belong in that class: a deleted or weakened test, `--no-verify`, a new
dependency with no PR-body justification, a CI job without `timeout-minutes`
or a workflow without a `cancel-in-progress` concurrency group, a direct push
to `main`. Each is already law in `.claude/process-core.md`; none of them
currently forces a `must-fix`.

Concretely: a short auto-must-fix table appended to the review prompts in both
workflows and in `reviewer.md`. Prompt text only, no new agents, no schema
change.

### 3. SendMessage-resume before respawn (from `land-round` section 5 and PROGRAM-STATE section 6)

> "Dead/stalled agents: SendMessage-resume first (context intact); respawn
> fresh only if the transcript is unrecoverable. Waiter-stalls ('waiting on
> the watcher') get a finalize nudge - stopping to wait ends an agent's run."

`tm-kickoff` has fix-round caps and "never re-dispatch an unchanged prompt",
but no rule for an agent that returns nothing or stalls. Today that lands as a
fresh dispatch, which throws away the agent's context and burns the work
again. The Agent tool documents SendMessage continuation for exactly this.

Concretely: one routing rule in `.claude/skills/tm-kickoff/SKILL.md` section
3, next to the Opus-limit fallback rule. Note that this is distinct from the
Opus-limit case, where the model must change and a resume would fail the same
way.

### 4. A law bank -> living rulebook promotion step (from `spawn-builder` item 11 and `land-round` section 4)

Every round report ends with "law discoveries for the bank"; the per-tank
packet holds the raw record, and at landing the orchestrator folds the
generalizable ones into `docs/BUILD-STANDARD.md` "the turn they arrive". Two
tiers: a cheap per-unit scratch record, and a curated global standard that
only the orchestrator writes.

We have the curated tier (`docs/architecture/`, `.claude/process-core.md`) and
we have per-package issues, but no channel between them. `CLAUDE.md` says a
doc gets corrected when code contradicts it; nothing captures a process lesson
learned during a run. Our own `docs/` has the evidence that this leaks: the
incident knowledge in `docs/team-guide-rationale.md` and the postmortem-shaped
content in `docs/reviews/` arrived by hand, not by a pipeline step.

Concretely: an optional `LESSONS:` line in the tester and reviewer report
contracts, and a step in `tm-kickoff` section 4 (wave end) that surfaces
collected lessons in the report for the human to promote. Keep the promotion
human - our curated tier is small and an agent-written standards edit is the
kind of irreversible outward-facing change the advisor model parks.

### 5. Sibling-invariant proof for shared-machinery changes (from `spawn-builder` item 2 and item 8)

Their rule for touching a shared helper: the edit must be an opt-in parameter
with byte-identical defaults, and the agent must prove it by hashing the
sibling outputs before the first edit and again at close. A moved sibling hash
invalidates the round.

We get file isolation from worktrees, but `tm-kickoff` itself records that
"worktree isolation does not reliably separate the working tree", and
isolation says nothing about a change to shared machinery altering other
packages' behaviour. Our analogue of a geometry hash is `npm test`, which
already covers the effort-policy and spec-sync invariants.

Concretely: for a package whose diff touches `.claude/workflows/`,
`.claude/adapters/`, or `.claude/process-core.md`, require the tester to run
the full suite on the branch and on its merge-base and report both, so an
"unchanged" claim about the rest of the machinery is measured rather than
asserted. Weakest of the five; worth filing only if we hit the failure.

## Considered and rejected

- **`docs/PROGRAM-STATE.md` as a resume handbook.** 9,361 lines, 727 KB, and
  the resume protocol (section 13) says to read it before starting. That is
  roughly 180k tokens of context before any work, in a project whose own
  team-guide warns about lead-session context growth. The append-only growth
  also broke its own ordering: it started as sections 0-13 and new entries got
  wedged in as fractional numbers, so `4.99999` and `5.0` follow section 13 in
  file order and section 5 is marked superseded by section 12. Our batch
  tracking issue is bounded, disposable, and queryable. This is the source's
  cautionary tale, not its lesson.
- **The `spawn-builder` / `spawn-critic` brief-template-as-skill pattern.**
  Genuinely good ("a brief that predates a law never excuses missing it"), but
  it solves brief drift across many ad-hoc round types. We have five fixed
  pipeline stages whose contracts already live in the agent files. Revisit if
  ad-hoc dispatch types multiply.
- **The `agent-docs:auto` / `agent-docs:fill` marker convention in
  `AGENTS.md`.** Machine-owned blocks regenerated by a scaffold command,
  human-owned prose between them. Attractive, but it depends on an external
  private toolchain (`KEVIN_WIKI_ROOT`, a Graphify sidecar) and our
  `tm-map-codebase` already produces dated maps without needing an in-place
  rewrite protocol.
- **The FIFO lock (`/tmp/cot-shots.lock`, self-ticketing rigs, 15-digit
  tickets, staleness reclaim).** Serializes contention on one GPU/browser.
  No analogue here.
- **The gate ladder, hash-freezing, `graduate`, `oracle-repair`,
  `onboard-oracle`, `photo-round`.** Domain hardware for tank geometry.
- **Committed absolute paths.** `.claude/launch.json` and
  `final-judgment.spec.js` both hardcode `/Users/kevinliu/...`. Anti-pattern,
  noted so we do not copy it along with the workflow shape.

## Next step

Candidates 1 and 2 are the ones with a measured argument behind them and are
`size:S` each against existing files. Candidates 3 and 4 are `size:S`
prose edits. Candidate 5 is speculative. Refine and size on #344 before
filing anything.
