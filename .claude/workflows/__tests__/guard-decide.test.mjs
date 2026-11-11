/**
 * Tests for the guard's decision function (issue #539, batch #538).
 *
 * `decide(call, facts)` in `.claude/guard/decide.mjs` answers allow or deny for
 * one tool call. It holds the mode rule, the repo-class rules and the
 * `/tm-repo-guard` exception, then hands the call to the rule groups. These
 * tests pass it made-up calls and facts. Repo names are invented. The command
 * texts are strings handed to the function; none of them is ever run.
 *
 * The merge-rule group has its own file: guard-decide-merge-rule.test.mjs.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { decide } from '../../guard/decide.mjs'

const FACTS = {
  repoClass: 'personal-set-up',
  repo: 'acme/widget',
  defaultBranch: 'main',
  currentBranch: 'feat/1-x',
  enforceList: ['acme/widget'],
  pluginRoot: null,
}

const CALL = {
  tool: 'Bash',
  input: { command: 'ls' },
  mode: 'bypassPermissions',
  folder: '/work/widget',
}

const facts = (over = {}) => ({ ...FACTS, ...over })
const bash = (command, over = {}) => ({ ...CALL, input: { command }, ...over })
const tool = (name, over = {}) => ({ ...CALL, tool: name, input: {}, ...over })

function expectAnswer(answer, decision, rule) {
  assert.equal(answer.decision, decision, `${JSON.stringify(answer)}`)
  assert.equal(answer.rule, rule, `${JSON.stringify(answer)}`)
  assert.equal(typeof answer.reason, 'string')
  assert.ok(answer.reason.length > 0)
  assert.equal(typeof answer.enforced, 'boolean')
}

const SKILL_SCRIPT = '${CLAUDE_PLUGIN_ROOT:-.claude}/skills/tm-repo-guard/repo-guard.mjs'
const SKILL_LINE = `node "${SKILL_SCRIPT}"`
const ACTING_CLASSES = ['personal-not-set-up', 'personal-set-up', 'no-github-repo']

describe('decide: the mode rule', () => {
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    test(`${mode} allows a push to the default branch in a set-up repo`, () => {
      expectAnswer(decide(bash('git push --force origin main', { mode }), facts()), 'allow', 'mode')
    })

    test(`${mode} allows a file edit in a repo that is not set up`, () => {
      expectAnswer(decide(tool('Write', { mode }), facts({ repoClass: 'personal-not-set-up' })), 'allow', 'mode')
    })

    test(`${mode} allows a call with an unknown repo class`, () => {
      expectAnswer(decide(bash('ls', { mode }), facts({ repoClass: 'personal' })), 'allow', 'mode')
    })
  }

  for (const mode of ['bypassPermissions', 'auto', 'dontAsk', undefined, 'someNewMode']) {
    test(`the guard acts in mode ${String(mode)}`, () => {
      const answer = decide(tool('Write', { mode }), facts({ repoClass: 'personal-not-set-up' }))
      expectAnswer(answer, 'deny', 'not-set-up')
    })
  }

  test('a call with no mode field acts like an unknown mode', () => {
    const { mode, ...noMode } = CALL
    assert.equal(mode, 'bypassPermissions')
    expectAnswer(decide({ ...noMode, tool: 'Write', input: {} }, facts({ repoClass: 'personal-not-set-up' })), 'deny', 'not-set-up')
  })
})

describe('decide: organization repos', () => {
  const org = facts({ repoClass: 'organization' })

  test('allows a force push to the default branch', () => {
    expectAnswer(decide(bash('git push --force origin main'), org), 'allow', 'organization')
  })

  test('allows deleting a repo', () => {
    expectAnswer(decide(bash('gh repo delete acme/widget --yes'), org), 'allow', 'organization')
  })

  test('allows a file edit', () => {
    expectAnswer(decide(tool('Write'), org), 'allow', 'organization')
  })

  test('allows a shell call with no command text', () => {
    expectAnswer(decide({ ...CALL, input: {} }, org), 'allow', 'organization')
  })

  test('allows a line the parser cannot read', () => {
    expectAnswer(decide(bash("git push origin 'main"), org), 'allow', 'organization')
  })
})

describe('decide: invalid input', () => {
  test('an unknown repo class is denied', () => {
    expectAnswer(decide(bash('ls'), facts({ repoClass: 'personal' })), 'deny', 'invalid-input')
  })

  test('a missing repo class is denied', () => {
    expectAnswer(decide(bash('ls'), facts({ repoClass: undefined })), 'deny', 'invalid-input')
  })

  test('a tool that is not a string is denied', () => {
    expectAnswer(decide({ ...CALL, tool: undefined }, facts()), 'deny', 'invalid-input')
    expectAnswer(decide({ ...CALL, tool: 7 }, facts()), 'deny', 'invalid-input')
  })

  test('a shell call with no command text is denied', () => {
    expectAnswer(decide({ ...CALL, input: {} }, facts()), 'deny', 'invalid-input')
    expectAnswer(decide({ ...CALL, input: { command: 5 } }, facts()), 'deny', 'invalid-input')
    expectAnswer(decide({ ...CALL, input: undefined }, facts()), 'deny', 'invalid-input')
  })

  test('a missing call or missing facts is denied and does not throw', () => {
    expectAnswer(decide(undefined, facts()), 'deny', 'invalid-input')
    expectAnswer(decide(CALL, undefined), 'deny', 'invalid-input')
    expectAnswer(decide(null, null), 'deny', 'invalid-input')
  })
})

describe('decide: a personal repo that is not set up', () => {
  const notSetUp = facts({ repoClass: 'personal-not-set-up' })

  const reads = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'Skill']
  for (const name of reads) {
    test(`${name} is allowed as a read`, () => {
      expectAnswer(decide(tool(name), notSetUp), 'allow', 'read')
    })
  }

  const changes = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'mcp__github__create_issue', 'SomeNewTool']
  for (const name of changes) {
    test(`${name} is denied`, () => {
      expectAnswer(decide(tool(name), notSetUp), 'deny', 'not-set-up')
    })
  }

  for (const command of ['ls', 'git status']) {
    test(`Bash ${command} is denied`, () => {
      expectAnswer(decide(bash(command), notSetUp), 'deny', 'not-set-up')
    })
  }

  test('a line the parser cannot read is denied as not set up', () => {
    expectAnswer(decide(bash("echo 'a"), notSetUp), 'deny', 'not-set-up')
  })
})

describe('decide: the /tm-repo-guard exception', () => {
  const allowed = [
    SKILL_LINE,
    `${SKILL_LINE} apply widget`,
    `${SKILL_LINE} apply acme/widget --confirm 0123456789ab`,
    `${SKILL_LINE} statuses widget 12`,
  ]
  for (const repoClass of ACTING_CLASSES) {
    for (const command of allowed) {
      test(`${repoClass} allows: ${command}`, () => {
        expectAnswer(decide(bash(command), facts({ repoClass })), 'allow', 'tm-repo-guard')
      })
    }

    test(`${repoClass} allows the plugin-root spelling`, () => {
      const answer = decide(
        bash('node /plugins/orchestrai/skills/tm-repo-guard/repo-guard.mjs apply widget'),
        facts({ repoClass, pluginRoot: '/plugins/orchestrai' }),
      )
      expectAnswer(answer, 'allow', 'tm-repo-guard')
    })
  }

  const notSetUp = facts({ repoClass: 'personal-not-set-up' })
  const denied = [
    ['a command that only mentions the skill', 'echo /tm-repo-guard'],
    ['a chained rm', `${SKILL_LINE} && rm -rf src`],
    ['a chained push', `${SKILL_LINE}; git push origin main`],
    ['a pipe', `${SKILL_LINE} | tee out.txt`],
    ['a redirect', `${SKILL_LINE} > out.txt`],
    ['a command substitution argument', `${SKILL_LINE} apply "$(touch x)"`],
    ['a variable argument', `${SKILL_LINE} apply $REPO`],
    ['a node flag before the script', `node -e 1 "${SKILL_SCRIPT}"`],
    ['another plugin copy, no plugin root', 'node /tmp/x/skills/tm-repo-guard/repo-guard.mjs'],
    ['bash -c around the line', `bash -c '${SKILL_LINE}'`],
    ['an environment prefix', `FOO=1 ${SKILL_LINE}`],
    ['a cd in front', `cd /tmp && ${SKILL_LINE}`],
    ['the repo-relative spelling', 'node .claude/skills/tm-repo-guard/repo-guard.mjs'],
    ['cat of the script', `cat "${SKILL_SCRIPT}"`],
  ]
  for (const [name, command] of denied) {
    test(`denied in a repo that is not set up: ${name}`, () => {
      expectAnswer(decide(bash(command), notSetUp), 'deny', 'not-set-up')
    })
  }

  test('another plugin copy is denied when the plugin root is a different path', () => {
    const answer = decide(
      bash('node /tmp/x/skills/tm-repo-guard/repo-guard.mjs'),
      facts({ repoClass: 'personal-not-set-up', pluginRoot: '/plugins/orchestrai' }),
    )
    expectAnswer(answer, 'deny', 'not-set-up')
  })

  test('the plugin-root spelling is denied when no plugin root is known', () => {
    const answer = decide(bash('node /plugins/orchestrai/skills/tm-repo-guard/repo-guard.mjs'), notSetUp)
    expectAnswer(answer, 'deny', 'not-set-up')
  })

  test('a shell call with no command text is not an exception', () => {
    expectAnswer(decide({ ...CALL, input: {} }, notSetUp), 'deny', 'invalid-input')
  })
})

describe('decide: the enforce flag', () => {
  test('is true on a deny when the repo is on the list', () => {
    const answer = decide(tool('Write'), facts({ repoClass: 'personal-not-set-up' }))
    expectAnswer(answer, 'deny', 'not-set-up')
    assert.equal(answer.enforced, true)
  })

  test('is true on an allow when the repo is on the list', () => {
    const answer = decide(tool('Read'), facts({ repoClass: 'personal-not-set-up' }))
    expectAnswer(answer, 'allow', 'read')
    assert.equal(answer.enforced, true)
  })

  test('is true in a prompting mode too', () => {
    const answer = decide(bash('ls', { mode: 'default' }), facts())
    expectAnswer(answer, 'allow', 'mode')
    assert.equal(answer.enforced, true)
  })

  test('is true on an invalid-input answer when the repo is on the list', () => {
    assert.equal(decide(bash('ls'), facts({ repoClass: 'personal' })).enforced, true)
  })

  test('matches the repo name without regard to case', () => {
    assert.equal(decide(bash('ls'), facts({ repo: 'ACME/Widget' })).enforced, true)
    assert.equal(decide(bash('ls'), facts({ enforceList: ['Acme/WIDGET'] })).enforced, true)
  })

  test('is false when the repo is not on the list', () => {
    assert.equal(decide(tool('Write'), facts({ repoClass: 'personal-not-set-up', repo: 'acme/other' })).enforced, false)
  })

  test('is false when the repo is null', () => {
    assert.equal(decide(tool('Write'), facts({ repoClass: 'personal-not-set-up', repo: null })).enforced, false)
  })

  test('is false when the enforce list is missing', () => {
    assert.equal(decide(tool('Write'), facts({ repoClass: 'personal-not-set-up', enforceList: undefined })).enforced, false)
    assert.equal(decide(bash('ls'), facts({ enforceList: null })).enforced, false)
  })

  test('is false when there are no facts at all', () => {
    assert.equal(decide(CALL, undefined).enforced, false)
  })
})

describe('decide: lines the parser cannot read', () => {
  const unreadable = "git push origin 'main"

  for (const repoClass of ['personal-set-up', 'no-github-repo']) {
    test(`${repoClass} denies an unterminated quote`, () => {
      expectAnswer(decide(bash(unreadable), facts({ repoClass })), 'deny', 'unparseable')
    })
  }

  test('a prompting mode allows it', () => {
    expectAnswer(decide(bash(unreadable, { mode: 'default' }), facts()), 'allow', 'mode')
  })
})

describe('decide: calls no rule applies to', () => {
  for (const repoClass of ['personal-set-up', 'no-github-repo']) {
    for (const [name, call] of [
      ['Edit', tool('Edit')],
      ['Write', tool('Write')],
      ['Read', tool('Read')],
      ['npm test', bash('npm test')],
    ]) {
      test(`${repoClass} allows ${name} as no-rule`, () => {
        expectAnswer(decide(call, facts({ repoClass })), 'allow', 'no-rule')
      })
    }
  }
})

describe('decide: no side effects', () => {
  const guardDir = fileURLToPath(new URL('../../guard/', import.meta.url))
  const rulesDir = `${guardDir}rules/`
  const files = [
    `${guardDir}decide.mjs`,
    `${guardDir}shell.mjs`,
    `${guardDir}groups.mjs`,
    ...(existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith('.mjs')).map((f) => `${rulesDir}${f}`) : []),
  ]
  const forbidden = /^(node:)?(fs|fs\/promises|child_process|net|http|https|http2|dns|dgram|tls|worker_threads|vm)$/

  test('the file list includes the core files', () => {
    assert.ok(files.length >= 3)
  })

  for (const file of files) {
    const name = file.slice(guardDir.length)
    test(`${name} imports no module that touches the system`, () => {
      const source = readFileSync(file, 'utf8')
      const specifiers = [...source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2])
      for (const specifier of specifiers) {
        assert.ok(!forbidden.test(specifier), `${name} imports ${specifier}`)
      }
      assert.ok(!/\bimport\s*\(/.test(source), `${name} uses a dynamic import`)
      assert.ok(!/\brequire\s*\(/.test(source), `${name} uses require`)
      assert.ok(!/\bfetch\s*\(/.test(source), `${name} calls the network`)
      assert.ok(!/process\.(env|exit|cwd|stdout|stderr)/.test(source), `${name} reads the process`)
    })
  }
})
