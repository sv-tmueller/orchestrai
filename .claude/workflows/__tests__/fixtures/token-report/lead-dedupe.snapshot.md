# Token report

- Session: fixture-session
- Window: full transcript
- Price source: fixture price list (retrieved 2026-09-27)

## By role

| Role | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est. where marked) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lead | 2 | 140 | 20 | 50 | 0 | 258 |

## By model

| Model | Calls | Input | Cache read | Cache write (5m) | Cache write (1h) | Output (est. where marked) | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5-5 | 1 | 100 | 20 | 50 | 0 | 246 | $0.01 |
| claude-sonnet-5 | 1 | 40 | 0 | 0 | 0 | 12 | $0.00 |
| **Total** | 2 | 140 | 20 | 50 | 0 | 258 | **$0.01** |

## Limitations

- Output: lead figures are measured from the lead transcript's `usage.output_tokens`. Subagent transcripts carry no reliable count, so subagent figures are visible text plus tool-call input divided by 4, marked "(est.)". A by-model or total figure that includes any estimate is marked too.
- The estimate leaves out thinking tokens, so it undercounts real output token usage.
- Prices are Anthropic public list prices, not your actual billing (discounts, batch pricing and negotiated rates are not reflected).
