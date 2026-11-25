# New-project setup

Run once when adopting the orchestrai plugin into an existing repo.

The one command that sets a repo up is `/tm-repo-guard apply <owner>/<name>`
(section 5). After the plugin is installed (section 2), it creates the six
labels, adds CI where the repo has tests but none, and protects the default
branch. Sections 1 and 5 are what Apply covers. Sections 2, 3, 4 and 6 are
by hand.

## 1. Labels

- [ ] The workflow uses six labels: the sizing set `size:S`, `size:M`,
      `size:L`, `size:XL` (see process-core.md "Sizing") plus `in-progress`
      and `needs-human` (see team-guide.md "Agent team").
      `/tm-repo-guard apply` creates or fixes all six on every repo, so you do
      not create them by hand. Apply requires `orchestrai/review` once they
      exist, and it counts them as present in the same run. `/tm-kickoff` and
      `/tm-advisor` also create them on first run, including `/tm-advisor`
      (file only).
- [ ] (Optional) Create the labels you will filter on, e.g. `type:feat`,
      `type:fix`. The flow itself uses only the six above
      (`docs/architecture/light-flow.md`).

## 2. Claude Code

- [ ] Install the orchestrai plugin via the marketplace (see the README's
      "Getting the team into your repos"):
      `/plugin marketplace add sv-tmueller/orchestrai`, then
      `/plugin install orchestrai@orchestrai`. It depends on the superpowers
      plugin: accept the prompt that `.claude/settings.json` triggers, or if
      no prompt appears (a known gap,
      https://github.com/anthropics/claude-code/issues/32606), run
      `/plugin marketplace add anthropics/claude-plugins-official`, then
      `/plugin install superpowers@claude-plugins-official`.
- [ ] Check the agent team is loaded: `/agents` should list architect,
      developer, and reviewer.
- [ ] Check the skills are registered: `/skills` should list tm-advisor,
      tm-kickoff, tm-grill-me, and tm-repo-guard.
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

## 3. Docs structure

- [ ] Create the docs tree:
  ```
  docs/architecture/
  docs/operations/
  docs/plans/
  docs/reviews/
  docs/superpowers/specs/
  ```
- [ ] Add the first architecture note under `docs/architecture/` (stack and policy
      choices).

## 4. Tests and CI/CD

- [ ] Decide the e2e approach for this app and scaffold `e2e/`.
- [ ] Where the repo has tests but no CI, section 5's Apply adds it (one
      `tests` job), on the same yes. For a fuller pipeline, start from
      `.claude/skills/tm-repo-guard/templates/ci.yml` and keep its cost
      controls: pinned `timeout-minutes` on every job, a `concurrency` group
      with `cancel-in-progress: true`, and e2e/build skipped on draft PRs.
- [ ] If you deploy, make e2e a pre-deploy gate.

## 5. Merge rule

- [ ] Type `/tm-repo-guard apply <owner>/<name>` with this repo's full name.
      It shows the changes and asks before it writes. It creates the six
      labels from section 1, and requires every check that ran on the newest
      finished PR plus `orchestrai/review`. It never requires an up to date
      branch.
- [ ] If Apply refuses the repo as not your own (an organization repo, or one
      owned by another account), protect `main` by hand in the repo's GitHub
      settings instead: block direct pushes, require a PR, require status
      checks to pass before merge, and make the relevant CI jobs required
      status checks. A private repo on a plan without branch protection is
      blocked either way.

## 6. First slice of work

- [ ] Brainstorm the first design via `superpowers:brainstorming`; save the spec to
      `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- [ ] File the first issues (`gh issue create`), sized, with `Blocked by: #N`
      lines for dependencies.
- [ ] For a single issue: make sure its body has an `## Approach` section (the
      plan), branch, and open a draft PR (`Closes #N`).
- [ ] For a batch of refined issues: run `/tm-kickoff` (see team-guide.md "Agent team").
