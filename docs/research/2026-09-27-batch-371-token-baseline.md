# Batch #371 token baseline (token-report, #379)

A real run of `token-report.mjs` (#379) over the session that ran batch #371
and its follow-on batch #378 sign-off, as a baseline for future batches.

## Command

```
node .claude/skills/tm-kickoff/token-report.mjs \
  --session d4567eab-4604-4dec-ba3f-2209ed6e64f0 \
  --config-dir <config dir> \
  --until 2026-09-27T11:04:53.617Z
```

`<config dir>` stands in for the real local config directory (this is a
public repo). The session id is an opaque UUID and is safe to publish.

## Cut-off rule

`--until` is the timestamp of the human's sign-off message for batch #378
in the lead transcript (a user line, so it carries no usage itself).
`--until` is exclusive. Everything the lead and its subagents did before
that message is in scope (batch #371 plus the #378 planning discussion);
work after it (including #379 itself) is not.

## Output (verbatim)

```
# Token report

- Session: d4567eab-4604-4dec-ba3f-2209ed6e64f0
- Window: up to 2026-09-27T11:04:53.617Z
- Price source: https://platform.claude.com/docs/en/about-claude/pricing (retrieved 2026-09-27)

## By role

| Role | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lead | 143 | 342 | 26,052,659 | 0 | 523,158 | 44,707 |
| architect | 100 | 200 | 3,195,311 | 303,139 | 0 | 19,552 |
| developer | 267 | 534 | 12,881,064 | 490,844 | 0 | 30,717 |
| reviewer | 95 | 190 | 2,613,646 | 347,381 | 0 | 15,768 |
| tester | 310 | 620 | 10,660,755 | 443,975 | 0 | 25,227 |

## By model

| Model | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5-5 | 338 | 732 | 31,861,616 | 650,520 | 523,158 | 80,027 | $15.41 |
| claude-sonnet-5 | 577 | 1,154 | 23,541,819 | 934,819 | 0 | 55,944 | $7.61 |
| **Total** | 915 | 1,886 | 55,403,435 | 1,585,339 | 523,158 | 135,971 | **$23.02** |

## Limitations

- Output token counts are not in the transcripts; the "Output (est.)" column is estimated from visible text and tool-call input, divided by 4.
- The estimate excludes thinking tokens, so it undercounts real output token usage.
- Prices are Anthropic public list prices, not your actual billing (discounts, batch pricing and negotiated rates are not reflected).
```

Independently verified against the raw transcripts before writing this doc:
34 unique `agentId` dispatches before the cut-off (one per `Agent` tool_use
whose matching `tool_result` arrives before it), all of them mapped to a
named role, none `unmapped`. The `Calls` column is a separate count (turns,
after de-duplication, not dispatches): it adds up exactly across both
tables, `915` either way.

## Comparison with the in-session figures

Issue #379 carries the batch's own in-session estimate: 53.6M input tokens
(22.7M lead, 6.5M Opus seats, 24.5M Sonnet seats), at about $25-31. On the
same basis (uncached input, cache reads and both cache-write columns, no
output estimate), this run measures 57.5M input and 26.6M for the lead,
about 7% and 17% higher.

The gap has two causes:

- **A different cut-off.** The in-session estimate read the transcripts at
  10:50:50Z, 14 minutes before this run's cut-off. Its Opus seats (6.5M)
  and Sonnet seats (24.5M) match this run. The whole difference is in the
  lead: its 11 calls between the two times (the end of the #378 planning
  discussion) add 3.6M. Re-running with `--until 2026-09-27T10:50:51.000Z`
  gives 23.0M for the lead and 53.9M in total.
- **Unverified family prices with a flat 2x cache write.** The in-session
  estimate priced every cache write at 2x the input rate ($8/MTok Opus,
  $4/MTok Sonnet). `token-prices.json` uses the pricing page's rates: $5
  and $2.50 for 5-minute writes, $8 and $4 for 1-hour writes. Re-pricing
  this run's 650,520 Opus and 934,819 Sonnet 5-minute cache-write tokens at
  the flat 2x adds $3.35, giving $26.37, inside the in-session range. The $31 top of that
  range also multiplied visible output by 4 for hidden thinking, which
  this script does not do.
