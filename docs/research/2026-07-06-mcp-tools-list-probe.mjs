#!/usr/bin/env node
// MCP tools/list probe for issue #218 ("research: measure MCP tool-schema
// injection size (driver 5 follow-up)").
//
// PRIVACY BOUND: this script sends only MCP protocol constants (initialize,
// notifications/initialized, tools/list JSON-RPC requests). It never reads,
// sends, or prints conversation content, project data, or credentials. It
// does not read or use any stored OAuth token or credential; if the server
// demands auth, the script reports the HTTP status and WWW-Authenticate
// header and stops. Output is aggregate numbers, tool names and sizes,
// serverInfo, protocol version, and HTTP statuses only: never full schema
// content.
//
// Usage:
//   node docs/research/2026-07-06-mcp-tools-list-probe.mjs [url]
//
// Default url: https://mcp.supabase.com/mcp (the supabase plugin's
// configured MCP server; see the accompanying doc for config evidence).
//
// Zero dependencies: plain Node, global fetch (Node >= 18).

const DEFAULT_URL = 'https://mcp.supabase.com/mcp';

function heuristicTokens(bytes) {
  // chars/4 heuristic, same as docs/research/2026-07-06-token-burn-investigation.md
  return Math.round(bytes / 4);
}

// Streamable HTTP responses are either plain JSON or SSE-framed ("data: ..."
// lines). This extracts the JSON-RPC message either way.
function parseBody(contentType, text) {
  if (contentType && contentType.includes('text/event-stream')) {
    const messages = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (!payload) continue;
      try {
        messages.push(JSON.parse(payload));
      } catch {
        // ignore unparseable SSE frames
      }
    }
    return messages[messages.length - 1] ?? null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rpc(url, sessionId, body) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = parseBody(res.headers.get('content-type'), text);
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    sessionId: res.headers.get('mcp-session-id') || sessionId || null,
    body: parsed,
  };
}

async function probe(url) {
  const httpStatuses = [];

  const initRes = await rpc(url, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'orchestrai-mcp-schema-size-probe', version: '1.0.0' },
    },
  });
  httpStatuses.push({ step: 'initialize', status: initRes.status });

  if (!initRes.ok) {
    return {
      blocked: true,
      step: 'initialize',
      status: initRes.status,
      wwwAuthenticate: initRes.headers.get('www-authenticate') || null,
      body: initRes.body,
      httpStatuses,
    };
  }

  const sessionId = initRes.sessionId;
  const serverInfo = initRes.body?.result?.serverInfo || null;
  const protocolVersion = initRes.body?.result?.protocolVersion || null;

  await rpc(url, sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  httpStatuses.push({ step: 'notifications/initialized', status: 'sent (notification, no id)' });

  const tools = [];
  let cursor;
  for (;;) {
    const params = cursor ? { cursor } : {};
    const listRes = await rpc(url, sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params,
    });
    httpStatuses.push({ step: 'tools/list', status: listRes.status });

    if (!listRes.ok) {
      return {
        blocked: true,
        step: 'tools/list',
        status: listRes.status,
        wwwAuthenticate: listRes.headers.get('www-authenticate') || null,
        body: listRes.body,
        httpStatuses,
      };
    }

    const result = listRes.body?.result || {};
    for (const tool of result.tools || []) tools.push(tool);
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  const toolsJson = JSON.stringify(tools);
  const totalBytes = Buffer.byteLength(toolsJson);

  return {
    blocked: false,
    serverInfo,
    protocolVersion,
    toolCount: tools.length,
    totalBytes,
    heuristicTokens: heuristicTokens(totalBytes),
    perTool: tools.map((t) => ({
      name: t.name,
      bytes: Buffer.byteLength(JSON.stringify(t)),
    })),
    httpStatuses,
  };
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const result = await probe(url);
  console.log(JSON.stringify({ url, ...result }, null, 2));
  if (result.blocked) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
