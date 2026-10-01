// Workflow spec (embedded; mirrors specs/tm-review-changes.spec.json)
// The spec encodes the fan-out as data: stages, tiers, parallelism, schemas,
// and fallbacks. The JS renderer reads SPEC to drive agent()/parallel()/phase()
// calls. A host adapter on another platform reads the JSON spec file directly.
// See docs/architecture/adapter-interface.md section "Spec format".
// The spec-sync test (specs.test.mjs) asserts this constant matches the JSON.
const SPEC = {
  name: 'tm-review-changes',
  description:
    'Token-bounded code review: Sonnet workers review the diff across fixed dimensions, one Opus critic consolidates. Models are pinned per stage in-script, so it never inherits the session model or fans out unboundedly.',
  phases: [
    { title: 'Review', detail: 'one Sonnet worker per dimension', tier: 'worker' },
    { title: 'Verify', detail: 'one adversarial Sonnet worker per must-fix finding, capped', tier: 'worker' },
    { title: 'Consolidate', detail: 'one Opus critic verifies and merges findings', tier: 'judgment' },
  ],
  stages: {
    review: {
      phase: 'Review',
      tier: 'worker',
      parallelism: 'fixed-list',
      items_key: 'dimensions',
      item_label_prefix: 'review:',
      schema: 'FINDINGS_SCHEMA',
      fallback: null,
    },
    verify: {
      phase: 'Verify',
      tier: 'worker',
      parallelism: 'dynamic-list',
      items_source: 'review_result',
      items_transform: 'must_fix_deduped',
      items_cap: 'args.maxVerify',
      items_default_cap: 12,
      item_label_prefix: 'verify:',
      schema: 'VERIFY_SCHEMA',
      fallback: null,
    },
    consolidate: {
      phase: 'Consolidate',
      tier: 'judgment',
      parallelism: 'single',
      label: 'consolidate',
      schema: 'REPORT_SCHEMA',
      fallback: { from_tier: 'judgment', to_tier: 'worker', preserve_effort: true },
    },
  },
}

// Resolve a tier to a model+effort via the adapter table. The adapter table
// (.claude/adapters/claude-code.json) is the single source of truth; the SPEC
// references tiers, never model names. On Claude Code the resolution is
// inlined here because the workflow runtime has no imports.
const TIER_MODELS = { judgment: 'opus', worker: 'sonnet', lead: 'opus' }
const TIER_EFFORTS = { judgment: 'xhigh', worker: 'high', lead: 'xhigh' }

export const meta = {
  name: SPEC.name,
  description: SPEC.description,
  phases: SPEC.phases.map((p) => ({
    title: p.title,
    detail: p.detail,
    // The adapter table resolves the tier to a concrete model for the
    // Claude Code host. meta.phases carries the model for display purposes.
    model: TIER_MODELS[p.tier],
  })),
}

// Bounded by construction. The dimension list is fixed, there is no per-file
// fan-out and no loop, so a run is DIMENSIONS.length Sonnet reviewers, plus one
// Sonnet verifier per must-fix finding (at most min(must-fix count, MAX_VERIFY),
// the cap is what keeps this bounded), plus one Opus critic. It cannot become
// the 100-agent fan-out that an unpinned session-model review produces. Models
// and effort are pinned per
// stage, so the session model and effort never leak into the workers; the
// single critic runs Opus at xhigh effort and auto-retries once on sonnet
// at the same effort if Opus returns nothing (criticWithFallback below;
// see team-guide for the lead-level fallback, which is still manual).
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
// Cap on verifier dispatches, same coercion as MAX_AREAS in tm-map-codebase.js.
const MAX_VERIFY =
  args && Number.isInteger(args.maxVerify) && args.maxVerify > 0 ? args.maxVerify : SPEC.stages.verify.items_default_cap

// Flatten worker reports to the unique must-fix findings, deduped on file +
// line + problem. Mirrors ITEM_TRANSFORMS.must_fix_deduped in the Hermes and
// Codex renderers. parallel() null-pads a dead worker, and a report may carry
// no findings array, so both are skipped.
function mustFixDeduped(reports) {
  const seen = new Set()
  const out = []
  for (const report of reports) {
    if (!report || !Array.isArray(report.findings)) continue
    for (const f of report.findings) {
      if (!f || f.severity !== 'must-fix') continue
      const key = JSON.stringify([f.file, f.line, f.problem])
      if (seen.has(key)) continue
      seen.add(key)
      out.push(f)
    }
  }
  return out
}

