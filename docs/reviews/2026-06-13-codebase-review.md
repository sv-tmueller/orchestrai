# Codebase review - 2026-06-13

> **Historical record.** All skill and workflow paths in this report (e.g.
> `/advisor`, `/kickoff`, `/grill-me`, `/review-changes`, `/review-codebase`,
> `/sync-template`, `review-codebase.js`) predate the tm- rename (commit
> 6940104). Their current equivalents carry the `tm-` prefix:
> `/tm-advisor`, `/tm-kickoff`, `/tm-grill-me`, `/tm-review-changes`,
> `/tm-review-codebase`, `/tm-sync-template`, `tm-review-codebase.js`.
> The finding headers and text are preserved verbatim.

**Verdict: changes-requested**

Full-repo review of the claude-template: the `.claude/` agent team and skills,
the two bounded review workflows, the project configuration, and the
documentation, design spec, and plan. The machinery is well-built and the
model-pinning discipline holds throughout. One must-fix blocks: the
`review-codebase` workflow silently passes a run when the scout fails, reviewing
nothing while still able to return `approve`. The rest are robustness gaps in
agent and skill prose, two shell-injection hardening items in the workflow
scripts, stale plan code blocks, and documentation polish.

The earlier diff-scoped review on this branch flagged a forbidden em dash in the
README and an untracked `review-codebase.js`; the workflow is now committed and
tracked, but the README em dash and the stale skill list in CLAUDE.md remain
open and are carried below.

## Must-fix

### Bounded orchestration workflows

- **.claude/workflows/review-codebase.js:144-211 (bugs)** - When the scout agent
  fails and returns null (or a non-array `areas`), `allAreas` and `areas` are
  both empty, no area workers are dispatched, `scoutDropped` is empty so
  `ceilingReached` is false, and `workersFailed` is empty (the architecture
  worker still ran). The `coverageNote` to the critic is therefore empty, the
  raw findings array is empty, and the critic can return `verdict: 'approve'` on
  a review where not a single area was read. The entire area-review phase
  vanishes with no signal. Fix: detect the scout failure
  (`const scoutFailed = !map || !Array.isArray(map.areas)`) and, when true,
  prepend a prominent warning to `coverageNote` (the scout did not return; all
  area workers were skipped, only the architecture worker ran; treat this review
  as partial) so the critic is explicitly told area coverage is missing and
  cannot silently approve.

## Should-fix

### Role agents

- **.claude/agents/developer.md:23 (bugs)** - The fix-round / resume flow pushes
  with `git push origin HEAD:refs/heads/<branch>` with no `--force-with-lease`
  and no rejection path. If the branch advanced between the fetch and the push
  (a concurrent fix round), this fast-forwards over that work or fails with no
  guidance. Add `--force-with-lease`, or note that a rejected push means
  re-fetch and rebase before retrying.
- **.claude/agents/developer.md:27-28 (bugs)** - The fresh-package collision
  fallback says: if branch creation collides with a crashed-run leftover, "work
  detached from `origin/main`". That discards whatever partial work the crashed
  run left on `origin/<branch>` and starts fresh, silently losing it, which
  contradicts the kickoff resume-detection that is meant to preserve it. Fix:
  fetch `origin/<branch>`, inspect the leftover, and surface it as NEEDS_CONTEXT
  rather than starting fresh from `origin/main`.
- **.claude/agents/tester.md:27 (bugs)** - The tester runs "the full check suite
  from CLAUDE.md Useful commands", but in an unscaffolded repo that section
  holds only placeholder comments (`# install`, `# test`). With nothing to run,
  the tester has no stop signal and can report PASS on an empty run. Add an
  explicit check: if Useful commands contains only placeholders, emit FAIL with
  a finding that the check suite is not configured.
- **.claude/agents/architect.md:15-43 (scope)** - The three job types (SUB_PLAN,
  SPLIT_PROPOSAL, ARBITRATION) live in one file and the agent must "identify
  which" from context, even though the kickoff caller already knows the job. A
  wrong guess sends all downstream work down the wrong path with no signal.
  Require the caller to pass the job type explicitly (for example a first line
  `JOB: SUB_PLAN`), removing the inference, or split into three single-purpose
  agents.

### Project skills

- **.claude/skills/kickoff/SKILL.md:68 (bugs)** - Step 7 acts "On APPROVE with
  the full suite green", but nothing re-runs the suite at approve time: the
  reviewer does not test, and after a CHANGES_REQUESTED fix round the developer
  pushes commits that the pipeline may not re-test before re-review. "Full suite
  green" is then an unverified precondition. Clarify that it refers to the most
  recent tester PASS and that a re-test is required after every fix round before
  marking the PR ready, or add an explicit "only proceed if the last tester
  verdict is PASS" check.
