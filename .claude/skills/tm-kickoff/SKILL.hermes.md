---
name: tm-kickoff
description: "Run refined, sized GitHub issues through the orchestrai pipeline driver, node .claude/adapters/hermes-pipeline.mjs: a dry run to confirm, then the live run to ready PRs. User-invocable only."
---

This skill runs the pipeline driver and reads its output back to the user. The
driver does the pipeline itself: the gate, the waves, every seat, parking and
the report. It is described in `docs/architecture/hermes-adapter.md`. Do none
of its steps by hand.

The only GitHub write this skill makes is the split-proposal comment (see
"What each line asks of you").

Run every command below in the top directory of the repo to be worked on. The
driver works on the repo in the current directory, and the commands name it by
a path inside that repo. If `.claude/adapters/hermes-pipeline.mjs` is not there,
stop and tell the user: this skill needs orchestrai's `.claude/adapters` folder
in the repo.

## When to use

The user asks to run the orchestrator team on refined, sized issues. Refining a
need into issues is `tm-advisor`'s job.

## Arguments

Take them from the user's message. Each one is an issue number or
`label:<name>`. Pass bare numbers, `42`, not `#42`: the driver rejects `#42`
with `bad argument: "#42"` and exit 2. With no arguments, ask which issues to
run.

## Run the driver

Seats take their model, provider and effort from `.claude/adapters/hermes.json`.
If the user asks for the OpenRouter variant, put
`HERMES_ADAPTER_TABLE=hermes-openrouter.json` in front of every `node` command
of this skill. Never do that on a customer repo. Details:
`docs/architecture/hermes-adapter.md`, "OpenRouter variant (Kimi K3.1 Pro)".

Step 1, a dry run. It reads GitHub, prints the gate and the wave plan, writes
nothing and starts no seat:

```
DRY_RUN=true node .claude/adapters/hermes-pipeline.mjs <arguments>
```

Show its stdout to the user as it is and ask whether to run. This is the only
question of the run. Any answer but yes: stop.

Step 2, the live run, with the same arguments:

```
node .claude/adapters/hermes-pipeline.mjs <arguments>
```

It asks nothing. It reads GitHub again, so its own gate lines count. It runs
until every package of wave 1 has ended, which can take hours. Start it so that
no timeout stops it, and keep its stdout: the result lines and the report come
only at the end. Progress and dry-run notes go to stderr.

## Read the output

Quote these shapes as printed.

- Gate line, one per issue: `#<n> <size> <outcome>: <detail>`. `<size>` is
  `size:S`, `size:M`, `size:L`, `size:XL` or `unsized`. `<outcome>` is `run`,
  `resume`, `wait`, `complete`, `park`, `stop` or `skip`.
- Wave plan: `wave <k>: #<n> #<n>`, and `waiting: #<n> (blocked by #<b>, #<b>)`.
  Only wave 1 runs.
- Result lines, live run only, one per package that ran: `#<n> done: PR <pr>`,
  `#<n> parked: <reason>` or `#<n> error: <reason>`.
- Report, live run only, when the gate had at least one entry: it starts at the
  line `## What happened` and ends with the numbered list under `## Next steps`.
  Relay it as printed. A dry run prints no report.
- Empty stdout with exit 0: the `label:` arguments selected no open issue.

Exit codes:

- 0: the run finished. Parked, stopped, waiting and skipped packages are
  outcomes, not failures.
- 1: a `gh` or `git` call failed before the gate lines (one line on stderr, no
  gate lines), a package ended with an `error` line, or something unexpected
  happened. Report it and stop.
- 2: a usage error, before any GitHub call. stderr holds the error, then the
  usage line. Fix the arguments and start again at the dry run.

## What each line asks of you

- **`stop`** (`#<n> size:L stop: size:L, split it first`, or `size:XL`; report
  line `- #<n> stopped: ...`). The driver only stops the issue. The next step is
  yours: a split proposal from the architect. Ask for it only after a live run.
  If the user declined the live run, name the stopped issues and do nothing
  more. After the live run, check for an issue comment that starts with
  `SPLIT_PROPOSAL`:

  ```
  gh issue view <n> --json comments --jq '[.comments[].body | select(startswith("SPLIT_PROPOSAL"))] | length'
  ```

  If the count is 0, run the command below with its stdout redirected to a
  file outside the repo (`mktemp` makes one). It can run for up to 30 minutes,
  the adapter's limit for one seat, so start it so that no shorter timeout stops
  it. On exit 0 the file starts with `SPLIT_PROPOSAL` and holds the proposal:
  post it with `gh issue comment <n> --body-file <file>`. On any other exit,
  post nothing: stderr holds the reply, `no report` or an error. Tell the user
  which one happened.

  ```
  node --input-type=module -e 'const { spawn } = await import("./.claude/adapters/hermes-adapter.mjs"); const r = await spawn("architect", process.argv[1], { tier: "judgment", cwd: process.cwd() }); const text = typeof r?.raw === "string" ? r.raw.trim() : ""; if (!/^SPLIT_PROPOSAL(?::|\s)\s*\S/.test(text)) { console.error(text || "no report"); process.exit(1) } console.log(text)' "JOB: SPLIT_PROPOSAL

  Issue #<n>: read the issue and its comments, then propose the split."
  ```

  It goes through the adapter, so it uses the table, the env var, the role
  prompt and the effort guard, and this skill names no model. It prints a reply
  only when the reply starts with `SPLIT_PROPOSAL` and has text after that word.
  Never run it with `DRY_RUN=true`. Never post a reply that is not a split
  proposal.
- **`park`, `parked`, `parked (needs-human)`**: in a live run the driver
  posted `Parked: <reason>` on the issue and set `needs-human`. A dry run
  posts nothing and sets no label. A human decides. Report it with its reason.
  Do not clear the label and do not rerun it yourself. For `architect size
  check: the work exceeds the size label`, the sub-plan on the issue names the
  label it recommends. Once the user has dealt with the reason and removed
  `needs-human`, the next run picks the issue up. For `no size label, not
  guessing a size` that means adding a size label: without one the gate parks
  the issue again.
- **`error`**: a failed `gh` or `git` call in that package, or an unexpected
  fault. Nothing was parked and the other packages ran. Report it. Once the
  cause is fixed, a new run picks the package up from where it stopped.
- **`wait`, `wave 2` and later, `waiting:`, `deferred:`**: the issue waits for
  its blockers to merge. Run the skill again after they merge.
- **`skip`**: the issue is closed, or labeled `needs-human`. That is the
  user's call.
- **`complete`, `done`, `PR #<p> ready`**: the PR is ready for review. The
  driver never merges, and neither does this skill.
