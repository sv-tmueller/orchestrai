# Plan-downgrade runbook (Max to Pro and back)

## Scope

This runbook documents an existing lever, not a new one. Moving the team
between the Max and Pro Claude subscription tiers uses the lead-session
fallback already defined in `.claude/team-guide.md`, "Model policy". Nothing
in the machinery changes: no agent frontmatter pin moves, no skill or
workflow file changes, no new config lever is introduced. This is a
procedure for a human decision (downgrade to Pro, or revert to Max), not a
mechanism the team runs on its own.

## What changes on Pro

Facts below are verified 2026-08-02.

- Fable 5 is not plan-included on Pro. It bills as pay-as-you-go usage
  credits on top of the Pro subscription. The plan-included promo for Fable 5
  ended 2026-07-19.
- Opus 5 and Sonnet 5 are both available on Pro, including inside Claude
  Code. Neither needs a separate credit purchase.
- Weekly usage is one shared pool across claude.ai and Claude Code. A chat
  session in claude.ai draws down the same pool as a Claude Code run.

The practical consequence: running the lead on Fable 5 under Pro means every
lead-session token is metered, on top of the subscription price, with no
plan-included allowance left to absorb it. Opus 5 and Sonnet 5 carry no such
metering on Pro.

## Downgrade steps (Max to Pro)

1. Flip the lead session: `/model claude-opus-5`. This is the same
   lead-session fallback the Model policy already documents for a
   Fable-unavailable event; a plan downgrade is just a different trigger for
   the same switch.
2. Run that command at the start of each lead session. Whether `/model`
   persists a choice across sessions is not verifiable from the docs in this
   repo, so treat the flip as a per-session step rather than a one-time
   setting.
3. Touch no frontmatter pin. `architect` and `reviewer` keep `model: opus` in
   their frontmatter either way; `developer`, `tester`, `fact-checker`,
   `docs-writer`, and `perf-investigator` keep `model: sonnet`. None of that
   changes on Pro.
4. Stop routing anything to Fable. The kickoff routing rules include a
   per-call Fable override for a judgment-seat dispatch under Opus quota
   pressure (`.claude/skills/tm-kickoff/SKILL.md`); that override assumes
   Fable is plan-included, which is not true on Pro, so do not invoke it
   while on Pro. For what a judgment-seat dispatch falls back to instead,
   see `.claude/team-guide.md`, "Model policy" (not restated here, since a
   sibling change to that section is in flight).

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

1. Flip the lead session back: `/model claude-fable-5`.
2. Restore the standard caps: up to 6 packages per batch, 3 in flight.
3. Log the change (dates, reason, any packages parked and resumed) wherever
   the batch or session tracked the downgrade, so the history is visible to
   the next session.

## Relationship to the cost-based fallback trigger

The cost-based fallback trigger in `.claude/team-guide.md`, "Model policy",
governs a different event: Fable 5 losing its plan-included status under an
unchanged Max plan, which calls for measuring the lead's actual $/session
cost before deciding whether to keep Fable or move to Opus permanently. A
voluntary downgrade to Pro is not that event, it is a decided move the human
already made, so the already-documented lead-session fallback applies
directly and no separate measurement step gates it.
