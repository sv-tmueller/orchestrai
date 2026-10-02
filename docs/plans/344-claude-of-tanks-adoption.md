# Plan: adopt what transfers from Claude-of-Tanks - #344

Survey this plan derives from:
`docs/reviews/2026-08-22-claude-of-tanks-orchestration-survey.md` (PR #345).
Read the survey first for the source analysis; this file is the execution plan
and the reasoning behind its shape.

**Status:** not filed. No issues exist yet. Section 7 holds ready-to-file
bodies so filing is mechanical once approved.

## 1. What this plan is for

The survey found five adoptable ideas. This plan turns four of them into work
packages, drops the fifth, and adds one package that is not from the survey at
all but sits on the critical path: a resolver bug in the Hermes renderer that
the design work uncovered.

The plan is written to be run two ways, because that is what was asked for:

- by this repo's orchestrator team (`/tm-advisor` or `/tm-kickoff`), and
- again by a different model, so the two can be compared and the better parts
  kept.

Section 8 covers the second run. It routes through `/tm-ab-test` rather than a
freehand rerun, because this repo already has that machinery and a ledger with
a model-versus-model precedent (`docs/reviews/2026-07-27-ab-judgment-seats.md`).

## 2. The one thing worth reading if you read nothing else

The headline candidate (adversarial verification of review findings) is **not**
a small change, and my first estimate on #344 said `size:S`. That was wrong.
Correcting it here.

A new workflow stage in this repo is not one file. It is a coupled edit across:

| Surface | File | Enforced by |
|---|---|---|
| Runtime SPEC | `.claude/workflows/<wf>.js` | - |
| Portable spec | `.claude/workflows/specs/<wf>.spec.json` | `specs.test.mjs` |
| Runtime prompts | `PROMPTS` const in `<wf>.js` | - |
| Portable prompts | `.claude/workflows/prompts/<wf>.prompts.json` | `prompts-sync.test.mjs` |
| Second host | `.claude/adapters/hermes-renderer.mjs` (`collectSlotVals`, `inferRole`) | `hermes-renderer-prompts.test.mjs` |
| Tier pinning | stage `tier` field | `effort-policy.test.mjs`, `render-path.test.mjs` |
| Format contract | `docs/architecture/adapter-interface.md` "Spec format" | review |

And there is a harder problem underneath. A verify stage needs its item list to
be "every must-fix finding across all area workers, flattened, deduped, capped".
The spec format cannot say that. `items_source` is a dotted path
(`docs/architecture/adapter-interface.md` lines 132-134), and a dotted path
cannot express flatten, filter, or dedup.

So candidate 1 is really two things: a spec-format extension, then a stage that
uses it. That is why it is `size:M` and why it is split across two packages.

## 3. The bug the design work found

While checking whether a second dynamic-list stage would work, I traced the
existing one and it does not.

`.claude/workflows/specs/tm-review-codebase.spec.json:35` declares
`"items_source": "scout_result.areas"`. The Hermes renderer resolves that path
against `ctx` (`hermes-renderer.mjs:248-263`), and `ctx` is keyed by **stage
name** (`hermes-renderer.mjs:122,126,130` all assign `ctx[name]`). The stage is
named `scout`, so `ctx.scout_result` is always `undefined`, the resolver falls
through to its dry-run stub, and every dynamic-list stage in the Hermes path
fans out over one fake area.

It is invisible today because the Hermes test suite runs dry-run only
(`docs/architecture/hermes-adapter.md:89`), and a stub is exactly what dry-run
expects to see. `tm-map-codebase.spec.json:35` has the same line.

This goes first (P0). Adding a second dynamic-list stage on top of a resolver
that never resolves would double the load on a broken path and make it harder
to see.

It is also, usefully, an example of the class of defect candidate 1 exists to
catch: a claim that reads as true (the spec says the stage fans out over scout
output) that nothing re-derives against the tree.

## 4. Package list

Six packages. That is the `/tm-advisor` batch cap, run 3 at a time.

| # | Package | Size | Blocked by | Source |
|---|---|---|---|---|
| P0 | Fix dynamic-list `items_source` resolution | S | - | found while designing P1 |
| P1 | Spec-format item transforms + Verify stage in `tm-review-changes` | M | P0 | survey candidate 1 |
| P2 | Port the Verify stage to `tm-review-codebase` | S | P1 | survey candidate 1 |
| P3 | Auto-must-fix conditions in review prompts | S | - | survey candidate 2 |
| P4 | Resume-before-respawn routing rule | S | - | survey candidate 3 |
| P5 | `LESSONS:` channel from run to curated docs | S | - | survey candidate 4 |

Dropped: survey candidate 5 (sibling-invariant proof for shared-machinery
changes). Reasoning in section 6.

### Wave plan

- **Wave 1:** P0, P4, P5. Three independent packages, no shared files. P4 and
  P5 are prose-only and will finish well ahead of P0.
- **Wave 2:** P1, P3. P1 needs P0 landed. P3 is independent of both but belongs
  here for a cost reason, not a correctness one: P3 raises must-fix volume, and
  must-fix volume is exactly what P1's verify stage fans out over. Landing P3
  before P1's cap exists means the first post-P3 review pays for an uncapped
  fan-out. Same wave is fine; P3 before P1 is not.
- **Wave 3:** P2.

Merging stays human between waves, per the operating model.

## 5. Package detail

### P0. Fix dynamic-list `items_source` resolution

**Why:** section 3. Critical path for P1 and P2.

**Decision to make.** Two ways to close the gap, and the package should pick
one rather than patch both ends:

- **(a) Key the context by `<stage>_result`.** Change `ctx[name]` to
  `ctx[name + '_result']`. Specs stay as written. Touches one file.
- **(b) Change the specs to `scout.areas`.** Touches two spec JSONs, two
  embedded SPECs, and the format doc's example.

Recommend **(a)**. The `_result` suffix is already the vocabulary the spec
files chose, in both workflows, and it reads better at the callsite
(`scout_result.areas` says what it is; `scout.areas` reads like the stage has
an `areas` property). One file changes instead of five.

**Acceptance:**
1. A test asserts a dynamic-list stage receives items derived from the prior
   stage's real output, not the stub. Today's tests cannot fail on this, which
   is why the bug survived.
2. The stub fallback stays, but logs when it fires, so a future silent
   fall-through is visible in dry-run output.
3. `npm test` green.

**Do not:** delete the stub. Dry-run needs it. The defect is that it fires
unconditionally, not that it exists.

### P1. Spec-format item transforms, then a Verify stage in `tm-review-changes`

**Why:** the survey's headline. Their run refuted 10 of 24 major findings
(`HANDOFF.md` 5.2). Our two review workflows go worker to critic with nothing
re-deriving a finding against the tree, and the Opus critic is asked to verify,
consolidate, and write the report in one pass from worker text alone.
`fact-checker` exists but is a manual dispatch against a finished report, which
is after the point where a false must-fix has already reached a human.

**Why `tm-review-changes` first, not `tm-review-codebase`:** it is the smaller
workflow (two stages, fixed-list, no scout), so the format extension gets
proven on the smaller surface. It also runs more often, so the value lands
sooner.

**The format decision.** Three options for expressing a derived item list:

- **(a) Named transform.** Add `items_transform: "<name>"` to the stage
  descriptor, naming an entry in a small closed registry of reducers that each
  renderer implements. First entry: `must_fix_deduped`.
- **(b) Keep the fan-out in the JS, leave the spec silent.** Cheapest. Rejected:
  `docs/architecture/adapter-interface.md` makes the JSON spec the portable
  representation, so a Hermes or Codex host would silently run a review with no
  verify stage and no signal that it was missing. A portability contract that
  lies is worse than no contract.
- **(c) An expression language in `items_source`.** Rejected as
  over-engineering for one consumer.

Recommend **(a)**. It keeps the spec declarative, the vocabulary is closed and
small, a second host implements a reducer in about ten lines, and it is
testable in a way (b) is not.

**Scope:**
1. `items_transform` field, documented in the adapter-interface "Spec format"
   list alongside `items_source`.
2. A reducer registry in both renderers, with `must_fix_deduped`: flatten
   worker findings, keep `severity === 'must-fix'`, dedup on
   `file + line + problem`, cap.
3. Cap follows the `MAX_AREAS` precedent: an args field plus
   `items_default_cap`. Start at 12.
4. `verify` stage between `review` and `consolidate`. Worker tier. Schema
   `{ confirmed: boolean, note: string }`.
5. The verifier prompt states the adversarial stance explicitly, in the source's
   terms: default position is that the finding is wrong or stale; reproduce it
   against the current tree or it does not survive; cannot reproduce, already
   fixed, or the evidence does not hold all mean `confirmed: false`.
6. The consolidate prompt receives confirmed and refuted as separate inputs.
7. `REPORT_SCHEMA` gains a `refuted` array. The report carries a refuted
   appendix, so the human can see what the verify stage removed and judge
   whether it is removing too much.
8. Overflow past the cap is reported, not dropped silently, matching how
   `scoutDropped` and `ceilingReached` already work in `tm-review-codebase.js`.

**Acceptance:** `npm test` green including `specs.test.mjs`,
`prompts-sync.test.mjs`, `render-path.test.mjs`, `effort-policy.test.mjs`; a
test that `must_fix_deduped` filters, dedups, and caps; a test that a refuted
finding does not appear in `mustFix`; one live `/tm-review-changes` run on a
real diff with the confirmed and refuted counts recorded in the PR body.

**Watch for:** the token cost is one worker dispatch per must-fix finding.
Record the real numbers on that live run. If the refuted rate comes back near
zero across two or three real runs, the stage is not paying for itself and
should be reconsidered rather than kept for symmetry.

### P2. Port the Verify stage to `tm-review-codebase`

**Why separate:** once P1 exists this is a mechanical repeat, and splitting
keeps P1 out of `size:L`. It is also a check on P1's design. If P1 got the
abstraction right, P2 is genuinely small. If P2 turns out large, P1's format
extension was wrong and that is worth knowing before it spreads further.

**Scope:** same seven surfaces from section 2, plus `collectSlotVals` and
`inferRole` cases for the new stage name. The area dimension means a finding
carries an `area`, so the dedup key gains it.

**Acceptance:** as P1, plus one live `/tm-review-codebase` run.

### P3. Auto-must-fix conditions in review prompts

**Why:** their critics carry deterministic caps that override the model's
holistic read (`HANDOFF.md` 5.1: a slab track-run caps the score at 6.0
regardless of everything else). Our `FINDING.severity` enum is pure model
judgment with no floor. We have rules that are already law here and already
objectively checkable, and none of them currently forces a severity.

**The conditions.** Every one is existing law in `.claude/process-core.md`.
This package adds no new policy, it only makes existing policy binding on the
severity field:

1. A test deleted, skipped, or weakened, without the PR body saying why.
2. `--no-verify`, or any bypassed git hook.
3. A new dependency with no justification in the PR body.
4. A CI job with no `timeout-minutes`, or a workflow with no `concurrency`
   group carrying `cancel-in-progress: true`.
5. A change touching the full stack, shipped without e2e.

**Why prompt text and not code:** a static check would be stronger for 2 and 4,
and that is a reasonable future issue. It is not this one. This package buys
most of the value for a prompt edit and no new machinery, and the survey's
point is about the severity floor, not about the detection method.

**Scope:** the shared review prompt text in both workflows (embedded `PROMPTS`
and the prompts JSON, kept in sync), the Hermes copy, and both
`reviewer.md` files (`.claude/agents/` and `.claude/adapters/prompts/`).

**Acceptance:** `npm test` green including `prompts-sync.test.mjs` and
`role-contract-sync.test.mjs`; the condition list appears identically in every
copy; a test asserts the list is present in each prompt surface, so a future
edit to one copy cannot silently drift.

### P4. Resume-before-respawn routing rule

**Why:** `land-round` section 5 and PROGRAM-STATE section 6 both say resume
first, respawn only if the transcript is unrecoverable, and give waiter-stalls
a finalize nudge rather than a fresh spawn. `tm-kickoff` has fix-round caps and
"never re-dispatch an unchanged prompt" but nothing for an agent that returns
empty or stalls, so today that lands as a fresh dispatch that throws away
context and repeats the work.

**Scope:** one routing rule in `.claude/skills/tm-kickoff/SKILL.md` section 3.

**It must say three things, or it will be misread:**
1. The order: SendMessage-resume first, fresh respawn only when the transcript
   is unrecoverable.
2. That it does **not** apply to the Opus-limit case directly above it. There
   the model has to change, so a resume fails the same way. That rule keeps
   priority.
3. That a resume does not violate "never re-dispatch an unchanged prompt". The
   resume message is new input; a resume with no new content is the thing that
   rule forbids.

**Acceptance:** the rule states all three; a reviewer pass confirms it does not
contradict the two neighbouring rules.

### P5. `LESSONS:` channel from run to curated docs

**Why:** their round reports end with "law discoveries for the bank", the packet
holds the raw record, and the orchestrator promotes generalizable ones into the
standard at landing. Two tiers, with promotion reserved to the orchestrator. We
have the curated tier (`docs/architecture/`, `.claude/process-core.md`) and the
per-package tier (issues), and no channel between them. The evidence that this
leaks is in our own `docs/`: the incident knowledge in
`docs/team-guide-rationale.md` and the postmortem-shaped content in
`docs/reviews/` all arrived by hand.

**Scope:**
1. An optional `LESSONS:` line in the tester and reviewer report contracts,
   in `.claude/agents/`, `.claude/adapters/prompts/`, and
   `docs/architecture/role-contracts.md`.
2. A step in `tm-kickoff` section 4 (wave end) collecting them into the wave
   report.

**Optional, not required, and the wording matters.** A required field produces
filler on every run. The line is for a generalizable process lesson, not a
restatement of the finding the agent just reported.

**Promotion stays human.** An agent editing `process-core.md` is precisely the
irreversible, outward-facing change the advisor model parks as `needs-human`.
The channel ends at the wave report.

**Acceptance:** `npm test` green including `role-contract-sync.test.mjs`; the
contract change appears in all three copies; the wave-end step names where
lessons surface and states that promotion is human.

## 6. Dropped, and why

**Survey candidate 5, sibling-invariant proof.** The idea: when a package
touches shared machinery, prove the untouched siblings are unchanged rather
than assert it. Deferred, for two reasons. It is speculative: no observed
failure motivates it. And P0 is arguably the first real instance of the class
it would catch, so P0 landing gives actual evidence about whether this recurs.
Revisit after P0.

The survey's own rejected list (`PROGRAM-STATE.md` as a resume handbook, the
brief-template-as-skill pattern, the `agent-docs` marker convention, the FIFO
browser lock, the tank-geometry skills, committed absolute paths) stays
rejected. Reasoning is in the survey, not repeated here.

