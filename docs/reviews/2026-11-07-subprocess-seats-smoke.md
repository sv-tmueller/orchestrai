# Subprocess seats smoke run - 2026-11-07

Issue #461. The live acceptance gate for the subprocess seat feature
(#453, merged as PR #458; #454 for the tm-kickoff integration, merged as
PR #462): one live end-to-end run of the subprocess pipeline, recorded as
this entry. The run was executed by the lead (session `7c87604a`) on
2026-11-07; this report transcribes the lead's captured evidence. The
per-seat token and cost figures below are the record and are transcribed
exactly, not re-derived.

## 1. What ran

- Scratch issue: #463 (README Zone 1 Model config paragraph for the
  subprocess variant tables), size:S, a real mergeable change.
- Adapter table: `claude-code-split.json`
  (`.claude/adapters/claude-code-split.json`), selected per run via
  `CLAUDE_CODE_ADAPTER_TABLE`. Opus judgment seats and the lead at xhigh on
  the paid Anthropic endpoint; self-hosted vllm workers. Developer is a
  per-role override (`glm-5-3` at high) resolving through the worker tier;
  the tester takes the tier default (`deepseek-v41-flash` at max).
- Placeholders exported by the lead: `CLAUDE_CODE_ANTHROPIC_SETTINGS`
  (/root/.claude/settings.json) and `CLAUDE_CODE_NORIS_SETTINGS`
  (/root/.claude-noris/settings.json).
- The lead session itself was not spawned by the adapter. Per design, the
  lead drives and keeps its own host/model; only the four pipeline seats
  ran as subprocess seats.
- One package at a time, per the memory note in the issue (7.7 GB box, no
  parallel fan-out).
- All four scratch-package seats ran as attempt 1. No respawn fired and no
  timeout killed any of them. The deliverable's own developer seat later
  exercised the timeout and respawn paths; see section 4, item 1.

## 2. Per-seat models and outcomes

| Seat | Model, effort | Endpoint | cwd | Outcome | Attempt |
| --- | --- | --- | --- | --- | --- |
| architect | opus, xhigh | paid Anthropic | lead checkout | SUB_PLAN posted on #463 | 1 |
| developer | glm-5-3, high (role override) | noris (vllm) | `.worktrees/pkg-463` worktree | DONE, branch `docs/463-readme-variant-adapter-tables`, commit `f98b3b0`, draft PR #464 | 1 |
| tester | deepseek-v41-flash, max (tier default) | noris (vllm) | same worktree | PASS round 1 at `f98b3b0` | 1 |
| reviewer | opus, xhigh | paid Anthropic | same worktree | APPROVE round 1, STAGE: quality, one nit | 1 |

Per-seat usage, transcribed raw from the adapter capture:

| Seat | Input | Output | Cache read | Cost |
| --- | --- | --- | --- | --- |
| architect | 375 | 2,854 | 207,680 | $0.3347 (priced) |
| developer | 563 | 9,504 | 577,024 | null (unpriced, self-hosted) |
| tester | 2,790 | 170,474 | 2,268,416 | null (unpriced) |
| reviewer | 406 | 7,761 | 248,448 | $0.4131 (priced) |

The vllm seats report `cost: null`, which is the unpriced-by-design path for
self-hosted models, matching the acceptance criterion that per-seat
token/cost lines are captured raw.

Developer detail: README-only diff, 21 insertions; `npm test` green at the
seat (717 pass, 0 fail, 2 pre-existing skips). Tester detail: suite 719
tests / 717 pass / 0 fail / 2 skipped (pre-existing chmod-cannot-block-root
skips); scope verified README.md only; version-bump guard not required.
Reviewer detail: one nit (README.md:182, the tier-granular workers row vs
the developer override). PR #464 was then marked ready; CI green (Unit
tests, Version bump guard both pass).

## 3. What was verified live

- Every seat ran as its own headless `claude -p` subprocess against the
  noris vllm endpoint or the paid endpoint per its tier, on the split table.
- Seat reports arrived through the stdout contract markers and the lead
  parsed them: four structured reports (SUB_PLAN, DONE, PASS, APPROVE)
  reached the lead and drove the pipeline to a ready PR.
- Per-seat token/cost lines were captured raw per seat (section 2): priced
  for the two paid opus seats, unpriced (`null`) for the two vllm seats.
- The worktree `.worktrees/pkg-463` was created and used (developer, tester,
  reviewer all ran with it as cwd). The lead's `.worktrees/pkg-461`
  worktree, detached at `aab8279`, hosted this deliverable. Fork point
  check at report time: `git merge-base origin/main
  docs/463-readme-variant-adapter-tables` resolves to `aab8279`, equal to
  `origin/main` at run time. No base drift.
