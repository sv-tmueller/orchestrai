# MCP tool-schema injection size (driver 5 follow-up)

Follow-up to recommendation 5 of
[`2026-07-06-token-burn-investigation.md`](./2026-07-06-token-burn-investigation.md)
(issue #218, part of batch #215). That report left driver 5 ("MCP schema
overhead") LABELED and inconclusive: no local, static, or zero-dependency
measurement was available, and starting the configured MCP server directly
was needed before the driver could be confirmed, cleared, or sized.

## Contract note: the configured server is remote, not local

The issue scope asked to "start the server locally". The configured server
cannot be started locally: it is a hosted HTTP endpoint. This follow-up
measures it as such, over HTTPS, unauthenticated, sending MCP protocol
constants only. See the batch #215 lead decision for the scope reading that
authorizes this.

## Config evidence

Both config dirs enable the `supabase` plugin:

```
$ cat ~/.claude/settings.json | jq '.enabledPlugins'
{
  "frontend-design@claude-plugins-official": true,
  "skill-creator@claude-plugins-official": true,
  "superpowers@claude-plugins-official": true,
  "bigdata-com@claude-plugins-official": true,
  "supabase@claude-plugins-official": true,
  "solvvision-servicenow@solvvision": false
}

$ cat ~/.claude-personal/settings.json | jq '.enabledPlugins'
{
  "ui-ux-pro-max@ui-ux-pro-max-skill": true,
  "impeccable@impeccable": true,
  "frontend-design@claude-plugins-official": true,
  "supabase@claude-plugins-official": true,
  "superpowers@claude-plugins-official": true,
  "orchestrai@orchestrai": true
}
```

The plugin manifest points to an MCP server definition file (cached version
0.1.11 in `~/.claude-personal`; 0.1.10 in `~/.claude`, same server
definition shape):

```
$ cat ~/.claude-personal/plugins/cache/claude-plugins-official/supabase/0.1.11/.claude-plugin/plugin.json
{
  "name": "supabase",
  "version": "0.1.11",
  ...
  "mcpServers": "./agents/claude/.mcp.json",
  ...
}

$ cat ~/.claude-personal/plugins/cache/claude-plugins-official/supabase/0.1.11/agents/claude/.mcp.json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp",
      "headers": {
        "X-Source-Name": "claude-code-plugin",
        "X-Source-Version": "0.1.11"
      }
    }
  }
}
```

`"type": "http"` confirms this is a hosted endpoint, not a spawned local
process. There is no server binary or command to run locally.

## Measurement procedure

A committed zero-dependency Node script,
[`2026-07-06-mcp-tools-list-probe.mjs`](./2026-07-06-mcp-tools-list-probe.mjs),
speaks MCP streamable HTTP against the configured URL:

1. POST `initialize` (protocol constants only: `protocolVersion`,
   `capabilities`, `clientInfo`), `Accept: application/json,
   text/event-stream`. Captures the `mcp-session-id` response header and
   `result.serverInfo`.
2. POST `notifications/initialized`, then `tools/list` with the session id,
   following `nextCursor` pagination to exhaustion. Handles both plain-JSON
   and SSE-framed (`data: ...`) responses.
3. Reports aggregate numbers only: tool count, `Buffer.byteLength` of the
   tools array as JSON, chars/4 heuristic tokens (labeled), per-tool name and
   size, `serverInfo`, negotiated protocol version, and HTTP statuses at each
   step. No schema content is printed to this doc.
4. If `initialize` or `tools/list` returns a non-2xx status, the probe stops
   and reports the status and `WWW-Authenticate` header instead of
   proceeding.

Reproduce command (unauthenticated, sends only the JSON-RPC bodies above; no
stored credential is read or used):

```
node docs/research/2026-07-06-mcp-tools-list-probe.mjs
```

## Both runs' numbers

Run 1 (2026-07-06T15:28:30Z, per the response `date` header):

```json
{
  "url": "https://mcp.supabase.com/mcp",
  "blocked": true,
  "step": "initialize",
  "status": 401,
  "wwwAuthenticate": "Bearer error=\"invalid_request\", error_description=\"No access token was provided in this request\", resource_metadata=\"https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp\"",
  "body": { "message": "Unauthorized" },
  "httpStatuses": [ { "step": "initialize", "status": 401 } ]
}
```

Run 2 (2026-07-06T15:28:59Z):

```json
{
  "url": "https://mcp.supabase.com/mcp",
  "blocked": true,
  "step": "initialize",
  "status": 401,
  "wwwAuthenticate": "Bearer error=\"invalid_request\", error_description=\"No access token was provided in this request\", resource_metadata=\"https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp\"",
  "body": { "message": "Unauthorized" },
  "httpStatuses": [ { "step": "initialize", "status": 401 } ]
}
```

Both runs return the identical HTTP status (401) and identical
`WWW-Authenticate` header on the `initialize` call, before any
`serverInfo`, session id, or tool-schema payload is ever returned. The
acceptance criterion ("a second run gives the same payload size for the
same server version") does not apply literally here, because no payload or
`serverInfo.version` was obtained on either run; the closest available
reproducibility evidence is this identical-status, identical-challenge
pair, recorded plainly rather than substituted for a payload size.

## Verdict

**STILL-BLOCKED.** The hosted server at `https://mcp.supabase.com/mcp`
requires OAuth (evidence: HTTP 401 on `initialize`, `WWW-Authenticate:
Bearer error="invalid_request", error_description="No access token was
provided in this request", resource_metadata="https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp"`).
Provisioning credentials for this measurement is out of scope: the sub-plan
forbids reusing or extracting Claude Code's stored OAuth token, since that
token grants project-data access far beyond a tool listing, and no other
credential source is authorized for this probe.

The adopted verdict rule (CONFIRMED at >= 1,000 heuristic tokens, CLEARED
below that, STILL-BLOCKED per the auth path) is not reachable here: no
tool-schema payload was ever returned, so there is no token count to compare
against the threshold. No before/after arithmetic follows, per the sub-plan
(that arithmetic applies only to the CONFIRMED branch).

Driver 5 therefore moves from "LABELED, inconclusive (data gap)" in the
token-burn report to **STILL-BLOCKED (named blocker: OAuth required)**: the
data gap is closed in the sense that the blocker is now precise and
evidenced, not in the sense that the driver's size is known. A future
follow-up could re-attempt this measurement with a legitimately provisioned,
scoped-down credential for this purpose alone, if that is ever judged worth
doing.

## Privacy bound

The probe sends only MCP protocol constants (`initialize` params,
`notifications/initialized`, `tools/list` params). It does not read, send,
or print conversation content, project data, or any stored credential. No
user data was sent to or received from the endpoint; the endpoint rejected
the request before returning anything beyond the two lines quoted above.