// The script, not the critic, owns `refuted` and `unverified`: they are set
// from the verify stage's own data, and any must-fix the verifiers refuted is
// stripped from mustFix by file + line + problem. Returns a new object (same
// reason as criticWithFallback: the runtime's result could be frozen). A report
// with no mustFix array (the render-path stub) is left without one. The verdict
// is recomputed to approve when only refuted findings were removed.
function finalizeReport(report, refuted, unverified) {
  const out = { ...report, refuted, unverified }
  if (Array.isArray(report.mustFix)) {
    const gone = new Set(refuted.map((f) => JSON.stringify([f.file, f.line, f.problem])))
    out.mustFix = report.mustFix.filter((f) => !gone.has(JSON.stringify([f.file, f.line, f.problem])))
    if (out.mustFix.length === 0 && report.mustFix.length > 0) out.verdict = 'approve'
  }
  return out
}

// Duplicated byte-for-byte across the three tm- workflows that run an Opus
// critic (the workflow runtime has no shared imports); keep this copy in
// sync, see helpers.test.mjs.
async function criticWithFallback(prompt, opts) {
  const first = await agent(prompt, opts)
  // agent() returns null both when the model errors out after retries (for
  // example Opus quota exhaustion) and when the user skips the dispatch
  // mid-run. Nothing in this script can tell those two cases apart, so there
  // is no heuristic to invent here. The ruling is on which failure mode is
  // worse: retrying a deliberate skip costs one extra skip prompt (the retry
  // is itself an agent() call, so skipping again just returns null and the
  // run ends below with a clear error), while not retrying a quota death
  // costs the entire unattended run. Retry unconditionally.
  //
  // The fallback model is resolved from the SPEC's fallback.to_tier via the
  // adapter table by the caller and passed as opts.fallbackModel. This keeps
  // the function host-neutral: no hardcoded model names (issue #317).
  if (first) return first
  const fb = opts.fallbackModel
  log(
    `${opts.label}: the ${opts.model} critic returned nothing. This could be quota exhaustion or a manual skip; retrying once on ${fb} at the same effort. Skipping again will end the run.`
  )
  const second = await agent(
    `${prompt}\n\nNOTE: this is a retry on the ${fb} fallback after the ${opts.model} critic returned nothing (quota or a skip). If you write a report file, record in it that this fallback produced it.`,
    { ...opts, model: fb }
  )
  if (!second) throw new Error(`${opts.label}: both the ${opts.model} critic and the ${fb} fallback returned nothing.`)
  log(`${opts.label}: this critique was produced by the ${fb} fallback, not ${opts.model}.`)
  // Return a new object rather than mutating `second`: the runtime's returned
  // object could be frozen or sealed, in which case mutating it would either
  // silently drop the `modelFallback` marker (sloppy mode) or throw a
  // TypeError.
  return { ...second, modelFallback: `${opts.model} -> ${fb}` }
}

// This list is diff-scoped and intentionally longer than tm-review-codebase's
// per-area dimension list: docs and perf need diff context (what changed, and
// whether the matching doc or hot path moved with it) that a whole-repo area
// pass does not have. tm-review-codebase covers doc drift repo-wide through
// its architecture worker instead; see that file's `dimensions` comment.
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
  {
    key: 'docs',
    brief:
      'Doc drift introduced by this diff. Behavior, commands, or config that changed with no matching update to README, CLAUDE.md, or the relevant spec under docs/. Enforces the CLAUDE.md rule that when code and a doc disagree, the doc is corrected in the same PR. Flag only drift this diff introduces, not pre-existing gaps.',
  },
  {
    key: 'perf',
    brief:
      'Performance regressions introduced by this diff. Algorithmic complexity regressions, N+1 query patterns, unnecessary work in hot paths, unbounded memory growth.',
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

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    confirmed: { type: 'boolean', description: 'true only if the finding was reproduced against the current tree' },
    note: { type: 'string', description: 'what was checked and what was found' },
  },
  required: ['confirmed', 'note'],
}

const REFUTED_FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: { ...FINDING.properties, note: { type: 'string', description: "the verifier's note" } },
  required: [...FINDING.required, 'note'],
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
    refuted: {
      type: 'array',
      items: REFUTED_FINDING,
      description: 'set by the script from the verify stage (a verifier could not reproduce these); leave empty',
    },
    unverified: {
      type: 'array',
      items: FINDING,
      description: 'set by the script (past the verify cap, or the verifier returned nothing); leave empty',
    },
  },
  required: ['verdict', 'summary', 'mustFix', 'shouldFix', 'nits'],
}

