# Ultracode arm on a replayed #379: protocol - 2026-09-28

Pre-registered for issue #405 (batch #403). This file is frozen once
committed and pushed; any later change is a deviation, logged in the
report. Not a `/tm-ab-test` run: this package forbids GitHub writes during
the trial and runs a single arm (n=1), not a paired comparison.

## Documented ultracode syntax (fetched this session, changes the sub-plan's assumption)

The sub-plan drafted `ultracode` as a prompt-line keyword ("Use ultracode
for this task."), with a fallback to that literal wording if the developer
could not confirm the documented syntax. `code.claude.com/docs/en/model-config.md`
was reachable this session (WebFetch, 2026-09-28). Quoted verbatim, it says
ultracode is a **session setting**, not a prompt keyword:

> The `/effort` menu also offers `ultracode`. Ultracode is a Claude Code
> setting rather than a model effort level: it sends `xhigh` to the model
> and additionally has Claude orchestrate dynamic workflows for
> substantive tasks.
>
> You can turn on ultracode through any of the following: `/effort`: run
> `/effort ultracode`, or select it from the menu. `--effort` flag: launch
> with `claude --effort ultracode`, which starts the session at `xhigh`
> effort with ultracode on. `ultracode` setting: set `"ultracode": true` in
> a settings file, with `--settings`, or in an Agent SDK control request.
> `/model` picker: move the effort slider to `ultracode` with the arrow
> keys while you choose a model.
>
> Passing `ultracode` to the `--effort` flag ... requires Claude Code
> v2.1.203 or later. Before v2.1.203, `--effort ultracode` printed `Unknown
> --effort value 'ultracode'` and the session started at the default
> effort.

This developer's CLI is v2.1.280 (`>= v2.1.203`), so `--effort ultracode`
is the documented, headless-compatible activation. Per the sub-plan's own
instruction ("prefer that wording" when the docs are reachable), **both
the probe and the arm activate ultracode with `--effort ultracode` on the
CLI, not a prompt-line keyword.** This is a deviation from the sub-plan's
literal text, made under the sub-plan's own fallback clause, logged here
and in the report.

Consequence for the "hang case": the sub-plan's hang scenario assumed an
interactive confirmation a headless `-p` session could not satisfy. The
documented mechanism is a plain CLI flag with no described confirmation
step. The park condition is unchanged in substance (no evidence within the
wall-clock ceiling still means "no evidence found, not a technical
failure"), it is just no longer expected to manifest as an actual hang.

**A named, pre-existing risk this developer's own account carries:**
`~/.claude-work/settings.json` persists
`modelSettings.claude-opus-5-5.effortLevel: "high"` (same override #404's
report names). The docs state: "The persisted `effortLevel` setting and
the `CLAUDE_CODE_EFFORT_LEVEL` environment variable don't accept
`ultracode`. When `CLAUDE_CODE_EFFORT_LEVEL` is set to a level other than
`xhigh`, requests run at that level and ultracode's workflow orchestration
stays inactive." It is not written for this exact case (a persisted
*per-model* override, not the session-wide env var), and #404 found the
explicit `--effort` flag wins over this same persisted override in
practice. Defense in depth: both probe and arm additionally neutralize it
via `--settings` (below), and the evidence gate itself is the real test of
whether ultracode actually activated.

## Task (reused from #400's architect analysis for #379, re-verified)

- Reference (merged): PR #384, merge commit
  `1b4b8c5f5c95d28f06b417cf862b253bb7e3e589` (single parent, checked with
  `git rev-list --parents -n1` this session).
- Base (pre-merge): `aba6cb4eb93074b54f1324a90269e570b7755d5b`.
- Issue: #379, "Per-batch token report from session transcripts."

## 1. Probe: design, evidence, park condition (AC 1)

Runs first, in its own disposable clone, isolated one level up: the parent
directory `~/.cache/orchestrai-ultracode-probe/` holds nothing but
`2026-09-28/`, so a `Glob`/`Bash` call one level above the probe's own
trial root cannot reach any other trial's data (the H2/H3 sweep #404's
report documents).

- **Clone:** `~/.cache/orchestrai-ultracode-probe/2026-09-28/repo`, cloned
  fresh from `https://github.com/sv-tmueller/orchestrai.git`, detached at
  `origin/main` HEAD pinned to `8e60a31e4b455a6c9fefadd3821f8fc25c5a33ab`
  (`git ls-remote` this session), `origin` removed. `GH_CONFIG_DIR` at
  `~/.cache/orchestrai-ultracode-probe/2026-09-28/gh-empty` (empty).
