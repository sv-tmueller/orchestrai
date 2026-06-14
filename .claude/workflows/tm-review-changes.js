export const meta = {
  name: 'tm-review-changes',
  description:
    'Token-bounded code review: Sonnet workers review the diff across fixed dimensions, one Opus critic consolidates. Models are pinned per stage in-script, so it never inherits an expensive session model or fans out unboundedly.',
  phases: [
    { title: 'Review', detail: 'one Sonnet worker per dimension', model: 'sonnet' },
    { title: 'Consolidate', detail: 'one Opus critic verifies and merges findings', model: 'opus' },
  ],
}

// Bounded by construction. The dimension list is fixed, there is no per-file
// fan-out and no loop, so a run is exactly DIMENSIONS.length Sonnet workers plus
// one Opus critic. It cannot become the 100-agent fan-out that an unpinned
// session-model review produces. Models are pinned per stage, so a Fable 5 or Opus
// session never leaks into the workers.
//
// Invoke with an optional base ref:
//   Workflow({ name: 'tm-review-changes', args: { base: 'origin/main' } })

// Validate base against git-ref-safe chars; fall back to the default if it
// contains shell metacharacters. Protects both the git command string and the
// agent prompts that interpolate the value.
function safeRef(value, fallback) {
  return typeof value === 'string' && /^[\w.~^\/\-]+$/.test(value) && !value.includes('..') ? value : fallback
}
const base = safeRef(args && args.base, 'origin/main')

const DIMENSIONS = [
  {
    key: 'bugs',
    brief:
      'Bugs, adversarially. Do not just read for correctness; look for inputs or states that break the change: logic errors, wrong or missing edge-case handling, broken error paths, races and ordering bugs, off-by-one, misused or wrongly-assumed APIs, null and boundary handling, resource leaks. A weakened or deleted test is a finding.',
  },
  {
    key: 'security',
    brief:
      'Security. Untrusted input reaching a sink (injection, path traversal, SSRF, unsafe deserialization), missing authn or authz checks, secrets or credentials in code or logs, unsafe defaults, weak crypto, and supply-chain risk from new or bumped dependencies. The /security-review skill is the deep standalone pass; here, flag what this diff exposes.',
  },
  {
    key: 'scope',
    brief:
      'Scope and simplicity (CLAUDE.md principles 2 and 3). Code beyond what the change requires, speculative abstraction, drive-by refactoring, reformatted unrelated lines, configurability nothing uses. Ask whether 200 lines could be 50.',
  },
  {
    key: 'tests',
    brief:
      'Test coverage. Behavior changed with no test pinning it, logic with a right answer lacking a failing-then-passing test, integration touched without fixture coverage.',
  },
  {
    key: 'style',
    brief:
      'Project style (CLAUDE.md code style and writing style). Em dashes, AI-cliche phrases, hard-coded user-facing strings, raw primitives where dedicated types exist, comments that restate code, escape hatches with no // reason: comment.',
  },
]

// FINDING and FINDINGS_SCHEMA are a shared base intentionally duplicated with
// tm-review-codebase.js (the workflow runtime has no shared imports); that copy
// adds `area` and `dimension`. Keep the two definitions in sync.
const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string' },
    line: { type: 'string', description: 'line number or range, or "n/a"' },
    severity: { type: 'string', enum: ['must-fix', 'should-fix', 'nit'] },
    problem: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['file', 'line', 'severity', 'problem', 'fix'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { findings: { type: 'array', items: FINDING } },
  required: ['findings'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes-requested'] },
    summary: { type: 'string' },
    mustFix: { type: 'array', items: FINDING },
    shouldFix: { type: 'array', items: FINDING },
    nits: { type: 'array', items: FINDING },
    dismissed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { problem: { type: 'string' }, why: { type: 'string' } },
        required: ['problem', 'why'],
      },
      description: 'findings judged false-positive or out of scope, with the reason',
    },
  },
  required: ['verdict', 'summary', 'mustFix', 'shouldFix', 'nits'],
}

const diffHint =
  `Get the change under review with \`git diff ${base}...HEAD\` for committed work on the branch, and \`git diff\` plus \`git status\` for any uncommitted changes; review the union. Read surrounding code before judging, and do not flag what the diff does not touch.`

phase('Review')
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(
      `You review one dimension of a code change and report findings only; you never edit.\n\nDimension: ${d.brief}\n\n${diffHint}\n\nReport every finding with file, line, severity (must-fix | should-fix | nit), the problem, and the required fix. If the dimension is clean, return an empty findings array. Stay strictly within your dimension.`,
      { label: `review:${d.key}`, phase: 'Review', model: 'sonnet', schema: FINDINGS_SCHEMA }
    )
  )
)

const raw = reviews.filter(Boolean).flatMap((r) => r.findings)

// parallel() null-pads a worker that errors or is skipped, so a dead reviewer
// would otherwise drop its whole dimension while the critic assumes full
// coverage. Track which dimensions actually reported.
const covered = DIMENSIONS.filter((_, i) => reviews[i])
const dropped = DIMENSIONS.filter((_, i) => !reviews[i])
const coverageNote = dropped.length
  ? ` ${dropped.length} reviewer(s) did not return, so these dimensions are NOT covered: ${dropped.map((d) => d.key).join(', ')}. Treat the review as partial and say so in your summary.`
  : ''

phase('Consolidate')
const report = await agent(
  `You are the senior reviewer. ${covered.length} parallel reviewers produced the raw findings below.${coverageNote} ${diffHint}\n\nFor each raw finding: verify it against the actual diff, drop false positives and anything out of scope, merge duplicates, and set a final severity. You may add a finding only if it is a clear must-fix the reviewers missed. Only must-fix findings block: verdict is changes-requested if any remain, approve otherwise. Record every dropped finding under dismissed with the reason.\n\nRaw findings (JSON):\n${JSON.stringify(raw, null, 2)}`,
  { label: 'consolidate', phase: 'Consolidate', model: 'opus', schema: REPORT_SCHEMA }
)

return report