const diffHint =
  `Get the change under review with \`git diff ${base}...HEAD\` for committed work on the branch, and \`git diff\` plus \`git status\` for any uncommitted changes; review the union. Read surrounding code before judging, and do not flag what the diff does not touch.`

// Prompt templates (embedded; mirrors prompts/tm-review-changes.prompts.json).
// Plain strings with {{slot}} markers, not template literals with ${expr},
// so the prompts-sync test can parse this const via node:vm and deep-equal
// it to the JSON file the same way specs.test.mjs parses SPEC. The
// renderPrompt helper swaps {{slot}} for vals[slot] at the call site;
// runtime-assembled values (coverageNote, rawFindings) are plugged in there.
const PROMPTS = {
  review:
    'You review one dimension of a code change and report findings only; you never edit.\n\nDimension: {{brief}}\n\n{{diffHint}}\n\nReport every finding with file, line, severity (must-fix | should-fix | nit), the problem, and the required fix. If the dimension is clean, return an empty findings array. Stay strictly within your dimension.\n\nSeverity floor: if a finding you report matches one of these conditions, its severity is must-fix, whatever your overall read. 1. A test deleted, skipped or weakened, without the PR body saying why. 2. `--no-verify`, or any other bypassed git hook. 3. A new dependency with no justification in the PR body. 4. A CI job with no `timeout-minutes`, or a workflow with no `concurrency` group carrying `cancel-in-progress: true`. 5. A change touching the full stack, shipped without e2e.',
  verify:
    'You are an adversarial verifier. A reviewer reported the finding below as must-fix. Start from the position that it is wrong or stale. It survives only if you can reproduce it against the current tree: open the file at the cited line, read the surrounding code, and show the problem is real. "Cannot reproduce", "already fixed" and "the evidence does not hold" all mean confirmed: false. You report only; you never edit.\n\n{{diffHint}}\n\nFinding (JSON):\n{{finding}}\n\nReturn confirmed (true only if you reproduced the problem) and a note of one or two sentences naming what you checked and what you found.',
  consolidate:
    'You are the senior reviewer. {{coveredCount}} parallel reviewers produced the findings below.{{coverageNote}} {{diffHint}}\n\nEvery must-fix finding went through an adversarial verification pass against the current tree, so must-fix findings arrive in three groups. Confirmed: a verifier reproduced the finding; keep it as must-fix unless the diff shows otherwise. Refuted: a verifier could not reproduce it; do not report it as must-fix and do not repeat it in any field, because the script lists refuted findings in the report. Unverified: no verifier checked it (cap reached or the verifier returned nothing); judge each against the actual diff yourself. For the confirmed, unverified and raw findings: verify against the actual diff, drop false positives and anything out of scope, merge duplicates, and set a final severity. You may add a finding only if it is a clear must-fix the reviewers missed. Severity floor: any finding that matches one of these conditions is must-fix, whatever your overall read. 1. A test deleted, skipped or weakened, without the PR body saying why. 2. `--no-verify`, or any other bypassed git hook. 3. A new dependency with no justification in the PR body. 4. A CI job with no `timeout-minutes`, or a workflow with no `concurrency` group carrying `cancel-in-progress: true`. 5. A change touching the full stack, shipped without e2e. A floor finding cannot be downgraded to should-fix or nit, but you may still dismiss it if it is false on the facts, with the reason under dismissed. Only must-fix findings block: verdict is changes-requested if any remain, approve otherwise. Record every dropped finding under dismissed with the reason.\n\nConfirmed must-fix findings (JSON):\n{{confirmedFindings}}\n\nRefuted must-fix findings (JSON, with the verifier note):\n{{refutedFindings}}\n\nUnverified must-fix findings (JSON):\n{{unverifiedFindings}}\n\nRaw should-fix and nit findings (JSON):\n{{rawFindings}}',
}

// Replace {{slot}} markers with vals[slot]; throw on unknown slot.
function renderPrompt(template, vals) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vals)) throw new Error(`renderPrompt: unknown slot "${key}"`)
    return vals[key]
  })
}