- **Settings:** `--settings '{"enabledPlugins":{"orchestrai@orchestrai":false},"modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh"}}}'`
  (#400 §2's plugin-off gate, plus the persisted-effort neutralization
  above).
- **CLI:** the #358 protocol's block, `env -i` with the same fixed env,
  `--model claude-opus-5-5 --effort ultracode`, `--output-format
  stream-json --verbose --session-id <sid>`, `--max-budget-usd 3`. Same
  allow/deny shape as the arm (section 3 below).
- **Wall-clock ceiling:** 15 minutes (`timeout 900`), independent of the
  dollar cap, for the hang case.
- **Task:** add a pure helper (array median) plus a unit test to a new
  scratch file, run the test, review the diff, stop; no commit, no push,
  no `gh`, no web. Full text: `~/.cache/orchestrai-ultracode-probe/2026-09-28/task-prompt.md`,
  sha256 `313a39794e73918dbb234ff7b9da973ec99798f192fefab62ba2f6fc20537220`.
- **Evidence (either counts):** (a) authors a Workflow: the stream-json
  contains a `tool_use` named `Workflow`, or a `Write`/`Edit` of a workflow
  definition that a later `Workflow`/`Agent`/`Task` call runs; (b) an
  init/system/control event or assistant text in the first few turns
  confirms ultracode is active (case-insensitive `ultracode`, or an
  explicit settings/init field distinguishing it from plain `xhigh`).
- **Park condition:** neither (a) nor (b), including a run that hits the
  wall-clock ceiling with no evidence: park `needs-human` ("the documented
  ultracode activation does not show workflow authoring or an ultracode
  signal in headless `-p` mode; a supervised arm is a scope change per AC
  1") and stop. No hand-authored stand-in.
- **Plugin-off gate:** verified from the init event before trusting any
  other evidence (no `orchestrai:`-prefixed skills/agents listed).
- **429:** not evidence either way. Park `needs-human` with the reset time;
  one retry next session.

## 2. Pre-merge commit and isolation (arm)

- **Isolation:** fresh clone reset to `aba6cb4e...`, detached, `origin`
  removed, no GitHub credentials
  (`~/.cache/orchestrai-ultracode-arm/2026-09-28/pristine`, set up and
  verified this session: `HEAD` equals the base SHA, zero remotes, clean
  tree). `repo/` is `cp -R` from `pristine/` before the run, matching the
  #358/#404 recreate-per-run pattern (n=1 here, so exactly once).
- **Parent-directory isolation:** `~/.cache/orchestrai-ultracode-arm/`
  holds nothing but `2026-09-28/`, for the same reason as section 1.
- **Settings:** same plugin-off plus persisted-effort override as section
  1. This matters most here: the installed marketplace plugin carries the
  merged `token-report.mjs`, which would hand the arm the reference
  solution if the override did not take.
- **Frozen input:** `~/.cache/orchestrai-ultracode-arm/2026-09-28/input/config/projects/-Users-TM-Desktop-github-orchestrai/`,
  frozen this session from the batch #371 lead session
  `d4567eab-4604-4dec-ba3f-2209ed6e64f0`: lead lines before
  `2026-09-27T11:04:53.617Z` (859 of 2246 lines kept) and subagent
  transcripts (`.jsonl` plus `.meta.json`) whose `.jsonl` first-line
  timestamp is before that cutoff (34 of 65 agents kept, matching the
  reference's "34 dispatches"). Checked this session: zero matches for
  `token-report.mjs`, `check-version-bump`, `version-guard`, `#384`,
  `#386` across the frozen copy. Mounted with `--add-dir
  ~/.cache/orchestrai-ultracode-arm/2026-09-28/input` (the arm's own
  `CLAUDE_CONFIG_DIR` stays `$HOME/.claude-work`, unrelated to this input
  directory; the frozen copy is sample data the arm's own tool invocation
  points `--config-dir` at, not the arm session's runtime config).
- **Task delivery:** no scratch GitHub issue. Local `task-prompt.md` piped
  to stdin, #379's issue body verbatim (title, What to build, Acceptance
  criteria, Non-goals) plus a trailer adapted from #400 §4: no GitHub
  access, do not look up or guess the original PR, implement in this
  checkout, run `npm test`, commit locally, do not push. Full text:
  `~/.cache/orchestrai-ultracode-arm/2026-09-28/task-prompt.md`, sha256
  `4d4ecd53f937fb5562a8ab31cf7ac03adcd5ef7646807b4017c621901c76ff09`.
- **Real-host redaction:** the real provider host is present at
  `aba6cb4e...` and still on `main`. Every committed file from this trial
  (this protocol, the report, any diff excerpt) is grepped against the
  2026-09-23 root's `redact.txt` (read only at redaction time, never
  copied) before committing; any count above zero is redacted first.

## 3. Arm's tool permissions

Same for probe and arm:

```
--allowedTools "Read,Grep,Glob,Write,Edit,Agent,Task,Workflow,Bash(git *),Bash(npm *)"
--disallowedTools "Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git push *),Bash(git remote *),Bash(curl *)"
```

`Skill` is disallowed outright because the clone still carries
project-level `.claude/skills/tm-kickoff` etc.; invoking them would fall
back to the bounded pipeline and violate the non-goal. No `--add-dir`
beyond `$TRIAL/input` for the arm; the probe gets no `--add-dir` at all.

Known gap, inherited from #404's finding and not fixed here (fixing it
mid-trial would change the arm's tool conditions from what the allowlist
above states): `Glob`'s `path` argument is not restricted by
`--allowedTools`'s literal-prefix matching the way `Bash(...)` entries
are, so a `path` one level above the trial root could in principle sweep a
sibling. Neutralized here by construction (parent directories hold nothing
but this run), not by a tool restriction.

