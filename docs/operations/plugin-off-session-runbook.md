# Plugin-off session runbook (when the guard refuses everything)

## When to use it

Use it when a session refuses every call after a merge reached the config
dirs, and the cause is the guard (`docs/superpowers/specs/2026-11-10-autonomous-runs-design.md`,
sections 3.4 and 4.2).

- A guard that cannot run refuses with a tool error that ends in
  `blocking because onFailure is "block"`. The probe saw this in bypass mode
  (`docs/research/2026-11-11-hook-denial-in-bypass-probe.md`, rows 4a-b and
  4b-b). Other modes were not tested. The failure policy as the CLI describes
  it names no mode, so expect the same refusal in every mode.
- The guard is a plugin hook (design 4.2). Claude Code runs hooks only inside
  its own sessions, so a command typed in a plain terminal never reaches the
  guard. Every step below, apart from the session checks in steps 1 and 7, is
  a shell command: run it in the plugin-off session or in a plain terminal.
- If the guard ever ships some other way than as a plugin hook, this command
  no longer switches it off.

## The command

```sh
env claude --permission-mode manual --settings '{"enabledPlugins":{"orchestrai@orchestrai":false,"orchestrai@synced":false}}'
```

If your usual `claude` is an alias or function that sets a config dir (check
with `type claude`), use this form instead:

```sh
env CLAUDE_CONFIG_DIR=<config-dir> claude --permission-mode manual --settings '{"enabledPlugins":{"orchestrai@orchestrai":false,"orchestrai@synced":false}}'
```

- `env` runs the `claude` binary found on PATH, so a shell alias or function
  named `claude` does not apply. Run `type claude` to see whether you have
  one. If the alias sets a config dir, put `CLAUDE_CONFIG_DIR=<config-dir>`
  right after `env`.
- Never add a bypass flag. Do not put this command in an alias.
- The command changes no settings file: the checksums of `settings.json` and
  `plugins/installed_plugins.json` were the same before and after the test
  (see "What was tested"). It holds for that one session only: a control run
  started right after, without `--settings`, listed the plugin again.
- Both keys are set because the plugin can be loaded under two keys, one per
  copy (the marketplace copy and the synced copy). The seat adapter's comment
  says disabling only the first copy left the synced second copy loading
  (`.claude/adapters/claude-code-subprocess.mjs`, lines 194-195).
- Your other hooks and the CLAUDE.md rules are expected to stay on, because
  the command switches off only the two plugin keys. This was not checked.

Check the switch inside the session: type `/orchestrai:`. Nothing should be
offered. If something is offered, an orchestrai copy under another key is
still on. Find its key in `/plugin` (only read it there: switching the plugin
off in `/plugin` is expected to write a settings file), quit, add
`"<key>":false` to the JSON in the command and start again.

## Permission mode

The command names `manual`, the mode the 2.1.319 help lists. The start-up
record shows it as `default`. Neither is a mode where nobody is asked
(`bypassPermissions`, `auto` and `dontAsk`, design 4.2). The design puts the
base deny list in the guard (4.2, 4.3), so with the plugin off it is expected
to be gone too. What should remain is the GitHub rule (design 4.2), your own
permission settings and the prompts: a command your settings already allow
runs without a prompt, and other commands ask you first.

- Name the mode because a config dir's user settings can make bypass the
  default with nothing at launch (probe row 7; that the mode came from those
  settings is an inference, design 4.1), and an alias can add a bypass flag.