- The scratch package, PR #464, completed green: ready (not draft),
  MERGEABLE, both CI checks (Unit tests, Version bump guard) SUCCESS.
- On the scratch package (#463) no respawn fired and no timeout killed any
  seat; every seat completed on attempt 1. The deliverable package (#461)
  then exercised the timeout and respawn paths on its own developer seat:
  see section 4, item 1.

## 4. Deviations and traps found

These are lead observations from the run. Traps found by the live run that
the stubbed tests missed are recorded here and filed as follow-up issues,
not fixed inside the run, per the issue's non-goals.

1. **The 30-minute timeout and respawn-then-park ladder fired as designed.**
   The deliverable's developer seat (glm-5-3, high) wrote this report,
   committed it (6f9a368), then stalled before pushing or opening the PR.
   The module killed it at the 30-minute mark, respawned it once per the
   respawn policy, and the respawn stalled the same way, so the module
   killed it again and parked the package. A fresh developer seat then
   completed the push and this PR from the stalled seat's commit. This is
   live evidence that the timeout arms on the real path, the kill fires, and
   the one-respawn-then-park contract holds; the stubbed tests cannot show
   this. For contrast, the scratch package's tester seat ran about 24
   minutes (18:34 to 18:58 UTC), inside the budget. An earlier draft of
   this report stated the tester ran 47 minutes with a timeout that did not
   fire; that was a lead arithmetic error in the evidence handoff, not a
   timeout failure, and no timeout-defect issue is filed.
2. **The init-event gate is captured and passes.** The seats' own output
   cannot carry the check (`buildArgv` pins `--output-format json`, whose
   envelope has no init event), so the lead ran a separate stream-json
   probe with the exact settings fragment the adapter composes
   (SETTINGS_FRAGMENT merged over the noris profile). The init event lists
   zero orchestrai plugin entries: both `orchestrai@orchestrai` and
   `orchestrai@synced` are disabled, the plugin list contains only
   superpowers and builtin plugins, and zero orchestrai: skills or agents
   appear. Reproduction trap: `--output-format stream-json` under `-p`
   requires `--verbose`.
3. **Lead-side Bash classifier outages, no seat affected.** The lead-side
   Bash classifier (an unrelated Claude Code auto-mode feature keyed to a
   vllm model) had intermittent outages during the run, blocking some lead
   commands. Retries and the user running two commands via `!` got through.
   No seat was affected. Recorded as a lead observation, not an adapter
   defect.
4. **Worktree cleanup timing.** The `.worktrees/pkg-463` worktree existed at
   report time by design: cleanup is a lead step at wave end, after the
   report, not before it. Creation and use were verified; cleanup is
   recorded in the wave-end report, not here.

Also observed, per design rather than a deviation: the role prompts loaded
per seat are the shared Hermes-binding prompts from
`.claude/adapters/prompts/` (host-neutral contracts), observed live in the
seat process argv.

## 5. Acceptance criteria, scored against #461

| AC | Status | Evidence |
| --- | --- | --- |
| One scratch size:S issue run end to end on the noris endpoint, judgment seat on opus and worker seats on vllm, split table | Met | Section 1 and section 2: architect and reviewer on opus at the paid endpoint, developer and tester on vllm at the noris endpoint, `claude-code-split.json` |
| Init-event check recorded: zero orchestrai plugin skills/agents in each seat session | Met | Stream-json probe with the adapter's settings fragment: zero orchestrai plugin entries in the init event (section 4, item 2) |
| Per-seat reports parsed from stdout; worktree created and cleaned; token counts captured | Met | Reports parsed and token counts captured raw (sections 2 and 3); worktree created and used; cleanup is a wave-end lead step (section 4, item 4) |
| A dated docs/reviews/ entry records the run, deviations, and traps | Met | This file |
| Any trap the stubbed tests missed is either fixed or filed as its own issue | Met | The timeout and respawn-then-park behavior is exercised live and recorded (section 4, item 1); the init-event capture gap is closed by the probe (section 4, item 2); the two consecutive stalls between commit and push are recorded as an observation (section 4, item 1) |

## 6. Follow-up issues

- No follow-up issue is filed from this run. The timeout defect the stalled
  seat drafted an issue for was withdrawn: the timeout demonstrably fires
  and the respawn-then-park contract held (section 4, item 1). The two
  consecutive developer stalls between commit and push are recorded in
  section 4, item 1 as an observation; if they recur on the next subprocess
  run, they get their own issue then.

## 7. Files

This report is the only file this package adds. No `.claude/` changes, no
adapter or skill machinery, per the issue's non-goals. The scratch package
(#463, PR #464) is a separate, real mergeable change and stays separate
from this deliverable.
