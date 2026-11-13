/**
 * Repo class (issue #540, batch #538): which kind of folder is this?
 *
 * `lookupRepoClass` names a folder's class: `personal-set-up`,
 * `personal-not-set-up`, `organization` or `no-github-repo`. It reads the git
 * remote, asks GitHub with the same check `/tm-repo-guard` Check uses, and
 * remembers the answer for the session. It does not decide allow or deny and
 * is not wired to any hook.
 *
 * Every gh call goes through `guarded()` from the repo guard script, so
 * nothing here can write to GitHub. The two memory files live under
 * `stateDir`, outside every config dir and outside the repo.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { evaluate, gatherFacts, guarded, parseError } from '../skills/tm-repo-guard/repo-guard.mjs'

export const REPO_CLASSES = ['personal-set-up', 'personal-not-set-up', 'organization', 'no-github-repo']

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
// The same rule as validPart in the repo guard script.
const NAME_PART = /^[A-Za-z0-9_.-]+$/
const validPart = (p) => NAME_PART.test(p) && !p.startsWith('-') && !p.startsWith('.')
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const oneLine = (message) => String(message).replace(/\s+/g, ' ').trim().slice(0, 200)
const text = (v) => (typeof v === 'string' ? v : null)

// ---------------------------------------------------------------------------
// The remote
// ---------------------------------------------------------------------------

// These hosts, compared in lower case, are GitHub: the site, the same name with
// one trailing dot, and the ssh-over-443 host. Any other name is not, www and
// every other subdomain included.
const GITHUB_HOSTS = new Set(['github.com', 'github.com.', 'ssh.github.com'])

// { owner, repo } for a GitHub remote, { invalid: true } for a GitHub URL whose
// path is not exactly owner/repo, or whose host or user part git would read
// differently (see below), null for any other host or a local path. A query or
// fragment stays in the path, so it makes the path invalid.
//
// Two readers disagree about where the host is, and the parser follows the one
// that connects. For http and https the host ends at the first / ? # or
// backslash, as a URL parser reads it, so "https://other.invalid#@github.com/o/r"
// goes to other.invalid. For ssh, git and the scp-like form, git ends the host
// only at the first slash and ssh splits user and host at the last @, so
// "ssh://other.invalid#@github.com/o/r" does go to github.com. Before it finds
// the host git also decodes %XX and strips [...]: "ssh://other.invalid%2F@github.com/o/r"
// goes to other.invalid. A % or bracket in the user or host part is not
// reproduced here, so such a remote is invalid, never GitHub.
// `git fetch-pack --diag-url <url>` shows the host git takes; the local test
// compares the parser with it.
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null
  const input = url.trim()
  let user
  let hostText
  let path
  let isScheme = false
  const scheme = /^(https?|git|ssh|git\+ssh|ssh\+git):\/\/(.*)$/i.exec(input)
  if (scheme) {
    isScheme = true
    const web = /^https?$/i.test(scheme[1])
    const rest = scheme[2]
    const end = rest.search(web ? /[/?#\\]/ : /\//)
    const authority = end === -1 ? rest : rest.slice(0, end)
    path = end === -1 ? '' : rest.slice(rest[end] === '/' ? end + 1 : end)
    // The user and token part may hold a colon, so cut at the last @.
    const at = authority.lastIndexOf('@')
    user = authority.slice(0, Math.max(at, 0))
    hostText = authority.slice(at + 1)
  } else {
    const scp = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(.*)$/.exec(input)
    if (!scp) return null
    user = scp[1] ?? ''
    hostText = scp[2]
    path = scp[3]
  }
  if (/[%[\]]/.test(hostText)) return { invalid: true }
  const hostPort = isScheme ? /^([^:]+)(?::(\d*))?$/.exec(hostText) : [hostText, hostText]
  const host = hostPort?.[1]
  if (host === undefined || !GITHUB_HOSTS.has(host.toLowerCase())) return null
  if (/[%[\]]/.test(user)) return { invalid: true }
  // git and ssh cannot use a port above 65535. An empty port is dropped by git,
  // but after a colon in the user part ssh sees "github.com:" as the host.
  const port = isScheme ? hostPort[2] : undefined
  if (port !== undefined && (port === '' ? user.includes(':') : Number(port) > 65535)) return { invalid: true }

  let name = path.replace(/\/+$/, '')
  if (name.endsWith('.git')) name = name.slice(0, -4)
  const parts = name.split('/')
  if (parts.length !== 2 || !parts.every(validPart)) return { invalid: true }
  return { owner: parts[0], repo: parts[1] }
}

const result = (repoClass, source, f = {}) => ({
  repoClass,
  owner: f.owner ?? null,
  repo: f.repo ?? null,
  defaultBranch: f.defaultBranch ?? null,
  source,
  ...(f.detail ? { detail: f.detail } : {}),
})

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function sessionMemory(local, stateDir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { get: () => null, set: () => {} }
  const path = join(stateDir, 'sessions', `${sessionId}.json`)
  // Anything unreadable or malformed is a miss and gets overwritten.
  const load = () => {
    try {
      const raw = local.read(path)
      const data = raw === null ? null : JSON.parse(raw)
      return isObject(data) ? data : {}
    } catch {
      return {}
    }
  }
  return {
    get(key) {
      const entry = load()[key]
      if (!isObject(entry) || !REPO_CLASSES.includes(entry.repoClass)) return null
      return result(entry.repoClass, 'session', {
        owner: text(entry.owner),
        repo: text(entry.repo),
        defaultBranch: text(entry.defaultBranch),
        detail: text(entry.detail),
      })
    },
    set(key, answer) {
      const data = load()
      data[key] = answer
      try {
        local.write(path, JSON.stringify(data, null, 2) + '\n')
      } catch {
        // The answer does not depend on the write.
      }
    },
  }
}

// Remotes that GitHub said an organization owns. Read only when GitHub gives no
// answer, because offline a personal repo and an organization repo look alike.
const orgPath = (stateDir) => join(stateDir, 'organization-repos.json')

function readOrgRepos(local, stateDir) {
  try {
    const raw = local.read(orgPath(stateDir))
    const repos = raw === null ? null : JSON.parse(raw)?.repos
    return new Set(Array.isArray(repos) ? repos.filter((r) => typeof r === 'string').map((r) => r.toLowerCase()) : [])
  } catch {
    return new Set()
  }
}

function updateOrgRepos(local, stateDir, key, isOrg) {
  const repos = readOrgRepos(local, stateDir)
  if (repos.has(key) === isOrg) return
  if (isOrg) repos.add(key)
  else repos.delete(key)
  try {
    local.write(orgPath(stateDir), JSON.stringify({ repos: [...repos].sort() }, null, 2) + '\n')
  } catch {
    // Not remembered, so a later offline lookup is stricter, never looser.
  }
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

function fullNameOf(value) {
  const parts = typeof value === 'string' ? value.split('/') : []
  return parts.length === 2 && parts.every(validPart) ? { owner: parts[0], repo: parts[1] } : null
}

function askGitHub({ call, local, stateDir, key, remote, head }) {
  const asked = `${remote.owner}/${remote.repo}`

  let info
  try {
    const res = call(['api', `repos/${asked}`])
    if (res.code !== 0) throw new Error(parseError(res).message)
    info = JSON.parse(res.stdout)
    if (!isObject(info)) throw new Error('the repo answer is not an object')
    // gh asks its default host, which GH_HOST can move. An answer from another
    // host says nothing about the github.com repo, so it is no answer.
    if (typeof info.html_url !== 'string' || !info.html_url.toLowerCase().startsWith('https://github.com/')) {
      throw new Error('the repo answer did not come from github.com')
    }
  } catch (err) {
    // A 404 is handled like any other failure: the two cannot be told apart.
    const detail = `could not read the repo from GitHub: ${oneLine(err.message)}`
    const where = { ...remote, defaultBranch: head() }
    if (readOrgRepos(local, stateDir).has(key)) {
      return result('organization', 'remembered-owner', { ...where, detail: `${detail}; it was an organization repo when last seen` })
    }
    return result('personal-not-set-up', 'fallback', { ...where, detail })
  }

  const type = info.owner?.type
  updateOrgRepos(local, stateDir, key, type === 'Organization')

  const named = fullNameOf(info.full_name) ?? remote
  const where = { ...named, defaultBranch: text(info.default_branch) }
  if (type === 'Organization') return result('organization', 'github', where)

  let login
  try {
    const res = call(['api', 'user'])
    if (res.code !== 0) throw new Error(parseError(res).message)
    login = JSON.parse(res.stdout)?.login
    if (typeof login !== 'string' || login === '') throw new Error('no login in the answer')
  } catch (err) {
    return result('personal-not-set-up', 'fallback', {
      ...where,
      detail: `could not read the logged-in account: ${oneLine(err.message)}`,
    })
  }
  const own = type === 'User' && String(info.owner?.login).toLowerCase() === login.toLowerCase()
  if (!own || info.archived === true) return result('personal-not-set-up', 'github', where)

  try {
    const state = evaluate(gatherFacts(call, info, asked)).state
    return result(state === 'set up' ? 'personal-set-up' : 'personal-not-set-up', 'github', where)
  } catch (err) {
    return result('personal-not-set-up', 'fallback', {
      ...where,
      detail: `could not read the repo's settings: ${oneLine(err.message)}`,
    })
  }
}

// `local.git` returns { code, stdout, stderr } and throws when git cannot run.
// A failure other than "not a git repository" throws, so a hook can block.
export function lookupRepoClass({ folder, sessionId, run, local, stateDir }) {
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw new TypeError('folder must be an absolute path')
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path')

  const git = (args) => local.git(['-C', folder, ...args])
  const gitOut = (args) => {
    const res = git(args)
    if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${oneLine(res.stderr)}`)
    return res.stdout.trim()
  }
  const noGitHub = (defaultBranch = null) => result('no-github-repo', 'local', { defaultBranch })

  const list = git(['remote'])
  if (list.code !== 0) {
    if (/not a git repository/i.test(list.stderr)) return noGitHub()
    throw new Error(`git remote failed: ${oneLine(list.stderr)}`)
  }
  const names = list.stdout.split('\n').map((n) => n.trim()).filter(Boolean)
  const urlOf = (name) => gitOut(['remote', 'get-url', '--', name])
  // Pushes go to the push URLs, which pushurl and pushInsteadOf can change, so
  // the fetch URL alone does not say where a push lands.
  const pushUrlsOf = (name) =>
    gitOut(['remote', 'get-url', '--push', '--all', '--', name]).split('\n').map((u) => u.trim()).filter(Boolean)
  const anyGitHub = (urls) => urls.some((u) => parseGitHubRemote(u) !== null)

  let name
  if (names.includes('origin')) name = 'origin'
  else if (names.length === 1) name = names[0]
  else if (names.length === 0) return noGitHub()
  else {
    if (!names.some((n) => anyGitHub([urlOf(n), ...pushUrlsOf(n)]))) return noGitHub()
    return result('personal-not-set-up', 'fallback', { detail: 'several remotes and none is named origin' })
  }

  const head = () => {
    const out = git(['symbolic-ref', '--short', `refs/remotes/${name}/HEAD`])
    const ref = out.code === 0 ? out.stdout.trim() : ''
    return ref.startsWith(`${name}/`) && ref.length > name.length + 1 ? ref.slice(name.length + 1) : null
  }

  const remote = parseGitHubRemote(urlOf(name))
  if (remote === null) {
    // Fetched from another host. A push URL on GitHub, valid or not, still puts
    // pushes on GitHub, so only the deny list would apply to a guarded repo.
    if (!anyGitHub(pushUrlsOf(name))) return noGitHub(head())
    return result('personal-not-set-up', 'fallback', {
      defaultBranch: head(),
      detail: 'the remote is fetched from another host but a push URL is on GitHub',
    })
  }
  if (remote.invalid) {
    return result('personal-not-set-up', 'fallback', {
      defaultBranch: head(),
      detail: 'the GitHub remote does not name one owner and one repo, or its host cannot be read the way git reads it',
    })
  }

  // Every push URL must be the repo that was fetched. Not covered:
  // remote.pushDefault and branch.<name>.pushRemote, which pick another remote.
  const same = (url) => {
    const other = parseGitHubRemote(url)
    return other !== null && !other.invalid && `${other.owner}/${other.repo}`.toLowerCase() === `${remote.owner}/${remote.repo}`.toLowerCase()
  }
  const pushUrls = pushUrlsOf(name)
  if (pushUrls.length === 0 || !pushUrls.every(same)) {
    return result('personal-not-set-up', 'fallback', {
      ...remote,
      defaultBranch: head(),
      detail: 'a push URL of the remote is not the repo that is fetched',
    })
  }

  const key = `${remote.owner}/${remote.repo}`.toLowerCase()
  const memory = sessionMemory(local, stateDir, sessionId)
  const hit = memory.get(key)
  if (hit) return hit

  const answer = askGitHub({ call: guarded(run), local, stateDir, key, remote, head })
  memory.set(key, answer)
  return answer
}

// ---------------------------------------------------------------------------
// Real adapters
// ---------------------------------------------------------------------------

export function defaultStateDir({ env = process.env, home = homedir() } = {}) {
  const xdg = env.XDG_STATE_HOME
  const root = typeof xdg === 'string' && isAbsolute(xdg) ? xdg : join(home, '.local', 'state')
  return join(root, 'orchestrai')
}

// A missing file is null. Any other failure throws, and the memory treats it as a miss.
function readFileOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function nodeRepoClassLocal() {
  return {
    git: (args) => {
      const res = spawnSync('git', args, {
        encoding: 'utf8',
        // English messages, because the "not a git repository" test reads stderr.
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        // Stdin is closed so git cannot stall waiting on it.
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      })
      if (res.error) throw new Error(`could not run git: ${res.error.message}`)
      return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
    },
    read: readFileOrNull,
    // The folder is private to the owner. A temp file and a rename keep a
    // reader from ever seeing half a file.
    write: (path, content) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const temp = `${path}.${process.pid}.tmp`
      try {
        writeFileSync(temp, content, { mode: 0o600 })
        renameSync(temp, path)
      } catch (err) {
        rmSync(temp, { force: true })
        throw err
      }
    },
  }
}