- **.claude/skills/kickoff/SKILL.md:83 (bugs)** - The "3 fix rounds per stage"
  cap never defines "stage". The pipeline has two fix loops (tester FAIL, step
  4; reviewer CHANGES_REQUESTED, step 6) and it is ambiguous whether each gets
  its own count or they share one. A long reviewer fix loop followed by a tester
  regression could exhaust the count before either stage is fairly tried.
  Clarify: "3 fix rounds per loop, tester and reviewer counted independently"
  (or state the combined cap if that is the intent). This also covers the
  unhandled case where the re-test in step 6 itself returns FAIL: define that it
  re-enters the step-4 loop under that stage's counter.
- **.claude/skills/kickoff/SKILL.md:76-78 (bugs)** - The routing rule "BLOCKED,
  or the developer pushes back on a finding: dispatch the architect for
  ARBITRATION" conflates two different triggers. A BLOCKED status (external
  dependency, missing context) is not a reviewer dispute, and the architect's
  ARBITRATION contract only covers a reviewer finding vs developer pushback; a
  genuine blocker has no defined path after ARBITRATION. Split the rule:
  "BLOCKED: park the package. Developer pushes back on a reviewer finding:
  dispatch the architect for ARBITRATION."
- **.claude/skills/kickoff/SKILL.md:51-54 (bugs)** - The standalone fallback for
  a NEEDS_DECISION from the architect's SUB_PLAN rests entirely on the
  "otherwise park the package" clause, which is correct but easy to misread as
  applying only inside an /advisor batch. State the standalone case explicitly:
  outside an /advisor batch a NEEDS_DECISION always parks the package and
  surfaces the question to the user in the wave-end report.
- **.claude/skills/kickoff/SKILL.md:27-32 (bugs)** - Resume detection re-enters
  "at the tester" when in doubt. If the session dropped at the reviewer
  CHANGES_REQUESTED stage, this fires a fresh tester dispatch that wastes a run
  and can return a PASS that advances state before the unresolved reviewer
  findings are addressed. Prefer re-entering at the last incomplete stage
  inferred from the PR comment history; fall back to the tester only when the
  stage genuinely cannot be determined (no comments after the sub-plan). Cover
  the related state where `in-progress` is set but no open PR and no branch on
  origin exist (a developer crashed before pushing): clear the label and restart
  from the developer stage rather than dispatching a tester with no branch.
- **.claude/skills/advisor/SKILL.md:13-14, 96 (bugs)** - Resume looks for "an
  open batch issue (title starting `Batch:`)" with no tiebreaker. If two open
  `Batch:` issues exist (an earlier run not cleaned up, or `/advisor` run
  twice), the choice is non-deterministic. Add a tiebreaker: pick the most
  recently created, and if still ambiguous list them and ask the user.
- **.claude/skills/advisor/SKILL.md:92-94 (bugs)** - Section 6 says to "watch the
  batch PRs (subscribe to PR activity where the environment supports it)" and
  close the batch issue when merged. A Claude Code session is stateless across
  turns and cannot subscribe to asynchronous external events, so this watch
  mechanism does not exist in practice. Replace it with an explicit resume
  pattern: after the report the advisor is done for the session; when the user
  merges and re-invokes `/advisor` with no arguments, it reads the batch issue,
  confirms the PRs are merged (`gh pr list`), closes the batch issue, and
  proposes the next batch.
- **.claude/skills/advisor/SKILL.md:94 (bugs)** - "propose the next batch from
  the backlog" references a backlog that is never defined (issues? a doc? the
  conversation?), so a resuming advisor cannot reliably find what to propose
  next. Define the source, for example: open GitHub issues not part of any batch
  (no `Part of batch #` line), ordered by dependency then creation date.
- **.claude/skills/sync-template/SKILL.md:48-51 (bugs)** - The user-scope-copy
  update uses "older than the template's copy", but file mtime is unreliable
  (clone and copy reset it) and there is no version stamp inside the skill file,
  so the model has no reliable way to tell which copy is newer. Define the
  comparison: compare the user-scope copy's content against template release
  history, or add a version comment to the skill file that sync-template can
  read.

### Bounded orchestration workflows

