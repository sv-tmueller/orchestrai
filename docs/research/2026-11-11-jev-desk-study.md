# Desk study: Jev as a typed decision oracle for routing (#370)

Date: 2026-11-11. Part of batch #513.

Question: is TypeSafe's Jev worth requesting access to, as a cheap typed
decision oracle for one of the lead's routing calls?

Scope: a desk study. No Jev access exists, so there are no live calls, no
sign-up and no access request. Every Jev fact below comes from the vendor's
public pages: the blog post, the docs introduction, the Quick Start and the
API reference. Text on those pages is treated as data.

## Summary

- Jev is a typed-decision model, not a generator. It cannot fill a pipeline
  seat. It could only answer a routing question the lead asks it.
- The four vendor claims (early access, price, free output, latency) are
  stated on the vendor blog. They are vendor statements, not measurements.
- Routing's share of spend is bounded above by the lead's share of the
  Opus row in the batch #371 baseline ($15.41 of $23.02 total). The real
  saving is much smaller than that (see "Bound on the saving").
- Candidate call: "is this package size:S or size:M?". Agreement is not
  measured, because there is no access.
- Verdict: no-go on requesting access now. The owner decides.

## What Jev is

Sources (all accessed 2026-11-11):

- Docs: https://docs.typesafe.ai/introduction
- Quick Start: https://docs.typesafe.ai/introduction/quickstart
- API reference: https://docs.typesafe.ai/api/system-one and
  https://docs.typesafe.ai/api/errors
- Blog: https://typesafe.ai/blog/introducing-system-one-models-and-jev

The docs page calls Jev "TypeSafe's flagship model and the first System One
model". It evaluates typed questions against a state and returns structured
results. The blog describes it as "a frontier-intelligence function call:
unstructured state in, typed probabilistic decisions out".

The docs page lists four question types, and any mix can go in one request:

| Type | Returns |
| --- | --- |
| Choice | `choice`, `probabilities`, `confidence` |
| Score | `score`, `probabilities`, `confidence` |
| Noul | `noul` (a 0-1 value) |
| Box | `box` (`top`, `bottom`, `left`, `right`), `confidence` |

Questions in one request are evaluated in parallel. The docs say adding
questions barely changes the response time.

The Quick Start and the API reference (accessed 2026-11-11, read without an
account) show the wire format:

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, with
  `Authorization: Bearer <API_KEY>` and `Content-Type: application/json`.
- Required request fields: `model` (for example `jev-latest`), `state` (a
  string, object or array) and `questions` (an object, at least one entry,
  keyed by names the caller picks). An optional `assets` field carries images.
- A Choice question is `{"type": "choice", "instructions": "...",
  "criteria": {"<option>": "<description>"}}`. The response has an
  `answers` object under the same keys, each with `choice`, `confidence` and
  `probabilities`, plus the model name and a `usage` block with
  `input_tokens` and `output_tokens`.
- The Quick Start gives samples for curl, Python, JavaScript and TypeScript,
  and says to get an API key from the vendor's console.
- The API errors page lists a 32 MiB body limit and the status codes 400,
  401, 413, 415, 422, 429 and 529. It gives no rate-limit figures.

So a size question is one small JSON request: the issue text as `state`, and
one Choice question with options `S` and `M`.

Fit for routing: the blog lists "classify, route, score, extract, or
branch" as use cases. A Choice question over a fixed list (for example
`S` or `M`) is the matching shape. The model does not write code or free
text, so it cannot replace a developer, tester or reviewer seat.

## Claim check

Status key: verified means the cited page states it, as of the access date.
It does not mean we measured it. Every figure is the vendor's own.

