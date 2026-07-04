export const meta = {
  name: 'tm-map-codebase',
  description:
    'Token-bounded full-repo map: a Sonnet scout splits the repo into N coherent areas (N sized to the repo, capped at a ceiling), one Sonnet worker maps each area (purpose, entry points, key modules, data and control flow, external dependencies, conventions), and one Fable critic synthesizes a dated architecture map. Models are pinned per stage in-script, so it never inherits the session model, and the agent count scales with repo size only up to a hard ceiling. This is a map, not a review: no findings, no severities, no recommendations.',
  phases: [
    { title: 'Scout', detail: 'one Sonnet agent splits the repo into N areas (N <= ceiling)', model: 'sonnet' },
    { title: 'Map', detail: 'one Sonnet worker per area describes it', model: 'sonnet' },
    { title: 'Synthesize', detail: 'one Fable critic writes the consolidated map', model: 'fable' },
  ],
}

// Bounded by construction. The scout sizes the number of areas N to the repo, and
// the script hard-clamps N to MAX_AREAS, so a run is 1 scout + N area workers +
// 1 critic = N + 2 agents, with N <= MAX_AREAS. The count scales with repo size
// but never exceeds MAX_AREAS + 2, no matter how large the repo is or how many
// areas the scout proposes. There is no per-file fan-out and no loop. Models and
// effort are pinned per stage, so the session model and effort never leak into
// the scout or the workers; the single critic runs Fable 5 at xhigh effort (flip
// its model pin to 'opus' under the Opus 4.8 fallback, see team-guide).
//
// When the repo is too big for MAX_AREAS areas to cover, the leftover paths are
// reported (coverage.areasDropped, coverage.ceilingReached, and a suggested next
// action), never silently skipped, so the caller can re-run with a higher cap or
// a scoped path.
//
// This workflow maps, it does not review: workers describe purpose, structure,
// and flow, never quality or security findings. That is tm-review-codebase's job.
//
// Invoke with optional args:
//   Workflow({ name: 'tm-map-codebase', args: { path: 'src', areas: 24 } })

// args may arrive as an object or, depending on the caller, as a JSON string.
// Normalize so { path, areas } work either way.
// Duplicated byte-for-byte from tm-review-codebase.js (the workflow runtime has
// no shared imports); keep this copy in sync, see helpers.test.mjs.
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
// Duplicated byte-for-byte from tm-review-codebase.js; keep this copy in sync,
// see helpers.test.mjs.
function safeRef(value, fallback) {
  return typeof value === 'string' && /^[\w.~^\/\-]+$/.test(value) && !value.includes('..') ? value : fallback
}
const root = safeRef(opts.path, '.')
const MAX_AREAS = Number.isInteger(opts.areas) && opts.areas > 0 ? opts.areas : 24

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

const AREA_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    purpose: { type: 'string', description: 'what this area is for, in plain terms' },
    entryPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'files or exports where execution or usage of this area starts',
    },
    keyModules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          role: { type: 'string', description: 'one-line description of what this module does' },
        },
        required: ['name', 'role'],
      },
    },
    dataFlow: { type: 'string', description: 'how data moves through this area' },
    controlFlow: { type: 'string', description: 'how control moves through this area (call order, triggers, lifecycle)' },
    externalDependencies: {
      type: 'array',
      items: { type: 'string' },
      description: 'packages, services, or other areas this area depends on',
    },
    conventions: { type: 'string', description: 'naming, structure, or style conventions specific to this area' },
  },
  required: [
    'area',
    'purpose',
    'entryPoints',
    'keyModules',
    'dataFlow',
    'controlFlow',
    'externalDependencies',
    'conventions',
  ],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    reportPath: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    coverage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        areasMapped: { type: 'array', items: { type: 'string' } },
        areasDropped: { type: 'array', items: { type: 'string' } },
        workersFailed: { type: 'array', items: { type: 'string' } },
        ceilingReached: { type: 'boolean' },
        suggestedNextAction: {
          type: 'string',
          description: 'precomputed by the orchestrator and returned unchanged; present only when ceilingReached is true',
        },
      },
      required: ['areasMapped', 'areasDropped', 'workersFailed', 'ceilingReached'],
    },
  },
  required: ['summary', 'reportPath', 'openQuestions', 'coverage'],
}

