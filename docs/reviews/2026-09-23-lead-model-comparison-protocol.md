# Lead model comparison: protocol - 2026-09-23

Pre-registered for issue #358 (batch #356). This file is frozen once committed
and pushed; any later change is a deviation, logged in the report. It is not a
`/tm-ab-test` run: that skill files scratch issues, and this package forbids
GitHub writes during the trial.

## Task

The lead does advisor sections 1 (Refine) and 2 (Propose) of
`.claude/skills/tm-advisor/SKILL.md` on issue #355 ("Make SKILL.hermes.md a
thin wrapper over the pipeline driver"), a headless, read-only, single-turn
run. Refinement is the one place where nothing backs up the lead's own
judgment (architect and reviewer both run Opus regardless of the lead's
model), so it is the sharpest test of the lead-model choice. #355 is a good
probe: it is built on unmerged #351 (PR #354 is still open at BASE, so main
still spawns Hermes seats via `delegate_task`, not the subprocess model #355's
own body describes as already shipped), its `size:M` label is debatable once
that dependency is accounted for, and its body carries a "Related, still
open" scope item the lead has to decide in or out.

## Frozen inputs

- **BASE**: `1730257e1d979bda7cd60967012165d8a4b236d1` (origin/main HEAD,
  pinned via `git ls-remote`, 2026-09-23). A fresh clone of
  `sv-tmueller/orchestrai` is reset to this commit and its `origin` remote is
  removed before every run; each run gets its own disposable copy.
- **GitHub snapshot**: `_snapshot/issues-open.json` and
  `_snapshot/prs-open.json`, captured 2026-09-23T08:16:47Z via
  `gh issue list --state open --limit 100 --json number,title,labels,body,comments,createdAt`
  and `gh pr list --state open --limit 100 --json number,title,headRefName,isDraft,body,createdAt`,
  with issues #356, #357, #358 and PR #359 (`Closes #357`) removed. sha256:
  - `issues-open.json`: `d75cb1973f9ca8e2218f91841b2ee17a3c4102b1bd9b2167fc6df97ec54d618b`
  - `prs-open.json`: `3676d9f89775e3acedf921c9c5c269dd146c13d7745a5f89fecdf96c98ff5c9e`
- **No GitHub credentials**: `GH_CONFIG_DIR` points at an empty directory for
  every run; `gh auth status` against that directory reports "You are not
  logged into any GitHub hosts."
- **No writes**: the trial runs make no GitHub writes and no writes to the
  developer's own checkout. `--disallowedTools` blocks `Edit`, `Write`,
  `NotebookEdit`, `Skill`, `AskUserQuestion`, `WebFetch`, `WebSearch`,
  `Bash(gh *)`, `Bash(git commit *)`, `Bash(git push *)`, `Bash(git remote *)`,
  `Bash(curl *)`; `--allowedTools` is a short read-only list (`Read`, `Grep`,
  `Glob`, `Agent`, `Task`, and a handful of read-only `Bash(git ...)` /
  `Bash(ls|cat|head|tail|wc|grep|rg|find|jq ...)` patterns).
- **Real host redaction**: the repo is public. BASE still carries a real
  Hermes provider host at `docs/architecture/hermes-adapter.md:68` (replaced
  with a placeholder in commit `ef9f83d`, after BASE; issue #352 and its
  decision comment cover the history). That host, listed in the developer's
  local `redact.txt` (never committed), is redacted from every blinded
  transcript before judging and never appears in any committed file,
  including this one.

## CLI

`/opt/homebrew/bin/claude` v2.1.280, not the `claude` shell alias (which only
prints a hint in this environment). `CLAUDE_CONFIG_DIR=$HOME/.claude-work`.
`env -i` drops the parent session's own environment (`CLAUDECODE`,
`CLAUDE_EFFORT`, ...) so it cannot leak into the trial.

