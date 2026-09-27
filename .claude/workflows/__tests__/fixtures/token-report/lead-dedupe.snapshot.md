# Token report

- Session: fixture-session
- Window: full transcript
- Price source: fixture price list (retrieved 2026-09-27)

## By role

| Role | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lead | 2 | 140 | 20 | 50 | 0 | 8 |

## By model

| Model | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est.) | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5-5 | 1 | 100 | 20 | 50 | 0 | 7 | $0.00 |
| claude-sonnet-5 | 1 | 40 | 0 | 0 | 0 | 1 | $0.00 |
| **Total** | 2 | 140 | 20 | 50 | 0 | 8 | **$0.00** |

## Limitations

- Output token counts are not in the transcripts; the "Output (est.)" column is estimated from visible text and tool-call input, divided by 4.
- The estimate excludes thinking tokens, so it undercounts real output token usage.
- Prices are Anthropic public list prices, not your actual billing (discounts, batch pricing and negotiated rates are not reflected).
