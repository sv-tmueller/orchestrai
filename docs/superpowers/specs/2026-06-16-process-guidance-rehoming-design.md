# Process guidance moves user-global; tm-sync-template is deprecated

Resolves the brainstorm in claude-template#102.

## Context

The team (agents, `tm-*` skills, review workflows) is now delivered user-global
by `/tm-install-team` into each config dir (`~/.claude-personal`,
`~/.claude-work`). The committed team has been reverted from the personal
consuming repos. That leaves two open questions:

1. `tm-sync-template`'s machinery-sync role is obsolete and would re-pollute the
   reverted repos. What happens to the skill?
2. The template's process guidance (agent team, advisor model, model policy,
   sizing, the issues/branches/commits conventions) currently lives in each
   repo's `CLAUDE.md`, synced per-repo. In the user-global model, where should it
   live?

## Verified fact (the hinge)

A `<config-dir>/CLAUDE.md` loads as user-global instructions in every session run
under that config dir. Confirmed empirically: under the `claude-personal` alias
(`CLAUDE_CONFIG_DIR=~/.claude-personal`), a sentinel written to
`~/.claude-personal/CLAUDE.md` appeared in a headless session's loaded
instructions. The official docs do not state this (they hardcode
`~/.claude/CLAUDE.md` for user memory and note only that `CLAUDE_CONFIG_DIR`
bypasses everything under `~/.claude`), so it was tested, not assumed.

Consequence found in the same test: `CLAUDE_CONFIG_DIR` relocates the user
CLAUDE.md, it does not stack on top of `~/.claude/CLAUDE.md`. With a config-dir
CLAUDE.md present, the four personal coding principles in `~/.claude/CLAUDE.md`
did not load. They reach alias sessions today only because no config-dir
CLAUDE.md exists yet (a fallback). Creating one ends that fallback, so the
config-dir CLAUDE.md must carry or import those principles.

## Decisions

### 1. Process guidance moves user-global

The generic process guidance moves out of per-repo CLAUDE.md and into a single
source, `.claude/team-guide.md`, shipped user-global by `tm-install-team` into
each config dir. Documentation lives where the thing it describes lives: the
machinery is user-global, so the guidance that describes it is too.

What moves: agent team, advisor operating model, model policy, sizing,
sub-plans, the issues/branches/commits/tests conventions, how-to-pick-up-a-task,
what-not-to-do, and the parts of repo-layout that describe the team.

What stays per-repo in each consuming repo's CLAUDE.md: what the project is,
useful commands, code style, and pointers to that repo's architecture and
operations docs.

The drift on the reverted repos (their CLAUDE.md still describes `.claude/agents`
and the like that the revert removed) then resolves by design: each consuming
CLAUDE.md shrinks to project specifics and no longer overstates the repo.

### 2. The template repo keeps the full guidance

`claude-template` is the source of truth where the team is built. User-global
means distributed, not stripped from here. The template repo's own `CLAUDE.md`
keeps the full guidance by sourcing it from the same single source: it
`@import`s `.claude/team-guide.md`. This dogfoods the guide (the template repo's
own sessions load it the same way every other repo will) and keeps one copy of
the generic content, not two.

### 3. Delivery: a file install-team owns, plus one import line

`tm-install-team` copies `.claude/team-guide.md` to `<config-dir>/team-guide.md`
(a managed deploy copy it owns, safe to overwrite on update, same conflict
handling as the rest of the team) and instructs the user to add a single
`@team-guide.md` import line to `<config-dir>/CLAUDE.md`. It does not edit the
user's CLAUDE.md itself, mirroring how it detects-and-instructs for superpowers
rather than mutating `settings.json`. The user's `<config-dir>/CLAUDE.md` then
imports both their own principles and the team guide, so introducing it shadows
nothing silently.

Rejected: a delimited managed block written straight into
`<config-dir>/CLAUDE.md` (mutates a user-owned doc, and the user must hand-place
their principles around it). Rejected: print-and-paste (drifts on every update,
pure manual toil).

### 4. tm-sync-template is deprecated

Its three jobs are gone or trivial: machinery sync is obsolete and re-pollutes
reverted repos; the Section 3 self-bootstrap is obsolete (`tm-install-team`
manages the user-global team); prose-delta sync is obsolete (per-repo CLAUDE.md
is project-specific now, the template has no generic prose to push into it). The
only residual job, GitHub label creation, moves to where the team first needs it
(decision 5).

`tm-install-team` currently installs `.claude/skills/tm-*`, which includes
`tm-sync-template`, so it is being pushed user-global right now. Deprecation
excludes it from that glob (it never belonged there; it targets a repo, not a
config dir). Existing user-global copies in the config dirs need a one-time
manual removal; the skill change notes this.

Deprecation subsumes the Section 3 cleanup noted in #102: the skill is gone, so
the self-bootstrap step goes with it.

### 5. Label creation folds into kickoff and advisor

An idempotent ensure-labels step (`gh label create` for size:S/M/L/XL,
in-progress, needs-human, ignore-if-exists) runs at the start of `/tm-kickoff`
and `/tm-advisor`. Labels are created in the repo exactly when the team first
needs them. No standalone skill to remember.

## Out of scope

Shrinking the four reverted repos' CLAUDE.md to project specifics is per-repo
work in external repos (rainmaker-bot, fixum-budget, korveth-space, trading-bot),
not a change to this template. It is a separate dependent batch, run after this
lands and `team-guide.md` reaches those environments.

## Verification

- The load fact is already confirmed (see above); re-confirm after delivery that
  a real alias session loads `team-guide.md` via the `@import`.
- `tm-install-team` dry run against a temp dir: `team-guide.md` lands, a re-run
  skips it as identical, an edited copy is reported as a conflict.
- Skill frontmatter for edited skills still registers (quoted string fields).
- The `gh label create` step is idempotent: running it twice creates no
  duplicates and errors on nothing.
