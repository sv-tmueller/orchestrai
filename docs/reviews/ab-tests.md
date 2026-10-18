# A/B test ledger

Accumulation point for `/tm-ab-test` runs. Each report under
`docs/reviews/YYYY-MM-DD-ab-<task-slug>.md` is immutable once written; this
ledger appends one row per run and never edits a past one.

| Date | Task | Arms | Headline numbers | Report |
| --- | --- | --- | --- | --- |
| 2026-07-13 | #255 plan-status block parser and renderer | A: kickoff-pipeline (headless), B: developer-dispatch (headless) | A: 15m23s, lead+4, 17.4k out tokens ($7.55), +350, review approve; B: 6m12s, lead+1, 4.3k out tokens ($1.80), +517, review changes-requested (1 must-fix) | [2026-07-13-ab-plan-status-parser](2026-07-13-ab-plan-status-parser.md) |
| 2026-07-27 | #286 Opus 5 vs Fable 5 in the judgment seats (reviewer on PR #285, architect on a #224 copy) | A: fable (headless), B: opus (headless) | A: 6m25s, 2 agents, 99.2k tokens, review approve (1 nit), full sub-plan; B: 8m49s, 2 agents, 127.0k tokens, review changes-requested (1 must-fix, 2 should-fix), NEEDS_DECISION with data-absence proof | [2026-07-27-ab-judgment-seats](2026-07-27-ab-judgment-seats.md) |
| 2026-09-28 | #400 (replaying #362) A/B native plan-and-execute vs the kickoff pipeline, both arms headless | A: kickoff-pipeline (headless), B: native plan-approve-execute-review-fix (headless) | A: 32m37s, 7 agents, $4.72 est./$6.29 CLI cost on actual tokens (list price), PR #413 ready, 382/382 tests, pass-1 review approve; B: 21m50s, 1 agent, $2.94 est./$4.46 CLI cost on actual tokens (list price), PR #414 draft, 399/399 tests, pass-1 review approve; quality comparable (Q1=Q2=0 both, descriptive, not a verdict); R 0.62, R(actual) 0.71, adjusted R 0.88, all in the 0.5-2 band, native cheaper on every measure; INCONCLUSIVE (insufficient pairs), one pair only | [2026-09-28-ab-native-vs-kickoff](2026-09-28-ab-native-vs-kickoff.md) |
