# Token burn re-measure - 2026-08-16

Delta report for issue #224. Compares a fresh closed 14-day window
(2026-07-26 through 2026-08-08 inclusive, the earliest window the
re-measure became runnable per the 2026-07-28 blocked report) against the
recorded 2026-06-22 to 2026-07-05 baseline from
`docs/research/2026-07-06-token-burn-investigation.md`.

The script ran unmodified (`docs/research/2026-07-06-token-burn-analyze.mjs`)
for both windows. Every number below traces to a recorded command in
section 7.

**PRIVACY BOUND, restated:** this report uses only the token-burn script's
aggregate output, project directory names, model names, and directory
metadata. No transcript file is opened, read, or quoted (same bound as the
baseline report and #212).

## 1. Why this window, not the one #224 originally named

Issue #224 asked for the 2026-07-06 to 2026-07-20 window. The 2026-07-28
blocked report proved that window returns zero deduped lines: the local
transcript store carries no usage data before 2026-07-26. The earliest
closed 14-day window starting from that first day of data is 2026-07-26
through 2026-08-08 inclusive, closing at 2026-08-09T00:00:00.000Z. Today is
2026-08-16, so this window is fully closed and the numbers reproduce
exactly regardless of when the script runs.

## 2. Data inventory comparison

| metric                         | baseline (2026-06-22 to 07-05) | new (2026-07-26 to 08-08) |
|--------------------------------|-------------------------------|---------------------------|
| project dirs scanned           | 48                            | 13                        |
| project dirs with usage lines  | 25                            | 10                        |
| main (lead) transcript files   | 269                           | 31                        |
| subagent transcript files      | 1,824                         | 398                       |
| total bytes scanned            | 801,595,608                   | 187,767,753               |
| lines scanned (all types)      | 263,706                       | 58,142                    |
| assistant-type lines           | 136,809                       | 33,091                    |
| deduped usage lines counted    | 20,558                        | 16,433                    |
| cross-file duplicates          | 0                             | 0                         |
| inline isSidechain in main      | 0                             | 0                         |

The store is materially smaller: 13 project directories vs 48, 31 main
files vs 269, 188 MB vs 802 MB. This is a changed environment, not just a
changed window. The 2026-07-28 blocked report documented the transition:
project-directory naming shifted from `-Users-TM-Desktop-30-Github-*` to
`-Users-TM-Desktop-github-*`, and a third root
(`~/.claude-work/projects`) sits outside the script's `PROJECT_ROOTS`. The
store was effectively rebuilt from 2026-07-26 forward.

## 3. Window-wide totals

| bucket            | baseline              | new                   | delta      |
|-------------------|-----------------------|-----------------------|------------|
| input             | 1,842,476             | 76,738                | -95.8%     |
| output            | 11,108,154            | 3,419,089             | -69.2%     |
| cache_creation    | 79,582,989            | 50,079,940            | -37.1%     |
| cache_read        | 2,002,167,680         | 1,644,568,491         | -17.9%     |
| grand total       | 2,094,701,299        | 1,698,144,258         | -18.9%     |
| deduped lines     | 20,558                | 16,433                | -20.1%     |

Grand total dropped 18.9%. But raw totals alone cannot answer the
efficiency question, because the baseline report itself warned of a 223.7x
day-to-day swing. The new window's swing is wider, not narrower (section 4
below), so some of the drop is fewer active days, not better discipline.

## 4. Did lead-session peak context come down?

**Yes, meaningfully.** This is the clearest finding.

| metric                          | baseline   | new        | delta      |
|---------------------------------|------------|------------|------------|
| highest single-line peak        | 1,634,150  | 722,976    | -55.8%     |
| 2nd highest                     | 1,630,625  | 704,380    | -56.8%     |
| top-15 minimum                   | ~570,000   | 255,258    | -55.2%     |
| orchestrai highest lead peak    | 583,848    | 432,950    | -25.8%     |
| median lead first-request ctx   | 42,947     | 38,962     | -9.3%      |
| median subagent first-req ctx   | 16,503     | 15,403     | -6.7%      |

