/**
 * Tests for the guard's shell command parser (issue #539, batch #538).
 *
 * `parseCommandLine` in `.claude/guard/shell.mjs` splits a shell line into
 * commands the guard's rule groups can read. These tests pass it strings and
 * look at the result. No test runs any of the command text.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseCommandLine } from '../../guard/shell.mjs'

function parse(line) {
  const result = parseCommandLine(line)
  assert.equal(result.ok, true, `expected ok for ${JSON.stringify(line)}: ${result.reason}`)
  return result.commands
}

const texts = (line) => parse(line).map((c) => c.words.map((w) => w.text))

function nestedCall(levels) {
  return `echo ${'$('.repeat(levels)}a${')'.repeat(levels)}`
}

function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function wrappedInBash(levels) {
  let line = 'a'
  for (let n = 0; n < levels; n++) line = `bash -c ${shellQuote(line)}`
  return line
}

describe('parseCommandLine: splitting', () => {
  const separators = [';', '&&', '||', '|', '|&', '&', '\n']
  for (const sep of separators) {
    test(`separator ${JSON.stringify(sep)} splits two commands`, () => {
      assert.deepEqual(texts(`a x ${sep} b y`), [['a', 'x'], ['b', 'y']])
    })
  }

  test('a subshell gives plain commands', () => {
    const commands = parse('(a; b)')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['a', 'b'])
    assert.ok(commands.every((c) => c.nested === false))
  })

  test('a brace group gives plain commands', () => {
    assert.deepEqual(texts('{ a; b; }'), [['a'], ['b']])
  })

  test('braces inside a word stay in the word', () => {
    assert.deepEqual(texts('gh api repos/{owner}/{repo}/branches'), [['gh', 'api', 'repos/{owner}/{repo}/branches']])
    assert.deepEqual(texts('echo {a,b}'), [['echo', '{a,b}']])
  })

  test('empty commands between separators are dropped', () => {
    assert.deepEqual(texts('a;; b ;'), [['a'], ['b']])
  })

  test('an empty line gives no commands', () => {
    assert.deepEqual(parse(''), [])
    assert.deepEqual(parse('   \n  '), [])
  })

  test('a plain command has nested, afterCd and wrapped false', () => {
    const [c] = parse('git status')
    assert.equal(c.nested, false)
    assert.equal(c.afterCd, false)
    assert.equal(c.wrapped, false)
    assert.equal(c.redirects, 0)
  })
})

describe('parseCommandLine: quoting and comments', () => {
  test('single quotes keep the text literal', () => {
    assert.deepEqual(texts("echo 'git push; rm -rf x'"), [['echo', 'git push; rm -rf x']])
  })

  test('single-quoted text is one word', () => {
    assert.deepEqual(texts("'git push' origin"), [['git push', 'origin']])
  })

  test('double quotes with an escaped quote are one word', () => {
    assert.deepEqual(texts('echo "a \\"b\\""'), [['echo', 'a "b"']])
  })

  test('a backslash outside quotes joins the next character', () => {
    assert.deepEqual(texts('echo a\\ b'), [['echo', 'a b']])
  })

  test('a line continuation joins two lines', () => {
    assert.deepEqual(texts('git push \\\norigin main'), [['git', 'push', 'origin', 'main']])
    assert.deepEqual(texts('git pu\\\nsh origin main'), [['git', 'push', 'origin', 'main']])
  })

  test('a hash inside a word is part of the word', () => {
    assert.deepEqual(texts('echo a#b'), [['echo', 'a#b']])
  })

  test('a hash at the start of a word starts a comment', () => {
    assert.deepEqual(texts('echo a # git push origin main'), [['echo', 'a']])
    assert.deepEqual(texts('echo a;# c\necho b'), [['echo', 'a'], ['echo', 'b']])
  })

  test('a hash inside quotes is kept', () => {
    assert.deepEqual(texts('echo "a # b"'), [['echo', 'a # b']])
  })

  test('an empty quoted word is a word', () => {
    assert.deepEqual(texts("echo ''"), [['echo', '']])
  })
})

describe('parseCommandLine: substitutions', () => {
  test('$( ) gives a nested command and the outer word expands', () => {
    const commands = parse('echo $(git push origin main)')
    assert.equal(commands.length, 2)
    assert.equal(commands[0].words[1].expands, true)
    assert.equal(commands[0].nested, false)
    assert.deepEqual(commands[1].words.map((w) => w.text), ['git', 'push', 'origin', 'main'])
    assert.equal(commands[1].nested, true)
  })

  test('backticks give a nested command', () => {
    const commands = parse('echo `git push origin main`')
    assert.equal(commands.length, 2)
    assert.equal(commands[0].words[1].expands, true)
    assert.equal(commands[1].nested, true)
    assert.equal(commands[1].words[0].text, 'git')
  })

  test('process substitution gives nested commands', () => {
    const commands = parse('diff <(a) <(b)')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['diff', 'a', 'b'])
    assert.deepEqual(commands.map((c) => c.nested), [false, true, true])
    const out = parse('tee >(c)')
    assert.equal(out[1].nested, true)
  })

  test('a substitution inside double quotes gives a nested command', () => {
    const commands = parse('echo "x $(a) y"')
    assert.equal(commands.length, 2)
    assert.equal(commands[0].words[1].expands, true)
    assert.equal(commands[1].words[0].text, 'a')
  })

  test('a substitution inside single quotes is literal', () => {
    const commands = parse("echo '$(a)'")
    assert.equal(commands.length, 1)
    assert.equal(commands[0].words[1].expands, false)
    assert.equal(commands[0].words[1].text, '$(a)')
  })

  test('substitutions nest two levels deep', () => {
    const commands = parse('echo $(a $(b))')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['echo', 'a', 'b'])
    assert.deepEqual(commands.map((c) => c.nested), [false, true, true])
  })

  test('a substitution with several commands gives each', () => {
    assert.deepEqual(texts('echo $(a; b | c)').slice(1), [['a'], ['b'], ['c']])
  })

  test('arithmetic expansion is a word and gives no command', () => {
    const commands = parse('echo $((1+2))')
    assert.equal(commands.length, 1)
    assert.equal(commands[0].words[1].expands, true)
  })
})

describe('parseCommandLine: heredocs and here-strings', () => {
  test('the body of a heredoc inside a substitution gives no command', () => {
    const line = [
      'gh pr create --body "$(cat <<\'EOF\'',
      'git push origin main',
      'EOF',
      ')"',
    ].join('\n')
    const commands = parse(line)
    assert.deepEqual(commands.map((c) => c.words[0].text), ['gh', 'cat'])
    assert.equal(commands[0].words[4].expands, true)
    assert.equal(commands[1].nested, true)
    assert.equal(commands[1].redirects, 1)
  })

  test('a line after the end marker is read as a command', () => {
    const line = 'cat <<EOF\nbody\nEOF\ngit push origin main'
    assert.deepEqual(texts(line), [['cat'], ['git', 'push', 'origin', 'main']])
  })

  test('<<- strips leading tabs from the end marker', () => {
    const line = 'cat <<-EOF\n\tgit push origin main\n\tEOF\necho done'
    assert.deepEqual(texts(line), [['cat'], ['echo', 'done']])
  })

  test('a quoted end marker works', () => {
    assert.deepEqual(texts('cat <<"END"\nx\nEND\necho y'), [['cat'], ['echo', 'y']])
  })

  test('a heredoc at the end of the text, with no trailing newline', () => {
    assert.deepEqual(texts('cat <<EOF\nx\nEOF'), [['cat']])
  })

  test('two heredocs on one line', () => {
    assert.deepEqual(texts('cat <<A <<B\n1\nA\n2\nB\necho z'), [['cat'], ['echo', 'z']])
  })

  test('a here-string is one redirect and its word is dropped', () => {
    const [c] = parse('cat <<< "git push origin main"')
    assert.deepEqual(c.words.map((w) => w.text), ['cat'])
    assert.equal(c.redirects, 1)
  })
})

describe('parseCommandLine: redirects', () => {
  test('redirects are removed with their target and counted', () => {
    const [c] = parse('echo hi > out.txt 2>&1 >> log')
    assert.deepEqual(c.words.map((w) => w.text), ['echo', 'hi'])
    assert.equal(c.redirects, 3)
  })

  test('input, error and combined redirects', () => {
    assert.equal(parse('cat < in')[0].redirects, 1)
    assert.deepEqual(parse('ls 2>/dev/null')[0].words.map((w) => w.text), ['ls'])
    assert.equal(parse('cmd &>all')[0].redirects, 1)
    assert.equal(parse('cmd >&2')[0].redirects, 1)
  })

  test('a lone digit word before a space is not a file descriptor', () => {
    const [c] = parse('echo 2 > f')
    assert.deepEqual(c.words.map((w) => w.text), ['echo', '2'])
    assert.equal(c.redirects, 1)
  })

  test('a substitution in a redirect target is parsed', () => {
    const commands = parse('echo > $(a)')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['echo', 'a'])
  })
})

describe('parseCommandLine: expands', () => {
  test('$X, ${X} and $\'x\' expand', () => {
    assert.equal(parse('echo $X')[0].words[1].expands, true)
    assert.equal(parse('echo ${X}')[0].words[1].expands, true)
    assert.equal(parse("echo $'x'")[0].words[1].expands, true)
    assert.equal(parse('echo "$X"')[0].words[1].expands, true)
  })

  test("'$X' and plain words do not expand", () => {
    assert.equal(parse("echo '$X'")[0].words[1].expands, false)
    assert.equal(parse('echo "a"')[0].words[1].expands, false)
    assert.equal(parse('echo a')[0].words[1].expands, false)
  })

  test('the text of an expanding word keeps the source form', () => {
    assert.equal(parse('echo $X')[0].words[1].text, '$X')
    assert.equal(parse('echo "${A:-.b}/c"')[0].words[1].text, '${A:-.b}/c')
  })

  test('a lone dollar sign is literal text', () => {
    const [c] = parse('echo "a $"')
    assert.equal(c.words[1].expands, false)
  })
})

describe('parseCommandLine: positional parameters and ANSI-C quoting (reviewer round 1)', () => {
  test('$1, "$@" and $? expand', () => {
    const [c] = parse('echo $1 "$@" $?')
    assert.deepEqual(c.words.map((w) => w.expands), [false, true, true, true])
    assert.deepEqual(c.words.map((w) => w.text), ['echo', '$1', '$@', '$?'])
  })

  test('$* and $# expand', () => {
    const [c] = parse('echo $* $#')
    assert.deepEqual(c.words.map((w) => w.expands), [false, true, true])
  })

  test("$'...' decodes hex, octal and the single-letter escapes", () => {
    const [c] = parse("echo $'\\x72epos' $'\\162' $'a\\nb' $'a\\tb' $'\\\\' $'it\\'s'")
    assert.deepEqual(c.words.slice(1).map((w) => w.text), ['repos', 'r', 'a\nb', 'a\tb', '\\', "it's"])
    assert.ok(c.words.slice(1).every((w) => w.expands === true))
  })

  test("$'...' keeps an escape it does not know", () => {
    assert.equal(parse("echo $'a\\qb'")[0].words[1].text, 'a\\qb')
  })
})

describe('parseCommandLine: environment and directory of a wrapped command (reviewer round 1)', () => {
  test('assigned names are recorded on the command', () => {
    assert.deepEqual(parse('GIT_DIR=../o/.git git push')[0].env, ['GIT_DIR'])
    assert.deepEqual(parse('A=1 B=2 git push')[0].env, ['A', 'B'])
    assert.deepEqual(parse('env A=1 B=2 git push')[0].env, ['A', 'B'])
    assert.deepEqual(parse('A=1 env B=2 git push')[0].env, ['A', 'B'])
  })

  test('a command with no assignments has an empty env', () => {
    assert.deepEqual(parse('git push')[0].env, [])
  })

  test('a nested command inherits the names assigned in front of its shell', () => {
    const commands = parse("GIT_DIR=x bash -c 'git push'")
    assert.deepEqual(commands[commands.length - 1].env, ['GIT_DIR'])
  })

  test('env -C, env --chdir and sudo -D set afterCd', () => {
    assert.equal(parse('env -C ../x git push')[0].afterCd, true)
    assert.equal(parse('env --chdir=../x git push')[0].afterCd, true)
    assert.equal(parse('env --chdir ../x git push')[0].afterCd, true)
    assert.equal(parse('sudo -D ../x git push')[0].afterCd, true)
    assert.equal(parse('sudo --chdir=../x git push')[0].afterCd, true)
  })

  test('the directory of one command does not mark the next one', () => {
    assert.deepEqual(parse('env -C ../x git status; git push').map((c) => c.afterCd), [true, false])
  })

  test('the directory flag marks what a wrapped shell runs', () => {
    const commands = parse("env -C ../x bash -c 'git push'")
    assert.equal(commands[commands.length - 1].afterCd, true)
  })

  test('other wrapper flags do not set afterCd', () => {
    assert.equal(parse('env -i git push')[0].afterCd, false)
    assert.equal(parse('sudo -u bob git push')[0].afterCd, false)
  })
})

describe('parseCommandLine: unwrapping', () => {
  const wrappers = [
    'A=1 git push',
    'A=1 B=2 git push',
    'env git push',
    'env A=1 git push',
    'env -i A=1 git push',
    'env -u A git push',
    '/usr/bin/env git push',
    'command git push',
    'exec git push',
    'nohup git push',
    'time git push',
    'time -p git push',
    'sudo git push',
    'sudo -u bob git push',
    'timeout 60 git push',
    'timeout -s KILL 60 git push',
    'nice git push',
    'nice -n 5 git push',
    'A=1 env nice -n 1 timeout 5 git push',
  ]
  for (const line of wrappers) {
    test(`unwraps: ${line}`, () => {
      const commands = parse(line)
      assert.equal(commands.length, 1)
      assert.deepEqual(commands[0].words.map((w) => w.text), ['git', 'push'])
      assert.equal(commands[0].wrapped, true)
    })
  }

  test('a path to the command keeps its text and is not wrapped', () => {
    const [c] = parse('/usr/bin/git push')
    assert.equal(c.words[0].text, '/usr/bin/git')
    assert.equal(c.wrapped, false)
  })

  test('an assignment with a substitution still yields the nested command', () => {
    const commands = parse('A=$(git push origin main)')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['git'])
    assert.equal(commands[0].nested, true)
  })

  test('shell keywords in front of a command are unwrapped', () => {
    const lines = ['if git push; then echo; fi', 'while git push; do :; done', '! git push', 'for x in a; do git push; done']
    for (const line of lines) {
      const push = parse(line).find((c) => c.words[0].text === 'git')
      assert.ok(push, line)
      assert.equal(push.wrapped, true)
    }
  })

  test('bash -c gives nested commands', () => {
    const commands = parse('bash -c "git push origin main"')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['bash', 'git'])
    assert.equal(commands[0].nested, false)
    assert.equal(commands[1].nested, true)
    assert.deepEqual(commands[1].words.map((w) => w.text), ['git', 'push', 'origin', 'main'])
  })

  test('sh -c, zsh -lc, dash -ec and bash -x -c give nested commands', () => {
    assert.deepEqual(texts("sh -c 'git push origin main'").slice(1), [['git', 'push', 'origin', 'main']])
    assert.deepEqual(texts("zsh -lc 'a; b'").slice(1), [['a'], ['b']])
    assert.deepEqual(texts("dash -ec 'a'").slice(1), [['a']])
    assert.deepEqual(texts("bash -x -c 'a'").slice(1), [['a']])
  })

  test('a wrapper in front of bash -c still gives the nested commands', () => {
    assert.deepEqual(texts("sudo bash -c 'a'").map((w) => w[0]), ['bash', 'a'])
  })

  describe('shells with options before -c (tester round 1, finding 6)', () => {
    const lines = [
      "bash --login -c 'a'",
      "bash --norc -c 'a'",
      "bash --noprofile --norc -c 'a'",
      "bash -O extglob -c 'a'",
      "bash +O extglob -c 'a'",
      "bash +x -c 'a'",
      "bash --posix -lc 'a'",
      "bash -o pipefail -c 'a'",
      "bash --rcfile x -c 'a'",
      "fish -c 'a'",
      "sudo fish -c 'a'",
    ]
    for (const line of lines) {
      test(`gives the nested command: ${line}`, () => {
        const commands = parse(line)
        assert.equal(commands.length, 2)
        assert.equal(commands[1].words[0].text, 'a')
        assert.equal(commands[1].nested, true)
      })
    }

    test('options before a script file still give no nested command', () => {
      assert.equal(parse('bash --norc script.sh').length, 1)
      assert.equal(parse('bash -O extglob script.sh').length, 1)
    })
  })

  describe('options after the -c word, and a shell whose name expands (tester round 2, finding 4)', () => {
    const lines = [
      "bash -c -l 'a'",
      "sh -c -e 'a'",
      "bash -c -O extglob 'a'",
      "bash -c +x 'a'",
      "bash -lc --norc 'a'",
      "$SHELL -c 'a'",
      "\"$SH\" -lc 'a'",
      "${SHELL} --login -c 'a'",
      "$(command -v bash) -c 'a'",
      "$SHELL -c -l 'a'",
    ]
    for (const line of lines) {
      test(`gives the nested command: ${line}`, () => {
        const commands = parse(line)
        assert.equal(commands.length >= 2, true)
        const inner = commands[commands.length - 1]
        assert.equal(inner.words[0].text, 'a')
        assert.equal(inner.nested, true)
      })
    }

    test('a command word that expands with no -c cluster is left as it is', () => {
      assert.equal(parse('$SHELL script.sh').length, 1)
      assert.equal(parse('$SHELL -x script.sh').length, 1)
      assert.deepEqual(texts('$X push origin main'), [['$X', 'push', 'origin', 'main']])
    })

    test('the command string is the first word after the options, not an option', () => {
      assert.deepEqual(texts("bash -c -l 'a b'").slice(1), [['a', 'b']])
    })
  })

  describe('env -S (tester round 1, finding 6)', () => {
    test("env -S '<line>' gives a nested command", () => {
      const commands = parse("env -S 'git push origin main'")
      assert.deepEqual(commands.map((c) => c.words.map((w) => w.text)), [['git', 'push', 'origin', 'main']])
      assert.equal(commands[0].nested, true)
    })

    test('env --split-string=<line> gives a nested command', () => {
      assert.deepEqual(texts("env --split-string='git push origin main'"), [['git', 'push', 'origin', 'main']])
    })

    test('the words after the string join its line', () => {
      assert.deepEqual(texts("env -S 'git push' origin main"), [['git', 'push', 'origin', 'main']])
    })

    test('env -S with variables in front still gives the command', () => {
      assert.deepEqual(texts("env A=1 -S 'git push origin main'"), [['git', 'push', 'origin', 'main']])
    })
  })

  describe('more wrappers (tester round 1, finding 6)', () => {
    const lines = [
      'stdbuf -o0 git push',
      'stdbuf -oL git push',
      'stdbuf -o L git push',
      'stdbuf -i0 -o0 -e0 git push',
      'setsid git push',
      'setsid -f git push',
      'ionice -c3 git push',
      'ionice -c 3 -n 7 git push',
      'ionice -p 5 git push',
      'doas git push',
      'doas -u bob git push',
    ]
    for (const line of lines) {
      test(`unwraps: ${line}`, () => {
        const commands = parse(line)
        assert.equal(commands.length, 1)
        assert.deepEqual(commands[0].words.map((w) => w.text), ['git', 'push'])
        assert.equal(commands[0].wrapped, true)
      })
    }
  })

  describe('known gap: a command handed to a shell on its input', () => {
    // Documented in the "Not covered" header of rules/merge-rule.mjs. These
    // rows pin the gap so a change to it is a decision, not an accident.
    test('a command piped into a shell is not unwrapped', () => {
      const commands = parse("echo 'git push origin main' | bash")
      assert.ok(!commands.some((c) => c.words[0].text === 'git'))
    })

    test('a here-string handed to a shell is not unwrapped', () => {
      const commands = parse("bash <<< 'git push origin main'")
      assert.ok(!commands.some((c) => c.words[0].text === 'git'))
    })
  })

  test('running a script file gives no nested command', () => {
    assert.equal(parse('bash script.sh').length, 1)
    assert.equal(parse('bash -x script.sh').length, 1)
  })

  test('eval gives nested commands from the joined words', () => {
    const commands = parse('eval git push origin main')
    assert.deepEqual(commands.map((c) => c.words[0].text), ['eval', 'git'])
    assert.equal(commands[1].nested, true)
    assert.deepEqual(texts('eval "a; b"').slice(1), [['a'], ['b']])
  })
})

describe('parseCommandLine: afterCd', () => {
  test('commands after cd are marked', () => {
    const commands = parse('cd /tmp && git push')
    assert.deepEqual(commands.map((c) => c.afterCd), [false, true])
  })

  test('commands after pushd and popd are marked', () => {
    assert.deepEqual(parse('pushd x; a').map((c) => c.afterCd), [false, true])
    assert.deepEqual(parse('popd; a').map((c) => c.afterCd), [false, true])
  })

  test('commands before cd and in a line without cd are not marked', () => {
    assert.deepEqual(parse('a && cd x').map((c) => c.afterCd), [false, false])
    assert.deepEqual(parse('git status; git push').map((c) => c.afterCd), [false, false])
  })

  test('a cd inside a subshell still marks what follows', () => {
    assert.deepEqual(parse('(cd x; git push)').map((c) => c.afterCd), [false, true])
    assert.deepEqual(parse('(cd x); git push').map((c) => c.afterCd), [false, true])
  })

  test('a cd inside a substitution marks the rest of the line', () => {
    const commands = parse('echo $(cd x; pwd); git push')
    assert.equal(commands[commands.length - 1].afterCd, true)
  })

  test('nested commands after a cd are marked', () => {
    const commands = parse("cd x && bash -c 'git push'")
    assert.equal(commands[commands.length - 1].afterCd, true)
    assert.equal(commands[commands.length - 1].nested, true)
  })
})

describe('parseCommandLine: lines it cannot read', () => {
  const bad = [
    ["echo 'a", 'single quote'],
    ['echo "a', 'double quote'],
    ['echo `a', 'backtick'],
    ['echo $(a', 'substitution'],
    ['echo <(a', 'process substitution'],
    ['cat <<EOF\nbody', 'heredoc with no end marker'],
    ['cat <<EOF', 'heredoc with no body'],
    ['echo "$(a"', 'substitution inside quotes'],
  ]
  for (const [line, name] of bad) {
    test(`unterminated ${name}`, () => {
      const result = parseCommandLine(line)
      assert.equal(result.ok, false)
      assert.ok(result.reason.length > 0)
    })
  }

  test('nesting four levels deep is read', () => {
    assert.equal(parseCommandLine(nestedCall(4)).ok, true)
  })

  test('nesting five levels deep is not read', () => {
    assert.equal(parseCommandLine(nestedCall(5)).ok, false)
  })

  test('nesting through bash -c is counted too', () => {
    assert.equal(parseCommandLine(wrappedInBash(4)).ok, true)
    assert.equal(parseCommandLine(wrappedInBash(5)).ok, false)
  })

  test('a non-string is not read', () => {
    assert.equal(parseCommandLine(undefined).ok, false)
  })

  test('unusual but valid shell is read', () => {
    assert.equal(parseCommandLine('[[ -f x ]] && case $x in a) echo;; esac').ok, true)
    assert.equal(parseCommandLine('echo ${x:-y}').ok, true)
    assert.equal(parseCommandLine('(( x = 1 << 3 ))').ok, true)
    assert.equal(parseCommandLine('echo $((1+2))').ok, true)
  })
})

// Fix round past the cap (issue #539): `\u` and `\U` in $'...', and an export of
// GIT_DIR or GIT_WORK_TREE counting like a cd.

describe("parseCommandLine: \\u and \\U escapes in $'...'", () => {
  const word = (line) => parse(line)[0].words[1]

  test('\\u reads one to four hex digits, \\U one to eight', () => {
    assert.equal(word("echo $'\\u0072epos'").text, 'repos')
    assert.equal(word("echo $'\\u72epos'").text, 'repos')
    assert.equal(word("echo $'\\U00000072epos'").text, 'repos')
    assert.equal(word("echo $'\\U72epos'").text, 'repos')
    assert.equal(word("echo $'\\u002d\\u002dadmin'").text, '--admin')
    assert.equal(word("echo $'\\U0000002d\\U0000002dadmin'").text, '--admin')
  })

  test('the hex digits are read greedily, so a fifth digit stays text', () => {
    assert.equal(word("echo $'\\u00720'").text, 'r0')
    assert.equal(word("echo $'\\U000000720'").text, 'r0')
  })

  test('one digit is enough, as in bash', () => {
    assert.equal(word("echo $'\\u7'").text, '\x07')
    assert.equal(word("echo $'\\uA'").text, '\n')
  })

  test('upper and lower case hex digits both read', () => {
    assert.equal(word("echo $'\\u00E9'").text, '\xe9')
    assert.equal(word("echo $'\\u00e9'").text, '\xe9')
  })

  test('a code point above the basic plane reads as one character', () => {
    assert.equal(word("echo $'\\U0001F600'").text, '\u{1F600}')
  })

  test('\\u and \\U with no hex digit are kept as written', () => {
    assert.equal(word("echo $'\\u'").text, '\\u')
    assert.equal(word("echo $'\\ug'").text, '\\ug')
    assert.equal(word("echo $'\\U'").text, '\\U')
    assert.equal(word("echo $'a\\Ub'").text, 'a\\Ub')
  })

  test('a surrogate or a code point past U+10FFFF is kept as written, and never throws', () => {
    assert.equal(word("echo $'\\ud800'").text, '\\ud800')
    assert.equal(word("echo $'\\U0000dfff'").text, '\\U0000dfff')
    assert.equal(word("echo $'\\U00110000'").text, '\\U00110000')
    assert.equal(word("echo $'\\UFFFFFFFF'").text, '\\UFFFFFFFF')
    assert.equal(word("echo $'\\U7FFFFFFF'").text, '\\U7FFFFFFF')
  })

  test('a NUL ends the string, as in bash', () => {
    assert.equal(word("echo $'--admin\\u0000x'").text, '--admin')
    assert.equal(word("echo $'--admin\\U00000000x'").text, '--admin')
    assert.equal(word("echo $'--admin\\x00x'").text, '--admin')
    assert.equal(word("echo $'--admin\\0x'").text, '--admin')
    assert.equal(word("echo $'--admin\\u0'").text, '--admin')
  })

  test('a NUL ends only its own $\'...\' piece of the word', () => {
    assert.equal(word("echo a$'\\x00'b").text, 'ab')
    assert.equal(word("echo $'a\\u0000b'c").text, 'ac')
  })

  test('the word still expands, and the escapes mix with the older ones', () => {
    const w = word("echo $'\\x72\\u0065\\160\\U0000006fs'")
    assert.equal(w.text, 'repos')
    assert.equal(w.expands, true)
  })

  test('a \\u inside double or single quotes is plain text', () => {
    assert.equal(word('echo "\\u0072"').text, '\\u0072')
    assert.equal(word("echo '\\u0072'").text, '\\u0072')
  })
})

describe('parseCommandLine: export of GIT_DIR or GIT_WORK_TREE counts like a cd', () => {
  const marks = (line) => parse(line).map((c) => c.afterCd)

  test('export, declare -x and typeset -x of either name mark the later commands', () => {
    for (const line of [
      'export GIT_DIR=x; a',
      'export GIT_WORK_TREE=x; a',
      'export GIT_DIR; a',
      'export -p GIT_DIR=x; a',
      'export A=1 GIT_DIR=x; a',
      'export "GIT_DIR=x y"; a',
      'declare -x GIT_DIR=x; a',
      'declare -gx GIT_DIR=x; a',
      'declare -xr GIT_WORK_TREE=x; a',
      'declare -r -x GIT_DIR=x; a',
      'typeset -x GIT_DIR=x; a',
      'typeset -x GIT_WORK_TREE=x; a',
    ]) {
      assert.deepEqual(marks(line), [false, true], line)
    }
  })

  test('the export itself is not marked, and every later command is', () => {
    assert.deepEqual(marks('export GIT_DIR=x && a || b | c; d'), [false, true, true, true, true])
  })

  test('the mark reaches a command in a subshell or a substitution that follows', () => {
    assert.deepEqual(marks('export GIT_DIR=x; (a; b)'), [false, true, true])
    assert.deepEqual(marks('export GIT_DIR=x; echo $(a)'), [false, true, true])
    assert.deepEqual(marks("export GIT_DIR=x; bash -c 'a'"), [false, true, true])
  })

  test('an export inside a subshell marks what follows, as a cd does', () => {
    assert.deepEqual(marks('(export GIT_DIR=x; a); b'), [false, true, true])
  })

  test('other names, a declare with no -x, and a plain assignment do not mark', () => {
    for (const line of [
      'export FOO=1; a',
      'export GIT_DIRX=1; a',
      'export MY_GIT_DIR=1; a',
      'declare GIT_DIR=x; a',
      'declare -r GIT_DIR=x; a',
      'typeset GIT_WORK_TREE=x; a',
      'GIT_DIR=x; a',
      'GIT_WORK_TREE=x; a',
      'echo export GIT_DIR=x; a',
      'export; a',
    ]) {
      assert.ok(marks(line).every((m) => m === false), line)
    }
  })

  test('the word GIT_DIR after the export of something else does not mark', () => {
    assert.deepEqual(marks('export FOO=1 && echo GIT_DIR; a'), [false, false, false])
  })
})
