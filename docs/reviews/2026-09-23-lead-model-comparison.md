# Lead model comparison: Fable 5.1 vs Opus 5.5 - 2026-09-23

Issue #358, batch #356. Pre-registered protocol:
[2026-09-23-lead-model-comparison-protocol.md](2026-09-23-lead-model-comparison-protocol.md).
Per-run data, judge scores, and hashes:
[2026-09-23-lead-model-comparison-data.json](2026-09-23-lead-model-comparison-data.json).
Not a `/tm-ab-test` run: no scratch issue, no `ab-tests.md` row.

## 1. Bottom line

**Comparable quality, recommend Opus 5.5 for the lead seat on cost, at low
confidence** under the pre-registered decision rule: the two arms' mean
judge scores are 19.0 (Fable) and 19.67 (Opus), 0.67 points apart out of 20,
inside the rule's 2-point "comparable" band, and Opus 5.5's mean cost per
valid run ($2.20) is well under half of Fable 5.1's ($4.88).

That recommendation carries one open question this trial could not close: a
Fable run (F3) failed on an API 429, "You've hit your individual spend
limit," after the two prior Fable runs. `apiKeySource` read `none` (not a
literal API key) on every one of the six launches, which is what the
protocol's hard gate checks, so the gate never fired and the trial
continued to O3 as scheduled. But this repo's own
`docs/operations/plan-downgrade-runbook.md` documents that Fable bills as
metered usage credits on Pro once its plan-included promo ended, while
staying plan-included on Max, and `apiKeySource: none` does not distinguish
the two. Nothing available inside this trial's tool allowlist, or inside its
budget, can confirm which subscription tier the account was on when F3
failed. If it was Pro, the Fable arm's dollar figures above are close to
real invoiced cost, not quota; if Max, they are quota consumption at list
prices with no direct dollar meaning. Section 7 lays out what is and is not
resolved. This is flagged as a concern for the tester, not smoothed over.

## 2. The policy lines at BASE

`.claude/team-guide.md`:

- L115: "Fable 5 in the one seat nothing backstops (the lead), Opus 5 at
  xhigh in the backstopped judgment seats (architect, reviewer, workflow
  critics), efficient workers everywhere else."
- L122-125: "Orchestrator (the lead session, including `/tm-advisor` and
  `/tm-kickoff`): Fable 5 (`claude-fable-5`) at xhigh effort. Affordable
  only because the lead stays on the bounded tm- machinery. Fable costs 2x
  Opus 5 per token. The premium is bounded in aggregate, not per batch."
- L147-151: the cost-based fallback trigger, "if Fable 5 stops being
  included under the Max-plan subscription and shifts to metered API
  billing, do not switch to Opus automatically. Measure the lead's actual
  $/session cost at API rates first, then decide whether to keep Fable or
  move to Opus 5 permanently, logging the decision and cost here."

