# claude-template

A starting `CLAUDE.md` and a bootstrap checklist for new projects.

- `CLAUDE.md` - copy into a new repo's root and fill in the placeholders. Standing
  guidance for Claude Code sessions: what the repo is, where decisions live, the
  issue -> branch -> PR -> main workflow, sub-plan checkpoints, TDD and e2e,
  writing style, and workflow defaults.
- `NEW-PROJECT-SETUP.md` - the once-per-repo checklist: branch protection, docs
  structure, CI/CD and e2e wiring, and filling in the `CLAUDE.md` placeholders.

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

## License

**Copyright © 2026 Thomas Mueller. All rights reserved.**

This source code is published for demonstration and portfolio purposes only. No license is granted to use, copy, modify, merge, publish, distribute, sublicense, or sell any part of this software, in whole or in part, in any other project — public or private — without prior written permission from the copyright holder.

Unauthorized reuse of any portion of this code constitutes copyright infringement and will be pursued accordingly.
