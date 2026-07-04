---
name: tm-review-changes
description: Token-bounded code review of the current diff, run as a workflow (fixed Sonnet reviewers, one per dimension including docs drift and performance, plus one Fable critic). Plugin-only wrapper; the committed-repo root invokes the tm-review-changes workflow directly by name. User-invocable only.
disable-model-invocation: true
argument-hint: "[base ref, default origin/main]"
---

Run the `tm-review-changes` workflow against the current diff. This skill
exists only so the plugin install (`orchestrai@orchestrai`) can reach the
workflow: the committed-repo root already exposes it directly as
`/tm-review-changes` because Claude Code auto-discovers
`.claude/workflows/*.js`, and plugin `workflows/` is not an official component
type; any direct registration is undocumented. Retire this wrapper if plugin
`workflows/` becomes an officially documented component type (see the
component table in code.claude.com/docs/en/plugins-reference.md).

Input: $ARGUMENTS (an optional base ref, default `origin/main`).

1. Check whether you are running from a plugin install: `echo "$CLAUDE_PLUGIN_ROOT"`.
2. If `CLAUDE_PLUGIN_ROOT` is set (non-empty), invoke the Workflow tool with
   `scriptPath` set to
   `${CLAUDE_PLUGIN_ROOT}/workflows/tm-review-changes.js` and
   `args: { base: <the base ref> }`. No `.claude/` segment: `source:
   "./.claude"` in `marketplace.json` makes the plugin root `.claude/` itself,
   so `workflows/` sits directly under `CLAUDE_PLUGIN_ROOT`.
3. Otherwise, invoke the Workflow tool with `name: "tm-review-changes"` and
   `args: { base: <the base ref> }`, which resolves the saved workflow at
   `.claude/workflows/tm-review-changes.js` the normal way.

Report whatever the workflow returns; do not re-summarize or re-run dimensions
yourself.