- **.claude/workflows/review-codebase.js:135, 146, 171 (security)** - `root`
  comes verbatim from `opts.path` and is embedded into the `git ls-files --
  ${root}` string handed to the scout and architecture agents' Bash tool. Shell
  metacharacters in `root` (for example `$(...)`, `; rm -rf .`) reach a shell
  unescaped. The input is the operator's own CLI argument and the agent runs
  sandboxed, so real risk is low, but the value should be hardened: restrict to
  `[A-Za-z0-9_./-]` or single-quote it in the command string.
- **.claude/workflows/review-changes.js:94 (security)** - Same vector: `base`
  from `args.base` is embedded into `git diff ${base}...HEAD`. Apply the same
  guard (accept only git-ref-safe characters, or single-quote the value).
- **.claude/workflows/review-codebase.js:194-196 (bugs)** - `ceilingReached` is
  `scoutDropped.length > 0`, but `scoutDropped` mixes the scout's own `dropped`
  list with the script's `slice(MAX_AREAS)` overflow. When the scout self-drops
  paths while staying under `MAX_AREAS`, `ceilingReached` is still true and
  `suggestedNextAction` tells the caller to re-run with double the cap. Raising
  the cap is the right advice for scout self-drop too (the scout uses
  `MAX_AREAS` as its own limit), but the two cases deserve distinct messages so
  the caller knows whether the hard clamp or the scout's own sizing caused the
  shortfall. Track script overflow separately from scout self-drop and word the
  note accordingly.
- **.claude/workflows/review-codebase.js:n/a (tests)** - The scout-failure path
  (the must-fix above) is exercised by no live run; the plan tests only the
  ceiling path (`areas: 2`). Add a validation step that invokes the workflow
  with an invalid `path` so `git ls-files` returns nothing, and asserts the
  result calls out missing area coverage rather than returning `approve`.

### Project configuration

- **.claude/agents/tester.md:1-8 (style)** - `architect` and `reviewer` declare
  `tools: Read, Grep, Glob, Bash` in frontmatter; the tester's read-only
  constraint ("You have no Edit or Write access on purpose") lives only in prose
  and is not enforced by configuration. Add `tools: Read, Grep, Glob, Bash` to
  the tester frontmatter so the constraint is machine-readable and consistent
  with the other read-only agents.

### Project documentation and onboarding

- **CLAUDE.md:223 (bugs)** - The Repo layout skills entry lists only "/advisor,
  /kickoff" but `.claude/skills/` holds five skills (advisor, grill-me, kickoff,
  sync-template, to-issues). A reader using the layout to learn what is
  available misses three. List all five, or describe the directory generically
  if the list is expected to grow. (Reported three times across areas; one fix.)
- **README.md:88 (style)** - The license paragraph uses two em dashes ("in any
  other project — public or private — without prior written permission"). The
  writing-style rule forbids em dashes. Replace with parentheses or commas:
  "in any other project (public or private) without prior written permission".
- **NEW-PROJECT-SETUP.md:24-25 (scope)** - Step 2 verifies the agent team
  (`/agents` lists architect, developer, tester, reviewer) but adds no parallel
  check that the project skills registered, even though `/kickoff` and
  `/advisor` are equally critical and equally prone to silent install failure.
  Add a check that the skills are available.

### Design specs and plans

- **docs/plans/37-review-codebase.md:57-247 (scope)** - The four Task 1 code
  blocks are stale: the "Design updates after planning" section (lines 13-27)
  acknowledges three divergences from the shipped file (default ceiling 24 not
  8, the `slice(0, MAX_AREAS)` hard clamp, args normalization) and the omission
  of `ceilingReached` / `suggestedNextAction` from the schema and consolidate
  prompt, but the code blocks themselves were never updated. The shipped
  workflow is correct and the plan flags the divergence, so this does not block
  the code, but a session resuming from the plan code blocks would reproduce the
  superseded design. Update the code blocks to match the shipped file, or
  replace them with a pointer to the shipped file as the source of truth. (This
  single finding absorbs the separately reported gaps at lines 81, 134-166,
  187-188, and 241-243, which are all instances of the same un-updated blocks.)
- **docs/superpowers/specs/2026-06-13-review-codebase-design.md:136-137
  (style)** - The Report contract says the report is "grouped by severity then
  area", while the shipped consolidate prompt says "grouped by area" (with
  severity sections implied by the must-fix / should-fix / nit headings). The
  two are reconcilable but the wording diverges; align the spec and the prompt
  on one phrasing (severity sections, each organized by area).

## Nits

### Role agents

