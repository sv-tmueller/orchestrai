# New-project setup

Run once when adopting the orchestrai plugin into an existing repo.

**Type `/tm-setup` in the repo.** It does the automatable part and is safe to
re-run (`.claude/skills/tm-setup/SKILL.md`):

1. Creates the six flow labels: `size:S`, `size:M`, `size:L`, `size:XL`,
   `in-progress`, `needs-human`.
2. Checks that the orchestrai and superpowers plugins are installed and
   enabled, and prints the `/plugin` commands to type for any that are not.
   It never installs a plugin or writes settings.
3. Adds the missing `docs/` folders on a branch with a PR.
4. Sets the merge rule through `/tm-repo-guard apply`, after you confirm.
5. Reports what it did and what is left.

The rest of this file is what `/tm-setup` leaves to you, and the by-hand
fallback.

## Manual items

- [ ] Install the plugins if `/tm-setup` printed commands for them. The
      superpowers dependency is normally prompted by `.claude/settings.json`;
      if no prompt appears (a known gap,
      https://github.com/anthropics/claude-code/issues/32606), run the
      printed commands.
- [ ] Check the agent team is loaded: `/agents` should list architect,
      developer, and reviewer. Check `/skills` lists tm-advisor, tm-kickoff,
      tm-grill-me, tm-repo-guard, and tm-setup.
- [ ] (Optional) Create the labels you will filter on, e.g. `type:feat`,
      `type:fix`. The flow itself uses only the six above
      (`docs/architecture/light-flow.md`).
- [ ] (Optional) If this project builds UI, enable the design plugins. They are
      not on by default, so adoption stays generic and free of third-party
      defaults. Add each to `.claude/settings.json` under `enabledPlugins` and
      install it:
      - `frontend-design@claude-plugins-official` (distinctive frontend UI;
        official marketplace, like superpowers):
        `/plugin install frontend-design@claude-plugins-official`.
      - `ui-ux-pro-max@ui-ux-pro-max-skill` (UI/UX design intelligence: styles,
        palettes, font pairings). Third-party, from
        `nextlevelbuilder/ui-ux-pro-max-skill`: add the marketplace
        (`/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`), then
        `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`.
      - `impeccable@impeccable` (frontend interface design and critique).
        Third-party, from `pbakaus/impeccable`: add the marketplace
        (`/plugin marketplace add pbakaus/impeccable`), then
        `/plugin install impeccable@impeccable`.
      Vet the two third-party plugins before enabling them in a project others
      build on; their install steps live in their repos and may change.
- [ ] Add the first architecture note under `docs/architecture/` (stack and
      policy choices).
- [ ] Decide the e2e approach for this app and scaffold `e2e/`.
- [ ] Where the repo has tests but no CI, the merge-rule step adds it (one
      `tests` job), on the same yes. For a fuller pipeline, start from
      `.claude/skills/tm-repo-guard/templates/ci.yml` and keep its cost
      controls: pinned `timeout-minutes` on every job, a `concurrency` group
      with `cancel-in-progress: true`, and e2e/build skipped on draft PRs.
- [ ] If you deploy, make e2e a pre-deploy gate.

## By hand: merge rule

Only if `/tm-repo-guard apply` refuses the repo as not your own (an
organization repo, or one owned by another account). Protect `main` in the
repo's GitHub settings instead: block direct pushes, require a PR, require
status checks to pass before merge, and make the relevant CI jobs required
status checks. A private repo on a plan without branch protection is blocked
either way.

## First slice of work

- [ ] Brainstorm the first design via `superpowers:brainstorming`; save the spec to
      `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- [ ] File the first issues (`gh issue create`), sized, with `Blocked by: #N`
      lines for dependencies.
- [ ] For a single issue: make sure its body has an `## Approach` section (the
      plan), branch, and open a draft PR (`Closes #N`).
- [ ] For a batch of refined issues: run `/tm-kickoff` (see team-guide.md "Agent team").
