# Plan-downgrade runbook (Max to Pro and back)

## Scope

Since issue #380, Opus is the default lead on every plan tier, so there is
no lead-session fallback left to flip when moving between Max and Pro: the
lead already runs the same model either way. What this runbook still
covers is Fable's own Max-vs-Pro availability difference, relevant only if
a user chooses Fable for the main window (`.claude/team-guide.md`, "Model
policy"), and the batch-pacing recommendation below. Nothing in the
machinery changes: no agent frontmatter pin moves, no skill or workflow
file changes, no new config lever is introduced. This is a procedure for a
human decision (downgrade to Pro, or revert to Max), not a mechanism the
team runs on its own.

## What changes on Pro

Facts below are verified 2026-08-02.

- Fable 5 is not plan-included on Pro. It bills as pay-as-you-go usage
  credits on top of the Pro subscription. The plan-included promo for Fable 5
  on Pro ended 2026-07-19. Fable 5 stays plan-included on Max; this promo end
  is a Pro-only fact and does not touch the Max plan.
- Opus 5 and Sonnet 5 are both available on Pro, including inside Claude
  Code. Neither needs a separate credit purchase.
- Weekly usage is one shared pool across claude.ai and Claude Code. A chat
  session in claude.ai draws down the same pool as a Claude Code run.

The `opus` alias has since moved to a newer Opus (Opus 5.5, confirmed
2026-09-23). Its Pro availability has not been re-verified since the
2026-08-02 facts above, so re-check it before relying on this runbook.

The practical consequence, as of 2026-08-02: running the lead on Fable 5
under Pro means every lead-session token is metered, on top of the
subscription price, with no plan-included allowance left to absorb it.
Opus 5 and Sonnet 5 carry no such metering on Pro.

## Downgrade steps (Max to Pro)

1. Nothing to flip on the lead. Opus is the default lead on both tiers
   (issue #380); there is no fallback command to run at the start of a
   session anymore.
2. Touch no frontmatter pin. `architect` and `reviewer` keep `model: opus` in
   their frontmatter either way; `developer`, `tester`, `fact-checker`,
   `docs-writer`, and `perf-investigator` keep `model: sonnet`. None of that
   changes on Pro.
3. If the main window is on Fable, know the cost. That is the user's own
   choice (`.claude/team-guide.md`, "Model policy"), not something this
   runbook or the machinery flips; Fable is not plan-included on Pro (see
   "What changes on Pro" above) and meters as usage credits instead.

## Working under Pro limits

Recommendation: run roughly 3 packages per batch, 2 in flight, instead of the
standard up-to-6-per-batch, 3-in-flight default (`.claude/team-guide.md`,
"Operating model (advisor)"). This is an unmeasured starting point, a
conservative halving, not a measured Pro capacity number. Tighten or loosen
it against what actually happens in a batch or two.

Other things that matter while on Pro:

- The session-hygiene rule (`.claude/team-guide.md`, Workflow defaults;
  rationale in `docs/team-guide-rationale.md`) matters more, not less, on
  Pro: a bloated lead session burns pool budget shared with everything else.
- claude.ai chat use competes for the same weekly pool as Claude Code. A
  heavy chat session before a kickoff run eats into the same budget.
- Symptom: limit errors mid-wave. Response: park the in-flight package as
  `needs-human` and resume it in the next weekly window. Do not retry into
  the same limit.

## Revert steps (Pro to Max)

1. Nothing to flip on the lead; Opus stays the default. If the main window
   was switched to Fable for the Pro stint, flip that back to whatever the
   user wants on Max.
2. Restore the standard caps: up to 6 packages per batch, 3 in flight.
3. Log the change (dates, reason, any packages parked and resumed) wherever
   the batch or session tracked the downgrade, so the history is visible to
   the next session.

## Relationship to the cost-based fallback trigger

The cost-based fallback trigger in `.claude/team-guide.md`, "Model policy",
is superseded: the lead already defaults to Opus, decided by the
2026-09-23 lead-model comparison's own decision rule (comparable quality,
lower cost), not by a confirmed Fable-billing trigger condition
(`docs/reviews/2026-09-23-lead-model-comparison.md`, section 7). A
voluntary downgrade to Pro does not reopen that trigger; it only affects
whether Fable, if a user chooses it for the main window, is plan-included
or metered (see "What changes on Pro" above).