`docs/team-guide-rationale.md` L82-89 ("Cost-based fallback trigger: why it
is quota, not dollars"): "The 'affordable' reasoning behind the
orchestrator's model choice is weighed against Max-plan quota, not real
dollars, so it stops applying the moment billing changes to metered API
rates." Section 1's open question is exactly whether that premise held
during this trial.

`docs/research/2026-07-24-opus-5-vs-fable-5-judgment-seats.md` recommended
moving the lead to Opus 5 (medium confidence) on 2026-07-24; its
2026-08-03 addendum records the opposite path actually shipped (architect,
reviewer, and the critics moved to Opus; the lead stayed on Fable). This
trial is the first repo-scoped comparison run against that specific,
still-open recommendation, using today's models (Fable 5.1, Opus 5.5) and a
pre-registered rubric instead of the single illustrative paired run
`docs/reviews/2026-07-27-ab-judgment-seats.md` used for the judgment seats.

## 3. Prices

Sources (both retrieved 2026-09-23, WebFetch):

- Model pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Models overview (IDs and aliases):
  https://platform.claude.com/docs/en/about-claude/models/overview

| Model | Input | 5m cache write | 1h cache write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5.1 (`claude-fable-5-1`) | $10 | $12.50 | $20 | $0.25 (0.025x) | $50 |
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 | $5 | $8 | $0.20 (0.05x) | $20 |
| Claude Opus 5 (`claude-opus-5`) | $5 | $6.25 | $10 | $0.50 (0.1x) | $25 |
| Claude Sonnet 5 (`claude-sonnet-5`, the judge) | $2 | $2.50 | $4 | $0.20 (0.1x) | $10 |

All per MTok. `costBasis: "list"` on every run's `modelUsage` block confirms
the CLI itself priced each run at these same list rates; one run's cost is
independently recomputed in section 5.

**Does the team-guide's "2x" hold?** Fable 5.1 vs Opus 5 (the pair the 2x
line describes) is exactly 2x on input and output ($10/$5, $50/$25). Fable
5.1 vs Opus 5.5 (the pair this trial actually runs, since Opus 5.5 is the
current `opus`-alias model) is 2.5x on input and output ($10/$4, $50/$20).
The 2x figure is stale for the model actually in the judgment seats today;
issue #357 (version-neutral model refs, part of the same batch) is the
right place to correct it, keeping the ratio dated as #357's own scope
already asks for.

**Measured ratio in this trial:** Fable's mean cost per valid run ($4.88)
is 2.22x Opus's ($2.20), below the 2.5x list ratio. The gap: cache-read
tokens dominate every run's token count, and cache reads price close to
each other in absolute terms across the two models ($0.25 vs $0.20 per
MTok, a 1.25x spread) even though their cache-read *multipliers* differ
(0.025x vs 0.05x of a base price that itself differs 2.5x). Output and
cache-write tokens, the buckets that carry the full 2.5x spread, are a
minority of every run's total tokens (see section 5's table).

**Max plan and Fable availability**
(https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan,
retrieved 2026-09-23): "Fable 5 and Fable 5.1 are included as a standard
part of your plan" on Max; on Pro, "Fable 5 and Fable 5.1 aren't included in
your plan's usage limits. You can use them with usage credits." The same
article: Fable models "draw from your plan's regular weekly usage limits
and use them faster than other Claude models," with no published
multiplier. https://claude.com/pricing (retrieved 2026-09-23) only says Max
includes "More Claude models" over Pro, without naming Fable specifically.

## 4. Method

- **Task:** the lead runs `/tm-advisor` sections 1 (Refine) and 2 (Propose)
  on issue #355, headless, read-only, single turn, stopping at the sign-off
  block. Full prompt in the protocol file.
- **BASE:** `1730257e1d979bda7cd60967012165d8a4b236d1` (origin/main HEAD,
  pinned via `git ls-remote` before any run).
- **Snapshot:** `_snapshot/issues-open.json` and `_snapshot/prs-open.json`,
  captured 2026-09-23T08:16:47Z, with #356, #357, #358, and PR #359
  (`Closes #357`) removed. Frozen; `gh` was unreachable from every run
  (`GH_CONFIG_DIR` pointed at an empty directory; `gh auth status` there
  reports "You are not logged into any GitHub hosts").
- **Write-blocking layers:** `--disallowedTools` on `Edit`, `Write`,
  `NotebookEdit`, `Skill`, `AskUserQuestion`, `WebFetch`, `WebSearch`,
  `Bash(gh *)`, `Bash(git commit *)`, `Bash(git push *)`,
  `Bash(git remote *)`, `Bash(curl *)`; `--allowedTools` limited to `Read`,
  `Grep`, `Glob`, `Agent`, `Task`, and read-only `git`/shell patterns; each
  run's own disposable copy of the repo (never the developer's checkout);
  no GitHub credentials reachable.
