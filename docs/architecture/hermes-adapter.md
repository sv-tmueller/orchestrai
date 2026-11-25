# Hermes adapter

The Hermes adapter implements the adapter interface (spawn, detectFailure,
retry) for the Hermes Agent host. It lets the orchestrator team run on
Hermes with GLM-5-3 and deepseek-v41-flash (or any configured model)
instead of Claude Code.

See `docs/architecture/adapter-interface.md` for the interface contract
and `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
section 4 Phase C for the design.

## Components

- `.claude/adapters/hermes.json` -- the default adapter table mapping tiers
  to models and efforts for the Hermes host.
- `.claude/adapters/hermes-openrouter.json` -- the OpenRouter variant table
  (see "OpenRouter variant (Kimi K3.1 Pro)").
- `.claude/adapters/hermes-adapter.mjs` -- the adapter module exporting
  `spawn`, `detectFailure`, `retry`, `resolveTier`, and `resolveRole`.
- `.claude/adapters/hermes-pipeline.mjs` -- the pipeline driver: a command
  line (see "Driver command line"), the gate, and the per-package stage
  loop that runs architect, developer, tester, reviewer and ship.
- `.claude/adapters/hermes-renderer.mjs` -- the workflow renderer that
  reads JSON spec files from `.claude/workflows/specs/` and drives the
  adapter's spawn/parallel operations.
- `.claude/workflows/__tests__/hermes-adapter.test.mjs` -- tests for the
  adapter table, interface, and renderer (dry-run mode).
- `.claude/skills/tm-kickoff/SKILL.hermes.md` -- the Hermes variant of the
  pipeline-driver skill. Source for the auto-discovered
  `~/.hermes/skills/autonomous-ai-agents/orchestrai/` skill.
- `.claude/skills/tm-advisor/SKILL.hermes.md` -- the Hermes variant of the
  batch-advisor skill (#346). Source for the auto-discovered
  `~/.hermes/skills/autonomous-ai-agents/tm-advisor/` skill. Loads the
  pipeline via `skill_view(name='orchestrai')` at dispatch time.

## Configuration

### Adapter table

The adapter table at `.claude/adapters/hermes.json` maps the three tiers
(judgment, worker, lead) to concrete models and efforts. The current
configuration targets GLM-5-3 for judgment and lead, and
deepseek-v41-flash for the worker tier:

```json
{
  "tiers": {
    "judgment": { "model": "vllm/release/glm-5-3", "effort": "max" },
    "worker": { "model": "vllm/release/deepseek-v41-flash", "effort": "max" },
    "lead": { "model": "vllm/release/glm-5-3", "effort": "max" }
  }
}
```

All tiers run at `max` effort. The self-hosted vLLM models carry no
token-cost ceiling, so this table lifts the paid-API effort policy
(`effort_ceiling: xhigh`, `forbidden_efforts: ["max"]`) that the
Claude Code and Codex adapter tables keep.

Because Hermes `delegate_task` has a single global model pin
(`delegation.model` in `~/.hermes/config.yaml`), the tier split is realized
mechanically at dispatch time, not by the adapter module: `delegation.model`
pins all delegate_task children to the worker model, and judgment roles
(architect, reviewer) are dispatched as one-shot Hermes subprocess seats
(`hermes chat -q -m <judgment-model> --reasoning max "<prompt>"`)
instead of delegate_task children. The adapter table records the intended
mapping; the pipeline driver (tm-kickoff / tm-advisor) realizes it.

To use a cheaper model for the worker tier, edit the `worker` entry:

```json
"worker": { "model": "<cheaper-model-id>", "effort": "high" }
```

The role-to-tier mapping is identical to the Claude Code adapter table.
Changing which tier a role uses (e.g. moving reviewer from judgment to
worker) means editing the `roles` map in both adapter tables.

### OpenRouter variant (Kimi K3.1 Pro)

A second table, `.claude/adapters/hermes-openrouter.json`, routes all three
tiers to Kimi K3.1 Pro through OpenRouter. It sits next to the self-hosted
table and does not replace it. `hermes.json` stays the default.

| Tier | Model | Provider | Effort | Fallback |
|------|-------|----------|--------|----------|
| judgment | moonshotai/kimi-k3.1-pro | openrouter | xhigh | moonshotai/kimi-k3 |
| worker | moonshotai/kimi-k3.1-pro | openrouter | xhigh | moonshotai/kimi-k3 |
| lead | moonshotai/kimi-k3.1-pro | openrouter | xhigh | moonshotai/kimi-k3 |

Selection. Set `HERMES_ADAPTER_TABLE` to a file name under the adapters
directory before the run. It defaults to `hermes.json`.

```bash
export HERMES_ADAPTER_TABLE=hermes-openrouter.json
```

The lead session is not spawned by the adapter, so select its model yourself:
`hermes ... -m moonshotai/kimi-k3.1-pro --provider openrouter --reasoning xhigh`.
Without `--reasoning` the lead uses `agent.reasoning_effort`, which can be
`max`. Seats spawned
by the adapter take model, provider, and effort from the table.

`HERMES_ADAPTER_TABLE` is read only by the adapter module. It selects the
variant for the programmatic driver (`hermes-pipeline.mjs`) and anything else
that spawns seats through `hermes-adapter.mjs`. The skill-driven
`delegate_task` path ignores it: there, workers follow `delegation.model` and
the provider in `~/.hermes/config.yaml`, and judgment seats use the command
hardcoded in `SKILL.hermes.md`. To run that path on Kimi, set
`delegation.model` to `moonshotai/kimi-k3.1-pro` with provider `openrouter`
and `delegation.reasoning_effort` to `xhigh` (children otherwise inherit the
parent's level, which can be `max`), and dispatch judgment seats with
`-m moonshotai/kimi-k3.1-pro --provider openrouter --reasoning xhigh`.

Effort policy. OpenRouter is a paid provider, so the paid-API policy applies,
unlike the self-hosted default table: `effort_ceiling` is `xhigh` and
`forbidden_efforts` is `["max", "ultra"]`. A seat on this table never runs at
`max`, provided the lead and the skill-path workers are set to `xhigh` as above.

Cost profile (OpenRouter listing, 2026-10-24, USD per 1M tokens, 1M context
for both models):

| Model | Input | Output | Cache read |
|-------|-------|--------|------------|
| moonshotai/kimi-k3.1-pro | 2 | 10 | 0.20 |
| moonshotai/kimi-k3 | 0.239 | 10.8 | 0.21 |

Not for customer repos. The model is not available through OpenRouter EU
in-region routing, so customer code must not go through this table.

The Claude Code host can also run against Kimi, with no table change. That
path is described once, in the README: "Other providers via a profile" under
Zone 1 "Model config".

### Model and provider config

The Hermes config (`~/.hermes/config.yaml`) pins the model and provider.
The adapter table references the model ID that Hermes resolves. For
example, with GLM-5-2 served via a custom provider:

```yaml
model:
  default: vllm/release/glm-5-2
  provider: custom
  base_url: https://your-provider.example.com/v1
  api_key: ${HERMES_CUSTOM_API_KEY}
