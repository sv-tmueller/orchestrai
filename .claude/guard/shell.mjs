/**
 * Shell command parser for the guard (issue #539, batch #538).
 *
 * `parseCommandLine(text)` reads one shell line and returns
 * `{ ok: true, commands }` or `{ ok: false, reason }`. Each command is
 * `{ words: [{ text, expands }], redirects, wrapped, nested, afterCd }`:
 *
 * - `words` has quotes removed. `expands` is true when the word holds `$VAR`,
 *   `${...}`, `$'...'` or a substitution, so its real value is unknown.
 * - `redirects` counts the redirections removed from the command, targets
 *   included. A heredoc body is skipped as data.
 * - `wrapped` is true when `env`, `sudo`, `timeout`, a `NAME=value` prefix or
 *   a keyword such as `if` was taken off the front.
 * - `nested` is true for a command found inside `$(...)`, backticks, `<(...)`,
 *   `bash -c` or `eval`.
 * - `afterCd` is true for every command after a `cd`, `pushd` or `popd` that
 *   appears earlier in the line. Subshell scope is ignored, which errs toward
 *   "unknown".
 *
 * The parser is lenient: it reads words, not the whole shell grammar. It fails
 * only on an unterminated quote, backtick, `$(` or heredoc, and on nesting
 * deeper than 4. It is pure: no file system, no process, no network.
 */

const MAX_DEPTH = 4

class ParseError extends Error {}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const CD_COMMANDS = new Set(['cd', 'pushd', 'popd'])
const NO_VALUE = new Set()

// Wrappers: each takes the words after the wrapper name and returns what is
// left once the wrapper's own flags and arguments are removed.
function skipFlags(words, valueFlags, { assignments = false } = {}) {
  let i = 0
  while (i < words.length) {
    const t = words[i].text
    if (assignments && ASSIGNMENT.test(t)) {
      i++
    } else if (t === '--') {
      i++
      break
    } else if (t.length > 1 && t.startsWith('-')) {
      i += valueFlags.has(t) ? 2 : 1
    } else {
      break
    }
  }
  return words.slice(i)
}

const SUDO_VALUE_FLAGS = new Set([
  '-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U',
  '--user', '--group', '--host', '--prompt', '--close-from', '--chdir',
  '--chroot', '--role', '--type', '--other-user',
])

const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir'])

// `env -S` takes a whole command line as one string. Its value goes to
// `lines` and is parsed as a line.
function skipEnv(words, lines) {
  let i = 0
  while (i < words.length) {
    const t = words[i].text
    if (ASSIGNMENT.test(t)) {
      i++
    } else if (t === '--') {
      i++
      break
    } else if (t === '-S' || t === '--split-string') {
      if (words[i + 1]) lines.push(words[i + 1].text)
      i += 2
    } else if (t.startsWith('--split-string=')) {
      lines.push(t.slice('--split-string='.length))
      i++
    } else if (t.startsWith('-S') && t.length > 2) {
      lines.push(t.slice(2))
      i++
    } else if (t.length > 1 && t.startsWith('-')) {
      i += ENV_VALUE_FLAGS.has(t) ? 2 : 1
    } else {
      break
    }
  }
  return words.slice(i)
}

const WRAPPERS = {
  env: (rest, lines) => skipEnv(rest, lines),
  stdbuf: (rest) => skipFlags(rest, new Set(['-i', '-o', '-e', '--input', '--output', '--error'])),
  setsid: (rest) => skipFlags(rest, NO_VALUE),
  ionice: (rest) => skipFlags(rest, new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'])),
  doas: (rest) => skipFlags(rest, new Set(['-u', '-C'])),
  command: (rest) => skipFlags(rest, NO_VALUE),
  exec: (rest) => skipFlags(rest, new Set(['-a'])),
  nohup: (rest) => skipFlags(rest, NO_VALUE),
  time: (rest) => skipFlags(rest, new Set(['-f', '--format', '-o', '--output'])),
  sudo: (rest) => skipFlags(rest, SUDO_VALUE_FLAGS),
  nice: (rest) => skipFlags(rest, new Set(['-n', '--adjustment'])),
  timeout: (rest) => skipFlags(rest, new Set(['-s', '--signal', '-k', '--kill-after'])).slice(1),
}

export function commandName(command) {
  const text = command.words[0]?.text ?? ''
  return text.slice(text.lastIndexOf('/') + 1)
}

export function parseCommandLine(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'the command is not text' }
  try {
    const { commands } = scan(text, 0, 0, false, false)
    return { ok: true, commands }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, reason: err.message }
    throw err
  }
}