- **Run order:** F1, O1, F2, O2, F3, O3, strictly sequential, one process at
  a time, each launched only after the previous one's commit landed.
- **CLI:** `/opt/homebrew/bin/claude` v2.1.280 (not the `claude` alias),
  `CLAUDE_CONFIG_DIR=$HOME/.claude-work`, `env -i` clearing the parent
  session's own environment.
- **Effort:** `xhigh` on every lead run and the judge.
- **`apiKeySource`:** `none` on every one of the six lead launches and the
  judge (no `ANTHROPIC_API_KEY` was ever set; the CLI used the logged-in
  Claude subscription). This is the literal signal the protocol's hard gate
  checks; section 7 covers what it does and does not prove.
- **Protocol timing:** the protocol file was committed and pushed at
  `191c110` (2026-09-23T10:23:06+02:00 = 08:23:06Z), before F1's start
  (08:24:21Z). No later commit edited the protocol file.
- **A real filesystem-jail gap, found during the runs, not designed for:**
  the read-only tools (`Glob`, `Grep`, `Read`) are not confined to the
  cloned repo directory. F1 and O1 both read files under
  `~/.hermes/skills/` and `~/.hermes/plugins/` outside the clone (visible in
  their raw logs). This never produced a write (the disallow list still
  held) and both models' own outputs treat those reads as informational
  context about the real Hermes install, not the frozen BASE state, but the
  "frozen inputs" isolation was less complete than the protocol describes.
  Recorded as a limitation (section 10), not corrected mid-trial per the
  freeze rule.
- **Session bootstrap noise:** `CLAUDE_CONFIG_DIR=$HOME/.claude-work` is the
  developer's own live config directory, so every run's `init` event lists
  dozens of unrelated plugins and skills (solvvision-servicenow,
  cowork-plugin-management, anthropic-skills, and more) alongside
  orchestrai and superpowers. `Skill` is disallowed, so none of this could
  be invoked, but it is part of every run's system prompt and token count,
  identically across both arms, so it is a shared confound rather than an
  arm-specific bias.

## 5. Per-run table

Tokens in thousands (K), from each run's own `result.usage`; no run spawned
a subagent (`spawn_count: 0` throughout), so lead-only equals total.

| Run | Model | Input | Cache write (1h) | Cache read | Output (of which thinking) | Cost (list) | Wall | Turns | Score |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Fable 5.1 | 258 | 155.6K | 514.5K | 33.6K (24.2K) | $4.9253 | 7m33s | 49 | 18/20 |
| O1 | Opus 5.5 | 46 | 142.6K | 1,916.6K | 59.6K (46.7K) | $2.7167 | 9m50s | 49 | 20/20 |
| F2 | Fable 5.1 | 354 | 129.4K | 963.2K | 40.2K (27.7K) | $4.8429 | 9m01s | 62 | 20/20 |
| O2 | Opus 5.5 | 34 | 96.1K | 1,150.3K | 48.8K (38.3K) | $1.9748 | 7m38s | 36 | 19/20 |
| F3 | Fable 5.1 | 322 | 83.0K | 492.1K | 11.3K (6.5K), then a 429 | $2.3530 | 3m02s | 50 | **invalid, not scored** |
| O3 | Opus 5.5 | 44 | 94.3K | 1,523.8K | 42.6K (32.1K) | $1.9110 | 7m24s | 38 | 20/20 |
| Judge | Sonnet 5 | 102 | 208.0K | 6,153.9K | 80.3K (68.8K) | $2.8660 | 15m05s | 70 | n/a |

None of the 5 valid outputs were budget-capped (`--max-budget-usd 50`
against a $1.91-$4.93 actual spend); all matched their requested `model` in
`init`; all had empty `mcp_servers`; all ran `permissionMode: dontAsk`.

**Per-arm means (valid runs only):**

- Fable 5.1: n=2 (F1, F2). Mean score 19.0/20 (range 18-20). Mean cost
  $4.8841 (range $4.8429-$4.9253).