```sh
rm -rf "$TRIAL/repo" && cp -R "$TRIAL/pristine" "$TRIAL/repo"; mkdir -p "$TRIAL/runs"
SID=$(uuidgen | tr 'A-Z' 'a-z'); START=$(date -u +%Y-%m-%dT%H:%M:%SZ); T0=$(date +%s)
cd "$TRIAL/repo" && env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  CLAUDE_CONFIG_DIR="$HOME/.claude-work" GH_CONFIG_DIR="$TRIAL/gh-empty" \
  /opt/homebrew/bin/claude -p --model "$MODEL" --effort xhigh \
    --output-format stream-json --verbose --session-id "$SID" \
    --permission-mode dontAsk --strict-mcp-config --max-budget-usd 50 \
    --allowedTools "Read,Grep,Glob,Agent,Task,Bash(git log *),Bash(git show *),Bash(git diff *),Bash(git grep *),Bash(git ls-files *),Bash(ls *),Bash(cat *),Bash(head *),Bash(tail *),Bash(wc *),Bash(grep *),Bash(rg *),Bash(find *),Bash(jq *)" \
    --disallowedTools "Edit,Write,NotebookEdit,Skill,AskUserQuestion,WebFetch,WebSearch,Bash(gh *),Bash(git commit *),Bash(git push *),Bash(git remote *),Bash(curl *)" \
    < "$TRIAL/task-prompt.md" > "$TRIAL/runs/$ID.jsonl" 2> "$TRIAL/runs/$ID.stderr"; RC=$?
WALL=$(( $(date +%s) - T0 ))
```

`$MODEL` is `claude-fable-5-1` for F runs, `claude-opus-5-5` for O runs (the
current Claude API IDs for Fable 5.1 and Opus 5.5; confirmed against the
models-overview page below). If `--permission-mode dontAsk` is rejected by
this CLI build, the fallback is `--permission-mode manual --permission-prompts none`,
logged as a deviation. Never `--dangerously-skip-permissions`, never
`--fallback-model`, never `CLAUDE_CODE_SUBAGENT_MODEL`.

Six lead runs total: F1, O1, F2, O2, F3, O3, strictly sequential (never two
runs overlapping), each in its own disposable `$TRIAL/repo` copy. A launched
run counts against the budget even if it fails or is budget-capped. One judge
run, one judge retry only if its output does not parse as JSON. Any other
model call stops the package with `NEEDS_CONTEXT`.

**Gates after each run** (a run that fails any of these is recorded as
invalid, never replaced): the init event's `model` field equals the requested
ID; `mcp_servers` is empty; `permissionMode` is `dontAsk` (or the logged
fallback); a `result` event exists; `apiKeySource` shows subscription billing,
not API-key billing (if API-key billing is shown, the whole package stops
with `NEEDS_CONTEXT` after that run).

Commit after every run (`docs: record lead trial run <ID> (#358)`) so a
resumed session can see from `data.json` and the commit log which runs
already happened before launching anything else.

## Fixed task prompt

Piped to stdin, byte-identical across all six runs. sha256:
`429284cf98429a3a7deb9677b554bb40a2fdb177a883f0a9d41d5aa35605a4ac`.

```
You are the lead session for this repository, acting as the /tm-advisor advisor.
This is a headless, read-only run. No user is present.

The user's need: "Refine issue #355 into a batch I can sign off on."

Do sections 1 (Refine) and 2 (Propose) of .claude/skills/tm-advisor/SKILL.md for
that need, then stop at the sign-off block. Do not do sections 3 to 6.

Rules for this run:
1. GitHub is offline. _snapshot/ holds the GitHub state as of 2026-09-23T08:16:47Z:
   open issues with bodies and comments (issues-open.json) and open pull requests
   (prs-open.json). Treat it as current. Do not run gh.
2. Change nothing. Do not create, edit, or delete files, and do not commit, push,
   file, label, or comment. Use read-only commands only.
3. Where section 1 says to ask the user, run /tm-grill-me, or brainstorm, do not.
   List each question you would ask with your recommended answer, assume that
   answer, and continue. Do not write a spec file; state design decisions inline.
4. You may dispatch subagents under the same rules. Pass rules 1 and 2 to them.
5. Your final message is the deliverable: first the questions with their assumed
   answers, then the batch proposal in the section 2 format, ending with the
   section 2 sign-off block. Do not name the model you are running on.
```

## Rubric

Each criterion scores 0/1/2, ten criteria, max 20 per run.

- **C1, dependency/state.** 2: states #351 / PR #354's snapshot state (open,
  unmerged; main still spawns via `delegate_task`) and draws the consequence
  for #355's scope or sizing. 1: mentions it without checking the snapshot or
  without drawing the consequence. 0: takes #355's premise (subprocess spawn
  already shipped) at face value.
  Ground truth (developer-checked against the snapshot and BASE before
  committing this file): at BASE, PR #354 (`feat/351-hermes-subprocess-spawn`)
  is open and unmerged (`state: OPEN`, `mergedAt: null`); `git merge-base
  --is-ancestor 8aae560 origin/main` fails. Main spawns Hermes seats via
  `delegate_task`, not the subprocess model.
- **C2, grounding.** The judge checks the first 5 concrete, checkable claims
  in the output against the repo and the snapshot. 2: none contradicted. 1:
  one contradicted. 0: two or more contradicted, or no concrete claims to
  check. Unverifiable claims (opinions, predictions) count as neither.
