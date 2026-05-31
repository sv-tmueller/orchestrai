# New-project setup

Run once when starting a new repo from this template. Copy `CLAUDE.md` into the
new repo's root and fill in its placeholders as you go.

## 1. Repository and protection

- [ ] Create the repo (`gh repo create`).
- [ ] Protect `main`: block direct pushes, require a PR, require status checks to
      pass before merge.
- [ ] (Optional) Create the labels you will filter on, e.g. `phase:0`, `phase:1`,
      `type:feat`, `type:fix`. Recommended regardless: the sizing set `size:S`,
      `size:M`, `size:L`, `size:XL` (see CLAUDE.md "Sizing").

## 2. Docs structure

- [ ] Create the docs tree:
  ```
  docs/architecture/
  docs/operations/
  docs/plans/
  docs/superpowers/specs/
  ```
- [ ] Add the first architecture note under `docs/architecture/` (stack and policy
      choices).

## 3. Tests and CI/CD

- [ ] Decide the e2e approach for this app and scaffold `e2e/`.
- [ ] Add a CI workflow that runs typecheck, lint, unit tests, build, and e2e.
- [ ] Make the relevant CI jobs required status checks on `main`.
- [ ] If you deploy, make e2e a pre-deploy gate.

## 4. CLAUDE.md

- [ ] Fill "What this repo is" (what, who, status).
- [ ] Fill "Useful commands" with the real install/dev/test/lint/e2e commands.
- [ ] Tailor "Code style" and "What not to do" to this project; delete the rest.
- [ ] Confirm "Workflow defaults" still match how you want to work here.

## 5. First slice of work

- [ ] Brainstorm the first design via `superpowers:brainstorming`; save the spec to
      `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- [ ] File the first issue (`gh issue create`).
- [ ] Post a short sub-plan on the issue, branch, open a draft PR (`Closes #N`),
      then expand it to a full plan in `docs/plans/`.