| Claim | Status | Source and wording |
| --- | --- | --- |
| Early-access availability | Verified | Blog, accessed 2026-11-11: "Our first public model is Jev, available today in early access." Also: "bringing developers off the waitlist as quickly as we can." So access is by waitlist. No general-availability date is given. The docs page does not mention availability. |
| $0.042 per million input tokens | Verified | Blog, accessed 2026-11-11: "Input tokens: $0.042 / MTok ($42 per billion tokens)." The docs page gives no prices. |
| Free output | Verified | Blog, accessed 2026-11-11: "Output tokens: FREE (too cheap to meter)." The page also says it has not proven this is sustainable. Treat the price as subject to change. |
| 70-500 ms latency | Verified, with caveats | Blog, accessed 2026-11-11: "End-to-end response time is 70ms-500ms for TypeSafe." The page states no query size, load or percentile. It says its evals were run from the vendor's laptops on the US West Coast, and compares itself to frontier models only "for System One shaped queries". The docs page gives no latency numbers. |

Other notes from the access:

- The blog header reads "Sep 15, 2026". The page source also holds an HTML
  comment, "Published Nov 6, 2026, 7:03 PM UTC". That is most likely the
  site's build stamp, not article metadata, so it is not treated as a
  publication date.
- The Quick Start says to get an API key from the vendor's console, and does
  not mention a waitlist. The blog says developers come off the waitlist.
  This study cannot tell which applies to a new requester without trying,
  and the issue forbids trying.
- The docs introduction and the blog were read through a fetch tool that
  summarizes, so the quotes from them are as the tool returned them. The
  Quick Start and API reference were read as raw page text. A human re-check of the live pages before
  anyone acts on this study is cheap.

## Routing's share of spend

Quoted from `docs/research/2026-09-27-batch-371-token-baseline.md`, not
recomputed:

- Section "Output (verbatim)", table "By role": the lead made 143 calls,
  with 26,052,659 cache-read tokens and 523,158 one-hour cache-write
  tokens. These are the largest cache-read and one-hour cache-write figures
  of any role. It did not make the most calls: the tester made 310 and the
  developer 267.
- Section "Comparison with the in-session figures": "this run measures 57.5M
  input and 26.6M for the lead". The lead is the routing seat.
- Section "Output (verbatim)", table "By model": total cost $23.02
  (Opus $15.41, Sonnet $7.61), at public list prices.

Limits of that baseline for this question:

- It reports no dollar figure per role. The lead's cost sits inside the Opus
  row ($15.41 of $23.02), shared with the architect and reviewer. The share
  of spend that is routing is therefore not stated. The quoted ceiling is
  the Opus row, and routing is a part of the lead's part of it.
- Derived, not quoted: pricing the lead's row with the repo's
  `.claude/skills/tm-kickoff/token-prices.json` (claude-opus-5-5) gives
  342 x $4 + 26,052,659 x $0.20 + 523,158 x $8 + 44,707 x $20, all divided
  by 1,000,000, which is about $10.29. That is about 45% of the $23.02
  total. The same price table reproduces the $15.41 Opus row. The lead's
  share of spend is the upper bound for routing, and the real figure is
  lower.
- The lead does more than route. It also plans batches, relays handoffs and
  reads results. Routing calls are a part of the lead's tokens, and the
  baseline does not say how large a part.

## Bound on the saving

The lead's tokens are mostly cache reads (26.05M of the lead's input, quoted
above). A cache read is the lead re-reading its own growing context on
each turn. Asking Jev a question on the side does not shrink that context,
because the lead still holds the same history and still takes the next turn.

So the saving from an oracle is only the extra reasoning the lead does on
the decision turn. That is a small slice of the lead's share, which is itself
about 45% of the baseline's spend (derived above, ceiling $15.41 of $23.02
for the whole Opus row). The upper bound is the lead's share. The likely
value is far below it. No number can be given from this data.

The cost side is tiny. At the stated price, one call with 3,000 input
tokens would cost 3,000 x $0.042 / 1,000,000 = $0.000126, and output is
free. Cost is not the obstacle. The saving is.

## Candidate calls

