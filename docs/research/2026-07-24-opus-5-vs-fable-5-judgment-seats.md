# Opus 5 vs Fable 5 for the lead, architect, and reviewer seats - 2026-07-24

A recommendation, not a policy change. Related: issue #264. Nothing here
edits `.claude/team-guide.md`, any agent frontmatter, or any workflow stage.

## 1. Question and scope

With Opus 5 released, should the orchestrator (lead), architect, and
reviewer seats stay on Fable 5, or move to Opus 5? These three are the
Model policy's "judgment" seats: the lead session itself, plus the two
`fable`-pinned role agents (`architect.md`, `reviewer.md`) and, by
extension, the three workflow critic stages that also pin `fable`
(`tm-review-changes.js`, `tm-review-codebase.js`, `tm-map-codebase.js`).

In scope: one recommendation with a stated confidence level, grounded in
this repo's own measured burn data and current published pricing.
Out of scope: the Sonnet-pinned worker seats, the `xhigh` effort ceiling,
any live A/B run (no `tm-ab-test` execution), and any actual edit to the
Model policy, frontmatter, or workflow scripts. A follow-up issue would
carry out any change this document recommends.

## 2. What the current policy rests on

`.claude/team-guide.md`, Model policy, as of this session:

> Fable 5 (`claude-fable-5`) at xhigh effort. Affordable only because the
> lead stays on the bounded tm- machinery. Fable costs 2x Opus 5 per
> token. The premium is bounded in aggregate, not per batch
> (docs/research/2026-07-06-token-burn-investigation.md, driver 3).

Note on that quote: issue #263 landed on this same branch while this
document was being written and renamed the fallback model throughout
`team-guide.md` from Opus 4.8 to Opus 5 (a stale comparison target, not a
dollar-math error). The line above already reflects that edit; earlier
drafts said "2x Opus 4.8 per token." Opus 4.8 and Opus 5 are priced
identically ($5/$25 per MTok, section 4), so the "2x" figure is unchanged
by the rename.

Two things to hold apart when reading "affordable":

- It is a **Max-plan subscription quota claim**, not a dollar claim. The
  policy's own "Cost-based fallback trigger" bullet says as much: if
  Fable 5 ever moves off the Max-plan subscription to metered API
  billing, "measure the lead's actual $/session cost at API rates first,"
  rather than assuming the quota reasoning still applies.
- "Bounded in aggregate, not per batch" is a scope claim, backed by one
  finding (section 4): Fable's token share is small across 14 days and 25
  projects, but not small inside a single kickoff batch.

## 3. Options

Three concrete seat assignments, not general positions.

- **(a) Stay on Fable everywhere.** Lead, architect, reviewer, and all
  three workflow critics stay `fable`. The status quo.
- **(b) Move all three seats to Opus 5.** Lead switches its session model;
  `architect.md`/`reviewer.md` frontmatter and the three critic stages
  flip `model: fable` to `model: opus`.
- **(c) Split: lead moves to Opus 5, architect/reviewer/critics stay on
  Fable 5.** Priced in section 4, justified in section 8.

A fourth combination (architect/reviewer to Opus 5, lead stays Fable) was
rejected as a candidate: section 7 shows the frontmatter/critic-stage move
is the one blocked by today's failing effort-policy test, while the
lead's own model is not test-pinned at all. Leading with the change that
needs no code fix first is the lower-risk split.

## 4. Cost, from this repo's numbers

Three scopes, in order of how much of the pipeline they cover.

**14-day, 25-project aggregate.** From
`docs/research/2026-07-06-token-burn-investigation.md` section 4/5:
Fable's raw token share is 5.5%, its weighted-proxy-dollar share is 18.7%.
Lead attribution alone (section 3) accounts for 1,105,250 input /
9,757,736 output / 41,496,802 cache_creation / 1,156,442,742 cache_read
across 4,535 deduped lines, "more than half of all buckets except
cache_creation" - the single largest attribution bucket in the dataset.

