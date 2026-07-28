# Token burn re-measure blocked - 2026-07-28

Records why issue #224's re-measure (the 2026-07-06 to 2026-07-20 delta
against the 2026-06-22 to 2026-07-05 baseline) cannot run today, and when it
becomes possible. Follows the arm B (opus) architect's NEEDS_DECISION on
scratch issue #288 (`docs/reviews/2026-07-27-ab-judgment-seats.md`), option A.

**PRIVACY BOUND, restated:** this report uses only the token-burn script's
aggregate output, project directory names, and directory metadata (`ls`,
`du`, `find` on file modification times). No transcript file is opened,
read, or quoted.

## 1. What this records

Issue #224 asks for a delta report between a fresh 14-day window and the
2026-06-22/2026-07-05 baseline. That comparison cannot run today: the local
transcript store has no usage data before 2026-07-26, so every window #224
names returns zero lines. The earliest date the re-measure becomes possible
is 2026-08-09.

## 2. Probes and output

All three commands below were run fresh in this session, against
`docs/research/2026-07-06-token-burn-analyze.mjs`, unmodified.

**Probe 1, the window #224 asks for:**

```
node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-07-06T00:00:00.000Z --end 2026-07-20T00:00:00.000Z
```

```
Window: 2026-07-06T00:00:00.000Z (inclusive) to 2026-07-20T00:00:00.000Z (exclusive)

## Data inventory

- roots scanned: /Users/TM/.claude/projects, /Users/TM/.claude-personal/projects
- project directories scanned: 6
- main (lead) transcript files: 12
- subagent transcript files: 147
- total bytes scanned: 72,708,521
- lines scanned (all types): 21,698
- assistant-type lines: 12,334
- lines outside window: 12,334
- synthetic (error placeholder) lines skipped: 0
- malformed/unparseable lines: 0
- lines with missing usage: 0
- same-file duplicate lines skipped (streaming repeats): 0
- cross-file duplicate lines skipped (resume/fork): 0
- max observed repeats of one message.id: 0
- inline isSidechain:true lines found in main (lead) files: 0
- deduped usage lines counted: 0
- cache_creation on 5-minute TTL: 0
- cache_creation on 1-hour TTL: 0
```

`deduped usage lines counted: 0`, so every table below this block in the
script's output (by project, by model, by day, by attribution, cache
efficiency, quota-weighted view, top sessions) is empty. Confirmed by
reading the actual output; not assumed from the zero count.

**Probe 2, the baseline window (bare default invocation, the exact command
recorded in the baseline report's section 7):**

```
node docs/research/2026-07-06-token-burn-analyze.mjs
```

```
Window: 2026-06-22T00:00:00.000Z (inclusive) to 2026-07-06T00:00:00.000Z (exclusive)

## Data inventory

- roots scanned: /Users/TM/.claude/projects, /Users/TM/.claude-personal/projects
- project directories scanned: 6
- main (lead) transcript files: 12
- subagent transcript files: 147
- total bytes scanned: 72,729,195
- lines scanned (all types): 21,707
- assistant-type lines: 12,340
- lines outside window: 12,340
- synthetic (error placeholder) lines skipped: 0
- malformed/unparseable lines: 0
- lines with missing usage: 0
- same-file duplicate lines skipped (streaming repeats): 0
- cross-file duplicate lines skipped (resume/fork): 0
- max observed repeats of one message.id: 0
- inline isSidechain:true lines found in main (lead) files: 0
- deduped usage lines counted: 0
- cache_creation on 5-minute TTL: 0
- cache_creation on 1-hour TTL: 0
```

Same result: zero deduped lines, every table below empty. The total-bytes
figure (72,729,195) differs from probe 1's (72,708,521) by a few thousand
bytes even though both ran within the same minute; the store is being
actively appended to during this session, which is expected given section 3
below, not a measurement error.

**Probe 3, all data to the last closed UTC day:**

```
node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-01-01T00:00:00.000Z --end 2026-07-28T00:00:00.000Z
```

Run on 2026-07-28 UTC, so the end is today's UTC midnight, a closed window.

```
## Data inventory

- roots scanned: /Users/TM/.claude/projects, /Users/TM/.claude-personal/projects
- project directories scanned: 6
- main (lead) transcript files: 12
- subagent transcript files: 147
- total bytes scanned: 72,747,441
- lines scanned (all types): 21,717
- assistant-type lines: 12,347
- lines outside window: 203
- synthetic (error placeholder) lines skipped: 24
- malformed/unparseable lines: 0
- lines with missing usage: 0
- same-file duplicate lines skipped (streaming repeats): 6,189
- cross-file duplicate lines skipped (resume/fork): 0
- max observed repeats of one message.id: 9
- inline isSidechain:true lines found in main (lead) files: 0
- deduped usage lines counted: 5,931
- cache_creation on 5-minute TTL: 13,825,211
- cache_creation on 1-hour TTL: 3,312,532

### Totals by day

day | input | output | cache_creation | cache_read
--- | --- | --- | --- | ---
2026-07-26 | 6,533 | 314,124 | 4,077,892 | 129,175,423
2026-07-27 | 15,440 | 750,563 | 13,059,851 | 469,129,639
```

The "Totals by day" table has exactly two rows: 2026-07-26 and 2026-07-27.
The earliest day carrying usage lines is confirmed as **2026-07-26**,
matching the arm B architect's #288 finding; the recorded Not-before date of
2026-08-09 (section 5) is not carried through unchecked, it is verified
against this table.

## 3. Environment delta against the baseline

The baseline report's section 2 recorded, from the default run on
2026-07-06: 48 project directories, 801,595,608 total bytes.

The fresh default run (probe 2, this session, 2026-07-28) shows: 6 project
directories, 72,729,195 total bytes. This is not the 2026-07-27 figure from
scratch issue #288 (the arm B architect's prior observation, one day
earlier); it is a fresh number from probe 2 above, and it differs from
#288's because the store is append-only and grew by a day.