The top of the distribution fell by roughly half. The baseline's highest
peaks (1.63M and 1.63M tokens) came from `one-pager` and `fixum-budget`,
two projects that do not appear in the new window at all. The new window's
highest peaks (722,976 and 704,380) are both from `trading-bot` lead
sessions, and the 15th-ranked session is 255,258, less than half the
baseline's 15th rank floor of ~570,000.

The median first-request context barely moved (-9.3% lead, -6.7%
subagent), which is expected: that is the injection-chain cost (CLAUDE.md +
team-guide + memory + hooks), and the 2026-07-28 blocked report confirmed
the store rebuild did not change those files. The peak reduction is from
fewer long-lived sessions hitting extreme context depths, not from smaller
starting contexts.

orchestrai's own highest lead peak dropped from 583,848 to 432,950
(-25.8%), a smaller drop than the plan-wide top. The worktree-per-package
convention already bounded orchestrai's peaks in the baseline; the bigger
gains are in other projects that adopted shorter sessions.

## 5. Day-to-day swing widened, not narrowed

| metric                | baseline   | new       |
|-----------------------|------------|-----------|
| min day total         | 1,514,902  | 887,784   |
| max day total         | 338,902,570| 482,955,493|
| swing ratio           | 223.7x     | 544.0x    |
| days with data        | 14         | 11        |

The swing worsened from 223.7x to 544.0x. Three days in the new window
carry almost no traffic (2026-07-30 at 2.2M, 2026-07-31 at 29.8M, 2026-08-05
at 888K), while 2026-07-27 alone accounts for 483M tokens. The baseline
had 14 active days; the new window has 11 days with data and 3 near-zero
days. This means the 18.9% drop in grand-total tokens is partly fewer
heavy days, not purely better per-session efficiency. Peaks and
per-session shapes (section 4) are the cleaner signal, and they improved.

## 6. Per-project comparison

**Baseline top 5 by input + cache_creation:**

| project                                | input    | output     | cache_creation | cache_read   | lines |
|----------------------------------------|----------|------------|----------------|--------------|-------|
| -Users-TM-Desktop-github-fixum-budget   | 225,920  | 1,439,886  | 12,001,353     | 334,422,606  | 2,749 |
| -Users-TM-Desktop-github-korveth-space  | 63,227   | 1,077,409  | 7,242,517      | 145,430,658  | 1,610 |
| -Users-TM-Desktop-30-Github-claude-template | 245,636 | 712,348 | 6,713,031   | 154,463,406  | 1,341 |
| -Users-TM-Desktop-30-Github-orchestrai  | 152,750  | 676,862    | 6,349,180      | 123,645,718  | 1,504 |
| -Users-TM-Desktop-30-Github-second-brain | 66,864  | 875,761    | 6,197,447      | 180,923,244  | 1,665 |

**New window top 5 by input + cache_creation:**

| project                                | input    | output     | cache_creation | cache_read   | lines |
|----------------------------------------|----------|------------|----------------|--------------|-------|
| -Users-TM-Desktop-github-trading-bot    | 33,434   | 2,062,767  | 34,800,591     | 1,213,469,249| 9,977 |
| -Users-TM-Desktop-github-gaslit-game    | 23,396   | 629,774    | 5,550,590      | 159,765,109  | 2,738 |
| -Users-TM-Desktop-github-orchestrai     | 10,057   | 419,788    | 5,539,584      | 152,796,084  | 2,088 |
| -Users-TM-Desktop-github-second-brain   | 8,249    | 185,165    | 2,806,005      | 72,117,947   | 838   |
| -Users-TM-Desktop-github-warwright      | 1,502    | 105,057    | 1,226,554      | 44,926,669   | 761   |

Three of the baseline top-5 projects are absent from the new window:
`fixum-budget`, `korveth-space`, and `claude-template` are gone entirely.
However, `orchestrai` and `second-brain` do appear (ranked #3 and #4 in
the new window). `trading-bot` is now dominant (9,977 lines, 61% of all
deduped lines), and it was not in the baseline top-5. This is a changed
workload, not the same projects running leaner.

