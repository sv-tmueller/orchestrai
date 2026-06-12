# claude-template

A starting point for new projects: a `CLAUDE.md`, a bootstrap checklist, and a
ready-made agent team for Claude Code.

- `CLAUDE.md` - standing guidance for Claude Code sessions: what the repo is,
  where decisions live, the issue -> branch -> PR -> main workflow, sub-plan
  checkpoints, TDD and e2e, writing style, workflow defaults, and the agent
  team.
- `NEW-PROJECT-SETUP.md` - the once-per-repo checklist: branch protection,
  docs structure, CI/CD and e2e wiring, labels, and filling in the `CLAUDE.md`
  placeholders.
- `.claude/agents/` - four role agents: architect (approach, read-only),
  developer (one issue end to end, worktree-isolated), tester (independent
  verification, read-only), reviewer (spec pass then quality pass, read-only).
- `.claude/skills/kickoff/` - `/kickoff`: fans refined, sized issues out to
  the agent team in parallel waves, through implement, test, and review, to a
  ready PR per issue.
- `.claude/skills/grill-me/` - `/grill-me`: stress-tests a plan one question
  at a time before kickoff (from mattpocock/skills, MIT).
- `.claude/skills/to-issues/` - `/to-issues`: turns an approved plan into
  sized, dependency-ordered issues ready for `/kickoff` (adapted from
  mattpocock/skills, MIT).
- `.claude/settings.json` - enables obra's superpowers plugin per project
  (`superpowers@claude-plugins-official`; the methodology skills:
  brainstorming, writing-plans, TDD, verification).

Generalized from two project `CLAUDE.md` files (a Python advisory bot and a
TypeScript web app), keeping the shared backbone and dropping the project
specifics.

The four global coding principles live in `~/.claude/CLAUDE.md` and apply to
every project; this template references them rather than repeating them.

## Using it

Use it as a GitHub template repo, or copy the whole tree including `.claude/`:

```bash
gh repo create <new-repo> --template sv-tmueller/claude-template --private --clone
# then work through NEW-PROJECT-SETUP.md
```

Copying only `CLAUDE.md` works but does not carry the agents and skills.

## License

**Copyright © 2026 Thomas Mueller. All rights reserved.**

This source code is published for demonstration and portfolio purposes only. No license is granted to use, copy, modify, merge, publish, distribute, sublicense, or sell any part of this software, in whole or in part, in any other project — public or private — without prior written permission from the copyright holder.

Unauthorized reuse of any portion of this code constitutes copyright infringement and will be pursued accordingly.
