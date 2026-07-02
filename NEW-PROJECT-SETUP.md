# New-project setup

Run once when starting a new repo from this template. Create the repo from the
GitHub template (or copy the whole tree, including `.claude/`) and fill in the
`CLAUDE.md` placeholders as you go.

## 1. Repository and protection

- [ ] Create the repo (`gh repo create <name> --template sv-tmueller/claude-template --clone`).
- [ ] Protect `main`: block direct pushes, require a PR, require status checks to
      pass before merge.
- [ ] (Optional) Create the labels the workflow uses: the sizing set `size:S`,
      `size:M`, `size:L`, `size:XL` (see team-guide.md "Sizing") plus
      `in-progress` and `needs-human` (see team-guide.md "Agent team").
      `/tm-kickoff` and `/tm-advisor` create these six automatically on first
      run, so this step is only needed if you file sized issues (for example
      via `/tm-to-issues`) before the first kickoff or advisor run.
- [ ] (Optional) Create the labels you will filter on, e.g. `phase:0`, `phase:1`,
      `type:feat`, `type:fix`.

## 2. Claude Code

- [ ] Open the repo in Claude Code and trust the folder. Accept the superpowers
      plugin prompt that `.claude/settings.json` triggers. If no prompt appears
      (a known gap, https://github.com/anthropics/claude-code/issues/32606), run
      `/plugin install superpowers@claude-plugins-official`.
- [ ] Check the agent team is loaded: `/agents` should list architect,
      developer, tester, and reviewer.
- [ ] Check the skills are registered: `/skills` should list tm-advisor,
      tm-kickoff, tm-grill-me, tm-to-issues, and tm-install-team.
- [ ] (Optional) If this project builds UI, enable the design plugins. They are
      not on by default, so the template stays generic and free of third-party
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
- [ ] Add a CI workflow that runs typecheck, lint, unit tests, build, and e2e.
- [ ] Make the relevant CI jobs required status checks on `main`.
- [ ] If you deploy, make e2e a pre-deploy gate.

## 5. CLAUDE.md

- [ ] Fill "What this repo is" (what, who, status).
- [ ] Fill "Useful commands" with the real install/dev/test/lint/e2e commands.
- [ ] Tailor "Code style" to this project; delete the placeholder line.

## 6. First slice of work

- [ ] Brainstorm the first design via `superpowers:brainstorming`; save the spec to
      `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- [ ] File the first issues (`gh issue create`), sized, with `Blocked by: #N`
      lines for dependencies.
- [ ] For a single issue: post a short sub-plan on the issue, branch, open a
      draft PR (`Closes #N`), then expand it to a full plan in `docs/plans/`.
- [ ] For a batch of refined issues: run `/tm-kickoff` (see team-guide.md "Agent team").

## 7. Clean up

- [ ] Remove all `(see NEW-PROJECT-SETUP)` pointers from `CLAUDE.md`, in
      "Where decisions live" and "Repo layout".
- [ ] Delete this file, `NEW-PROJECT-SETUP.md`, once every box above is
      checked.
