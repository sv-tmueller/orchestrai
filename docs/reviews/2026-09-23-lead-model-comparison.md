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
inside the rule's 2-point "comparable" band, and Opus 5.5's mean list-price
cost per valid run ($2.20) is well under half of Fable 5.1's ($4.88).

One run failed mid-trial: a Fable run (F3) hit an API 429, "You've hit your
individual spend limit · run /usage-credits to raise it, or visit
claude.ai/admin-settings/usage," after the two prior Fable runs had already
spent $9.77 (list-price equivalent) between them. `apiKeySource` read `none`
(not a literal API key) on every one of the six launches, which is what the
protocol's hard gate checks, so the gate never fired and the trial continued
to O3 as scheduled. What caused F3 is undetermined: the same-worded
"individual spend limit" 429 later hit a Sonnet tester dispatch in this same
account (request `req_011CfL9r8ukGaQVoFsNi2poW`, logged on batch issue
#356), on a model that carries none of Fable's Max-vs-Pro distinction,
which points toward an account-wide cap; but that tester's own 429 carried
different wording ("your session limit resets 2:20pm (Europe/Berlin)"), and
O3 (Opus) and the Sonnet judge both then ran cleanly in the same account
within minutes, which points just as well toward a Fable-specific spend
ceiling that Opus's and Sonnet's much smaller per-run costs never reached.
Section 7(d) lays out both readings with the facts for and against each.
F3 is not evidence, either way, on which subscription tier the account was
on; that question stays open on its own terms, unresolved by this trial,
and section 7 covers where it does and does not matter.

## 2. The policy lines at BASE

`.claude/team-guide.md`:

- L115: "Fable 5 in the one seat nothing backstops (the lead), Opus 5 at
  xhigh in the backstopped judgment seats (architect, reviewer, workflow
  critics), efficient workers everywhere else."
- L121-125: "Orchestrator (the lead session, including `/tm-advisor` and
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
is 2.22x Opus's ($2.20), below the 2.5x list ratio. Two things narrow it,
one by token count and one by dollar cost:

- Cache-read tokens dominate every run's total token count (the majority
  of every run's tokens, see section 5's table), and cache reads price
  close to each other in absolute terms across the two models ($0.25 vs
  $0.20 per MTok, a 1.25x spread) even though their cache-read
  *multipliers* differ (0.025x vs 0.05x of a base price that itself
  differs 2.5x).
- By dollar cost rather than token count, the two arms' spend mixes
  differ (computed from the per-run formula in section 5, summed per
  arm): Fable's cost is about 58% cache-write and 38% output; Opus's is
  about 46% output and 40% cache-write, with cache-read a much larger
  share of Opus's cost (14%, against 4% of Fable's) because Opus consumed
  proportionally more cache-read tokens. Opus's mean total tokens per
  valid run (about 1.69M) ran about 1.8x Fable's (about 0.92M), so part of
  the narrowing from 2.5x to 2.22x is Opus buying more tokens at its lower
  price, not only the cache-read compression above.

