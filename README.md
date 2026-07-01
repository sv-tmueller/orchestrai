# claude-template

A starting point for new projects: a `CLAUDE.md`, a bootstrap checklist, and a
ready-made agent team for Claude Code.

- `CLAUDE.md` - standing guidance for Claude Code sessions: what the repo is,
  where decisions live, code style, useful commands.
- `.claude/team-guide.md` - generic team process guidance (agent team, advisor
  model, model policy, sizing, the issues/branches/commits conventions,
  how-to-pick-up-a-task, what-not-to-do). Imported by the repo CLAUDE.md and
  installed user-global by `/tm-install-team`.
- `NEW-PROJECT-SETUP.md` - the once-per-repo checklist: branch protection,
  docs structure, CI/CD and e2e wiring, labels, and filling in the `CLAUDE.md`
  placeholders.
- `.claude/agents/` - four role agents: architect (approach, read-only),
  developer (one issue end to end, worktree-isolated), tester (independent
  verification, read-only), reviewer (spec pass then quality pass, read-only).
- `.claude/skills/tm-advisor/` - `/tm-advisor`: the operating model on top of the
  team. Refines a raw need into a batch of work packages, takes one sign-off,
  runs the batch uninterrupted through the kickoff pipeline, and reports.
  State lives in a batch tracking issue, so a dropped session resumes. Design:
  `docs/superpowers/specs/2026-06-12-advisor-operating-model-design.md`.
- `.claude/skills/tm-kickoff/` - `/tm-kickoff`: fans refined, sized issues out to
  the agent team in parallel waves, through implement, test, and review, to a
  ready PR per issue.
- `.claude/skills/tm-grill-me/` - `/tm-grill-me`: stress-tests a plan one question
  at a time before kickoff (from mattpocock/skills, MIT).
- `.claude/skills/tm-to-issues/` - `/tm-to-issues`: turns an approved plan into
  sized, dependency-ordered issues ready for `/tm-kickoff` (adapted from
  mattpocock/skills, MIT).
- `.claude/skills/tm-install-team/` - `/tm-install-team`: installs or updates the
  team into one or more user config dirs (`/tm-install-team ~/.claude-personal
  ~/.claude-work`), so it is available in every repo under that config without
  being committed anywhere. Copies the operational skills, agents,
  workflows, and `team-guide.md`, and checks superpowers is enabled. The user-scope path for repos
  you do not want to carry the team (an org repo).
- `.claude/workflows/` - bounded orchestration scripts. `tm-review-changes`
  reviews a diff with a fixed set of Sonnet reviewers plus one Opus critic;
  `tm-review-codebase` audits the whole repo with a Sonnet scout that splits it into
  areas (scaled to the repo, capped at a ceiling), per-area Sonnet workers, an
  architecture worker, and one Opus critic. Both pin models in-script so the cost
  is bounded by construction.
- `.claude/settings.json` - enables obra's superpowers plugin per project
  (`superpowers@claude-plugins-official`; the methodology skills:
  brainstorming, writing-plans, TDD, verification).
- `.claude-plugin/marketplace.json` - the marketplace catalog, pointing the
  `sv-tmueller` plugin at the `.claude/` root. The plugin manifest itself lives
  at `.claude/.claude-plugin/plugin.json` (see "Getting the team into your
  repos" below).

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

Copying only `CLAUDE.md` works but does not carry the agents and skills, and leaves its `@.claude/team-guide.md` import dangling.

## Getting the team into your repos

Three ways, depending on whether the team should be committed to the repo.

**User scope (recommended), nothing committed.** Install the team into your
Claude Code config dir(s) once and it is available in every repo you open under
that config, including repos you must not commit it to (an org's private repo).
From a checkout of this template:

```bash
git pull                                          # get the latest first
/tm-install-team ~/.claude-personal ~/.claude-work
```

It copies the operational skills, agents, and workflows into each
`<config-dir>/{skills,agents,workflows}/` and tells you if superpowers needs
enabling there. It also copies `team-guide.md` to `<config-dir>/team-guide.md`.
For the guide to load, add a `@team-guide.md` line to `<config-dir>/CLAUDE.md`
yourself; the install prints this and does not edit `CLAUDE.md`. Note that a
config-dir `CLAUDE.md` replaces `~/.claude/CLAUDE.md` instead of stacking with
it, so re-import the four global coding principles in the same file if you rely
on them. Re-run after a `git pull` to update. A repo that carries its own
committed team overrides the user-scope copy, so the two never clash.

**Committed in the repo.** A repo created from this template carries the team
in `.claude/`. To update it after a `git pull` on the template, copy the
updated files manually from the template checkout into the repo's `.claude/`
and open a PR.

**Plugin install, via the marketplace.** This repo is also a single-plugin
marketplace (`.claude-plugin/marketplace.json`), so any machine with Claude
Code can install the team without cloning or copying anything:

```text
/plugin marketplace add sv-tmueller/claude-template
/plugin install sv-tmueller@claude-template
```

This installs the 4 agents and all 7 skills under the `sv-tmueller` namespace,
for example `/sv-tmueller:tm-advisor` and `/sv-tmueller:tm-kickoff`. The two
review workflows (`tm-review-changes`, `tm-review-codebase`) ship as thin
wrapper skills, since a plugin does not auto-register `workflows/`.
`/sv-tmueller:tm-install-team` ships too (default-directory discovery does not
exclude it) but is a no-op outside a checkout of this template: it has
nothing to copy from.

A plugin cannot install another plugin for you: the `developer` and `tester`
agents and `tm-advisor` depend on obra's superpowers plugin, so enable it
yourself first if it is not already, the same prerequisite `/tm-install-team`
documents for the user-scope path above:

```text
/plugin marketplace add anthropics/claude-plugins-official
/plugin install superpowers@claude-plugins-official
```

## License

**Copyright © 2026 Thomas Mueller. All rights reserved.**

This source code is published for demonstration and portfolio purposes only. No license is granted to use, copy, modify, merge, publish, distribute, sublicense, or sell any part of this software, in whole or in part, in any other project (public or private) without prior written permission from the copyright holder.

Unauthorized reuse of any portion of this code constitutes copyright infringement and will be pursued accordingly.
