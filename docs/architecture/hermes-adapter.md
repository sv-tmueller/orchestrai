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
  line (see "Driver command line"), the gate, and the per-package loop that
  runs the developer, the reviewer when the review gate says so, and ship.
- `.claude/adapters/hermes-renderer.mjs` -- the workflow renderer that
  reads JSON spec files from `.claude/workflows/specs/` and drives the
  adapter's spawn/parallel operations.
- `.claude/workflows/__tests__/hermes-adapter.test.mjs` -- tests for the
  adapter table, interface, and renderer (dry-run mode).
- `.claude/skills/tm-kickoff/SKILL.hermes.md` -- the Hermes kickoff skill: it
  runs `hermes-pipeline.mjs` and reads its output. Source for the auto-discovered
  `~/.hermes/skills/autonomous-ai-agents/orchestrai/` skill.
- `.claude/skills/tm-advisor/SKILL.hermes.md` -- the Hermes variant of the
  batch-advisor skill (#346). Source for the auto-discovered
  `~/.hermes/skills/autonomous-ai-agents/tm-advisor/` skill. Runs the packages
  through `hermes-pipeline.mjs` after the sign-off.

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

The adapter realizes the tier split for every seat it spawns: `buildArgv`
passes the model, provider and effort of the seat's tier. The driver
dispatches only through it, and so does the orchestrai skill, which runs the
driver. The tm-advisor Hermes skill runs the same driver for its batch, so
it dispatches no seat by hand.

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
variant for the driver (`hermes-pipeline.mjs`), and so for the orchestrai skill
that runs it, and for anything else that spawns seats through
`hermes-adapter.mjs`. The tm-advisor Hermes skill runs the driver too, so the
variable applies to it the same way.

Effort policy. OpenRouter is a paid provider, so the paid-API policy applies,
unlike the self-hosted default table: `effort_ceiling` is `xhigh` and
`forbidden_efforts` is `["max", "ultra"]`. A seat on this table never runs at
`max`, provided the lead session is set to `xhigh` as above.

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
node "${ORCHESTRAI_ROOT:-.claude}/adapters/hermes-pipeline.mjs" <arg>...
```

The driver is the code form of `docs/architecture/light-flow.md`: a developer, a
reviewer only when the review gate says so, at most 2 fix rounds, then ship.
This section describes what the code does; the flow doc is the rule.

### How the driver is found

The driver finds its own files (the adapter table, the role prompts) by its
module location, never by the current directory. So the only thing that ties it
to a repo is the path the caller names it by. `ORCHESTRAI_ROOT` is the folder
that holds `adapters/`, and it defaults to `.claude`, the way the Claude side
uses `${CLAUDE_PLUGIN_ROOT:-.claude}`.

- In a repo that carries orchestrai's `.claude/adapters` folder, leave it unset.
- In any other repo, point it at the `.claude` folder of an orchestrai checkout,
  for example `export ORCHESTRAI_ROOT=/home/me/orchestrai/.claude`. The driver
  still works on the repo in the current directory: `gh` and `git` find the repo
  from there.
- When neither the variable nor the default leads to
  `adapters/hermes-pipeline.mjs`, the skill stops and tells the user to set the
  variable. The driver is not bundled into the skill, because a bundle would be a
  second copy to keep in step.

Both Hermes skills and the split-proposal command of the kickoff skill take the
driver and the adapter from the variable. `hermes-kickoff-skill-text.test.mjs`
runs them from a folder with no `.claude`, with the variable set.

### Arguments and the gate

Each argument is an issue number or `label:<name>`. A label selects the open
issues carrying it (the first 100). Numbers and labels mix, and the package list
is all of them in argument order with duplicates dropped. The driver never
merges.

The gate reads each issue and decides one outcome per package: `run`, `resume`,
`wait`, `complete`, `park`, `stop` or `skip`. The first matching rule wins:

1. closed: `skip`;
2. labeled `needs-human`: `skip`;
3. `size:L` or `size:XL`: `stop`, split it first;
4. no size label: `park`, no guessed size;
5. a ready PR for the issue: `complete` (the highest PR number);
6. a draft PR: `resume` at the stage its comments show (below);
7. `in-progress` with no PR and a branch `<type>/<n>-...` on origin: `resume` at
   the developer on that branch, who is told to finish the work and open the PR;
8. no `## Approach` section in the issue body or any comment: `park`. The driver
   never dispatches a developer with no plan, and it cannot write one;
9. otherwise `run` at the developer.

An unmerged `Blocked by: #N` blocker (a whole line, closed as completed) turns a
`run` or `resume` into a `wait`. Only wave 1 runs, because a later wave's blocker
cannot be merged during the run. Wave 1 runs as a rolling pool of 3: the next
package starts when any one finishes. The gate writes nothing.

Resume reads GitHub state only. The stage comes from the latest PR comment that
has a line starting with `VERDICT: APPROVE` or `VERDICT: CHANGES_REQUESTED`:

| State | Stage |
| --- | --- |
| no PR | `develop` |
| a PR, no review comment | `gate`: run the review gate. On an S issue this is still the gate, never a new developer |
| last review `CHANGES_REQUESTED` | `fix`: the developer gets that comment, then a re-review |
| last review `APPROVE` | `done`: ship, if the sha on that comment's `CHECKS` block is the PR head; else the gate (a reviewer runs again) |

`countFixRounds` counts the `CHANGES_REQUESTED` comments on the PR, so a resumed
run starts with the count the stopped run had. A package parked on a used-up
count parks again if it is resumed. The readers split a comment at a line feed
only, and a quoted line does not count.

### One package

1. The driver creates the package worktree (`<repo>/.worktrees/pkg-<n>`, branch
   `<type>/<n>-<slug>`, the slug from the issue title: lowercase, other runs
   hyphenated, at most 40 characters, `pending` when empty) and runs every seat
   in it. It never passes `hermes -w`. A resume continues the branch the PR
   already has.
2. `in-progress` goes on the issue and the developer runs (worker tier). Its
   `STATUS` must be `DONE` or `DONE_WITH_CONCERNS`, and its `PR` a pull request
   URL (it holds `/pull/<digits>`) or a number. `BLOCKED` and `NEEDS_CONTEXT`
   park with the developer's notes: no seat has a job that answers a question.
3. The review gate decides whether a reviewer runs (judgment tier). It does when
   `needsReview` says so: the issue is `size:M` or larger, the diff (read with
   `gh pr diff <pr> --name-only`) touches a path in `RISKY_PATHS`, or the
   developer reported `DONE_WITH_CONCERNS`. `RISKY_PATHS` is `.claude/agents`,
   `.claude/skills`, `.claude/workflows`, `.github/workflows`, and the names of
   dependency manifests and lockfiles at any depth. It also runs when the
   developer's `CHECKS` block (the line and every line up to the next report key)
   has no command or a command that did not exit 0, and at a resume into the gate,
   where there is no `CHECKS` block to trust. Otherwise the lead's own check
   stands: every command in the block exited 0.
4. The reviewer's `VERDICT` must be exactly `APPROVE` or `CHANGES_REQUESTED`. The
   driver posts every reviewer report on the PR as
   `**Reviewer report: <VERDICT> (issue #<n>)**`, then the report as the seat
   wrote it, with a `VERDICT:` line added when the seat's own cannot be read back.
5. `CHANGES_REQUESTED` is one fix round. The driver sends the developer the whole
   comment (the parser keeps only the first line of a multi-line `FINDINGS`),
   then the reviewer reviews again. The 3rd `CHANGES_REQUESTED` parks the package
   with `fix rounds exhausted (2/2)`.
6. A developer who disputes a finding parks the package with
   `developer disputes a finding of the review`. The fix prompt ends with the rule:
   under `DEVIATIONS`, one line per disputed finding,
   `pushback: finding <k>: <why it is wrong>`. The driver reads that line (also
   after `DEVIATIONS:` or `NOTES:`, a list marker or a number) in the report's
   raw text. No seat settles the dispute here: the owner decides.
7. Anything else, and a seat that returns nothing, parks with
   `<role> seat returned no usable report`. A dry run uses placeholders in place
   of seat output instead.

### Ship

The writes go in this order, and a failed write throws, so the package ends with
an `error` line and is not done:

1. The driver reads the PR with
   `gh pr view <pr> --json closingIssuesReferences,headRefOid,number`. The PR has
   to close the issue (GitHub's own list, not the words of the body), else the
   package parks with `PR #<number> does not close #<n>` and the PR stays a draft.
2. The reviewer's `CHECKS` block must start with a commit sha (7 to 40 hex
   digits) that the PR head starts with. With another sha, or none, the review
   does not cover the head: the driver posts nothing and runs the review gate
   again. A second miss parks with `the PR head moved after two reviews, so no
   review covers it`, or `two reviews gave no head sha on CHECKS, so no review
   covers the head`. A re-review is not a fix round. A resume at `done` takes the
   sha from the latest review comment and goes through the same check.
3. `orchestrai/review` = `success` is posted on the head read in step 1:
   `gh api -X POST repos/{owner}/{repo}/statuses/<head> -f state=success -f context=orchestrai/review -f description=<d>`,
   with `<d>` = `approved by reviewer`, or `not required (size S)` when the
   gate skipped the reviewer; in that case a PR comment
   `Review not required (size S)` goes on first. This is the only status the
   driver posts, and `main` never requires `orchestrai/test`.
4. `gh pr ready`, `in-progress` comes off, and the summary comment goes on the
   issue: `Pipeline complete: PR <pr> is ready for review.`, then
   `Reviewer: <APPROVE | not required (size S)>. Fix rounds used: <c>/2.`

Hermes exceptions to `docs/architecture/light-flow.md`, because the driver has
no lead seat to judge:

- It does not queue auto merge. The PR is left ready for a person to merge.
- A developer `CHECKS` block with a nonzero exit goes to the reviewer instead
  of back to the developer as a fix round. Safe, at the cost of one reviewer
  dispatch.
- An unsized issue parks at the gate instead of being sized by the lead.

### Parking

Every stop writes three things: `Parked: <reason>` on the issue, the
`needs-human` label, and removal of `in-progress` when this run or the gate had
put it on. Where the stop has seat text (a `BLOCKED` or `NEEDS_CONTEXT` report, a
dispute), the comment quotes it under the reason, one `> ` per line, so no line of
it starts with `VERDICT:` where the readers look. The stops are: a developer
`BLOCKED` or `NEEDS_CONTEXT`, a seat with no usable report, a dispute, an
exhausted count, a PR that does not close the issue, and a stale review. The
result line is `#<n> parked: <reason>`.

Text the driver writes ends a line at any of seven characters (line feed, CR,
vertical tab, form feed, U+0085, U+2028, U+2029), so a reason, a result line and a
report line each hold one line of seat text, cut to its first non-blank line.

### Output, dry run and exit codes

stdout carries the gate lines (`#<n> <size> <outcome>: <detail>`), the wave plan
(`wave <k>: ...`, `waiting: ...`) and, in a live run, one result line per package
(`#<n> done: PR <pr>`, `#<n> parked: <reason>`, `#<n> error: <reason>`) and the
report. Progress, dry-run notes and errors go to stderr.

`DRY_RUN=true` is the confirmation step. The driver still reads GitHub, but it
creates no label, posts no comment, makes no worktree and starts no seat, and it
prints the plan and stops. Each skipped write is named on stderr. A run without
`DRY_RUN` is the confirmed run and asks nothing. The advisor skill treats its
sign-off as that confirmation and runs live.

The report is `formatReport(entries, results)`:

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

One line per gate entry, in gate order. "Next steps" lists only the items that
have members, numbered from 1; with none it is `1. Nothing to do`.

A package that throws (a failed `git fetch`, `git worktree add` or `gh` write)
does not stop the others: its line reads `#<n> error: <reason>`, the first line of
the failed command's stderr. A failed read at the gate prints the command and the
first line of its stderr on stderr and exits 1. An answer the driver cannot
accept is a failed read with the fixed message
`gh <command> returned a malformed answer`.

Exit codes: 0 when the run finished (parked, stopped, waiting and skipped
packages are outcomes, not failures), 1 when a `gh` or `git` call failed at the
gate, when a package ended with an `error` line, or when something unexpected
happened, and 2 for a usage error, before any GitHub call.

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
