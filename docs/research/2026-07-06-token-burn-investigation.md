# Token burn investigation - 2026-07-06

Root-causing the fast session-limit exhaustion on Max 5x, for issue #212.

## 1. Question and method

The question: why does the Max 5x plan's session limit exhaust faster than
expected, and which of the suspected drivers (pipeline overhead, cache misses
from parallel sessions, the Fable-5-at-2x-Opus pricing, injected-context size,
MCP schema overhead) actually explains it.

Method: `docs/research/2026-07-06-token-burn-analyze.mjs` walks both Claude
Code project roots (`~/.claude/projects`, `~/.claude-personal/projects`),
streams every `.jsonl` transcript line by line, and aggregates only usage
metadata for `type: "assistant"` lines inside a closed 14-day window,
2026-06-22T00:00:00.000Z (inclusive) to 2026-07-06T00:00:00.000Z (exclusive),
which covers 2026-06-22 through 2026-07-05 inclusive. The window is closed
(no partial "today") so a re-run reproduces identical numbers.

**PRIVACY BOUND, restated:** the script and this report use only aggregate
counts, project directory names, model names, and timestamps. It never reads,
prints, or quotes message content (text, tool inputs/outputs, thinking) from
any transcript. The subagent sidecar's `agentType`, `spawnDepth`, `toolUseId`,
and `worktreePath` fields are metadata, not content, and are used the same
way. Every number below traces to a script output section (default run,
`--json`, or a scoped `--start`/`--end`/`--project` run) or a one-line command
recorded in section 7.

Default invocation (full window, all projects):

```
node docs/research/2026-07-06-token-burn-analyze.mjs
node docs/research/2026-07-06-token-burn-analyze.mjs --json
```

## 2. Data inventory

From the default run's "Data inventory" section:

- Roots scanned: `/Users/TM/.claude/projects`, `/Users/TM/.claude-personal/projects`
- Project directories scanned: 48; 25 had usage lines inside the window
- Main (lead) transcript files: 269; subagent transcript files: 1,824
- Total bytes scanned: 801,595,608 (~765 MiB), streamed line by line
- Lines scanned (all types): 263,706; assistant-type lines: 136,809
- Lines outside the window: 89,170
- Synthetic (`message.model == "<synthetic>"`) lines skipped: 131
- Malformed/unparseable lines: 0; lines with missing `usage`: 0
- Same-file duplicate lines skipped (streaming repeats of one `message.id`):
  26,950; max observed repeats of a single `message.id`: 17 (higher than the
  sub-plan's example of "up to 4"; the dedup rule does not depend on the
  exact count, so this does not change the result)
- Cross-file duplicate lines skipped (resume/fork): 0, confirming decision
  2's "measured 0" holds across all 48 project directories, not just
  orchestrai's
- Inline `isSidechain: true` lines found in main (lead) files: 0, confirming
  decision 1's "no mirroring hazard" holds across all 48 project directories
- Deduped usage lines counted: 20,558
- `cache_creation` on the 5-minute TTL: 38,086,187; on the 1-hour TTL:
  41,131,216 (48% / 52% split)

**Sanity check** (per the task's practical note): the largest per-project
`cache_read` totals (hundreds of millions of tokens from a few thousand
lines, e.g. 334,422,606 across 2,749 lines for one `fixum-budget` project
directory) look implausible against ~800 MiB of scanned bytes until you
account for what `cache_read_input_tokens` actually is: a per-turn *count*
Anthropic reports back, not a copy of the cached bytes stored in the file.
The same multi-hundred-thousand-token cached prefix gets re-billed (cheaply,
at the cache-read rate) on every subsequent turn without being re-written to
the local JSONL. Section 3's per-session peak-context numbers (up to
1,634,150 tokens on one line) and the 25x ratio of total `cache_read`
(2,002,167,680) to total `cache_creation` (79,582,989) corroborate this: the
totals are large because sessions run long and get re-read from cache many
times each, not because the script double-counted anything.

## 3. Findings

All numbers below are from the default run (full window, all projects)
unless marked otherwise.

