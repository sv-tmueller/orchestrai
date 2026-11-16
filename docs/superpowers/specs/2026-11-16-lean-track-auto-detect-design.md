# Lean track for small code changes, decided by a script

Date: 2026-11-16
Status: approved by the owner on 2026-11-16.
Changes "Pipeline tracks (lean and full)" in
`.claude/skills/tm-kickoff/SKILL.md`.

## 1. Goal

Easy packages stop paying for four seats. Today the lean track (developer,
then a reviewer who also runs the check suite) is closed to any diff that
contains executable code, so in a normal code repo even a ten-line fix runs
architect, developer, tester and reviewer. The owner sees this on other
projects and in bench runs: #255 cost $7.55 on the pipeline against $1.80
for one developer dispatch, and #400 cost $6.29 against $4.46 at equal
measured quality (API list prices, one pair each).

After this change a small code change runs lean, and a script, not the
lead's reading of the rule, decides which track a package is on.

Why keep one reviewer: the developer-only arm of #255 ended with a must-fix
on its diff. One independent look stays on every package.

## 2. Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Which packages can run lean? | `size:S`, no forced-full path, at most 150 counted lines, and the existing repo clause (section 3). |
| 2 | Who decides? | A script, from the size label and the real diff. No model call. |
| 3 | When? | Twice: before dispatch (provisional) and before every reviewer dispatch (final), as today. |
| 4 | Can a package change track? | Lean to full only. Never full to lean. |
| 5 | What about `size:M`? | Always full, as today. |
| 6 | What about `.claude/` machinery? | Always full, as today. |

The owner approved all six on 2026-11-16, in a brainstorming session.

## 3. The rule

A package runs lean when all of these hold. Any other result is full, and
so is any input the script cannot read.

