/**
 * Hermes renderer: tm-review-changes verify stage (issue #406).
 *
 * Drives the renderer in live mode against a stubbed HERMES_BIN subprocess
 * (the adapter's spawn seam, batch #437) and inspects the prompts it sends.
 * The verify stage's items come from the review stage's reports through the
 * must_fix_deduped transform. A seat identifies itself by the role-prompt
 * contract prepended to its task; the stub answers with report-contract
 * stdout plus a fenced json block for structured payloads.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RENDERER_PATH = '../../adapters/hermes-renderer.mjs'

const MUST_FIX = { file: 'src/a.js', line: '12', severity: 'must-fix', problem: 'unique-problem-text', fix: 'f' }

// The stub seat: a Node script playing `hermes -z`. It records the -z prompt
// to a sidecar file, and answers by role contract with a fenced json block
// carrying the structured payload downstream stages fan out over.
//
// Written with no nested template literals: the fence characters are built
// from a variable so the generator below stays readable.
function stubScript(sidecarPath) {
  const f = '`'.repeat(3)
  return [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "const zi = args.indexOf('-z')",
    "const prompt = zi >= 0 ? args[zi + 1] : ''",
    `appendFileSync(${JSON.stringify(sidecarPath)}, JSON.stringify({ prompt }) + '\\n')`,
    `const f = '${f}'`,
    "let out = 'VERDICT: APPROVE\\n\\n' + f + 'json\\n{}\\n' + f + '\\n'",
    "// review stage (developer contract) reports the must-fix finding;",
    "// verify (fact-checker) confirms; consolidate (reviewer) approves.",
    "if (prompt.includes('# Developer role prompt') && prompt.includes('review')) {",
    "  out = 'STATUS: DONE\\n\\n' + f + 'json\\n' + "
      + `JSON.stringify({ findings: [${JSON.stringify(MUST_FIX)}] })`
      + " + '\\n' + f + '\\n'",
    "} else if (prompt.includes('# Fact-checker role prompt')) {",
    "  out = 'CONFIRMED: reproduced\\n\\n' + f + 'json\\n{}\\n' + f + '\\n'",
    '}',
    'process.stdout.write(out)',
  ].join('\n')
}

async function runLive() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-seat-stub-'))
  const sidecar = join(dir, 'calls.jsonl')
  const bin = join(dir, 'hermes-stub.mjs')
  writeFileSync(bin, stubScript(sidecar))
  chmodSync(bin, 0o755)

  const origBin = process.env.HERMES_BIN
  const origDryRun = process.env.DRY_RUN
  const origWarn = console.warn
  process.env.HERMES_BIN = bin
  process.env.DRY_RUN = 'false'
  console.warn = () => {}
  try {
    const { renderWorkflow } = await import(RENDERER_PATH)
    await renderWorkflow('tm-review-changes', { base: 'origin/main' })
  } finally {
    console.warn = origWarn
    process.env.HERMES_BIN = origBin
    process.env.DRY_RUN = origDryRun
  }
  const calls = []
  for (const line of readFileSync(sidecar, 'utf8').trim().split('\n').filter(Boolean)) {
    calls.push(JSON.parse(line))
  }
  return calls
}

// Classify a call by the role contract prepended to its prompt.
function roleOf(call) {
  if (call.prompt.includes('# Fact-checker role prompt')) return 'fact-checker'
  if (call.prompt.includes('# Reviewer role prompt')) return 'reviewer'
  return 'other'
}

describe('hermes renderer: tm-review-changes verify stage', () => {
  test('dispatches one verifier for the deduped must-fix finding, with the finding and diffHint filled in', async () => {
    const calls = await runLive()
    const verifyCalls = calls.filter((c) => roleOf(c) === 'fact-checker')
    assert.equal(verifyCalls.length, 1, 'every reviewer reports the same finding; dedup leaves one verifier')
    const goal = verifyCalls[0].prompt
    assert.ok(goal.includes('unique-problem-text'), 'verify prompt must carry the finding JSON')
    assert.ok(goal.includes('origin/main...HEAD'), 'verify prompt must carry the diffHint')
    assert.ok(goal.includes('adversarial verifier'), 'verify prompt must carry the adversarial stance')
    assert.ok(!goal.includes('{{'), 'no unfilled slot markers')
  })

  test('verify runs on the fact-checker role prompt, not the developer default', async () => {
    const calls = await runLive()
    const verifyCall = calls.find((c) => roleOf(c) === 'fact-checker')
    assert.ok(verifyCall, 'a fact-checker dispatch must exist')
    assert.ok(
      verifyCall.prompt.includes('# Fact-checker role prompt'),
      `got: ${verifyCall.prompt.slice(0, 60)}`
    )
  })

  test('the consolidate prompt renders with no unfilled slot markers', async () => {
    const calls = await runLive()
    // Consolidate runs on the reviewer contract (inferRole maps it there).
    const consolidate = calls.filter((c) => roleOf(c) === 'reviewer')
      .find((c) => c.prompt.includes('senior reviewer'))
    assert.ok(consolidate, 'a consolidate dispatch must exist')
    assert.ok(!consolidate.prompt.includes('{{'), 'no unfilled slot markers')
  })
})