**Max plan and Fable availability**
(https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan,
retrieved 2026-09-23): "Fable 5 and Fable 5.1 are included as a standard
part of your plan" on Max; on Pro, "Fable 5 and Fable 5.1 aren't included in
your plan's usage limits. You can use them with usage credits." The same
article: Fable models "draw from your plan's regular weekly usage limits
and use them faster than other Claude models," with no published
multiplier. https://claude.com/pricing (retrieved 2026-09-23, live
plan-comparison table) corroborates this directly with its own "Fable" row:
Free "No", Pro "Usage credits", Max 5x and Max 20x both "50% of weekly
limits*". Separately, the same page's feature list attaches "More Claude
models" to the Pro plan card (a Pro-over-Free feature), not to Max over Pro;
that phrase is not the source for Fable's Max-vs-Pro treatment, the named
row above is.

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
  F2 is a third affected run, and its escape changed a score: F2's C2 and
  C7 "why" text (`data.json` lines 468 and 488) both credit "a third
  hand-written rule copy at `~/.hermes/plugins/tm-orchestrator/`" as a
  verified, checkable fact, which is live install state outside BASE and
  outside `_snapshot/`, not something C2 or C7 are supposed to be able to
  verify. The judge is a fourth affected run: to credit that claim as
  "verified true," it had to reach outside its own confined judge-repo
  copy the same way. **Sensitivity:** if C7 is marked down to 1 for
  resting on a claim outside the repo and the snapshot (the criterion's
  own anchor requires backing "in the repo or snapshot"), F2 drops from 20
  to 19, the Fable mean drops from 19.0 to 18.5, and the gap to Opus's
  mean (19.67) widens from 0.67 to 1.17, still inside the decision rule's
  2-point "comparable" band. The recommendation in section 8 is unchanged
  either way.
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
- **Deviation: five judged outputs, not six.** F3 was invalidated (section
  5, budget/gate reasons unrelated to the judge) before blinding, leaving
  five valid runs, not the six the frozen protocol's judge section and
  prompt describe. The `_judge/` directory held only `R1.md` through
  `R5.md`; the judge prompt actually sent, and the reply schema requested,
  were adapted from the protocol's literal "six anonymized outputs ...
  R1.md to R6.md ... {"R1": ..., ..., "R6": {...}}" to five outputs and a
  five-key schema (`R1` through `R5`), matching what `data.json`'s
  `judge.label_to_run_id` and `scores_by_run` record. The protocol file
  itself was not edited; it stayed frozen at `191c110`. Per the protocol's
  own rule ("any later change is a deviation, logged in the report"), this
  is that change: nothing else about the judge run (model, effort, budget,
  rubric text, redaction, unblinding order) differs from the frozen
  protocol.

## 5. Per-run table

Input is the raw token count (not K); the remaining token columns are in
thousands (K), from each run's own `result.usage`; no run spawned a
subagent (`spawn_count: 0` throughout), so lead-only equals total.

| Run | Model | Input | Cache write (1h) | Cache read | Output (of which thinking) | Cost (list) | Wall | Turns | Denials | Score |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Fable 5.1 | 258 | 155.6K | 514.5K | 33.6K (24.2K) | $4.9253 | 7m33s | 49 | 0 | 18/20 |
| O1 | Opus 5.5 | 46 | 142.6K | 1,916.6K | 59.6K (46.7K) | $2.7167 | 9m50s | 49 | 0 | 20/20 |
| F2 | Fable 5.1 | 354 | 129.4K | 963.2K | 40.2K (27.7K) | $4.8429 | 9m01s | 62 | 0 | 20/20 |
| O2 | Opus 5.5 | 34 | 96.1K | 1,150.3K | 48.8K (38.3K) | $1.9748 | 7m38s | 36 | 0 | 19/20 |
| F3 | Fable 5.1 | 322 | 83.0K | 492.1K | 11.3K (6.5K), then a 429 | $2.3530 | 3m02s | 50 | 1 | **invalid, not scored** |
| O3 | Opus 5.5 | 44 | 94.3K | 1,523.8K | 42.6K (32.1K) | $1.9110 | 7m24s | 38 | 0 | 20/20 |
| Judge | Sonnet 5 | 102 | 208.0K | 6,153.9K | 80.3K (68.8K) | $2.8660 | 15m05s | 70 | 5 | n/a |

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

**`modelUsage` cross-check:** done, not skipped, for all 7 launches. Every
run's `modelUsage` bucket totals equal its own `usage` bucket totals
exactly (0% difference), which is a weaker check here than the protocol
intended: `spawn_count: 0` on every run means there is no subagent
transcript to dedupe or sum against the lead's own numbers, so the two
sources were never independent for this trial.

**Total list-price cost equivalent across all 7 launches (6 lead + 1
judge):** $21.5896. Under subscription auth (`apiKeySource: none`
throughout, section 4), this is what the tokens would cost at API list
rates, not dollars actually invoiced; section 7 covers what that
distinction does and does not settle. F3's partial run cost $2.3530 of
that before failing.

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

The three dropped points landed on C5 (an acceptance criterion judged as a
process step, not an observable state, F1: -1) and C8 (an internal
contradiction between a stated design decision and the batch's own
acceptance criteria: F1: -1, O2: -1). The 5 valid runs scored 97 of a
possible 100 (5 runs x 20), close to the rubric's ceiling; there is little
room left for this rubric to separate the arms further on this task.