```

The adapter does not authenticate to the model provider itself; that is
handled by the Hermes runtime config. The adapter table only declares
which model ID each tier uses.

### Isolation strategy

Hermes does not have a native worktree concept. The adapter relies on git
branch isolation: each role agent works on a branch, and handoff happens
through files in the repo. The `isolation: "worktree"` hint from the
interface is interpreted as "create a branch" on Hermes, not a git
worktree. For parallel stages, each delegated task works on the same
branch (read-only) and the results are merged by the consolidate stage.

## Dry-run mode

Set `DRY_RUN=true` to exercise the adapter and renderer without live API
calls. In dry-run mode, `spawn` returns synthetic reports shaped to
satisfy the schema, so the full fan-out (scout, parallel workers, critic
with fallback) can be tested offline.

```bash
DRY_RUN=true npm test
```

The test suite makes no live calls: it runs in dry-run mode, against stubs,
or against saved fixtures. Live runs require a Hermes session with the model
provider configured.

## Live mode

In live mode `spawn` runs one `hermes` subprocess per seat:

```
hermes -z "<role prompt + task>" -m <model> --provider <p> \
  --reasoning <effort> -t <toolsets> --in <worktree> --yolo --accept-hooks
```

`-z` prints only the final response, so the report is parsed from stdout
by `parseReport`, keyed by role against the contracts in
`docs/architecture/role-contracts.md`. Hermes documents no
structured-output parameter, so there is no schema to pass.

This runs as ordinary Node: `hermes` is a CLI reached through
`child_process`, with no host-injected globals. A Hermes lead session is
therefore not required. `node hermes-pipeline.mjs` plus `hermes -z`
workers is the whole team, and the Hermes skill is one way to launch it
rather than the only way.

Set `HERMES_BIN` to point at a different binary; tests use it so CI never
shells out to a real install.

The adapter never passes `-w`. Hermes' worktree mode registers an
`atexit` cleanup that force-removes the worktree and deletes its branch
unless there are unpushed commits, and it names branches from a UUID
rather than `<type>/<issue>-<slug>`. The driver creates one worktree per
package instead (`worktreePlan` and `ensureWorktree` in
`hermes-pipeline.mjs`) and passes it as `--in`.

`-t` restricts the tool surface but cannot express read-only: every seat
needs `terminal` for git, gh, and the check suite, and terminal implies
write capability. Read-only stays a prompt-level contract on this host.
What `-t` does enforce is flat-star: no seat gets the `delegation`
toolset, so no seat can re-delegate.

## Driver command line

```
node .claude/adapters/hermes-pipeline.mjs <arg>...
```

Each argument is an issue number or `label:<name>`. A label selects the open
issues carrying it (the first 100). Numbers and labels mix, and the package
list is all of them in argument order with duplicates dropped. The driver
works on the repo in the current directory, since `gh` and `git` find the
repo from there. It never merges.

The gate reads each issue and decides one outcome per package: `run`,
`resume`, `wait`, `complete`, `park`, `stop` or `skip`. The first matching
rule wins: closed, `needs-human`, `size:L` or `size:XL`, no size label,
a ready PR, a draft PR, `in-progress` with no PR, and then a plain run. A run
starts at the developer when the issue has a sub-plan comment (a comment with
a line that is exactly `SUB_PLAN`), and at the architect when it has none. An
unmerged `Blocked by: #N` blocker turns a run or resume into a wait. Only
wave 1 runs, because a later wave's blocker cannot be merged during the run.