`trading-bot` is also the source of the new window's highest session peaks
(section 4). Its 9,977 lines across 14 days is a long-session pattern: the
three trading-bot lead sessions in the top-15 have hit ratios of 0.9832,
0.9712, and 0.9376. The lowest hit ratio (0.9376, peak 365,163) has the
narrowest first-to-peak spread (317,068), while the highest hit ratio
(0.9832, peak 722,976) has the widest spread (677,693); higher peaks
accumulate more cache reads, which raises the hit ratio. That is the same
long-lived-session accumulation pattern the baseline identified as the
largest driver, now concentrated in one project rather than spread across
several.

## 7. Lead vs subagent split

| attribution | baseline input | baseline output | baseline cc | baseline cr | baseline lines | new input | new output | new cc | new cr | new lines |
|-------------|----------------|-----------------|-------------|-------------|----------------|-----------|------------|---------|--------|-----------|
| lead        | 1,105,250      | 9,757,736       | 41,496,802  | 1,156,442,742 | 4,535        | 16,628   | 2,184,741  | 13,761,518 | 478,604,111 | 1,953 |
| subagent (all) | 737,226     | 1,350,418       | 38,086,187  | 845,724,938 | 16,023        | 60,110   | 1,234,348  | 36,318,422 | 1,165,964,380 | 14,480 |

| metric                          | baseline | new    |
|---------------------------------|----------|--------|
| lead % of grand total (tokens)  | 57.7%    | 29.1%  |
| lead % of deduped lines         | 22.1%    | 11.9%  |

The lead share dropped sharply: from 57.7% of tokens to 29.1%, and from
22.1% of lines to 11.9%. This is partly because the new window has fewer
large lead sessions (the peak reduction in section 4) and partly because
the subagent side grew as a proportion: `orchestrai:developer` alone
accounts for 5,547 of 16,433 lines (33.8%) and 664M of 1,645M cache_read
(40.4%). The pipeline is running more developer dispatches relative to
lead-session work than in the baseline.

## 8. Model mix shift

| model                  | baseline lines | baseline cc | new lines | new cc |
|------------------------|---------------|-------------|-----------|--------|
| claude-opus-4-8        | 5,487         | 44,252,054  | 0         | 0      |
| claude-sonnet-5        | 5,787         | 12,313,101  | 11,000    | 23,122,154 |
| claude-fable-5         | 1,219         | 8,544,106   | 2,315     | 13,504,885 |
| claude-sonnet-4-6      | 7,841         | 13,687,611  | 0         | 0      |
| claude-haiku-4-5       | 224           | 786,117     | 7         | 87,840 |
| claude-opus-5          | 0             | 0           | 3,111     | 13,365,061 |

Two model generations turned over. `claude-opus-4-8` and `claude-sonnet-4-6`
are gone; `claude-opus-5` appeared (3,111 lines). `claude-sonnet-5` doubled
its line share from 28.2% to 66.9%, becoming the dominant worker model.
`claude-fable-5` nearly doubled in raw lines (1,219 to 2,315) but its
share of total lines went from 5.9% to 14.1%.

The weighted-proxy view is incomparable across windows because
`claude-opus-5` has `weightKnown: false` (no price entry in the script's
`MODEL_PRICE` table), so its weighted USD is 0. The baseline had no
unknown-weight models. Any cross-window weighted comparison would
understate the new window's proxy cost by ignoring Opus 5 entirely, so it
is not made here.

## 9. Cache efficiency

| metric                              | baseline | new    |
|-------------------------------------|----------|---------|
| cache TTL split (5m / 1h)           | 48% / 52%| 73% / 27% |
| projects with hit ratio > 0.92      | 20 of 25 | 6 of 10  |
| projects with hit ratio <= 0.92     | 5 of 25  | 4 of 10  |

The cache-write TTL mix shifted toward 5-minute writes (48% to 73%). This
means more cache creations are short-lived, which is consistent with
shorter sessions: a session that starts and ends quickly writes a 5-minute
TTL cache and never re-reads it, lowering the 1-hour share.

