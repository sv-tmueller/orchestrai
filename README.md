# claude-template

A starting `CLAUDE.md` and a bootstrap checklist for new projects.

- `CLAUDE.md` - copy into a new repo's root and fill in the placeholders. Standing
  guidance for Claude Code sessions: what the repo is, where decisions live, the
  issue -> branch -> PR -> main workflow, sub-plan checkpoints, TDD and e2e,
  writing style, and workflow defaults.
- `NEW-PROJECT-SETUP.md` - the once-per-repo checklist: branch protection, docs
  structure, CI/CD and e2e wiring, and filling in the `CLAUDE.md` placeholders.
- `.claude/settings.json` - notification "pling" hooks (`Notification` and
  `Stop`). macOS only (`afplay`); the command no-ops elsewhere. Delete the file
  to opt out.

Generalized from two project `CLAUDE.md` files (a Python advisory bot and a
TypeScript web app), keeping the shared backbone and dropping the project
specifics.

The four global coding principles live in `~/.claude/CLAUDE.md` and apply to
every project; this template references them rather than repeating them.

## Using it

```bash
cp claude-template/CLAUDE.md <new-repo>/CLAUDE.md
# then work through NEW-PROJECT-SETUP.md
```