1. The issue carries `size:S`.
2. No path is forced full. Forced-full paths:
   - `.claude/agents`, `.claude/skills`, `.claude/workflows` (as today);
   - `.github/workflows` (a CI change can switch off the checks a lean
     merge depends on);
   - dependency manifests and lockfiles (the repo guard's own lists).
3. Counted lines are at most 150. Counted lines are added plus deleted
   lines in files that are neither test files (the repo guard's rule) nor
   docs (Markdown and reStructuredText). Tests and docs are never capped.
   A `.txt` file counts as code, because build files and pinned dependency
   lists are plain text too. A file with no line count (a binary file, or a
   text file marked binary or -diff) outside tests and docs gives full, and
   so does an empty diff.
4. The repo clause in `lean-allowed.mjs` allows it: unchanged. On a repo
   set up for auto merge with no test files, lean stays off.

The words "executable code" leave the lean rule. Rule 2 of "Fix rounds"
(lead-verified rounds) keeps its own wording and is not touched.

### Where 150 comes from

Measured on 2026-11-16 on merged PRs that close exactly one sized issue, in
four other repos the pipeline runs on (`claudeline-champions`,
`3d-casaplazai`, `rainmaker-bot` and one private work repo), with the rule
above applied to each PR's file list.

How many `size:S` packages run lean (202 PRs):

| | PRs | Share |
|---|---|---|
| Lean today (docs and tests only) | 42 | 21% |
| Lean with a cap of 100 | 141 | 70% |
| Lean with a cap of 150 | 154 | 76% |
| Lean with a cap of 200 | 162 | 80% |
| Forced full by path (CI, manifests, machinery) | 21 | 10% |

What the tester found on `size:S` code changes. 69 of them have a tester
verdict on the PR and no forced-full path (2026-07-17 to 2026-11-15):

| Counted lines | PRs | Tester FAIL | What the FAILs were |
|---|---|---|---|
| up to 150 | 56 | 5 | 3 wrong docs or comments, 1 line wrap, 1 "check suite not configured" |
| over 150 | 13 | 6 | 3 code or test defects, 2 line wrap, 1 "check suite not configured" |

Up to 150 counted lines the tester never found a code defect. Above it,
three of thirteen PRs had one: an incomplete conversion (`rainmaker-bot`
#442), risk caps that fail open on NaN (`rainmaker-bot` #488), and a test
guard that passes on a no-op (`claudeline-champions` #62). The reviewer
asked for changes on 11 of the 56 small ones, so it keeps earning its seat.

Limits of this evidence. The samples are small. On the full track the
reviewer sees the diff after the tester's fix, so the data cannot show
whether a lean reviewer would have found those three defects. And the docs
and comment findings below 150 lines were real: on the lean track they are
the reviewer's to catch.

The cap is one named constant in the script, with no setting.

This repo gains little: of its 151 `size:S` PRs, 90 touch the machinery and
stay full, 49 are lean today, and 10 are code changes outside the machinery
(9 of them under the cap). The gain is in the other repos.

## 4. How the decision runs

`lean-allowed.mjs` holds the whole rule, not only the repo clause, and
prints `{ allowed, reason }` as it does today. It makes no gh calls. The
lead runs it and follows the answer; the lead no longer applies the rule
from the prose.

- **Before dispatch (provisional).** Input: the size label, the repo clause
  inputs, and the paths the issue body names, if any. There is no diff yet,
  so the line cap cannot apply. The result decides whether the architect is
  skipped, and goes into the wave plan or advisor proposal with its reason.
  Reading paths out of the issue body is the one step that stays with the
  lead. The match on those paths is broader than the match on the diff: an
  issue path that contains `.claude` or `.github`, or the name of a
  dependency file, in any spelling, gives full.
- **Before every reviewer dispatch (final).** Input: the same, plus the
  real diff between the default branch and the PR head, read with git. If
  lean is not allowed, the package moves to the full track at the tester
  stage with a `Track: full - <reason>` comment, exactly as a broken diff
  check does today.
- **Wave-end report.** One line: how many packages ran lean, ran full, and
  moved from lean to full, with the reasons. This is the data for
  revisiting the cap.

Agent files do not change. The reviewer already runs the check suite on a
lean dispatch, and the developer already takes the issue body as its spec.

## 5. Approaches considered

- **A script on the label and the real diff (chosen).** Same answer for the
  same input, covered by unit tests, costs no tokens. The diff is the
  ground truth: a package that grows past the cap gets a tester. Weakness:
  it cannot see a change that is small and still tricky. The reviewer and
  CI are the answer to that.
- **A model judges how hard the issue is** (the architect, or a cheap
  triage seat). It can read intent, but it costs a dispatch per package,
  its answer varies between runs, and it spends tokens to decide whether to
  save tokens.
- **The reviewer can ask for a tester.** A new line in the reviewer's
  report sends a lean package to the tester when the reviewer cannot
  verify the logic by reading. Good judgment at no extra dispatch, but it
  changes the report contract and its parser. Not now. Revisit if lean
  packages ship flaws.
- **The diff alone, without the size label.** Dropped: the architect has to
  be skipped before any diff exists.

## 6. Not in scope

- Skipping the tester on a `size:M` package whose diff comes out small. In
  the four repos, 60 of 243 `size:M` PRs are code changes of at most 150
  counted lines, so there may be a second saving there. Their tester
  record has not been measured yet.
- Opening the lean track to `.claude/` machinery.
- Changing models or effort on any seat.
- Letting the developer rate its own package as easy.

## 7. Accepted risk

On a repo set up for auto merge, a `size:S` code change of up to 150
counted lines merges on one reviewer verdict plus green CI, with no tester
and no human. Before this change that was true only for docs and tests.
The owner accepted this on 2026-11-16.

## 8. Left to the plan

- The script's new flags.
- The exact docs extensions and the manifest list taken from the repo guard.
- Unit tests first for the pure function. Update the text tests that pin
  the lean rule (`kickoff-lean-check-text.test.mjs`), `README.md`,
  `SKILL.hermes.md`, and any other place that repeats the rule.
- Issue sizing. Expected: one `size:M` issue, on the full track, because it
  edits a skill.