- **C3, slicing/sizing.** 2: every proposed package is `size:S` or `size:M`
  with a stated reason, no in-batch `Blocked by:` line, at most 6 packages,
  and any deferred work is named with a reason. 1: exactly one of these is
  broken. 0: an `L`/`XL` package, an in-batch dependency, or no slicing at
  all.
- **C4, the "Related, still open" item.** #355's body carries a scope item
  (generating the installed bundle from repo source with a drift test) it
  explicitly leaves open. 2: the proposal puts it explicitly in or out of
  scope, with a reason. 1: mentioned, no decision either way. 0: ignored.
- **C5, acceptance criteria.** 2: every package's acceptance criteria are
  observable (checkable from an outside view, not "code is clean"). 1: some
  are vague. 0: missing, or vague throughout.
- **C6, non-goals.** 2: every package has non-goals that actually narrow the
  scope (not restatements of the acceptance criteria). 1: some packages are
  missing them or they are generic. 0: none.
- **C7, challenge.** Section 1 asks the lead to be "a sparring partner, not a
  stenographer." 2: surfaces a real hidden assumption, a cheaper alternative,
  or an architecture tension, backed by something checkable in the repo or
  snapshot. 1: a generic challenge with no specific backing. 0: none.
- **C8, questions.** 2: the listed clarifying questions are real decisions
  (not rhetorical), each carries a recommended answer, and the proposal that
  follows is consistent with those answers. 1: filler questions, or the
  proposal ignores the stated answers. 0: no questions, or the run stops at
  questions without proposing a batch.
- **C9, format/discipline.** 2: every package carries all required fields
  (title, scope, acceptance criteria, size, non-goals), the sign-off block is
  reproduced verbatim, and the output never claims a GitHub action (filing,
  labeling, commenting) that rule 2 forbids. 1: exactly one of these is
  missing. 0: several are missing, or a forbidden action is claimed.
- **C10, writing style.** Per `.claude/process-core.md`: no em dashes, no
  banned phrases. 2: none found. 1: one or two violations. 0: more than two.

Recorded per run, not scored: word count of the final message, count of
`permission_denial` events (the run attempting a disallowed tool), and the
number of subagent (`Agent`/`Task`) dispatches.

## Judge

One headless Sonnet run (`claude-sonnet-5`, xhigh effort), because Opus is a
contestant in this trial and Fable is lead-session-only by policy, so neither
can judge without bias toward itself. One retry only if the first judge
response does not parse as the JSON shape below.

Before judging: the six raw outputs are redacted (model names, model IDs,
`Generated with` / `Co-Authored-By` lines, and every host in `redact.txt`,
replaced with `https://provider.example.com`), then assigned labels R1-R6 by
the sorted sha256 of the six redacted files (so label order carries no
information about run order or model). A manual pass checks for missed
self-identification (a run naming its own capabilities or context window)
that the automated redaction would not catch; anything found is logged.

The judge runs against a fresh pristine copy of the repo at BASE, with a
`_judge/` directory holding `rubric.md` (this section, exported standalone),
`task-prompt.md` (the prompt above), and `R1.md` through `R6.md`. Same
lockdown as the lead runs, plus `--model claude-sonnet-5 --effort xhigh
--max-budget-usd 10 --output-format json` (a single non-streaming call, since
the judge does not need to show its work turn by turn). Unblinding (mapping
R1-R6 back to run IDs and models) happens only after the scores are saved to
`data.json`.

Judge prompt, verbatim:

```
You are scoring six anonymized outputs, _judge/R1.md to _judge/R6.md, all answers
to the task in _judge/task-prompt.md. Score each output against each criterion in
_judge/rubric.md, using only the rubric's anchors. The repository in this directory
is the exact state the outputs were written against; _snapshot/ is the GitHub
state they saw. Use both to check claims as C2 directs. Do not run gh or change
anything. Score each output on its own. Do not reward length. Do not guess which
system wrote an output. Reply with JSON only:
{"R1": {"C1": {"score": 0, "why": "<one line>"}, ..., "C10": {...}}, ..., "R6": {...}}
```

Bias risks this trial cannot remove, listed in the report: a Sonnet judge may
carry a same-lineage preference between Sonnet-adjacent phrasing and either
contestant; length can correlate with perceived thoroughness even when told
not to reward it; hash-based labels remove order effects from presentation
but not from each model's own default verbosity; a single judge model means
no inter-rater agreement can be measured; and writing-style tells (an
em dash, a particular hedge) can leak identity even after redaction.