## 7. Ready-to-file issue bodies

Fill the literal `Blocked by: #N` lines at filing time, once P0 and P1 have
numbers. Every issue gets its `size:` label from the table in section 4.

Each body should carry: the why paragraph from section 5, the scope list, the
acceptance criteria, and a `Part of #344` line. Where section 5 records a
decision between options, the issue states the recommendation and its reason,
so the architect's sub-plan either confirms it or argues against it rather than
re-deriving it from scratch.

P1's issue additionally carries the coupled-surface table from section 2. A
developer who does not know a stage touches seven surfaces will break
`specs.test.mjs` and lose a fix round to it.

## 8. Running this a second time with a different model

Use `/tm-ab-test`, not a freehand rerun. It forks both arms from one base
commit, runs them sequentially, records agent count, wall-clock, tokens, diff
size, and an independent review per arm, then appends a row to
`docs/reviews/ab-tests.md`. There is already a model-versus-model precedent in
that ledger (`2026-07-27-ab-judgment-seats.md`).

**Use P1 as the A/B subject, not the whole plan.** Reasons:

- P1 is the only package with real design judgment in it (the three-option
  format decision, the cap, the dedup key, whether the refuted appendix belongs
  in the report). The prose packages have close to one correct answer, so a
  model comparison on them measures wording preference, not judgment.
