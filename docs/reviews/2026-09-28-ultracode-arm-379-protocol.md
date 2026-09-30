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

## Probe result (run 2026-09-28)

Session `935bb48c-1f0d-424b-bcc5-bf70ee52981a`, `RC=0 WALL=48` (48 seconds,
well inside the 15-minute ceiling; no hang). `terminal_reason: "completed"`,
9 turns, `total_cost_usd: 0.2866058`, 2 permission denials (it tried
`node --test ...` directly, which the `Bash(git *)`/`Bash(npm *)` allowlist
correctly denies; a probe-design gap, not an ultracode signal).

**Gates:** `model` `claude-opus-5-5` (pass); `mcp_servers` empty (pass);
`permissionMode` `dontAsk` (pass); `apiKeySource` `none`, i.e. subscription
billing (pass). **Plugin-off gate: fails.** The init event lists
`orchestrai:tm-kickoff`, `orchestrai:tm-advisor`, `orchestrai:architect`,
etc.; the `--settings enabledPlugins` override did not remove them (see
Amendment 1).

**Evidence (a), Workflow authored:** not found; no `tool_use` named
`Workflow` anywhere in the transcript.

**Evidence (b), ultracode self-reference:** found, in the first assistant
turn: *"This is a small task, so I'll do it inline without a workflow.
Ultracode says to go solo on trivial edits, and the team guide says to
save ultracode for heavy one-off tasks."* This is not a restatement of
`.claude/team-guide.md`'s own wording (which never says "go solo on
trivial edits"); it reads as the model paraphrasing an in-context
instruction Claude Code injects when ultracode is actually active,
consistent with the documented mechanism ("has Claude orchestrate dynamic
workflows for substantive tasks", implying a per-task orchestrate-or-not
decision). Read together with evidence (a)'s absence, the most likely
account is that ultracode activated and the model correctly judged this
probe's task too small to warrant a dynamic workflow, not that ultracode
failed to activate. The sub-plan's own risk ("a one-line task risks a
false negative") is a live caveat here: this probe cannot distinguish
"ultracode on, workflow-authoring correctly skipped for a small task" from
"ultracode off, ordinary inline work"; it establishes headless
compatibility (no hang, no interactive-confirmation stall, evidence (b)
present) but does not, on its own, prove evidence (a) would ever fire for
*any* task size, since no task in this trial tried to force it. Per
section 1, evidence (b) alone is sufficient to clear the park condition;
this limitation is carried into the final report rather than triggering a
probe re-run with a different task (not something this protocol, once
committed, permits). The probe prompt itself names the file
`scratch/ultracode-probe.mjs`, so the word alone proves nothing; the
signal is the phrase "go solo on trivial edits", which neither the prompt
nor the team guide contains.