- Opus 5.5: n=3 (O1, O2, O3). Mean score 19.67/20 (range 19-20). Mean cost
  $2.2008 (range $1.9110-$2.7167).

**Cost recomputed independently for one run (O2), against the price table
in section 3:** 34 x $4 + 96,074 x $8 + 1,150,344 x $0.20 + 48,801 x $20,
all /1e6 = $0.000136 + $0.768592 + $0.2300688 + $0.97602 = $1.9748168,
matching the run's own `total_cost_usd` exactly.

**Total dollars spent across all 7 launches (6 lead + 1 judge), at list
prices:** $21.5896. F3's partial run cost $2.3530 of that before failing.

## 6. Scores per criterion, word counts

Rubric in the protocol file; `data.json`'s `judge.scores_by_run` carries the
full per-criterion `why` text the judge returned. Both Fable runs and all
three Opus runs correctly caught PR #354's open, unmerged state and the
dead `delegate_task` path on `main` (C1: 2/2 on every valid run); this is
the one fact the task most wanted refinement to catch, and every valid run
caught it independently.

| Run | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | Total | Words |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | 2 | 2 | 2 | 2 | 1 | 2 | 2 | 1 | 2 | 2 | 18 | 1,842 |
| O1 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 20 | 2,689 |
| F2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 20 | 1,949 |
| O2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 1 | 2 | 2 | 19 | 2,439 |
| O3 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 20 | 2,628 |

The two dropped points both landed on C5 (an acceptance criterion judged as
a process step, not an observable state, F1) and C8 (an internal
contradiction between a stated design decision and the batch's own acceptance
criteria: once on F1, once on O2). Word count does not track score here
(F1 is shortest and lowest-scoring; O1 is longest and highest-scoring, but
F2 scores equal to O1 at 727 fewer words), which is some evidence the judge
followed the "do not reward length" instruction, though n=5 is too small to
lean on this.

## 7. Quota vs dollars

(a) **Is Fable in Max for Claude Code?** Yes, per
https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
(section 3): plan-included on Max, metered as usage credits on Pro.

(b) **This trial's auth mode:** `apiKeySource: none` on all seven launches,
meaning the CLI authenticated as the logged-in Claude subscription, not a
raw API key. That is what the protocol's hard gate checks (its purpose is
to catch literal API-key billing), and it never fired.

