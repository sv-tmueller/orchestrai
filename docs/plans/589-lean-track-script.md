# Lean Track For Small Code Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lean-allowed.mjs` holds the whole lean rule (size, forced-full paths, a 150-line cap, the repo clause), and the kickoff skill tells the lead to run it and follow its answer.

**Architecture:** The existing script keeps its name, its output shape `{ allowed, reason }` and its repo clause. A new pure function `packageAllowed` decides the size, path and line rules; `main` runs it first and the repo clause second. The CLI gains three required flags and reads the diff with `git diff --numstat`. The skill text drops its prose rule and its `gh pr diff --name-only` step.

**Tech Stack:** Node (ESM, `node:test`, zero dependencies), git, Markdown skill text.

**Spec:** `docs/superpowers/specs/2026-11-16-lean-track-auto-detect-design.md`. Issue #589.

> **Changed after this plan was written** (review and tester rounds on PR #590). The code and the design doc are the current statement of the rule. Where this plan differs, they win:
>
> - A file with no line count (a binary file, or a text file marked `binary` or `-diff`) outside tests and docs gives full. This plan says a binary file counts zero lines, and its test listings "a binary change counts zero lines", "a binary entry has zero counts" and "a binary file added: allowed" were changed to match.
> - With a diff head given, an empty diff gives full.
> - A `.txt` file counts as code, and `requirements*.txt` and `constraints*.txt` are forced full.
> - An issue path is normalized before the match, the parents `.claude` and `.github` force full, and an issue path that is not a plain repo-relative path is a usage error.
> - The diff is read with `--no-relative`.

## Global Constraints

- Line cap: `150` counted lines. Counted lines are added plus deleted lines in files that are neither test files nor docs.
- Test file: `countTestFiles([path]) > 0` from `.claude/skills/tm-repo-guard/repo-guard.mjs`. Never copy its patterns.
- Docs: file name ends in `.md`, `.mdx` or `.rst`, case-insensitive. (Changed in the final review: `.txt` counts as code, and `requirements*.txt` and `constraints*.txt` are forced full.)
- Forced-full directories, matched as `path === dir` or `path.startsWith(dir + '/')`: `.claude/agents`, `.claude/skills`, `.claude/workflows`, `.github/workflows`.
- Forced-full file names, matched on the base name in any directory: the repo guard's `MANIFESTS` and `NODE_LOCKFILES` names, plus `uv.lock`, `poetry.lock`, `requirements.txt`, `go.sum`, `Package.resolved`.
- Any input the script cannot read gives `allowed: false`. A usage error exits 2 with one stderr line. Every other run exits 0.
- The script makes no gh calls.
- A package moves from lean to full, never back. `size:M` and larger are always full.
- No change to any file in `.claude/agents/`, to a model or to an effort pin. Rule 2 of "Fix rounds" in the kickoff skill keeps its wording.
- Writing style from `.claude/process-core.md`: no em dashes, plain short sentences, comments only where the why is not obvious.
- `npm test` passes before every commit. Conventional Commits, lowercase, imperative.

## Review Focus

- **A rename with no content change.** The diff is read with `--no-renames`, so it counts as a delete plus an add and can exceed the cap. Expected: full, never a crash. Test in Task 2.
- **A binary file.** numstat prints `-` for both counts. Expected: full outside tests and docs, because the line cap cannot be checked (changed in the tester rounds; this plan first said zero counted lines). Tests in Tasks 1 and 2.
- **Spaces, tabs, newlines and non-ASCII in a path.** Expected: the `-z` parser keeps the path whole. Test in Task 1.
- **Near-miss paths.** `.claude/skills-notes.md` and `docs/.github/workflows/x.yml` are not forced full. `.claude/skills` with no trailing slash (how an issue body names a directory) and `apps/web/package.json` are. Tests in Task 1.
- **A PR branch behind the default branch.** Expected: only the branch's own changes count, not what landed on the default branch since. Test in Task 2.

---

## File structure

- Modify `.claude/skills/tm-repo-guard/repo-guard.mjs:513-514`: export `MANIFESTS` and `NODE_LOCKFILES`.
- Modify `.claude/skills/tm-kickoff/lean-allowed.mjs`: the package rule, the numstat parser, three flags.
- Modify `.claude/workflows/__tests__/lean-allowed.test.mjs`: tests for the above.
- Modify `.claude/skills/tm-kickoff/SKILL.md`: "Pipeline tracks (lean and full)" and the wave-end report.
- Modify `.claude/skills/tm-advisor/SKILL.md`: one report line in section 5.
- Modify `.claude/workflows/__tests__/kickoff-lean-check-text.test.mjs`: the pinned clauses.
- Modify `README.md:63-69`: the "Lean vs full track" bullet.

---

### Task 1: The package rule

**Files:**
- Modify: `.claude/skills/tm-repo-guard/repo-guard.mjs:513-514`
- Modify: `.claude/skills/tm-kickoff/lean-allowed.mjs`
- Test: `.claude/workflows/__tests__/lean-allowed.test.mjs`

**Interfaces:**
- Consumes: `countTestFiles(paths: string[]): number`, `MANIFESTS: string[]`, `NODE_LOCKFILES: [name, command][]` from the repo guard.
- Produces, all exported from `lean-allowed.mjs`:
  - `LINE_CAP = 150`
  - `parseNumstat(text: string): { path: string, added: number, deleted: number }[]`
  - `forcedFull(path: string): boolean`
  - `countedLines(changes: { path, added, deleted }[]): number`
  - `packageAllowed({ size, issuePaths, changes }): { allowed: boolean, reason: string }` where `size` is `'S' | 'M' | 'L' | 'XL' | 'none'`, `issuePaths` is `string[]`, and `changes` is the `parseNumstat` array, `'none'` (no diff yet) or `'unknown'` (the diff could not be read).

- [ ] **Step 1: Write the failing tests**

Add to `lean-allowed.test.mjs`, importing the five new names. One `describe('lean-allowed: the package rule')` with these cases. `c(path, added, deleted = 0)` builds one change.

```js
const pkg = (over) => packageAllowed({ size: 'S', issuePaths: [], changes: 'none', ...over })

test('size S, no diff yet, no issue paths: allowed', () => {
  assert.equal(pkg({}).allowed, true)
})
for (const size of ['M', 'L', 'XL', 'none']) {
  test(`size ${size}: not allowed, the reason names the size`, () => {
    const r = pkg({ size })
    assert.equal(r.allowed, false)
    assert.ok(r.reason.includes(size))
  })
}
test('150 counted lines: allowed', () => {
  assert.equal(pkg({ changes: [c('src/a.ts', 100, 50)] }).allowed, true)
})
test('151 counted lines: not allowed, the reason names 151 and 150', () => {
  const r = pkg({ changes: [c('src/a.ts', 100, 50), c('src/b.py', 1)] })
  assert.equal(r.allowed, false)
  assert.ok(r.reason.includes('151') && r.reason.includes('150'))
})
test('test files and docs do not count', () => {
  const changes = [c('src/a.ts', 150), c('src/a.test.ts', 900), c('docs/x.md', 900),
    c('NOTES.TXT', 900), c('guide.rst', 900), c('page.mdx', 900)]
  assert.equal(countedLines(changes), 150)
  assert.equal(pkg({ changes }).allowed, true)
})
test('a binary change counts zero lines', () => {
  assert.equal(pkg({ changes: [c('art/logo.png', 0, 0)] }).allowed, true)
})
test('an unreadable diff: not allowed', () => {
  assert.equal(pkg({ changes: 'unknown' }).allowed, false)
})
for (const path of ['.claude/agents/reviewer.md', '.claude/skills/x/SKILL.md',
  '.claude/workflows/a.js', '.github/workflows/ci.yml', 'package.json',
  'apps/web/package.json', 'pnpm-lock.yaml', 'uv.lock', 'go.sum', 'Package.resolved']) {
  test(`forced full in the diff: ${path}`, () => {
    const r = pkg({ changes: [c(path, 1)] })
    assert.equal(r.allowed, false)
    assert.ok(r.reason.includes(path))
  })
}
test('forced full from the issue paths, directory named without a slash', () => {
  const r = pkg({ issuePaths: ['.claude/skills'] })
  assert.equal(r.allowed, false)
  assert.ok(r.reason.includes('.claude/skills'))
})
test('near misses are not forced full', () => {
  for (const path of ['.claude/skills-notes.md', 'docs/.github/workflows/x.yml',
    '.claude/settings.json', 'src/package.json.ts']) {
    assert.equal(forcedFull(path), false, path)
  }
})
test('the manifest names come from the repo guard, not a copy', () => {
  const src = readFileSync(scriptPath, 'utf8')
  assert.match(src, /MANIFESTS/)
  assert.doesNotMatch(src, /'pyproject\.toml'/)
})
```

And one `describe('lean-allowed: parseNumstat')`:

```js
test('reads counts and paths from -z output', () => {
  assert.deepEqual(parseNumstat('3\t1\tsrc/a.ts\x0010\t0\tb.md\x00'),
    [{ path: 'src/a.ts', added: 3, deleted: 1 }, { path: 'b.md', added: 10, deleted: 0 }])
})
test('a binary entry has zero counts', () => {
  assert.deepEqual(parseNumstat('-\t-\tart/logo.png\x00'),
    [{ path: 'art/logo.png', added: 0, deleted: 0 }])
})
test('keeps a tab, a newline and non-ASCII inside a path', () => {
  assert.deepEqual(parseNumstat('1\t0\tdir\twith\ttab/fü\nr.js\x00'),
    [{ path: 'dir\twith\ttab/fü\nr.js', added: 1, deleted: 0 }])
})
test('empty output is an empty list', () => {
  assert.deepEqual(parseNumstat(''), [])
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)|lean-allowed"`
Expected: the import fails, `packageAllowed` is not exported.

- [ ] **Step 3: Export the guard's lists**

In `repo-guard.mjs`, put `export` in front of `const MANIFESTS` and `const NODE_LOCKFILES`. Nothing else changes there.

- [ ] **Step 4: Implement the five exports in `lean-allowed.mjs`**

Order inside `packageAllowed`, first match wins:

1. `size !== 'S'`: not allowed.
2. A forced-full path among `issuePaths`, then among the diff's paths: not allowed, the reason names the first such path.
3. `changes === 'unknown'`: not allowed.
4. `changes` is an array and `countedLines(changes) > LINE_CAP`: not allowed, the reason gives the count and the cap.
5. Otherwise allowed.

`parseNumstat` splits on NUL and takes the path as everything after the second tab. Malformed input throws, like `leanAllowed`. Update the file's header comment: the script now decides the whole lean rule (issue #589), not one clause.

- [ ] **Step 5: Run the tests and see them pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/tm-repo-guard/repo-guard.mjs .claude/skills/tm-kickoff/lean-allowed.mjs .claude/workflows/__tests__/lean-allowed.test.mjs
git commit -m "feat: package rule for the lean check (#589)"
```

---

### Task 2: The command line reads the size and the diff

**Files:**
- Modify: `.claude/skills/tm-kickoff/lean-allowed.mjs` (`USAGE`, `FLAGS`, `main`)
- Test: `.claude/workflows/__tests__/lean-allowed.test.mjs`

**Interfaces:**
- Consumes: `packageAllowed`, `parseNumstat` from Task 1; the existing `leanAllowed`, `isSetUp`, `listPaths`.
- Produces: the command the skill names in Task 3.

```
lean-allowed.mjs --default-ref <ref>|unknown --auto-merge true|false|unknown
  --branch-protected true|false|unknown --branch-rules <n>|unknown
  --size S|M|L|XL|none --diff-head <ref>|none --issue-paths <paths>|none
```

All seven flags are required. `--issue-paths` is a comma-separated list. `--diff-head none` means no diff yet. With a diff head, the diff is `git diff --numstat -z --no-renames <default-ref>...<diff-head>` (three dots, so it starts at the merge base). The diff is `'unknown'` when the default ref is `unknown` or git fails.

- [ ] **Step 1: Write the failing tests**

Extend the `flags` helper with `size = 'S'`, `diffHead = 'none'`, `issuePaths = 'none'`, so every existing CLI test keeps its meaning. Add a helper `branch(dir, name, files)` that creates a branch off the current commit, writes the files and commits. Then, in a new `describe('lean-allowed: the CLI with a diff')`, each on a temp repo whose `main` holds `src/a.test.js` (the last one: only a `README.md`):

```js
test('no diff yet, size S: allowed', ...)                       // flags('main')
test('size M: not allowed', ...)                                // { size: 'M' }
test('a 10-line code change on the branch: allowed', ...)       // { diffHead: 'feat' }
test('a 151-line code change: not allowed, reason has 151', ...)
test('900 lines of tests and docs plus 10 of code: allowed', ...)
test('a change under .github/workflows: not allowed', ...)
test('an issue path under .claude/skills: not allowed', ...)    // { issuePaths: 'src/a.js,.claude/skills' }
test('main moved on by 400 lines after the branch point: still allowed', ...)
test('a 100-line file renamed with no edit: not allowed', ...)  // 200 counted lines
test('a binary file added: allowed', ...)                       // write Buffer.from([0, 1, 2, 0])
test('a diff head that does not exist: not allowed, exit 0', ...)
test('--default-ref unknown with a diff head: not allowed, exit 0', ...)
test('set up, no test files, small code change: not allowed with the repo reason', ...)
```

Each asserts `r.status === 0` and the parsed `allowed`. The last one asserts `reason === NO_TESTS`, which proves the repo clause still runs after the package rule.

Add to the usage-error block:

```js
test('a bad size', () => expectUsage(flags('main', { size: 's' })))
test('an empty diff head', () => expectUsage(flags('main', { diffHead: '' })))
test('a diff head that starts with a dash', () => expectUsage(flags('main', { diffHead: '--output=x' })))
test('an empty issue path list', () => expectUsage(flags('main', { issuePaths: '' })))
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: failures with `unknown argument "--size"`.

- [ ] **Step 3: Implement the flags and the composition in `main`**

Parse the three flags with the same strictness as the others. `main` validates everything before touching git, runs `packageAllowed`, prints its result when not allowed, and otherwise prints the `leanAllowed` result as today. Skip the diff read when `--diff-head` is `none` or the size is not `S`. Update `USAGE`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: failures only in `kickoff-lean-check-text.test.mjs` (the skill still names four flags). Task 3 fixes those. Every `lean-allowed` test passes.

- [ ] **Step 5: Commit together with Task 3**

The tree is red between Step 3 and the skill text change, so Task 2 and Task 3 share one commit.

---

### Task 3: The skill follows the script

**Files:**
- Modify: `.claude/skills/tm-kickoff/SKILL.md:511-571` ("Pipeline tracks") and the section 4 report
- Modify: `.claude/skills/tm-advisor/SKILL.md` (section 5 report)
- Modify: `.claude/workflows/__tests__/kickoff-lean-check-text.test.mjs`
- Modify: `README.md:63-69`

**Interfaces:**
- Consumes: the command line from Task 2.

- [ ] **Step 1: Update the pinned clauses first**

In `kickoff-lean-check-text.test.mjs`, replace the last two `CLAUSES` entries (`'if the paths still pass, run the lean check'` and the `"or \`Track: full - ..."` one) with:

```js
['Diff check', 'run the lean check with `--diff-head origin/<branch>`'],
['Diff check', "If it does not allow the lean track, post `Track: full - <the lean check's reason>` on the issue, remove `track:lean`"],
['Before dispatch', 'Run the lean check with `--diff-head none`'],
['Lean check', 'The lead does not apply the rule itself'],
```

Add one test that the lean rule no longer says "executable code":

```js
test('the lean rule no longer excludes executable code', () => {
  const start = text.indexOf('### Pipeline tracks (lean and full)')
  const end = text.indexOf('### Repair (queued PRs behind the default branch)')
  assert.ok(start !== -1 && end > start)
  assert.ok(!text.slice(start, end).includes('executable code'))
})
```

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`. Expected: these fail.

- [ ] **Step 2: Rewrite the intro, "Before dispatch", "Lean check" and "Diff check" in `SKILL.md`**

Replace the intro paragraph and those three bullets with this text. Every other bullet in the section stays as it is.

```markdown
The numbered pipeline above is the full track, the default for every
package. A package runs the lean track only when the lean check (below)
allows it. The check holds the whole rule: `size:S`, no forced-full path
(`.claude/agents`, `.claude/skills`, `.claude/workflows`,
`.github/workflows`, dependency manifests and lockfiles), at most 150
counted lines (added plus deleted, outside test files and docs), and a
repo that has test files or is not set up for auto merge. A package moves
from lean to full, never back. When in doubt, full.

- **Before dispatch.** Run the lean check with `--diff-head none` and
  state the track and the check's reason in the wave plan or advisor
  proposal.
- **Lean check.** The lead does not apply the rule itself: it runs the
  check and follows the answer. Run it fresh each time:
  1. The three reads of step 7 sub-step 2. Set up is decided as in "Fix
     rounds" rule 8: a read that fails or prints `null` is passed as
     `unknown` and counts as set up.
  2. `git fetch origin`.
  3. `node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-kickoff/lean-allowed.mjs"
     --default-ref origin/<default> --auto-merge true|false|unknown
     --branch-protected true|false|unknown --branch-rules <n>|unknown
     --size S|M|L|XL|none --diff-head origin/<branch>|none
     --issue-paths <paths>|none`.
     Pass `--default-ref unknown` when the first read or the fetch failed.
     `--size` is the issue's size label. `--diff-head` is `none` until the
     developer has pushed. `--issue-paths` is the paths the issue body
     names, comma-separated, or `none`. It makes no gh calls: it reads the
     diff and the file list with git, counts test files with the repo
     guard's own rule, and prints `{ allowed, reason }`.
  When `allowed` is false the package runs full with the script's
  `reason`; a nonzero exit runs full with the reason `lean-allowed error`.
- **Diff check.** Before every lean reviewer dispatch (after DONE or
  DONE_WITH_CONCERNS, after each fix round, and on resume), run the lean
  check with `--diff-head origin/<branch>`. If it does not allow the lean
  track, post `Track: full - <the lean check's reason>` on the issue,
  remove `track:lean`, and continue on the full track from step 3
  (tester).
```

The first test in the text file runs the command with every listed choice. If `origin/<branch>` or `<paths>` needs a concrete stand-in there, extend that test's `concrete()` and nothing else.

- [ ] **Step 3: Add the track line to both reports**

In `SKILL.md` section 4, add to the "Report to the user" sentence: "and how many packages ran lean, ran full, and moved from lean to full (counted from the `Track:` comments)". Add this line to the "What happened" template, above the `Lesson` line:

```
- Tracks: <n> lean, <n> full, <n> moved to full (#NN: <the lean check's reason>)
```

Add the same line at the same place in the section 5 template of `tm-advisor/SKILL.md`, and "the track counts (as in kickoff section 4)" to the sentence above it.

- [ ] **Step 4: Rewrite the README bullet**

```markdown
- **Lean vs full track.** A `size:S` package that stays out of
  `.claude/agents`, `.claude/skills`, `.claude/workflows`,
  `.github/workflows` and dependency manifests, and changes at most 150
  lines outside tests and docs, skips the architect and tester stages;
  everything else runs the full five-stage pipeline. A script decides
  (`lean-allowed.mjs`), before dispatch and again on the real diff. On a
  repo set up for auto merge that has no test files (the repo guard's
  rule), every package runs the full track, so a merge never rests on the
  reviewer alone. Mechanics: `.claude/skills/tm-kickoff/SKILL.md`,
  "Pipeline tracks (lean and full)".
```

- [ ] **Step 5: Check nothing else repeats the old rule**

Run: `git grep -n "executable code" -- ':!docs/reviews' ':!docs/research' ':!docs/plans' ':!docs/superpowers'`
Expected: one hit, rule 2 (c) of "Fix rounds" in `tm-kickoff/SKILL.md`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit Tasks 2 and 3**

```bash
git add .claude/skills/tm-kickoff/lean-allowed.mjs .claude/skills/tm-kickoff/SKILL.md .claude/skills/tm-advisor/SKILL.md .claude/workflows/__tests__/lean-allowed.test.mjs .claude/workflows/__tests__/kickoff-lean-check-text.test.mjs README.md
git commit -m "feat: lean track for small code changes, decided by the lean check (#589)"
```

The body says why: the tester found no code defect on `size:S` changes of up to 150 counted lines in four repos, and the rule moved from prose into the script so the lead cannot misread it.
