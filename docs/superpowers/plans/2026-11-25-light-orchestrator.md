# Light Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-stage tm-kickoff pipeline with a light flow (developer, then a reviewer only for bigger or risky work), on Claude as short prose skills and on Hermes as a slimmed driver.

**Architecture:** One flow doc (`docs/architecture/light-flow.md`) is the single source. The Claude skills `tm-kickoff` and `tm-advisor` are rewritten as short prose that follows it. The Hermes driver `hermes-pipeline.mjs` enforces the same flow in code. The tester role and the kickoff helper scripts are deleted. `main` stops requiring `orchestrai/test`.

**Tech Stack:** Node (ESM, zero dependencies), `node --test` via `npm test`, `gh` CLI, Markdown skills.

**Spec:** `docs/superpowers/specs/2026-11-25-light-orchestrator-design.md`

## Global Constraints

- Zero new dependencies.
- Each Claude skill (`tm-kickoff/SKILL.md`, `tm-advisor/SKILL.md`) under 200 lines.
- Hermes driver well under half of 1,132 lines (target: under 560).
- Review gate, identical on both harnesses: reviewer runs when the issue is `size:M` or larger, OR the diff touches `.claude/agents`, `.claude/skills`, `.claude/workflows`, `.github/workflows`, or a dependency manifest or lockfile, OR the developer reported `DONE_WITH_CONCERNS`.
- At most 2 fix rounds, then `needs-human`.
- Labels used by the flow: `size:*`, `in-progress`, `needs-human`. Nothing else.
- Required contexts after rollout: CI checks plus `orchestrai/review`. Never `orchestrai/test`.
- The lead posts `orchestrai/review` = success after APPROVE, or with description `not required (size S)` when the gate skipped the reviewer.
- The reviewer never files follow-up issues.
- Writing style per `.claude/process-core.md`: no em dashes, no AI-cliche words.
- One issue and one branch per task (`feat/<n>-<slug>`), PR with `Closes #N`.
- Every task is done when `npm test` passes.

## Review Focus

1. A repo still requiring `orchestrai/test` when the new kickoff ships: every PR blocks. Task 2 must land and the owner must apply it (Task 7, step 1) before Task 4 merges.
2. A hand-filed issue with no `## Approach` section: the lead adds one as a comment before dispatch, never dispatches with no plan. Task 4's text test pins this sentence.
3. Resume after a dropped session, with a PR but no review comment, on an S issue: the gate must still run (lead check plus status), not re-dispatch the developer. Task 4 text test and Task 6 `resumeStage` test pin it.
4. A diff on an S issue that touches a risky path: reviewer required even though size is S. Task 6 `needsReview` test pins it; Task 4 text test pins the risky path list.
5. Leftover references to `tester` or the deleted scripts in files that stay (adapter tables, renderers, docs): Task 3 and Task 5 each end with a grep that must come back empty.

---

### Task 1: Flow doc and issue template

**Files:**
- Create: `docs/architecture/light-flow.md`
- Test: `.claude/workflows/__tests__/light-flow-text.test.mjs`

**Interfaces:**
- Produces: the doc's headings, which Tasks 4 and 6 link to: `## Advisor`, `## Issue body`, `## Kickoff`, `## Review gate`, `## Merge gate`, `## Resume`.

- [ ] **Step 1: Write the failing test** `light-flow-text.test.mjs`, describe `light flow doc`:
  - `has the six sections`: each heading above is present.
  - `states the review gate`: the text contains `size:M`, each of the five risky path prefixes, and `DONE_WITH_CONCERNS`.
  - `caps fix rounds at 2`: contains `2 fix rounds`.
  - `issue body template`: contains `## What to build`, `## Approach`, `## Acceptance criteria`, `## Non-goals`.
- [ ] **Step 2:** `npm test` fails on the missing file.
- [ ] **Step 3:** Write the doc from the spec sections "The flow", "Merge gate" and "Resume". Under 120 lines.
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit `docs: light flow doc and issue body template`.