- **.claude/agents/reviewer.md:8-13 (bugs)** - Two diff commands are offered
  (`gh pr diff <n>` or `git diff origin/main...origin/<branch>`) with no
  guidance on which to prefer; they can produce different output depending on
  GitHub's computed merge base. Prescribe one canonical command per situation.
- **.claude/agents/developer.md:15-30 (scope)** - Steps 2 and 3 duplicate most
  of their fetch / detached-work / refspec-push logic split by resume-vs-fresh
  framing. A single fetch-and-switch pattern (always fetch; detached from
  FETCH_HEAD if the branch exists, else `git switch -c`) would cover both and
  reduce drift.
- **.claude/agents/architect.md:35 (style)** - "Anchor on the issue text and the
  four principles" uses "anchor on", a borderline AI-cliche construction.
  Replace with "Decide using the issue text and the four principles".
- **.claude/agents/developer.md:40 (style)** - "Touch only what the issue
  requires" restates the surgical-changes principle the developer already
  inherits; per CLAUDE.md, agent files should not repeat the global principles.
  Consider removing it.
- **.claude/agents/reviewer.md:26 (style)** - "verifiable behavior" is vague
  next to "correctness" and "simplicity" and overlaps the tester's role.
  Replace with a concrete criterion or rely on the specific "weakened or deleted
  test is always a blocking finding" line.
- **.claude/agents/tester.md:11 (style)** - "Throwaway scripts go in /tmp" reads
  as a one-off aside. Move it into a constraints block with the other guardrails
  (no Edit, no Write) so it has structural context, or drop it.

### Project skills

- **.claude/skills/kickoff/SKILL.md:66 (style)** - "the same fix loop" in step 6
  refers back to step 4 implicitly across a different triggering agent. Make the
  antecedent explicit (same dispatch format as step 4, then re-test, then
  re-review).
