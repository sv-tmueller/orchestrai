# Codex-readiness: evaluated and deferred

Date: 2026-07-08
Status: decision record. Resolves issue #230. Affirms
`docs/architecture/operating-model.md`; does not reopen it.

## 1. Summary

Issue #230 asked whether the team should become usable from a non-Claude host
(OpenAI's Codex CLI) or a non-Anthropic model, and which of three routes to
take: a separate Codex host, the Claude host pointed at a non-Claude model, or
a full host-and-model abstraction. The real driver, confirmed with the owner,
is model independence: not being hostage to Anthropic availability or pricing,
and being able to run the best or cheapest model per seat.

The decision is to defer the port. Claude Code and the Claude model family
remain the substrate for now. This document records why, the resilience we
rely on instead, the accepted risk, the single sanctioned path for adding a
non-Anthropic seat when we do revisit, and the triggers that would reopen the
question. One small spike is filed to prove that sanctioned path is real.

## 2. The driving question, answered honestly

Can the Claude CLI itself be driven with a non-Claude model (for example
GPT-5.6)?

Technically yes, but only through an unsupported third-party gateway
(claude-code-router, LiteLLM, and similar) that fronts the Anthropic Messages
API. There is no official support, and Anthropic's own gateway docs explicitly
disclaim routing Claude Code to non-Claude models through any gateway.

For this system specifically, that route is a trap. It breaks the exact
mechanisms orchestrai is built on:

- Prompt caching stops working, so token cost roughly doubles on long
  sessions. This repo runs on a cost-bounded model policy and has a whole
  token-burn investigation; doubling cost is disqualifying.
- The Workflow tool breaks or severely degrades. Three core commands
  (`tm-map-codebase`, `tm-review-codebase`, `tm-review-changes`) are Workflow
  scripts.
- Extended thinking breaks, and subagent reliability degrades.
- The per-seat model policy collapses. A single gateway routes every request
  to one model, so "strong model in judgment seats, cheap workers elsewhere,
  effort pinned per seat" (the heart of the design) loses its meaning.

So option 2 from the issue (point the Claude host at a non-Claude model) is the
technically worst path for a system whose whole value is the-right-model-per-seat
with bounded token burn.

## 3. Options considered

1. **Separate Codex host (issue option 1).** Port the team to Codex as a
   parallel host. The concepts map well: agent personas move from Markdown to
   TOML, skills use the near-identical `SKILL.md` format, MCP and slash
   commands map across. The blocker: Codex has no deterministic
   subagent-fan-out primitive equivalent to the Workflow tool. The JavaScript
   Workflow scripts have no in-agent equivalent and would be rebuilt as an
   external driver (Codex SDK, `codex exec`, or the Agents SDK). A port also
   means permanent dual maintenance of two teams and reopening the
   "personal, Claude-only" identity decision.

2. **Claude host on a non-Claude model (issue option 2).** The gateway route.
   Rejected for the reasons in section 2.

3. **Full host-and-model abstraction (issue option 3).** Largest rework.
   Premature before a port has proven the seams.

4. **Subscription-authed Codex worker seat (surfaced during this pass).** Keep
   Claude Code as the lead on the Claude Max subscription. Add a Codex worker
   seat signed into a ChatGPT Plus or Pro subscription, driven by the lead via
   `codex exec` (shell) or `codex mcp-server` (MCP), with git and files as the
   handoff medium. Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` /
   `CODEX_API_KEY` stay unset, so nothing is billed at metered API rates; each
   seat draws on its own flat subscription. This keeps the Claude side
   (caching, Workflow tool, model policy) fully intact, needs no port, and does
   not reopen the identity decision, because a Codex seat is an extension (like
   an MCP tool), not a second host replacing Claude Code.

Note on Cursor: it was raised as a way to hold both subscriptions in one
editor. It does not fit. Cursor bills through its own token-priced credit pool
(metered once the pool is spent), does not let you attach a ChatGPT or Claude
subscription to its agent, and its multi-agent mode runs agents in parallel
isolation with no orchestration between them. It puts both models in one
window, but not under your subscriptions and not interacting.

## 4. Decision

Defer the port. Claude Code and the Claude model family remain the substrate.
Do not adopt the gateway route (option 2) at all. Record option 4 (the
subscription-authed Codex worker seat) as the single sanctioned path for adding
a non-Anthropic seat if and when a revisit trigger fires.

## 5. What "Codex-ready" means for v1

Nothing new is in scope. No host CLI beyond Claude Code, and no non-Anthropic
model, ships in v1. The one exception is the spike in section 9, which proves
the sanctioned path works but does not put a Codex seat into the running team.

## 6. Resilience we rely on instead

The honest answer to "not hostage to Anthropic" today rests on three supported
mechanisms already in place:

- The Fable-to-Opus fallback ladder in `.claude/team-guide.md` handles Fable
  unavailability or quota exhaustion. This is exactly what the #179
  quota-exhaustion incident exercised.
- Claude Code natively supports Amazon Bedrock and Google Vertex for Claude
  models, giving cross-cloud availability of the Claude family.
- The cost-based fallback trigger already in the model policy covers the
  pricing dimension for the lead seat.

## 7. Accepted risk

None of the above provides a non-Anthropic model. If Anthropic as a whole is
unavailable, or a non-Anthropic model becomes materially better or cheaper for
a seat, there is no escape hatch today. We accept that risk in exchange for not
paying the port cost now. The spike in section 9 keeps the escape hatch cheap
to build later.

## 8. Identity: affirmed, not reopened

This pass is an explicit revisit of the locked identity decision in
`operating-model.md`, and it concludes with no change to the substrate. The
plugin stays a personal orchestrator built on Claude Code. A future Codex
worker seat, if built, is an extension of that identity, not a replacement of
the host. A dated pointer to this document is added to `operating-model.md`.

## 9. Decomposition and next steps

Issue #230 is a design issue; this document satisfies its acceptance criteria,
so #230 closes with the PR that lands this spec and the `operating-model.md`
pointer. There is no implementation plan to write, because the decision is to
defer.

One spike issue is filed to the backlog (not dispatched, because it needs the
owner's own subscription logins on the owner's machine):

- Prove a subscription-authed Codex worker seat end to end: from a Claude Code
  session on Claude Max, invoke `codex exec` against a Codex CLI signed into a
  ChatGPT Plus or Pro subscription, confirm the result returns through a
  file or stdout, and verify no metered API key was used or silently minted.
  Size S. MCP (`codex mcp-server`), the flat-star report-contract wiring, and
  any real porting are explicit non-goals of the spike.

## 10. Volatility and things to re-verify

Pricing, model coverage, and auth defaults in this area move fast. Before
acting on the sanctioned path, re-verify:

- Current Codex and ChatGPT subscription pricing and rate limits, and current
  Cursor pricing.
- That `codex exec` and `codex mcp-server` still reuse the saved ChatGPT OAuth
  login by default, and that "sign in with ChatGPT" does not silently mint a
  billable API key (a reported Codex bug, status unconfirmed).
- Which OpenAI models each auth path covers (ChatGPT sign-in vs API key).

## 11. Sources

Claude Code model and gateway behavior:
- https://code.claude.com/docs/en/model-config.md
- https://code.claude.com/docs/en/llm-gateway.md
- https://code.claude.com/docs/en/prompt-caching.md
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan

Codex CLI capabilities and auth:
- https://developers.openai.com/codex/subagents
- https://developers.openai.com/codex/skills.md
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/noninteractive.md
- https://developers.openai.com/codex/auth
- https://developers.openai.com/codex/sdk

Cross-tool orchestration and Cursor:
- https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk
- https://www.vantage.sh/blog/cursor-pricing-explained
