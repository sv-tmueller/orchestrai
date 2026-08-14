# SQLite as durable state: evaluation

Date: 2026-08-14
Status: decision record. Recommends outcome B (supplemental index, not
replacement). Resolves issue #312.

## 1. The question

Should a SQLite database replace or supplement the current durable-state
strategy (Markdown files in docs/ plus GitHub issues/PRs/comments/labels)?
The current strategy stores state in three places:

1. GitHub issues and PRs (the durable state a dropped session resumes
   from: sub-plan comments, verdict comments, labels, batch tracking
   issues).
2. Markdown files under docs/ (plans, reviews, specs, architecture
   decisions, research, codebase maps).
3. The lead session's chat context (ephemeral, lost on disconnect).

A community discussion (Reddit, 2026-08-14) claimed SQLite beats
Markdown for keyword/full-text search, relational joins, compounding
agent memory, and fast precedent lookup. This evaluation measures that
claim against this repo's constraints, not against the poster's.

## 2. Recommendation: B (supplemental index)

Adopt SQLite as a supplemental index, not a replacement. Keep GitHub as
the durable state and Markdown as the human-readable docs. Maintain a
SQLite index, regeneratable from the repo, for fast agent queries.

Rationale in one sentence: the current approach already solves
durability, resumability, and collaboration; SQLite adds query speed
and structured joins that ripgrep and `gh search` approximate but do not
match, and it can do so without weakening the strengths already in
place, as long as it stays a derived index rather than a source of
truth.

Sections 3 through 9 evaluate the seven dimensions. Section 10 gives
the prototype schema and sample query. Section 11 analyzes the
interaction with issue #311's portability goal.

## 3. Dimension 1: searchability

Claim: SQLite FTS5 beats ripgrep over docs/ and `gh issue search` for
finding past decisions ("why did we choose X").

Measured today:

- ripgrep over docs/ (27 files, 448K): 15 milliseconds for a keyword
  search. Effectively instant on this corpus size.
- `gh issue list --search "keyword"` (184 issues, all states): 636
  milliseconds. Network-bound, not CPU-bound.
- `gh search issues "keyword"` across all GitHub: 1.1 seconds. Broader
  but noisier (returns results from other repos).

What SQLite FTS5 would add:

- Stemming and tokenization beyond literal substring match. ripgrep
  finds "portability" but not "portable" unless you regex for it.
  FTS5 stems both to the same token.
- Ranking by relevance. ripgrep returns files in filesystem order;
  FTS5 ranks by BM25. For a 27-file corpus this rarely matters; for a
  600-document corpus it would.
- Cross-source union. A single query searches issues, PRs, specs, and
  reviews together. Today the agent runs ripgrep for docs and `gh
  search` for issues separately, then mentally merges.

What SQLite FTS5 does not add at this scale:

- Speed. 15ms ripgrep is already faster than any SQLite query that
  involves opening a database, parsing SQL, and returning rows. The
  speed advantage only appears at corpus sizes orders of magnitude
  larger than 27 files.
- Semantic search. FTS5 is keyword/token search, not embedding search.
  The agent is already a language model; it can decide search terms
  and judge relevance semantically. The structured-query advantage
  shrinks when the searcher already understands prose.

Verdict for this dimension: marginal improvement at current scale,
meaningful at 10x scale. The agent can find "why did we choose X" today
with ripgrep + `gh search` in under a second. SQLite would make that
slightly more precise (stemming, ranking) and slightly more convenient
(one query), but it does not unlock a capability the agent lacks.

## 4. Dimension 2: relational linking

Claim: SQLite's relational model enables ticket-to-ticket and
ticket-to-doc joins that Markdown cross-references cannot match.

Today, orchestrai expresses relationships textually:

- `Blocked by: #N` lines in issue bodies (parsed by tm-kickoff).
- `Closes #N` in PR descriptions.
- `Part of batch #N` in batch tracking issues.
- Freeform cross-references in Markdown prose ("see
  docs/superpowers/specs/2026-07-08-codex-readiness-design.md").

What SQLite would add:

- Transitive closure. "Find all issues blocked by #232, transitively."
  In SQL: a recursive CTE. Today: the agent reads #232's blockers, then
  each blocker's blockers, manually. For a 2-hop graph this is trivial;
  for a 5-hop graph SQL wins decisively.
- Structured joins. "Show me every spec that led to a merged PR, with
  the PR's review comments." In SQL: JOIN specs ON specs.issue_id =
  prs.closing_issue_id JOIN comments ON comments.pr_id = prs.id. Today:
  the agent runs `gh pr list --json closingIssuesReferences`, then `gh
  pr view <n> --comments` for each, and stitches the results.

What SQLite does not add:

- The relationships themselves. They have to be authored first. Whether
  they live in a `Blocked by: #N` line or a foreign-key column, someone
  (the agent or the human) has to declare them. Moving the declaration
  from prose to a schema does not reduce the authoring burden; it
  changes where the typing happens.
- Discoverability of implicit links. A spec that discusses issue #232
  in prose but does not formally reference it is invisible to a foreign
  key. ripgrep catches it; a strict FK schema misses it. The agent
  reading prose catches it too.

Verdict: moderate improvement for transitive and multi-hop queries,
which are rare in practice (most dependency chains are 1-2 hops).
Structured joins are nice but the volume is low: 184 issues, 134 PRs,
27 docs. The agent can stitch these manually without noticeable cost.

## 5. Dimension 3: resumability

Claim: moving state to SQLite weakens resumability.

This is the decisive dimension.

GitHub issues and PRs are the durability layer. A dropped session
resumes from them: the sub-plan comment, the verdict comments, the
labels, the batch tracking issue. This works because GitHub is:

- Remote and replicated. Survives a lost laptop.
- Visible to collaborators and CI. Anyone can read the state.
- Append-only in practice. Comments accumulate; history is preserved.
- Addressable by URL. A PR comment links directly to the state.

SQLite is a local file. It does not survive a lost laptop. It is not
visible to collaborators unless committed to the repo (see dimension 4)
or synced to a remote (adding infrastructure). It is not addressable by
URL.

If SQLite became the primary store, a dropped session on a different
machine could not resume: the database file would not be there. This
breaks the core resumability guarantee that the flat-star model relies
on (docs/team-architecture.md: "a dropped session resumes from GitHub
instead of restarting").

Mitigation if outcome B (supplemental): the SQLite index is
regenerated from GitHub + docs/, so losing it costs only rebuild time,
not state. GitHub remains the source of truth; SQLite is a cache.

Verdict: SQLite as primary (outcome A) weakens resumability
unacceptably. SQLite as supplement (outcome B) does not touch
resumability. This alone rules out outcome A.

## 6. Dimension 4: git trackability

Claim: a SQLite binary file degrades the PR review experience compared
to diffable Markdown.

A committed `.sqlite` file:

- Is not human-readable in a diff. `git diff` shows "Binary files
  differ." No line-level review.
- Is not diffable at the row level. You cannot see that row 42 changed
  from "rejected" to "adopted" in a PR.
- Bloats the repo if it carries full-text content. A 27-file docs
  corpus is 448K; a SQLite DB indexing the same content is comparable,
  but it grows with every issue and PR comment imported.

Options:

1. Commit the .sqlite file. Degrades review. Rejected.
2. Regenerate from source. The DB is a build artifact, not committed.
   A `make db` or `npm run build-db` script populates it from `gh`
   exports + docs/ files. The .gitignore excludes it. This is the
   standard pattern for derived indexes.
3. Commit SQL migrations + seed data. The schema is tracked; the data
   is regenerated. This is how Rails/Prisma projects handle it. More
   structure than option 2, but adds a migration framework for a
   single-user orchestrator.

Outcome B uses option 2: regenerate from source, do not commit the
binary. The build script is the reviewed artifact; the DB is ephemeral.

Verdict: committing a .sqlite binary degrades review. Regenerating it
from source avoids the problem entirely. Outcome B is compatible with
git trackability as long as the DB is a build artifact.

## 7. Dimension 5: host compatibility

Claim: requiring SQLite might exclude some AI hosts. This ties to issue
#311 (portable orchestrator).

The three target hosts from the portability design:

- Claude Code: has Bash. Can run `sqlite3`.
- Hermes Agent: has `terminal`. Can run `sqlite3`.
- OpenAI Codex: has `codex exec`. Can run `sqlite3`.
- GLM-5-2 (as a model on any host): the host it runs on determines
  tool access, not the model. If the host has shell access, SQLite
  works.

SQLite is a single-file, zero-dependency, serverless database. The
`sqlite3` binary is preinstalled on macOS (verified: 3.51.0 at
/usr/bin/sqlite3) and virtually every Linux distro. No daemon, no
network, no auth.

Risk: a lightweight host (future, not in the current target set) might
restrict shell access. But the adapter design in #311 already accounts
for varying tool access: a host without shell access would skip the
SQLite index and fall back to ripgrep + `gh search`, the same way it
falls back from the Workflow tool to an external driver. The index is
optional, not mandatory.

Verdict: SQLite is universally available across the three target hosts.
A host without shell access loses the index but retains the underlying
Markdown + GitHub state. No exclusion.

## 8. Dimension 6: indexing and query cost

Claim: the agent already does semantic search over prose, so SQLite's
structured-query advantage may not matter.

This is the strongest argument against adopting SQLite.

The agent is a language model. When it needs to find "why did we choose
X," it:

1. Picks search terms (semantic, not lexical).
2. Runs ripgrep or `gh search`.
3. Reads the results and judges relevance.

Steps 1 and 3 are things SQLite does not help with. SQLite FTS5 improves
step 2 (lexical precision, ranking) but the bottleneck is steps 1 and 3:
deciding what to search for and interpreting what comes back. Those are
language-model operations, not database operations.

Where structured query does help:

- Counting. "How many issues were parked as needs-human?" Today: `gh
  issue list --label needs-human --state all | wc -l`. Equivalent in
  SQL: SELECT COUNT(*) FROM issues WHERE label = 'needs-human'. Neither
  is hard.
- Aggregation. "Average fix rounds per package." Today: read every PR's
  comments, count fix-round annotations, average. In SQL: SELECT
  AVG(fix_rounds) FROM prs. SQL wins here, but this query is rare.
- Existence checks. "Did we ever decide about X?" Today: ripgrep for X
  in docs/. If nothing comes back, `gh search issues X`. In SQL: one
  query. Marginally faster, equally reliable.

The query-cost advantage is real but narrow. It shines for aggregate
analytics over accumulated state, not for the common case ("find the
doc that explains X"), which is already fast and cheap.

Verdict: the structured-query advantage matters for analytics, not for
precedent lookup. The agent's semantic search over prose is sufficient
for the common case. SQLite adds value for aggregate queries, which are
occasional, not daily.

## 9. Dimension 7: compounding memory

Claim: 600 tickets of accumulated context that grows in value, easier
to use in a single queryable table than scattered across files.

Orchestrai accumulates context in:

- docs/architecture/ (locked decisions, 2 files)
- docs/superpowers/specs/ (approved designs, 6 files)
- docs/reviews/ (dated reviews, 9 files)
- docs/research/ (investigations, 7 files)
- docs/plans/ (implementation plans, 2 files)
- GitHub issues (184 total, all states)
- GitHub PRs (134 total, all states)

Total indexed surface: approximately 27 Markdown files plus 318 GitHub
items. This is not 600 tickets, but it is growing.

The scattering problem is real. Finding "everything we decided about
model fallback" today means:

- ripgrep docs/ for "fallback" (catches specs, reviews, research).
- `gh issue list --search "fallback"` (catches issues and PRs).
- Reading the results and stitching them together.

A single SQLite table with FTS5 would collapse this to one query. But
the stitching cost is low at 27 files: the agent reads 3-4 hits in
under a second. At 270 files the calculus changes; at 600 it flips.

The compounding-memory claim has a second component: the agent getting
better at citing precedent because it can query past work. This is
true in proportion to the volume of accumulated state. At 184 issues,
the agent can hold the issue titles in context and decide which to read
in full. At 600+, a queryable index becomes necessary, not nice-to-have.

Verdict: the compounding-memory advantage is real but volume-dependent.
At the current scale (27 docs, 184 issues) it is marginal. At 10x scale
it becomes compelling. Outcome B positions the team to gain the
advantage when the volume warrants it, without disrupting the current
workflow.

## 10. Prototype schema and sample query

If outcome B is adopted, the index schema:

```sql
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,        -- 'issue' | 'pr' | 'spec' | 'review'
                              -- | 'architecture' | 'research' | 'plan'
  source_id TEXT,              -- issue/PR number, or doc filename
  title TEXT NOT NULL,
  body TEXT NOT NULL,          -- full text for FTS
  date TEXT,                   -- ISO date of the artifact
  url TEXT,                    -- GitHub URL or repo-relative path
  labels TEXT,                 -- pipe-separated labels (issues/PRs)
  state TEXT                   -- 'open' | 'closed' | 'merged'
);

CREATE TABLE cross_refs (
  id INTEGER PRIMARY KEY,
  from_source TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_source TEXT NOT NULL,
  to_id TEXT NOT NULL,
  ref_type TEXT NOT NULL       -- 'blocks' | 'closes' | 'part_of'
                              -- | 'references' | 'supersedes'
);

CREATE VIRTUAL TABLE decisions_fts USING fts5(
  title, body, labels,
  content='decisions',
  content_rowid='id',
  tokenize='porter'
);
```

Sample query: "find past work related to this new issue."

Given a new issue titled "Evaluate SQLite as the team's durable state
backing store":

```sql
-- Full-text search for related decisions
SELECT d.source, d.source_id, d.title, d.url, bm25(decisions_fts) AS rank
FROM decisions_fts
JOIN decisions d ON d.rowid = decisions_fts.rowid
WHERE decisions_fts MATCH 'sqlite durable state memory'
ORDER BY rank
LIMIT 10;

-- Relational: what blocks or references this issue?
SELECT cr.from_source, cr.from_id, cr.ref_type, d.title
FROM cross_refs cr
JOIN decisions d ON d.source = cr.to_source AND d.source_id = cr.to_id
WHERE cr.to_id = '312';
```

Build script (conceptual):

```bash
#!/bin/bash
# scripts/build-db.sh - regenerate the SQLite index from the repo.
set -euo pipefail
DB="${1:-.orchestra.db}"

sqlite3 "$DB" <<'SCHEMA'
/* schema from section 10 */
SCHEMA

# Index docs/
for f in $(find docs -name '*.md' -type f); do
  title=$(head -1 "$f" | sed 's/^#\s*//')
  sqlite3 "$DB" "INSERT INTO decisions(source, source_id, title, body, url)
    VALUES ('$(echo "$f" | cut -d/ -f2)', '$f', '$title', '$(cat "$f")', '$f');"
done

# Index issues and PRs via gh
gh issue list --state all --limit 500 --json number,title,body,url,labels,state \
  --jq '.[] | @base64' | while read -r row; do
    # decode and insert each issue
    :
  done

gh pr list --state all --limit 500 --json number,title,body,url,labels,state \
  --jq '.[] | @base64' | while read -r row; do
    # decode and insert each PR
    :
  done

# Populate FTS index
sqlite3 "$DB" "INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');"

echo "Index built: $DB ($(sqlite3 "$DB" 'SELECT COUNT(*) FROM decisions') decisions)"
```

The build script is the reviewed, committed artifact. The `.db` file is
gitignored. Rebuilding takes seconds at current scale.

## 11. Interaction with issue #311 (portability)

Issue #311 targets three hosts: Claude Code, Hermes, and Codex. All
three have shell access (Bash, terminal, exec respectively), so all
can run `sqlite3`. SQLite does not exclude any target host.

The portability design's adapter model (section 3.2 of the 2026-08-14
design) separates the process layer from the adapter layer. A SQLite
index is an adapter-layer concern: it is a tool the agent uses, not a
process the team follows. A host without shell access would lose the
index but retain the process layer and the underlying Markdown + GitHub
state. The index degrades gracefully; it does not create a hard
dependency.

Conclusion: SQLite is compatible with the portability goal. It is not
a requirement (the process layer never references it), and it is not a
blocker (all target hosts support it).

## 12. Outcomes evaluated

### A. Adopt SQLite as primary state store

Rejected. Weakens resumability (section 5): a local file does not
survive a lost laptop, is not visible to collaborators, and is not
addressable by URL. Breaks the flat-star resumability model that
depends on GitHub as the durable layer.

### B. Adopt SQLite as supplemental index

Recommended. Keeps GitHub as durable state and Markdown as
human-readable docs. Adds a regeneratable SQLite index for fast agent
queries. The index is a build artifact (gitignored), not committed.
Adds a build step, but the step is cheap (seconds at current scale) and
optional (the agent falls back to ripgrep + `gh search` without it).

### C. Reject SQLite

Not recommended yet, but defensible. The current approach is
sufficient at 27 docs and 184 issues. However, rejecting outright
ignores the trajectory: the corpus is growing, and the compounding-
memory advantage (section 9) becomes compelling at 10x scale. Deferring
(option D) is more honest than rejecting (option C).

### D. Defer

Defensible if the team wants to avoid the build-step maintenance cost
until the volume warrants it. The trigger to reconsider: the docs/
corpus exceeds 100 files, or the issue count exceeds 400, or the agent
regularly spends more than one tool call stitching cross-reference
results. None of these thresholds are met today (27 docs, 184 issues).

## 13. Final recommendation

Adopt outcome B, but defer the implementation until one of these
triggers fires:

- docs/ exceeds 100 Markdown files (currently 27).
- Total issues exceed 400 (currently 184).
- The agent regularly needs multiple tool calls to stitch cross-
  reference results (transitive dependency chains deeper than 2 hops).

Until then, the current approach (Markdown + ripgrep + GitHub + 
session_search) is sufficient. The schema in section 10 and the build
script sketch are ready to implement when a trigger fires.

Record this decision and the triggers in the repo so the next session
does not re-evaluate from scratch.

## 14. What the current approach does that SQLite would not improve

- Durability and resumability. GitHub issues and PRs survive laptop
  loss, are visible to collaborators, and are addressable by URL. A
  local SQLite file does none of these.
- Human readability. Markdown is readable in a browser, a text editor,
  a GitHub diff. SQLite requires a client tool to inspect.
- Diffability and review. Markdown diffs are line-level and
  reviewable in a PR. SQLite binaries are not diffable.
- Zero infrastructure. The current approach needs no build step, no
  database engine, no regeneration script. SQLite adds a build
  dependency (even if it is a single binary).

## 15. Trigger to reopen

Implement outcome B when any of these fire:

1. docs/ corpus exceeds 100 files.
2. Total issues exceed 400.
3. The agent regularly needs 3+ tool calls to answer a "find related
   past work" question (indicating the stitching cost has exceeded the
   query benefit of a single SQLite query).

Until then, log the decision and continue with the current approach.

## 16. References

- Community discussion prompting this: Reddit, 2026-08-14 (quoted in
  issue #312)
- `docs/superpowers/specs/2026-08-14-portable-orchestrator-design.md`
  (host neutrality constraint, section 11)
- `docs/architecture/operating-model.md` (GitHub as durable state)
- `docs/team-architecture.md` (flat-star resumability via GitHub)
- Issue #311 (portable orchestrator package)