- **.claude/skills/sync-template/SKILL.md:9, 38 (style)** - "judgment merge" is
  a non-standard term used inconsistently (a noun compound on line 9, "by
  judgment" on line 38). Normalize to one phrasing, for example "a manual,
  file-by-file merge guided by the delta".
- **.claude/skills/grill-me/SKILL.md:1-15 (scope)** - The frontmatter
  description and the body both say "interview ... relentlessly"; minor
  duplication. No change needed (harvested third-party skill, harmless at this
  size).

### Bounded orchestration workflows

- **.claude/workflows/review-codebase.js:207 (bugs)** - `suggestedNextAction` is
  embedded with `JSON.stringify`, which wraps the string in literal quotes the
  agent then has to strip. Embed it directly (`${suggestedNextAction}`); keep
  `JSON.stringify` only for the arrays and boolean, which need valid JSON
  literals.
- **.claude/workflows/review-codebase.js:96-133 (scope)** - The
  `coverage.suggestedNextAction` schema description ("when ceilingReached, how
  to cover the rest...") implies the agent computes the value, but the script
  computes it and passes it back to echo. Change the description to note it is
  precomputed by the orchestrator.
- **.claude/workflows/review-codebase.js:45-58 (architecture)** - `FINDING`,
  `FINDINGS_SCHEMA`, and the `dismissed` sub-schema are duplicated verbatim
  between `review-changes.js` and `review-codebase.js`, diverging only in the
  added `area` / `dimension` fields. The runtime has no shared imports so the
  duplication is unavoidable; add a comment above each `FINDING` block noting
  the shared base and the intentional divergence so they stay in sync.
- **.claude/workflows/review-codebase.js:207 (style)** - The consolidate prompt
  says findings are "grouped by area" while the spec and plan say "grouped by
  severity then area". Reword the prompt to put severity first (must-fix, then
  should-fix, then nit, each organized by area) so the most critical findings
  lead the report and the prompt matches the spec.

### Project configuration

- **.claude/template-version:n/a (architecture)** - The template repo ships no
  `.claude/template-version` stamp (NEW-PROJECT-SETUP.md step 2 creates it
  per-repo, and sync-template writes it on first run). A repo created from this
  template is therefore in unknown-base mode on its first `/sync-template`,
  taking the conservative full-file pass instead of the cheaper delta. The
  legacy no-stamp path handles this, so it is usability, not correctness:
  shipping a stamp (the template HEAD SHA, or a placeholder) would make the
  first downstream sync cleaner. (Reported twice; one fix.)
- **CLAUDE.md:143 (style)** - The heading "Operating model (CEO + advisor)" uses
  "CEO", which appears nowhere else and is never defined. Expand it ("user as
  decision-maker + advisor") or drop it.
- **CLAUDE.md:133-134 (style)** - These two lines (103 and 135 characters) break
  the paragraph's ~80-character soft wrap, making the block inconsistent and
  harder to diff. Re-wrap to match the surrounding flow.
- **docs/plans/37-review-codebase.md:7 (architecture)** - The plan header still
  says "at most N coherent areas (default 8)" while the shipped default is 24.
  The Design updates section documents the change, but the header summary is
  stale; update it to match the shipped behavior.
- **docs/plans/37-review-codebase.md:74 (style)** - A comment in the Step 1 code
  block says "a Fable or Opus session"; CLAUDE.md names the efficient model
  "Fable 5". Minor internal-naming inconsistency; use "Fable 5" if the block is
  revised (note: `review-changes.js:14` uses the same bare "Fable", so align all
  three if touched).
- **.gitignore:3 (architecture)** - `/reviews/` is ignored with no comment.
  Add an inline comment noting it is generated by `/review-codebase` and that
  `git add -f` keeps a specific report.
- **CLAUDE.md:83-85, 227-231 (architecture)** - The Repo layout and the e2e /
  Tests sections reference `docs/architecture/`, `docs/operations/`, and `e2e/`,
  none of which exist yet in the template (they are created by
  NEW-PROJECT-SETUP.md). A session that reads CLAUDE.md and then inspects the
  tree finds a gap. Add a "scaffolded per NEW-PROJECT-SETUP.md" note to those
  entries, or add `.gitkeep` placeholders.
- **.claude/settings.json:1-5 (scope)** - The file holds only `enabledPlugins`,
  which is correct and minimal. The sync-template merge strategy implies other
  keys (permissions, hooks, env) may live here over time with no in-file marker
  distinguishing template-managed from project-managed keys. No change needed
  now; if the template ever ships a permissions or hook example, add a layout
  note distinguishing the two so a sync does not silently overwrite project
  keys.

## Dismissed

- **CLAUDE.md:172 "Fable 5 is not a known Anthropic model name" (must-fix
  claim)** - Not a defect. "Fable" / "Fable 5" is the template's deliberate
  internal codename for the efficient model class, used consistently across
  CLAUDE.md, `.claude/workflows/review-changes.js:14`, and
  `docs/plans/37-review-codebase.md:74`. It is intentional project terminology,
  not a typo or a missing model. The only real item here is the minor bare
  "Fable" vs "Fable 5" inconsistency, kept as a nit.
- **docs/plans/37-review-codebase.md:134-166 and :241-243 (must-fix claims:
  schema and consolidate prompt omit ceiling fields)** - Downgraded, not
  blocking. The shipped `.claude/workflows/review-codebase.js` includes
  `ceilingReached` / `suggestedNextAction` in both the schema and the
  consolidate call and is correct; the plan is a stale execution artifact for
  already-shipped work and explicitly flags the divergence in its Design updates
  section. Per the repo rule "when code and a doc disagree, the code wins and the
  doc is corrected", these are documentation staleness, merged into the single
  should-fix on the stale plan code blocks.
- **docs/plans/37-review-codebase.md:81 and :187-188 (default 8, missing
  slice/clamp)** - Same root cause as above (un-updated Task 1 code blocks);
  merged into the single stale-code-blocks should-fix rather than listed
  separately.
- **CLAUDE.md skills-list staleness reported under three areas (Project
  configuration, Project documentation, repo)** - The same omission at line 223;
  merged into one should-fix.
- **`.claude/template-version` reported under two areas (Project configuration
  and repo)** - Same gap; merged into one nit.
- **review-changes.js / review-codebase.js schema duplication reported under
  "workflows" architecture** - Kept as a nit (the consolidated workflows entry);
  the proposed fix (a sync comment) is the same.

## Coverage

Full review, no truncation.

- **Areas reviewed:** Role agents (`.claude/agents/`); Project skills
  (`.claude/skills/`); Bounded orchestration workflows (`.claude/workflows/`);
  Project configuration (`.claude/settings.json`, `.gitignore`,
  `.claude/template-version`); Project documentation and onboarding
  (`CLAUDE.md`, `README.md`, `NEW-PROJECT-SETUP.md`); Design specs and plans
  (`docs/superpowers/specs/`, `docs/plans/`).
- **Paths not covered:** none. `docs/architecture/`, `docs/operations/`, and
  `e2e/` do not exist yet (created per NEW-PROJECT-SETUP.md) and are flagged in
  the nits above.
- **Workers that failed:** none.
