export const meta = {
  name: 'tm-review-codebase',
  description:
    'Token-bounded full-repo review: a Sonnet scout splits the repo into N coherent areas (N sized to the repo, capped at a ceiling), one Sonnet worker reviews each area plus one Sonnet architecture worker audits repo-wide structure, and one Fable critic verifies, writes a dated report, and consolidates. Models are pinned per stage in-script, so it never inherits the session model, and the agent count scales with repo size only up to a hard ceiling.',
  phases: [
    { title: 'Scout', detail: 'one Sonnet agent splits the repo into N areas (N <= ceiling)', model: 'sonnet' },
    { title: 'Review', detail: 'one Sonnet worker per area plus one architecture worker', model: 'sonnet' },
    { title: 'Consolidate', detail: 'one Fable critic verifies, writes the report, consolidates', model: 'fable' },
  ],
}

// Bounded by construction. The scout sizes the number of areas N to the repo, and
// the script hard-clamps N to MAX_AREAS, so a run is 1 scout + (N area workers +
// 1 architecture worker) + 1 critic = N + 3 agents, with N <= MAX_AREAS. The
// count scales with repo size but never exceeds MAX_AREAS + 3, no matter how
// large the repo is or how many areas the scout proposes. There is no per-file
// fan-out and no loop. Models and effort are pinned per stage, so the
// session model and effort never leak into the scout or the workers; the
// single critic runs Fable 5 at xhigh effort (flip its model pin to 'opus'
// under the Opus 4.8 fallback, see team-guide).
//
// When the repo is too big for MAX_AREAS areas to cover, the leftover paths are
// reported (coverage.ceilingReached, coverage.areasDropped, and a suggested next
// action), never silently skipped, so the caller can re-run with a higher cap or
// a scoped path.
//
// Invoke with optional args:
//   Workflow({ name: 'tm-review-codebase', args: { path: 'src', areas: 24 } })

// args may arrive as an object or, depending on the caller, as a JSON string.
// Normalize so { path, areas } work either way.
function parseArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string' && a.trim()) {
    try {
      return JSON.parse(a)
    } catch {
      return {}
    }
  }
  return {}
}
const opts = parseArgs(args)
// Validate root against path-safe chars; fall back to '.' if it contains shell
// metacharacters. Protects both the git command string and the agent prompts
// that interpolate the value.
function safeRef(value, fallback) {
  return typeof value === 'string' && /^[\w.~^\/\-]+$/.test(value) && !value.includes('..') ? value : fallback
}
const root = safeRef(opts.path, '.')
const MAX_AREAS = Number.isInteger(opts.areas) && opts.areas > 0 ? opts.areas : 24

// FINDING and FINDINGS_SCHEMA are a shared base intentionally duplicated with
// tm-review-changes.js (the workflow runtime has no shared imports); this copy
// adds `area` and `dimension`. Keep the two definitions in sync.
const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    dimension: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'string', description: 'line number or range, or "n/a"' },
    severity: { type: 'string', enum: ['must-fix', 'should-fix', 'nit'] },
    problem: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['area', 'dimension', 'file', 'line', 'severity', 'problem', 'fix'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { findings: { type: 'array', items: FINDING } },
  required: ['findings'],
}

const AREA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'directories or globs that make up this area',
    },
    why: { type: 'string', description: 'why this is one coherent area and how it ranks' },
  },
  required: ['name', 'paths', 'why'],
}

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    areas: { type: 'array', items: AREA },
    dropped: {
      type: 'array',
      items: { type: 'string' },
      description: 'paths left uncovered because the repo exceeded the area ceiling',
    },
  },
  required: ['areas', 'dropped'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes-requested'] },
    summary: { type: 'string' },
    reportPath: { type: 'string' },
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
    coverage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        areasReviewed: { type: 'array', items: { type: 'string' } },
        areasDropped: { type: 'array', items: { type: 'string' } },
        workersFailed: { type: 'array', items: { type: 'string' } },
        ceilingReached: { type: 'boolean' },
        suggestedNextAction: {
          type: 'string',
          description: 'precomputed by the orchestrator and returned unchanged; present only when ceilingReached is true',
        },
      },
      required: ['areasReviewed', 'areasDropped', 'workersFailed', 'ceilingReached'],
    },
  },
  required: ['verdict', 'summary', 'reportPath', 'mustFix', 'shouldFix', 'nits', 'coverage'],
}

const scope = `Work from the repo root scoped to "${root}". List source files with \`git ls-files -- ${root}\` (it already respects .gitignore); ignore vendored and generated trees (node_modules, dist, build, vendor, .git, coverage) and lockfiles.`

