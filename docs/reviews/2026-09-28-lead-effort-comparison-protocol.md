# Lead effort comparison: Opus 5.5 at high vs xhigh - protocol delta, 2026-09-28

Pre-registered for issue #404 (batch #403). This is a delta against the
frozen protocol for #358
([2026-09-23-lead-model-comparison-protocol.md](2026-09-23-lead-model-comparison-protocol.md)):
same task, same BASE, same snapshot, same rubric, same judge setup, same CLI.
The only frozen-command change is `--effort high` in place of `--effort
xhigh`. This file is frozen once committed and pushed; any later change is a
deviation, logged in the report. Not a `/tm-ab-test` run.

## What changes from #358, what does not

**Reused as-is (checked this session, before any new run):**

- BASE: `1730257e1d979bda7cd60967012165d8a4b236d1`. The new trial root's
  `pristine/` copy is at this SHA, no remote, clean.
- Snapshot: `_snapshot/issues-open.json` and `prs-open.json`, sha256
  `d75cb1973f9ca8e2218f91841b2ee17a3c4102b1bd9b2167fc6df97ec54d618b` and
  `3676d9f89775e3acedf921c9c5c269dd146c13d7745a5f89fecdf96c98ff5c9e`, matching
  `data.json`'s `snapshot_sha256`.
- Task prompt: byte-identical, sha256
  `429284cf98429a3a7deb9677b554bb40a2fdb177a883f0a9d41d5aa35605a4ac`.
- Rubric: byte-identical, sha256
  `4c46bdf86922eed3f37f461c49e440f27aa6b9d77eb7bf29c9c5c23b35d63f9a`.
- CLI: `/opt/homebrew/bin/claude` v2.1.280, same build as #358.
- The three Opus 5.5 xhigh runs from #358, O1-O3, stand in as this trial's
  xhigh arm, unmodified: `runs/O{1,2,3}.jsonl` hash to the `raw_log_sha256`
  values recorded in `2026-09-23-lead-model-comparison-data.json`
  (`07396673e1...`, `141696a5ee...`, `8c051d1f52...`, all verified this
  session); `runs/O{1,2,3}.output.md` equal each log's own `.result` (`jsonl`
  tail extraction, verified byte-for-byte this session) and are
  byte-identical to #358's blinded `_judge/R2.md`, `R3.md`, `R5.md` (also
  verified this session). Effort was xhigh: the CLI's own session logs under
  `~/.claude-work/projects/-Users-TM--cache-orchestrai-lead-trial-2026-09-23-repo/`
  record every turn of all three sessions at `perTurnEffort: xhigh` (82, 48,
  and 59 turns respectively); the stream-json run logs carry no effort field
  of their own, so those session logs are the only proof of effort for O1-O3.
- `redact.txt` in the 2026-09-23 root is read only at redaction time, never
  copied into the new root, never `cat`.

Fallback check, done before any new run: CLI version and the three O-hashes
above both still match. Neither failed, so this trial takes the reuse
branch, not the else-branch (re-running the xhigh arm as X1-X3 interleaved
with H1-H3).

**New for this trial:**

- A new sibling trial root, `~/.cache/orchestrai-lead-trial/2026-09-28/`
  (the real path is not repeated outside this developer's own filesystem;
  the 2026-09-23 root is left untouched as the reused arm's evidence).
  `pristine/`, `_snapshot/`, and `task-prompt.md` copied over; `gh-empty/`
  created fresh; `_snapshot/` sits next to `repo/`, not inside it, matching
  #358's actual layout rather than this protocol's own prose describing it.
- Three new high-effort runs, H1, H2, H3, `claude-opus-5-5`, `--effort high`
  as the only change to the frozen CLI block below, strictly sequential,
  never two runs overlapping, each in its own disposable `repo/` copy
  recreated from `pristine/` with `cp -R` before every run.
- `--max-budget-usd 8` per high-effort run (about 3x the most expensive #358
  Opus run, $2.72), not the $50 cap #358 used; logged as a deviation from
  the old cap, not from the frozen task or model.
- One fresh judge pass over all six outputs (O1, O2, O3, H1, H2, H3), run
  outside both lead trial roots. #358's own scores for O1-O3 are reported
  alongside the new pass's O1-O3 scores as a judge-stability check, but the
  decision rule below uses only the new pass's scores for all six runs.
- One added redaction-normalization step: any run date later than the
  snapshot date, and any trial-root path, is replaced with a placeholder
  before judging; the snapshot's own timestamp is never touched; each
  replacement is logged. A run's own relative-time language (e.g. "this
  week") is logged, not rewritten.

## CLI (delta: effort and budget only)

```sh
rm -rf "$TRIAL/repo" && cp -R "$TRIAL/pristine" "$TRIAL/repo"; mkdir -p "$TRIAL/runs"
SID=$(uuidgen | tr 'A-Z' 'a-z'); START=$(date -u +%Y-%m-%dT%H:%M:%SZ); T0=$(date +%s)
cd "$TRIAL/repo" && env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  CLAUDE_CONFIG_DIR="$HOME/.claude-work" GH_CONFIG_DIR="$TRIAL/gh-empty" \
  /opt/homebrew/bin/claude -p --model claude-opus-5-5 --effort high \
    --output-format stream-json --verbose --session-id "$SID" \
    --permission-mode dontAsk --strict-mcp-config --max-budget-usd 8 \
    --allowedTools "Read,Grep,Glob,Agent,Task,Bash(git log *),Bash(git show *),Bash(git diff *),Bash(git grep *),Bash(git ls-files *),Bash(ls *),Bash(cat *),Bash(head *),Bash(tail *),Bash(wc *),Bash(grep *),Bash(rg *),Bash(find *),Bash(jq *)" \
    --disallowedTools "Edit,Write,NotebookEdit,Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git commit *),Bash(git push *),Bash(git remote *),Bash(curl *)" \
    < "$TRIAL/task-prompt.md" > "$TRIAL/runs/$ID.jsonl" 2> "$TRIAL/runs/$ID.stderr"; RC=$?
WALL=$(( $(date +%s) - T0 ))
```

Everything else in #358's "CLI" section (permission-mode fallback, never
`--dangerously-skip-permissions`, never `--fallback-model`, never
`CLAUDE_CODE_SUBAGENT_MODEL`, strictly sequential runs, commit after every
run, the per-run gates) applies unchanged.