const scope = `Work from the repo root scoped to "${root}". List source files with \`git ls-files -- ${root}\` (it already respects .gitignore); ignore vendored and generated trees (node_modules, dist, build, vendor, .git, coverage) and lockfiles.`

phase('Scout')
const map = await agent(
  `You map a repository into coherent areas for a codebase map (not a review). You do not describe or evaluate code content in this step, only structure.\n\n${scope}\n\nFirst gauge the repo's size (for example \`git ls-files -- ${root} | wc -l\`). Then split the files into N coherent areas, where an area is a set of files that belong together (a module, package, or directory subtree) and is small enough to read in one pass. Size N to the repo: make one area per top-level module or per a few thousand lines of related code, using as few areas as cover it well. Do NOT split finer just to use the budget; only a genuinely large codebase should approach ${MAX_AREAS} areas. Return at most ${MAX_AREAS} areas, ranked by importance (size and how central they are to the system). If the repo is larger than ${MAX_AREAS} areas can cover at a readable size, return the ${MAX_AREAS} most important and put every path you cannot fit in "dropped" so it is reported, not lost. Return areas (name, paths, why) and dropped.`,
  { label: 'scout', phase: 'Scout', model: 'sonnet', effort: 'high', schema: MAP_SCHEMA }
)

// If the scout fails, no area workers run; flag it so the critic cannot
// synthesize a map from an empty area set.
const scoutFailed = !map || !Array.isArray(map.areas)
const allAreas = scoutFailed ? [] : map.areas
// Hard ceiling: never spawn more than MAX_AREAS area workers, even if the scout
// returns more. Overflow areas are reported as dropped, not silently lost, so the
// N + 2 bound holds by construction rather than by the scout obeying the prompt.
const areas = allAreas.slice(0, MAX_AREAS)
// Two distinct shortfall causes, tracked separately so the remedy matches the
// cause: script overflow (the scout returned more than MAX_AREAS areas, so the
// script clamped the extras) versus scout self-drop (the scout itself could not
// fit some paths into MAX_AREAS readable areas). scoutDropped is their union, for
// the single coverage list the schema reports.
const scriptOverflow = allAreas.slice(MAX_AREAS).map((a) => a.name)
const scoutSelfDropped = scoutFailed ? [] : Array.isArray(map.dropped) ? map.dropped : []
const scoutDropped = scoutSelfDropped.concat(scriptOverflow)

phase('Map')
const repoMap = areas.map((a) => `- ${a.name}: ${a.paths.join(', ')}`).join('\n')

const mapThunks = areas.map((a) => () =>
  agent(
    `You map one area of a codebase. You describe, you do not evaluate: no findings, no severities, no recommendations, no quality or security judgments. You never edit.\n\nArea: ${a.name}\nPaths: ${a.paths.join(', ')}\n\nOther areas in this repo, for context on dependencies:\n${repoMap}\n\nRead these files in full, with surrounding context where needed. Describe:\n- purpose: what this area is for, in plain terms.\n- entryPoints: files or exports where execution or usage of this area starts.\n- keyModules: the modules that matter, each with a one-line role.\n- dataFlow: how data moves through this area.\n- controlFlow: how control moves through this area (call order, triggers, lifecycle).\n- externalDependencies: packages, services, or other areas this area depends on.\n- conventions: naming, structure, or style conventions specific to this area.\n\nSet area to "${a.name}". Stay within your area. Do not report findings, severities, or fixes; this is a map, not a review.`,
    { label: `area:${a.name}`, phase: 'Map', model: 'sonnet', effort: 'high', schema: AREA_MAP_SCHEMA }
  )
)

