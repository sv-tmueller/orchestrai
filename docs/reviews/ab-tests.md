# A/B test ledger

Accumulation point for `/tm-ab-test` runs. Each report under
`docs/reviews/YYYY-MM-DD-ab-<task-slug>.md` is immutable once written; this
ledger appends one row per run and never edits a past one.

| Date | Task | Arms | Headline numbers | Report |
| --- | --- | --- | --- | --- |
| 2026-07-13 | #255 plan-status block parser and renderer | A: kickoff-pipeline (headless), B: developer-dispatch (headless) | A: 15m23s, lead+4, 17.4k out tokens ($7.55), +350, review approve; B: 6m12s, lead+1, 4.3k out tokens ($1.80), +517, review changes-requested (1 must-fix) | [2026-07-13-ab-plan-status-parser](2026-07-13-ab-plan-status-parser.md) |