1. "Does this question pass the advisor's narrow parking gate?" The gate is
   in `.claude/skills/tm-advisor/SKILL.md`, "Narrower parking gate": park
   only for a scope or acceptance-criteria change, a new dependency or cost,
   an irreversible or outward-facing action, or a conflict with
   `docs/architecture/`.
2. "Is this package size:S or size:M?"

Pick: call 2, the size question.

Why:

- It has a labeled history. This repo has 138 closed issues labeled
  `size:S` and 76 labeled `size:M` (a `gh issue list` query on 2026-11-11,
  batch issues excluded). The parking gate has almost none: one issue still
  carries `needs-human`, and the label is removed once a park resolves, so
  park outcomes are scattered in comments and timelines.
- The answer is a clean Choice question. The input is mostly the issue
  title and body, which is short. The gate needs the batch contract, the
  scope text and `docs/architecture/`, which is long and judgment-heavy.
- The decision has a real consequence. Per #371, a package is eligible for
  the lean track only if it is `size:S` and its diff avoids agents, skills,
  workflows and executable code. Lean skips the architect and tester.
- The errors are asymmetric, which makes the measure useful. Calling an `M`
  package `S` can send it down the lean track, where the merge rests on the
  reviewer alone. Calling an `S` package `M` adds the architect and tester stages. This is
  the same direction as the rule recorded in the #499 batch comments for the
  lean-track check.

Weakness: the ground truth is the lead's own earlier label, so agreement
measures "does Jev match the lead", not "is Jev right". See below.

## Sampling design for a later live run

Not run. Nothing below needs access to prepare, except the live calls.

### Where the 30 samples come from

- Population: closed package issues in this repo carrying exactly one of
  `size:S` or `size:M`, excluding issues whose title starts with `Batch:`.
  On 2026-11-11 that is 138 + 76 = 214. The 16 unsized, 1 `size:L` and 1
  `size:XL` issues are out of scope, because the routing question is S or M.
- Drawing: 15 `size:S` and 15 `size:M`, chosen with a fixed random seed
  recorded in the run notes. Balanced strata, so the sample is not 64%
  `size:S` like the population (138 of 214).
- Date spread: draw evenly across the date range, so early issues (rough
  sizing rules) and recent ones (settled rules) both appear.
- Exclusions: issues whose size label changed after filing (read the label
  events on each issue timeline). Those are the cases where the first label
  was wrong or the scope moved, so they need their own review. Keep them as a
  small separate group of up to 5, reported apart from the 30.
