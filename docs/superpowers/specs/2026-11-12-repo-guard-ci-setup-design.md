# Repo guard sets up CI

Date: 2026-11-12
Status: draft, for owner review. Decisions settled with the owner on
2026-11-12 in a brainstorming session.
Reopens the `tm-new-project` decision in
`docs/architecture/operating-model.md` (issue #190) and changes section 6 of
`docs/superpowers/specs/2026-11-10-autonomous-runs-design.md`.

## 1. Goal

One command per repo. Today a repo that has tests but no CI is refused by
`/tm-repo-guard apply` with "needs CI first", and the owner has to know that
`/tm-new-project` and a hand-written `ci.yml` come first. The owner never ran
`/tm-new-project` on newer repos, so the refusal was a dead end
(`3d-casaplazai`, 2026-11-12).

After this change, `/tm-repo-guard apply <repo>` sets up the missing CI
itself, merges it, and then applies the protection, all on one owner yes.
`tm-new-project` is removed.

Out of scope: repos that already have CI checks on a finished PR, and repos
with no test files. Both behave as today.

## 2. Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | How are the test commands chosen? | Detected from the repo's files, shown in the plan, written only after the owner's yes. When detection fails, the owner gives them. |
| 2 | What happens after the CI PR is open? | The same run waits for its checks, merges it when green, and goes on to protection. |
| 3 | Does one yes cover protection too? | Yes, with a safety stop: if the checks that ran differ from the ones the plan showed, the run stops and asks again. |
| 4 | What happens to the rest of `tm-new-project`? | The guard creates the six labels. The docs-tree step is dropped. The skill is deleted. `NEW-PROJECT-SETUP.md` stays as a plain checklist. |

## 3. The flow

The new path runs only where Apply refuses today with "needs CI first": the
repo has test files and no finished, non-draft PR has run a check.

### 3.1 Plan (reads only)

The plan prints, before the confirm token:

- the labels it will create: `size:S`, `size:M`, `size:L`, `size:XL`,
  `in-progress`, `needs-human`, with the colors and descriptions
  `tm-new-project` uses today
- the detected install and test commands, and the full `ci.yml` it will add
- the check name it expects that file to produce (`tests`)
- the protection changes, computed as if `tests` and the two verdict checks
  were already seen
- the writes, and the confirm token

The token covers all of it, the `ci.yml` text included. Any change to the
plan gives a new token.

### 3.2 Writes, in order

1. Create the six labels (create when absent, update when present).
2. Apply the repo settings (auto merge on, squash merge allowed). This comes
   before the PR because GitHub refuses a squash merge with 405 while squash
   merge is off. It is safe to do early: the pipeline counts a repo as set up
   only when auto merge is on and the branch is protected (rule 8 in the
   `tm-kickoff` skill), and auto merge on without protection never queues a
   merge.
3. Create the branch `orchestrai/ci-setup` from the default branch head, add
   `.github/workflows/ci.yml`, and open a non-draft PR from it.
4. Wait for the PR's checks, polling every 30 seconds, for at most 20 minutes
   from the first poll. Green means: nothing failed, nothing is still running,
   and `tests` has run. Right after the PR opens there are no checks, and a
   third-party status can finish before `tests` is queued, so "no check is red"
   is not enough.
5. Check what is about to merge. The PR must change exactly one file,
   `.github/workflows/ci.yml`, added, and the file at the PR head must equal
   the planned text. The head sha is the one the poll that read green
   returned. Squash-merge pinned to that sha, so GitHub refuses with 409 if
   anyone pushes after the check, then delete the branch.
6. Read the check names that ran on the PR. They match the expected names:
   apply the protection, as Apply does today. This is the only write that waits
   for the merge, because it requires `tests`, which no PR can pass until the
   workflow is on the default branch.

### 3.3 Stops

The run stops at the first of these and writes nothing after it:

- A check fails, or 20 minutes pass. The PR stays open. The output names it.
  Exit 1.
- Before the merge, the PR holds more than the planned file, or the file
  differs. The PR stays open. Exit 2.
- During the wait, before the merge, the open PR turns into a draft, its base
  changes, or a second open PR from `orchestrai/ci-setup` appears. The PR
  stays open. Exit 2.
- After the merge, `ci.yml` is not on the default branch, for example because
  the PR was retargeted just before the merge. No protection is written, since
  it would require `tests` where no workflow exists. The run says "stopped
  here". Exit 1.
- After the merge, the repo now requires signed commits and a protection write
  is left. The protection PUT can reset that setting and `required_signatures`
  is not part of the PUT body, so the comparison below cannot see it. The run
  refuses, as the plan does, and says "stopped here". No new token. Exit 2.
- After the merge, the check names that ran differ from the expected ones, or
  the repo changed during the wait. The run prints a new plan with a new token
  and the owner confirms again. Exit 2. The check is a comparison of the
  protection write the plan showed with the one the merged state calls for, so
  a plan that had no protection write is compared the same way.
- Any write fails, or a read after the first write fails. Exit 1. The output
  says "stopped here" and lists what was written. One exception: a delete of
  the `orchestrai/ci-setup` branch that GitHub answers with 422 "Reference
  does not exist" counts as done, because "Automatically delete head
  branches" may have removed it first. A 404 still stops.

A PR from `orchestrai/ci-setup` counts as CI only once it is merged. Without
that rule a red or timed-out CI PR would make the repo read as having CI, and
the next Apply would require `tests` while the workflow exists only on the
unmerged branch (#561).

A later `apply` on the same repo resumes where the last run stopped, and the
plan says so. It finds an open PR from `orchestrai/ci-setup`, or else the
branch with or without the file, and skips the writes already done. Open PR,
branch and file are read the same way in plan and confirm mode, and what they
find is part of the confirm token. Before it trusts an open PR it runs the
check from step 5. A branch whose file differs from the plan is refused, and
the message says to delete the branch.

### 3.4 Refusals that stay

- The repo already has a file under `.github/workflows/`, but no finished,
  non-draft PR has run it. The guard does not add a second CI next to an
  existing one. It refuses, and the message says to open or finish a PR so
  the existing workflow runs.
- Blocked repos (no branch protection on the plan) and repos not owned by
  the owner's account, as today.

## 4. Stack detection

The guard reads root files through the API, as it already reads the file
tree to count tests.

| Found at the root | Install | Test |
|---|---|---|
| `package.json` with a real `test` script and `package-lock.json` | `npm ci` | `npm test` |
| the same with `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | `pnpm test` |
| the same with `yarn.lock` | `yarn install --frozen-lockfile` | `yarn test` |
| the same with no lockfile | `npm install` | `npm test` |
| `requirements.txt` | `pip install -r requirements.txt` | `pytest` |
| `pyproject.toml` without `requirements.txt` | `pip install -e .` | `pytest` |
| `go.mod` | none | `go test ./...` |

npm's default script (`echo "Error: no test specified" && exit 1`) is not a
real test script.

The runtime version comes from `.nvmrc`, `.python-version` or the `go`
line in `go.mod`. Without one, the current LTS (Node), 3.12 (Python) or
`stable` (Go).

Detection fails when no row fits, when more than one row fits, or when test
files sit only under subfolders that carry their own `package.json`,
`pyproject.toml` or `go.mod`. The plan then names what it found, prints no
token, and exits 2. The skill asks the owner for the two commands and runs
the plan again with `--install "<cmd>" --test "<cmd>"`. Given commands skip
detection. The job then has no runtime setup step and relies on the
runtimes preinstalled on `ubuntu-latest`.

## 5. The generated `ci.yml`

One job, named `tests`, so the required check is `tests`.

- `on`: `pull_request` (opened, synchronize, reopened, ready_for_review)
  and `push` to the default branch.
- `concurrency` group per workflow and ref, `cancel-in-progress: true`.
- `timeout-minutes: 10`.
- Steps: checkout, runtime setup for the detected stack, install, test.

Two deliberate differences from the reference template:

- No `paths-ignore`. A required check that `paths-ignore` skips reports
  "Expected" and never completes, so a docs-only PR could never merge. This
  check becomes required in the same run.
- No typecheck, lint, build or e2e jobs. An `echo` placeholder passes every
  time and would look like a real check. Those jobs come later, through a
  normal PR in that repo.

## 6. Write fence

`repo-guard.mjs` today allows exactly two writes, each validated by
`writeGuarded()`: the branch protection PUT and the repo PATCH. This design
widens the fence. Each new write is allowed only in this narrow shape:

- label create or update: only the six names above
- create a ref: only `refs/heads/orchestrai/ci-setup`
- put a file: only `.github/workflows/ci.yml`, only on that branch, only
  with the exact text the plan showed
- open a PR: only head `orchestrai/ci-setup` into the default branch
- merge: only a PR whose head is `orchestrai/ci-setup`, squash only
- delete a ref: only `refs/heads/orchestrai/ci-setup`

The read guard is not loosened. The guard now writes into a repo's code, not
only its settings. The owner accepted that on 2026-11-12.

## 7. Removing `tm-new-project`

- Delete `.claude/skills/tm-new-project/SKILL.md` and
  `.claude/workflows/__tests__/new-project-guard.test.mjs`.
- Move `templates/ci.yml` to `.claude/skills/tm-repo-guard/templates/ci.yml`.
  It stays the worked example of the CI cost policy. Update the pointer in
  `.claude/process-core.md` and the path in `ci-template-policy.test.mjs`.
- Add a test that pins the cost rules (timeout, concurrency, no
  `paths-ignore`) on the generated `ci.yml`.
- `NEW-PROJECT-SETUP.md`: drop the guided-flow pointer. The labels and CI
  sections point to `/tm-repo-guard apply`. The plugin and design-plugin
  notes stay.
- Update the README, `docs/team-guide-rationale.md`,
  `docs/architecture/operating-model.md` (a dated note that the owner
  reopened issue #190's decision, and why), and section 6 of the
  autonomous-runs design.
- `.claude/skills/tm-repo-guard/SKILL.md`: add the "ask for the commands"
  step, and run the confirm step in the background, since the 20-minute wait
  is longer than one shell call may take.

## 8. Work packages

All filed in orchestrai.

| # | Package | Issue | Size | Blocked by |
|---|---------|-------|------|------------|
| 1 | Plan: stack detection, generated `ci.yml`, `--install`/`--test`, expected check name. Reads only. | #551 | M | none |
| 2 | Apply: create the six labels, fence for label writes | #552 | S | none |
| 3 | Fence and check rules for the CI setup PR: the five CI writes, `ciCheckState`, the unmerged-PR rule | #561 | M | none |
| 4 | Apply: CI PR run (labels and PATCH first, branch, file, PR, wait, merge, protect, resume, stops) | #554 | M | #551, #552, #561 |
| 5 | Remove `tm-new-project`: skill, template move, docs, tests | #555 | M | #554 |
| 6 | Check the `gh` version up front: print "gh 2.48 or newer needed" instead of a usage dump | #553 | S | none |

## 9. Open points

- The script reads labels with `gh api --paginate --slurp`, which needs `gh`
  2.48 or newer. On older `gh` every Apply fails to read
  (seen 2026-11-12 with Ubuntu's `gh` 2.45). Package 6 turns that into a
  clear version message. The owner approved it as its own package.
- Monorepos with tests in more than one stack (for example rainmaker-bot's
  `dashboard/` and Python) fall back to owner-given commands in one job. A
  job per stack is not in scope (owner confirmed 2026-11-12).