**Verdict: park condition not triggered. Proceed to the arm**, after
Amendment 1 below (the plugin-off gate's failure is the same defect that
makes the arm's isolation, section 2, unverified as originally specified).

## Amendment 1: isolation fix for the arm (committed and pushed before the arm runs)

Diagnostic sessions after the probe (each `--effort low`, `--max-budget-usd`
0.05-0.2, plugin-off `--settings` as in section 1) found two problems with
section 2's stated isolation, both discovered empirically, not assumed:

1. **The plugin-off `--settings` override does not take effect.** Tried
   both `{"enabledPlugins":{"orchestrai@orchestrai":false}}` (the key
   `~/.claude-work/settings.json` itself uses) and
   `{"enabledPlugins":{"orchestrai@synced":false}}` (the `source` field the
   init event actually reports for this plugin instance, since it is
   synced from the claude.ai account rather than installed from a local
   marketplace entry). Neither removes `orchestrai:`-prefixed skills or
   agents from the init event. This confirms #400 §13's "untried (gated)"
   flag: tried, and it fails for an account-synced plugin.
2. **A `Read` (and `Grep`) tool named bare in `--allowedTools` bypasses
   `permissions.blockReadsOutsideWorkingDirectories`.** A diagnostic
   session with `--allowedTools "Read"` and
   `--settings '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}'`
   successfully read
   `~/.claude-work/plugins/cache/orchestrai/orchestrai/2.4.0/skills/tm-kickoff/token-report.mjs`,
   i.e. **the merged #379 reference solution, verbatim, from outside the
   trial's working directory**, despite the block setting. The same
   setting correctly blocked an equivalent `Glob` call in a separate
   diagnostic session (`Glob`'s own `path` argument is not exempt the way
   `Read`'s and `Grep`'s bare grants are). This is a materially worse
   version of #404's Glob-path finding: there, a sweep could reach sibling
   trial data; here, an unrestricted `Read`/`Grep` can reach the exact
   file whose contents this arm's diff is later scored against.

**Fix, verified empirically before use:** drop `Read` and `Grep` from
`--allowedTools` (do not name them bare); keep `--permission-mode dontAsk`,
which auto-approves in-boundary tool use on its own (confirmed: a
diagnostic session with `--allowedTools "Glob"` only, no `Read` entry,
still read `package.json` inside its own repo without a prompt) and add
`--settings '{"permissions":{"blockReadsOutsideWorkingDirectories":true}, ...}'`
(merged with the existing `enabledPlugins`/`modelSettings` keys from
sections 1 and 4). A diagnostic session with this exact combination
correctly denied the same out-of-boundary `Read` ("Permission to use Read
has been denied because Claude Code is running in don't ask mode") while
still reading `package.json` inside the repo. `Glob` stays in
`--allowedTools` (it already respects the boundary). This closes the raw
filesystem leak; it does not fix problem 1 (the plugin's skills/agents
still list `orchestrai:`-prefixed entries), which is reported as a known,
unfixed limitation: the arm cannot invoke them (`Skill` stays
disallowed), so the residual risk is metadata visibility, not code access.

**Revised tool blocks for the arm (supersedes sections 3-4 above):**

```
--allowedTools "Glob,Write,Edit,Agent,Task,Workflow,Bash(git *),Bash(npm *)"
--disallowedTools "Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git push *),Bash(git remote *),Bash(curl *)"
--settings '{"enabledPlugins":{"orchestrai@orchestrai":false,"orchestrai@synced":false},"modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh"}},"permissions":{"blockReadsOutsideWorkingDirectories":true}}'
```

`Read` and `Grep` are intentionally absent from `--allowedTools`; the
session still uses them freely inside its own working directory and
`--add-dir` grants (dontAsk auto-approves in-boundary use), and is denied,
not prompted, outside them. Diagnostic cost so far, not counted against
the arm's $40 cap (same convention as #404's round-1/round-2 split):
recorded in the final report's cost table as its own line.

One 429 hit during this diagnostic phase (individual spend limit,
`your session limit resets 9:50pm (Europe/Berlin)`), on a low-value
follow-up check (Grep boundary test) that had already returned its result
before the error; not counted as a probe or arm run under section 8's end
states, since it was neither. Resumed after the stated reset time.

## Arm run 1 (invalid, superseded by Amendment 2)

Session `26905c9d-4490-4ef0-8c88-ebee1b590dc9`, `RC=0 WALL=695` (11.6
minutes, well under the 90-minute ceiling). `terminal_reason: "completed"`,
63 turns, `total_cost_usd: 3.9138096`, 11 permission denials.

**Gates:** model, `mcp_servers`, `permissionMode` (`dontAsk`) all pass.
**Plugin-off gate now passes**: the init event lists zero
`orchestrai:`-prefixed skills or agents, confirming that Amendment 1's
combined `{"orchestrai@orchestrai":false,"orchestrai@synced":false}` (both
keys together, where either alone had failed in diagnostics) does disable
the synced plugin for a session. **Contamination gate: clear.** Every
absolute path outside the arm's own `repo/`/`input/` touched anywhere in
the transcript is either a plugin/skill listing from the init event itself
(not a tool call) or a path this developer's own report text quotes back
for citation, not a tool target; no `Read`, `Grep`, or `Glob` call
resolved outside the working directory or `--add-dir` grant.

**Outcome: crippled, not by contamination or by ultracode, but by a
protected-path rule this protocol did not anticipate.** All 11 permission
denials, and specifically 7 of 9 `Write` attempts plus the only `Edit`
attempt, target paths under `.claude/` in the arm's own repo (the fixture
tree under `.claude/workflows/__tests__/fixtures/token-report/` and
`.claude/skills/tm-kickoff/SKILL.md`); every `Write`/`Edit` call to a
non-`.claude/` path (a scratch survey script under `/tmp`, and the
baseline doc under `docs/research/`) succeeded. Per
`code.claude.com/docs/en/permission-modes.md`: `.claude` (like `.git`) is
a built-in **protected path**; "writes to protected paths are never
auto-approved except in `bypassPermissions` mode," and `dontAsk` mode
"auto-denies every tool call that would otherwise prompt you," including
protected-path writes, with **no `--allowedTools`/`--settings` rule able
to override that** (confirmed by testing an explicit `Write`/`Edit` grant
above, which had no effect). Since #379's actual deliverable is
`.claude/skills/tm-kickoff/token-report.mjs` plus tests and fixtures under
`.claude/workflows/__tests__/`, this blocks the task's core almost
entirely under `dontAsk`. The one artifact that landed,
`docs/research/2026-09-28-batch-371-token-baseline.md`, sits outside
`.claude/` and is left in the arm's `repo/` as evidence, not committed (no
commit exists at all: `git log` at the arm's end state still shows the
base commit as `HEAD`).

