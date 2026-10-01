# Token report

- Session: workflow-session
- Window: from 2026-10-01T10:00:00Z
- Price source: https://platform.claude.com/docs/en/about-claude/pricing (retrieved 2026-09-27)

## By role

| Role | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lead | 7 | 80 | 0 | 0 | 0 | 82 |
| developer | 3 | 630 | 0 | 0 | 0 | 13 |
| reviewer | 1 | 300 | 0 | 0 | 0 | 0 |
| tester | 4 | 460 | 0 | 0 | 0 | 18 |
| workflow:tm-review-changes | 3 | 1,310 | 0 | 0 | 0 | 11 |
| unmapped | 1 | 50 | 0 | 0 | 0 | 2 |

## By model

| Model | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5-5 | 9 | 630 | 0 | 0 | 0 | 87 | $0.00 |
| claude-sonnet-5 | 10 | 2,200 | 0 | 0 | 0 | 39 | $0.00 |
| **Total** | 19 | 2,830 | 0 | 0 | 0 | 126 | **$0.01** |

## By agent

| Start (UTC) | Role | Model | Calls | Tool uses | Output (est.) | Wall-clock | Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 2026-10-01 10:00:00 | lead | claude-opus-5-5 | 7 | 6 | 82 | 1h 30m 0s (est.) | lead first-to-last span |
| 2026-10-01 10:00:10 | developer | claude-sonnet-5 | 3 | 2 | 13 | 2m 0s | task notification duration_ms |
| 2026-10-01 10:00:10 | tester | claude-sonnet-5 | 4 | 2 | 18 | 1m 30s (est.) | transcript span |
| 2026-10-01 10:00:12 | reviewer | claude-sonnet-5 | 1 | 0 | 0 | 45s | task notification duration_ms |
| 2026-10-01 10:00:14 | architect | - | 0 | 0 | 0 | n/a | n/a |
| 2026-10-01 10:00:20 | unmapped | claude-opus-5-5 | 1 | 0 | 2 | n/a | n/a |
| 2026-10-01 10:00:30 | workflow:tm-review-changes (review:bugs) | claude-sonnet-5 | 2 | 2 | 8 | 1m 30s (est.) | transcript span |
| 2026-10-01 10:02:10 | workflow:tm-review-changes (consolidate) | claude-opus-5-5 | 1 | 0 | 3 | 30s (est.) | transcript span |

## Limitations

- Output token counts are not in the transcripts; the "Output (est.)" column is estimated from visible text and tool-call input, divided by 4.
- The estimate excludes thinking tokens, so it undercounts real output token usage.
- Prices are Anthropic public list prices, not your actual billing (discounts, batch pricing and negotiated rates are not reflected).
- Wall-clock: "task notification duration_ms" is the time the harness measured for a dispatched seat. "transcript span" is the first-to-last timestamp span of each run in a transcript, used for workflow subagents and for a seat with no positive measured duration. "est." marks a span. The lead row spans its first to last line in the window, so it includes idle and waiting time. "n/a" means no source gave a positive value.
- Tool uses are counted from tool_use blocks in each transcript.
- Found but not read (left out of every total): subagents/unknown-layout.