An `in-progress` issue with no PR resumes at the developer when a branch named
`<type>/<n>-...` is on origin, on that branch. The developer is told the
branch has no PR, to finish the work and to open the draft PR. Without such a
branch the package runs from the developer. The tester's and reviewer's
reports belong on a PR, so a package with no PR is never resumed past the
developer.

In a live run each stage accepts only the report its contract prescribes:

- The architect's report is a sub-plan only when it opens with `SUB_PLAN` and
  has a body: text after `SUB_PLAN:` on the header line, or at least one
  non-empty line after it. A bare `SUB_PLAN` line is not a sub-plan. A
  sub-plan is posted on the issue. `NEEDS_DECISION` parks the
  package. The question may be on the same line, on the next line or after the
  bare word, and the reason reads `architect NEEDS_DECISION: <the question>`,
  cut to one line (see "Parking"). With no question at all it reads
  `architect NEEDS_DECISION`, with no colon. A `NEEDS_DECISION` field that
  is not text, or is empty, counts as no field: the question then comes from the
  first non-blank line after the header, outside any fenced block, so it is never
  the fence line of a json block.
  A `SPLIT_PROPOSAL`, an `ARBITRATION` or text with no header is not a
  sub-plan. The task asks the architect to end the sub-plan with one line that
  starts with `Size check:`, either `Size check: fits <label>` or
  `Size check: exceeds <label>, recommend <label>`. The driver reads the last line
  of an accepted sub-plan that is not blank under JavaScript's `trim()`, with the
  readers' rule (a line feed ends a line, and a CR before it is dropped). When
  that line starts with `Size check: exceeds` at its first character, followed by
  a word boundary (JavaScript's `\b`), the driver posts the sub-plan and
  then parks the package with the reason
  `architect size check: the work exceeds the size label`. The comparison is
  case-sensitive. No developer runs. These do not stop the package: the words on
  any other line, in a quote, indented, in another case, or on the last line
  after a vertical tab, a form feed, a lone carriage return, U+0085, U+2028 or
  U+2029. A sub-plan with no `Size check:` line runs as before. A sub-plan the
  gate finds on the issue is never read for it.
- The developer's `STATUS` must be `DONE` or `DONE_WITH_CONCERNS`, with a PR
  that is a pull request URL (it holds `/pull/<digits>`) or a number, on the
  single line of the value (see "Parking"). The PR comes from the report, or
  from the gate on a resume when the report names none. It is missing only when
  the field is absent, is json `null`, or is text with no non-blank character.
  With no PR known the package then stops. Any other value must be a pull request
  URL or a number on its single line (a json number counts as its digits). An
  object, an array, a boolean, or text that is neither stops the package, also
  when the gate knows a PR.
  `BLOCKED` and `NEEDS_CONTEXT` park with the developer's notes. This
  holds in a fix round too, as far as the `STATUS` goes. `NEEDS_CONTEXT`
  always parks: no seat contract has a job that answers a question, so the
  driver has nobody to ask.
- The tester's `VERDICT` is exactly `PASS` or `FAIL`, and the reviewer's is
  exactly `APPROVE` or `CHANGES_REQUESTED`, in the first pass and in every
  re-test and re-review. A lower-case word, a word with trailing text or any
  other word is not a verdict.

A seat field that is not text never throws. A json number is read as its
digits. Any other json value that is not a string (an object, an array, a
boolean, `null`) is read as an absent field: the stage that needs it stops with
`<role> seat returned no usable report` (a `STATUS`, a `VERDICT`), and a note or
a question that is absent leaves the reason without a colon. The `PR` is the
exception, because it can also come from the gate: see the developer bullet
above. There `null` is a missing PR, and an object, an array or a boolean is an
invalid one.

Anything else, and a seat that returns nothing, stops the package: it parks
with the reason `<role> seat returned no usable report`. `runPipeline` with
`dryRun` uses placeholders in place of seat output instead, so the dry-run
tests complete.

stdout carries the gate lines, the wave plan and one result line per package.
In a live run with at least one gate entry the report follows the result lines
(see "Ship and report"). A dry run prints none. A package that throws (a failed
`git fetch`, `git worktree add` or `gh` write) does not stop the others: its
line reads `#<n> error: <reason>`, and every other package still runs and
reports. The reason is the single line of the failed command's stderr, cut as
described under "Parking". When the error is not a failed command, it is the
single line of the error's message, cut the same way. A failed command at the
gate prints one line on stderr instead: the command with its arguments on one
line (a newline in an argument shows as a space), then the single line of its
stderr. An answer the driver cannot accept is a failed read with a fixed
message, `gh <command> returned a malformed answer`, that holds none of the
answer. At the gate the message is printed on stderr, and in a package it is
that package's `error` line. A read is accepted only when:

- `gh issue list` is a list of objects, each with a positive integer `number`.
- `gh issue view` is an object with a positive integer `number` and with
  `labels` and `comments` that are lists.
- `gh pr list` is a list of objects, each with a positive integer `number` and
  a `closingIssuesReferences` that is a list. An entry of
  `closingIssuesReferences` that is not an object matches no issue.
- `gh pr view <pr> --json comments` is an object whose `comments` is a list.
- The closing read of ship is described under "Ship and report".

Progress, dry-run notes and errors go to stderr.

`DRY_RUN=true` is the confirmation step. The driver still reads GitHub, but
it creates no label, posts no comment, makes no worktree and starts no seat.
Each skipped write is named on stderr. A run without `DRY_RUN` is the
confirmed run and asks no questions.

Exit codes: 0 when the run finished (parked, stopped, waiting and skipped
packages are outcomes, not failures), 1 when a `gh` or `git` call failed at
the gate, when any package ended with an `error` line, or when something
unexpected happened (a mistyped issue number ends here), and 2 for a usage
error, before any GitHub call.

### Fix rounds

Each tester `FAIL` and each reviewer `CHANGES_REQUESTED` is one fix round. Each
seat has up to 3, and the two counts never touch each other. The driver posts
the report on the PR, the developer fixes it, and the tester runs again. After
a reviewer fix round the re-test comes first. A `PASS` there goes to the
re-review. A `FAIL` there is an ordinary tester round: it adds to the tester
count and goes through the tester loop. The 4th `FAIL` or the 4th
`CHANGES_REQUESTED` is posted and then parks the package, with the reason
`tester fix rounds exhausted (3/3)` or `reviewer fix rounds exhausted (3/3)`.

Every tester and reviewer report is posted on the PR with `gh pr comment`,
`PASS` and `APPROVE` included:

```
**<Tester|Reviewer> report: <VERDICT> (issue #<n>, <tester|reviewer> fix rounds <c>/3)**

<the seat's report, trimmed, unchanged and unquoted>
```

`<c>` is that seat's count once this report is counted, so the report that
uses up the cap reads `4/3`. The comment always carries a `VERDICT:` line at
the start of a line: the seat's own, or one the driver adds under the header
when the report text has none the readers can read (a verdict the parser took
from a json block, or another verdict word ahead of the real one). So
`resumeStage` reads the stage back from it. The same lines give the counts:
`countFixRounds` counts a `FAIL` as a tester round and a `CHANGES_REQUESTED` as
a reviewer round, from the first verdict line of each comment. A bold header, a
quoted line and a fact-checker verdict do not count. The readers split a
comment at a line feed only (a CR before it is dropped). U+2028, U+2029, a
lone CR, a vertical tab, a form feed and U+0085 do not start a line for the
readers. That is the readers' rule, and it is not the rule for what the driver
writes (see "Parking"). The gate reads the PR's
comments once and hands the counts to the resumed run, so a run that starts
later has the numbers the run that stopped had. A package that parked on a
used-up count parks again if it is resumed, because the count comes from the
PR.

The fix prompt carries the whole comment body, not the `FINDINGS` field. The
report parser keeps only the first line of a multi-line key, so a prompt built
from the field would drop every finding after the first. On a resume with
findings, the round is the count of the findings' kind, which already
includes that report. With no count given it is 1. A count already above 3
parks before any seat is dispatched.

A seat is never sent the same prompt twice in one run. The re-test and the
review prompts name the latest fix round they follow, the fix prompts name
their own round, and the counts only rise. The first seat of a resumed run
gets one more line asking it to check the branch and the PR for work an
earlier run left, since the run that stopped may have sent the same text.
The one exception is the developer resume for a branch with no PR: it keeps
the exact prompt of #355's ruling and gets no pick-up line.
The reviewer's prompt carries the latest tester report, for the untested
claims it rates. After a resume at the reviewer, which has no tester report in
memory, it names the tester's comment on the PR instead.

#### Arbitration

A developer may dispute a finding of a reviewer round. The fix prompt of every
reviewer round that has no outcome yet (below) has this after the findings:

```

If a finding is wrong, do not fix it. Under DEVIATIONS, write one line per such finding: `pushback: finding <k>: <why it is wrong>`.
```

A tester fix prompt does not carry it: a tester finding is settled by the
re-test, and a tester round is never arbitrated.

**What counts as a pushback.** A line of the developer report's `raw` that
starts with optional spaces and tabs, then optionally `DEVIATIONS:` or `NOTES:`
and spaces, then optionally a list marker (`-` or `*` and spaces, or digits, a
dot and spaces), and then `pushback: finding <digits>:`. The match is
case-sensitive and uses the readers' rule (see "Fix rounds"): a line feed starts
a line, and a CR before it is dropped. So the words after a lone carriage return,
a vertical tab, a form feed, U+0085, U+2028 or U+2029 do not make a pushback, a
quoted line does not, and neither does the suffix line of the prompt echoed back.
Only `raw` is read: a pushback that appears only in the json block is not read,
nothing is arbitrated, and the re-review decides.

**The flow.** The check sits after the developer's report passes the status
check and before the re-test. On a resume with reviewer findings it sits in the
developer stage, after the PR check, so a live run spends no architect on a
report with a bad PR. When the report pushes back, and the round has no outcome
yet, the driver dispatches the architect (judgment tier, the package worktree):

```
JOB: ARBITRATION

Issue #<n>, PR <pr>, reviewer fix round <k>/3: the developer pushed back on findings of the reviewer report below. For each finding pushed back on, decide who is right and state the required outcome.

The reviewer report:
<the posted report body>

The developer's report:
<the developer's raw>
```

The reply is accepted only when it is an `ARBITRATION` report with a body (the
rule of the sub-plan: text after `ARBITRATION:` on the header line, or a
non-empty line after it). A `NEEDS_DECISION` parks as in the sub-plan stage, in a dry run too.
Any other reply parks with `architect seat returned no usable report`. A dry run
accepts any other reply.

The outcome is posted on the PR (a dry run logs the write):

```
**Arbitration outcome (issue #<n>, reviewer fix round <k>/3)**

> <the architect's reply, trimmed, one `> ` per line>
```

The reply is quoted the way a park comment quotes seat text (see "Parking"). The
developer is then dispatched again for the same round:

```
Issue #<n>, branch <branch>, reviewer fix round <k>/3: the arbitration outcome below is final. Make every change it requires, leave every finding it overrules as it is, and report.
<the outcome comment's body>
```

Its `STATUS` is checked like that of any fix-round report (a `BLOCKED` parks),
and then the re-test follows.

**The same round.** An arbitration is not a new round. It moves no count, the
re-test and the re-review name `after reviewer fix round <k>/3`, and a `FAIL` in
that re-test is an ordinary tester round. The architect's dispatch adds to no
count. A round is arbitrated at most once: the outcomes of the run are keyed by
their header, and a round that already has one is not arbitrated again. That
covers a pushback in the second developer report, and a resume after the outcome
was posted.

**Settled findings.** While the run holds an outcome, every dispatch gets the
block below after its prompt, and the first seat of a resume gets the pick-up
line after the block. This includes a later arbitration, which sees the earlier
outcomes. The one prompt sent word for word (the developer resume for a branch
with no PR) never gets it. The outcome of the arbitration in progress is in its
developer prompt and joins the block after that dispatch.

```

Settled by arbitration on this PR. These outcomes are final: a finding they overrule is not raised again and not fixed.
<outcome>

<outcome>
```

**Resume.** `resumeStage` skips an outcome comment: after its header and an
empty line every line starts with `> `, so it has no `VERDICT:` line at the start
of a line. The stage and the findings are read from the latest comment that has
a verdict line, as before. `countFixRounds` does not count it. The gate reads the
outcomes from the PR comments it already reads, with no further call. A comment
is an outcome when its first line, read with the readers' rule, is exactly the
header above, with the number of this issue and a round number in digits. A
header on a later line, after another line end, for another issue, or in the
text of a posted report (the first line of a posted report is the driver's own)
is not read. The bodies are kept in order of creation, and `resume.arbitrations`
is set only when there is at least one. The driver does not look at who wrote a
comment, for an outcome or for a verdict. The run starts with these outcomes. A round that already has one gets its fix prompt
with no pushback suffix, then the block and the pick-up line, and a pushback in
the developer's report is not arbitrated.

**Dry run.** `runPipeline` with `dryRun` arbitrates only when a scripted
developer report pushes back: the adapter's dry-run developer has no `raw`. The
outcome write is logged as `dry run, skipped: gh pr comment ...`.

Arbitration adds nothing to stdout. A stop inside it is one more `parked` line,
and the summary comment names the number of arbitrations (see "Ship and report").

### Ship and report

A package ships when the tester's last verdict is `PASS` and the reviewer's is
`APPROVE`. The writes go in this order: `in-progress` is added if this run has
not added it, the closing references are read, `gh pr ready` runs, `in-progress`
comes off, and the summary comment is posted on the issue. `state.done` is set
only after the summary comment succeeded. A write that fails throws, so the
package ends with an `error` line and is not done.

The PR has to close the issue. The driver reads
`gh pr view <pr> --json closingIssuesReferences,number` through the runner and
looks for an entry whose `number` is the issue. The words of the PR body do not
count, and this is the same test the gate uses to find a package's PR. When no
entry matches, the package parks with `PR #<number> does not close #<n>`:
`<number>` is the number in the read and `<n>` is the issue, so the reason holds
no seat text. `in-progress` comes off and the PR stays a draft. The
driver does not edit the PR: a person adds `Closes #<n>` and removes
`needs-human`, and the next gate finds the draft PR and resumes at ship from
the `APPROVE` comment. A dry run makes no read.

The driver accepts the answer only when it is an object whose `number` is a
positive integer and whose `closingIssuesReferences` is a list. Anything else is
a failed read: the package gets an error.

The summary comment on the issue is:

```
Pipeline complete: PR <pr> is ready for review.

Tester PASS, reviewer APPROVE. Fix rounds used: tester <t>/3, reviewer <r>/3. Arbitrations: <a>.
```

`<pr>` is the PR value of the package, cut to its single line, `<t>` and `<r>`
are the counts of fix rounds used, and `<a>` is the number of arbitrations: the
outcomes of this run and the ones an earlier run left on the PR.

The report is `formatReport(entries, results)`, a pure function that returns
its lines. `main` prints it after the result lines in a live run with at least
one gate entry, also when no package ran. It is:

```
## What happened
- PR #<p> ready  - <title>
- #<n> parked (needs-human): <reason>
- #<n> error: <reason>
- #<n> stopped: <gate detail>
- #<n> skipped: <gate detail>
- #<n> deferred: <gate detail>

## Next steps
1. Review & merge: #<p>, #<p>
2. Decide on #<n>, #<n> (retry or close)
3. Run the driver again to start the next wave
```

"What happened" has one line per gate entry, in gate order:

- A package shipped in this run and a gate `complete` entry give the PR line.
  `<p>` is the PR's number from GitHub: the number of the closing read for a
  package shipped in this run, and the gate's own number for a `complete` entry.
- A package that parked in this run and a gate `park` give the `parked` line.
  A package that threw gives the `error` line.
- A gate `stop`, `skip` and `wait` give `stopped`, `skipped` and `deferred`.

"Next steps" lists only the items that have members, numbered from 1: "Review
& merge" for the ready PRs, "Decide on" for the parked and errored packages, and
"Run the driver again" when any package was deferred. With none, the section is
`1. Nothing to do`. It holds issue and PR numbers only. A title, a reason, an
error and a gate detail are each one line cut with the writer's rule (see
"Parking"). Every line starts with a fixed prefix and the text follows it on the
same line, so no text starts a line of its own.

### Parking

Every stop of a package writes three things: the comment `Parked: <reason>` on
the issue, the `needs-human` label, and removal of `in-progress` when this run
or the gate had put it on. Where the stop has seat text (a `NEEDS_DECISION`,
`BLOCKED` or `NEEDS_CONTEXT` report), the comment quotes it under the reason,
one `> ` per line, so no line of it starts with `SUB_PLAN` or `VERDICT:` where
the gate reads comments. A developer `BLOCKED` or `NEEDS_CONTEXT` report with
no notes parks as `developer BLOCKED` or `developer NEEDS_CONTEXT`, with no
colon.

Two rules about lines apply, one for what the driver writes and one for what it
reads. They differ on purpose.

**The writer ends a line at any of seven characters:** line feed, carriage
return, vertical tab, form feed, U+0085, U+2028 and U+2029. A CRLF pair is one
line end. These seven are Unicode's mandatory line breaks, and a consumer of the
output may end a line at more than a line feed. The rule does not make the
output safe against every consumer: other control characters pass through, and
Python's `str.splitlines`, for one, also ends a line at U+001C, U+001D and
U+001E. A report body and a sub-plan are posted as the seat wrote them. The
writer's rule covers:

- The single line of seat text. Where the driver cuts seat text to one line (the
  developer's notes for a reason, the architect's question for a reason, the
  developer's `PR` value), it takes the first line that holds a non-blank
  character, trimmed. A line that is only a code fence marker (three or more
  backticks or tildes, with or without a language word) is skipped. The result
  is empty only when the whole text is blank. If the reason has no text left, it
  has no colon. The whole text of the seat's report stays in the quoted lines
  under the reason.
- The quoted details of a park comment, and the quoted reply in an arbitration
  outcome comment. Each of the seven starts a new `> ` line and is written as a
  line feed.
- The header line of an arbitration outcome comment is fixed text with two
  numbers. An empty line follows it, then the quoted reply.
- So `state.parked`, the first line of a park comment, the first line of an
  outcome comment, every line of the summary comment, every result line on
  stdout and every line of the report hold none of the seven. The `error` line
  of a package is cut with `oneLine`, the same cut as every other single line. So is the detail of a gate line, which can hold a
  branch name read from origin.

The developer's `PR` value is cut to its single line before it is checked, so a
value with a blank first line is judged by its first non-blank line. It is
missing only when that line is empty, which means the whole value is blank. A
report body posted on a PR stays as the seat wrote it.

**The readers split at a line feed only:** `resumeStage`, `countFixRounds` and
the sub-plan reader (see "Fix rounds"). Seat text reaches a comment or a result
line in three forms only: a posted report body, a quoted block, or a single line
cut as above.

The stops are: an architect `NEEDS_DECISION` (in the sub-plan or in an
arbitration), an architect size check that says the work exceeds the size label,
a developer `BLOCKED` or `NEEDS_CONTEXT` (also in the report after an outcome),
a seat with no usable report (an arbitration reply that is not an `ARBITRATION`
with a body included), an exhausted count, no PR to mark ready, a PR that does
not close the issue, and an unexpected final state. The size-check stop
applies in a live run only: a dry run does not stop on a Size check line. The
result line on stdout is `#<n> parked: <reason>`, with that same one-line reason.

### Branch name

The branch is `<type>/<n>-<slug>`, and the slug comes from the issue title:
lowercase, every run of characters other than letters and digits becomes one
hyphen, hyphens trimmed at both ends, cut at 40 characters, and `pending` when
nothing is left. The worktree is created on that branch and the developer is
told the same name. A resume keeps the branch its PR already has.

## Workflow rendering

The renderer (`hermes-renderer.mjs`) reads the same JSON spec files that
the Claude Code JS renderer consumes (via its embedded SPEC constant).
This proves the data-spec approach works on a second host: the spec is
the single source of truth, and each host provides its own renderer.

The renderer handles all three parallelism modes (single, fixed-list,
dynamic-list) and the fallback ladder for stages that declare one. The
prompt templates are minimal in the current implementation; a full
production renderer would interpolate the complete prompt from the
workflow's JS source or a shared prompt template library.
