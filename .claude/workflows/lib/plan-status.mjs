/**
 * Parser and renderer for the plan-status block convention defined in
 * .claude/team-guide.md ("Plan-status block before dispatch").
 *
 * A block looks like:
 *
 *   Plan status (issue #42):
 *     [x] 1. sub-plan
 *     [x] 2. develop
 *     [>] 3. test   <- dispatching tester
 *     [ ] 4. review
 *     [ ] 5. PR ready
 *
 * parsePlanStatus() and renderPlanStatus() are exact inverses on the block
 * structure: parsing tolerates run-of-whitespace between fields (matching
 * hand-typed alignment padding), rendering always emits single spaces. Both
 * directions run the same 7 validation rules through the shared validate()
 * below, so a value that renders is guaranteed to parse back to itself.
 */

const HEADER_RE = /^Plan status \((.+)\):$/
const STEP_LINE_RE = /^\s+\[([x> ])\]\s+(\d+)\.\s+(.*)$/
const DISPATCHING_RE = /^(.*?)\s+<-\s*dispatching\s+(\S+)\s*$/
const FIX_ROUND_RE = /^(.*?)\s+\(fix round (\d+)\/(\d+)\)\s*$/

const STATE_BY_MARKER = { x: 'done', '>': 'current', ' ': 'todo' }
const MARKER_BY_STATE = { done: 'x', current: '>', todo: ' ' }

/**
 * Parse a plan-status block into { subject, steps }.
 * Throws Error naming the offending line for any malformed or
 * rule-violating input.
 */
export function parsePlanStatus(text) {
  if (typeof text !== 'string') throw new Error('plan-status input must be a string')

  const rawLines = text.split('\n')
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  if (lines.length === 0) throw new Error('plan-status block is empty')

  const headerLine = lines[0]
  const headerMatch = headerLine.match(HEADER_RE)
  if (!headerMatch || !headerMatch[1].trim()) {
    throw new Error(`invalid plan-status header: "${headerLine}"`)
  }
  const subject = headerMatch[1].trim()

  const steps = lines.slice(1).map(parseStepLine)

  return validate({ subject, steps })
}

/**
 * Render a { subject, steps } block back into canonical plan-status text.
 * Runs the same validate() as parsePlanStatus, so an invalid block throws
 * before anything is emitted.
 */
export function renderPlanStatus(block) {
  validate(block)

  const lines = [`Plan status (${block.subject}):`, ...block.steps.map(renderStepLine)]
  return lines.join('\n')
}

function parseStepLine(line) {
  const match = line.match(STEP_LINE_RE)
  if (!match) throw new Error(`invalid step line: "${line}"`)

  const [, marker, numberText, remainder] = match
  const state = STATE_BY_MARKER[marker]
  const number = parseInt(numberText, 10)

  let rest = remainder
  let dispatching = null
  const dispatchMatch = rest.match(DISPATCHING_RE)
  if (dispatchMatch) {
    rest = dispatchMatch[1]
    dispatching = dispatchMatch[2]
  }

  let fixRound = null
  const fixRoundMatch = rest.match(FIX_ROUND_RE)
  if (fixRoundMatch) {
    rest = fixRoundMatch[1]
    fixRound = { round: parseInt(fixRoundMatch[2], 10), cap: parseInt(fixRoundMatch[3], 10) }
  }

  const title = rest.trim()
  if (!title) throw new Error(`step line missing title: "${line}"`)

  return { number, title, state, dispatching, fixRound }
}

function renderStepLine(step) {
  const marker = MARKER_BY_STATE[step.state]
  let line = `  [${marker}] ${step.number}. ${step.title}`
  if (step.fixRound) line += ` (fix round ${step.fixRound.round}/${step.fixRound.cap})`
  if (step.dispatching) line += ` <- dispatching ${step.dispatching}`
  return line
}

/**
 * Enforce the 7 validation rules from team-guide.md against a structured
 * block. Shared by both parsePlanStatus (after building the structure) and
 * renderPlanStatus (before emitting), so both directions agree on what a
 * valid block is. Error messages reconstruct the offending line canonically
 * from the step's fields, which is exact for well-formed input and only
 * normalizes whitespace for padded input.
 */
function validate(block) {
  const subject = block && block.subject
  if (!subject || !String(subject).trim()) {
    throw new Error(`invalid plan-status header: "Plan status (${subject ?? ''}):"`)
  }

  const steps = block.steps
  if (!Array.isArray(steps)) throw new Error('plan-status block has no steps')

  let currentCount = 0
  let seenCurrent = false
  let seenTodo = false

  steps.forEach((step, index) => {
    const line = renderStepLine(step)

    if (!MARKER_BY_STATE[step.state]) {
      throw new Error(`invalid step marker: "${line}"`)
    }

    const expectedNumber = index + 1
    if (step.number !== expectedNumber) {
      throw new Error(`step numbers must run 1..N in order, no gaps, no duplicates: "${line}"`)
    }

    if (step.state === 'current') {
      currentCount++
      if (currentCount > 1) {
        throw new Error(`at most one current step ([>]) is allowed per block: "${line}"`)
      }
    }

    if (step.state === 'done') {
      if (seenCurrent || seenTodo) {
        throw new Error(`step order must be done, then current, then todo: "${line}"`)
      }
    } else if (step.state === 'current') {
      if (seenTodo) {
        throw new Error(`step order must be done, then current, then todo: "${line}"`)
      }
      seenCurrent = true
    } else if (step.state === 'todo') {
      seenTodo = true
    }

    if (step.dispatching && step.state !== 'current') {
      throw new Error(`a dispatching suffix is only valid on the current step: "${line}"`)
    }

    if (step.fixRound) {
      if (step.state !== 'current') {
        throw new Error(`a fix round annotation is only valid on the current step: "${line}"`)
      }
      const { round, cap } = step.fixRound
      if (!Number.isInteger(round) || !Number.isInteger(cap) || round < 1 || cap < 1 || round > cap) {
        throw new Error(`fix round annotation must have positive N <= M: "${line}"`)
      }
    }
  })

  return block
}