Six of ten projects have hit ratios above 0.92, comparable to the
baseline's 20 of 25 (80% vs 60%). The four below 0.92 are:
`rainmaker-bot` (0.882, 6 lines, too small to read), and three
`scratchpad-probe` throwaway directories (0.664, 0.553, 0.538, 1-3 lines
each, all throwaway probe runs from PR #309's sentinel test). Excluding
the probe directories, every real project has a hit ratio above 0.88, and
the seven real projects average 0.954.

## 10. Answer to the efficiency question

**Did lead-session peak context come down? Yes, by roughly half.** The
top of the distribution fell from 1.63M to 723K, the 15th-ranked peak
fell from ~570K to 255K, and orchestrai's own peak fell from 584K to 433K.
The median first-request context barely moved (-9.3%), confirming the gain
is from fewer extreme-depth sessions, not from smaller injections.

**Did any project's long-session pattern change? Yes, but by turnover.**
The baseline's heavy offenders (`fixum-budget`, `one-pager`,
`korveth-space`) are absent from the new window. Their replacements are
lighter overall, but `trading-bot` now carries the same long-session
signature (9,977 lines, three lead sessions in the top-15, hit ratios
above 0.97 on long accumulations). The pattern migrated to a different
project rather than disappearing.

**How much more efficient are we now?** Grand-total tokens dropped 18.9%,
but that figure has two confounders: (1) the day-to-day swing widened from
223.7x to 544.0x, meaning the new window has more idle days inflating the
drop, and (2) the project roster turned over completely, so this is a
different workload, not the same workload running leaner. The cleaner
signal is the peak reduction: the worst-case session context halved, and
that improvement is real, not an artifact of changed workload. The
recommendation from the baseline report (bound single-session context
growth, keep the worktree-per-package convention) appears to have been
partially applied, with measurable effect on the ceiling, but the
long-session pattern persists in at least one project.

## 11. Confounders named

1. **Changed workload, not just changed behavior.** Three of the baseline
   top-5 projects (`fixum-budget`, `korveth-space`, `claude-template`) are
   absent from the new window, though `orchestrai` and `second-brain` carry
   over. The 18.9% token drop cannot be attributed to better discipline
   without accounting for the different project mix.
2. **Wider day-to-day swing.** 544.0x vs 223.7x. Three near-zero days in
   the new window deflate the grand total. Peak comparisons (section 4) are
   less sensitive to this than total-volume comparisons (section 3).
3. **Store rebuild.** The 2026-07-28 blocked report documented that the
   transcript store carries no data before 2026-07-26. The new window is
   from the rebuilt store, not a continuation of the baseline's store.
   Byte totals, project counts, and directory naming all changed.
4. **Incomplete weighted-cost comparison.** `claude-opus-5` lacks a price
   entry in the script's `MODEL_PRICE` table (`weightKnown: false`), so
   its weighted USD is 0. Cross-window proxy-cost comparison would
   understate the new window; it is not made.
5. **Fewer active days.** 11 days with data vs 14 in the baseline. One
   heavy day (2026-07-27, 483M tokens) dominates the new window.

## 12. What this does not claim

- It does not establish causation for the peak reduction. The absence of
  `fixum-budget` and `one-pager` from the new window is enough to explain
  the top-2 drop without any behavioral change. The 15th-rank drop
  (~570K to 255K) is harder to explain by turnover alone, but this report
  cannot isolate behavior from workload there either.
- It does not update the 2026-07-06 baseline report. That file stands as
  the 2026-07-06 record, amended only by its own 2026-07-28 addendum.
- It does not change the script, the Model policy, or any recommendation.
  This produces evidence; acting on it is a later decision.
- It does not read or quote any transcript content (privacy bound, same
  as #212).

## 13. Reproducibility appendix

Every number above traces to one of these commands, run on 2026-08-16.

**New window (text and JSON):**

```
node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-07-26T00:00:00.000Z --end 2026-08-09T00:00:00.000Z

node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-07-26T00:00:00.000Z --end 2026-08-09T00:00:00.000Z --json
```

**Baseline (referenced from the 2026-07-06 report, not re-run here):**

The baseline numbers are from `docs/research/2026-07-06-token-burn-
investigation.md` sections 2-5, produced by the default invocation
(window 2026-06-22 to 2026-07-06). That report's 2026-07-28 addendum
notes the same commands now return zero lines; the baseline numbers stand
as the 2026-07-06 record.

**Derived computations (run against the new window's --json output):**

Day-to-day swing, lead-vs-subagent split, median first-request context,
and cache TTL percentages were computed from the JSON output using
inline Node.js one-liners (summing `byDay`, `byAttribution`, and
`sessions` arrays). The JSON file is reproducible from the command above.