// This list stays at five and does not track tm-review-changes.js's dimension
// list: docs and perf there are diff-scoped (they need to know what changed).
// Here, doc drift is covered repo-wide by the architecture worker below, and
// there is no repo-wide perf dimension.
const dimensions = `Review across these dimensions:
- bugs: adversarial correctness. Logic errors, wrong or missing edge-case handling, broken error paths, races and ordering bugs, off-by-one, misused or wrongly-assumed APIs, null and boundary handling, resource leaks.
- security: untrusted input reaching a sink (injection, path traversal, SSRF, unsafe deserialization), missing authn or authz, secrets or credentials in code or logs, unsafe defaults, weak crypto, risky dependencies.
- scope: speculative abstraction, dead configurability, code that could be much smaller.
- tests: behavior with no test pinning it, logic with a right answer lacking a test, integration points with no fixture coverage.
- style: project code and writing style (em dashes, AI-cliche phrases, hard-coded user-facing strings, raw primitives where dedicated types exist, comments that restate code).`

phase('Scout')
const map = await agent(
  `You map a repository into coherent review areas. You do not review code in this step.\n\n${scope}\n\nFirst gauge the repo's size (for example \`git ls-files -- ${root} | wc -l\`). Then split the files into N coherent areas, where an area is a set of files that belong together (a module, package, or directory subtree) and is small enough to read in one pass. Size N to the repo: make one area per top-level module or per a few thousand lines of related code, using as few areas as cover it well. Do NOT split finer just to use the budget; only a genuinely large codebase should approach ${MAX_AREAS} areas. Return at most ${MAX_AREAS} areas, ranked by importance (size and how central they are to the system). If the repo is larger than ${MAX_AREAS} areas can cover at a readable size, return the ${MAX_AREAS} most important and put every path you cannot fit in "dropped" so it is reported, not lost. Return areas (name, paths, why) and dropped.`,
  { label: 'scout', phase: 'Scout', model: 'sonnet', effort: 'high', schema: MAP_SCHEMA }
)

// If the scout fails, no area workers run; flag it so the critic cannot approve
// a review where only the architecture worker saw the repo.
const scoutFailed = !map || !Array.isArray(map.areas)
const allAreas = scoutFailed ? [] : map.areas
// Hard ceiling: never spawn more than MAX_AREAS area workers, even if the scout
// returns more. Overflow areas are reported as dropped, not silently lost, so the
// N + 3 bound holds by construction rather than by the scout obeying the prompt.
const areas = allAreas.slice(0, MAX_AREAS)
// Two distinct shortfall causes, tracked separately so the remedy matches the
// cause: script overflow (the scout returned more than MAX_AREAS areas, so the
// script clamped the extras) versus scout self-drop (the scout itself could not
// fit some paths into MAX_AREAS readable areas). scoutDropped is their union, for
// the single coverage list the schema reports.
const scriptOverflow = allAreas.slice(MAX_AREAS).map((a) => a.name)
const scoutSelfDropped = scoutFailed ? [] : Array.isArray(map.dropped) ? map.dropped : []
const scoutDropped = scoutSelfDropped.concat(scriptOverflow)

phase('Review')
const repoMap = areas.map((a) => `- ${a.name}: ${a.paths.join(', ')}`).join('\n')

const reviewThunks = areas.map((a) => () =>
  agent(
    `You review one area of a codebase and report findings only. You never edit.\n\nArea: ${a.name}\nPaths: ${a.paths.join(', ')}\n\nRead these files in full, with surrounding context where needed. ${dimensions}\n\nReport every finding with area ("${a.name}"), dimension, file, line, severity (must-fix | should-fix | nit), the problem, and the required fix. If the area is clean, return an empty findings array. Stay within your area.`,
    { label: `area:${a.name}`, phase: 'Review', model: 'sonnet', effort: 'high', schema: FINDINGS_SCHEMA }
  )
)

reviewThunks.push(() =>
  agent(
    `You audit a repository's structure and report findings only. You never edit. Use dimension "architecture".\n\n${scope}\n\nRead the directory layout, module boundaries, imports, and dependency manifests. Read signatures and imports rather than full file bodies, so you can hold the whole tree in view. The area map is:\n${repoMap}\n\nFlag: module boundaries and layering that have drifted, the same logic duplicated across modules, dead or orphaned code, dependency health (unused, outdated, risky), test-coverage gaps at the suite level, and doc drift between README/CLAUDE.md claims and the actual repo state (commands that no longer exist, a described layout that does not match the real one, stale status claims). Report each finding with area (the module name or "repo"), dimension ("architecture"), file, line or "n/a", severity, the problem, and the fix.`,
    { label: 'architecture', phase: 'Review', model: 'sonnet', effort: 'high', schema: FINDINGS_SCHEMA }
  )
)

