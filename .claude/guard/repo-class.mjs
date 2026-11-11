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
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { evaluate, gatherFacts, guarded, nodeLocal, parseError } from '../skills/tm-repo-guard/repo-guard.mjs'

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
// path is not exactly owner/repo, null for any other host or a local path.
// A query or fragment stays in the path, so it makes the path invalid.
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null
  const input = url.trim()
  let host
  let path
  const scheme = /^(?:https?|git|ssh):\/\/(.*)$/i.exec(input)
  if (scheme) {
    // The host part ends at the first / ? # or backslash, as a URL parser reads
    // it. Without this, "https://other.invalid#@github.com/o/r" looks like GitHub.
    const end = scheme[1].search(/[/?#\\]/)
    const authority = end === -1 ? scheme[1] : scheme[1].slice(0, end)
    path = end === -1 ? '' : scheme[1].slice(scheme[1][end] === '/' ? end + 1 : end)
    // The user and token part may hold a colon, so cut at the last @.
    const hostPort = /^([^:]+)(?::\d+)?$/.exec(authority.slice(authority.lastIndexOf('@') + 1))
    host = hostPort?.[1]
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(.*)$/.exec(input)
    host = scp?.[1]
    path = scp?.[2]
  }
  if (host === undefined || !GITHUB_HOSTS.has(host.toLowerCase())) return null

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
  if (typeof stateDir !== 'string' || stateDir === '') throw new TypeError('stateDir must be a path')

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

  let name
  if (names.includes('origin')) name = 'origin'
  else if (names.length === 1) name = names[0]
  else if (names.length === 0) return noGitHub()
  else {
    if (!names.some((n) => parseGitHubRemote(urlOf(n)) !== null)) return noGitHub()
    return result('personal-not-set-up', 'fallback', { detail: 'several remotes and none is named origin' })
  }

  const head = () => {
    const out = git(['symbolic-ref', '--short', `refs/remotes/${name}/HEAD`])
    const ref = out.code === 0 ? out.stdout.trim() : ''
    return ref.startsWith(`${name}/`) && ref.length > name.length + 1 ? ref.slice(name.length + 1) : null
  }

  const remote = parseGitHubRemote(urlOf(name))
  if (remote === null) return noGitHub(head())
  if (remote.invalid) {
    return result('personal-not-set-up', 'fallback', {
      defaultBranch: head(),
      detail: 'the github.com remote does not name one owner and one repo',
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

export function nodeRepoClassLocal() {
  const { read } = nodeLocal()
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
    read,
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