Word count does not cleanly track score: F1 is shortest and lowest-scoring,
and F2 scores equal to O1 at 740 fewer words, which is some evidence the
judge followed the "do not reward length" instruction on that pair. But the
aggregate cuts the other way: Opus's 3 outputs run about 36% longer than
Fable's 2 (mean 2,585 vs 1,896 words) and Opus also has the higher mean
score (19.67 vs 19.0), so length and score are positively correlated across
the arms even if not causally linked; n=5 is too small to settle which
reading dominates.

## 7. Quota vs dollars

(a) **Is Fable in Max for Claude Code?** Yes, per
https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
(section 3): plan-included on Max, metered as usage credits on Pro. The live
https://claude.com/pricing plan-comparison table corroborates this with its
own "Fable" row (section 3): Free "No", Pro "Usage credits", Max 5x and Max
20x both "50% of weekly limits*".

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

(d) **An availability event from this trial itself, cause undetermined:**
F3 failed with HTTP 429, `result: "You've hit your individual spend limit ·
run /usage-credits to raise it, or visit claude.ai/admin-settings/usage"`,
at 09:05:16Z, about 41 minutes after F1 started (08:24:21Z). F1 and F2
together are two separate sessions spanning about 29 minutes (F1's start
to F2's end) and had spent $9.7682 combined (list-price equivalent) by the
time F3 failed. This is a different message than the "You've reached your
Fable 5 limit" quota error
`docs/research/2026-07-24-opus-5-vs-fable-5-judgment-seats.md` section 5
recorded on three prior occasions (#179, #228, and that batch's own two
events): this one names a *spend* limit rather than a per-model limit.

Two readings are both consistent with what this trial observed, and this
trial cannot tell them apart:

- **Account-wide cap.** The same "individual spend limit" wording later
  hit a Sonnet tester dispatch in this same account (request
  `req_011CfL9r8ukGaQVoFsNi2poW`, logged on batch issue #356), a model
  with none of Fable's Max-vs-Pro distinction. A cap that catches a Sonnet
  dispatch too cannot be Fable-specific metering. Against this reading:
  the tester's own 429 carried different wording ("your session limit
  resets 2:20pm (Europe/Berlin)," per the same #356 log entry), so the two
  events may be two different caps, a session/time cap and a spend cap,
  that only sound alike rather than one cap recurring; and O3 (Opus,
  09:06:45-09:14:09Z) and the Sonnet judge (09:16:13-09:31:18Z) both ran
  cleanly in the same account within minutes of F3's failure, which an
  account-wide spend cap large enough to stop F3 would also have been
  expected to block.
- **Fable-specific usage-credit metering.** The two Fable runs cost
  $4.84-$4.93 each, well above every Opus run ($1.91-$2.72) and the Sonnet
  judge ($2.87); a spend ceiling reached by Fable's heavier per-run cost
  while Opus's and Sonnet's smaller draws stayed under it is consistent
  with the support article's own language in (a) below, that Fable
  "draw[s] from your plan's regular weekly usage limits and use[s] them
  faster than other Claude models," and with Pro's usage-credits billing
  for Fable specifically. Against this reading: the recurrence on a
  Sonnet dispatch above is at minimum evidence that some cap in this
  account is not Fable-specific, even if it turns out to be a different
  cap than the one that stopped F3.

**F3's cause is undetermined.** It does not evidence which subscription
tier the account was on either way (`apiKeySource: none` is identical on
Max and Pro, so it cannot settle this; see below), and whether the
Fable-specific reading holds is exactly what determines whether the
cost-based fallback trigger (team-guide L147-151) has fired.

Separately, and still unresolved by this trial on its own terms: which
subscription tier (Max or Pro), or seat type, the account was on.
`apiKeySource: none` cannot settle Max-vs-Pro, and a plan-tier lookup is
outside every allowed tool in the protocol (it is not a repo fact, and
checking it live would be an eighth model call, over the budget). The
429's own text points at `claude.ai/admin-settings/usage`, an org
admin-settings path rather than a personal-account settings path, which
raises a possibility this trial did not consider going in: a Team or
Enterprise seat with its own pooled or admin-managed usage limits, not
simply "Max" or "Pro." That question bears on whether Fable draws from a
plan-included weekly limit or metered usage credits in general, per (a)
below; it does not bear on why F3 failed, and this trial does not use F3
to answer it.

**Does the quota reasoning in (a)-(c) still apply here?** Only if the
account-wide reading above is wrong. If the account is on Max, (a)'s "50%
of weekly limits" figure means a lead session on Fable draws down the
shared weekly pool twice as fast as an equivalent Opus or Sonnet session
would; two Fable runs in this trial would then cost roughly the same
weekly-limit budget as four Opus runs, independent of any dollar figure.
If the account is on Pro or an org-managed seat billed by usage credits,
the dollar figures in section 5 are closer to real cost than to quota
accounting, and the cost-based fallback trigger's own instruction
("measure the lead's actual $/session cost at API rates first") is close
to already satisfied by this trial's numbers, pending a human confirming
the tier.

**Verdict:** availability risk is confirmed again, on today's models,
after a smaller cumulative spend than any prior recorded occurrence ($9.77
across 2 runs, about 29 minutes apart and 41 minutes before F3 failed),
with the cause undetermined between an account-wide cap and Fable-specific
metering (both readings above). The account's Max-vs-Pro-or-other tier
remains an open question independent of F3, and is worth a human check
before anyone leans on this trial's dollar figures as a Max/Pro signal.

## 8. Recommendation

Under the pre-registered decision rule (protocol file): both arms have at
least 2 valid runs (Fable 2, Opus 3); no sweep in either direction (Fable's
best score, F2's 20, ties O1 and O3 and beats O2's 19, so Opus's valid
scores do not all beat Fable's; Fable's worst score is not the reason a
sweep failed); the arms' means are 0.67 points apart, inside the 2-point
"comparable quality" band. Recommendation: **move the lead to Opus 5.5, on
cost, at low confidence**, the same direction as the 2026-07-24 research
document's original, never-adopted recommendation, but at a lower
confidence level: that document was medium confidence, for Opus 5, under a
different method (no rubric, no judge, reasoning from aggregate
token-share data rather than a repo-scoped run); this trial's low
confidence comes from the decision rule's "comparable quality" branch, not
the sweep branch that document's own reasoning more closely resembles.

This adds one consideration that document did not have: **a shared
blind spot.** Architect, reviewer, and the workflow critics already run
Opus (the `opus` alias, in `.claude/adapters/claude-code.json`'s
`tiers.judgment`, which section 3 confirms resolves to Opus 5.5 today).
Moving the lead to Opus 5.5 too means every plan-and-decide seat in the
pipeline runs the same model family. A systematic Opus-class blind spot (a
category of mistake Opus is prone to and Fable is not) would then go
uncaught by any seat in the pipeline, where today the lead's different
model family is the one structural check on that risk, thin as it is (the
lead is itself unbacked per team-guide L115). This trial's own judge is
Sonnet, not Opus, so it cannot speak to whether such a blind spot exists;
it is a risk this report surfaces, not one it measures.

Section 7's open question is the other side of the ledger: if the account
is on Pro, the Fable arm's dollar figures already are close to the
"measure the lead's actual $/session cost at API rates first" step the
cost-based fallback trigger calls for, and this trial's own numbers
(section 5) may already answer it. If Max, they are list-price quota
accounting only, and the fallback trigger's condition has not fired.

## 9. Implied Model-policy wording (not applied)

If a human accepts section 8's recommendation, `.claude/team-guide.md`'s
Model policy section would change in four places. Quotes below are exact
against BASE; "after" text is this report's own sketch, not applied, and
both files named in this section are unedited by this PR.

**L115** (the section's opening line) would change from:

> Fable 5 in the one seat nothing backstops (the lead), Opus 5 at xhigh in
> the backstopped judgment seats (architect, reviewer, workflow critics),
> efficient workers everywhere else. The lever is where each model runs,
> not raw effort everywhere.

to something like:

> Opus at xhigh in every plan-and-decide seat, including the lead
> (architect, reviewer, workflow critics, and now the orchestrator too;
> see the shared-blind-spot note in section 8), efficient workers
> everywhere else. The lever is where each model runs, not raw effort
> everywhere.

**L121-125**, the orchestrator bullet, would change from:

> Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
> Fable 5 (`claude-fable-5`) at xhigh effort. Affordable only because the
> lead stays on the bounded tm- machinery. Fable costs 2x Opus 5 per
> token. The premium is bounded in aggregate, not per batch
> (docs/research/2026-07-06-token-burn-investigation.md, driver 3).

to something like:

> Orchestrator (the lead session, including `/tm-advisor` and `/tm-kickoff`):
> Opus (the `opus` alias, Opus 5.5 as of 2026-09-23 per
> `docs/reviews/2026-09-23-lead-model-comparison.md` section 3) at xhigh
> effort, the same model family as the judgment seats (see the
> shared-blind-spot note, section 8).

using the version-neutral `opus` alias rather than pinning
`claude-opus-5-5`, consistent with #357's own scope (version-neutral model
references) and with PR #359, already in flight for that issue, which
rewords several of these same lines (see the touch points below).

**L126-132**, the lead-session-fallback bullet, currently:

> Lead-session fallback: Opus 5 at xhigh effort, a manual procedure. Fable is
> lead-session-only: used as the orchestrator when available, and nothing
> else in the machinery calls it. When Fable 5 is unavailable, rate-limited,
> quota-exhausted, or refuses the workload, switch the lead with
> `/model claude-opus-5`. Flip back when Fable returns. This fallback covers
> the lead session only; no other seat pins Fable, so no other pin needs to
> flip alongside it.

would need retiring (there is no fallback *to* Opus once Opus is already
the default) or inverting into a Fable-escalation bullet, something like:

> Fable escalation (optional, manual): a lead session may switch to Fable
> at xhigh effort with `/model fable` for a specific task it judges needs
> it, then flip back. No seat other than the lead ever pins Fable.

The escalation direction above is this report's own sketch, not a finding
this trial's data supports: the trial never tested Fable as an occasional
escalation, only as the default across 2 valid runs. Keep it as a separate
design question if section 8's recommendation is adopted, not as part of
the recommendation itself.

**L147-151**, the cost-based fallback trigger, currently:

> Cost-based fallback trigger: if Fable 5 stops being included under the
> Max-plan subscription and shifts to metered API billing, do not switch to
> Opus automatically. Measure the lead's actual $/session cost at API rates
> first, then decide whether to keep Fable or move to Opus 5 permanently,
> logging the decision and cost here.

would need rewording, since its "then decide whether to keep Fable or move
to Opus" branch is moot once Opus is already the default; something like:

> Cost-based fallback trigger (historical): this triggered the move to
> Opus recorded above (`docs/reviews/2026-09-23-lead-model-comparison.md`).
> If Fable's billing terms improve enough to revisit that move, re-run a
> comparison before switching back; do not switch on an availability event
> alone (see that report's section 7).

Nothing here is applied; both files are unedited by this PR.

Other touch points, for whoever implements the decision, none edited here:

- `.claude/adapters/claude-code.json` `tiers.lead` (`{ "model": "fable",
  "effort": "xhigh" }`) would need `"model": "opus"`, at which point
  `tiers.lead` and `tiers.judgment` become identical and could plausibly
  merge, a design question of its own.
- `.claude/workflows/__tests__/effort-policy.test.mjs`: the module
  docstring (L16-18, "Lead tier is rejected on agent seats and workflow
  stages: fable is lead-session-only") would need updating, since lead and
  judgment would then share a model; `SEAT_EXPECTATIONS` (L83-87) hardcodes
  `lead: { model: 'fable', effort: 'xhigh' }` at L86 and would need
  `model: 'opus'`; the reference-adapter assertion at L145-160 checks the
  adapter table against that hardcoded map and needs no edit itself, only
  the map; and the "Reject lead tier on agent seats" / "workflow stages"
  comments at L193 and L315 (plus the seat-list comment at L75-78, which
  names "opus/sonnet/fable" as the three reference models) would need
  rewording once lead is no longer a distinct seat model.
- `docs/team-guide-rationale.md`'s "Cost-based fallback trigger" section
  (L82-89) would need a note that the trigger's condition is what section 7
  above could not resolve, and that this trial's own dollar figures are the
  measurement the trigger asks for, if the condition holds.
- `docs/operations/plan-downgrade-runbook.md` would need its Max-to-Pro
  downgrade step 1 ("Flip the lead session: `/model claude-opus-5`")
  retired as a downgrade-specific step, since the lead would already be on
  Opus. PR #359 (open, `Closes #357`) already rewrites a nearby line in
  this same file (the Pro-availability facts paragraph a few lines above
  step 1, noting that Opus's Pro availability needs re-verification since
  the `opus` alias now resolves to 5.5); it does not touch step 1 itself.

## 10. Limitations

- **n=2 (Fable) vs n=3 (Opus), one invalid:** 2 valid Fable runs, 3 valid
  Opus runs, one task, one judge. The decision rule's own stated chance of
  a false sweep, about 1 in 20, is the figure for 3 valid runs per arm;
  at this trial's actual 2-vs-3 split the chance of a complete split by
  chance alone is closer to 1 in 10 (the odds that a specific 2 of the 5
  ranked outputs land exactly on top). This trial did not reach a sweep
  either way, so neither figure describes its own result; both are here
  only as the reference point for reading a future, larger run.
- **One task:** refine-and-propose on #355 only. Nothing here speaks to
  architect, reviewer, or critic-stage judgment (already Opus by policy and
  out of scope), or to the lead's other duties (arbitration, parking
  decisions, un-delegated writing).
- **One judge, one model family, and the bias risks that come with it:**
  Sonnet 5, xhigh. No inter-rater agreement is measurable with a single
  judge. A same-lineage preference between Sonnet-adjacent phrasing and
  either contestant cannot be ruled out. Order effects are controlled for
  by construction (labels R1-R5 are assigned by sorted sha256 of the
  redacted files, not by run order or arm), but each model's own default
  verbosity is not, which is the length-bias question section 6 covers
  directly. Writing-style tells (an em dash, a particular hedge) could
  leak identity even after redaction; C10 (writing style) scored 2/2 on
  every valid run, so style did not visibly separate the arms here
  regardless. The protocol's own manual pass for missed self-identification
  (a run naming its own capabilities or context window) found nothing to
  redact in any of the 5 judged outputs: each blinded `_judge/R#.md` file
  is byte-identical to its run's own extracted final message, so automated
  redaction had nothing to change and the manual pass added no further
  redactions either.
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
- **Filesystem jail gap:** section 4's note applies here too, and the
  count is at least four, not two: F1 and O1 read live, unfrozen state
  outside the clone; F2's C2 and C7 scores were credited in part on a
  claim resting on that same live state; and the judge had to reach
  outside its own confinement to verify that claim. Section 4 gives the
  F2 sensitivity: marking C7 down to 1 still leaves section 8's
  recommendation unchanged.
- **The Pro-vs-Max question (section 7):** unresolved, and material to
  whether this report's dollar figures for the Fable arm are quota
  accounting or close to real invoiced cost.
- **Protocol correction (not a deviation, the protocol file is frozen and
  not edited here):** the protocol's "Prices" section describes the
  models-overview fetch as redirecting "from `/docs/en/models/overview`".
  The direction is backwards: `curl -sI` against
  `https://platform.claude.com/docs/en/about-claude/models/overview`
  returns `307` with `location: /docs/en/models/overview`, so the
  requested `/docs/en/about-claude/models/overview` path redirects *to*
  `/docs/en/models/overview`, not the reverse. This does not change any
  price, ID, or alias recorded in section 3; it is a wording correction,
  noted here rather than in the frozen protocol file.

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
- **jq extraction**, verified against the raw logs: each lead run's final
  message is the `result` field of the last line of its `.jsonl`
  (`stream-json`), and this matches every kept `*.output.md` byte for
  byte:
  ```sh
  tail -1 "$TRIAL/runs/$ID.jsonl" | jq -r '.result' > "$TRIAL/runs/$ID.output.md"
  ```
  The judge's own `--output-format json` reply needed one extra step,
  since its `.result` is a markdown-fenced JSON blob:
  ```sh
  jq -r '.result' "$TRIAL/runs/JUDGE1.json" | sed '1d;$d' > "$TRIAL/_judge/scores.json"
  ```
- **sha256 labeling**, verified to reproduce `data.json`'s
  `judge.label_to_run_id` exactly (`R1`=F1, `R2`=O1, `R3`=O2, `R4`=F2,
  `R5`=O3):
  ```sh
  for id in F1 O1 F2 O2 O3; do
    printf '%s %s\n' "$(shasum -a 256 "$TRIAL/runs/$id.output.md" | awk '{print $1}')" "$id"
  done | sort | awk '{ print "R" NR, $2 }'
  ```
- **Perl redaction step: not recoverable verbatim.** The literal
  invocation was not preserved in this developer's shell history for the
  trial's own terminal session; reconstructing its exact flags now would
  be silent guessing, which this fix round's own instructions rule out.
  What is directly verifiable instead: each of the 5 `_judge/R#.md` files
  is byte-identical to its source run's extracted `output.md` (`diff`
  reports no difference for any of the 5), meaning the redaction step
  found nothing to change in any of them, consistent with the manual
  self-identification pass also finding nothing (section 10) and with
  none of the 5 outputs containing a model name, a model ID, an
  attribution line, or the `redact.txt` host (checked directly with
  `grep`, zero hits across all 5). A command that would perform the rule
  as stated, never run against the actual outputs since none of them
  needed it: one `perl -0777 -pe` substitution per redaction target
  (model names, model IDs, `Generated with` / `Co-Authored-By` lines,
  each `redact.txt` host replaced with `https://provider.example.com`),
  applied per file before the sha256 labeling step above.
- **Judge invocation**, from the protocol's CLI block with the
  non-streaming, JSON-output flags it specifies, confirmed against
  `JUDGE1.json`'s own `modelUsage` (key `claude-sonnet-5`) and
  `permission_denials` (5 entries, all `Bash`):
  ```sh
  cd "$TRIAL/judge-repo" && env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
    PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    CLAUDE_CONFIG_DIR="$HOME/.claude-work" GH_CONFIG_DIR="$TRIAL/gh-empty" \
    /opt/homebrew/bin/claude -p --model claude-sonnet-5 --effort xhigh \
      --output-format json --session-id "$JUDGE_SID" \
      --permission-mode dontAsk --strict-mcp-config --max-budget-usd 10 \
      --allowedTools "Read,Grep,Glob,Agent,Task,Bash(git log *),Bash(git show *),Bash(git diff *),Bash(git grep *),Bash(git ls-files *),Bash(ls *),Bash(cat *),Bash(head *),Bash(tail *),Bash(wc *),Bash(grep *),Bash(rg *),Bash(find *),Bash(jq *)" \
      --disallowedTools "Edit,Write,NotebookEdit,Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git commit *),Bash(git push *),Bash(git remote *),Bash(curl *)" \
      < "$TRIAL/judge-prompt.md" > "$TRIAL/runs/JUDGE1.json" 2> "$TRIAL/runs/JUDGE1.stderr"
  ```
- **The verbatim five-output judge prompt actually sent** (the frozen
  protocol's own judge prompt names six; section 4's deviation entry
  covers the narrowing to five):
  ```
  You are scoring five anonymized outputs, _judge/R1.md to _judge/R5.md, all answers
  to the task in _judge/task-prompt.md. Score each output against each criterion in
  _judge/rubric.md, using only the rubric's anchors. The repository in this directory
  is the exact state the outputs were written against; _snapshot/ is the GitHub
  state they saw. Use both to check claims as C2 directs. Do not run gh or change
  anything. Score each output on its own. Do not reward length. Do not guess which
  system wrote an output. Reply with JSON only:
  {"R1": {"C1": {"score": 0, "why": "<one line>"}, ..., "C10": {...}}, ..., "R5": {...}}
  ```