// Render: fan out from the spec
// Stage: review (parallel, fixed-list of dimensions, worker tier)
const reviewStage = SPEC.stages.review
phase(reviewStage.phase)
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(
      renderPrompt(PROMPTS.review, { brief: d.brief, diffHint }),
      { label: `${reviewStage.item_label_prefix}${d.key}`, phase: reviewStage.phase, model: TIER_MODELS[reviewStage.tier], effort: TIER_EFFORTS[reviewStage.tier], schema: FINDINGS_SCHEMA }
    )
  )
)

// Only should-fix and nit findings go to the critic raw; must-fix findings
// reach it through the verify stage below. A report with no findings array
// (the render-path stub) contributes nothing.
const raw = reviews
  .filter(Boolean)
  .flatMap((r) => (Array.isArray(r.findings) ? r.findings : []))
  .filter((f) => f.severity !== 'must-fix')

// parallel() null-pads a worker that errors or is skipped, so a dead reviewer
// would otherwise drop its whole dimension while the critic assumes full
// coverage. Track which dimensions actually reported.
const covered = DIMENSIONS.filter((_, i) => reviews[i])
const dropped = DIMENSIONS.filter((_, i) => !reviews[i])
const reviewNote = dropped.length
  ? ` ${dropped.length} reviewer(s) did not return, so these dimensions are NOT covered: ${dropped.map((d) => d.key).join(', ')}. Treat the review as partial and say so in your summary.`
  : ''

// Stage: verify (parallel, dynamic-list of must-fix findings, worker tier).
// Items are the reviewers' must-fix findings, deduped, then capped at
// MAX_VERIFY. Findings past the cap are reported as unverified, not dropped.
const verifyStage = SPEC.stages.verify
phase(verifyStage.phase)
const allMustFix = mustFixDeduped(reviews)
const toVerify = allMustFix.slice(0, MAX_VERIFY)
const overflow = allMustFix.slice(MAX_VERIFY)
let verdicts = []
if (toVerify.length === 0) {
  log('verify: no must-fix findings, skipping the verify stage')
} else {
  verdicts = await parallel(
    toVerify.map((f) => () =>
      agent(
        renderPrompt(PROMPTS.verify, { finding: JSON.stringify(f, null, 2), diffHint }),
        { label: `${verifyStage.item_label_prefix}${f.file}:${f.line}`, phase: verifyStage.phase, model: TIER_MODELS[verifyStage.tier], effort: TIER_EFFORTS[verifyStage.tier], schema: VERIFY_SCHEMA }
      )
    )
  )
}

// A dead verifier is unverified, never refuted: parallel() null-pads, and
// treating a null verdict as a refutation would silently drop a must-fix.
// A verdict whose `confirmed` is not a boolean is treated the same way.
const confirmed = []
const refuted = []
const unverified = [...overflow]
toVerify.forEach((f, i) => {
  const v = verdicts[i]
  if (!v || typeof v.confirmed !== 'boolean') unverified.push(f)
  else if (v.confirmed) confirmed.push({ ...f, note: v.note })
  else refuted.push({ ...f, note: v.note })
})
const verifierDead = unverified.length - overflow.length
const verifyNote =
  (overflow.length
    ? ` ${overflow.length} must-fix finding(s) were past the verify cap of ${MAX_VERIFY} and were NOT verified; they are listed as unverified.`
    : '') +
  (verifierDead
    ? ` ${verifierDead} verifier(s) returned nothing, so those must-fix findings are unverified, not refuted.`
    : '')
const coverageNote = reviewNote + verifyNote

// Stage: consolidate (single, judgment tier, fallback to worker)
const consolStage = SPEC.stages.consolidate
phase(consolStage.phase)
const report = await criticWithFallback(
  renderPrompt(PROMPTS.consolidate, {
    coveredCount: covered.length,
    coverageNote,
    diffHint,
    confirmedFindings: JSON.stringify(confirmed, null, 2),
    refutedFindings: JSON.stringify(refuted, null, 2),
    unverifiedFindings: JSON.stringify(unverified, null, 2),
    rawFindings: JSON.stringify(raw, null, 2),
  }),
  { label: 'consolidate', phase: consolStage.phase, model: TIER_MODELS[consolStage.tier], effort: TIER_EFFORTS[consolStage.tier], fallbackModel: TIER_MODELS[consolStage.fallback.to_tier], schema: REPORT_SCHEMA }
)

return finalizeReport(report, refuted, unverified)