Project directory naming changed. `ls -1 ~/.claude/projects
~/.claude-personal/projects` shows `-Users-TM-Desktop-github`,
`-Users-TM-Desktop-github-orchestrai`, `-Users-TM-Desktop-github-second-brain`,
`-Users-TM-Desktop-github-trading-bot`, `-Users-TM-Desktop-github-warwright`.
The baseline report's section 3 project table names directories like
`-Users-TM-Desktop-30-Github-claude-template` and
`-Users-TM-Desktop-30-Github-orchestrai`. The pattern changed from
`-Users-TM-Desktop-30-Github-*` to `-Users-TM-Desktop-github-*`: the `30 `
segment is dropped and `Github` is lowercased.

A third root, `~/.claude-work/projects`, sits outside the script's
`PROJECT_ROOTS` (`~/.claude/projects` and `~/.claude-personal/projects`
only). `ls -1 ~/.claude-work/projects` lists six project directories. `du
-sk` on the two in-roots directories plus this third root gives 8 KB, 74,284
KB, and 1,204 KB (du covers the third root only; the two in-roots byte
totals are cited from the script's own inventory above, so they trace to
the same run as the zero-line result). `find ~/.claude-work/projects -type f
-name '*.jsonl' | wc -l` counts 12 files; the same command with `!
-newermt '2026-07-26 00:00'` counts 0. That command measures file
modification time, not message timestamps: no `.jsonl` file under the third
root has an mtime older than 2026-07-26 00:00 local time.

## 4. What this does not claim

No cause is established for why the transcript store carries no data before
2026-07-26. File modification time is not a message timestamp; the mtime
check in section 3 says only that no file under the third root is older than
2026-07-26, not when any message inside it was written. Including the third
root in `PROJECT_ROOTS` would not recover data from before 2026-07-26 either,
since it holds nothing older than that date. `PROJECT_ROOTS` is recorded as
an observation here, not changed; the script stays byte-identical. Option B
from the #288 architect output (re-target to the single closed day
2026-07-26, peaks-only) was considered and not taken; this report follows
option A only.

## 5. When the re-measure becomes possible

First day carrying usage lines: 2026-07-26 (section 2, probe 3). First
closed 14-day window starting there: 2026-07-26 through 2026-08-08
inclusive. That window closes at 2026-08-09T00:00:00.000Z, so the
re-measure is runnable starting 2026-08-09, with:

```
node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-07-26T00:00:00.000Z --end 2026-08-09T00:00:00.000Z
```

## 6. Reproducibility appendix

Every command below was run on 2026-07-28 (this session). Directory names,
byte totals, and file counts are specific to this machine's transcript
store and will not reproduce on another machine or after further store
growth.

```
node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-07-06T00:00:00.000Z --end 2026-07-20T00:00:00.000Z
node docs/research/2026-07-06-token-burn-analyze.mjs
node docs/research/2026-07-06-token-burn-analyze.mjs \
  --start 2026-01-01T00:00:00.000Z --end 2026-07-28T00:00:00.000Z
ls -1 ~/.claude/projects ~/.claude-personal/projects
ls -1 ~/.claude-work/projects
du -sk ~/.claude/projects ~/.claude-personal/projects ~/.claude-work/projects
find ~/.claude-work/projects -type f -name '*.jsonl' | wc -l
find ~/.claude-work/projects -type f -name '*.jsonl' ! -newermt '2026-07-26 00:00' | wc -l
```
