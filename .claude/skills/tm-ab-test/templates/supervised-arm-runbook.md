# Supervised-arm runbook

For any arm whose mode is `supervised` (a session-level setting the skill
cannot turn on for itself, for example ultracode or a non-default effort
level). The skill emits this runbook and stops; a human runs the arm, per
appendix step 4 of `docs/reviews/2026-06-30-orchestration-comparison.md`.

## Before you start

- [ ] Confirm the base commit recorded for this A/B run:
      `<base-commit>` (`git fetch origin`, then `git rev-parse origin/main`
      at fork time). This arm must fork from the same commit as every
      other arm.
- [ ] Open a fresh session. Do not reuse the session that ran (or will run)
      any other arm; a shared session carries context across arms and
      contaminates the comparison.
- [ ] Work in this arm's own worktree, forked from the base commit above.
      Do not reuse another arm's worktree.
- [ ] Turn on the session-level setting this arm tests (for example
      `ultracode`, or a specific `/effort` level) before doing any task
      work. Confirm it is active before proceeding.

## During the run

- [ ] Record the start timestamp (ISO) the moment you begin task work.
- [ ] Work the task to completion in this session, using the setting from
      the previous step throughout. Do not switch it off mid-run.
- [ ] Record the end timestamp (ISO) when the task is done (PR opened,
      or the arm's stopping point reached).

## After the run

- [ ] Fill in `templates/recording-checklist.md` for this arm: base commit,
      window, token usage, agent/subagent count, diff size, the
      `tm-review-changes` pass, and any acceptance-criteria drift.
- [ ] Report status as "run supervised" in `templates/report.md`.
- [ ] Hand the filled checklist back to the lead session for the report and
      ledger entry.