function unwrap(input) {
  let words = input
  let wrapped = false
  const lines = []
  for (let guard = 0; guard < 50 && words.length > 0; guard++) {
    const head = words[0].text
    if (ASSIGNMENT.test(head) || KEYWORDS.has(head)) {
      words = words.slice(1)
      wrapped = true
      continue
    }
    const wrapper = WRAPPERS[head.slice(head.lastIndexOf('/') + 1)]
    if (!wrapper) break
    words = wrapper(words.slice(1), lines)
    wrapped = true
  }
  return { words, wrapped, lines }
}

const SHELL_VALUE_OPTIONS = new Set(['-O', '+O', '-o', '+o', '--rcfile', '--init-file'])

// Index of the script word after a `-c` cluster, or -1. Other options may
// stand before it: long options, `-O name`, `+O name`, `+x` and the like.
function scriptIndex(words) {
  for (let i = 1; i < words.length; i++) {
    const t = words[i].text
    if (SHELL_VALUE_OPTIONS.has(t)) {
      i++
    } else if (t.startsWith('--')) {
      continue
    } else if (/^-[A-Za-z]+$/.test(t) && t.includes('c')) {
      // More options may follow the cluster; the command string is the first
      // word after them.
      let j = i + 1
      while (j < words.length && /^[-+]./.test(words[j].text)) {
        j += SHELL_VALUE_OPTIONS.has(words[j].text) ? 2 : 1
      }
      return j < words.length ? j : -1
    } else if (!/^[-+][A-Za-z]+$/.test(t)) {
      return -1
    }
  }
  return -1
}

function buildCommand(rawWords, redirects, afterCd, depth) {
  const { words, wrapped, lines } = unwrap(rawWords)
  if (lines.length > 0) {
    const line = [...lines, ...words.map((w) => w.text)].join(' ')
    const inner = scan(line, 0, depth + 1, afterCd, false)
    return { command: null, extra: inner.commands.map((c) => ({ ...c, nested: true })), sawCd: inner.sawCd }
  }
  if (words.length === 0) return { command: null, extra: [], sawCd: false }
  const command = { words, redirects, wrapped, nested: false, afterCd }
  const name = commandName(command)
  let line = null
  // A command word that expands ($SHELL) is read as a shell only when a -c
  // cluster follows it.
  if (SHELLS.has(name) || words[0].expands) {
    const at = scriptIndex(words)
    if (at >= 0) line = words[at].text
  } else if (name === 'eval') {
    line = words.slice(1).map((w) => w.text).join(' ')
  }
  let extra = []
  let sawCd = CD_COMMANDS.has(name)
  if (line !== null) {
    const inner = scan(line, 0, depth + 1, afterCd, false)
    extra = inner.commands.map((c) => ({ ...c, nested: true }))
    sawCd = sawCd || inner.sawCd
  }
  return { command, extra, sawCd }
}

const isBlank = (ch) => ch === ' ' || ch === '\t' || ch === '\r'