const results = await parallel(mapThunks)

// parallel() null-pads a worker that errors or is skipped. Track which workers
// actually returned so the critic knows where coverage is partial.
const mappedAreas = areas.filter((_, i) => results[i]).map((a) => a.name)
const workersFailed = areas
  .filter((_, i) => !results[i])
  .map((a) => a.name)
  .concat(scoutFailed ? ['scout (returned no area map; no area workers ran)'] : [])

const raw = results.filter(Boolean)

// A non-empty scoutDropped means the repo did not fully fit; word the remedy to
// the cause (raising the cap fixes a clamp, but not a scout that already judged
// the repo too big for MAX_AREAS readable areas).
const ceilingReached = scoutDropped.length > 0
const suggestedNextAction = !ceilingReached
  ? ''
  : scriptOverflow.length
    ? `Coverage is partial: the scout proposed more than the ${MAX_AREAS}-area ceiling, so ${scriptOverflow.length} area(s) were clamped. Re-run with a higher cap (args.areas: ${MAX_AREAS * 2}). Clamped: ${scriptOverflow.join(', ')}.`
    : `Coverage is partial: the repo is larger than ${MAX_AREAS} areas can cover at a readable size, so the scout left ${scoutSelfDropped.length} path(s) out. Scope follow-up runs to the leftover with args.path, or raise the cap (args.areas) if those areas are small. Uncovered: ${scoutSelfDropped.join(', ')}.`

phase('Synthesize')
const coverageNote =
  (scoutFailed
    ? ` CRITICAL: the scout returned no valid area map, so NO area workers ran. This is a failed, not a complete, mapping run: do not present this as covering the repo; report it as incomplete and advise re-running.`
    : '') +
  (!scoutFailed && areas.length === 0
    ? ` CRITICAL: the scout returned zero areas, so NO area workers ran. Treat this as incomplete, not a full map.`
    : '') +
  (workersFailed.length
    ? ` These workers did not return, so their area is NOT covered: ${workersFailed.join(', ')}.`
    : '') +
  // Gate on any dropped path (union of self-drop and overflow), not only
  // ceilingReached, so self-drop cases are also surfaced to the critic.
  (scoutDropped.length ? ` COVERAGE IS PARTIAL. ${suggestedNextAction}` : '')

const suggestedNextActionClause = ceilingReached
  ? `, and coverage.suggestedNextAction to ${JSON.stringify(suggestedNextAction)}`
  : ''

const report = await agent(
  `You are the senior architect synthesizing a full-codebase map from the area descriptions below. This is a map, not a review: do not add findings, severities, recommendations, or quality and security judgments. Describe what is there.${coverageNote}\n\nRun \`date +%F\` for today's date, make the docs/architecture/ directory if it does not exist, and write docs/architecture/<date>-codebase-map.md with exactly these sections, in this order:\n1. Executive summary: what the repo is and how its areas fit together, in a few paragraphs.\n2. Component table: one row per area, with columns for area, purpose, and key modules.\n3. Data-flow narrative: how data moves across areas, end to end.\n4. Dependency summary: external dependencies (packages, services) and cross-area dependencies.\n5. Open questions: anything the workers could not determine or that needs a human to confirm.\n\nIf coverage is partial, add a "Coverage" callout immediately after the executive summary stating how many paths were not mapped and the suggested next action.\n\nSet reportPath to the file you wrote. Set summary to a short plain-language summary of the whole repo. Set openQuestions to the same list you put in the report's Open Questions section.\n\nSet coverage.areasMapped to ${JSON.stringify(mappedAreas)}, coverage.areasDropped to ${JSON.stringify(scoutDropped)}, coverage.workersFailed to ${JSON.stringify(workersFailed)}, coverage.ceilingReached to ${ceilingReached}${suggestedNextActionClause}.\n\nArea maps (JSON):\n${JSON.stringify(raw, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', model: 'fable', effort: 'xhigh', schema: REPORT_SCHEMA }
)

return report