## 4. CLI (arm, full block)

```sh
ARM_TRIAL="$HOME/.cache/orchestrai-ultracode-arm/2026-09-28"
rm -rf "$ARM_TRIAL/repo" && cp -R "$ARM_TRIAL/pristine" "$ARM_TRIAL/repo"
SID=$(uuidgen | tr 'A-Z' 'a-z'); T0=$(date +%s)
cd "$ARM_TRIAL/repo" && env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  CLAUDE_CONFIG_DIR="$HOME/.claude-work" GH_CONFIG_DIR="$ARM_TRIAL/gh-empty" \
  timeout 5400 /opt/homebrew/bin/claude -p --model claude-opus-5-5 --effort ultracode \
    --output-format stream-json --verbose --session-id "$SID" \
    --permission-mode dontAsk --strict-mcp-config --max-budget-usd 40 \
    --add-dir "$ARM_TRIAL/input" \
    --settings '{"enabledPlugins":{"orchestrai@orchestrai":false},"modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh"}}}' \
    --allowedTools "Read,Grep,Glob,Write,Edit,Agent,Task,Workflow,Bash(git *),Bash(npm *)" \
    --disallowedTools "Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git push *),Bash(git remote *),Bash(curl *)" \
    < "$ARM_TRIAL/task-prompt.md" > "$ARM_TRIAL/runs/arm.jsonl" 2> "$ARM_TRIAL/runs/arm.stderr"; RC=$?
WALL=$(( $(date +%s) - T0 ))
```

Wall-clock ceiling: 90 minutes (`timeout 5400`), independent of the
`--max-budget-usd 40` cap, for the hang case (section 9 of the sub-plan).
If `--permission-mode dontAsk` is rejected by this CLI build, the fallback
is `--permission-mode manual --permission-prompts none`, logged as a
deviation. Never `--dangerously-skip-permissions`, never
`--fallback-model`, never `CLAUDE_CODE_SUBAGENT_MODEL`.

**Gates after the run** (fails any of these: invalid, not replaced, per
section 7): the init event's `model` field is `claude-opus-5-5`;
`mcp_servers` is empty; `permissionMode` is `dontAsk` (or the logged
fallback); a `result` event exists; `apiKeySource` shows subscription
billing, not API-key billing (API-key billing stops the whole package with
`NEEDS_CONTEXT`); the init event lists no `orchestrai:`-prefixed
skills/agents (plugin-off gate); no tool input in the transcript touches
`~/.cache/orchestrai-lead-trial*`, `~/.cache/orchestrai-judge*`,
`~/.cache/orchestrai-ab-400*`, `~/.claude-work/projects/*.jsonl`, the
developer's own checkout or worktree, or
`~/.claude-work/plugins/marketplaces/orchestrai/` (contamination gate,
adapted from #404's).

## 5. Diff extraction and scoring against the merged PR

- `git diff --stat <base> <tip>` and `git diff <base> <tip>` from the
  arm's `repo/` at its end state (or its last commit before a cap or a
  429).
- Not blind paired judging: the issue asks for a comparison against the
  human-accepted reference, so showing PR #384's diff to the scoring pass
  is intentional.