(c) **Is per-model weighting published?** No specific multiplier. The same
support article states Fable draws down the shared weekly limit "faster
than other Claude models" without a number; a second article
(`usage-limit-best-practices`) confirms per-model tracking exists ("Weekly
limits: check ... for Fable if included in your plan") but also publishes
no ratio.

(d) **A direct measurement, from this trial itself, not "unmeasured":** F3
failed with HTTP 429, `result: "You've hit your individual spend limit ·
run /usage-credits to raise it, or visit claude.ai/admin-settings/usage"`,
after F1 and F2 had already spent $9.7682 combined on Fable in this same
session, within about 22 minutes. This is a different message than the
"You've reached your Fable 5 limit" quota error
`docs/research/2026-07-24-opus-5-vs-fable-5-judgment-seats.md` section 5
recorded on three prior occasions (#179, #228, and that batch's own two
events): this one names a *spend* limit and points at `/usage-credits`, the
same phrase `docs/operations/plan-downgrade-runbook.md` uses for Fable's
Pro-plan, metered, pay-as-you-go behavior after its plan-included promo
ended. `apiKeySource: none` is identical on Max and Pro (it only reports
whether a raw API key was used, not which subscription tier), so it cannot
settle which case this was. **This trial could not determine, within its
own tool allowlist or budget, whether the account was on Max (a quota
event, no real dollar meaning beyond the list-price accounting above) or
Pro (a real, metered dollar cost for the Fable arm specifically).** A
plan-tier lookup is outside every allowed tool in the protocol (it is not a
repo fact, and checking it live would be an eighth model call, over the
budget); the honest state is "not resolved by this trial," not "resolved as
quota" the way the team-guide's rationale assumes cost is inert here.

**Verdict:** availability risk is confirmed again, on today's models, after
a smaller cumulative spend than any prior recorded occurrence ($9.77 across
2 runs, all inside one 22-minute window); whether it is also a real-dollar
event is an open question, not a settled one, and is the single most
important thing for a human to check before treating this trial's dollar
figures as pure quota accounting.

## 8. Recommendation

Under the pre-registered decision rule (protocol file): both arms have at
least 2 valid runs (Fable 2, Opus 3); no sweep in either direction (Fable's
worst score, 18, is below Opus's median, 19-20); the arms' means are 0.67
points apart, inside the 2-point "comparable quality" band. Recommendation:
**move the lead to Opus 5.5, on cost, at low confidence**, same direction
and same confidence level as the 2026-07-24 research document's original,
never-adopted recommendation (there for Opus 5, medium confidence, under a
different method: no rubric, no judge, reasoning from aggregate token-share
data rather than a repo-scoped run).

This adds one consideration that document did not have: **a shared
blind spot.** Architect, reviewer, and the workflow critics already run
Opus (5.5 today, per the effort-policy test's `MODEL_BY_TIER`). Moving the
lead to Opus 5.5 too means every plan-and-decide seat in the pipeline runs
the same model family. A systematic Opus-class blind spot (a category of
mistake Opus is prone to and Fable is not) would then go uncaught by any
seat in the pipeline, where today the lead's different model family is the
one structural check on that risk, thin as it is (the lead is itself
unbacked per team-guide L115). This trial's own judge is Sonnet, not Opus,
so it cannot speak to whether such a blind spot exists; it is a risk this
report surfaces, not one it measures.

Section 7's open question is the other side of the ledger: if the account
is on Pro, the Fable arm's dollar figures already are close to the
"measure the lead's actual $/session cost at API rates first" step the
cost-based fallback trigger calls for, and this trial's own numbers
(section 5) may already answer it. If Max, they are list-price quota
accounting only, and the fallback trigger's condition has not fired.

## 9. Implied Model-policy wording (not applied)

If a human accepts section 8's recommendation, `.claude/team-guide.md`'s
orchestrator bullet (L121-125) would change from:

> Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
> Fable 5 (`claude-fable-5`) at xhigh effort. Affordable only because the
> lead stays on the bounded tm- machinery. Fable costs 2x Opus 5 per token.

to something like:

> Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
> Opus (`claude-opus-5-5` as of 2026-09-23) at xhigh effort, the same model
> family as the judgment seats (see the shared-blind-spot note,
> `docs/reviews/2026-09-23-lead-model-comparison.md` section 8). Fable
> remains available as a manual escalation for a task the lead itself
> judges to need it.

with the lead-session-fallback bullet (currently "fallback covers the lead
session only") either retired or inverted (Opus already is the lead; Fable
becomes the exception, not the default). This sketch deliberately keeps
version numbers off the seat assignment and dates the one claim that needs
it, per #357's own scope, since #357 may land first and reword these same
lines without changing which model any seat runs (its non-goals say so
explicitly). Nothing here is applied; both files are unedited by this PR.

Other touch points, for whoever implements the decision, none edited here:

- `.claude/adapters/claude-code.json` `tiers.lead` (`{ "model": "fable",
  "effort": "xhigh" }`) would need `"model": "opus"`, at which point
  `tiers.lead` and `tiers.judgment` become identical and could plausibly
  merge, a design question of its own.
- `.claude/workflows/__tests__/effort-policy.test.mjs`: the docstring
  starting at line 90 ("Lead tier is rejected on agent seats ... fable is
  lead-session-only") would need updating; lines 98, 206, and 328 are
  generic assertion bodies parameterized over `MODEL_BY_TIER`, so they need
  no edit themselves, only the table `.claude/adapters/claude-code.json`
  feeds them.
- `docs/team-guide-rationale.md`'s "Cost-based fallback trigger" section
  (L82-89) would need a note that the trigger's condition is what section 7
  above could not resolve, and that this trial's own dollar figures are the
  measurement the trigger asks for, if the condition holds.
- `docs/operations/plan-downgrade-runbook.md` would need its Max-to-Pro
  downgrade step 1 ("Flip the lead session: `/model claude-opus-5`")
  retired as a downgrade-specific step, since the lead would already be on
  Opus.

## 10. Limitations

- **n=3 per arm, one invalid:** 2 valid Fable runs, 3 valid Opus runs, one
  task, one judge. The decision rule's own stated chance of a false sweep
  at this n is about 1 in 20; this trial did not even reach a sweep, so
  that number does not apply here, but it bounds how much confidence a
  larger n would add.
- **One task:** refine-and-propose on #355 only. Nothing here speaks to
  architect, reviewer, or critic-stage judgment (already Opus by policy and
  out of scope), or to the lead's other duties (arbitration, parking
  decisions, un-delegated writing).
- **One judge, one model family:** Sonnet 5, xhigh. No inter-rater
  agreement is measurable with a single judge. A same-lineage preference
  between Sonnet-adjacent phrasing and either contestant cannot be ruled
  out; C10 (writing style) scored 2/2 on every valid run, so style did not
  visibly separate the arms here regardless.
- **Cache warmth:** each run got a cold, freshly cloned copy with no prior
  cache, so no run benefited from another run's warm cache; this also means
  every run paid full 1h cache-write price rather than a cheaper 5m
  refresh, which is representative of a real cold lead session, not of a
  kickoff pipeline's typically warmer cache.
- **Headless, no user turns:** the task explicitly forbids the
  brainstorming and grill-me loops a real `/tm-advisor` session would use;
  all "questions" become inline assumptions. This narrows what the trial
  can say about the lead's real, interactive refinement quality.
- **Snapshot exclusions:** #356, #357, #358, and PR #359 removed from every
  run's GitHub view; a run could not have used them even if it wanted to
  cheat toward this trial's own existence.
- **`Skill` and `AskUserQuestion` denied throughout:** by design (the task
  forbids brainstorming and grill-me), but this also means neither arm
  could load the `tm-advisor` skill file through the normal `Skill` tool
  path; both read it directly with `Read`, per the task prompt's own
  instruction, which is a faithful but not identical substitute for how a
  live session invokes it.
- **Filesystem jail gap:** section 4's note on `~/.hermes/` reads applies
  here too; two runs read live, unfrozen state outside the clone.
- **The Pro-vs-Max question (section 7):** unresolved, and material to
  whether this report's dollar figures for the Fable arm are quota
  accounting or close to real invoiced cost.

## 11. Reproduction

- BASE: `git ls-remote origin main` should show
  `1730257e1d979bda7cd60967012165d8a4b236d1` diverging from HEAD by however
  many commits have merged since; check out that SHA to match what every
  run saw.
- Snapshot hashes: `sha256sum` the two files named in section 4 against
  `data.json`'s `snapshot_sha256`.
- Task prompt hash: `429284cf98429a3a7deb9677b554bb40a2fdb177a883f0a9d41d5aa35605a4ac`.
- Per-run raw log hashes: `data.json`'s `runs[].raw_log_sha256` and
  `stderr_sha256`. Raw logs and transcripts themselves are not committed
  (they may carry the real Hermes provider host redacted from every
  committed file); they stayed under the developer's own
  `~/.cache/orchestrai-lead-trial/2026-09-23/` for the run and are not part
  of this PR.
- Judge raw log hash: `data.json`'s `judge.raw_log_sha256`.
- CLI command: the protocol file's "CLI" section, byte-identical to what
  ran, with `$MODEL` swapped per run.