## New gates per high run (in addition to #358's gates)

- Init event `claude_code_version` is `2.1.280`.
- Effort gate: in
  `~/.claude-work/projects/-Users-TM--cache-orchestrai-lead-trial-2026-09-28-repo/<SID>.jsonl`,
  every `perTurnEffort` is `high` and at least one exists.
- Contamination gate: no tool input touches the 2026-09-23 root,
  `~/.claude-work/projects/*.jsonl`, any `*lead-model-comparison*` file (the
  marketplace clone under `~/.claude-work/plugins/marketplaces/orchestrai/`
  contains the #358 report), `*.output.md`, or the developer's own checkout
  or worktree. A hit invalidates the run.
- Recomputing O1-O3's metrics from the raw logs with the same extraction as
  #358 used: #358's `data.json` recorded `permission_denial_count: 0` for
  every run, but each run's raw `result.permission_denials` array is
  non-empty (1 for O1, 1 for O2, 2 for O3, and 1 each for F1, F2). This is
  noted in the new report as a recount, not a correction to #358's own
  committed file, which is left unedited.

## Drift between arms, named as a limitation, not a trigger

- The orchestrai plugin updated 2026-09-27, after O1-O3 ran and before
  H1-H3 run; the skill/agent counts in the system prompt differ between
  O1's init event and H1's (compared directly in the report: O1 recorded 7
  plugins, 137 skills, 24 agents).
- `~/.claude-work/settings.json` changed 2026-09-27 (also carries
  `modelSettings.claude-opus-5-5.effortLevel: "high"` next to the global
  `xhigh` default; on 2026-09-23 the explicit `--effort xhigh` flag won for
  O1-O3, and the explicit `--effort high` flag governs H1-H3 here; only the
  effort gate above proves it per run, not this config file).
- The run date is 5 days later than O1-O3's.
- `~/.hermes` is unchanged except curator backups.

None of these are a pre-registered trigger for anything; they are named so
the report's comparison is read as "today's Opus 5.5 at high, with 5 days of
drift, vs. 2026-09-23's Opus 5.5 at xhigh," not as a same-instant paired
trial.

## Budget caps

- High-effort runs: `--max-budget-usd 8` per run, about 3x the most
  expensive #358 Opus run ($2.72); a deviation from #358's $50 cap, logged
  here rather than discovered mid-report.
- Judge: `--max-budget-usd 10`, one retry only if its output does not parse
  as JSON.
- The judge is skipped if fewer than 2 of H1-H3 are valid (result:
  insufficient evidence, keep xhigh, per the decision rule below).
- Expected total across the new work (3 high runs + 1 judge pass): about
  $9-10. Hard ceiling on this reuse branch: $44 (3 x $8 + $10 judge + 1
  retry x $10, plus headroom). The re-run branch, not triggered, would have
  added the X1-X3 re-run cost, ceiling $68.
- Both arms are costed from token buckets at #358's price table
  (`prices_usd_per_mtok` in `2026-09-23-lead-model-comparison-data.json`,
  Opus 5.5 row); `modelUsage.costUSD` is used only as a cross-check, any
  mismatch logged as a price change.

## Decision rule (pre-registered before H1)

- A run is valid if it passes every #358 gate plus the new gates above, and
  was not budget-capped.
- Fewer than 2 valid runs in either arm (xhigh: O1-O3; high: H1-H3):
  **insufficient evidence, keep xhigh**.
- Switch the lead to `--effort high` only if both hold:
  1. Mean judge score at high is no more than 1.0 point (out of 20) below
     the xhigh mean.
  2. Mean list-price cost per run at high is no more than 0.80x the xhigh
     mean. (The xhigh arm's three valid runs ranged $1.91-$2.72; a smaller
     cost gap than this is noise at n=3.)
- Anything else: **keep xhigh**.
- Scores from the new, single judge pass over all six outputs only;
  #358's own O1-O3 scores are reported next to them as a judge-stability
  check, not used in the rule.
- The report also states whether the batch's own deferred run-phase
  measurement (distinct from this refine-task measurement) is now
  triggered.

If the rule says switch: the only file edited is `.claude/team-guide.md`,
and only a refinement-only note (advisor sections 1-2 may run at `high`,
linked to the report, flipped back to `xhigh` before replying "dispatch").
`tiers.lead` in `.claude/adapters/claude-code.json` and `SEAT_EXPECTATIONS`
in `effort-policy.test.mjs` are not touched: both are guarded, outside this
package's contract, and editing either would extend this refine-task result
to the unmeasured run phase.

## Blinding

- Redact all six outputs the same way as #358: model names and model IDs,
  `Generated with` / `Co-Authored-By` lines, every host in `redact.txt`,
  replaced with `https://provider.example.com`.
- New normalization step (this trial only): replace any run date later than
  the snapshot date (2026-09-23), and any trial-root path, with a
  placeholder; never touch the snapshot's own timestamp; log every
  replacement made. A run's own relative-time language referring to "this
  week" or similar is logged, not rewritten.
- Label R1-R6 by sorted sha256 of the six redacted files, so label order
  carries no information about run order, arm, or model.
- A manual pass checks for missed self-identification, the same as #358.
- Run the judge outside both lead trial roots
  (`~/.cache/orchestrai-judge/2026-09-28/judge-repo`, with `_snapshot/` and
  `_judge/` inside its own pristine copy); "effort" and "high"/"xhigh" are
  kept out of every path used by the judge run.
- After the judge run, scan its own CLI session log for any tool input path
  under `orchestrai-lead-trial/`; a hit is logged as a possible blinding
  breach and named in the report, not silently fixed.
- Unblinding (mapping R1-R6 back to run IDs, arms, and effort levels)
  happens only after the scores are committed to the new `data.json`.

## Redacting the real host

- `redact.txt` is read only from the 2026-09-23 root, only at redaction
  time; never copied, never `cat`.
- Before every commit in this package: a scoped grep for every line in
  `redact.txt` (ugrep, no `--exclude-dir` support, explicit file lists) over
  every file changed relative to `origin/main`, judge `why` text in the new
  `data.json` included. Every count must be zero.
- Not repo-wide: the real host is still present on `main` (PR #353 open), so
  a repo-wide grep always hits; that hit is not cited as a redaction
  failure in this package.
- Only hashes and metrics are committed; raw logs, transcripts, and the
  snapshot itself never are.

## Order of work

1. Pre-flight (no model calls): CLI version, O1-O3 hashes, new sibling
   trial root, `gh auth status` against the empty config dir reports not
   logged in, `redact.txt` stays in the old root. Done, this session,
   before this file was written.
2. This protocol delta: commit and push, draft PR opened with `Closes
   #404`, before H1 starts.
3. H1, H2, H3, strictly one at a time. After each: gates, commit
   `data.json` (`docs: record lead effort run H<n> (#404)`).
4. Blind: redact, normalize, manual pass, labels.
5. Judge (only if at least 2 of H1-H3 are valid): gates, commit scores,
   then unblind.
6. No-writes check (`gh ... --search updated:>=<H1 start>`); hits from
   #403, #404, #405, and their PRs are expected, nothing else.
7. Report: `docs/reviews/2026-09-28-lead-effort-comparison.md`, decision
   rule stated first; a per-run table (score, list-price cost, output
   tokens, thinking tokens, wall-clock, turns; denials, spawns, and word
   count as unscored columns).
8. `.claude/team-guide.md` edited only if the rule says switch.
9. Checks: `npm test`; the scoped host grep above; no em dashes or banned
   phrases in the new files; the report's scores equal `data.json`'s; one
   run's cost recomputed by hand; #358's three files (protocol, report,
   data.json) unchanged.

## Verification

- `npm test` passes.
- The diff that introduces this protocol delta touches exactly the new
  `docs/reviews/2026-09-28-lead-effort-comparison*` files (plus
  `.claude/team-guide.md` only if the decision is switch).
- This file's commit-and-push time is earlier than H1's start, and no
  later commit edits this file.
- Each new run's init `model` field matches what was requested
  (`claude-opus-5-5`), and the effort gate above passes.
- One run's cost is recomputed independently from its token buckets and
  matches the reported figure.
- The report's per-run scores equal what is stored in the new `data.json`.
- No em dashes or banned phrases in the new committed files.
- None of the `redact.txt` hosts appear in any new committed file.
- `2026-09-23-lead-model-comparison-protocol.md`,
  `2026-09-23-lead-model-comparison.md`, and
  `2026-09-23-lead-model-comparison-data.json` are byte-identical to BASE.

## If blocked

If `claude -p` cannot launch from the developer's own shell (sandbox,
keychain, or the nested-session check), the package reports `BLOCKED` with
the prepared command block above. No bypass flag is used to work around it.
On an HTTP 429 or spend-limit error mid-trial: the run is marked invalid,
not replaced; no further run is launched; the package parks `needs-human`
with the reset time if shown; on resume, the next unstarted run launches.