- One command covers both kinds of guard bug. A bug in the decision logic
  is expected to leave prompting modes alone (design 4.2). A guard that
  crashes or times out is expected to refuse in every mode (see "When to use
  it"), and then switching the plugin off is required.
- Do not use `auto`, `dontAsk` or a bypass flag in this session.
- Not known: whether `--permission-mode manual` beats a bypass default in a
  config dir's user settings. The test ran with the inherited config dir and
  shows only which mode that run reported. So step 1 checks the mode before
  the session gets any task.

## From the session to a fix

1. In the orchestrai checkout, start the session with the command above.
   Before you give it any task, check two things:
   - The switch took: `/orchestrai:` offers nothing (see "The command").
   - The mode the session shows is not bypass, `auto` or `dontAsk`. If it is,
     nothing asks you before a command runs: quit, and do the steps below in
     a plain terminal.
2. Find the faulty merge: `git fetch origin`, then
   `git log --oneline -10 origin/main -- .claude/`. Look for a merge that
   touched the guard or the plugin's hook file. The refusal text may name the
   failing hook command (probe rows 4a-b and 4b-b).

   If no recent merge touched them, there is nothing to revert, for example
   when a Claude Code update broke the guard. Then in step 3 write the fix
   instead of running `git revert`, and go on as below.
3. Revert it on a branch and open a PR:
   - `gh issue create --title "Guard refuses every call" --body "<what you saw>"`
   - `git switch -c fix/<issue>-revert-guard origin/main`
   - `git revert <sha>` (squash merges have one parent, so no `-m`)
   - `git push -u origin HEAD`
   - `gh pr create --title "fix: revert <original subject>" --body "Closes #<issue>"`
4. CI must pass: `gh pr checks <pr> --watch`.
5. Read the diff yourself. The two statuses are your own verdict. Then print
   the commands from the checkout:
   `node .claude/skills/tm-repo-guard/repo-guard.mjs statuses orchestrai <pr>`
   (or `/tm-repo-guard statuses orchestrai <pr>`).
   - Run the printed commands in your own shell. They post both statuses and
     queue the merge.
   - After any new push or branch update, run `statuses` again. They are
     pinned to the head.
   - No admin merge and no change to branch protection. There is no admin
     exception.
6. When the PR is merged (`gh pr view <pr> --json state --jq .state` prints
   `MERGED`), update the plugin in each config dir that `/tm-repo-guard`
   lists. Leave out `CLAUDE_CONFIG_DIR` for the default dir.
   - `env CLAUDE_CONFIG_DIR=<config-dir> claude plugin marketplace update orchestrai`
   - `env CLAUDE_CONFIG_DIR=<config-dir> claude plugin update orchestrai@orchestrai`

   Do not wait for auto update: when it applies is not known (design section
   8). The help says "restart required to apply", so step 7 starts a new
   session.
7. Check the plugin is back and calls go through:
   - Run `/tm-repo-guard` with no argument. Each config dir with the plugin
     should print `at the newest commit`. It reads only the
     `orchestrai@orchestrai` copy.
   - Quit and start a new session the normal way. `/orchestrai:` should offer
     commands again, and an ordinary call in the mode that failed should go
     through.
   - If a call is still refused, the synced copy may still be on the faulty
     commit. Go back to the plugin-off command and record it on an issue.

   These checks show the plugin is loaded and no longer refuses everything.
   They do not show that the guard runs: with no guard loaded, a call goes
   through the same way.
8. Open an issue for the real fix of the reverted change.

## Why this command

It is the switch the repo already uses for subprocess seats
(`.claude/adapters/claude-code-subprocess.mjs`, `SETTINGS_FRAGMENT`, line
202). The other ways are read from the Claude Code 2.1.319 help (and for
`disableAllHooks`, from the research doc). None of these ways was tested
here:

- `--bare`: the help says it skips hooks (those defined in settings and by
  installed plugins) and CLAUDE.md auto-discovery, and that Anthropic auth is
  only `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and
  keychain are never read). A subscription login would not apply.
- `--safe-mode`: the help says it starts with all customizations (CLAUDE.md,
  skills, installed plugins, hooks, MCP servers and more) disabled. That is
  far more than the guard. Its effect on the synced copy is not tested here.
- `disableAllHooks` in a settings file changes that file and outlasts the
  session. It is a switch for all hooks, not for the plugin, so your other
  hooks would be expected to go too. Its effect was not tested.
- `/plugin` disable or `claude plugin disable`: the help says only "Disable an
  enabled plugin", with a scope of user, project or local. It is expected to
  write a settings file and stay in force for later sessions.

## What was tested

Tested 2026-11-11 on Claude Code 2.1.319, headless, in a folder outside any
repo, with the inherited config dir (evidence in PR #548). With the command,
the start-up record listed no orchestrai plugin and no `orchestrai:` skill,
command or agent, and the mode as `default`. A run started right after,
without `--settings`, listed the plugin again. Neither run changed
`settings.json` or `plugins/installed_plugins.json`.

Not tested:

- A refusal followed by this recovery. The guard is not built, so steps 1 to
  8 have never run. The commands in steps 6 and 7 are read from the CLI help
  and the tm-repo-guard SKILL.md.
- The interactive form, including the `/orchestrai:` picker and `/plugin`.
  Only headless runs were made.
- The `orchestrai@synced` key. Only one orchestrai copy was installed, so its
  effect was not seen.
- How the synced copy updates. Design section 8 lists the related open
  points.