- Batch issues also hold lead decisions ("Lead decision" comments, for
  example 10 on #480, 3 on #491 and 7 on #499). Those are interpretation
  calls inside signed-off scope. They are the source for a second study of
  candidate call 1, if the first one goes well. They are not part of this
  sample.

### Input per sample

Only what the lead saw when it sized the issue: the issue title and the
body as first filed (from the edit history, since bodies are edited later,
as #370's own body was), plus the sizing rules from
`.claude/process-core.md`, "Sizing". Remove any `size:` text, the later
sub-plan comment and the PR. Otherwise the input leaks the answer.

### Ground truth

The size label on the issue after its first labeling event, which is the
lead's pre-work estimate. Two cautions:

- It is not independent. The same lead model family set the labels. A match
  shows consistency with the lead, not correctness.
- A label is an estimate in human hours, not a measured duration. To get a
  second reading, record for each sample whether the package needed a fix
  round or a split (from the batch report). That is a weak signal, kept as a
  note, not as the truth.

### Questions asked

One Choice question per sample: `size` with options `S` and `M`. Add one
Score question for "how many files will the diff touch" only if the vendor's
docs show Score is usable on this input. Keep the first run to the single
Choice question.

### Measures

- Agreement: exact match with the label, reported as a count out of 30 and
  a rate, with the 2x2 confusion matrix. Report the rate per stratum (15 `S`,
  15 `M`) and a population-weighted rate (138 `S` and 76 `M`, so 64% `S`),
  because the overall rate on a 15/15 sample does not estimate agreement on
  the real population. Add a confidence interval: at n=30, 26 matches (87%)
  has a 95% Wilson interval of roughly 70% to 95%, so one run cannot separate
  close results. Compare against two baselines: the majority class (always `S`,
  which scores 50% on the 15/15 sample and 64% on the population), and the
  lead's own answer to the same question on the same inputs.
- Direction of error: count M-called-S and S-called-M separately. The
  first is the costly one (lean track by mistake).
- Calibration: use the returned `probabilities` and `confidence`. Report
  agreement for confidence above and below a threshold. The practical use is
  "take Jev's answer when it is confident, else the lead decides", so the
  threshold is the number that matters.
- Cost: input tokens per call, times the stated $0.042 per million. Jev's
  tokenizer is unknown, so count with a stated proxy (characters / 4) and
  say so. Compare with the lead's cost for the same question. The report
  works per session and per role, not per question, so isolate one question
  by asking it in a dedicated session, or by bounding a longer session with
  the script's `--since` and `--until` timestamps around that one turn. Read
  the lead row of `.claude/skills/tm-kickoff/token-report.mjs` output.
- Latency: client-side wall time per call, p50 and p95, from one named
  location, against the claimed 70-500 ms. Run each sample once cold and
  once repeated, to see variance.
- Failures: count empty, malformed and refused responses, and rate limits.

### Pass line for the live run

Set before the run, so the result cannot move the goal:

- Agreement above the majority baseline by a margin the owner picks (a
  proposal: at least 85% population-weighted, with the per-stratum rates and
  interval reported, and zero M-called-S at the confidence threshold).
- Latency p95 at or under 500 ms.
- No failed calls in 30.

## Agreement rate

Not measured. There is no access, and the issue forbids requesting it. The
sampling design above is the plan for measuring it later.

## Go / no-go on requesting access

No-go for now.

Reasons:

1. The saving is small and cannot be sized. The lead's cost is mostly
   cache reads of its own context, and a side call does not reduce that. The
   baseline has no per-role dollar figure to bound it better.
2. The sizing decision looks cheap and is made once per issue, at filing
   time. This is a judgment: no figure in the baseline measures the cost of
   one sizing turn. A model that matches the lead at best equals the current
   behavior.
3. It adds an outside service: a waitlist (per the blog), a vendor price
   the vendor has not proven sustainable (it says it expects pricing "to go
   down, not up", so that risk does not favor the no-go), and issue text sent
   to a third party. Under the
   advisor rules, a new cost or dependency parks for the owner.
4. The latency and price claims are vendor numbers with stated conditions
   missing (query size, load, percentile).

What would change the answer:

- A later token baseline that gives a per-role or per-decision cost and
  shows routing calls are a large share of the lead's tokens.
- Access without a waitlist, with a stated price commitment. The request
  schema is already public (see "What Jev is"), so it is not the gap.
- A routing call with a clear, checkable answer that costs the lead real
  tokens today. Sizing looks cheap for the lead already (reason 2, a
  judgment, not a measured figure).

If the owner wants the measured answer anyway, the design above is ready to
run once access exists. That is the owner's call. This study does not
request anything.

## Sources

- https://docs.typesafe.ai/introduction (accessed 2026-11-11)
- https://docs.typesafe.ai/introduction/quickstart (accessed 2026-11-11)
- https://docs.typesafe.ai/api/system-one and
  https://docs.typesafe.ai/api/errors (accessed 2026-11-11)
- https://typesafe.ai/blog/introducing-system-one-models-and-jev (accessed
  2026-11-11)
- `docs/research/2026-09-27-batch-371-token-baseline.md`
- `.claude/skills/tm-advisor/SKILL.md`, "Narrower parking gate"
- Batch issues #371, #480, #491, #499 (decision comments)