- One `size:M` package is a fair unit of work for a paired run. The full
  six-package batch is too big to run twice and too noisy to attribute.
- P1 has a hard, objective floor: `npm test` and seven coupled surfaces. An arm
  that skips a surface fails visibly rather than arguably.

**Suggested arms:** `A: opus-lead`, `B: <other-model>-lead`, both headless,
both from the P0-landed commit.

**Score on, in this order:** does `npm test` pass; are all seven surfaces
updated; which format option was chosen and was the reasoning stated; does the
refuted path actually work on a real diff; token cost. Take the better parts of
each rather than declaring one arm the winner. That is what the ledger's
headline-numbers column is for.

**One caution.** If both arms pick the same format option, that is weak
evidence it is right and strong evidence the recommendation in section 5.P1
anchored them. Consider running one arm from an issue body with the
recommendation stripped, so at least one arm decides cold.

## 9. Honest limits of this plan

- The refuted-rate argument for P1 rests on one data point from the source
  repo (10 of 24), on a different kind of artifact (game-visual findings, not
  code review findings). It is the best evidence available and it is not
  strong. P1's acceptance criteria record our own rate for exactly this reason.
- The source's loop never converged: seven rounds, averages 6.8 to 7.23, pass
  count stuck at 1-2 of 12 dimensions, stated exit condition never reached,
  final-judgment workflow written but never run. Nothing here should be
  justified by "it worked for them", because as a whole it did not.
- P3 and P1 interact in cost and the wave plan handles it by ordering, not by
  measurement. If must-fix volume jumps more than expected after P3, P1's cap
  is the lever.
- Sizing is estimated, not measured. P1 is the one most likely to be wrong, and
  it is the one with a documented split point (P2) if it runs long.