**Single batch (#201).** Same doc, section 5, driver 3: at batch scope,
Fable-priced roles (lead + architect + reviewer) flip to 57.5% of raw
tokens and 93.3% of weighted-proxy dollars, against Sonnet-priced roles
(developer + tester) at 42.5% raw / 6.7% weighted. This is the finding the
"bounded in aggregate, not per batch" policy line already cites.

**Single package.** `docs/reviews/2026-07-13-ab-plan-status-parser.md`,
Arm A (full kickoff pipeline): weighted cost $7.55, of which $6.44 is
Fable-priced (85.3%) and $1.11 Sonnet-priced. Arm B (developer-only
dispatch, no architect/reviewer): $1.80. Ledger row:
`docs/reviews/ab-tests.md`.

**Mandatory price correction.** `docs/research/2026-07-06-token-burn-analyze.mjs`
lines 63-77 weight all four scopes above using historical list-price
tiers: `OPUS_INPUT = 15`, `OPUS_OUTPUT = 75`, Sonnet `3`/`15`, with Fable
set to 2x that Opus figure (`30`/`150`). Current published pricing (bundled
`claude-api` skill, `shared/models.md`, which self-describes as cached, not
live, at line 7, with no embedded cache date): Opus 5 `claude-opus-5` $5/$25
per MTok, Fable 5 `claude-fable-5` $10/$50, Opus 4.8 `claude-opus-4-8` $5/$25
(still active). That file carries no Sonnet 5 pricing at all
(`grep -n '\$' shared/models.md` returns only the Fable 5 and Opus 5 lines);
Sonnet 5's $3/$15 comes from `shared/model-migration.md:1192` ("unchanged at
the $3/$15 sticker"), `python/claude-api/README.md:502`, and this repo's own
`docs/reviews/2026-06-30-orchestration-comparison.md:126-129` ("Corollary":
Sonnet $3/$15 vs Opus 4.8 $5/$25, checked 2026-06-30). Those three sources
agree with each other on Sonnet, and the last also agrees with
`shared/models.md` on Opus 4.8's $5/$25.

The Sonnet leg of the proxy table ($3/$15) already matches current
pricing exactly, but the Opus/Fable leg does not: at the proxy table,
Opus is 5x Sonnet's input price ($15 vs $3); at current prices, Opus is
1.67x ($5 vs $3), i.e. Sonnet is 1/5 of Opus in the proxy and 3/5 of Opus
now. **Every dollar figure quoted above (18.7%, 93.3%, $7.55, $6.44)
overstates the Fable/Opus share relative to current pricing.** Naively
rescaling one of those figures (dividing $6.44 by some factor) is not
done here: the single-package report only publishes already-weighted
dollars, not the raw per-model token counts a correct re-derivation
needs. Batch #201's driver-3 finding is different: it publishes the raw
split itself (57.5%/42.5%), so it can be re-derived.

**The counterfactual, worked from batch #201's raw split.** Assumption
named up front: a uniform bucket mix across role classes (input, output,
cache_creation, cache_read tokens in the same relative proportion for
Fable-priced and Sonnet-priced roles), since per-role, per-bucket splits
were never published for that batch. Under that assumption:

- Raw split: 57.5% Fable-priced tokens, 42.5% Sonnet-priced.
- Fable is 3.33x Sonnet at current prices ($10/$50 vs $3/$15, both
  directions), against the proxy table's implied 10x.
- Fable-priced share of weighted spend at current prices:
  `(0.575 x 3.33) / (0.575 x 3.33 + 0.425)`, roughly 80-85%, down from the
  proxy's 93.3%. Not stated to two decimals; the uniform-mix assumption
  does not support that precision.
- Opus 5 is exactly half of Fable 5's price in both directions, so
  replacing every Fable-priced seat with Opus 5 halves that slice's dollar
  contribution. Cutting an ~80-85% slice in half cuts total batch-level
  spend by roughly 40-42.5%.

That range is the ceiling for option (b) (all three seats moved), at
batch scope, in dollars, not confirmed Max-plan quota. It reuses
`2026-07-06-token-burn-analyze.mjs`'s own published numbers plus the
price correction above; no new analysis script was written.

**Pricing option (c).** Batch #201's driver-3 finding reports lead +
architect + reviewer as one combined group; it does not publish how much
of that 57.5%/93.3% the lead alone accounts for. The best available
proxy is the 14-day aggregate's attribution table, where lead alone is
more than half of nearly every bucket across the whole dataset (a
different scope, not batch #201's role split), so it is directional
evidence that lead is plausibly the majority of the Fable-priced group,
not a number to plug into the formula above. Option (c)'s savings are
therefore real, bounded above by the same 40-42.5% ceiling, and smaller if
architect and reviewer carry a non-trivial share. Pricing it more
precisely would need a role-scoped re-run of the token-burn script
against a fresh batch (section 9).

## 5. Availability and operating cost

During this batch, two judgment-seat dispatches failed with `You've
reached your Fable 5 limit`, each forcing a per-call Opus override (the
Agent tool's `model` param, per the documented fallback procedure). Both
events, with the exact error string, are recorded on batch issue #262
alongside the decision to use the per-call override; that issue is the
auditable record, since this document's sandbox has no GitHub access or
session transcript to re-derive the claim from. Cross-referenced against
commit `11003f9` ("docs: document per-call Opus override for a single
Fable-blocked seat", #228, verified with `git show 11003f9`): that commit
exists because the same workaround already had to be written down once
before, in a prior batch. Two events across two separate occasions is a
recurrence, not a first; it is not a measured failure rate, and this
document does not treat it as one.

Two standing costs from the pricing source (`claude-api` skill,
`shared/models.md`):

- Fable 5 requires 30-day data retention (not available under
  zero-data-retention). A policy cost the current assignment already
  pays, independent of anything measured here.
- Opus 5 sits in a rate-limit bucket separate from the combined Opus 4.x
  pool, so an Opus 5 primary with an Opus 4.8 fallback would be two
  independent capacity pools, not one pool with a within-family fallback.
  Whether that is a net resilience gain over the current Fable-primary,
  Opus-4.8-fallback arrangement is not established here; both
  arrangements already cross model families for their fallback.

Opus 5's prompt-cache minimum dropped to 512 tokens (from 1024 on
Opus 4.8), but this repo's own measured bootstrap contexts run
12k-22k tokens (driver 1 of the token-burn investigation), so that
change is marginal here and does not support the recommendation below.

## 6. Capability

No first-party comparison of Opus 5 against Fable 5 on this repo's own
judgment tasks (sub-plans, PR reviews, codebase-review critiques) exists.
The only capability signal is vendor positioning, the weakest evidence
class, quoted and labeled as such: `shared/models.md` describes Opus 5 as
"a step-change over Claude Opus 4.8... at half the cost of Claude Fable 5
(Claude Fable 5 remains the highest-capability tier)," and separately
calls Fable 5 "Anthropic's most capable widely released model." Taken at
face value, the vendor's own framing puts Fable 5 above Opus 5 on
capability, arguing against moving the judgment seats for quality
reasons, not for it. This repo's `docs/team-guide-rationale.md` DeepSWE
leaderboard note ("Fable 5 at max scores the same as at high... Sonnet 5
at max is dominated by Fable 5") compares effort levels and Sonnet
against Fable, not Opus 5 against Fable, so it does not bear here.

## 7. Change surface and prompt rework

Full inventory, `grep -rn "fable\|Fable" .claude/ docs/`: `architect.md`
and `reviewer.md` frontmatter (`model: fable` plus a fallback comment
naming Opus), the three workflow critic stages
(`tm-review-changes.js:146`, `tm-review-codebase.js:248`,
`tm-map-codebase.js:236`), the three `SKILL.md` files describing the
critic as Fable, and `team-guide.md`/`team-guide-rationale.md` as the
policy's own prose (an edit site for any future change, not touched here).

**Flag prominently:** `.claude/workflows/__tests__/effort-policy.test.mjs:21`
defines `EFFORT_BY_MODEL = { sonnet: 'high', fable: 'xhigh' }` with no
`opus` key. Read against the test body (lines 37-61): flipping any
frontmatter or workflow-stage `model:` to `opus` fails with "pins model
'opus', which has no effort rule." The documented Fable-outage fallback
(flip the pins to `opus` for a longer outage) is blocked by this repo's
own test today. This is real rework, not a hypothetical: option (b), and
the architect/reviewer half of option (c) if ever extended, cannot ship
until a follow-up issue adds an `opus` entry to `EFFORT_BY_MODEL`. That
follow-up is not done in this package.

One consequence worth flagging, verified directly: the same
`shared/models.md` alias table (lines 116-134) maps the bare alias
"opus" to `claude-opus-5`, not `claude-opus-4-8`. If Claude Code's own
frontmatter `model: opus` resolves through the same alias table (not
independently confirmed, but the two systems share Anthropic's model
naming), the documented Fable-outage fallback would already land on
Opus 5 today (section 2 notes the mid-session #263 rename that makes the
prose track this). Worth reconciling in the same follow-up that adds the
`opus` effort-policy entry.

Prompt rework specific to any Opus 5 shift, tied to each documented behavior
change (`claude-api` bundled skill, `shared/model-migration.md`, "Migrating
to Claude Opus 5" > "Behavioral shifts (prompt-tunable)", lines 1029-1098; a
vendor migration guide, the same weakest evidence class as section 6):

- **Longer default output.** `reviewer.md`'s report contract fixes
  structure (`VERDICT`/`STAGE`/`FINDINGS`) but sets no length bound. A
  longer-by-default reviewer inflates every fix-round input and PR
  comment; worth a length hint if reviewer moves.
- **Self-verification without being asked, distinguished carefully.**
  Self-check scaffolding aimed at a model's own output can become
  redundant if the model already double-checks itself. That does not
  apply to the workflow critic's consolidation step: `tm-review-changes.js:145`
  instructs the critic to "verify it against the actual diff" for the
  *parallel Sonnet reviewers'* raw findings, not the critic's own work. A
  doc that told a maintainer to strip that instruction because "the model
  self-verifies now" would remove a real cross-check on other agents, not
  redundant scaffolding. Do not remove it.
- **Readier delegation, priced as a lead-seat risk.** `architect.md`/
  `reviewer.md` have no Task tool, so those two seats are structurally
  bounded regardless of model. The lead is not, and the lead is where the
  one measured over-spawn failure in this repo's history came from
  (`docs/reviews/2026-06-30-orchestration-comparison.md` addendum: an
  unpinned, unbounded construction reached 297 agents and about 5.64M
  subagent tokens over ~51 minutes and died on an organization-wide spend
  cap, against the bounded arm's 9). That trial ran Sonnet 5, not Opus 5,
  so it is evidence about unbounded construction risk in general, not a
  measured Opus 5 spawning rate. If the lead moves to Opus 5, an explicit
  delegation cap is the mitigation this risk calls for, not a general
  policy change.
- **Task-scope expansion.** Hits `architect.md`'s advisory role and
  collides with `reviewer.md`'s pass-1 rule that "scope creep... [is a]
  blocking finding, even when the extra code is good." Watch for this
  before trusting either seat unsupervised on a new model.
- **Effort ceiling.** No change needed: Opus 5's effort ladder runs
  through `max`, so `xhigh` (this policy's ceiling) is already available.

## 8. Recommendation and confidence

**Move the lead seat from Fable 5 to Opus 5 now (`/model claude-opus-5`);
leave architect, reviewer, and the three workflow critic stages on
Fable 5 until the effort-policy test gains an `opus` tier in a follow-up
issue. Confidence: medium.**

This is option (c), not (b): a full move is blocked today by a real,
verified test failure (section 7), and the vendor's own capability claim
(section 6) argues against moving the two structurally-bounded judgment
seats for quality reasons alone. The lead-only move is not blocked by
that test (the lead's model is not frontmatter-pinned or asserted
anywhere in `npm test`), captures a real and potentially majority share
of the available savings (lead is the single largest token consumer in
this repo's own aggregate data, section 4), and its blast radius is
contained: per `docs/reviews/2026-06-30-orchestration-comparison.md`'s
Corollary, the pipeline pins architect and reviewer regardless of which
model leads, so a lead-model change affects only the lead's own direct
judgment work (scoping, parking decisions, un-delegated writing), not the
review or sub-plan quality the pipeline already guarantees through
Fable-pinned subagents.

What caps this at medium rather than high: the precise dollar/quota
savings from moving the lead alone are bounded (up to the 40-42.5%
batch-level ceiling in section 4) but not pinned, since driver-3 does not
publish a lead-only breakdown; "affordable" in the current policy is a
Max-plan quota claim, and nothing here measures whether Opus 5's lower
per-token price actually buys more quota; the two Fable-limit events are
a recurrence, not a measured rate, so the availability case is real but
modest; and Opus 5's own spawning tendency as a lead is unmeasured
(section 7's only data point is a Sonnet 5 trial).

## 9. What would have to be true to revisit

**To extend the move to architect, reviewer, and the critics:** the
effort-policy test gains an `opus` tier (a follow-up issue, not this
package); a repo-scoped comparison (a `tm-ab-test` run per role, since
none has run yet) shows Opus 5's judgment output on this repo's own
sub-plans or reviews holds up against Fable 5's, not just against vendor
positioning; or Fable-limit exhaustion events recur often enough to look
like a rate rather than two isolated incidents.

**To revert the lead-only move:** the lead's own scoping and parking
decisions visibly degrade on Opus 5, traceable to real batch outcomes
(missed scope calls, more parked `needs-human` items than before); a
measured Max-plan quota check (per the existing "Cost-based fallback
trigger" bullet) shows Opus 5's lower dollar price does not translate
into lower quota consumption for the lead seat; or Opus 5 shows the same
unbounded-delegation tendency the addendum measured for Sonnet 5, without
the recommended delegation cap in place.

## 10. Sources and limitations

- `docs/research/2026-07-06-token-burn-investigation.md` (sections 3, 4,
  5) and its script, `docs/research/2026-07-06-token-burn-analyze.mjs`
  (lines 55-87).
- `docs/reviews/2026-07-13-ab-plan-status-parser.md` and
  `docs/reviews/ab-tests.md`.
- `docs/reviews/2026-06-30-orchestration-comparison.md` (Corollary,
  addendum, and the $3/$15 vs $5/$25 pricing cross-check).
- `claude-api` bundled skill: `shared/models.md` (self-described as cached,
  not live, at line 7, no embedded cache date; recommends the Models API for
  anything capability-related, which this document did not run);
  `shared/model-migration.md:1192` (Sonnet 5 pricing) and its "Migrating to
  Claude Opus 5" > "Behavioral shifts (prompt-tunable)" section, lines
  1029-1098 (section 7's behavior-shift claims, a vendor migration guide,
  the same weakest evidence class as section 6's capability claims);
  `python/claude-api/README.md:502` (Sonnet 5 pricing).
- `.claude/team-guide.md`, `docs/team-guide-rationale.md`,
  `.claude/agents/architect.md`, `.claude/agents/reviewer.md`,
  `.claude/workflows/tm-review-changes.js`,
  `.claude/workflows/__tests__/effort-policy.test.mjs`, and commit
  `11003f9`, all read directly for this document.

Limitations: the price correction in section 4 is arithmetic, not a
re-run against real transcripts (transcripts were not reachable from this
worktree); the batch #201 and single-package dollar figures both predate
current pricing and were not independently re-derived beyond the one
worked example; capability evidence is vendor-only; and the two
availability events are anecdote, explicitly not a rate.