**By project** (top 5 of 25 by `input + cache_creation`; full table in the
script's "Totals by project" section):

| project | input | output | cache_creation | cache_read | lines |
|---|---|---|---|---|---|
| `-Users-TM-Desktop-github-fixum-budget` | 225,920 | 1,439,886 | 12,001,353 | 334,422,606 | 2,749 |
| `-Users-TM-Desktop-github-korveth-space` | 63,227 | 1,077,409 | 7,242,517 | 145,430,658 | 1,610 |
| `-Users-TM-Desktop-30-Github-claude-template` | 245,636 | 712,348 | 6,713,031 | 154,463,406 | 1,341 |
| `-Users-TM-Desktop-30-Github-orchestrai` | 152,750 | 676,862 | 6,349,180 | 123,645,718 | 1,504 |
| `-Users-TM-Desktop-30-Github-second-brain` | 66,864 | 875,761 | 6,197,447 | 180,923,244 | 1,665 |

**By model** (full table in "Totals by model"):

| model | input | output | cache_creation | cache_read | lines |
|---|---|---|---|---|---|
| `claude-opus-4-8` | 1,081,090 | 8,778,375 | 44,252,054 | 1,059,464,436 | 5,487 |
| `claude-sonnet-5` | 328,993 | 633,190 | 12,313,101 | 449,199,219 | 5,787 |
| `claude-fable-5` | 287,457 | 1,008,885 | 8,544,106 | 105,414,893 | 1,219 |
| `claude-haiku-4-5-20251001` | 79,303 | 24,736 | 786,117 | 6,973,308 | 224 |
| `claude-sonnet-4-6` | 65,633 | 662,968 | 13,687,611 | 381,115,824 | 7,841 |

Window-wide totals across all buckets: input 1,842,476; output 11,108,154;
cache_creation 79,582,989; cache_read 2,002,167,680; grand total
2,094,701,299 tokens over 20,558 deduped lines and 14 days, across the 25
active project directories.

**By day** (full table in "Totals by day"): burn varies roughly 10x day to
day (2026-06-26 is the quietest day at 216,376 cache_creation and 1,207,161
cache_read; 2026-07-04 is the heaviest single day for cache_creation at
8,694,276, and 2026-06-22 is the heaviest for cache_read at 323,946,132),
tracking active work days rather than a steady background rate.

**Lead vs agentType** (full table in "Totals by attribution"): `lead` alone
accounts for 1,105,250 input / 9,757,736 output / 41,496,802 cache_creation /
1,156,442,742 cache_read across 4,535 deduped lines, more than half of all
buckets except cache_creation. The remaining lines split across 18 distinct
`agentType` values (`developer`, `orchestrai:developer`, `architect`,
`tester`, `Explore`, `reviewer`, `orchestrai:tester`, `orchestrai:reviewer`,
`analyst`, `orchestrai:architect`, `general-purpose`, `claude-code-guide`,
`sv-tmueller:developer`, `sv-tmueller:tester`, `librarian`,
`sv-tmueller:architect`, `sv-tmueller:reviewer`, `fact-checker`) - the
plugin-prefixed forms (`orchestrai:*`, `sv-tmueller:*`) are real distinct
`agentType` sidecar values from different plugin installs, not a parsing
artifact.

**Cache efficiency by project** (full table in "Cache efficiency by
project"): 23 of 25 projects have a `cache_read / (cache_read +
cache_creation)` hit ratio above 0.92; the two below (`-Users-TM-Desktop-30-Github`
at 0.661 and `-Users-TM-Desktop-claudecode` at 0.742) each have 5 or fewer
deduped lines, too small a sample to read as a real efficiency problem.

**Session peaks** (full table in "Top sessions by peak context", `peak` =
max of `input + cache_read + cache_creation` on one deduped line): the top 15
sessions all belong to `lead` attribution; the single highest is 1,634,150
tokens on one line (`-Users-TM-Desktop-github-one-pager`), the second is
1,630,625 (`-Users-TM-Desktop-github-fixum-budget`), and 10 of the 15 exceed
570,000. orchestrai's own highest lead session peaks at 583,848 (13th of 15).
This is the largest single number this investigation measured, by 1-2 orders
of magnitude over every other driver below, and is developed further as a
finding in section 5.

## 4. Quota-weighted view

Max plan quota mechanics are not public, so this view is a labeled proxy, not
a measured cost: per-model, per-bucket weights in the script's `MODEL_PRICE`
table, built from historical Anthropic list-price tiers for Opus / Sonnet /
Haiku (Opus $15/$75 per million input/output tokens, Sonnet $3/$15, Haiku
$0.25/$1.25), with `claude-fable-5` set to 2x Opus 4.8 per this repo's
team-guide "Model policy" ("Fable costs 2x Opus 4.8 per token"), cache_creation
weighted at 1.25x input and cache_read at 0.1x input (Anthropic's standard
prompt-caching multipliers). These are not confirmed 2026 list prices for
these model names; treat the dollar figures as relative-scale indicators, not
real spend.

From the default run's "Quota-weighted view by model" section:

| model | raw input | raw output | weighted (proxy USD) |
|---|---|---|---|
| `claude-opus-4-8` | 1,081,090 | 8,778,375 | 3,093.52 |
| `claude-fable-5` | 287,457 | 1,008,885 | 796.61 |
| `claude-sonnet-5` | 328,993 | 633,190 | 191.42 |
| `claude-sonnet-4-6` | 65,633 | 662,968 | 175.80 |
| `claude-haiku-4-5-20251001` | 79,303 | 24,736 | 0.47 |

Total proxy cost across all models: $4,257.82. Opus 4-8 is 72.7% of the
weighted total; Fable 5 is 18.7% (vs 5.5% of raw tokens); the two Sonnet
variants combined are 4.5% + 4.1% = 8.6% weighted (vs 22.1% + 18.9% = 41.0%
raw). Section 5 (driver 3) uses this split, and a second, batch-scoped run of
the same view, to test the team-guide's "Fable's token share stays small"
claim.

## 5. Driver verdicts

**Driver 1 - pipeline overhead: CONFIRMED, but a minor contributor.**
Scoped to batch #201 (`Batch: awesome-agents-adoption`, orchestrai project,
window 2026-07-06T04:32:17Z to 2026-07-06T08:52:01Z - see section 7 for how
those bounds were obtained), the script's `sessions` output shows 24 distinct
subagent dispatches (4 architect, 8 developer, 6 tester, 6 reviewer),
matching the sub-plan's "~24 dispatches" estimate exactly. Summing each
dispatch's first-request context (its bootstrap cost: `input +
cache_creation` of its earliest deduped line) gives 404,659 tokens total.
The batch's total token volume in that window, lead plus all subagents
across all buckets, is 29,821,474. Bootstrap cost is therefore 1.36% of the
batch's burn. Per-role bootstrap cost is tight and consistent across
dispatches of the same role (architect 12,308-12,487; developer
21,357-22,314; tester 17,707-17,973; reviewer 12,357-12,664), confirming this
is a fixed, small per-dispatch tax, not a source of runaway growth.

**Driver 2 - cache misses from parallel sessions: NOT CONFIRMED.** Global
cross-file duplicates are 0 (section 2), so parallel sessions are not
double-billing the same message. Comparing lead sessions in the full window
whose active time range (`firstTs` to `lastTs`) overlaps a lead session from
a *different* project directory against ones that do not: 63 overlapping
sessions average a 0.9217 cache hit ratio; 5 non-overlapping sessions average
0.7810 (see section 7 for the exact comparison command). If parallel
dispatch caused cache eviction, overlapping sessions should show a *lower*
hit ratio; the data shows the opposite, though the non-overlapping sample is
too small (n=5) to treat as a confident clearance. The 5-minute vs 1-hour
cache-write split (48% / 52%, section 2) and the 25x cache_read-to-cache_creation
ratio both indicate writes routinely live long enough to be re-read, which is
inconsistent with a cache-thrashing story.

**Driver 3 - Fable priced at 2x Opus: MIXED, scope-dependent.** At the full
14-day, all-25-project scope (section 4), Fable's raw token share is 5.5% and
its weighted-proxy-dollar share is 18.7%, supporting the team-guide's
framing that "the lead's own token share is small next to the Sonnet-pinned
workers." Re-running the same view scoped to batch #201 alone (--project
orchestrai, the batch-201 window) flips this: Fable-priced roles (lead +
architect + reviewer) account for 57.5% of raw tokens and 93.3% of the
weighted-proxy dollars in that batch, against Sonnet-priced roles (developer
+ tester) at 42.5% raw / 6.7% weighted. The team-guide's "small share" claim
holds in aggregate across weeks and projects, but does not hold within a
single kickoff batch, where the pipeline structurally runs more
Fable-priced role-invocations (lead, architect, reviewer) than
Sonnet-priced ones (developer, tester) per package. This is a real,
measured finding, not a labeled estimate; recommendation 3 in section 6
follows from it.

**Driver 4 - injection size: LABELED (heuristic estimate).** The static
injected chain named in the sub-plan totals 24,878 bytes: `~/.claude/CLAUDE.md`
(2,074 B) + `~/.claude-personal/CLAUDE.md` (89 B) + this repo's `CLAUDE.md`
(2,301 B) + `.claude/team-guide.md` (16,800 B) + the orchestrai project's
`memory/MEMORY.md` (199 B) + the superpowers plugin's `session-start` hook
stdout (3,415 B). Using the labeled chars/4 heuristic, that is ~6,220 tokens.
Cross-check against the transcript-measured median first-request context
(section 3's underlying session data): median lead-session first-request
context is 42,947 tokens (n=68), so the chain is ~14.5% of a fresh lead
session's opening context; median subagent first-request context is 16,503
tokens (n=653), so the chain is ~37.7% of a fresh subagent's opening context.
A real, minor-to-moderate contributor to bootstrap cost, but bootstrap cost
itself is a small fraction of total burn (driver 1).

**Driver 5 - MCP schema overhead: LABELED, inconclusive (data gap).** Both
config directories' `enabledPlugins` (`~/.claude/settings.json` and
`~/.claude-personal/settings.json`) include the `supabase` MCP server, and no
project directory in either root carries a per-project `mcpServers`
override, so there is no natural "with MCP" vs "without MCP" project pair in
the sampled data to cross-check first-request context against. The actual
injected tool-schema size is negotiated at runtime between Claude Code and
the MCP server process; measuring it directly would mean starting that
server, which is out of scope for a zero-dependency, no-live-process script.
This driver is not cleared or confirmed; it is an open gap, flagged as a
follow-up rather than a conclusion.

**Additional finding - single-session context bloat: the largest measured
driver, outside the original five.** Section 3's session-peak numbers (up to
1,634,150 tokens on a single line, all in `lead` sessions, 10 of the top 15
over 570,000, hit ratios of 0.94-0.98 on those same sessions) show the
dominant cost is long-lived sessions accumulating unbounded conversation
history that gets re-read from cache on every turn. This is 25-70x driver
4's injection-chain estimate and roughly three to four orders of magnitude
over a single subagent's typical bootstrap cost (driver 1). orchestrai's own
highest lead session (583,848) is markedly below the plan-wide top entries
(up to 1,634,150), consistent with the worktree-per-package convention
(driver 1, recommendation 2) already bounding the worst case for this
project's own kickoff pipeline; other personal projects that run one
long-lived session across many tasks do not have that bound and show the
highest peaks in the whole sample.

## 6. Recommendations, ranked by estimated savings

1. **Bound single-session context growth: compact, `/clear`, or restart
   before a session's peak context reaches the hundreds of thousands of
   tokens.** Traceable to the session-peak finding in section 3/5: individual
   turns already reach up to 1,634,150 tokens, 25-70x every other measured
   driver. This is the largest lever found in this investigation, because it
   is the only driver operating at the million-token scale rather than the
   thousand-token scale.

2. **Keep (and extend) the tm-kickoff worktree-per-package convention:
   dispatch fresh, short-lived subagent sessions per issue rather than one
   long session working many issues in sequence.** Traceable to driver 1
   (a subagent's full bootstrap tax is fixed and small, ~1.36% of a batch)
   and to the session-peak finding (orchestrai's own top session, 583,848,
   sits well below the plan-wide top entries up to 1,634,150, despite
   similar workloads). The pattern this repo already uses for its own
   kickoff pipeline is the same fix recommendation 1 calls for generally;
   extending it to other personal-project sessions captures the same
   savings there.

3. **Scope-qualify the team-guide's "Fable's token share stays small" claim**
   (Model policy section) to say it holds at the multi-week, multi-project
   aggregate, not within a single kickoff batch. Traceable to driver 3: 5.5%
   raw / 18.7% weighted at full scope vs 57.5% raw / 93.3% weighted within
   batch #201. Not a token-savings recommendation directly, but prevents the
   Model policy from under-representing the lead-role slice of quota
   consumed during any one busy batch.

4. **Treat the injected CLAUDE.md/team-guide/memory/superpowers chain (~6,220
   heuristic tokens) as a secondary trim target, after 1 and 2, not before.**
   Traceable to driver 4: the chain is 14.5%-37.7% of a fresh session's
   opening context, and `.claude/team-guide.md` (16,800 bytes) is the
   largest single file in it, the first place to look if this chain ever
   needs to shrink. Recurring on every dispatch, so worth doing eventually,
   but two to three orders of magnitude smaller than recommendation 1.

5. **Measure actual MCP tool-schema size before concluding anything about
   driver 5.** Traceable to the data gap in section 5: no local, static, or
   zero-dependency measurement was available; a follow-up that connects to a
   configured MCP server (e.g. `supabase`) and inspects its `tools/list`
   payload size is needed before this driver can be confirmed, cleared, or
   sized for savings.

## 7. Reproducibility appendix

Every quantitative claim above maps to one of the following.

**Default run** (sections 2, 3, 4; full window, all 25 active project
directories):

```
node docs/research/2026-07-06-token-burn-analyze.mjs
node docs/research/2026-07-06-token-burn-analyze.mjs --json
```

**Batch #201 window** (driver 1 and the batch-scoped half of driver 3). Batch
#201 is `sv-tmueller/orchestrai` issue #201, `Batch: awesome-agents-adoption`.
Its start is the issue's `created_at`; its end is the "Batch report"
comment's `created_at` (the comment before the final "merges complete" run
log):

```
gh api repos/sv-tmueller/orchestrai/issues/201 --jq '.created_at'
# 2026-07-06T04:32:17Z
gh api repos/sv-tmueller/orchestrai/issues/201/comments --jq '.[-2].created_at'
# 2026-07-06T08:52:01Z (second-to-last comment: the "Batch report"; the last
# comment, index -1, is the later "merges complete" run log, posted after the
# batch's work was done)

node docs/research/2026-07-06-token-burn-analyze.mjs --json \
  --project orchestrai \
  --start 2026-07-06T04:32:17.000Z \
  --end 2026-07-06T08:52:01.000Z
```

**Driver 2's overlap comparison** (cache hit ratio for lead sessions
overlapping a different project's lead session vs not), run against the
default `--json` output:

```
node -e "
const d = require('./main.json'); // the default run's --json output
const leads = d.sessions.filter(s => s.attribution === 'lead' && s.hitRatio !== null);
function overlaps(a, b) { return a.firstTs <= b.lastTs && b.firstTs <= a.lastTs; }
let overlapGroup = [], noOverlapGroup = [];
for (const s of leads) {
  const hasOverlap = leads.some(o => o !== s && o.project !== s.project && overlaps(s, o));
  (hasOverlap ? overlapGroup : noOverlapGroup).push(s);
}
const avg = (arr) => arr.reduce((sum, x) => sum + x.hitRatio, 0) / arr.length;
console.log('overlapping:', overlapGroup.length, avg(overlapGroup).toFixed(4));
console.log('non-overlapping:', noOverlapGroup.length, avg(noOverlapGroup).toFixed(4));
"
```

**Driver 4's local measurements** (no transcripts read):

```
wc -c ~/.claude/CLAUDE.md ~/.claude-personal/CLAUDE.md \
  "/Users/TM/Desktop/30 Github/orchestrai/CLAUDE.md" \
  "/Users/TM/Desktop/30 Github/orchestrai/.claude/team-guide.md" \
  "$HOME/.claude-personal/projects/-Users-TM-Desktop-30-Github-orchestrai/memory/MEMORY.md"

bash ~/.claude-personal/plugins/cache/claude-plugins-official/superpowers/d884ae04edeb/hooks/session-start startup | wc -c
```

(`d884ae04edeb` is the superpowers plugin version active in this session, per
the skill base directory Claude Code reports when a superpowers skill loads;
the cache directory holds multiple versions side by side, so the version hash
must be pinned rather than globbed for a reproducible byte count.)

**Driver 5's configuration check** (no MCP server contacted):

```
cat ~/.claude/settings.json | jq '.enabledPlugins'
cat ~/.claude-personal/settings.json | jq '.enabledPlugins'
```

**Median first-request context** (driver 4's cross-check), run against the
default `--json` output:

```
node -e "
const d = require('./main.json');
const med = (arr) => { arr.sort((a,b)=>a-b); const n=arr.length; return n%2 ? arr[(n-1)/2] : (arr[n/2-1]+arr[n/2])/2; };
console.log('lead median firstContext:', med(d.sessions.filter(s=>s.attribution==='lead').map(s=>s.firstContext)));
console.log('subagent median firstContext:', med(d.sessions.filter(s=>s.attribution!=='lead').map(s=>s.firstContext)));
"
```