This is orthogonal to ultracode and to Amendment 1's contamination fix
(the plugin-off and boundary gates both passed cleanly on this same run);
it would have hit any headless `dontAsk` arm attempting this specific
issue, with or without ultracode. Not a pre-registered end state under
section 8 (not budget-capped, not a 429, not a wall-clock kill): a new,
fourth category this protocol did not anticipate, logged here rather than
silently reported as the n=1 result. This run's `total_cost_usd` is
counted in the diagnostic total, not against the retry's $40 cap, the
same convention as the diagnostic sessions above and as #404's round-1
spend.

## Amendment 2: permission mode for the arm (committed and pushed before the retry runs)

Root cause (`code.claude.com/docs/en/permission-modes.md`, quoted above):
`dontAsk` mode hard-denies protected-path writes with no override. `auto`
mode instead routes a protected-path write to a classifier for
case-by-case review ("writes to protected paths route to the classifier
even when an allow rule matches"), and in a non-interactive `-p` session
with nothing to prompt, a classifier block "doesn't run and Claude keeps
working" rather than hanging or erroring. `auto` mode is a documented,
non-bypass permission mode (distinct from `bypassPermissions`,
`--dangerously-skip-permissions`, or any sandbox override, none of which
this package uses).

**Verified before the retry:** a diagnostic session, identical settings
to Amendment 1's revised block except `--permission-mode auto`, wrote
`.claude/scratch-write-probe.md` successfully (`total_cost_usd: 0.266`, 0
denials). `permissions.blockReadsOutsideWorkingDirectories` is documented
to hold "in every permission mode," so Amendment 1's boundary fix is
unaffected by this mode change.

**Retry CLI (supersedes section 4 and Amendment 1's block; the only
change is the permission mode):**

```sh
ARM_TRIAL="$HOME/.cache/orchestrai-ultracode-arm/2026-09-28"
rm -rf "$ARM_TRIAL/repo" && cp -R "$ARM_TRIAL/pristine" "$ARM_TRIAL/repo"
SID=$(uuidgen | tr 'A-Z' 'a-z'); T0=$(date +%s)
cd "$ARM_TRIAL/repo" && env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  CLAUDE_CONFIG_DIR="$HOME/.claude-work" GH_CONFIG_DIR="$ARM_TRIAL/gh-empty" \
  timeout 5400 /opt/homebrew/bin/claude -p --model claude-opus-5-5 --effort ultracode \
    --output-format stream-json --verbose --session-id "$SID" \
    --permission-mode auto --strict-mcp-config --max-budget-usd 40 \
    --add-dir "$ARM_TRIAL/input" \
    --settings '{"enabledPlugins":{"orchestrai@orchestrai":false,"orchestrai@synced":false},"modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh"}},"permissions":{"blockReadsOutsideWorkingDirectories":true}}' \
    --allowedTools "Glob,Write,Edit,Agent,Task,Workflow,Bash(git *),Bash(npm *)" \
    --disallowedTools "Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git push *),Bash(git remote *),Bash(curl *)" \
    < "$ARM_TRIAL/task-prompt.md" > "$ARM_TRIAL/runs/arm2.jsonl" 2> "$ARM_TRIAL/runs/arm2.stderr"
RC=$?
WALL=$(( $(date +%s) - T0 ))
```

Same 90-minute wall-clock ceiling. Same gates as section 4, plus a new
one: zero `Write`/`Edit` denials on a `.claude/` path (if any occur, the
same defect persists and the run is invalid again). Same $40 cap and 429
handling as section 8; arm run 1's cost is not counted against it. This
is the second and last permission-mode change this protocol makes; a
further failure here parks `needs-human` rather than a third invention.

## Arm run 2 result (run 2026-09-29, owner-executed)

Per the park comment's owner decision (option a), the owner ran the retry
CLI above unchanged from their own terminal, not from a developer session,
and added one line writing an `.rc` file on exit. Result: `runs/arm2.jsonl`
(stream-json, 1247 lines), `runs/arm2.rc` = `RC=0 WALL=1996
SID=ae287ce2-613e-4077-9de8-9d9681a2ca3b`, `runs/arm2.stderr` =
`Background tasks still running after 600s; terminating. Set
CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.`

**Gates (section 4, plus Amendment 2's new one): all pass.**

- `model` `claude-opus-5-5`; `mcp_servers` empty; `permissionMode` `auto`;
  `apiKeySource` `none` (subscription billing); a `result` event exists
  (`stop_reason: end_turn`).
- Plugin-off gate: the init event lists 129 skills, 17 agents, 163 slash
  commands; zero of any of them are `orchestrai:`-prefixed.
- Contamination gate: every absolute path outside `repo/`/`input/` that
  appears anywhere in a tool_use input is either the one denied `Glob` on
  `~/.claude-work/projects` (boundary held) or a synthetic example path
  embedded in written file content (a doc-comment string inside the new
  test file), never a real tool target.
- Amendment 2's new gate: zero `Write`/`Edit` denials of any kind occurred
  (0 of 23 total denials touch `Write` or `Edit`; compare run 1's 7 of 9
  `Write` plus its only `Edit`, both denied).

**Outcome: valid under the pre-registered gates, n=1 illustrative run, cut
short.** Neither pre-registered invalid end state (section 8) applies:
`total_cost_usd` 12.76833 is well under the $40 cap, there was no 429, and
the 90-minute ceiling never fired (1996 s). It is not a clean completion:
the CLI terminated at its own 600-second background-task ceiling with the
review workflow still running, and the lead's last message ("I'll fix
whatever the review confirms, then run `npm test` and commit locally") was
never acted on. Section 8 (c)'s reason for not trusting a forced-kill state
would point to a retry; counting this run is a judgment made after the
fact, since a retry would breach the issue's one-run non-goal.

**Product diff.** `.claude/scripts/token-report.mjs` (439 lines) plus
`.claude/scripts/model-prices.json`, a 343-line test file and synthetic
fixtures under `.claude/workflows/__tests__/`, and
`docs/research/2026-09-29-batch-371-token-baseline.md`, alongside the
SKILL.md/README/rationale wiring. `git diff --stat` from a committed copy
of the arm's tree (never the trial directory itself, which stays
uncommitted as the session left it): 18 files changed, 1057
insertions(+), 5 deletions(-). No commit exists in `repo/`; `HEAD` there
still reads the base commit, with the whole product diff sitting as
modified and untracked files.

**Agents, workflow, and per-stage pins (sub-plan section 6).**

- One `Workflow` authored and run: `tm-token-report-review` (2 phases, up
  to 4 review dimensions each followed by a skeptic), persisted at
  `~/.claude-work/projects/-Users-TM--cache-orchestrai-ultracode-arm-2026-09-28-repo/ae287ce2-613e-4077-9de8-9d9681a2ca3b/workflows/wf_0ffd27eb-e79.json`.
- 7 subagent transcripts under `.../subagents/workflows/wf_0ffd27eb-e79/agent-*.jsonl`,
  one per workflow-agent slot: `review:recompute`, `review:spec`,
  `review:code`, `review:integration` (Review phase, all `state: done`),
  `verify:spec`, `verify:integration` (Verify phase, `done`), `verify:code`
  (`state: progress`, killed mid-tool-call). `verify:recompute` was never
  dispatched: its review found zero findings, and the pipeline's own code
  skips the skeptic call when a review returns no findings.
- 8 agents total (1 lead + 7 workflow subagents), all `claude-opus-5-5`:
  uniform model, no per-model pin.
- Effort: the lead ran under `--effort ultracode` (session-wide, per the
  documented mechanism). Every one of the 7 subagent transcripts carries
  `"perTurnEffort":"high"` explicitly, matching the workflow source's own
  `effort: 'high'` on both `agent()` calls in the pipeline. An
  ultracode-authored workflow pinned its own worker stages down to plain
  `high`, one level under the parent's `xhigh`/ultracode, on the same
  model rather than a cheaper one.

**Cost, list price.**

- Session `result` event (measured, real usage): `total_cost_usd 12.76833`
  from `modelUsage`, which covers the whole session (674,666 cache-write,
  16,796,080 cache-read, 264,980 output tokens, of which 135,422 thinking).
  The event's top-level `usage` block is lead-only (244,824 cache-write,
  8,631,936 cache-read, 132,845 output, of which 74,775 thinking).
  Uniformly `claude-opus-5-5`.
