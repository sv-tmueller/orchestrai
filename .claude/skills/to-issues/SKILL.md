---
name: to-issues
description: Break an approved plan, spec, or design into independently implementable GitHub issues using vertical slices, sized and dependency-ordered, ready for /kickoff. Use when the user wants to convert a plan or spec into issues, create implementation tickets, or break down work.
---

Break the plan into issues that `/kickoff` can run: thin vertical slices
(tracer bullets). Each slice is a complete, verifiable path through every
layer it touches, never a horizontal layer on its own.

## Process

1. Work from the conversation context. If the user passes a reference (issue
   number, URL, or a spec under `docs/superpowers/specs/`), read it fully
   first.
2. Explore the code enough to use the project's real names, and respect the
   decisions in `docs/architecture/`.
3. Draft the slices. Each one delivers narrow but complete end-to-end
   behavior and is demoable or verifiable on its own. Prefer many thin
   slices over few thick ones.
4. Quiz the user with a numbered list: title, proposed size label, and
   `Blocked by` relationships. Ask: is the granularity right, are the
   dependencies correct, should any slice be merged or split? Iterate until
   approved.
5. Publish with `gh issue create`, blockers first, so `Blocked by: #N` lines
   reference real issue numbers. Apply the size labels.

## Issue body template

```
Blocked by: #N            (omit when unblocked)

## What to build

The end-to-end behavior of this slice, in the project's domain terms. No
file paths or code snippets; they go stale.

## Acceptance criteria

- [ ] ...
- [ ] ...
```

---

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills)
(`skills/engineering/to-issues`), MIT License, Copyright (c) 2026 Matt
Pocock. The issue-tracker plumbing is replaced with `gh`, this template's
size labels, and its `Blocked by:` convention.
