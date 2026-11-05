/**
 * Role-contract parser, shared by the host adapters (issue #453).
 *
 * Seat reports arrive as text on stdout and are keyed on host-neutral
 * markers (STATUS:, VERDICT:, the architect job header, NEEDS_DECISION:)
 * per docs/architecture/role-contracts.md. The parse logic lives here, not
 * in each adapter, because the markers are the same on every host: a second
 * copy would drift from the contract silently. Extracted from
 * hermes-adapter.mjs, which now imports it.
 */

// The field whose absence means the seat did not produce a real report.
export const REQUIRED_FIELD = {
  architect: 'KIND',
  developer: 'STATUS',
  tester: 'VERDICT',
  reviewer: 'VERDICT',
  'fact-checker': 'VERDICT',
  'docs-writer': 'FILES',
  'perf-investigator': 'BASELINE',
}

// The openers an architect report may start with (role-contracts.md).
export const ARCHITECT_KINDS = ['SUB_PLAN', 'SPLIT_PROPOSAL', 'ARBITRATION', 'NEEDS_DECISION']

// Report keys are uppercase and may contain spaces ("UNTESTED CLAIMS") or
// hyphens ("RE-MEASURE"). Anchored at column 0 so the indented sub-keys
// inside a CLAIMS or BASELINE block do not shadow the top-level fields.
const REPORT_LINE = /^([A-Z][A-Z _-]*):[ \t]*(.*)$/

/**
 * parseReport(role, stdout) -> object
 *
 * Parse a seat's report out of its stdout. Returns the parsed fields plus
 * `raw`. An architect report also gets `KIND`, since its contract opens
 * with a bare keyword rather than a key-value line.
 *
 * Structured data: a seat whose downstream stage fans out over its output
 * is prompted to include one fenced ```json block holding that
 * machine-readable payload. When present and parseable, its top-level keys
 * are copied onto the report (existing report fields win). Prose-only
 * reports keep working: the block is optional, and an unparseable one is
 * caught by detectFailure's missing-field check.
 */
export function parseReport(role, stdout) {
  const text = stdout || ''
  const report = { raw: text }

  for (const line of text.split('\n')) {
    const match = REPORT_LINE.exec(line)
    if (!match) continue
    const [, key, value] = match
    // First occurrence wins: a later mention in prose cannot overwrite the
    // report block.
    if (!(key in report)) report[key] = value.trim()
  }

  const jsonBlock = extractJsonBlock(text)
  if (jsonBlock) {
    for (const [key, value] of Object.entries(jsonBlock)) {
      if (!(key in report)) report[key] = value
    }
  }

  if (role === 'architect') {
    const kind = parseArchitectKind(text)
    if (kind) report.KIND = kind
  }

  return report
}

// The architect's contract is "start your report with one of ...", so the
// kind is decided by the first non-empty line.
function parseArchitectKind(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    for (const kind of ARCHITECT_KINDS) {
      if (trimmed === kind || trimmed.startsWith(`${kind}:`)) return kind
    }
    return null
  }
  return null
}

// Extract the LAST fenced ```json block from a report. Last, not first:
// a seat may quote an example schema early and emit its real payload at
// the end. Returns the parsed object, or null when no parseable block
// exists (a prose-only report is legitimate).
function extractJsonBlock(text) {
  const fence = /```json\s*\n([\s\S]*?)```/g
  let match
  let parsed = null
  while ((match = fence.exec(text)) !== null) {
    try {
      const candidate = JSON.parse(match[1])
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate
      }
    } catch {
      // An unparseable block is not fatal: keep scanning for a later one.
    }
  }
  return parsed
}

/**
 * Does this output carry a provider-level error rather than a report?
 * The reference case is `HTTP 403: Virtual key has expired`.
 */
export function hasProviderError(text) {
  if (!text) return false
  if (/HTTP \d{3}/.test(text)) return true
  return /\b(quota exceeded|rate limit|unauthorized|invalid api key)\b/i.test(text)
}
