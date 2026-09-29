# A/B native vs kickoff: protocol - 2026-09-28

Pre-registered for issue #400 (batch #399), one pair, both arms headless.
Frozen at the commit that introduces this file on `feat/400-ab-native-vs-kickoff`
(the PR that carries `Closes #400`). Record that commit's SHA and timestamp
before Part 2 starts (`git log -1 --format='%H %cI' -- docs/reviews/2026-09-28-ab-native-vs-kickoff-protocol.md`).
Any change to this file after that commit is a logged deviation in Part 2's
report. This is not a `/tm-ab-test` run (that skill is user-typed only and
its supervised-arm path does not fit a headless native arm); section 11 lists
every departure.

The spec for this file is the architect's SUB_PLAN comment on #400 and the
owner's delta comment posted after it. The delta overrides the sub-plan
wherever they differ. This document folds both into one runnable protocol
for a single pair on #362.

## 1. Task and base

| | Task | Reference PR | Merge commit | Base (merge parent) |
| --- | --- | --- | --- | --- |
| T2 | #362 Fail CI when seat or skill behavior changes without a version bump | #386 | `0a34bf2e3e6e19d74eefc4e96365a0ab90c7680c` | `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589` |

Verified: `git rev-list --parents -n1 0a34bf2` prints
`0a34bf2e3e6e19d74eefc4e96365a0ab90c7680c 1b4b8c5f5c95d28f06b417cf862b253bb7e3e589`,
one parent only, so "first parent" is unambiguous. `gh pr view 386` confirms
`mergeCommit.oid` is the same SHA and `baseRefName` is `main`. The base
commit `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589` is itself the merge commit
of #384 ("feat: per-batch token-usage report (#379) (#384)"), one commit
behind `main` at merge time for #386.

**Why #362, not #364.** The architect's sub-plan originally paired #379
(replayed from `aba6cb4e`) with #364. The owner's delta drops #379 and the
T1 pair entirely (single headless pair only) and keeps the #364-to-#362 swap
from the sub-plan: #364 (PR #373) rewrites the machinery arm A itself runs
on (`tm-kickoff/SKILL.md`, `reviewer.md`, `team-guide.md`,
`role-contracts.md`), is mostly prose with one test line, so a diff-review
pass would mostly measure critic variance, and its body already carries
signed-off design decisions both arms would just transcribe. #362 is code
with a right answer (a zero-dependency guard script, tests, a CI job), sized
`M`, based one day behind `main`, changes no seat behavior, and its own
batch decision (the 2.4.0 version bump) applies identically to both arms.

## 2. Replay environment

`$TRIAL=~/.cache/orchestrai-ab-400/`. One base branch, pushed by the lead in
Part 2 before any arm runs:

```sh
git fetch origin
git push origin 1b4b8c5f5c95d28f06b417cf862b253bb7e3e589:refs/heads/ab/400-base-t2
```

Before every arm launch, `git ls-remote origin ab/400-base-t2` must still
show `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589`. `main` may move freely; only
this pinned branch matters to the arms.

### Clone recipe (one per arm, one per judge candidate)

```sh
TRIAL=~/.cache/orchestrai-ab-400
mkdir -p "$TRIAL"
git clone --single-branch --no-tags --branch ab/400-base-t2 \
  git@github.com:sv-tmueller/orchestrai.git "$TRIAL/<name>"
cd "$TRIAL/<name>"
git branch -m ab/400-base-t2 main
git config --unset-all remote.origin.fetch
git config --add remote.origin.fetch "+refs/heads/ab/400-base-t2:refs/remotes/origin/main"
git config --add remote.origin.fetch "+refs/heads/<scratch-branch-glob>:refs/remotes/origin/<scratch-branch-glob>"
git fetch origin
```

`<name>` is `A-t2` or `B-t2` for the two arms, `judge-X` or `judge-Y` for the
two pass-1 judge clones (section 8). `<scratch-branch-glob>` is
`feat/<scratch-issue>-*` and `fix/<scratch-issue>-*` for that clone's own
scratch issue number only (arm A fetches its own scratch branches, arm B
fetches its own; a judge clone fetches nothing further, it gets its diff
applied as a local commit instead, see section 8). The rewrite means the
developer contract's `git checkout --detach origin/main` lands on the pinned
base, `/code-review` diffs against the right base, and no post-base commit on
the real `main` is reachable from the clone.

