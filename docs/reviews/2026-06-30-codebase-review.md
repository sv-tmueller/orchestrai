# Codebase review - 2026-06-30

**Verdict: approve**

Full-repo review of the claude-template: the `.claude/` agent team and project
skills, the two bounded review workflows and their test harness, the project
configuration, and the documentation, design specs, plans, and prior review
reports. The machinery is well-built and the per-stage model-pinning discipline
holds throughout. No must-fix findings survived verification: the must-fix
items flagged in the two prior reports (the scout-failure guard, the
`opts.areas` numeric validation) have shipped, and nothing new rises to a
blocker. What remains is a set of prose-hardening and consistency items in the
agent and skill files, two reliability gaps in the workflow scripts, a few
test-coverage gaps in the helper suite, and documentation drift in the specs,
plans, and archived reports.

This review supersedes `docs/reviews/2026-06-14-codebase-review.md`, which itself
superseded `docs/reviews/2026-06-13-codebase-review.md`.

## Should-fix

### Agent role definitions

- **`.claude/agents/developer.md:58-60`** (bugs) - The instruction "Run the full
  check suite from CLAUDE.md 'Useful commands' before reporting" has no fallback
  for an absent section or an all-placeholder one (this template's literal state:
  the only runnable line is `npm test`). The sibling `tester.md:37-40` already
  handles this ("If that section is absent, or if every command line in it is a
  placeholder comment ... emit `VERDICT: FAIL`"), but `developer.md` has no
  parallel rule, so a developer dispatched against an unscaffolded project has
  undefined behavior for the CHECKS line and can report `CHECKS: none` under
  `STATUS: DONE` with no signal that nothing was verified. Fix: add the same
  guard - record an unconfigured check explicitly on the CHECKS line and
  downgrade to `DONE_WITH_CONCERNS` rather than `DONE` so the gap surfaces to the
  tester and reviewer.

- **`.claude/agents/reviewer.md:1-10`** (security) - The frontmatter grants
  `Read, Grep, Glob, Bash` and the description claims "Read-only", but unlike
  `tester.md` (explicit "Guardrails - hard constraints" block) `reviewer.md`
  only says "Bash is for reading only" with no explicit prohibition against
  commit/push/edit-adjacent commands (`gh pr edit`, `git commit`,
  `gh issue comment`, `rm`). The tool grant does not enforce read-only, so the
  only guard is prose, and this is the weakest of the three Bash-bearing roles.
  Fix: add an explicit guardrail sentence mirroring `tester.md`'s, e.g. "Hard
  constraint: never run a command that writes to the repo or GitHub state (no
  commit, push, file edit, label change, or PR/issue mutation)."

### Project skills (tm- slash commands)

- **`.claude/skills/tm-kickoff/SKILL.md:36`** (bugs) - Resume detection uses
  `gh pr list --state open --search "Closes #<n>"`. `Closes` is not a search
  qualifier and `#<n>` is tokenized, so this is a best-effort full-text search
  over PR bodies that can both false-positive (unrelated PRs containing the
  substring) and false-negative (indexing lag, `closes`/`Fixes` variants). Fix:
  prefer the branch-name convention (`gh pr list --state open --head <branch>`)
  or fetch `--json number,body` and match the `Closes #<n>` line yourself; at
  minimum document that the search is best-effort and cross-check the branch
  convention before concluding no PR exists.

- **`.claude/skills/tm-advisor/SKILL.md:130` and `:183`** (bugs) - The resume
  query `--search "Batch: in:title"` and the backlog query
  `--search "NOT Batch: in:title"` both pass an unquoted `Batch:` token to
  GitHub's search API, where a colon inside an unquoted term can be parsed as a
  qualifier delimiter rather than literal text, risking zero or wrong matches.
  On the backlog path a silent failure could surface a `Batch:` tracking issue
  as a candidate package, the exact case the design tries to prevent (the next
  sentence already adds a defensive body filter, implying the title filter is
  not fully trusted). Fix: quote the literal phrase
  (`--search "\"Batch:\" in:title"`) and add a client-side title-prefix reject on
  the returned issues, matching the belt-and-suspenders body filter already used
  for `Part of batch #`.

- **`.claude/skills/tm-kickoff/SKILL.md:144-159`** (bugs) - Worktree cleanup
  deletes a stray local package branch with `git branch -D <branch>` once
  `git ls-remote --exit-code origin <branch>` succeeds, treating remote existence
  as proof the local work is safe to discard. The prose says "never delete a
  branch whose commits are not on origin", but `ls-remote` success plus `-D` does
  not verify the local tip is reachable from (or equal to) the remote tip, so a
  local branch ahead of origin (a partial-push case) loses unpushed commits
  silently. Fix: compare `git rev-parse <branch>` to `git rev-parse
  origin/<branch>` and only force-delete on an exact match, or use `git branch
  -d` (which refuses on unmerged work) and abort with a report if they differ.

### Workflow scripts and tests

- **`.claude/workflows/tm-review-changes.js:23-26,102-103`** (security) -
  `safeRef` accepts any string matching `/^[\w.~^\/\-]+$/` without `..`, which
  permits a flag-shaped value (`-c`, `--upload-pack`) to pass and be interpolated
  into the `git diff ${base}...HEAD` prompt with no `--` guard. A git ref never
  legitimately begins with `-`, so an agent running the suggested command
  literally could have the value read as an option. The comment claims the regex
  "protects both the git command string and the agent prompts", but that is
  incomplete for leading-dash option injection. Fix: reject values starting with
  `-` (add `&& !value.startsWith('-')` to the predicate). This is the same
  hardening theme as the prior reports' `safeRef` allow-list and `..` items.

- **`.claude/workflows/tm-review-changes.js:26`** (bugs) - The file reads
  `args.base` directly with no JSON-string normalization, while the sibling
  `tm-review-codebase.js` runs `parseArgs()` to handle both object and
  JSON-string callers (per `docs/plans/37-review-codebase.md`: "`args` is
  normalized for both object and JSON-string callers"). If the runtime ever
  passes args as a JSON string, `args.base` silently evaluates to `undefined`
  and falls back to `origin/main`, masking the caller's intended base ref. Fix:
  add the same `parseArgs()` normalization so both workflows handle args
  consistently.

- **`.claude/workflows/tm-review-codebase.js:49`** (scope) - `MAX_AREAS` is taken
  from `opts.areas` with only a lower-bound check (`Number.isInteger && > 0`) and
  no upper bound. A caller passing a very large `areas` (e.g. 100000) defeats the
  "never exceeds MAX_AREAS + 3, no matter how large the repo is" guarantee
  asserted at lines 12-18, since the bound itself becomes unbounded. The repo's
  own size keeps real runs small, so this is should-fix, not a blocker. Fix:
  clamp to a sane absolute ceiling, e.g. `Math.min(opts.areas, 100)`.

### Plans, specs, and architecture docs

- **`docs/superpowers/specs/2026-06-15-tm-install-team-design.md:53,116-120` and
  `docs/plans/98-tm-install-team.md:50`** (architecture) - The approved spec and
  its plan describe the skill as copying three items (agents, skills, workflows)
  and running 5 numbered sections ("sections 1-5"). The shipped
  `.claude/skills/tm-install-team/SKILL.md` copies a 4th item (`team-guide.md` ->
  `T/team-guide.md`) and runs 6 sections, adding a dedicated "Step 4: Print
  team-guide import instruction". That delivery came from the 2026-06-16
  process-guidance-rehoming design (decision 3), but the 06-15 spec and the 98
  plan were never amended, unlike `docs/plans/37-review-codebase.md` which
  carries an explicit "Design updates after planning" amendment. Fix: add an
  amendment note (matching the 37-plan style) to both, pointing at the 06-16
  design and stating the shipped skill is canonical: it copies a 4th item and
  runs 6 sections.

### Review reports

- **`docs/reviews/2026-06-14-codebase-review.md`** (architecture) - The report
  repeatedly reviews and reports findings against
  `.claude/skills/tm-sync-template/SKILL.md` and `.claude/template-version`
  (11 references), both of which no longer exist in the tree (superseded by
  `tm-install-team` per the 2026-06-16 rehoming design, decision 4:
  "tm-sync-template is deprecated"). A reader today cannot locate or act on
  those findings. Fix: add a short superseded-by note at the top (mirroring the
  note it already carries about superseding the 06-13 report) stating that
  tm-sync-template / template-version were removed by the 06-16 decision and
  those specific findings no longer apply; or fold a fresh pass into a new dated
  report that reflects the current tree (this report does that for the live
  tree, so the note is the lighter fix).

## Nit

### Agent role definitions

- **`.claude/agents/architect.md:8-10`** (security) - architect.md does state "Do
  not commit, push, edit files, or change repo state" in prose, but as a single
  buried sentence rather than a distinct guardrails block like `tester.md`'s.
  Fix: pull the existing sentence into a short "Guardrails" list for consistency
  across the three read-only roles.

- **`.claude/agents/architect.md:19-25`** (scope) - The SUB_PLAN job re-lists the
  checkpoint-bullet format ("the approach, the files ... the order, the
  verification step") verbatim instead of referencing the "Sub-plans" section in
  team-guide.md, which defines the same format. Two copies can drift. Fix:
  replace the restated list with a reference to the team-guide format.

- **`.claude/agents/developer.md:15-46`** (scope) - The fix-round/resume path and
  the fresh-package path repeat most of the fetch / detached-checkout /
  push-refspec machinery, differing mainly in which `ls-remote` outcome is
  expected. The duplication is partly intentional (inverted success conditions),
  but a refactor of one path's wording is easy to forget to mirror. Fix:
  optional - factor the shared steps into one paragraph with the two branch
  conditions as a single if/else, or accept the duplication as a deliberate
  safety-clarity tradeoff.

- **`.claude/agents/*.md`** (tests) - No automated check pins the report-contract
  literals (`STATUS:`, `VERDICT:`, `DONE_WITH_CONCERNS`, `PASS`/`FAIL`, etc.)
  that tm-kickoff's routing string-matches against. A wording edit to any agent
  file could silently break the pipeline. Fix: consider a lightweight grep-based
  CI assertion that the literal routing tokens still appear verbatim in the
  agent files' report contracts. (Out of scope for a markdown-only change;
  flagged for awareness.)

### Project skills (tm- slash commands)

- **`.claude/skills/tm-advisor/SKILL.md:62-69` and
  `.claude/skills/tm-kickoff/SKILL.md:25-30`** (scope) - The six
  `gh label create ... --force` lines are duplicated verbatim across both files.
  The prose acknowledges the double-run and relies on `--force` idempotency, but
  the label set (names, colors, descriptions) now has two sources of truth that
  must be hand-synced. Fix: factor the block into one referenced place, or at
  minimum add a cross-pointing comment in each file.

- **`.claude/skills/tm-install-team/SKILL.md:52-59`** (bugs) - Conflict detection
  uses `diff -rq SRC DST` but never describes resolution when DST is the wrong
  type (a file where a skill directory is expected, or vice versa). `diff -rq`
  reports the mismatch as a difference, which routes correctly to the conflict
  list, so this is benign, but `cp -R` over a stale plain file named `tm-kickoff`
  will not produce a clean directory. Fix: when resolving a confirmed conflict,
  `rm -rf DST` before `cp -R` for directory items (and `rm -f DST` before `cp`
  for file items) so a type mismatch does not leave a corrupted merge.

- **tm-advisor, tm-kickoff, tm-install-team, tm-to-issues** (tests) - None of the
  orchestration-heavy skills have automated tests or fixtures pinning their `gh`
  usage, label idempotency, or resume-state parsing - the kind of
  "integration-client-against-fixtures" work the team-guide's Tests section
  calls for. This is consistent with prose-driven skills, but the riskier
  sub-behaviors (search-query correctness, branch-deletion safety) are
  logic-with-a-right-answer. Fix: if any fragile `gh search` or branch-safety
  logic is hardened into a helper script, add tests under a `__tests__/`
  directory following the `.claude/workflows/__tests__/` convention; for
  prose-only skills this stays low priority.

### Workflow scripts and tests

- **`.claude/workflows/__tests__/helpers.test.mjs:30-52,57-72`** (tests) -
  `loadFn`/`sliceFnSrc` find a function's closing brace by naively counting `{`
  and `}` with no awareness of string/template/regex contents. If `safeRef` or
  `parseArgs` ever gains a literal brace inside a string, the counter desyncs and
  slices a malformed body, producing a confusing `SyntaxError` rather than a
  clear "helper changed incompatibly" message. Today's functions have no such
  literals. Fix: note the caveat (partly documented) and leave as-is, or harden
  the brace walk with a small quote/backtick state machine.

- **`.claude/workflows/tm-review-codebase.js:214-219`** (tests) - The
  `ceilingReached` / `suggestedNextAction` branching (script-overflow vs
  scout-self-drop messaging) has no test coverage, unlike the closely related
  `scoutDropped` union logic which is well tested as a kernel. This is a
  multi-branch string-building path with a right answer. Fix: add a logic-kernel
  test covering: `scriptOverflow.length > 0` produces the "clamped, raise cap"
  message with `MAX_AREAS*2`; scout-self-dropped-only produces the "scope
  follow-up" message; `ceilingReached` is false when both are empty.

- **`.claude/workflows/tm-review-codebase.js:54-67`** (architecture) -
  `FINDING`/`FINDINGS_SCHEMA` are duplicated verbatim (differing only by the
  added `area`/`dimension` fields) between the two workflow files, with a comment
  in each asking editors to keep them in sync. The helper suite enforces
  byte-identity for `safeRef` but not for these schemas, so they can silently
  diverge on shape. Fix: add a structural-equality (or shared-fields
  byte-identity) test mirroring the existing `safeRef` test.

### Root config and guidance

- **`CLAUDE.md:44-55`** (scope) - The "Repo layout" tree lists `docs/architecture/`
  and `docs/operations/` as if they exist, but they are template placeholders
  created per NEW-PROJECT-SETUP. A reader of CLAUDE.md alone could believe they
  are scaffolded here, against the file's own "keep the status honest"
  instruction. (Note: the "Where decisions live" section at lines 24-27 already
  carries the "(see NEW-PROJECT-SETUP)" annotation on both bullets, so the
  inconsistency is only in the tree.) Fix: add a one-line parenthetical to the
  tree noting these directories do not exist in the template itself, mirroring
  the annotations already used elsewhere in the file.

- **`package.json:1`** (tests) - Declares only a `test` script plus
  `private: true`, with no `name`/`version`/`description`. For a template repo
  with zero dependencies and no lockfile this is consistent and healthy, but some
  tooling (`npm init`, `npm pkg get name`, dependabot) expects a name field.
  Fix: no action unless the repo is later published or needs a name for tooling;
  otherwise leave as-is.

### Review reports

- **`docs/reviews/2026-06-13-codebase-review.md:18`** (style) - The summary prose
  uses "robustness gaps"; "robust" is on the project's banned AI-cliche list
  (`.claude/team-guide.md:61`). This is the report's own prose, a literal
  style-rule violation. The 06-14 report already self-identifies this exact
  instance as a nit but the 06-13 file was never corrected. Fix: acceptable to
  leave given the file's "historical record, preserved verbatim" banner (the
  violation is already tracked); or, on a cosmetic pass, replace with
  "reliability gaps".

## Coverage

All planned areas were reviewed; no paths were dropped and no workers failed.

- **Areas reviewed:** Agent role definitions; Project skills (tm- slash
  commands); Workflow scripts and tests; Root config and guidance; Plans, specs,
  and architecture docs; Review reports.
- **Paths not covered:** none.
- **Workers that failed:** none.

This is a full-tree pass on the current state and supersedes the 06-14 and 06-13
reports. The unit test suite (`npm test`) was run and passes (40 tests).