- Scoring pass: one fresh read-only session (`claude-opus-5-5`, `xhigh`,
  plugin off, no gh, no web) given #379's body, the arm's diff, and the
  reference diff (`git show 1b4b8c5f... --stat` and the merge diff),
  producing: ACs met or missed, `npm test` at the arm's tip, a short note
  on how the solutions differ. JSON reply requested for easy extraction.
- #400 is `needs-human` (parked before any run; checked this session, its
  latest comment), so section 4 falls to the expected default: reference
  only, no kickoff-arm comparison.

## 6. `tm-review-changes` on the arm's diff

One fresh headless session, plugin off, no gh, no web,
`Read,Grep,Glob,Agent,Task,Bash(git log/show/diff *)` only, against a copy
of the arm's finished `repo/`, prompt: `Workflow({ name:
'tm-review-changes', args: { base: 'aba6cb4eb93074b54f1324a90269e570b7755d5b' } })`.
Summarize must-fix, should-fix, nits in the report. Skipped if the arm's
diff is empty (nothing to review).

## 7. Counting agents, workflows, per-stage model and effort pins

- **Cost and per-model breakdown:**
  `.claude/skills/tm-kickoff/token-report.mjs --session <arm SID>
  --config-dir "$HOME/.claude-work"`, run from this developer's own
  checkout (the script exists there; it does not exist in the arm's own
  pre-merge clone). Uniform `claude-opus-5-5` means no pinning; a mixed
  table is a reportable finding against the rationale's Ultracode section.
- **Agent and workflow count:** subagent transcripts under
  `~/.claude-work/projects/-Users-TM--cache-orchestrai-ultracode-arm-2026-09-28-repo/<arm
  SID>/subagents/agent-*.jsonl`; `Workflow` tool_use count from the
  stream-json log.
- **Per-stage effort:** grep `perTurnEffort` inside each subagent
  transcript (stdout/stream-json carries no effort field, per #404).
  Tabulate explicit vs. inherited, and whether `ultracode` (vs. plain
  `xhigh`) is distinguishable at the subagent level at all (an open
  question this trial itself answers).
- **Workflow source, if written to disk:** inspect for `model:`/`effort:`
  on its `agent()` calls.

## 8. $40 cap and 429 handling

- Arm CLI: `--max-budget-usd 40`, background-launched with an `.rc` file
  written on exit, bounded polls under 600s, never ending the turn while
  the child is live.
- **Pre-registered end states:** (a) hits `--max-budget-usd` while
  otherwise running normally: a valid, completed, illustrative run even if
  the diff is empty or unfinished; reported as the n=1 result, no second
  run. (b) 429 mid-run: not a completed run; marked invalid, parked
  `needs-human` with the reset time, and on resume exactly one retry of
  the same arm. Only (b) gets a retry. (c) hits the 90-minute wall-clock
  ceiling with the process still running: killed, treated the same as (b)
  (not a completed run, one retry on resume), since a run that needs more
  than 90 minutes of wall-clock on a $40 cap is itself an anomaly worth a
  fresh attempt rather than trusting a forced-kill state.
- Same three-way split applies to the probe (with its own $3 cap and
  15-minute ceiling; the probe's park condition, section 1, already covers
  its "no evidence" case regardless of which end state produced it).

## 9. Files, order, constraints

1. This file, committed and pushed before the probe runs.
2. Probe run, gated per section 1; commit its result before the arm.
3. Arm run, gated per sections 2-4, 7-8; commit after its end state.
4. `tm-review-changes` pass and scoring pass (section 5-6).
5. `docs/reviews/2026-09-28-ultracode-arm-379.md`: probe result, metrics
   table (agents, workflows, per-stage model and effort, list-price cost,
   wall-clock, diff size, ACs met or missed), review summary, the verdict
   on "No session-wide ultracode," labeled n=1.
6. No `ab-tests.md` row (not a `/tm-ab-test` run, and not a paired
   comparison).
7. No `.claude/` changes and no `team-guide.md` edit unless the data
   contradicts the rule.

## Verification

- `npm test` passes in this developer's own checkout.
- This file's commit-and-push time is earlier than the probe's start time,
  and no later commit edits this file (any change after is a logged
  deviation).
- The report's per-run figures are recomputed independently from the raw
  logs and match what is stated.
- No em dashes or banned phrases in the committed files.
- None of the `redact.txt` hosts appear in any committed file from this
  trial.

## If blocked

If `claude -p` cannot launch from this environment (sandbox, keychain, or
the nested-session check), the package reports `BLOCKED` with the prepared
command blocks above. No bypass flag is used to work around it.
