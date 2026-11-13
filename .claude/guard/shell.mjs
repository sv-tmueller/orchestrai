/**
 * Shell command parser for the guard (issue #539, batch #538).
 *
 * `parseCommandLine(text)` reads one shell line and returns
 * `{ ok: true, commands }` or `{ ok: false, reason }`. Each command is
 * `{ words: [{ text, expands }], redirects, wrapped, nested, afterCd, env }`:
 *
 * - `words` has quotes removed, and the escapes inside `$'...'` decoded (`\x`,
 *   octal, `\u`, `\U` and the single-letter ones; a NUL ends the string).
 *   `expands` is true when the word holds `$VAR`, `$1`, `${...}`, `$'...'` or
 *   a substitution, so its real value is unknown. It is the one test for
 *   "expands" that rule groups use.
 * - `env` lists the names assigned in front of the command (`GIT_DIR=x`, or
 *   `env GIT_DIR=x`), also for a command run by a shell in the same prefix.
 * - `redirects` counts the redirections removed from the command, targets
 *   included. A heredoc body is skipped as data.
 * - `wrapped` is true when `env`, `sudo`, `timeout`, a `NAME=value` prefix or
 *   a keyword such as `if` was taken off the front.
 * - `nested` is true for a command found inside `$(...)`, backticks, `<(...)`,
 *   `bash -c` or `eval`.
 * - `afterCd` is true for every command after a `cd`, `pushd` or `popd` that
 *   appears earlier in the line, and after an `export`, `declare -x` or
 *   `typeset -x` of `GIT_DIR` or `GIT_WORK_TREE`, which moves every later git
 *   command to another repository. Subshell scope is ignored, which errs
 *   toward "unknown". It is also true for a command whose `env` or `sudo`
 *   wrapper carries `-C`, `--chdir` or `-D`.
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
const GIT_FOLDER_NAMES = new Set(['GIT_DIR', 'GIT_WORK_TREE'])

const assignedName = (text) => text.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]

// Wrappers: each takes the words after the wrapper name and a state object
// ({ lines, env, chdir }), and returns what is left once the wrapper's own
// flags and arguments are removed. `chdir` names the wrapper's own
// change-directory flag: a short form and a long form.
function skipFlags(words, valueFlags, state, chdir = null) {
  let i = 0
  while (i < words.length) {
    const t = words[i].text
    if (t === '--') {
      i++
      break
    } else if (t.length > 1 && t.startsWith('-')) {
      if (chdir && (t === chdir.short || t === chdir.long || t.startsWith(`${chdir.long}=`) || (t.startsWith(chdir.short) && t.length > 2))) {
        state.chdir = true
      }
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
// `state.lines` and is parsed as a line. Assigned names go to `state.env`.
function skipEnv(words, state) {
  let i = 0
  while (i < words.length) {
    const t = words[i].text
    if (ASSIGNMENT.test(t)) {
      state.env.push(assignedName(t))
      i++
    } else if (t === '--') {
      i++
      break
    } else if (t === '-S' || t === '--split-string') {
      if (words[i + 1]) state.lines.push(words[i + 1].text)
      i += 2
    } else if (t.startsWith('--split-string=')) {
      state.lines.push(t.slice('--split-string='.length))
      i++
    } else if (t.startsWith('-S') && t.length > 2) {
      state.lines.push(t.slice(2))
      i++
    } else if (t.length > 1 && t.startsWith('-')) {
      if (t === '-C' || t === '--chdir' || t.startsWith('--chdir=') || (t.startsWith('-C') && t.length > 2)) state.chdir = true
      i += ENV_VALUE_FLAGS.has(t) ? 2 : 1
    } else {
      break
    }
  }
  return words.slice(i)
}

const WRAPPERS = {
  env: skipEnv,
  stdbuf: (rest, state) => skipFlags(rest, new Set(['-i', '-o', '-e', '--input', '--output', '--error']), state),
  setsid: (rest, state) => skipFlags(rest, NO_VALUE, state),
  ionice: (rest, state) => skipFlags(rest, new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid']), state),
  doas: (rest, state) => skipFlags(rest, new Set(['-u', '-C']), state),
  command: (rest, state) => skipFlags(rest, NO_VALUE, state),
  exec: (rest, state) => skipFlags(rest, new Set(['-a']), state),
  nohup: (rest, state) => skipFlags(rest, NO_VALUE, state),
  time: (rest, state) => skipFlags(rest, new Set(['-f', '--format', '-o', '--output']), state),
  sudo: (rest, state) => skipFlags(rest, SUDO_VALUE_FLAGS, state, { short: '-D', long: '--chdir' }),
  nice: (rest, state) => skipFlags(rest, new Set(['-n', '--adjustment']), state),
  timeout: (rest, state) => skipFlags(rest, new Set(['-s', '--signal', '-k', '--kill-after']), state).slice(1),
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
  const state = { lines: [], env: [], chdir: false }
  for (let guard = 0; guard < 50 && words.length > 0; guard++) {
    const head = words[0].text
    if (ASSIGNMENT.test(head) || KEYWORDS.has(head)) {
      if (ASSIGNMENT.test(head)) state.env.push(assignedName(head))
      words = words.slice(1)
      wrapped = true
      continue
    }
    const wrapper = WRAPPERS[head.slice(head.lastIndexOf('/') + 1)]
    if (!wrapper) break
    words = wrapper(words.slice(1), state)
    wrapped = true
  }
  return { words, wrapped, state }
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

// `export`, `declare -x` or `typeset -x` of GIT_DIR or GIT_WORK_TREE: every
// later git command in the line runs against another repository.
function exportsGitFolder(name, words) {
  if (name !== 'export' && name !== 'declare' && name !== 'typeset') return false
  const args = words.slice(1).map((w) => w.text)
  if (name !== 'export' && !args.some((a) => /^-[A-Za-z]*x[A-Za-z]*$/.test(a))) return false
  return args.some((a) => GIT_FOLDER_NAMES.has(a.split('=')[0]))
}

function buildCommand(rawWords, redirects, afterCd, depth) {
  const { words, wrapped, state } = unwrap(rawWords)
  // An `env -C` or `sudo -D` moves this command, and what it runs, to another
  // folder. The names assigned in front of it reach what it runs.
  const here = afterCd || state.chdir
  const nestedOf = (inner) => inner.commands.map((c) => ({ ...c, nested: true, env: [...state.env, ...c.env] }))
  if (state.lines.length > 0) {
    const line = [...state.lines, ...words.map((w) => w.text)].join(' ')
    const inner = scan(line, 0, depth + 1, here, false)
    return { command: null, extra: nestedOf(inner), sawCd: inner.sawCd }
  }
  if (words.length === 0) return { command: null, extra: [], sawCd: false }
  const command = { words, redirects, wrapped, nested: false, afterCd: here, env: state.env }
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
  let sawCd = CD_COMMANDS.has(name) || exportsGitFolder(name, words)
  if (line !== null) {
    const inner = scan(line, 0, depth + 1, here, false)
    extra = nestedOf(inner)
    sawCd = sawCd || inner.sawCd
  }
  return { command, extra, sawCd }
}

const ANSI_C_SIMPLE = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }
const ANSI_C_ESCAPE = /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|[\s\S])/g

// One escape of `$'...'` as text, or null for a NUL, which ends the string in
// bash. An escape the parser does not know, a surrogate, and a code point past
// U+10FFFF (which JS cannot hold) are kept as written.
function ansiCEscape(match, escape) {
  const kind = escape[0]
  let code
  if (escape.length > 1 && (kind === 'x' || kind === 'u' || kind === 'U')) code = parseInt(escape.slice(1), 16)
  else if (/^[0-7]+$/.test(escape)) code = parseInt(escape, 8) & 0xff
  else return escape in ANSI_C_SIMPLE ? ANSI_C_SIMPLE[escape] : match
  if (code === 0) return null
  if (kind === 'u' || kind === 'U') {
    return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? match : String.fromCodePoint(code)
  }
  return String.fromCharCode(code)
}

// The text inside `$'...'` with its escapes decoded, so `$'\x72epos'` and
// `$'\u0072epos'` read as `repos`.
function decodeAnsiC(raw) {
  let out = ''
  let at = 0
  for (const m of raw.matchAll(ANSI_C_ESCAPE)) {
    out += raw.slice(at, m.index)
    at = m.index + m[0].length
    const piece = ansiCEscape(m[0], m[1])
    if (piece === null) return out
    out += piece
  }
  return out + raw.slice(at)
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
      word.text += decodeAnsiC(text.slice(i + 2, j))
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