### Task 2: Repo guard requires only orchestrai/review

**Files:**
- Modify: `.claude/skills/tm-repo-guard/repo-guard.mjs:815` (`VERDICT_CHECKS`), `:1794` (the `statuses` output)
- Modify: `.claude/skills/tm-repo-guard/SKILL.md:100-120`
- Test: `.claude/workflows/__tests__/repo-guard.test.mjs`, `repo-guard-skill-text.test.mjs`

**Interfaces:**
- Produces: `VERDICT_CHECKS = ['orchestrai/review']`. Applying the guard to a repo whose protection lists `orchestrai/test` removes it, because `planChanges` sets the required list to exactly CI checks plus `VERDICT_CHECKS`.

- [ ] **Step 1: Update tests first:** expected required checks lose `orchestrai/test`; a `planChanges` case with current protection `[tests, orchestrai/review, orchestrai/test]` plans a change to `[orchestrai/review, tests]`; `statuses` output has one status line (`orchestrai/review`) and no `orchestrai/test`; the refusal message names only `orchestrai/review`.
- [ ] **Step 2:** `npm test` fails on those cases.
- [ ] **Step 3:** Change the constant and the `statuses` output; update SKILL.md to "posts `orchestrai/review`".
- [ ] **Step 4:** `npm test` passes.
- [ ] **Step 5:** Commit `feat: repo guard requires orchestrai/review only`.

### Task 3: Remove the tester role, update developer and reviewer

