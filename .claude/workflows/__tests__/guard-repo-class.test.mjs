/**
 * Tests for the repo class lookup (issue #540, batch #538).
 *
 * `.claude/guard/repo-class.mjs` names a folder's class: personal and set up,
 * personal and not set up, organization, or no GitHub repo. These tests use
 * fakes only: a table of saved gh answers, a table of git answers and an
 * in-memory file map. No test spawns gh or git. Repo, owner and host names are
 * invented. `guard-repo-class-local.test.mjs` covers the real adapter.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { lookupRepoClass, parseGitHubRemote, defaultStateDir, REPO_CLASSES } from '../../guard/repo-class.mjs'
import { isReadOnly, collect, render } from '../../skills/tm-repo-guard/repo-guard.mjs'

// ---------------------------------------------------------------------------
// Saved gh answers
// ---------------------------------------------------------------------------

const json = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
const fail = (status, message) => ({
  code: 1,
  stdout: JSON.stringify({ message, status: String(status) }),
  stderr: `gh: ${message} (HTTP ${status})`,
})
const check = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })
const pr = (number, rollup) => ({ number, isDraft: false, statusCheckRollup: rollup })

const PR_LIST = (full) => `pr list --repo ${full} --state all --limit 10 --json number,isDraft,state,headRefName,statusCheckRollup`
const LISTING = 'api --paginate --slurp user/repos?affiliation=owner&per_page=100'
const UPGRADE = 'Upgrade to GitHub Pro or make this repository public to enable this feature.'

const TIDY_PROTECTION = json({
  required_status_checks: { strict: true, contexts: ['Unit tests'] },
  required_pull_request_reviews: {},
  allow_force_pushes: { enabled: false },
  enforce_admins: { enabled: true },
})

// The answers for one personal repo that is read in full. `info` overrides
// fields of the repo read, `protection` replaces the protection answer.
function personal(name, { info = {}, protection = TIDY_PROTECTION } = {}) {
  const full = `octo/${name}`
  return {
    [`api repos/${full}`]: json({
      full_name: full,
      html_url: `https://github.com/${full}`,
      owner: { login: 'octo', type: 'User' },
      archived: false,
      private: false,
      allow_auto_merge: true,
      allow_squash_merge: true,
      default_branch: 'main',
      ...info,
    }),
    [`api repos/${full}/branches/main/protection`]: protection,
    [PR_LIST(full)]: json([pr(12, [check('Unit tests')])]),
    [`api repos/${full}/git/trees/main?recursive=1`]: json({ tree: [{ path: 'src/a.test.js', type: 'blob' }] }),
    [`api --paginate --slurp repos/${full}/labels?per_page=100`]: json([[{ name: 'bug' }]]),
  }
}

const ME = { 'api user': json({ login: 'octo' }) }
// Check runs `gh --version` first (requireGh in the repo guard). The lookup does not.
const GH_VERSION = { '--version': { code: 0, stdout: 'gh version 2.60.0 (2026-01-01)\n', stderr: '' } }

const orgRead = (full, extra = {}) => ({
  [`api repos/${full}`]: json({
    full_name: full,
    html_url: `https://github.com/${full}`,
    owner: { login: full.split('/')[0], type: 'Organization' },
    archived: false,
    default_branch: 'trunk',
    ...extra,
  }),
})

// The six reads of a personal repo, in the order the lookup makes them.
const SIX = (name) => [
  `api repos/octo/${name}`,
  'api user',
  `api repos/octo/${name}/branches/main/protection`,
  PR_LIST(`octo/${name}`),
  `api repos/octo/${name}/git/trees/main?recursive=1`,
  `api --paginate --slurp repos/octo/${name}/labels?per_page=100`,
]

// Each fixture is one repo whose class is known. Check prints the same repo
// from the same answers in the equivalence test.
const FIXTURES = {
  'set up': { expected: 'personal-set-up', answers: personal('widget-api') },
  'auto merge off': {
    expected: 'personal-not-set-up',
    answers: personal('widget-api', { info: { allow_auto_merge: false } }),
  },
  'no protection': {
    expected: 'personal-not-set-up',
    answers: personal('widget-api', { protection: fail(404, 'Branch not protected') }),
  },
  blocked: {
    expected: 'personal-not-set-up',
    answers: personal('widget-api', { info: { private: true }, protection: fail(403, UPGRADE) }),
  },
  'could not read': {
    expected: 'personal-not-set-up',
    answers: personal('widget-api', { protection: fail(500, 'Server Error') }),
  },
}

// A recording gh runner. `verify` fails the test when a call was not read-only,
// carried an input body, or was not in the table.
function ghFake(table) {
  const calls = []
  const bad = []
  const run = (args, input) => {
    calls.push(args)
    if (!isReadOnly(args)) bad.push(`not read-only: ${args.join(' ')}`)
    if (input !== undefined) bad.push(`input body on: ${args.join(' ')}`)
    const key = args.join(' ')
    if (!(key in table)) {
      bad.push(`unexpected call: ${key}`)
      throw new Error(`unexpected gh call: ${key}`)
    }
    const answer = table[key]
    return typeof answer === 'function' ? answer() : answer
  }
  return {
    run,
    calls,
    keys: () => calls.map((a) => a.join(' ')),
    verify: () => assert.deepEqual(bad, [], 'gh calls broke the contract'),
  }
}

// ---------------------------------------------------------------------------
// Saved git answers and an in-memory disk
// ---------------------------------------------------------------------------

const WORK = '/work/widget-api'
const STATE = '/state/orchestrai'
const GH_URL = 'https://github.com/octo/widget-api.git'
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })

// folders: { <path>: { notRepo, broken, gitThrows, remotes: {name: url}, head: {name: branch}, urlFails: [name],
//   pushUrls: {name: [url]} (default: the fetch URL), pushFails: [name] } }
function makeLocal({ folders, files = new Map(), failWrite = false, readThrows = false }) {
  const gitCalls = []
  const git = (args) => {
    gitCalls.push(args)
    assert.equal(args[0], '-C', 'every git call names its folder')
    const [, folder, ...rest] = args
    const f = folders[folder]
    if (f === undefined) throw new Error(`unexpected folder ${folder}`)
    if (f.gitThrows) throw new Error('could not run git')
    if (f.notRepo) {
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }
    }
    if (f.broken) return { code: 128, stdout: '', stderr: `fatal: ${f.broken}\n` }
    const remotes = f.remotes ?? {}
    const cmd = rest.join(' ')
    if (cmd === 'remote') return ok(Object.keys(remotes).map((n) => `${n}\n`).join(''))
    if (rest.slice(0, 5).join(' ') === 'remote get-url --push --all --') {
      const name = rest[5]
      if (!(name in remotes) || (f.pushFails ?? []).includes(name)) {
        return { code: 2, stdout: '', stderr: `error: No such remote '${name}'\n` }
      }
      const urls = (f.pushUrls ?? {})[name] ?? [remotes[name]]
      return ok(urls.map((u) => `${u}\n`).join(''))
    }
    if (rest[0] === 'remote' && rest[1] === 'get-url' && rest[2] === '--') {
      const name = rest[3]
      if (!(name in remotes) || (f.urlFails ?? []).includes(name)) {
        return { code: 2, stdout: '', stderr: `error: No such remote '${name}'\n` }
      }
      return ok(`${remotes[name]}\n`)
    }
    if (rest[0] === 'symbolic-ref' && rest[1] === '--short') {
      const name = rest[2].replace(/^refs\/remotes\//, '').replace(/\/HEAD$/, '')
      const branch = (f.head ?? {})[name]
      if (branch === undefined) return { code: 128, stdout: '', stderr: `fatal: ref ${rest[2]} is not a symbolic ref\n` }
      return ok(`${name}/${branch}\n`)
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  return {
    git,
    gitCalls,
    read: (path) => {
      if (readThrows) throw new Error('EACCES')
      return files.has(path) ? files.get(path) : null
    },
    write: (path, text) => {
      if (failWrite) throw new Error('disk full')
      files.set(path, text)
    },
  }
}

const DEFAULT_FOLDERS = {
  [WORK]: { remotes: { origin: GH_URL }, head: { origin: 'main' } },
  '/work/widget-api-wt': { remotes: { origin: GH_URL }, head: { origin: 'main' } },
}

// One lookup against fakes. Pass the same `files` to several calls to share a disk.
function lookup({
  table = {},
  folder = WORK,
  folders = DEFAULT_FOLDERS,
  files = new Map(),
  sessionId = 'sess-1',
  noSession = false,
  stateDir = STATE,
  ...localOpts
} = {}) {
  const gh = ghFake(table)
  const local = makeLocal({ folders, files, ...localOpts })
  const got = lookupRepoClass({ folder, sessionId: noSession ? undefined : sessionId, run: gh.run, local, stateDir })
  gh.verify()
  return { got, gh, local, files }
}

const SESSION_FILE = (id = 'sess-1') => `${STATE}/sessions/${id}.json`
const ORG_FILE = `${STATE}/organization-repos.json`

// ---------------------------------------------------------------------------
// parseGitHubRemote
// ---------------------------------------------------------------------------

describe('parseGitHubRemote', () => {
  const widget = { owner: 'octo', repo: 'widget-api' }

  test('reads the github.com URL forms', () => {
    const urls = [
      'https://github.com/octo/widget-api',
      'https://github.com/octo/widget-api.git',
      'https://github.com/octo/widget-api/',
      'https://github.com/octo/widget-api.git/',
      'https://octo@github.com/octo/widget-api.git',
      'https://x-access-token:TOKEN@github.com/octo/widget-api.git',
      'http://github.com/octo/widget-api.git',
      'git://github.com/octo/widget-api.git',
      'https://GitHub.com/octo/widget-api',
      'ssh://git@github.com/octo/widget-api.git',
      'ssh://git@github.com:22/octo/widget-api.git',
      'ssh://git@github.com:/octo/widget-api',
      'ssh://github.com/octo/widget-api',
      'git@github.com:octo/widget-api.git',
      'git@GITHUB.COM:octo/widget-api.git',
      'github.com:octo/widget-api',
      'git+ssh://git@github.com/octo/widget-api',
      'ssh+git://git@github.com/octo/widget-api.git',
      'GIT+SSH://git@github.com/octo/widget-api',
    ]
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), widget, url)
  })

  // git decodes %XX and strips [...] before it finds the host of an ssh://, git://
  // or scp-like remote, so these go to example.invalid, not to GitHub.
  test('marks a remote whose user part holds a percent sign or a bracket as invalid', () => {
    const urls = [
      'ssh://example.invalid%2F@github.com/octo/widget-api',
      'ssh://[example.invalid]@github.com/octo/widget-api',
      'ssh://[example.invalid:22]@github.com/octo/widget-api',
      '[example.invalid]@github.com:octo/widget-api',
      'git://example.invalid%2F@github.com/octo/widget-api',
      'https://example.invalid%2F@github.com/octo/widget-api',
      'git+ssh://[example.invalid]@github.com/octo/widget-api',
      'example.invalid%2F@github.com:octo/widget-api',
    ]
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), { invalid: true }, url)
  })

  test('a percent sign or bracket in the user part of a host that is not GitHub is still null', () => {
    assert.equal(parseGitHubRemote('ssh://[a]@example.invalid/octo/widget-api'), null)
    assert.equal(parseGitHubRemote('[a]@example.invalid:octo/widget-api'), null)
  })

  test('reads the other spellings of the GitHub host: ssh.github.com and one trailing dot', () => {
    const urls = [
      'ssh://git@ssh.github.com:443/octo/widget-api.git',
      'ssh://git@SSH.GitHub.com:443/octo/widget-api.git',
      'https://github.com./octo/widget-api',
      'https://GITHUB.COM./octo/widget-api',
      'ssh://git@github.com.:22/octo/widget-api.git',
      'git@github.com.:octo/widget-api.git',
      'git@ssh.github.com:octo/widget-api.git',
    ]
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), widget, url)
  })

  test('gives null for a host that only resembles GitHub', () => {
    const urls = [
      'https://www.github.com/octo/widget-api',
      'https://api.github.com/octo/widget-api',
      'https://gist.github.com/octo/widget-api',
      'ssh://git@ssh.github.com.example.invalid/octo/widget-api.git',
      'https://ssh.github.com.example.invalid/octo/widget-api',
      'https://github.com../octo/widget-api',
      'https://.github.com/octo/widget-api',
      'git@github.com..:octo/widget-api.git',
      'git@www.github.com:octo/widget-api.git',
      'git@ssh.github.com.example.invalid:octo/widget-api.git',
    ]
    for (const url of urls) assert.equal(parseGitHubRemote(url), null, url)
  })

  test('an http(s) host ends at the first slash, question mark, hash or backslash, so a later @ is not the host', () => {
    const urls = [
      'https://example.invalid#@github.com/octo/widget-api',
      'https://example.invalid?@github.com/octo/widget-api',
      'https://example.invalid/#@github.com/octo/widget-api',
      'https://example.invalid?x=1@github.com/octo/widget-api',
      'https://example.invalid#x@github.com/octo/widget-api',
      'https://example.invalid\\@github.com/octo/widget-api',
      'https://user:pw@example.invalid#@github.com/octo/widget-api',
    ]
    for (const url of urls) assert.equal(parseGitHubRemote(url), null, url)
  })

  // git's own ssh and git transports end the host only at the first slash (see
  // `git fetch-pack --diag-url`), and ssh splits user and host at the last @.
  test('an ssh or git remote keeps a ? # or backslash in the user part, so the host after the last @ is the host', () => {
    const urls = [
      'ssh://git@example.invalid?@ssh.github.com:443/octo/widget-api.git',
      'ssh://example.invalid#@github.com/octo/widget-api',
      'ssh://example.invalid\\@github.com/octo/widget-api',
      'git://example.invalid?x@github.com/octo/widget-api',
    ]
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), widget, url)
  })

  test('an ssh or git remote whose host part holds ? or # is a different host, not GitHub', () => {
    const urls = [
      'ssh://github.com?x/octo/widget-api',
      'ssh://github.com#x/octo/widget-api',
      'ssh://git@github.com:22#/octo/widget-api',
      'git://github.com?@example.invalid/octo/widget-api',
    ]
    for (const url of urls) assert.equal(parseGitHubRemote(url), null, url)
  })

  test('a percent sign or bracket in the host part is invalid, not GitHub and not another host', () => {
    const urls = ['ssh://%67ithub.com/octo/widget-api', 'ssh://git@[github.com]:22/octo/widget-api', '[github.com]:octo/widget-api', 'ssh://[example.invalid]/octo/widget-api']
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), { invalid: true }, url)
  })

  test('a fragment or query after a real github.com path makes the path invalid, never another repo', () => {
    const urls = [
      'https://user:token@github.com/octo/widget-api#frag',
      'https://github.com/octo/widget-api?x=1',
      'https://github.com/octo/widget-api.git#frag',
      'https://github.com?x=1',
      'https://github.com#/octo/widget-api',
      'https://github.com?/octo/widget-api',
    ]
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), { invalid: true }, url)
  })

  test('a scp-like user part may hold a hash, because ssh splits at the last @', () => {
    // `ssh -G 'example.invalid#@github.com'` gives user `example.invalid#` and host github.com.
    assert.deepEqual(parseGitHubRemote('example.invalid#@github.com:octo/widget-api'), widget)
    assert.equal(parseGitHubRemote('git@example.invalid#@notgithub.com:octo/widget-api'), null)
  })

  test('keeps the case of the owner and repo name', () => {
    assert.deepEqual(parseGitHubRemote('https://github.com/Octo/Widget-API.git'), { owner: 'Octo', repo: 'Widget-API' })
  })

  test('gives null for a host other than github.com, a local path or a file URL', () => {
    const urls = [
      'https://git.example.invalid/octo/widget-api.git',
      'git@git.example.invalid:octo/widget-api.git',
      'https://github.com.example.invalid/octo/widget-api',
      'https://example.invalid/github.com/octo/widget-api',
      'https://www.github.com/octo/widget-api',
      'ssh://git@gh-work/octo/widget-api.git',
      'git@gh-work:octo/widget-api.git',
      '/srv/git/widget-api.git',
      '../widget-api',
      'file:///srv/git/widget-api.git',
      'file://github.com/octo/widget-api',
      '',
    ]
    for (const url of urls) assert.equal(parseGitHubRemote(url), null, url)
    assert.equal(parseGitHubRemote(undefined), null)
    assert.equal(parseGitHubRemote(42), null)
  })

  test('marks a github.com URL whose path is not exactly owner/repo as invalid', () => {
    const urls = [
      'https://github.com',
      'https://github.com/',
      'https://github.com/octo',
      'https://github.com/octo/widget-api/extra',
      'https://github.com/octo/widget api',
      'https://github.com/octo/.hidden',
      'https://github.com/-octo/widget-api',
      'https://github.com/octo/widget-api?tab=readme',
      'git@github.com:octo',
      'git@github.com:/octo/widget-api',
    ]
    for (const url of urls) assert.deepEqual(parseGitHubRemote(url), { invalid: true }, url)
  })
})

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

describe('lookupRepoClass: the folder', () => {
  test('exports the four class strings', () => {
    assert.deepEqual([...REPO_CLASSES].sort(), ['no-github-repo', 'organization', 'personal-not-set-up', 'personal-set-up'])
  })

  test('a folder that is not a git repo is no-github-repo, with no gh call', () => {
    const { got, gh, files } = lookup({ folder: '/work/plain', folders: { '/work/plain': { notRepo: true } } })
    assert.deepEqual(got, { repoClass: 'no-github-repo', owner: null, repo: null, defaultBranch: null, source: 'local' })
    assert.equal(gh.calls.length, 0)
    assert.equal(files.size, 0)
  })

  test('a repo with no remote is no-github-repo', () => {
    const { got, gh } = lookup({ folder: '/work/local-only', folders: { '/work/local-only': { remotes: {} } } })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(got.source, 'local')
    assert.equal(got.defaultBranch, null)
    assert.equal(gh.calls.length, 0)
  })

  test('a remote that is not on github.com is no-github-repo, with the default branch from its HEAD', () => {
    const folders = { '/work/x': { remotes: { origin: 'https://git.example.invalid/octo/x.git' }, head: { origin: 'trunk' } } }
    const { got, gh } = lookup({ folder: '/work/x', folders })
    assert.deepEqual(got, { repoClass: 'no-github-repo', owner: null, repo: null, defaultBranch: 'trunk', source: 'local' })
    assert.equal(gh.calls.length, 0)
  })

  test('a remote that is not on github.com and has no HEAD gives a null default branch', () => {
    const folders = { '/work/x': { remotes: { origin: 'git@gh-work:octo/x.git' } } }
    const { got } = lookup({ folder: '/work/x', folders })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(got.defaultBranch, null)
  })

  test('the only remote is used when it is not named origin', () => {
    const folders = { '/work/x': { remotes: { upstream: GH_URL } } }
    const table = { ...personal('widget-api'), ...ME }
    const { got } = lookup({ folder: '/work/x', folders, table })
    assert.equal(got.repoClass, 'personal-set-up')
    assert.equal(got.repo, 'widget-api')
  })

  test('origin wins over other remotes', () => {
    const folders = { '/work/x': { remotes: { fork: 'https://github.com/other/fork.git', origin: GH_URL } } }
    const table = { ...personal('widget-api'), ...ME }
    const { gh } = lookup({ folder: '/work/x', folders, table })
    assert.equal(gh.keys()[0], 'api repos/octo/widget-api')
  })

  test('several remotes with no origin, one on github.com, is personal-not-set-up with no gh call', () => {
    const folders = { '/work/x': { remotes: { fork: 'https://github.com/other/fork.git', mirror: 'https://git.example.invalid/m.git' } } }
    const { got, gh } = lookup({ folder: '/work/x', folders })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.match(got.detail, /origin/)
    assert.equal(gh.calls.length, 0)
  })

  test('several remotes with no origin, none on github.com, is no-github-repo', () => {
    const folders = { '/work/x': { remotes: { a: 'https://git.example.invalid/a.git', b: '/srv/git/b.git' } } }
    const { got, gh } = lookup({ folder: '/work/x', folders })
    assert.equal(got.repoClass, 'no-github-repo')
    assert.equal(gh.calls.length, 0)
  })

  test('a look-alike URL with the set-up answers is no-github-repo, with no gh call', () => {
    const table = { ...FIXTURES['set up'].answers, ...ME }
    for (const url of ['https://example.invalid#@github.com/octo/widget-api', 'https://example.invalid?@github.com/octo/widget-api']) {
      const folders = { '/work/x': { remotes: { origin: url } } }
      const { got, gh } = lookup({ folder: '/work/x', folders, table })
      assert.equal(got.repoClass, 'no-github-repo', url)
      assert.equal(got.source, 'local', url)
      assert.equal(gh.calls.length, 0, url)
    }
  })

  test('ssh.github.com and a trailing dot are read from github.com, as personal-set-up', () => {
    const table = { ...FIXTURES['set up'].answers, ...ME }
    for (const url of ['ssh://git@ssh.github.com:443/octo/widget-api.git', 'https://github.com./octo/widget-api']) {
      const folders = { '/work/x': { remotes: { origin: url } } }
      const { got, gh } = lookup({ folder: '/work/x', folders, table })
      assert.equal(got.repoClass, 'personal-set-up', url)
      assert.deepEqual(gh.keys(), SIX('widget-api'), url)
    }
  })

  test('a remote git sends to another host, with an organization answer ready, is personal-not-set-up with no gh call', () => {
    const files = new Map()
    for (const url of ['ssh://example.invalid%2F@github.com/some-org/shared', '[example.invalid]@github.com:some-org/shared']) {
      const folders = { '/work/shared': { remotes: { origin: url } } }
      const { got, gh } = lookup({ folder: '/work/shared', folders, table: orgRead('some-org/shared'), files })
      assert.equal(got.repoClass, 'personal-not-set-up', url)
      assert.equal(got.source, 'fallback', url)
      assert.equal(gh.calls.length, 0, url)
    }
    assert.equal(files.size, 0)
  })

  describe('push URLs', () => {
    const SHARED = 'https://github.com/some-org/shared.git'
    const fork = (pushUrls, extra = {}) => ({
      '/work/shared': { remotes: { origin: SHARED }, head: { origin: 'trunk' }, pushUrls: { origin: pushUrls }, ...extra },
    })

    test('a push URL equal to the fetch URL changes nothing: same answer, same number of gh calls', () => {
      const same = lookup({ folder: '/work/shared', folders: fork([SHARED]), table: orgRead('some-org/shared') })
      const plain = lookup({ folder: '/work/shared', folders: { '/work/shared': { remotes: { origin: SHARED } } }, table: orgRead('some-org/shared') })
      assert.equal(same.got.repoClass, 'organization')
      assert.deepEqual(same.got, plain.got)
      assert.equal(same.gh.calls.length, 1)
    })

    test('a push URL that names the same repo in another spelling or case is fine', () => {
      const urls = ['git@github.com:Some-Org/Shared.git', 'ssh://git@ssh.github.com:443/some-org/shared']
      const { got, gh } = lookup({ folder: '/work/shared', folders: fork(urls), table: orgRead('some-org/shared') })
      assert.equal(got.repoClass, 'organization')
      assert.equal(gh.calls.length, 1)
    })

    test('a push URL for another GitHub repo is personal-not-set-up with no gh call', () => {
      const { got, gh } = lookup({ folder: '/work/shared', folders: fork(['https://github.com/octo/shared-fork.git']), table: orgRead('some-org/shared') })
      assert.equal(got.repoClass, 'personal-not-set-up')
      assert.equal(got.source, 'fallback')
      assert.equal(got.defaultBranch, 'trunk')
      assert.match(got.detail, /push/)
      assert.equal(gh.calls.length, 0)
    })

    test('a push URL that is not on GitHub is personal-not-set-up with no gh call', () => {
      for (const url of ['https://git.example.invalid/some-org/shared.git', '/srv/git/shared.git', 'https://github.com/some-org']) {
        const { got, gh } = lookup({ folder: '/work/shared', folders: fork([url]), table: orgRead('some-org/shared') })
        assert.equal(got.repoClass, 'personal-not-set-up', url)
        assert.equal(got.source, 'fallback', url)
        assert.equal(gh.calls.length, 0, url)
      }
    })

    test('two push URLs where one differs is personal-not-set-up with no gh call, in either order', () => {
      const other = 'https://github.com/octo/shared-fork.git'
      for (const urls of [[SHARED, other], [other, SHARED]]) {
        const { got, gh } = lookup({ folder: '/work/shared', folders: fork(urls), table: orgRead('some-org/shared') })
        assert.equal(got.repoClass, 'personal-not-set-up', urls.join(' '))
        assert.equal(gh.calls.length, 0)
      }
    })

    test('no push URL at all is personal-not-set-up, never trusted', () => {
      const { got, gh } = lookup({ folder: '/work/shared', folders: fork([]), table: orgRead('some-org/shared') })
      assert.equal(got.repoClass, 'personal-not-set-up')
      assert.equal(gh.calls.length, 0)
    })

    test('the push check runs before the session memory, so a changed push URL is not hidden by it', () => {
      const files = new Map()
      lookup({ folder: '/work/shared', folders: fork([SHARED]), table: orgRead('some-org/shared'), files })
      const second = lookup({ folder: '/work/shared', folders: fork(['https://github.com/octo/shared-fork.git']), table: {}, files })
      assert.equal(second.got.repoClass, 'personal-not-set-up')
      assert.equal(second.got.source, 'fallback')
    })

    test('a failing push URL read throws, like any other unexpected git failure', () => {
      assert.throws(() => lookup({ folder: '/work/shared', folders: fork([SHARED], { pushFails: ['origin'] }), table: orgRead('some-org/shared') }))
    })

    test('a first lookup of a set-up personal repo makes three git calls and six gh calls', () => {
      const table = { ...FIXTURES['set up'].answers, ...ME }
      const { gh, local } = lookup({ table })
      assert.equal(gh.calls.length, 6)
      assert.deepEqual(local.gitCalls.map((a) => a.slice(2).join(' ')), [
        'remote',
        'remote get-url -- origin',
        'remote get-url --push --all -- origin',
      ])
    })

    describe('when the fetch URL is not on GitHub', () => {
      const ELSEWHERE = 'https://git.example.invalid/some-org/shared.git'
      const GH_PUSH = 'https://github.com/octo/widget-api.git'
      const away = (pushUrls, extra = {}) => ({
        '/work/x': { remotes: { origin: ELSEWHERE }, head: { origin: 'trunk' }, pushUrls: { origin: pushUrls }, ...extra },
      })
      const calls = (local) => local.gitCalls.map((a) => a.slice(2).join(' '))

      test('a GitHub push URL is personal-not-set-up, source fallback, with no gh call', () => {
        const table = { ...FIXTURES['set up'].answers, ...ME }
        const { got, gh, files } = lookup({ folder: '/work/x', folders: away([GH_PUSH]), table })
        assert.equal(got.repoClass, 'personal-not-set-up')
        assert.equal(got.source, 'fallback')
        assert.equal(got.defaultBranch, 'trunk')
        assert.match(got.detail, /push/)
        assert.equal(gh.calls.length, 0)
        assert.equal(files.size, 0)
      })

      test('two push URLs where one is GitHub, in either order', () => {
        for (const urls of [[ELSEWHERE, GH_PUSH], [GH_PUSH, ELSEWHERE]]) {
          const { got, gh } = lookup({ folder: '/work/x', folders: away(urls) })
          assert.equal(got.repoClass, 'personal-not-set-up', urls.join(' '))
          assert.equal(got.source, 'fallback', urls.join(' '))
          assert.equal(gh.calls.length, 0)
        }
      })

      test('an invalid github.com push URL counts as GitHub', () => {
        for (const url of ['https://github.com/octo', 'ssh://[example.invalid]@github.com/octo/widget-api']) {
          const { got, gh } = lookup({ folder: '/work/x', folders: away([url]) })
          assert.equal(got.repoClass, 'personal-not-set-up', url)
          assert.equal(got.source, 'fallback', url)
          assert.equal(gh.calls.length, 0, url)
        }
      })

      test('a push URL that is not on GitHub either stays no-github-repo, source local', () => {
        const { got, gh } = lookup({ folder: '/work/x', folders: away(['https://git.example.invalid/other.git', '/srv/git/shared.git']) })
        assert.deepEqual(got, { repoClass: 'no-github-repo', owner: null, repo: null, defaultBranch: 'trunk', source: 'local' })
        assert.equal(gh.calls.length, 0)
      })

      test('a failing push URL read throws, like any other unexpected git failure', () => {
        assert.throws(() => lookup({ folder: '/work/x', folders: away([ELSEWHERE], { pushFails: ['origin'] }) }))
      })

      test('a non-GitHub remote costs four git calls, the push read included, and no gh call', () => {
        const { gh, local } = lookup({ folder: '/work/x', folders: away([ELSEWHERE]) })
        assert.equal(gh.calls.length, 0)
        assert.deepEqual(calls(local), [
          'remote',
          'remote get-url -- origin',
          'remote get-url --push --all -- origin',
          'symbolic-ref --short refs/remotes/origin/HEAD',
        ])
      })

      test('an invalid github.com fetch URL is personal-not-set-up and the push URLs are not read', () => {
        const folders = away(['https://git.example.invalid/other.git'])
        folders['/work/x'].remotes.origin = 'https://github.com/octo'
        const { got, local } = lookup({ folder: '/work/x', folders })
        assert.equal(got.repoClass, 'personal-not-set-up')
        assert.equal(got.source, 'fallback')
        assert.equal(calls(local).some((c) => c.includes('--push')), false)
      })
    })

    describe('several remotes and none named origin', () => {
      const ELSEWHERE = 'https://git.example.invalid/a.git'
      const many = (pushUrls) => ({
        '/work/x': { remotes: { a: ELSEWHERE, b: 'https://git.example.invalid/b.git' }, pushUrls },
      })

      test('a GitHub push URL on one of them is personal-not-set-up with no gh call', () => {
        const { got, gh } = lookup({ folder: '/work/x', folders: many({ b: ['https://github.com/octo/widget-api.git'] }) })
        assert.equal(got.repoClass, 'personal-not-set-up')
        assert.equal(got.source, 'fallback')
        assert.match(got.detail, /origin/)
        assert.equal(gh.calls.length, 0)
      })

      test('no GitHub URL anywhere stays no-github-repo, with each remote read for fetch and push', () => {
        const { got, gh, local } = lookup({ folder: '/work/x', folders: many({}) })
        assert.equal(got.repoClass, 'no-github-repo')
        assert.equal(got.source, 'local')
        assert.equal(gh.calls.length, 0)
        assert.deepEqual(local.gitCalls.map((a) => a.slice(2).join(' ')), [
          'remote',
          'remote get-url -- a',
          'remote get-url --push --all -- a',
          'remote get-url -- b',
          'remote get-url --push --all -- b',
        ])
      })

      test('a failing push URL read throws', () => {
        const folders = many({})
        folders['/work/x'].pushFails = ['b']
        assert.throws(() => lookup({ folder: '/work/x', folders }))
      })
    })
  })

  test('a github.com URL with a bad path is personal-not-set-up with no gh call', () => {
    const folders = { '/work/x': { remotes: { origin: 'https://github.com/octo' }, head: { origin: 'main' } } }
    const { got, gh } = lookup({ folder: '/work/x', folders })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.equal(got.defaultBranch, 'main')
    assert.equal(gh.calls.length, 0)
  })

  test('any other git failure throws, so the hook can block', () => {
    const cases = [
      { broken: 'detected dubious ownership in repository at /work/x' },
      { gitThrows: true },
      { remotes: { origin: GH_URL }, urlFails: ['origin'] },
    ]
    for (const f of cases) {
      assert.throws(() => lookup({ folder: '/work/x', folders: { '/work/x': f } }), undefined, JSON.stringify(f))
    }
  })

  test('refuses a folder that is not an absolute path, and a missing state dir', () => {
    const args = { run: () => ok(), local: makeLocal({ folders: DEFAULT_FOLDERS }), sessionId: 's', stateDir: STATE }
    assert.throws(() => lookupRepoClass({ ...args, folder: 'work/widget-api' }), TypeError)
    assert.throws(() => lookupRepoClass({ ...args, folder: '-C' }), TypeError)
    assert.throws(() => lookupRepoClass({ ...args, folder: undefined }), TypeError)
    assert.throws(() => lookupRepoClass({ ...args, folder: WORK, stateDir: '' }), TypeError)
    assert.throws(() => lookupRepoClass({ ...args, folder: WORK, stateDir: 'state/orchestrai' }), TypeError)
    assert.throws(() => lookupRepoClass({ ...args, folder: WORK, stateDir: undefined }), TypeError)
  })

  test('the remote URL is never stored or returned', () => {
    const folders = { [WORK]: { remotes: { origin: 'https://x-access-token:SECRET-TOKEN@github.com/octo/widget-api.git' } } }
    const table = { ...personal('widget-api'), ...ME }
    const { got, files } = lookup({ folders, table })
    assert.equal(got.repoClass, 'personal-set-up')
    const everything = JSON.stringify(got) + [...files.values()].join('\n')
    assert.doesNotMatch(everything, /SECRET-TOKEN/)
  })
})

// ---------------------------------------------------------------------------
// GitHub's answers
// ---------------------------------------------------------------------------

describe('lookupRepoClass: GitHub', () => {
  test('a set up personal repo is personal-set-up, after exactly six reads', () => {
    const { got, gh } = lookup({ table: { ...FIXTURES['set up'].answers, ...ME } })
    assert.deepEqual(got, {
      repoClass: 'personal-set-up',
      owner: 'octo',
      repo: 'widget-api',
      defaultBranch: 'main',
      source: 'github',
    })
    assert.deepEqual(gh.keys(), SIX('widget-api'))
  })

  test('a personal repo with auto merge off is personal-not-set-up', () => {
    const { got } = lookup({ table: { ...FIXTURES['auto merge off'].answers, ...ME } })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
  })

  test('a personal repo with no protection is personal-not-set-up', () => {
    const { got } = lookup({ table: { ...FIXTURES['no protection'].answers, ...ME } })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
  })

  test('a blocked personal repo is personal-not-set-up', () => {
    const { got } = lookup({ table: { ...FIXTURES.blocked.answers, ...ME } })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
  })

  test('a repo whose settings cannot be read is personal-not-set-up, source fallback, with a reason', () => {
    const { got } = lookup({ table: { ...FIXTURES['could not read'].answers, ...ME } })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.match(got.detail, /branch protection: Server Error/)
    assert.equal(got.defaultBranch, 'main')
  })

  test('an organization repo is organization, after exactly one read', () => {
    const folders = { '/work/shared': { remotes: { origin: 'git@github.com:some-org/shared.git' } } }
    const { got, gh } = lookup({ folder: '/work/shared', folders, table: orgRead('some-org/shared') })
    assert.deepEqual(got, {
      repoClass: 'organization',
      owner: 'some-org',
      repo: 'shared',
      defaultBranch: 'trunk',
      source: 'github',
    })
    assert.deepEqual(gh.keys(), ['api repos/some-org/shared'])
  })

  describe('an answer that does not come from github.com is no answer', () => {
    const wrongHost = (extra) => {
      const info = JSON.parse(orgRead('some-org/shared')['api repos/some-org/shared'].stdout)
      return { 'api repos/some-org/shared': json({ ...info, ...extra }) }
    }
    const folders = { '/work/shared': { remotes: { origin: 'git@github.com:some-org/shared.git' }, head: { origin: 'trunk' } } }

    test('an html_url on another host takes the offline path and leaves the organization list alone', () => {
      const files = new Map()
      const table = wrongHost({ html_url: 'https://ghe.example.invalid/some-org/shared' })
      const { got, gh } = lookup({ folder: '/work/shared', folders, table, files })
      assert.equal(got.repoClass, 'personal-not-set-up')
      assert.equal(got.source, 'fallback')
      assert.equal(got.defaultBranch, 'trunk')
      assert.match(got.detail, /github\.com/)
      assert.deepEqual(gh.keys(), ['api repos/some-org/shared'])
      assert.equal(files.has(ORG_FILE), false)
    })

    test('a missing html_url counts the same way', () => {
      const files = new Map()
      const table = wrongHost({ html_url: undefined })
      const { got } = lookup({ folder: '/work/shared', folders, table, files })
      assert.equal(got.repoClass, 'personal-not-set-up')
      assert.equal(got.source, 'fallback')
      assert.equal(files.has(ORG_FILE), false)
    })

    test('a look-alike prefix is not github.com', () => {
      const table = wrongHost({ html_url: 'https://github.com.example.invalid/some-org/shared' })
      assert.equal(lookup({ folder: '/work/shared', folders, table }).got.source, 'fallback')
    })

    test('a wrong-host answer does not remove an organization entry that was remembered', () => {
      const files = new Map([[ORG_FILE, JSON.stringify({ repos: ['some-org/shared'] })]])
      const table = wrongHost({ html_url: 'https://ghe.example.invalid/some-org/shared', owner: { login: 'some-org', type: 'User' } })
      const { got } = lookup({ folder: '/work/shared', folders, table, files })
      assert.equal(got.repoClass, 'organization')
      assert.equal(got.source, 'remembered-owner')
      assert.deepEqual(JSON.parse(files.get(ORG_FILE)), { repos: ['some-org/shared'] })
    })

    test('the right host in upper case is accepted', () => {
      const table = wrongHost({ html_url: 'HTTPS://GitHub.com/some-org/shared' })
      const { got } = lookup({ folder: '/work/shared', folders, table })
      assert.equal(got.repoClass, 'organization')
      assert.equal(got.source, 'github')
    })
  })

  test("another user's repo is personal-not-set-up", () => {
    const table = {
      ...ME,
      'api repos/octo/widget-api': json({
        full_name: 'octo/widget-api',
        html_url: 'https://github.com/octo/widget-api',
        owner: { login: 'someone-else', type: 'User' },
        default_branch: 'main',
      }),
    }
    const { got, gh } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
    assert.deepEqual(gh.keys(), ['api repos/octo/widget-api', 'api user'])
  })

  test('an archived personal repo is personal-not-set-up', () => {
    const table = { ...personal('widget-api', { info: { archived: true } }), ...ME }
    const { got, gh } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
    assert.equal(gh.calls.length, 2)
  })

  test('an unknown owner type is personal-not-set-up', () => {
    const table = { ...personal('widget-api', { info: { owner: { login: 'octo', type: 'Bot' } } }), ...ME }
    const { got, gh } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
    assert.equal(gh.calls.length, 2)
  })

  test('a repo read with no owner at all is personal-not-set-up', () => {
    const table = { ...personal('widget-api', { info: { owner: undefined } }), ...ME }
    const { got } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'github')
  })

  test('the logged-in account is compared without regard to case', () => {
    const table = { ...personal('widget-api'), 'api user': json({ login: 'OCTO' }) }
    assert.equal(lookup({ table }).got.repoClass, 'personal-set-up')
  })

  test('when the account cannot be read the answer is personal-not-set-up, source fallback', () => {
    const table = { ...personal('widget-api'), 'api user': fail(401, 'Bad credentials') }
    const { got, gh } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.match(got.detail, /Bad credentials/)
    assert.equal(gh.calls.length, 2)
  })

  test('a user answer with no login is treated as unreadable', () => {
    const table = { ...personal('widget-api'), 'api user': json({}) }
    const { got } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
  })

  test('every call goes through the read-only guard: a refused call never reaches the runner', () => {
    // A full_name of `--web` would make the pull request call `pr list --repo --web ...`,
    // which the guard refuses because a flag value starts with a dash.
    const table = {
      ...ME,
      'api repos/octo/widget-api': json({
        full_name: '--web',
        html_url: 'https://github.com/--web',
        owner: { login: 'octo', type: 'User' },
        default_branch: 'main',
        allow_auto_merge: true,
        allow_squash_merge: true,
      }),
      'api repos/--web/branches/main/protection': fail(404, 'Branch not protected'),
    }
    const { got, gh } = lookup({ table })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.match(got.detail, /refusing a call that is not read-only/)
    assert.equal(gh.keys().some((k) => k.startsWith('pr list')), false)
  })

  test('owner and repo come from the full_name GitHub returns, after a rename', () => {
    const table = { ...personal('new-name'), ...ME, 'api repos/octo/widget-api': personal('new-name')['api repos/octo/new-name'] }
    const { got } = lookup({ table })
    assert.equal(got.repoClass, 'personal-set-up')
    assert.equal(got.repo, 'new-name')
    assert.equal(got.owner, 'octo')
  })
})

// ---------------------------------------------------------------------------
// Same result as Check
// ---------------------------------------------------------------------------

describe('lookupRepoClass: same result as Check', () => {
  for (const [label, { expected, answers }] of Object.entries(FIXTURES)) {
    test(`${label}: the class is personal-set-up exactly when Check prints "set up"`, () => {
      const checkTable = {
        ...GH_VERSION,
        ...ME,
        ...answers,
        [LISTING]: json([[{ full_name: 'octo/widget-api', owner: { login: 'octo' }, archived: false }]]),
      }
      const checkRun = ghFake(checkTable)
      const printed = render(collect(checkRun.run))
      checkRun.verify()
      const printedSetUp = /^octo\/widget-api: set up$/m.test(printed)

      const { got } = lookup({ table: { ...answers, ...ME } })
      assert.equal(got.repoClass, expected)
      assert.equal(got.repoClass === 'personal-set-up', printedSetUp, printed)
    })
  }

  test('the fixtures cover both outcomes, so the comparison cannot pass trivially', () => {
    const classes = new Set(Object.values(FIXTURES).map((f) => f.expected))
    assert.deepEqual([...classes].sort(), ['personal-not-set-up', 'personal-set-up'])
  })

  test('the lookup makes the same reads Check makes for that repo', () => {
    const answers = FIXTURES['set up'].answers
    const checkRun = ghFake({ ...GH_VERSION, ...ME, ...answers, [LISTING]: json([[{ full_name: 'octo/widget-api', owner: { login: 'octo' }, archived: false }]]) })
    collect(checkRun.run)
    const perRepo = checkRun.keys().filter((k) => k !== '--version' && k !== 'api user' && k !== LISTING)
    const { gh } = lookup({ table: { ...answers, ...ME } })
    assert.deepEqual(gh.keys().filter((k) => k !== 'api user').sort(), perRepo.sort())
  })
})

// ---------------------------------------------------------------------------
// Session memory
// ---------------------------------------------------------------------------

describe('lookupRepoClass: session memory', () => {
  const live = { ...FIXTURES['set up'].answers, ...ME }

  test('a second lookup in the same session makes no call to GitHub', () => {
    const files = new Map()
    const first = lookup({ table: live, files })
    assert.equal(first.gh.calls.length, 6)
    const second = lookup({ table: {}, files })
    assert.equal(second.gh.calls.length, 0)
    assert.deepEqual(second.got, { ...first.got, source: 'session' })
  })

  test('the memory is one file per session, keyed by the remote, with the whole answer', () => {
    const { files, got } = lookup({ table: live })
    const stored = JSON.parse(files.get(SESSION_FILE()))
    assert.deepEqual(Object.keys(stored), ['octo/widget-api'])
    assert.equal(stored['octo/widget-api'].repoClass, got.repoClass)
    assert.equal(stored['octo/widget-api'].defaultBranch, 'main')
  })

  test('a worktree folder of the same repo makes no call to GitHub', () => {
    const files = new Map()
    lookup({ table: live, files })
    const second = lookup({ folder: '/work/widget-api-wt', table: {}, files })
    assert.equal(second.gh.calls.length, 0)
    assert.equal(second.got.source, 'session')
    assert.equal(second.got.repoClass, 'personal-set-up')
  })

  test('the key does not depend on the case of the remote', () => {
    const files = new Map()
    lookup({ table: live, files })
    const folders = { [WORK]: { remotes: { origin: 'https://github.com/OCTO/Widget-API.git' } } }
    const second = lookup({ table: {}, files, folders })
    assert.equal(second.gh.calls.length, 0)
  })

  test('another session looks up again', () => {
    const files = new Map()
    lookup({ table: live, files, sessionId: 'sess-1' })
    const second = lookup({ table: live, files, sessionId: 'sess-2' })
    assert.equal(second.gh.calls.length, 6)
    assert.equal(second.got.source, 'github')
    assert.ok(files.has(SESSION_FILE('sess-2')))
  })

  test('another repo in the same session is looked up, and both stay remembered', () => {
    const files = new Map()
    lookup({ table: live, files })
    const folders = { '/work/other': { remotes: { origin: 'https://github.com/octo/other.git' } } }
    const other = lookup({ folder: '/work/other', folders, table: { ...personal('other'), ...ME }, files })
    assert.equal(other.gh.calls.length, 6)
    assert.deepEqual(Object.keys(JSON.parse(files.get(SESSION_FILE()))).sort(), ['octo/other', 'octo/widget-api'])
  })

  test('a fallback answer is remembered for the session, offline or not', () => {
    const files = new Map()
    const table = { 'api repos/octo/widget-api': () => { throw new Error('network down') } }
    const first = lookup({ table, files })
    assert.equal(first.got.source, 'fallback')
    const second = lookup({ table: {}, files })
    assert.equal(second.gh.calls.length, 0)
    assert.equal(second.got.repoClass, 'personal-not-set-up')
    assert.equal(second.got.source, 'session')
    assert.equal(second.got.detail, first.got.detail)
  })

  test('an invalid or missing session id means no memory is read or written', () => {
    const ids = [null, '', '../escape', 'a b', 'a/b', 'x'.repeat(129), 42, { toString: () => 's' }, 'NO SESSION']
    for (const sessionId of ids) {
      const files = new Map()
      const opts = sessionId === 'NO SESSION' ? { noSession: true } : { sessionId }
      const first = lookup({ table: live, files, ...opts })
      const second = lookup({ table: live, files, ...opts })
      assert.equal(first.gh.calls.length, 6, String(sessionId))
      assert.equal(second.gh.calls.length, 6, String(sessionId))
      assert.deepEqual([...files.keys()].filter((k) => k.includes('/sessions/')), [], String(sessionId))
    }
  })

  test('an id of 128 allowed characters is used', () => {
    const files = new Map()
    const sessionId = `${'A'.repeat(61)}-${'z_9'.repeat(22)}`
    lookup({ table: live, files, sessionId })
    assert.ok(files.has(SESSION_FILE(sessionId)))
  })

  test('a corrupt memory file is a miss and is overwritten', () => {
    const files = new Map([[SESSION_FILE(), '{not json']])
    const { gh } = lookup({ table: live, files })
    assert.equal(gh.calls.length, 6)
    assert.equal(JSON.parse(files.get(SESSION_FILE()))['octo/widget-api'].repoClass, 'personal-set-up')
  })

  test('an entry with an unknown class is a miss', () => {
    for (const entry of [{ repoClass: 'made-up' }, { repoClass: 7 }, 'personal-set-up', null, {}]) {
      const files = new Map([[SESSION_FILE(), JSON.stringify({ 'octo/widget-api': entry })]])
      const { gh, got } = lookup({ table: live, files })
      assert.equal(gh.calls.length, 6, JSON.stringify(entry))
      assert.equal(got.source, 'github')
    }
  })

  test('a memory file that cannot be read is a miss', () => {
    const { gh, got } = lookup({ table: live, readThrows: true })
    assert.equal(gh.calls.length, 6)
    assert.equal(got.repoClass, 'personal-set-up')
  })

  test('a failing write keeps the answer', () => {
    const { got, files } = lookup({ table: live, failWrite: true })
    assert.equal(got.repoClass, 'personal-set-up')
    assert.equal(files.size, 0)
  })

  test('an organization answer is remembered for the session', () => {
    const files = new Map()
    const folders = { '/work/shared': { remotes: { origin: 'https://github.com/some-org/shared' } } }
    lookup({ folder: '/work/shared', folders, table: orgRead('some-org/shared'), files })
    const second = lookup({ folder: '/work/shared', folders, table: {}, files })
    assert.equal(second.gh.calls.length, 0)
    assert.equal(second.got.repoClass, 'organization')
  })

  test('a lookup that needs no gh call writes no session memory', () => {
    const { files } = lookup({ folder: '/work/plain', folders: { '/work/plain': { notRepo: true } } })
    assert.equal(files.size, 0)
  })
})

// ---------------------------------------------------------------------------
// GitHub cannot be reached
// ---------------------------------------------------------------------------

describe('lookupRepoClass: GitHub cannot be reached', () => {
  const offline = (answer) => ({ 'api repos/octo/widget-api': answer })
  const live = { ...FIXTURES['set up'].answers, ...ME }
  const ORG_URL_FOLDERS = { '/work/shared': { remotes: { origin: 'https://github.com/some-org/shared.git' }, head: { origin: 'trunk' } } }
  const orgLookup = (opts) => lookup({ folder: '/work/shared', folders: ORG_URL_FOLDERS, ...opts })
  const orgList = (files) => JSON.parse(files.get(ORG_FILE)).repos

  test('a personal repo never seen counts as not set up, after one call', () => {
    const { got, gh } = lookup({ table: offline(() => { throw new Error('network down') }) })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
    assert.equal(got.owner, 'octo')
    assert.equal(got.repo, 'widget-api')
    assert.equal(got.defaultBranch, 'main')
    assert.match(got.detail, /network down/)
    assert.deepEqual(gh.keys(), ['api repos/octo/widget-api'])
  })

  test('a personal repo seen before counts as not set up too', () => {
    const files = new Map()
    assert.equal(lookup({ table: live, files, sessionId: 's1' }).got.repoClass, 'personal-set-up')
    const { got } = lookup({ table: offline(fail(500, 'Server Error')), files, sessionId: 's2' })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
  })

  test('an organization repo seen once stays organization in a later session', () => {
    const files = new Map()
    assert.equal(orgLookup({ table: orgRead('some-org/shared'), files, sessionId: 's1' }).got.source, 'github')
    const { got, gh } = orgLookup({
      table: { 'api repos/some-org/shared': fail(502, 'Bad Gateway') },
      files,
      sessionId: 's2',
    })
    assert.equal(got.repoClass, 'organization')
    assert.equal(got.source, 'remembered-owner')
    assert.equal(got.owner, 'some-org')
    assert.equal(got.repo, 'shared')
    assert.equal(got.defaultBranch, 'trunk')
    assert.deepEqual(gh.keys(), ['api repos/some-org/shared'])
  })

  test('an organization repo never seen, offline, counts as a personal repo that is not set up', () => {
    const { got } = orgLookup({ table: { 'api repos/some-org/shared': fail(502, 'Bad Gateway') } })
    assert.equal(got.repoClass, 'personal-not-set-up')
    assert.equal(got.source, 'fallback')
  })

  test('the organization list holds lowercase, sorted remotes', () => {
    const files = new Map()
    const folders = {
      '/work/a': { remotes: { origin: 'https://github.com/Some-Org/Zeta.git' } },
      '/work/b': { remotes: { origin: 'https://github.com/some-org/alpha.git' } },
    }
    lookup({ folder: '/work/a', folders, table: orgRead('Some-Org/Zeta'), files })
    lookup({ folder: '/work/b', folders, table: orgRead('some-org/alpha'), files })
    assert.deepEqual(orgList(files), ['some-org/alpha', 'some-org/zeta'])
  })

  test('the memory matches the remote without regard to case', () => {
    const files = new Map([[ORG_FILE, JSON.stringify({ repos: ['some-org/shared'] })]])
    const folders = { '/work/shared': { remotes: { origin: 'https://github.com/SOME-ORG/Shared.git' } } }
    const { got } = lookup({ folder: '/work/shared', folders, files, table: { 'api repos/SOME-ORG/Shared': fail(404, 'Not Found') } })
    assert.equal(got.repoClass, 'organization')
  })

  test('another repo of a remembered organization, never seen, is not assumed to be organization', () => {
    const files = new Map()
    orgLookup({ table: orgRead('some-org/shared'), files })
    const folders = { '/work/other': { remotes: { origin: 'https://github.com/some-org/other.git' } } }
    const { got } = lookup({
      folder: '/work/other',
      folders,
      files,
      sessionId: 's2',
      table: { 'api repos/some-org/other': fail(502, 'Bad Gateway') },
    })
    assert.equal(got.repoClass, 'personal-not-set-up')
  })

  test('a later live user answer removes the organization entry', () => {
    const files = new Map([[ORG_FILE, JSON.stringify({ repos: ['octo/widget-api', 'some-org/shared'] })]])
    const { got } = lookup({ table: live, files })
    assert.equal(got.repoClass, 'personal-set-up')
    assert.deepEqual(orgList(files), ['some-org/shared'])
  })

  test('a live user answer for a repo not in the list leaves the file alone', () => {
    const files = new Map()
    lookup({ table: live, files })
    assert.equal(files.has(ORG_FILE), false)
  })

  test('a 404, 401, 5xx, bad JSON or thrown runner all take the offline path and leave the memory unchanged', () => {
    const answers = {
      'a 404': fail(404, 'Not Found'),
      'a 401': fail(401, 'Bad credentials'),
      'a 503': fail(503, 'Service Unavailable'),
      'an exit with no body': { code: 1, stdout: '', stderr: 'gh: connection refused' },
      'bad JSON': { code: 0, stdout: '<html>', stderr: '' },
      'a JSON null': { code: 0, stdout: 'null', stderr: '' },
      'a thrown runner': () => { throw new Error('could not run gh') },
    }
    for (const [label, answer] of Object.entries(answers)) {
      const memory = JSON.stringify({ repos: ['octo/widget-api'] })
      const files = new Map([[ORG_FILE, memory]])
      const { got, gh } = lookup({ table: offline(answer), files })
      assert.equal(got.repoClass, 'organization', label)
      assert.equal(got.source, 'remembered-owner', label)
      assert.equal(gh.calls.length, 1, label)
      assert.equal(files.get(ORG_FILE), memory, label)
    }
  })

  test('a corrupt organization file reads as empty', () => {
    for (const text of ['{not json', '[]', '{"repos": "octo/widget-api"}', 'null']) {
      const files = new Map([[ORG_FILE, text]])
      const { got } = lookup({ table: offline(fail(502, 'Bad Gateway')), files })
      assert.equal(got.repoClass, 'personal-not-set-up', text)
    }
  })

  test('an organization file that cannot be read reads as empty', () => {
    const { got } = lookup({ table: offline(fail(502, 'Bad Gateway')), readThrows: true })
    assert.equal(got.repoClass, 'personal-not-set-up')
  })

  test('a failing write of the organization list keeps the answer', () => {
    const { got } = orgLookup({ table: orgRead('some-org/shared'), failWrite: true })
    assert.equal(got.repoClass, 'organization')
  })

  test('an offline answer with no HEAD for the remote has a null default branch', () => {
    const folders = { [WORK]: { remotes: { origin: GH_URL } } }
    const { got } = lookup({ folders, table: offline(fail(502, 'Bad Gateway')) })
    assert.equal(got.defaultBranch, null)
  })
})

// ---------------------------------------------------------------------------
// defaultStateDir
// ---------------------------------------------------------------------------

describe('defaultStateDir', () => {
  test('uses XDG_STATE_HOME when it is set to an absolute path', () => {
    assert.equal(defaultStateDir({ env: { XDG_STATE_HOME: '/var/example/state' }, home: '/home/example' }), '/var/example/state/orchestrai')
  })

  test('falls back to the state folder under home', () => {
    assert.equal(defaultStateDir({ env: {}, home: '/home/example' }), '/home/example/.local/state/orchestrai')
  })

  test('ignores an empty or relative XDG_STATE_HOME', () => {
    for (const XDG_STATE_HOME of ['', 'state/here']) {
      assert.equal(defaultStateDir({ env: { XDG_STATE_HOME }, home: '/home/example' }), '/home/example/.local/state/orchestrai')
    }
  })
})