## Decision rule (pre-registered before run 1)

- A run is valid if it launched, completed (the gates above pass), and was
  not budget-capped. Invalid runs are reported and never replaced; the
  budget in "CLI" above is exhausted either way.
- Either arm with fewer than 2 valid runs: **insufficient evidence**,
  regardless of scores.
- If every valid Fable run's total score beats every valid Opus run's total
  score: **keep Fable**. If the reverse holds: **move the lead to Opus 5.5**.
  Either way, confidence is medium at best: a complete split in a named
  direction happens by chance about 1 time in 20 at 3 valid runs per arm
  (one-sided, n=3 vs n=3).
- Otherwise, if the two arms' mean total scores are within 2 points (out of
  20): **comparable quality**. Recommend the arm with the lower mean total
  cost per run at list prices, at low confidence.
- Otherwise: **insufficient evidence**, with the direction stated (which arm
  scored higher, by how much, without a recommendation to switch on that gap
  alone).
- Availability events (quota errors, forced fallbacks) and quota-vs-dollar
  findings are reported beside this rule, not folded into the score.

## Prices (WebFetch, retrieved 2026-09-23)

- Model pricing table:
  https://platform.claude.com/docs/en/about-claude/pricing (retrieved
  2026-09-23T08:20Z). Base input / 5m cache write / 1h cache write / cache
  hit / output, per MTok:
  - Claude Fable 5.1: $10 / $12.50 / $20 / $0.25 (0.025x base) / $50
  - Claude Opus 5.5: $4 / $5 / $8 / $0.20 (0.05x base) / $20
  - Claude Opus 5: $5 / $6.25 / $10 / $0.50 (0.1x base) / $25
  - Claude Sonnet 5: $2 / $2.50 / $4 / $0.20 (0.1x base) / $10
- Models overview (IDs and aliases):
  https://platform.claude.com/docs/en/about-claude/models/overview (retrieved
  2026-09-23T08:20Z; the fetched path redirects from
  `/docs/en/models/overview`). Claude API ID / alias for Fable 5.1:
  `claude-fable-5-1`; for Opus 5.5: `claude-opus-5-5`; for Sonnet 5:
  `claude-sonnet-5`. "Claude API ID: Every Claude model ID is a pinned
  snapshot, including the dateless IDs used from the 4.6 generation on."
- Ratio check: Fable 5.1 vs Opus 5.5 is $10/$4 = 2.5x input, $50/$20 = 2.5x
  output, not the 2x the team-guide states. Fable 5.1 vs Opus 5 (the model
  team-guide's "2x" line was written against) is $10/$5 = 2x input, $50/$25 =
  2x output: the 2x figure holds against Opus 5, not against the newer Opus
  5.5 this trial actually runs. The report states this explicitly; it is not
  a protocol change, since the prices below are what this trial's own runs
  are costed at.
- Max plan and Fable availability:
  https://claude.com/pricing (retrieved 2026-09-23T08:21Z) states Max
  includes "More Claude models" over Pro but does not itself name Fable.
  https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
  (retrieved 2026-09-23T08:22Z) states "Fable 5 and Fable 5.1 are included as
  a standard part of your plan" for Max (and Team/Enterprise premium seats);
  Pro states "Fable 5 and Fable 5.1 aren't included in your plan's usage
  limits. You can use them with usage credits." The same article states
  Fable models "draw from your plan's regular weekly usage limits and use
  them faster than other Claude models" without publishing a multiplier.
  https://support.claude.com/en/articles/9797557-usage-limit-best-practices
  (retrieved 2026-09-23T08:22Z) confirms per-model usage tracking exists
  ("Weekly limits: Check when your plan's weekly usage limit resets, for all
  models, and for Fable") but publishes no specific weighting ratio.

## Verification

- `npm test` passes.
- The diff that introduces this protocol touches exactly the three
  `docs/reviews/2026-09-23-lead-model-comparison*` files.
- This file's commit-and-push time is earlier than the earliest run start,
  and no later commit edits this file.
- At most 3 runs per model launch, and each run's init `model` field matches
  what was requested.
- One run's cost is recomputed independently from its token buckets and
  matches the reported figure.
- The final report's per-run scores equal what is stored in `data.json`.
- No em dashes or banned phrases in the three committed files.
- None of the `redact.txt` hosts appear in any of the three committed files.

## If blocked

If `claude -p` cannot launch from the developer's own shell (sandbox,
keychain, or the nested-session check), the package reports `BLOCKED` with
the prepared command block above. No bypass flag is used to work around it.