// Reads commands from `text` starting at `start`. With `closer` set it stops
// after the `)` that closes a `$(`, and returns the index after it as `end`.
function scan(text, start, depth, afterCd, closer) {
  if (depth > MAX_DEPTH) throw new ParseError(`nesting deeper than ${MAX_DEPTH}`)

  const commands = []
  let words = []
  let redirects = 0
  let pending = []
  let heredocs = []
  let seenCd = afterCd
  let nestedCd = false
  let parenDepth = 0
  let i = start

  const addNested = (inner) => {
    for (const c of inner.commands) pending.push({ ...c, nested: true })
    if (inner.sawCd) nestedCd = true
  }

  const finish = () => {
    if (words.length > 0) {
      const built = buildCommand(words, redirects, seenCd, depth)
      if (built.command) commands.push(built.command)
      commands.push(...pending, ...built.extra)
      if (built.sawCd || nestedCd) seenCd = true
    } else {
      commands.push(...pending)
      if (nestedCd) seenCd = true
    }
    words = []
    redirects = 0
    pending = []
    nestedCd = false
  }

  // The text after `))` of `$((`, or of `((` at the start of a command.
  const arithmeticEnd = (from, open) => {
    let level = open
    let j = from
    while (j < text.length && level > 0) {
      if (text[j] === '(') level++
      else if (text[j] === ')') level--
      j++
    }
    return j
  }

  const dollar = (word, inDouble) => {
    const next = text[i + 1]
    if (next === '(') {
      if (text[i + 2] === '(') {
        const end = arithmeticEnd(i + 3, 2)
        word.text += text.slice(i, end)
        word.expands = true
        i = end
        return
      }
      const inner = scan(text, i + 2, depth + 1, seenCd, true)
      addNested(inner)
      word.text += text.slice(i, inner.end)
      word.expands = true
      i = inner.end
      return
    }
    if (next === '{') {
      let level = 1
      let j = i + 2
      while (j < text.length && level > 0) {
        if (text[j] === '{') level++
        else if (text[j] === '}') level--
        j++
      }
      word.text += text.slice(i, j)
      word.expands = true
      i = j
      return
    }
    if (next === "'" && !inDouble) {
      let j = i + 2
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) throw new ParseError('unterminated quote')
      word.text += text.slice(i + 2, j)
      word.expands = true
      i = j + 1
      return
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let j = i + 2
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++
      word.text += text.slice(i, j)
      word.expands = true
      i = j
      return
    }
    if (next !== undefined && /[0-9?#@*!$-]/.test(next)) {
      word.text += text.slice(i, i + 2)
      word.expands = true
      i += 2
      return
    }
    word.text += '$'
    i++
  }

  const backtick = (word) => {
    let j = i + 1
    while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
    if (j >= text.length) throw new ParseError('unterminated backtick')
    const inner = text.slice(i + 1, j).replace(/\\([`$\\])/g, '$1')
    addNested(scan(inner, 0, depth + 1, seenCd, false))
    word.text += text.slice(i, j + 1)
    word.expands = true
    i = j + 1
  }

  const doubleQuoted = (word) => {
    i++
    for (;;) {
      if (i >= text.length) throw new ParseError('unterminated quote')
      const ch = text[i]
      if (ch === '"') {
        i++
        return
      }
      if (ch === '\\') {
        const next = text[i + 1]
        if (next === undefined) throw new ParseError('unterminated quote')
        if (next === '\n') {
          // line continuation
        } else if ('$`"\\'.includes(next)) {
          word.text += next
        } else {
          word.text += ch + next
        }
        i += 2
      } else if (ch === '$') {
        dollar(word, true)
      } else if (ch === '`') {
        backtick(word)
      } else {
        word.text += ch
        i++
      }
    }
  }

  const readWord = () => {
    const word = { text: '', expands: false, any: false, quoted: false }
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') {
        if (text[i + 1] === '\n') {
          i += 2
        } else if (i + 1 >= text.length) {
          i++
        } else {
          word.text += text[i + 1]
          word.any = word.quoted = true
          i += 2
        }
      } else if (ch === "'") {
        const end = text.indexOf("'", i + 1)
        if (end < 0) throw new ParseError('unterminated quote')
        word.text += text.slice(i + 1, end)
        word.any = word.quoted = true
        i = end + 1
      } else if (ch === '"') {
        word.any = word.quoted = true
        doubleQuoted(word)
      } else if (ch === '$') {
        word.any = true
        dollar(word, false)
      } else if (ch === '`') {
        word.any = true
        backtick(word)
      } else if ((ch === '<' || ch === '>') && text[i + 1] === '(') {
        const inner = scan(text, i + 2, depth + 1, seenCd, true)
        addNested(inner)
        word.text += text.slice(i, inner.end)
        word.expands = word.any = true
        i = inner.end
      } else if (isBlank(ch) || ch === '\n' || ';&|()<>'.includes(ch)) {
        break
      } else {
        word.text += ch
        word.any = true
        i++
      }
    }
    return word.any ? word : null
  }

  const skipBlanks = () => {
    while (i < text.length && (isBlank(text[i]) || (text[i] === '\\' && text[i + 1] === '\n'))) {
      i += text[i] === '\\' ? 2 : 1
    }
  }

  const redirect = () => {
    let heredoc = false
    let strip = false
    if (text[i] === '&') {
      i += 2
      if (text[i] === '>') i++
    } else if (text[i] === '>') {
      i++
      if ('>&|'.includes(text[i] ?? '')) i++
    } else {
      i++
      if (text[i] === '<') {
        i++
        if (text[i] === '<') {
          i++
        } else {
          heredoc = true
          if (text[i] === '-') {
            strip = true
            i++
          }
        }
      } else if (text[i] === '&' || text[i] === '>') {
        i++
      }
    }
    redirects++
    skipBlanks()
    const target = readWord()
    if (heredoc) {
      if (!target) throw new ParseError('heredoc without an end marker')
      heredocs.push({ delimiter: target.text, strip })
    }
  }

  const skipHeredocBodies = () => {
    for (const { delimiter, strip } of heredocs) {
      for (;;) {
        if (i >= text.length) throw new ParseError('unterminated heredoc')
        const newline = text.indexOf('\n', i)
        const end = newline < 0 ? text.length : newline
        let line = text.slice(i, end)
        i = newline < 0 ? text.length : newline + 1
        if (strip) line = line.replace(/^\t+/, '')
        if (line === delimiter) break
      }
    }
    heredocs = []
  }

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (isBlank(ch) || (ch === '\\' && next === '\n')) {
      skipBlanks()
    } else if (ch === '\n') {
      i++
      finish()
      skipHeredocBodies()
    } else if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === ';') {
      i++
      finish()
    } else if (ch === '&' && next === '>') {
      redirect()
    } else if (ch === '&') {
      i += next === '&' ? 2 : 1
      finish()
    } else if (ch === '|') {
      i += next === '|' || next === '&' ? 2 : 1
      finish()
    } else if (ch === '(') {
      if (words.length === 0 && next === '(') {
        i = arithmeticEnd(i + 2, 2)
      } else {
        parenDepth++
        i++
      }
      finish()
    } else if (ch === ')') {
      i++
      finish()
      if (closer) {
        if (parenDepth === 0) {
          if (heredocs.length > 0) throw new ParseError('unterminated heredoc')
          return { commands, sawCd: seenCd, end: i }
        }
        parenDepth--
      }
    } else if ((ch === '<' || ch === '>') && next !== '(') {
      redirect()
    } else if (ch === '{' && words.length === 0 && (next === undefined || isBlank(next) || next === '\n')) {
      i++
    } else if (ch === '}' && words.length === 0 && (next === undefined || isBlank(next) || ';&|)\n}'.includes(next))) {
      i++
    } else {
      const word = readWord()
      if (!word) {
        i++
      } else if (!word.quoted && /^[0-9]+$/.test(word.text) && (text[i] === '<' || text[i] === '>') && text[i + 1] !== '(') {
        // A file descriptor number such as the 2 in `2>&1`.
      } else {
        words.push({ text: word.text, expands: word.expands })
      }
    }
  }
  if (closer) throw new ParseError('unterminated $(')
  if (heredocs.length > 0) throw new ParseError('unterminated heredoc')
  finish()
  return { commands, sawCd: seenCd, end: i }
}
