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
- The guard is a plugin hook (design 4.2), so it is expected to act only
  inside Claude Code sessions. The repair steps below use `git`, `gh`, `node`
  and `claude plugin` commands, which are expected to work from a plain
  terminal too. Not tested.
- This covers the guard as a plugin hook (design 4.2). If it ever ships
  another way, this command no longer covers it.

## The command

```sh
env claude --permission-mode manual --settings '{"enabledPlugins":{"orchestrai@orchestrai":false,"orchestrai@synced":false}}'
```

- `env` runs the `claude` binary found on PATH, so a shell alias or function
  named `claude` does not apply. Run `type claude` to see whether you have
  one. If the alias sets a config dir, put `CLAUDE_CONFIG_DIR=<config-dir>`
  right after `env`.
- Never add a bypass flag. Do not put this command in an alias.
- The command changes no settings file: in the test run, the checksums of two
  settings files were the same before and after (test record). The
  `--settings` help says only "load additional settings", so that the JSON
  holds for this one session is expected, not checked. The control run, which
  left `--settings` out, listed the plugin again.
- Both keys are set because the plugin can be loaded under two keys, one per
  copy (the marketplace copy and the synced copy). The seat adapter's comment
  says disabling only the first copy left the synced second copy loading
  (`.claude/adapters/claude-code-subprocess.mjs`, lines 194-195). It was not
  re-tried here.
- Your other hooks and the CLAUDE.md rules are expected to stay on, because
  the command switches off only the two plugin keys. This was not checked.

Check the switch inside the session: type `/orchestrai:`. The test run's
start-up record listed no `orchestrai:` skill, command or agent, so expect
nothing to be offered. The interactive picker was not checked. If something is
offered, a copy under another key may still be on. Find its key in `/plugin` or
`claude plugin list` (the help says only that it lists installed plugins; that
it shows the key was not checked), quit, add the key to the JSON with `false`
and start again.

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

## Permission mode

The command names `manual`, the mode the 2.1.319 help lists. The start-up
record shows it as `default`. Design 4.2 names `bypassPermissions`, `auto` and
`dontAsk` as the modes where nobody is asked, so `manual` is expected to be a
prompting mode. The design puts the base deny list in the guard (4.2, 4.3), so
with the plugin off it is expected to be gone too. Only the GitHub rule
(design 4.2) and the prompts should remain, so you approve each command.

- Name the mode because a config dir's user settings can make bypass the
  default with nothing at launch (probe row 7; that the mode came from those
  settings is an inference, design 4.1), and an alias can add a bypass flag.
- One command covers both kinds of guard bug. A bug in the decision logic
  leaves prompting modes alone anyway. A guard that crashes or times out was
  seen to refuse in bypass mode. The failure policy names no mode, so expect it
  to refuse in a prompting mode too, and then switching the plugin off is
  required.
- Do not use `auto`, `dontAsk` or a bypass flag in this session.
- Not known: whether `--permission-mode manual` beats a bypass default in a
  config dir's user settings. The test below ran with the inherited config
  dir and shows only which mode that run reported. Look at the mode in the
  session before you approve anything.

## From the session to a fix

1. Start the session in the orchestrai checkout and check the switch took
   (`/orchestrai:`).
2. Find the faulty merge: `git fetch origin`, then
   `git log --oneline -10 origin/main -- .claude/`. Look for merges that
   touched the guard code or the plugin's hook file (the guard is not built
   yet, so those paths do not exist yet). The refusal text may help.
3. Open a one-line issue. Create a branch from `origin/main`, run
   `git revert <sha>` (squash merges have one parent, so no `-m`), push the
   branch and open a PR with `Closes #N`. Title: `fix: revert <original
   subject>`.
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
6. After the merge, update the plugin in each config dir:
   - `env CLAUDE_CONFIG_DIR=<config-dir> claude plugin marketplace update orchestrai`
   - `env CLAUDE_CONFIG_DIR=<config-dir> claude plugin update orchestrai@orchestrai`
   - Leave out `CLAUDE_CONFIG_DIR` for the default dir. The help says
     "restart required to apply". These two commands are read from the CLI
     help, not run. Auto update may also get there. Whether and when it
     applies is not tested (design section 8).
7. Check the guard is back:
   - `/tm-repo-guard` with no argument prints, per config dir, whether the
     installed copy is the newest commit (its SKILL.md). Each should say yes.
   - Quit and start a new session the normal way. Expect `/orchestrai:` to
     offer commands again and an ordinary call in the mode that failed to go
     through. Not tested, because the guard is not built yet.
   - If it is still refused, the synced copy may still be on the faulty
     commit. How that copy updates was not checked. Go back to the plugin-off
     command and record it on an issue.
8. Open an issue for the real fix of the reverted change.

## Test record

Tested 2026-11-11 on Claude Code 2.1.319 with two headless runs (one turn,
no tools, small model, in a folder outside any repo, in `<tmp-dir>`). The
test run used the command above. The control was the same command without the
`--settings` argument. Both used the inherited config dir.

- Test run: the start-up record listed no orchestrai plugin, and no
  `orchestrai:` skill, command or agent.
- Control: the start-up record listed the orchestrai plugin
  (`orchestrai@orchestrai`), with `orchestrai:` entries in the skill, command
  and agent lists. That plugin was the only difference between the two plugin
  lists.
- Both runs reported the permission mode as `default`, although the flag
  said `manual`. So the start-up record names it `default`.
- The checksums of the config dir's `settings.json` and
  `plugins/installed_plugins.json` were the same before and after. So the
  command wrote neither file.
- Limits: the control showed one orchestrai copy, not two, so the effect of
  the `orchestrai@synced` key was not seen. It was a headless run, not the
  interactive form.

## Open points

- How the synced copy updates was not checked. Design section 8 lists the
  related open points (whether an auto update applies in the running session,
  and plugins that arrive in a config dir with a login).
- The guard is not wired yet, so a refusal followed by this recovery was not
  exercised end to end.
