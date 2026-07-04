# Operating model

Status: living policy decision, locked unless explicitly revisited. Not dated.

## 1. What orchestrai is (identity)

orchestrai is a personal AI-team-orchestrator plugin, applied across the
user's own repos. It is not a template for spinning up new, unrelated
projects. This decision supersedes the template framing that shaped earlier
work in this repo.

The plugin exists for five purposes:

1. Get AI advice on a topic and file the resulting work as issues.
2. Turn that work into PRs that get merged.
3. Produce research and docs to support any piece of work or any decision.
4. Dispatch work to agents that cross-check each other, for the best
   achievable result.
5. Offer a portable structure the user can apply across any of their repos.

The plugin is the primary identity. Template-scaffolding is demoted to a
secondary capability, and its leftover framing (in CLAUDE.md,
`NEW-PROJECT-SETUP.md`, and `tm-new-project`) still exists in the tree and is
reconciled in Batch 2, not by this doc. See section 3.

## 2. How it operates (the loop, summary altitude)

The loop turns a topic into merged, verified work. Each stage below owns no
detail here; follow the link for the mechanics, caps, and numbers.

**Intake, advice, sign-off.** A raw need becomes a signed-off batch of work
packages before anything is filed. Owned by
`.claude/skills/tm-advisor/SKILL.md` and
`docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`.

**Refine to sized, filed issues.** Signed-off packages become GitHub issues,
sized and stress-tested. Owned by `.claude/team-guide.md` ("Issues and
branches", "Sizing"), `/tm-grill-me`, and `/tm-to-issues`.

**Flat-star pipeline.** Each issue runs through architect, developer, tester,
reviewer, with a fact-checker on demand, to a mergeable PR. Owned by
`docs/team-architecture.md` and `.claude/skills/tm-kickoff/SKILL.md`.

**Agents cross-check.** Every role is read-only or independently verifying
except the developer, so no single agent's claim goes unchecked. Owned by
`.claude/agents/` and the "Agent team" section of `.claude/team-guide.md`.

**Model policy.** Judgment seats and worker seats run different models by
design. Owned by the "Model policy" section of `.claude/team-guide.md`;
this doc does not re-derive that argument.

**Research and docs.** Any work or decision can produce a research doc, a
codebase map, or a review, as a first-class output of the loop, not a
side effect. Owned by `.claude/workflows/` (`tm-map-codebase.js`,
`tm-review-changes.js`, `tm-review-codebase.js`) and the `docs/` layout in
`CLAUDE.md`.

## 3. Reconciliation: leftover template framing (Batch 2)

This doc records the identity decision. It makes no edits to the files
below; reconciling them is explicit, deferred follow-up for Batch 2:

- `CLAUDE.md`'s three placeholder sentinels (the project-description
  paragraph, the "Code style" placeholder line, and the "(see
  NEW-PROJECT-SETUP)" pointers in the repo-layout section).
- `NEW-PROJECT-SETUP.md`.
- `.claude/skills/tm-new-project/SKILL.md`.

None of these files are touched by this change.
