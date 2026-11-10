---
name: tm-repo-guard
description: Report how each repo you own stands against the guard rules (branch protection, required PR, auto merge, required checks). Read-only. User-invocable only.
disable-model-invocation: true
---

You are reading this because the user typed the command, so this skill is
already loaded. Do not call the Skill tool for it.

Run the check once, with no arguments and a Bash timeout of 300000 ms:

```
node "${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-repo-guard/repo-guard.mjs"
```

Print its stdout as is. Run no other gh command: the script is read-only and
makes every GitHub call itself. Exit 0 means every repo was read; exit 1 means
at least one entry says "could not read", or the repo list itself failed.
Report that, and do not retry or work around it.