const reviews = await parallel(reviewThunks)
const areaResults = reviews.slice(0, areas.length)
const archResult = reviews[areas.length]

// parallel() null-pads a worker that errors or is skipped. Track which workers
// actually returned so the critic knows where coverage is partial.
const reviewedAreas = areas.filter((_, i) => areaResults[i]).map((a) => a.name)
const workersFailed = areas
  .filter((_, i) => !areaResults[i])
  .map((a) => a.name)
  .concat(archResult ? [] : ['architecture'])
  .concat(scoutFailed ? ['scout (returned no area map; no area workers ran)'] : [])

const raw = areaResults
  .filter(Boolean)
  .flatMap((r) => r.findings)
  .concat(archResult ? archResult.findings : [])

// A non-empty scoutDropped means the repo did not fully fit; word the remedy to
// the cause (raising the cap fixes a clamp, but not a scout that already judged
// the repo too big for MAX_AREAS readable areas).
const ceilingReached = scoutDropped.length > 0
const suggestedNextAction = !ceilingReached
  ? ''
  : scriptOverflow.length
    ? `Coverage is partial: the scout proposed more than the ${MAX_AREAS}-area ceiling, so ${scriptOverflow.length} area(s) were clamped. Re-run with a higher cap (args.areas: ${MAX_AREAS * 2}). Clamped: ${scriptOverflow.join(', ')}.`
    : `Coverage is partial: the repo is larger than ${MAX_AREAS} areas can cover at a readable size, so the scout left ${scoutSelfDropped.length} path(s) out. Scope follow-up runs to the leftover with args.path, or raise the cap (args.areas) if those areas are small. Uncovered: ${scoutSelfDropped.join(', ')}.`

phase('Consolidate')
const coverageNote =
  (scoutFailed
    ? ` CRITICAL: the scout returned no valid area map, so NO area workers ran and only the architecture worker saw the repo. This is a failed, not a clean, review: do not return approve on this basis; report it as incomplete and advise re-running.`
    : '') +
  (!scoutFailed && areas.length === 0
    ? ` CRITICAL: the scout returned zero areas, so NO area workers ran and only the architecture worker saw the repo. Treat this as architecture-only and incomplete, not a clean review; do not return approve on this basis.`
    : '') +
  (workersFailed.length
    ? ` These workers did not return, so their scope is NOT covered: ${workersFailed.join(', ')}.`
    : '') +
  // Gate on any dropped path (union of self-drop and overflow), not only
  // ceilingReached, so self-drop cases are also surfaced to the critic.
  (scoutDropped.length ? ` COVERAGE IS PARTIAL. ${suggestedNextAction}` : '')

const suggestedNextActionClause = ceilingReached
  ? `, and coverage.suggestedNextAction to ${JSON.stringify(suggestedNextAction)}`
  : ''

const report = await agent(
  `You are the senior reviewer consolidating a full-codebase review. The workers below produced the raw findings.${coverageNote}\n\nVerify each finding against the actual code, drop false positives and anything out of scope, merge duplicates (including the same problem found in two areas), and set a final severity. You may add a finding only if it is a clear must-fix the workers missed. Only must-fix findings block: verdict is changes-requested if any remain, approve otherwise. Record every dropped finding under dismissed with the reason.\n\nThen write the report file. Run \`date +%F\` for today's date, make the docs/reviews/ directory if it does not exist, and write docs/reviews/<date>-codebase-review.md with: the verdict and summary first; then a one-line health impression scored 0-10 and up to three named top risks; then, if coverage is partial, a prominent "Coverage: PARTIAL" callout immediately after that opening block that states how many paths were not reviewed and the suggested next action; then the findings as severity sections (must-fix, then should-fix, then nit), each organized by area; then a final "Coverage" section listing the areas reviewed, the paths not covered, the workers that failed, and (if partial) the suggested next action. Set reportPath to the file you wrote.\n\nReturn the structured summary. Set coverage.areasReviewed to ${JSON.stringify(reviewedAreas)}, coverage.areasDropped to ${JSON.stringify(scoutDropped)}, coverage.workersFailed to ${JSON.stringify(workersFailed)}, coverage.ceilingReached to ${ceilingReached}${suggestedNextActionClause}.\n\nRaw findings (JSON):\n${JSON.stringify(raw, null, 2)}`,
  { label: 'consolidate', phase: 'Consolidate', model: 'fable', effort: 'xhigh', schema: REPORT_SCHEMA }
)

return report
