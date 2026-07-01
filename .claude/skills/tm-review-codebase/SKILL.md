---
name: tm-review-codebase
description: Token-bounded full-repo review, run as a workflow (Sonnet scout and area workers plus one Fable critic that writes a dated report). Plugin-only wrapper; the committed-repo and config-dir roots invoke the tm-review-codebase workflow directly by name. User-invocable only.
disable-model-invocation: true
---

Run the `tm-review-codebase` workflow against the whole repo. This skill
exists only so the plugin install (`sv-tmueller@claude-template`) can reach the
workflow: the committed-repo and `/tm-install-team` config-dir roots already
expose it directly as `/tm-review-codebase` because Claude Code auto-discovers
`.claude/workflows/*.js`, and a plugin does not get that auto-discovery for
`workflows/` (it is not an official plugin component type).

1. Check whether you are running from a plugin install: `echo "$CLAUDE_PLUGIN_ROOT"`.
2. If `CLAUDE_PLUGIN_ROOT` is set (non-empty), invoke the Workflow tool with
   `scriptPath` set to
   `${CLAUDE_PLUGIN_ROOT}/workflows/tm-review-codebase.js`. No `.claude/`
   segment: `source: "./.claude"` in `marketplace.json` makes the plugin root
   `.claude/` itself, so `workflows/` sits directly under
   `CLAUDE_PLUGIN_ROOT`.
3. Otherwise, invoke the Workflow tool with `name: "tm-review-codebase"`,
   which resolves the saved workflow at `.claude/workflows/tm-review-codebase.js`
   the normal way.

Report whatever the workflow returns; do not re-review files yourself.