- The merged reference's `token-report.mjs` (`.claude/skills/tm-kickoff/`,
  from this developer's own checkout), run against this session: sees
  only the **lead**, 63 calls, estimated **$4.28**. Its subagent lookup
  (`<session>/subagents/agent-*.jsonl`, not recursive) does not reach
  `subagents/workflows/<run-id>/agent-*.jsonl`, so it misses all 7
  workflow subagents and about half of the run's real spend (the lead's
  own measured usage prices at $6.34 of the $12.77).
- The arm's *own* `token-report.mjs` (a different file, under
  `.claude/scripts/`, recurses with `readdirSync(subagentDir, {
  recursive: true })`; its own source comment names this exact case:
  "workflow agents write to subagents/workflows/<run>/agent-*.jsonl"), run
  against the same session from a scoring copy: 8 agents, 215 calls,
  **$7.48** input cost + **$1.25** output estimate ($8.73 total estimate).
  Still under the measured $12.76833: the gap is thinking tokens (135,422
  across the session), which the visible-output estimate excludes by
  design and states as a limitation.
- Diagnostic and prior-run spend, unchanged from the park-time report:
  probe $0.2866, ten isolation/permission diagnostics $0.9047, arm run 1
  $3.9138. **Total list-price spend across the whole package: $17.87343**
  ($5.1051 before run 2, plus run 2's $12.76833).

**The 600-second background kill.** Not a pre-registered end state;
reported as a finding, not grounds to invalidate the run. `Workflow` runs
as a background task; Claude Code's own default wait ceiling for a
background task still running when the main turn tries to end is 600
seconds (the run's stderr names the override,
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, which this run did not set). The
workflow launched at 11:22:30 UTC, about 1346 s (67%) into the run's
1996 s wall-clock; the last visible assistant/user content in the
transcript is 43 s later, at 11:23:13 (consistent with the session
ending its own turn right after kicking the review off in the
background, `Workflow`'s documented async pattern); the workflow itself
kept running for 643 s total before Claude Code killed it at 11:33:14 for
exceeding the 600 s ceiling. So roughly 600 s (30%) of the total
wall-clock is idle lead time: from the lead's last message at 11:23:13 to
the kill at 11:33:14, the CLI only waited on the background task.

**The lead never consumed the workflow's result.** The transcript ends at
the kill: a `task_notification` (status `stopped`) immediately followed
by the session's own terminal `result` event (`stop_reason: end_turn`),
with no further assistant turn reading the task's output file or acting
on it. No commit followed, and the review's own findings (below) never
reached the session that could have acted on them. For the fan-out
reading: the workflow did fan out (7 agents across 2 phases, all
completing or nearly completing their individual dispatches before the
kill); the kill is a harness-level grace-period mismatch between a
multi-agent review workflow's likely runtime and Claude Code's own
default background-task patience, not evidence that ultracode failed to
orchestrate. It does mean this run produced no wrapped-up result: the
review ran, found real issues, and then vanished before anything could
act on them.

**What the killed workflow found, for the record (never surfaced to the
arm's own session).** `review:spec` found one low-severity issue (an
unlabeled output-cost field in `--json`), which `verify:spec` REFUTED.
`review:code` found a medium-severity issue (non-ISO or no-offset
`--since`/`--until` timestamps parsed as local time); its skeptic,
`verify:code`, was mid-reproduction (16 tool calls in) when killed,
verdict unknown. `review:integration` found a medium-severity issue (the
`--session <id>` escape hatch documented in the SKILL.md diffs is not
practically actionable by the lead as written); `verify:integration`
**CONFIRMED** it: a real, live gap in AC 4's wiring that this run's own
review caught and the run never got to fix.

**Denials, categorized (23 total).**

- 19 `Bash`, `safetyCheck`: the boundary check
  (`permissions.blockReadsOutsideWorkingDirectories`) cannot statically
  verify a command whose target path is computed at run time (`find`,
  `ls`, `grep`, `cat`, `sed` with a variable path) or that the shell
  parser cannot fully analyze (brace or variable expansion, an inline
  `node -e`, an off-allowlist `sed` script). These read as the same
  "sandbox quirks" the workflow's own prompt later warns its review
  subagents about, almost verbatim ("the shell blocks `node -e`,
  heredocs, ... write scripts to files with the Write tool"): the main
  session hit this limitation itself while building the script and
  encoded the workaround into the workflow it then authored.
- 3 `Bash`, `subcommandResults`: a multi-operation Bash command where one
  part needed approval the classifier could not grant headlessly.
- 1 `Glob`, `other`: denied a `Glob` on `~/.claude-work/projects` (outside
  the trial's working directory and `--add-dir` grant), the boundary gate
  holding exactly as designed.
- 0 `Write`/`Edit` denials of any kind.

**Redaction check.** Grepped the scoring copy and both run transcripts
(`arm.jsonl`, `arm2.jsonl`) for the real provider host named in
`docs/architecture/hermes-adapter.md`: zero matches in either transcript.
The only occurrence in the copy is the pre-existing line in
`hermes-adapter.md` itself (already on `main`, predating this trial and
not introduced or quoted by it).

## `tm-review-changes` result (run 2026-09-29, lead-run)

Section 6's own pass. Logged here as an addition to this otherwise-frozen
file, since it is the piece of the developer stage a prior dispatch could
not complete (its own sandbox denied the child-CLI launch); the addition
itself is the deviation from "frozen once committed," and is recorded as
such rather than silently edited in.

**Method.** The prior developer's own sandbox denied launching
`tm-review-changes` as a child `claude -p` process (a permission check
refused a command line naming `git` operations inside a child-process
`--allowedTools` argument string, even though those arguments were an
allowlist for the child, not a git invocation by the denying session
itself). The owner approved a lead-run path instead of a further
child-process attempt: the lead made a throwaway git worktree of this
repo, detached at base `aba6cb4eb93074b54f1324a90269e570b7755d5b`, and
applied the arm's diff from the previous developer's scoring copy (`git
diff --binary aba6cb4 226de7f`, the arm's uncommitted working tree
committed as one throwaway commit) as one local commit `858cfc6` (18
files, +1057 -5). It ran the workflow in-session from that worktree with
`args: { base: 'aba6cb4eb93074b54f1324a90269e570b7755d5b' }`. No child CLI
session was launched; the worktree has since been removed. This also set
aside section 6's isolation (fresh headless session, plugin off, no gh or
web, restricted tools): the review ran with the lead's plugin and tools, in
a worktree whose refs include the merged #384. Checked afterward: no
review agent's tool input names the reference script, its price table, or
the merge commit.
`.claude/workflows/tm-review-changes.js` is byte-identical at that base
and on `origin/main` (last changed in `41f3fc5`), so the production
version ran. One adaptation: the Workflow runtime refused the production
file both by name and by path, because the file's `meta` export is
computed from a `SPEC` constant rather than being the literal first
statement in the script; the lead ran a copy with `meta` hoisted to a
literal first statement and every other byte unchanged (self-checked).
The same computed-`meta` pattern is in all three production workflows
(`tm-map-codebase.js:54`, `tm-review-changes.js:43`,
`tm-review-codebase.js:62`), so all three likely fail to load under the
current Workflow runtime. Whether the runtime or the files are at fault is
not settled here. It is out of scope for #405 and needs its own issue.

**Run stats.** 8 agents (7 Sonnet dimension workers: bugs, security,
scope, tests, style, docs, perf; 1 Opus critic that consolidates), 3 of
the 8 (security, style, docs) returned empty findings, 650,996 ms
wall-clock, 678,834 subagent tokens, 162 tool uses. Journal (one result
line per agent):
`~/.claude-work/projects/-Users-TM-Desktop-github-orchestrai/c5168e00-8b3d-486c-9ad3-d2f4cd14cb6a/subagents/workflows/wf_dbb9188f-59a/journal.jsonl`.

**Result: verdict approve**, 0 must-fix, 1 should-fix (the failure path of
`main()`/`findLeadTranscript` is untested, which matters because both
SKILL.md changes in the diff rely on this script failing gracefully), 4
nits, 2 dismissed. `npm test` at the arm's tip: 361 tests, 0 failures. Full
summary in the report file, section 7.

The critic did not flag the diff's missing `plugin.json` version bump,
reasoning that `scripts/check-version-bump.mjs` does not exist at this
diff's base. Checked: correct, and the merged reference PR #384 also never
bumped `plugin.json`, so this is not a divergence the arm introduced.

Result JSON: `tm-review-changes-arm2.result.json` (lead's own scratch
directory at run time; not committed, per this package's "no `.claude/`
changes" constraint and since the report already carries the summary).