**Gate, run after every `git fetch origin` in a clone and before the task
prompt is submitted:**

```sh
[ "$(git rev-parse origin/main)" = "1b4b8c5f5c95d28f06b417cf862b253bb7e3e589" ] \
  && echo "gate ok: origin/main == base" || echo "GATE FAIL: origin/main != base"
git rev-list --all | grep -qx 0a34bf2e3e6e19d74eefc4e96365a0ab90c7680c \
  && echo "GATE FAIL: reference merge reachable" || echo "gate ok: reference merge absent"
```

A launch that fails either line is fixed and relaunched before it counts as
an arm (per the decision rule's validity clause, section 9).

### Plugin off

Every arm and judge session (all headless) runs with
`--settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}'`
(the plugin's current skills carry the reference solution to #362: a
version-bump guard). **Gate:** inspect the session's first stream-json event
(`type: "system", subtype: "init"`) for its plugin listing; confirm no entry
named `orchestrai` or `orchestrai@orchestrai` is reported active. If that
event does not carry a legible plugin field in this CLI build, or the
override otherwise cannot be confirmed, log it as a deviation in Part 2's
report rather than assuming the override took.

### Base-era pipeline for arm A

Inside the base clone, the project-level `.claude/` is the pipeline as it
stood one commit before #362 merged: it lacks #395, #397, #398 and #384
(the token-report feature itself, irrelevant to a #362 replay). None of
those changes a seat's core job; the report names this as a caveat, not a
contamination risk.

## 3. Scratch issues

Two, both filed before any arm runs: **T2-A** (arm A's copy) and **T2-B**
(arm B's copy). Same title, same body, differ only in which arm uses them.

Title (original title only, no `AB #362-arm-X:` prefix, which would point at
the original issue):

```
Fail CI when seat or skill behavior changes without a version bump
```

Body: #362's body verbatim (`gh issue view 362 --json title,body`), minus its
`Part of batch #378` line, plus the replay-rules trailer with the base branch
filled to `ab/400-base-t2`:

```
## What to build

Seat and skill behavior can change on `main` without a version bump, and installed copies then silently keep the old behavior (see the stale-2.2.0 issue filed alongside this one). Add a CI check. It fails a PR that changes `.claude/agents`, `.claude/skills` or `.claude/workflows` without changing the `plugin.json` version, unless the PR carries an explicit skip label for changes that do not affect behavior.

## Acceptance criteria

- [ ] CI fails on a PR touching seat, skill or workflow files with no version change.
- [ ] CI passes when the version changes, or when the skip label is present.
- [ ] The team guide names the rule and the skip label.

## Non-goals

- Auto-bumping the version.
- Deciding the semver level (the author decides).


## Batch decisions (signed off on #378)

- This PR also bumps `plugin.json` to 2.4.0 and lists the changes since 2.3.0. It merges last in the batch.
- Guarded paths: `.claude/agents`, `.claude/skills`, `.claude/workflows` (excluding `__tests__`) and `.claude/adapters`. `team-guide.md` and `process-core.md` are imported from the marketplace clone and are not guarded.
- The CI job pins `timeout-minutes` and runs under the existing concurrency group.

---
Replay rules (this task is being re-run; the same rules apply to every run):
- Work only from this issue body and this checkout. Do not open, list, or search
  GitHub issues or pull requests numbered #378 or higher, except this issue and
  the pull request that closes it. Do not read commits, branches, or files outside
  this checkout's history.
- In this checkout, `origin/main` is pinned to the replay base. Branch from it as
  usual. Open any pull request against `ab/400-base-t2`, not `main`.
```

Filing commands (run twice, once per scratch issue, body from a local file
to preserve formatting):

```sh
gh issue create --title "Fail CI when seat or skill behavior changes without a version bump" \
  --body-file scratch-t2-body.md --label "ab-test" --label "size:M"
```

Record each returned issue number as `<T2-A>` / `<T2-B>` for every command
below. Labels `ab-test` and `size:M`, per the sub-plan.

## 4. Launch commands

Shared shell setup for every headless invocation (arm and judge alike):

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work"
ENV_WRAP() { env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" "$@"; }
CLAUDE=/opt/homebrew/bin/claude
```

`env -i` drops the parent session's own environment so it cannot leak into
the trial. `HOME` is kept so `gh` resolves its normal config under
`$HOME/.config/gh` (arm A needs real `gh` access to open the scratch issue's
PR; nothing here narrows its GitHub credentials, unlike a read-only judging
run).

### Arm A, pipeline, headless (`--max-budget-usd 25`)

```sh
SID_A=$(uuidgen | tr 'A-Z' 'a-z')
cd "$TRIAL/A-t2"
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode auto \
  --output-format stream-json --verbose --session-id "$SID_A" --max-budget-usd 25 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  "/tm-kickoff #<T2-A>" \
  > "$TRIAL/A-t2/run1.jsonl" 2> "$TRIAL/A-t2/run1.stderr"
```

Kickoff always stops after posting its wave plan. The lead resumes once with
the fixed confirmation:

```sh
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode auto \
  --output-format stream-json --verbose --resume "$SID_A" --max-budget-usd 25 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  "Confirmed. Run the wave." \
  > "$TRIAL/A-t2/run2.jsonl" 2> "$TRIAL/A-t2/run2.stderr"
```

**Questions and parks.** If, while still live, the session surfaces a
question that is not a formal kickoff park (for example an `AskUserQuestion`
call, or text asking the lead to decide something), resume once more with
the fixed reply, same command shape:

```sh
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode auto \
  --output-format stream-json --verbose --resume "$SID_A" --max-budget-usd 25 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  "Decide yourself from the issue body." \
  > "$TRIAL/A-t2/run<N>.jsonl" 2> "$TRIAL/A-t2/run<N>.stderr"
```

If the pipeline instead reaches a formal park (`needs-human` applied,
whatever the reason: a question with no answer available, a blocker, or an
exhausted fix-round cap), the arm ends there. Per the owner's delta this is
always a valid end state now (headless, no owner to relay to), overriding the
sub-plan's original "relay to the owner and re-run" path for a question-park.
A PR marked ready is the other end state. If `claude -p` itself cannot
launch, Part 2 is BLOCKED and parks; there is no in-session fallback, since
that would contaminate the lead's own context with the reference solution.

### Arm B, native, headless, four chained invocations (`--max-budget-usd 15` each)

Plan mode, then three `auto`-mode follow-ups, one `--resume` chain, one
scratch issue, mirroring "plan, approve, execute, review, one fix pass" with
the human's approval and follow-ups replaced by fixed text (the owner's
delta; no interactive session, no owner attention).

```sh
SID_B=$(uuidgen | tr 'A-Z' 'a-z')
cd "$TRIAL/B-t2"

# 1. plan
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode plan \
  --output-format stream-json --verbose --session-id "$SID_B" --max-budget-usd 15 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  "Implement GitHub issue #<T2-B>." \
  > "$TRIAL/B-t2/run1.jsonl" 2> "$TRIAL/B-t2/run1.stderr"

# 2. approve and execute
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode auto \
  --output-format stream-json --verbose --resume "$SID_B" --max-budget-usd 15 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  "Approved. Implement the plan." \
  > "$TRIAL/B-t2/run2.jsonl" 2> "$TRIAL/B-t2/run2.stderr"

# 3. review
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode auto \
  --output-format stream-json --verbose --resume "$SID_B" --max-budget-usd 15 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  "/code-review" \
  > "$TRIAL/B-t2/run3.jsonl" 2> "$TRIAL/B-t2/run3.stderr"

# 4. fix, test, commit, push, open the PR
ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh --permission-mode auto \
  --output-format stream-json --verbose --resume "$SID_B" --max-budget-usd 15 \
  --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
  'Fix the findings from that review that you agree are real problems. Run npm test, commit, push, and make sure a draft pull request against ab/400-base-t2 exists with "Closes #<T2-B>".' \
  > "$TRIAL/B-t2/run4.jsonl" 2> "$TRIAL/B-t2/run4.stderr"
```

Same question-handling as arm A: any mid-chain question gets
`"Decide yourself from the issue body."` as an extra `--resume` turn before
continuing to the next fixed step. `/code-review` is the local slash command,
never `ultra`. This is one review pass and one fix pass; the chain stops
after invocation 4 regardless of outcome.

## 5. Fixed texts

- Wave-plan confirmation (arm A): `Confirmed. Run the wave.`
- Question reply (either arm, any time a question surfaces mid-run):
  `Decide yourself from the issue body.`
- Arm B prompt 1 (plan mode): `Implement GitHub issue #<T2-B>.`
- Arm B prompt 2 (auto mode): `Approved. Implement the plan.`
- Arm B prompt 3 (auto mode): `/code-review`
- Arm B prompt 4 (auto mode):
  `Fix the findings from that review that you agree are real problems. Run npm test, commit, push, and make sure a draft pull request against ab/400-base-t2 exists with "Closes #<T2-B>".`

No other text is ever sent to either arm.

## 6. Measures, per arm

Owner attention is not measured by this run (both arms headless; see
section 11 item 9 and the decision rule's attention line, section 9).

- **Cost.** `token-report.mjs`, pinned by blob SHA `46f0b3d597017efc19c7350ef96feed263fd8e57`
  (confirmed via `git hash-object .claude/skills/tm-kickoff/token-report.mjs`
  against this PR branch's committed copy). Run it in place (so its sibling
  `token-prices.json` resolves), from a checkout at or after the freeze
  commit, once per arm's session id (a `--resume` chain keeps one session
  id, so one command covers all of an arm's invocations):
  ```sh
  git hash-object .claude/skills/tm-kickoff/token-report.mjs   # must equal 46f0b3d597017efc19c7350ef96feed263fd8e57
  node .claude/skills/tm-kickoff/token-report.mjs --session "$SID_A" --config-dir "$HOME/.claude-work"
  node .claude/skills/tm-kickoff/token-report.mjs --session "$SID_B" --config-dir "$HOME/.claude-work"
  ```
  Same method both arms; judging sessions are excluded from this figure.
- **Output calibration.** On arm A's lead session(s), compare the
  stream-json `result` event's actual `modelUsage` output-token count against
  `token-report.mjs`'s estimate for the same calls, giving the adjusted-R
  scale factor used in the decision rule.
- **Wall-clock.** Capture `T0` before arm A's `run1` and arm B's `run1`
  launch, `T1` after the arm's end state is reached (PR ready, or the park
  that ends it). `WALL=$((T1 - T0))`, minus any explicit wait on a usage or
  spend-limit reset (recorded separately, per the owner's "wait for the
  reset and resume" instruction).
- **Agent count.** Subagent transcript files under
  `$HOME/.claude-work/projects/<slug-for-the-clone-path>/<session-id>/subagents/agent-*.jsonl`,
  cross-checked against the role table (arm A: up to lead, architect,
  developer, tester, reviewer; arm B: the main session only, plus any
  `Task`/`Agent` tool subagent it chooses to spawn on its own).
- **Diff size.** `git diff --stat ab/400-base-t2 <arm's PR branch tip>`, run
  inside that arm's own clone after `git fetch origin`.
- **Checks.** `npm test` at each arm's tip (`git checkout <tip-sha> && npm test`
  inside the clone); AC drift from the reconciliation pass (section 8); count
  of in-arm fix rounds, parks, permission denials, and limit events from the
  transcripts.
- **Touchpoints.** The driving shell's own command log: timestamp,
  invocation number, and the verbatim fixed text sent, per arm. This is the
  full attention record for a headless run; there is no separate stopwatch.

## 7. Contamination

**Detection, T2 only** (a `rg` sweep over each arm's own transcripts,
run after that arm ends):

```
#386
pull/386
0a34bf2
feat/362-version-bump-guard
fix/362-version-bump-guard
gh (issue|pr) (view|list|diff|checks)
gh search
github\.com/sv-tmueller/orchestrai/(pull|commit|blob|tree|compare)
Desktop/github/orchestrai
plugins/marketplaces/orchestrai
<the other arm's scratch issue number>
<the other arm's scratch PR number>
```

The last two lines are filled in once both scratch issues exist (section 3);
the `gh (issue|pr) (view|list|diff|checks)` line covers any number from #378
up other than the arm's own scratch issue and PR.

**Classification.** The lead classifies every hit, the tester re-checks in
Part 2:

- **READ**: the reference solution (PR #386 or `0a34bf2`), the other arm's
  work, or a later checkout entered the session's context. The arm is
  invalid.
- **MENTION**: an identifier only, with no content read (for example the
  `skip-version-bump` label appearing in a plain label list). Valid, logged.

Owner-equivalent text beyond the fixed prompts in section 5 does not occur in
this run (no interactive owner), but if any unscripted text is ever sent
(for example during a fix-round retry the lead has to hand-drive), and it
names a path, function, flag, label or design choice that appears in the
reference diff but not in the scratch issue body, it counts as READ.

There is no T1 in this run, so the T1-only publishing-risk scan (frozen
transcript redaction) from the sub-plan does not apply.

## 8. Blind judging

One pair, so 2 pass-1 runs (candidates X and Y) plus 1 reconciliation run,
not the sub-plan's 4-and-2 for two pairs.

1. Per arm, inside that arm's clone: `git diff --binary ab/400-base-t2 <tip> -- . ':!docs/plans' ':!docs/superpowers'`,
   saved to `$TRIAL/blind/raw-A.patch` / `raw-B.patch`. The path excludes
   process files under `docs/plans/` and `docs/superpowers/` at generation
   time; record that the exclusion fired (or that there was nothing to
   exclude) for each arm.
2. Replace every occurrence of the arm's own scratch issue and PR numbers in
   each patch with `362` (the original task number), recording each
   replacement made. Save the results as `$TRIAL/blind/redacted-A.patch` and
   `redacted-B.patch`.
3. `sha256sum` both redacted patches. The one that sorts lower is label `X`,
   the other is `Y`. Write `$TRIAL/blind/mapping.json`:
   `{"task": "362", "labels": {"X": {"arm": "A"|"B", "sha256": "..."}, "Y": {"arm": "A"|"B", "sha256": "..."}}}`.
   Before judging starts, the lead posts only `sha256sum $TRIAL/blind/mapping.json`
   (the mapping file's own hash, not its contents) on the #400 issue or PR.
   After all three passes are saved, the lead posts `mapping.json` itself.
4. **Judge clone per candidate** (`judge-X`, `judge-Y`), using the recipe in
   section 2 with the patch applied as one commit:
   ```sh
   git clone --single-branch --no-tags --branch ab/400-base-t2 \
     git@github.com:sv-tmueller/orchestrai.git "$TRIAL/judge-X"
   cd "$TRIAL/judge-X"
   git branch -m ab/400-base-t2 main
   git remote remove origin
   git checkout -b candidate
   git apply --binary "$TRIAL/blind/redacted-X.patch"
   git -c user.name=candidate -c user.email=candidate@example.invalid add -A
   git -c user.name=candidate -c user.email=candidate@example.invalid \
     commit -m candidate
   ```
   Repeat for `judge-Y` with `redacted-Y.patch`. `HEAD^` in each judge clone
   is `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589`, the base SHA to hand the
   workflow.
5. **Pass 1, two runs** (one per candidate). Fresh headless session,
   `claude -p --model 'opus[1m]' --effort xhigh`, plugin off (section 2's
   `--settings`), empty `GH_CONFIG_DIR`, `--disallowedTools "WebFetch,WebSearch,Bash(gh *)"`:
   ```sh
   cd "$TRIAL/judge-X"
   GH_CONFIG_DIR="$TRIAL/gh-empty" mkdir -p "$TRIAL/gh-empty"
   ENV_WRAP "$CLAUDE" -p --model 'opus[1m]' --effort xhigh \
     --output-format stream-json --verbose --max-budget-usd 10 \
     --settings '{"enabledPlugins":{"orchestrai@orchestrai":false}}' \
     --disallowedTools "WebFetch,WebSearch,Bash(gh *)" \
     "Run the tm-review-changes workflow on this checkout: Workflow({ name: 'tm-review-changes', args: { base: '1b4b8c5f5c95d28f06b417cf862b253bb7e3e589' } }). Do not change anything. When it finishes, print its final report as JSON, verbatim, and nothing else." \
     > "$TRIAL/blind/pass1-X.jsonl" 2> "$TRIAL/blind/pass1-X.stderr"
   ```
   Repeat for `judge-Y`. The workflow file
   (`.claude/workflows/tm-review-changes.js`) is pinned by blob SHA
   `0f940c3f2314a0846d0db3ffb164bc4684ebe73e`, confirmed identical at the
   base commit `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589` and at `main`
   (`git hash-object .claude/workflows/tm-review-changes.js` against both,
   see the verification appendix). Since #362 does not touch
   `.claude/workflows/`, neither candidate is expected to touch the
   workflow's own files; if one does, stop and log it instead of running
   pass 1 on that candidate.
6. **Pass 2, one reconciliation run.** Fresh read-only Opus xhigh session, no
   `gh` or web tools, given four local files under `$TRIAL/blind/`:
   `task.md` (the #362 scratch body with issue/PR numbers redacted to `#362`),
   `redacted-X.patch`, `redacted-Y.patch`, the two pass-1 JSON reports, and
   `rubric.md` (below). Prompt:
   ```
   Read task.md, redacted-X.patch, redacted-Y.patch, pass1-X.json, pass1-Y.json
   and rubric.md in this directory. Both patches implement the same task
   against the same base commit. Do not guess which system wrote a
   candidate. Do not reward length.

   List each distinct flaw you find across both patches once, with one
   severity (must-fix, should-fix, or nit, per rubric.md), and say whether it
   applies to X, Y, or both. Then score each acceptance criterion and each
   non-goal in task.md as met or missed, separately for X and Y. Output JSON
   only, matching this shape:
   {
     "flaws": [{"description": string, "severity": "must-fix"|"should-fix"|"nit", "appliesTo": "X"|"Y"|"both"}],
     "acceptanceCriteria": {"X": [{"criterion": string, "met": boolean}], "Y": [...]},
     "nonGoals": {"X": [{"nonGoal": string, "violated": boolean}], "Y": [...]}
   }
   ```
   Command shape matches pass 1's `ENV_WRAP` invocation, `--add-dir "$TRIAL/blind"`,
   no checkout to operate on (read-only over the four files), prompt from a
   file rather than inline.
7. **Rubric** (`rubric.md`, verbatim): must-fix = breaks an AC or non-goal, a
   defect on ordinary input, a weakened or deleted test, committed secrets or
   transcript content; should-fix = edge-input defect, untested behavior, doc
   drift; nit = style, naming.
8. Reference solutions (PR #386, `0a34bf2`) are never shown to any judge
   session; they are the pipeline's own output on this task and would bias
   toward arm A.

## 9. Decision rule (pre-registered; frozen when this protocol merges)

```
## Decision rule (pre-registered; frozen when this protocol merges)

Units. One task: T2 replays #362 from 1b4b8c5f. Arm A is the kickoff
pipeline (headless) and arm B is native plan-and-execute (headless). A pair
is the task's two arms.

Validity.
- An arm is valid when its launch gates passed before the task prompt was
  submitted, it reached its end state, and the contamination check found no
  READ exposure. Arm A's end state is a PR marked ready, or a park (question
  with no answer available, a blocker, or an exhausted fix-round cap). Arm
  B's end state is the fourth fixed invocation completed with the work
  pushed. An arm that reaches its end state with no diff is valid and
  misses every acceptance criterion.
- An arm A session that hits --max-budget-usd is invalid.
- Invalid arms are reported and never replaced. A pair with an invalid arm
  leaves the verdict and is reported beside it.
- A launch that fails a gate before the task prompt is submitted is fixed and
  relaunched. It is not an arm.

Quality, per diff d of a pair (d is X or Y; labels are unblinded only after
every pass is saved):
- P(d) = acceptance criteria missed plus non-goals violated, as scored by the
  reconciliation pass, plus 1 if npm test exits non-zero at the arm's tip.
- Q1(d) = must-fix findings in the fresh tm-review-changes pass on d, plus P(d).
- Q2(d) = must-fix findings the reconciliation pass attributes to d, plus P(d).
- A diff is worse on its task when its Q1 and its Q2 are both higher than the
  other diff's. Otherwise the pair is comparable on quality. A gap that does
  not survive both passes is not a finding.

Cost, per arm: the list-price-equivalent cost of every session and subagent
in the arm, from token-report.mjs (the pinned command), by the same method
for both arms; judging is excluded. R = cost(arm B) / cost(arm A). Adjusted R
is the same ratio after scaling arm B's Opus output estimate by the
actual-to-estimated output ratio measured on arm A's headless lead
session(s). Cost bands: below 0.5, 0.5 to 2, above 2.

Verdict, over the valid pairs; the first match wins:
1. Fewer than 2 valid pairs: INCONCLUSIVE (insufficient pairs). The numbers
   are reported without a verdict.
2. Arm A worse on one pair and arm B worse on the other: INCONCLUSIVE (split
   quality).
3. Arm A worse on at least one pair: NATIVE WINS ON QUALITY, with R per pair.
4. Arm B worse on at least one pair: PIPELINE WINS ON QUALITY, with R per pair.
5. Comparable on both pairs, and R and adjusted R fall in different bands on
   any pair: INCONCLUSIVE (cost measurement), with both figures.
6. Comparable on both pairs and R below 0.5 on both: NATIVE WINS (comparable
   quality at under half the cost).
7. Comparable on both pairs and R above 2 on both: PIPELINE WINS (comparable
   quality at under half the cost).
8. Otherwise: COMPARABLE. Neither arm wins under this rule.

Owner attention is its own measure and is never folded into the verdict. The
verdict line always reads "<VERDICT>; owner attention per task: native <m>
min (<n> touchpoints), pipeline <m> min (<n> touchpoints)". No rate converts
minutes into dollars; the trade is stated, not decided.

Reported beside the verdict, not scored: wall-clock (arm B's includes the
owner's pace; waits on a human and limit resets are shown separately),
blocked-on-human time from the transcripts, agent count, diff size,
should-fix and nit counts from both passes, in-arm fix rounds and parks,
contamination MENTIONs, limit events, permission denials, and the
output-estimate calibration.

Confidence. Every verdict is low confidence: two pairs, one run per arm, and
judges from the same model family as both arms' authors. If the arms were
equal, both pairs would favour a named arm by chance about 1 time in 4. No
verdict changes policy (issue non-goal).
```

**This run's one-pair note (owner delta).** With one pair, rule 1 applies by
construction: the verdict is **INCONCLUSIVE (insufficient pairs)**, reported
without a verdict. The report still gives the per-pair comparison (worse or
comparable on Q1 and Q2, and the R and adjusted-R bands) as a descriptive
result, explicitly labelled as not a verdict. "Owner attention" reads zero
touchpoint-minutes for both arms by construction (section 6), and the report
states plainly that the attention trade is not measured by this run.

## 10. Cost cap and stop rule

**$40 total**, across both arms and judging together (list-price equivalent,
per `token-report.mjs`, the same method as the decision rule's cost figure).
The `--max-budget-usd` flags on individual invocations (25 for arm A, 15 per
arm B invocation, 10 per pass-1 judge run) are per-session backstops; they do
not by themselves keep the run under $40 if several sessions each spend near
their own cap. The lead recomputes cumulative cost from `token-report.mjs`
after every arm ends. **If arm A plus arm B together pass $35 before judging
starts, the lead stops there and reports the arm-level numbers (cost,
wall-clock, agent count, diff stat, npm test, touchpoints) without running
judging.**

## 11. Deviations from `tm-ab-test` (adapted to one headless pair)

1. Pinned replay base (`ab/400-base-t2`) instead of `origin/main` at run
   time; the drift gate checks the pinned branch, not a moving `main`.
2. Neutral scratch-issue titles (no `AB #362-arm-X:` prefix) and a
   scratch-body edit (the `Part of batch #378` line stripped, the
   replay-rules trailer appended).
3. Arm A is a fresh headless `claude -p` process driving `/tm-kickoff #<n>`
   by hand from outside the lead's own session, not the lead session itself
   invoking kickoff in-process. `tm-ab-test` is user-typed only and assumes
   an in-session headless arm; this run needs an external, cost-capped
   driver so the lead's own context is never contaminated by either arm's
   output.
4. Arm B, which `tm-ab-test` defines as "supervised" (a human at the
   keyboard, via `templates/supervised-arm-runbook.md`), runs instead as
   four chained headless `claude -p` invocations with fixed prompts standing
   in for the human's plan-approval and follow-up actions. This is the
   owner's explicit decision on #400 (headless native arm, no owner at the
   keyboard); "native, headless" replaces "native, supervised" throughout
   this protocol.
5. Cost is measured with `token-report.mjs`, not an implicit
   `token-burn-analyze.mjs` baseline.
6. Blind X/Y independent pass-1 review in fresh sessions, plus one
   reconciliation pass, replaces `tm-ab-test`'s "an independent review pass
   per arm" alone (this separates a flaw rated differently across the two
   passes from a flaw genuinely present in only one diff).
7. One report and one ledger row cover this single pair, and the same PR
   branch that carries this protocol also carries `Closes #400`; `tm-ab-test`
   files its report from a run with no pre-registered, separately-frozen
   protocol commit.
8. A fixed reply (`"Decide yourself from the issue body."`) stands in for
   any owner answer to an in-flight question, and a kickoff park on a
   question is an arm-A end state, not a relay-and-resume step: no owner is
   present in this run to relay to.
9. Attention time is recorded as zero, touchpoint-log only, by construction.
   `tm-ab-test`'s recording checklist has no field for a headless native arm;
   this protocol adds the touchpoint log in its place (section 6).
10. This protocol is committed to the #400 PR branch and frozen before any
    arm runs, rather than merged first (the owner is away for this run); any
    later edit to this file is a logged deviation, a concept `tm-ab-test`'s
    own report template does not carry.

**Remaining risks**, carried over from the sub-plan: the owner has merged the
reference PR (#386), so nothing steers either arm toward it beyond the
fixed prompts and the contamination gate; a PR opened against a non-default
base (`ab/400-base-t2`) can have an empty `closingIssuesReferences`, which
may confuse kickoff's resume detection in arm A (the lead watches the
transcript for this and logs it); the `--settings` plugin override is
untried in a fully headless pair and is gated per section 2.

## Verification run now (Part 1, no spend)

- `git rev-list --parents -n1 0a34bf2` -> single parent
  `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589` (section 1).
- `git hash-object .claude/workflows/tm-review-changes.js` on this branch
  (`main`, `8e60a31` at the time of this check) ->
  `0f940c3f2314a0846d0db3ffb164bc4684ebe73e`; the same command against
  `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589` gives the identical blob SHA.
  The workflow file is unchanged between the T2 base and current `main`.
- `git hash-object .claude/skills/tm-kickoff/token-report.mjs` on this branch
  -> `46f0b3d597017efc19c7350ef96feed263fd8e57` (pinned for section 6).
- `claude --help` (build 2.1.280) lists every flag this protocol pins:
  `--model`, `--effort` (with `xhigh` as a valid level), `--permission-mode`
  (with `auto` and `plan` both listed as valid choices), `--output-format`
  (with `stream-json`), `--verbose`, `--session-id`, `-r/--resume`,
  `--max-budget-usd`, `--add-dir`, `--settings`, `--disallowedTools`,
  `-p/--print`. No pinned flag is missing; no deviation needed here.
