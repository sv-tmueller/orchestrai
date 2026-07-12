# Recording checklist (per arm)

Fill one copy of this checklist per arm. Every field has an exact command;
nothing here is re-derived by hand. Covers the recording dimensions from
`docs/reviews/2026-06-30-orchestration-comparison.md`'s appendix, steps 2, 5,
and 6.

## Fork point (appendix step 2)

- [ ] Base commit: `git rev-parse HEAD`, recorded before either arm starts.
      Both arms fork from this same commit.

## Arm window

- [ ] Start: ISO timestamp when the arm begins.
- [ ] End: ISO timestamp when the arm ends.

Arms run sequentially, so the windows never overlap.

## Token usage and agent count (appendix step 5)

- [ ] Run:

  ```
  node docs/research/2026-07-06-token-burn-analyze.mjs \
    --start <arm-start-ISO> --end <arm-end-ISO> \
    --project <repo-dir-substring> --json
  ```

  Use the arm window above for `--start`/`--end`, and a substring of this
  repo's working-directory name for `--project` so the script scopes to this
  project only.

- [ ] Agent or subagent count: read from the same JSON output. For a headless
      arm, cross-check it against the lead's own dispatch log for that arm's
      window; the two should agree.

## Diff size (appendix step 5)

- [ ] Run: `git diff --stat <base-commit>...<arm-branch>`

## Independent review pass (appendix step 5)

- [ ] From a checkout with the arm branch at HEAD, run:

  ```
  Workflow({ name: 'tm-review-changes', args: { base: '<base-commit>' } })
  ```

  Use the same base commit recorded above for every arm, so each review is
  scoped to that arm's own diff from the common fork point.

## Acceptance-criteria drift (appendix step 5)

- [ ] Compare the arm's result against the task's stated acceptance
      criteria. Note any criterion the arm missed, changed, or exceeded.

## Wall-clock time

- [ ] Arm end minus arm start, from the window above.

Once every field above is filled for both arms, copy them into
`templates/report.md` and append one row to `docs/reviews/ab-tests.md`.
