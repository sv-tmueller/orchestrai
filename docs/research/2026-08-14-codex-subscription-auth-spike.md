# Spike: Codex exec with subscription auth

Date: 2026-08-14
Issue: #232
Design context: docs/superpowers/specs/2026-07-08-codex-readiness-design.md
(section 3, option 4, and section 9)

## Verdict

PASS. The `codex exec` round-trip works end to end with ChatGPT
subscription auth and zero metered API billing. All four acceptance
criteria verified on the owner's machine.

## Environment

- Codex CLI v0.146.0 (installed via Homebrew at /opt/homebrew/bin/codex)
- Auth: ChatGPT subscription (Plus/Pro), OAuth tokens in ~/.codex/auth.json
- Host: Claude Code session on Claude Max (Anthropic subscription)
- Machine: macOS, the owner's workstation

## Verified commands

```bash
# The trivial round-trip (run inside a git repo; codex refuses outside one
# unless --skip-git-repo-check is passed):
cd /Users/TM/Desktop/github/orchestrai
codex exec "Reply with exactly: SPIKE_OK"
```

Output (verbatim):

```
OpenAI Codex v0.146.0
--------
workdir: /Users/TM/Desktop/github/orchestrai
model: gpt-5.6-terra
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 01a0023b-7097-73b3-bcc5-49f19594d9fd
--------
user
Reply with exactly: SPIKE_OK
codex
SPIKE_OK
tokens used
11,231
SPIKE_OK
```

Exit code: 0.

## Acceptance criteria

### (a) The run used subscription auth, not a metered key

Verified. ~/.codex/auth.json contains:
- auth_mode: "chatgpt" (subscription, not API key)
- OPENAI_API_KEY: null (no metered key stored)
- tokens: OAuth token set (id_token, access_token, refresh_token,
  account_id) from the ChatGPT sign-in flow

The codex exec header showed `provider: openai` with no API key
warnings. The model used was gpt-5.6-terra (a subscription-available
model, not a metered-only one).

### (b) Metered API keys are all unset

Verified. In the shell that ran codex exec:
- ANTHROPIC_API_KEY: unset
- OPENAI_API_KEY: unset
- CODEX_API_KEY: unset

### (c) No billable API key was silently minted

Verified. After the run, ~/.codex/auth.json still shows
OPENAI_API_KEY: null. No API key was minted or stored. The config.toml
contains no api_key references. The "sign in with ChatGPT" bug
(described in the codex-readiness design section 9, where codex could
silently mint an OPENAI_API_KEY) did not occur with v0.146.0.

### (d) The result returns to the caller through stdout or a file

Verified. The result ("SPIKE_OK") appeared in stdout. The final line
of output is the result text, suitable for capture via shell piping or
command substitution.

## Observations

- codex exec requires a git repo as the working directory (or
  --skip-git-repo-check). Running from /tmp failed with "Not inside a
  trusted directory." This is expected behavior for the sandbox model.
- The default sandbox is read-only: the agent can read the repo but
  cannot write files or run commands that mutate state. For a worker
  seat that needs to write code, the sandbox mode must be raised
  (codex exec --sandbox workspace-write or --full-auto).
- Token usage was 11,231 for a trivial prompt. Subscription plans
  include a token allowance; no per-token billing occurs.
- The model (gpt-5.6-terra) is subscription-available. The codex
  readiness design's volatility checklist (section 10) should be
  re-checked before building the full adapter, but the auth path is
  stable as of v0.146.0.

## Conclusion

The sanctioned Codex path works with subscription auth and zero metered
billing. The blocker for #316 (Phase D: Codex adapter) is cleared. The
adapter can be built on `codex exec` with confidence that no
ANTHROPIC_API_KEY, OPENAI_API_KEY, or CODEX_API_KEY is needed.
