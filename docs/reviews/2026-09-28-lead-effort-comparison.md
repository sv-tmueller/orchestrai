# Lead effort comparison: Opus 5.5 at high vs xhigh - 2026-09-28

Issue #404, batch #403 (P1). Pre-registered protocol delta:
[2026-09-28-lead-effort-comparison-protocol.md](2026-09-28-lead-effort-comparison-protocol.md).
Per-run data and hashes:
[2026-09-28-lead-effort-comparison-data.json](2026-09-28-lead-effort-comparison-data.json).
Reused xhigh arm (O1-O3): #358's own files, unedited by this PR.

## 1. Bottom line

**Insufficient evidence. Keep the lead at xhigh.** All three new high-effort
runs (H1, H2, H3) failed a gate: H1 hit an HTTP 429 individual spend limit
after 4 turns; H2 and H3 each hit the new contamination gate (a `Glob` call
whose `path` argument scoped in the sibling 2026-09-23 trial root). The
high-effort arm has 0 valid runs out of 3, short of the decision rule's
"fewer than 2 valid runs in either arm" floor. No judge pass ran: the
protocol delta skips the judge below that same threshold. `.claude/team-guide.md`
is unedited; the rule's own decision is "keep xhigh," not "switch."

The batch's deferred run-phase measurement ("only if P1 shows high holds on
refinement," issue #403) is **not triggered**: P1 shows neither hold nor
fail, it shows no usable measurement.

Total new list-price spend for this package: **$2.5095844** (H1 $0.1806318
+ H2 $1.0894124 + H3 $1.2395402), against the protocol delta's $44 hard
ceiling. The reused O1-O3 runs cost nothing new today; their original
combined cost was $6.60 (#358's own data.json), not respent.

## 2. What killed each high-effort run

**H1 - HTTP 429, individual spend limit.** Died at 4 turns, `is_error: true`,
`terminal_reason: "api_error"`, `api_error_status: 429`, `result`: "You've
hit your individual spend limit · run /usage-credits to raise it, or visit
claude.ai/admin-settings/usage · your session limit resets 4:50pm
(Europe/Berlin)." Cost $0.1806318 before failing. Per the protocol delta's
"If blocked" clause, the run was marked invalid, not replaced; the
developer stopped launching further runs and treated it as a limit death.
On resume, the developer's own `date` command read 2026-09-28T14:52:04Z,
past the reset time (14:50 UTC / 16:50 CEST) read out of the run's own
`rate_limit_info.resetsAt` (unix `1790607000`), independently confirming
the reset before H2 launched (not solely trusting the resume prompt's own
claim). This is the same class of availability event #358's F3 hit (an
individual/session spend limit, not a per-model quota message); this trial
does not attempt to settle Max-vs-Pro or account-wide-vs-model-specific
questions any further than #358 already did.

**H2 and H3 - contamination gate, a structural gap, not a fluke.** Both
runs issued a `Glob` tool call with `path` set to
`/Users/TM/.cache/orchestrai-lead-trial` (the parent directory enclosing
*both* trial roots), rather than a path scoped to their own `repo/` or
`2026-09-28/` directory:

- H2: `{"pattern": "**/issues-open.json", "path":
  "/Users/TM/.cache/orchestrai-lead-trial"}`, and the result actually
  returned three matches, two of them under the 2026-09-23 sibling root
  (`_snapshot/issues-open.json` and `judge-repo/_snapshot/issues-open.json`).
  This is a real leak: the run observed that a `judge-repo/` directory
  exists in the old root, information a blinded run should not have.
- H3: `{"pattern": "**/_snapshot*", "path":
  "/Users/TM/.cache/orchestrai-lead-trial"}`, and the result was "No files
  found" (the pattern does not match a bare directory name, so nothing
  came back from either root).