**Files:**
- Delete: `.claude/agents/tester.md`, `.claude/adapters/prompts/tester.md`, `.claude/adapters/personas/tester.toml`
- Modify: `tester` rows in `.claude/adapters/{claude-code,claude-code-split,claude-code-vllm,codex,hermes,hermes-openrouter}.json`; `role-contract-parser.mjs:16`; `hermes-renderer.mjs`, `hermes-adapter.mjs`, `claude-code-subprocess.mjs` where they name tester
- Modify: `.claude/agents/developer.md` (the issue's `## Approach` section is the spec; drop sub-plan posting), `.claude/agents/reviewer.md` (always runs the check suite itself, no lean-track section, no tester claims input, no follow-up issues), `.claude/agents/architect.md` (on demand only: split proposals and disputes; drop the per-issue `SUB_PLAN` job), and their copies in `.claude/adapters/prompts/`
- Test: `role-contract-sync.test.mjs`, `prompts-sync.test.mjs`, `effort-policy.test.mjs`, `hermes-prompts.test.mjs`, `adapter-table.test.mjs`, and any other test the final grep turns up

**Interfaces:**
- Produces: roles `architect, developer, reviewer, fact-checker, docs-writer, perf-investigator`. Developer report contract unchanged except `DEVIATIONS` reads "from the issue's Approach". Reviewer input: PR, issue number. Reviewer output adds a `CHECKS` line (same shape as the developer's).

- [ ] **Step 1:** Update the sync tests to the new role list and the new reviewer contract (the `CHECKS` line is required on every verdict). Add to `adapter-table.test.mjs`: no adapter table names `tester`.
- [ ] **Step 2:** `npm test` fails.
- [ ] **Step 3:** Delete and edit the files above.
- [ ] **Step 4:** `npm test` passes. Then `grep -rnw tester .claude --exclude-dir=worktrees` lists only Task 4 and Task 6 files (kickoff SKILL.md, hermes-pipeline.mjs and its tests and fixtures, SKILL.hermes.md files). Note them in the PR body.
- [ ] **Step 5:** Commit `refactor: remove the tester role`.

### Task 4: Rewrite the Claude kickoff and advisor skills

Blocked by Tasks 1, 2, 3, and by Task 7 step 1 (protection applied) before merge.

**Files:**
- Rewrite: `.claude/skills/tm-kickoff/SKILL.md`, `.claude/skills/tm-advisor/SKILL.md`
- Delete: `.claude/skills/tm-kickoff/{lean-allowed,ship-decision,columns,same-changes,token-report}.mjs`, `token-prices.json`
- Delete tests: `lean-allowed`, `ship-decision`, `columns-config`, `same-changes`, `token-report` (plus `fixtures/token-report/`), `kickoff-closed-claims`, `kickoff-lean-check-text`, `kickoff-parking-text`, `kickoff-track-lean-clears`
- Modify: `repo-guard.test.mjs:54` (drop the `ship-decision` import and the cases that use it), `guard-decide-merge-rule.test.mjs:1719` (the row is a guard input string; keep it if `decide()` does not read the file, else replace the path with another plugin script)
- Test: `.claude/workflows/__tests__/light-flow-text.test.mjs` (extend)

**Interfaces:**
- Consumes: Task 1 doc headings; Task 3 reviewer contract (`CHECKS` line); Task 2 single status.

- [ ] **Step 1: Extend the text test** with describe `claude skills`:
  - each SKILL.md is under 200 lines;
  - kickoff contains the five risky path prefixes, `DONE_WITH_CONCERNS`, `orchestrai/review`, `not required (size S)`, `needs-human`, and a link to `docs/architecture/light-flow.md`;
  - kickoff says the lead adds an `## Approach` comment to an issue that has none (match `## Approach`);
  - kickoff's resume part covers "PR and no review comment" (match `no review comment`);
  - neither skill contains `tester`, `architect` as a stage, `phase:`, `track:`, `runner`, `claimed:`, `ship-decision`, `lean-allowed`, `Plan status`, `orchestrai/test`.
- [ ] **Step 2:** `npm test` fails.
- [ ] **Step 3:** Rewrite both skills from the flow doc. Advisor keeps: refine, propose (up to 6 S/M issues, body per template), one sign-off (dispatch or file only), file, batch issue with decision log, run the kickoff flow, report, resume. Delete the scripts and tests listed.
- [ ] **Step 4:** `npm test` passes. `grep -rn "ship-decision\|lean-allowed\|columns.mjs\|same-changes\|token-report" .claude --exclude-dir=worktrees` returns only the Hermes files Task 6 owns.
- [ ] **Step 5:** Commit `feat: light kickoff and advisor skills`.

### Task 5: Docs follow the light flow

Blocked by Task 4.

**Files:**
- Modify: `.claude/team-guide.md` (Agent team, plan-status block section removed, labels, Model policy rows for tester), `docs/team-architecture.md`, `docs/team-guide-rationale.md`, `README.md`, `NEW-PROJECT-SETUP.md`, `docs/why-the-team.md`, `docs/architecture/operating-model.md`, `docs/architecture/role-contracts.md`, `docs/operations/plan-downgrade-runbook.md`
- Test: `orientation-files-text.test.mjs` (only if headings it checks change)

- [ ] **Step 1:** Edit each file to describe the light flow, linking `docs/architecture/light-flow.md` instead of restating it. `team-guide.md` must shrink (today 284 lines).
- [ ] **Step 2:** `npm test` passes.
- [ ] **Step 3:** `grep -rnw "tester\|orchestrai/test\|plan-status\|phase:" README.md NEW-PROJECT-SETUP.md .claude/team-guide.md docs/team-architecture.md docs/architecture docs/operations docs/why-the-team.md docs/team-guide-rationale.md` returns only `docs/architecture/hermes-adapter.md` (Task 6) and dated codebase maps (left as history).
- [ ] **Step 4:** Commit `docs: describe the light flow`.

### Task 6: Hermes driver on the light flow

Blocked by Tasks 1 and 3. Re-check size at planning; split driver and skills into two issues if the driver alone is M.

**Files:**
- Rewrite: `.claude/adapters/hermes-pipeline.mjs`
- Rewrite: `.claude/skills/tm-kickoff/SKILL.hermes.md`, `.claude/skills/tm-advisor/SKILL.hermes.md`
- Modify: `docs/architecture/hermes-adapter.md`
- Test: `hermes-pipeline.test.mjs`, `hermes-kickoff-skill-text.test.mjs`, fixtures under `fixtures/hermes-pipeline/` (delete `main-resume-arbitration.json`)

**Interfaces:**
- Keeps: `runPipeline(issueNumber, opts)`, `runWave(packages, opts)`, `main(argv, deps)`, `parseArgs(argv)`, `planWaves(entries)`, `parseBlockers(body)`, `LABELS` (unchanged list), `createGitHub(opts)`, `DRY_RUN=true` behavior.
- Adds: `export const RISKY_PATHS` (the five prefixes plus manifest/lockfile names) and `export function needsReview({ size, paths, status }) -> boolean`.
- Changes: `resumeStage(comments, { hasPr }) -> 'develop' | 'gate' | 'fix' | 'done'`; `countFixRounds(comments) -> number` counts reviewer `CHANGES_REQUESTED` comments only.
- Removes: architect and tester stages, arbitration (`pushedBack`, `outcomeHeader`, `hasBody`, `decisionQuestion`), the size-check stop.
- Root variable: `ORCHESTRAI_ROOT`, default `.claude`; both skills run `node "${ORCHESTRAI_ROOT:-.claude}/adapters/hermes-pipeline.mjs"`.

- [ ] **Step 1: Write the failing tests:**
  - `needsReview`: `{size:'S', paths:['src/a.js'], status:'DONE'}` -> false; `size:'M'` -> true; S with `.github/workflows/ci.yml` -> true; S with `package-lock.json` -> true; S with `DONE_WITH_CONCERNS` -> true.
  - `runPipeline` dry run, S issue, safe paths: seats spawned are `['developer']`, `orchestrai/review` posted with `not required (size S)`, PR marked ready.
  - M issue, reviewer CHANGES_REQUESTED twice then APPROVE: seats `developer, reviewer, developer, reviewer, developer, reviewer`, shipped.
  - M issue, CHANGES_REQUESTED three times: parked `needs-human` after the second fix round's re-review.
  - Developer report that disputes a finding: parked `needs-human`.
  - `resumeStage`: no PR -> `develop`; PR, no review comment -> `gate`; last review CHANGES_REQUESTED -> `fix`; last review APPROVE -> `done`.
  - Driver run from a temp folder with no `.claude/adapters`, `ORCHESTRAI_ROOT` set to the real one: dry run prints the wave plan (absorbs #627).
- [ ] **Step 2:** `npm test` fails.
- [ ] **Step 3:** Rewrite the driver to the interfaces above; rewrite both `SKILL.hermes.md` to run it (advisor: sign-off stands in for the dry-run confirm; it decides parked questions between driver runs and clears `needs-human`); update `hermes-adapter.md`.
- [ ] **Step 4:** `npm test` passes; `wc -l .claude/adapters/hermes-pipeline.mjs` under 560; `grep -rnw "tester\|arbitration" .claude/adapters .claude/skills` empty.
- [ ] **Step 5:** Commit `feat: hermes driver on the light flow`.

### Task 7: Rollout (owner-approved, outward-facing)

Not a code change. Each step needs the owner's go before it runs.

- [ ] **Step 1 (after Task 2 merges, before Task 4 merges):** For each repo whose `main` requires `orchestrai/test` (`gh api repos/<r>/branches/main/protection --jq '.required_status_checks.contexts'`), run `/tm-repo-guard` apply. Verify: the contexts list no longer holds `orchestrai/test`.
- [ ] **Step 2 (after Task 4 merges):** On each affected repo, delete the labels `phase:*`, `track:lean`, `runner`, `runner:on`, `runner:off`, `run:*`, `claimed:*` (`gh label delete <name> --repo <r> --yes`). Verify: `gh label list` shows none of them.
- [ ] **Step 3 (after Tasks 4 and 6 merge):** Close #452, #614, #616, #617, #621, #623, #624, #626, #627 with a comment pointing to the merged PRs; close #618 as won't-fix. Keep #549.
- [ ] **Step 4:** `/plugin update` in each config dir.
