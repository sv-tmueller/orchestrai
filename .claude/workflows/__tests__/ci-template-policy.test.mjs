/**
 * Policy-lock test for the tm-new-project CI template (issue #155).
 *
 * The template is the worked example for the cost policy decided in #153:
 * staged jobs, pinned timeouts, concurrency cancellation, and a draft-PR
 * skip for the build/e2e jobs. This test reads the template's raw text, so
 * a future edit that drops one of these controls fails here instead of
 * shipping a template that silently regresses the policy.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const templatePath = join(
  __dir,
  '..',
  '..',
  'skills',
  'tm-new-project',
  'templates',
  'ci.yml'
)

describe('tm-new-project CI template', () => {
  test('the template file exists', () => {
    assert.ok(existsSync(templatePath), `expected a template at ${templatePath}`)
  })

  const src = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : ''
  // Split into per-job blocks by top-level `  <name>:` lines under `jobs:`.
  const jobsBlock = src.split(/\njobs:\n/)[1] ?? ''
  const jobNames = [...jobsBlock.matchAll(/^  (\w+):\n/gm)].map((m) => m[1])

  test('the template defines the checks, build, and e2e jobs', () => {
    assert.deepEqual(jobNames.sort(), ['build', 'checks', 'e2e'])
  })

  test('every job pins timeout-minutes', () => {
    for (const name of jobNames) {
      const jobSrc = jobsBlock.split(new RegExp(`^  ${name}:\\n`, 'm'))[1] ?? ''
      const nextJobIdx = jobSrc.search(/^  \w+:\n/m)
      const body = nextJobIdx === -1 ? jobSrc : jobSrc.slice(0, nextJobIdx)
      assert.match(
        body,
        /timeout-minutes:\s*\d+/,
        `job "${name}" must pin timeout-minutes`
      )
    }
  })

  test('has a concurrency group with cancel-in-progress true', () => {
    assert.match(src, /concurrency:/)
    assert.match(src, /cancel-in-progress:\s*true/)
  })

  test('the build and e2e jobs are gated off draft PRs', () => {
    for (const name of ['build', 'e2e']) {
      const jobSrc = jobsBlock.split(new RegExp(`^  ${name}:\\n`, 'm'))[1] ?? ''
      const nextJobIdx = jobSrc.search(/^  \w+:\n/m)
      const body = nextJobIdx === -1 ? jobSrc : jobSrc.slice(0, nextJobIdx)
      assert.match(
        body,
        /if:\s*github\.event_name == 'push' \|\| !github\.event\.pull_request\.draft/,
        `job "${name}" must skip on draft PRs`
      )
    }
  })

  test('the pull_request trigger includes ready_for_review', () => {
    assert.match(src, /types:\s*\[opened, synchronize, reopened, ready_for_review\]/)
  })
})
