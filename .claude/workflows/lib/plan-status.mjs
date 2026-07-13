/**
 * Parser and renderer for the plan-status block defined in
 * .claude/team-guide.md ("Plan-status block before dispatch").
 *
 * Example:
 *
 *   Plan status (issue #42):
 *     [x] 1. sub-plan
 *     [x] 2. develop
 *     [>] 3. test   <- dispatching tester
 *     [ ] 4. review
 *     [ ] 5. PR ready
 *
 * A fix round annotates the current step instead of a dispatching suffix,
 * for example `[>] 3. test (fix round 2/3)`.
 */

const HEADER_RE = /^Plan status \((.+)\):$/
const STEP_LINE_RE = /^\s*\[(.)\]\s+(\d+)\.\s+(.*)$/
const DISPATCH_RE = /^(.*?)\s*<-\s*dispatching\s+(\S+)\s*$/
const FIX_ROUND_RE = /^(.*?)\s*\(fix round\s+(\d+)\s*\/\s*(\d+)\)\s*$/

const MARKER_TO_STATE = { x: 'done', '>': 'current', ' ': 'todo' }
const STATE_TO_MARKER = { done: 'x', current: '>', todo: ' ' }

// ===========================================================================
// parsePlanStatus
// ===========================================================================

export function parsePlanStatus(text) {
  if (typeof text !== 'string') {
    throw new Error('parsePlanStatus: text must be a string')
  }

  const lines = text.split('\n')
  while (lines.length && lines[0].trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()

  if (lines.length === 0) {
    throw new Error('parsePlanStatus: empty plan-status block')
  }

  const headerLine = lines[0].trim()
  const headerMatch = headerLine.match(HEADER_RE)
  if (!headerMatch || !headerMatch[1].trim()) {
    throw new Error(`parsePlanStatus: invalid header line: "${lines[0]}"`)
  }
  const subject = headerMatch[1].trim()

  const stepLines = lines.slice(1)
  if (stepLines.length === 0) {
    throw new Error('parsePlanStatus: plan-status block has no step lines')
  }

  const steps = stepLines.map((line) => parseStepLine(line))

  validateStepSequence(steps, (step) => describeParsedStep(step, stepLines))

  return { subject, steps }
}

function parseStepLine(line) {
  const match = line.match(STEP_LINE_RE)
  if (!match) {
    throw new Error(`parsePlanStatus: invalid step line: "${line}"`)
  }
  const [, markerChar, numberStr, rest] = match

  const state = MARKER_TO_STATE[markerChar]
  if (!state) {
    throw new Error(`parsePlanStatus: invalid step marker (must be [x], [>], or [ ]): "${line}"`)
  }

  const number = Number(numberStr)

  let remainder = rest
  let dispatching = null
  const dispatchMatch = remainder.match(DISPATCH_RE)
  if (dispatchMatch) {
    remainder = dispatchMatch[1]
    dispatching = dispatchMatch[2]
  }

  let fixRound = null
  const fixRoundMatch = remainder.match(FIX_ROUND_RE)
  if (fixRoundMatch) {
    remainder = fixRoundMatch[1]
    fixRound = { round: Number(fixRoundMatch[2]), cap: Number(fixRoundMatch[3]) }
  }

  const title = remainder.trim()
  if (!title) {
    throw new Error(`parsePlanStatus: step line is missing a title: "${line}"`)
  }

  const step = { number, title, state, dispatching, fixRound }
  validateStepFields(step, () => `invalid step line: "${line}"`)
  return step
}

function describeParsedStep(step, stepLines) {
  return `invalid step line: "${stepLines[step.number - 1] ?? step.title}"`
}

// ===========================================================================
// renderPlanStatus
// ===========================================================================

export function renderPlanStatus(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('renderPlanStatus: block must be an object')
  }
  const { subject, steps } = block

  if (typeof subject !== 'string' || !subject.trim()) {
    throw new Error('renderPlanStatus: subject must be a non-empty string')
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('renderPlanStatus: steps must be a non-empty array')
  }

  steps.forEach((step) => validateStepFields(step, () => describeRenderedStep(step)))
  validateStepSequence(steps, (step) => describeRenderedStep(step))

  const lines = [`Plan status (${subject}):`]
  for (const step of steps) {
    let line = `  [${STATE_TO_MARKER[step.state]}] ${step.number}. ${step.title}`
    if (step.fixRound) {
      line += ` (fix round ${step.fixRound.round}/${step.fixRound.cap})`
    }
    if (step.dispatching) {
      line += ` <- dispatching ${step.dispatching}`
    }
    lines.push(line)
  }
  return lines.join('\n')
}

function describeRenderedStep(step) {
  return `invalid step ${step?.number ?? '?'} ("${step?.title ?? ''}")`
}

// ===========================================================================
// Shared validators
// ===========================================================================

// Per-step field checks: state set, dispatching/fixRound only on the
// current step, fix round bounds (rules 2, 6, 7).
function validateStepFields(step, describe) {
  if (!Number.isInteger(step.number) || step.number < 1) {
    throw new Error(`${describe(step)}: step number must be a positive integer`)
  }
  if (typeof step.title !== 'string' || !step.title.trim()) {
    throw new Error(`${describe(step)}: step title must be a non-empty string`)
  }
  if (!(step.state in STATE_TO_MARKER)) {
    throw new Error(`${describe(step)}: invalid state "${step.state}" (must be done, current, or todo)`)
  }
  if (step.dispatching != null && step.state !== 'current') {
    throw new Error(`${describe(step)}: "<- dispatching" is only valid on the [>] (current) step`)
  }
  if (step.fixRound != null) {
    if (step.state !== 'current') {
      throw new Error(`${describe(step)}: "(fix round N/M)" is only valid on the [>] (current) step`)
    }
    const { round, cap } = step.fixRound
    if (!Number.isInteger(round) || !Number.isInteger(cap) || round < 1 || cap < 1 || round > cap) {
      throw new Error(`${describe(step)}: fix round must be positive integers with round <= cap`)
    }
  }
}

// Cross-step checks: sequential numbering, at most one current step,
// monotonic done -> current -> todo order (rules 3, 4, 5).
function validateStepSequence(steps, describe) {
  steps.forEach((step, i) => {
    if (step.number !== i + 1) {
      throw new Error(
        `${describe(step)}: step numbers must run 1..N in order with no gaps or duplicates ` +
          `(found ${step.number}, expected ${i + 1})`
      )
    }
  })

  const currentCount = steps.filter((s) => s.state === 'current').length
  if (currentCount > 1) {
    throw new Error(`at most one [>] (current) step is allowed per block, found ${currentCount}`)
  }

  let seenCurrent = false
  let seenTodo = false
  for (const step of steps) {
    if (step.state === 'done') {
      if (seenCurrent || seenTodo) {
        throw new Error(`${describe(step)}: state order must be done, then current, then todo`)
      }
    } else if (step.state === 'current') {
      if (seenTodo) {
        throw new Error(`${describe(step)}: state order must be done, then current, then todo`)
      }
      seenCurrent = true
    } else {
      seenTodo = true
    }
  }
}