Both were marked invalid. H3's call returned nothing, but the gate's own
text ("no tool input touches the 2026-09-23 root... a hit invalidates the
run") was applied literally, on the input's scope, not on whether content
happened to come back, so both runs get the same treatment rather than one
being excused by a pattern-matching accident. This keeps the call
mechanical instead of a judgment call that could look like it favors
whichever run has the more convenient outcome, especially since (section 3)
the decision-rule outcome is identical either way.

**Root cause, worth naming for any future trial using this allowlist:**
`--allowedTools` grants `Glob` by name with no path restriction, unlike the
`Bash(...)` entries, which restrict by literal command-string prefix. A run
that calls `Glob` with an absolute path one level above its own trial root
can sweep in a sibling directory with no allowlist entry able to stop it.
This is a different, more direct version of the "filesystem jail gap"
#358 already documented (reads reaching `~/.hermes/skills`): there, the
escape needed no unusual path argument, since `~/.hermes` sits outside any
clone entirely; here, the model had to actively supply a parent-directory
path, and did so independently in both H2 and H3, on two different
`Glob` patterns. Two for three is not enough to call this a > 50% failure
rate at n=3, but it is enough to say the isolation this protocol relies on
for the CLI-level lockdown (`--disallowedTools` on `Edit`/`Write`/`gh
*`/etc.) does not extend to read-only path scoping, and any future
high-vs-xhigh or model-vs-model trial reusing this same command block
should expect the same gap.

**A separate, non-invalidating hit, for completeness:** H3 also read
`/Users/TM/.hermes/skills/autonomous-ai-agents/orchestrai/SKILL.md` and
globbed that directory, the same `~/.hermes` filesystem-jail class #358
documented on F1, O1, and F2. `~/.hermes` is not on this protocol delta's
forbidden-path list (it is a live install, not this trial's own data), so
this does not invalidate H3 on its own; it is recorded here as the same
known limitation recurring, not a new gate failure.

## 3. Decision rule, applied

Per the protocol delta:

- A run is valid if it passes every #358 gate plus the new gates
  (`claude_code_version` match, the effort gate, the contamination gate)
  and was not budget-capped.
- H1: invalid (429, an availability failure unrelated to any gate content,
  but no result was ever produced to gate).
- H2: invalid (contamination gate).
- H3: invalid (contamination gate).
- High-effort arm: **0 valid runs**, short of the rule's 2-valid-run floor.
- xhigh arm (O1-O3, reused from #358): 3 valid runs, unchanged.

**"Fewer than 2 valid runs in either arm: insufficient evidence, keep
xhigh."** This branch fires cleanly; the score-gap and cost-ratio branches
of the rule are never reached, because the judge never ran (protocol
delta: judge is skipped below 2 valid high runs). Nothing about this
result is close to the switch threshold either way, it is a measurement
failure on this trial's own operational reliability (an account spend
limit plus a tool-scoping gap), not a quality or cost finding about
`--effort high` itself.

## 4. Per-run table

O1-O3 columns are copied from #358's own `data.json` (unedited); H1-H3 are
new. Cost is list price; tokens in thousands (K) except input (raw count).
No run spawned a subagent.

| Run | Arm | Model | Effort | Input | Cache write (1h) | Cache read | Output (of which thinking) | Cost (list) | Wall | Turns | Denials | Valid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | xhigh (reused) | Opus 5.5 | xhigh | 46 | 142.6K | 1,916.6K | 59.6K (46.7K) | $2.7167 | 9m50s | 49 | 0 | yes |
| O2 | xhigh (reused) | Opus 5.5 | xhigh | 34 | 96.1K | 1,150.3K | 48.8K (38.3K) | $1.9748 | 7m38s | 36 | 0 | yes |
| O3 | xhigh (reused) | Opus 5.5 | xhigh | 44 | 94.3K | 1,523.8K | 42.6K (32.1K) | $1.9110 | 7m24s | 38 | 0 | yes |
| H1 | high (new) | Opus 5.5 | high | 4 | 20.0K | 48.8K | 0.6K (0.02K), then a 429 | $0.1806 | 11s | 4 | 1 | **no (429)** |
| H2 | high (new) | Opus 5.5 | high | 28 | 80.7K | 701.4K | 15.2K (8.2K) | $1.0894 | 2m52s | 26 | 1 | **no (contamination)** |
| H3 | high (new) | Opus 5.5 | high | 40 | 65.7K | 1,324.6K | 22.5K (13.7K) | $1.2395 | 4m14s | 37 | 1 | **no (contamination)** |

**Per-arm means:** xhigh (n=3, all valid): mean cost $2.2008 (unchanged from
#358). High (n=0 valid of 3 launched): no mean; all three data points exist
only as invalidated runs, table above for transparency.

**Cost recomputed independently for all three new runs**, against the
Opus 5.5 row of #358's price table (`prices_usd_per_mtok` in the new
`data.json`, copied unedited from #358's):

- H1: 4x$4 + 19,966x$8 + 48,839x$0.20 + 556x$20, all /1e6 = $0.1806318,
  matching `total_cost_usd` exactly.
- H2: 28x$4 + 80,668x$8 + 701,382x$0.20 + 15,184x$20, all /1e6 =
  $1.0894124, matching exactly.
- H3: 40x$4 + 65,652x$8 + 1,324,621x$0.20 + 22,462x$20, all /1e6 =
  $1.2395402, matching exactly.

## 5. Gate results

| Run | Model matches | mcp empty | permissionMode | apiKeySource | CLI 2.1.280 | Budget-capped | Effort=high every turn | Contamination-clear |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | yes | yes | dontAsk | none | yes | no | yes (5 turns recorded, all high) | yes |
| H2 | yes | yes | dontAsk | none | yes | no | yes (37 turns, all high) | **no** |
| H3 | yes | yes | dontAsk | none | yes | no | yes (51 turns, all high) | **no** |

The effort gate holds on all three: every `perTurnEffort` recorded in each
run's own CLI session log
(`~/.claude-work/projects/-Users-TM--cache-orchestrai-lead-trial-2026-09-28-repo/<SID>.jsonl`)
is `high`, confirming the explicit `--effort high` flag won over
`~/.claude-work/settings.json`'s `modelSettings.claude-opus-5-5.effortLevel:
"high"` entry (which would have produced the same value anyway) and the
global `xhigh` default (which it did not).

`init` counted 7 plugins, 137 skills, 24 agents on all three H runs,
matching O1's own baseline exactly (the sub-plan's own drift check found no
actual difference despite the 2026-09-27 plugin update landing between the
two trial dates).

## 6. Reused xhigh arm: verification this session

Before any new run, this session verified (data unchanged, checks re-run
independently rather than trusted from the sub-plan comment):

- `runs/O{1,2,3}.jsonl` sha256 match `data.json`'s `raw_log_sha256` for
  each: `07396673e1...`, `141696a5ee...`, `8c051d1f52...`.
- `runs/O{1,2,3}.output.md` are byte-for-byte equal to `tail -1
  O{1,2,3}.jsonl | jq -r '.result'` (the same extraction #358 used), and
  byte-for-byte equal to #358's own blinded `_judge/R2.md`, `R3.md`,
  `R5.md`.
- CLI still `/opt/homebrew/bin/claude` v2.1.280.
- `pristine/` (the 2026-09-23 root's own copy, and the new 2026-09-28
  copy made from it) is at BASE `1730257e1d979bda7cd60967012165d8a4b236d1`,
  no remote, clean, in both roots.
- Snapshot and task-prompt sha256 match `data.json`'s recorded values in
  both roots.
- `redact.txt` was read only from the 2026-09-23 root, only when the
  scoped grep ran before each commit; never copied, never `cat`.

None of these checks failed, so this trial took the reuse branch (O1-O3
stand as the xhigh arm) rather than the else-branch (re-running the xhigh
arm as X1-X3 interleaved with H1-H3).

**Permission-denial recount** (matching the protocol delta's new gate 7):
#358's `data.json` recorded `permission_denial_count: 0` for every run, but
each run's raw `result.permission_denials` array is non-empty: O1 1, O2 1,
O3 2, F1 1, F2 1. Recorded in the new `data.json`'s `reused_from_358` block;
#358's own committed file is unedited.

## 7. No-writes check

`gh issue list --repo sv-tmueller/orchestrai --state all --search
"updated:>=2026-09-28T10:56:00Z"` and the equivalent `gh pr list`, run after
H3 completed: hits are #399, #400, #401, #403, #405 and PRs #402, #408 (this
package's own draft PR). All are expected: #403 is this batch's tracking
issue, #405 is batch #403's other package (P2), #399/#400/#401/#402 are a
separate, concurrently running batch. Nothing traces to a write by H1, H2,
or H3, all three of which ran with no GitHub credentials reachable
(`GH_CONFIG_DIR` pointed at an empty directory) and `Bash(gh *)`
disallowed.

## 8. Limitations

- **A limit death mid-package.** H1's 429 paused the package; the developer
  independently confirmed the reset time had passed (system clock read
  2026-09-28T14:52:04Z against a 14:50 UTC reset) before resuming with H2,
  rather than relying solely on the resume instruction's own claim.
- **The contamination gate's own design choice.** H3 was marked invalid on
  a tool-input scope match that returned zero content, the same as H2's
  match that returned real content. Section 2 explains the reasoning
  (consistency, avoiding a result-dependent judgment call); a reader who
  prefers an effect-only reading would keep H3 as the trial's one surviving
  high-effort data point, still short of the rule's 2-valid floor on its
  own, so the decision-rule outcome in section 3 is unchanged either way.
- **n=0 valid high-effort runs is not evidence against `--effort high`.**
  Every failure here was operational (an account-wide spend limit, a
  Glob path-scoping gap), not a quality or cost signal about the effort
  level itself. This report recommends *retrying* the high arm under a
  tighter Glob restriction and a cooldown from the xhigh arm's own spend,
  not concluding anything about high-effort quality.
- **No judge pass ran.** The protocol delta's own skip condition (fewer
  than 2 valid high runs) fired as designed; the rubric, redaction, and
  blinding machinery built for this trial (normalization step, judge-repo
  layout) were never exercised end to end.
- **Everything #358's own report already listed as a limitation for O1-O3**
  (n=3 xhigh only one task, one judge model family, cache warmth, headless
  no-user-turns, the filesystem-jail gap on `~/.hermes`) still applies to
  the reused arm; not repeated in full here, see that report's section 10.

## 9. Recommendation

Keep the lead at `--effort xhigh`. No change to `.claude/team-guide.md`.
Re-run P1 as a separate package if a future session wants a real
high-vs-xhigh signal: fix the `Glob` path-scoping gap first (either drop
`Glob` from `--allowedTools` in favor of `Bash(find "$TRIAL/repo" ...)`
patterns, or wrap the read-only tools in a sandboxed working directory), and
either wait out the account's spend-limit window before the high-effort arm
or split the two arms across separate windows.

## 10. Reproduction

- BASE, snapshot, task-prompt, rubric hashes: unchanged from #358, listed
  in the protocol delta file.
- New trial root layout: sibling to the 2026-09-23 root, not part of this
  PR (raw logs, transcripts, and the real Hermes provider host are never
  committed).
- Per-run raw log and stderr hashes: `data.json`'s `runs[].raw_log_sha256`
  / `stderr_sha256` for H1-H3; O1-O3 entries carry the same hashes #358
  already committed.
- CLI command: the protocol delta's "CLI" section, byte-identical to what
  ran, `$ID` swapped per run (`H1`, `H2`, `H3`).
- Cost formula: section 4 above, reproducible from `data.json`'s
  `tokens` block per run against the Opus 5.5 row of `prices_usd_per_mtok`.
