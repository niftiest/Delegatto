import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { GithubRepo, GithubRepoOption, GithubStatus, PrepareRepoOutcome } from '../../shared/github-types'

export type { GithubRepo, GithubRepoOption, GithubStatus, PrepareRepoOutcome } from '../../shared/github-types'

/** GitHub support through the user's own `gh`: nothing here holds a token, and every
 *  command runs without a shell. Node-only, like the rest of src/main/engine. */

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/
const CLONE_TIMEOUT_MS = 10 * 60_000
const QUICK_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 60_000
const MAX_ERROR = 500

function isRepoName(name: string): boolean {
  return REPO_NAME.test(name) && !name.split('/')[1]!.endsWith('.') && !name.includes('..')
}

/** Output can echo a remote URL, and a remote URL can hold a token. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\/\/[^/\s@]+@/g, '//')
    .replace(/\bgh[opusr]_[A-Za-z0-9_]+/g, '[token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[token]')
    .trim()
    .slice(0, MAX_ERROR)
}

/** Windows installs can leave gh off the PATH an already-running app inherited. */
export function ghPath(): string {
  if (process.platform === 'win32') {
    const installed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')
    if (existsSync(installed)) return installed
  }
  return 'gh'
}

/** The real runner. Never prompts: a clone that needs input fails with a message instead of hanging. */
export const realRunner: Runner = (file, args, opts) => new Promise((done, fail) => {
  execFile(file === 'gh' ? ghPath() : file, args, {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? QUICK_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
  }, (err, stdout, stderr) => {
    if (err !== null && typeof err.code !== 'number') { fail(err); return }
    done({ code: err === null ? 0 : (err.code as number), stdout, stderr })
  })
})

/** `owner/name` for a remote on github.com itself, else null. Credentials in the URL are ignored. */
export function parseGithubRemote(url: string): string | null {
  const text = url.trim()
  const match = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:www\.|ssh\.)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text)
    ?? /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text)
  if (match === null) return null
  const name = `${match[1]}/${match[2]}`
  return REPO_NAME.test(name) ? name : null
}

function remotesIn(config: string): Map<string, string> {
  const remotes = new Map<string, string>()
  let current: string | null = null
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[\s*([^\]\s]+)(?:\s+"([^"]*)")?\s*\]/.exec(line)
    if (section !== null) {
      current = section[1]!.toLowerCase() === 'remote' ? (section[2] ?? null) : null
      continue
    }
    const url = /^url\s*=\s*(.+)$/i.exec(line)
    if (current !== null && url !== null && !remotes.has(current)) remotes.set(current, url[1]!.trim())
  }
  return remotes
}

/** The folder holding `config` for the repo `cwd` is in, or null. A worktree's `.git` is a file
 *  pointing at its own folder, whose `commondir` leads back to the main repo. */
function gitConfigDir(cwd: string): string | null {
  let current = resolve(cwd)
  for (;;) {
    const dotGit = join(current, '.git')
    try {
      if (statSync(dotGit).isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
      if (pointer === null) return null
      const gitdir = resolve(current, pointer[1]!.trim())
      try {
        return resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())
      } catch {
        return gitdir
      }
    } catch { /* nothing here: try the parent */ }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Which GitHub repo a folder belongs to, from its git config. No process, so the nav can ask for
 *  every project. Origin first, then any other remote on GitHub. */
export function readOriginRepo(cwd: string): string | null {
  try {
    const dir = gitConfigDir(cwd)
    if (dir === null) return null
    const remotes = remotesIn(readFileSync(join(dir, 'config'), 'utf8'))
    const origin = remotes.get('origin')
    if (origin !== undefined) {
      const repo = parseGithubRemote(origin)
      if (repo !== null) return repo
    }
    for (const url of remotes.values()) {
      const repo = parseGithubRemote(url)
      if (repo !== null) return repo
    }
    return null
  } catch {
    return null
  }
}

export async function githubStatus(run: Runner): Promise<GithubStatus> {
  try {
    const version = await run('gh', ['--version'])
    if (version.code !== 0) return { state: 'missing', account: null }
    const auth = await run('gh', ['auth', 'status'])
    if (auth.code !== 0) return { state: 'signed_out', account: null }
    const user = await run('gh', ['api', 'user', '--jq', '.login'])
    return { state: 'ready', account: user.code === 0 ? (user.stdout.trim() || null) : null }
  } catch {
    return { state: 'missing', account: null }
  }
}

/** Every repo the user can reach, including organizations, most recently pushed first. */
export async function listGithubRepos(run: Runner): Promise<GithubRepo[]> {
  const result = await run('gh', [
    'api', '--paginate',
    'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    '--jq', '.[] | {full_name, description, private, archived, pushed_at}'
  ], { timeoutMs: LIST_TIMEOUT_MS })
  if (result.code !== 0) throw new Error(cleanOutput(result.stderr) || 'gh could not list your repositories.')
  const repos: GithubRepo[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (typeof row.full_name !== 'string' || !isRepoName(row.full_name)) continue
    repos.push({
      fullName: row.full_name,
      description: typeof row.description === 'string' ? row.description : null,
      isPrivate: row.private === true,
      isArchived: row.archived === true,
      pushedAt: typeof row.pushed_at === 'string' ? row.pushed_at : null
    })
  }
  return repos
}

/** Where new clones go: wherever the user's linked projects mostly sit, so they land beside the rest. */
/** Each of the signed-in account's own private repos that has this file, with its text. One
 *  request covers 100 repos, so this stays quick however many there are. */
export async function privateReposWithFile(run: Runner, file: string): Promise<Array<{ repo: string; text: string }>> {
  const query = `query($after: String) { viewer { repositories(first: 100, after: $after, privacy: PRIVATE, ownerAffiliations: OWNER) {
    pageInfo { hasNextPage endCursor }
    nodes { nameWithOwner object(expression: "HEAD:${file}") { ... on Blob { text } } }
  } } }`
  const out: Array<{ repo: string; text: string }> = []
  let after: string | null = null
  for (let page = 0; page < 50; page++) {
    const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`, ...(after === null ? [] : ['-f', `after=${after}`])], { timeoutMs: LIST_TIMEOUT_MS })
    if (r.code !== 0) throw new Error(cleanOutput(r.stderr) || "Couldn't list your repositories.")
    const found = (JSON.parse(r.stdout) as { data: { viewer: { repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: Array<{ nameWithOwner: string; object: { text?: string | null } | null }>
    } } } }).data.viewer.repositories
    for (const n of found.nodes) if (typeof n.object?.text === 'string') out.push({ repo: n.nameWithOwner, text: n.object.text })
    if (!found.pageInfo.hasNextPage || found.pageInfo.endCursor === null) break
    after = found.pageInfo.endCursor
  }
  return out
}

/** Where new clones go: wherever the user's linked projects mostly sit, so they land beside the rest. */
export function defaultCloneRoot(linkedCwds: string[], home: string): string {
  const counts = new Map<string, number>()
  for (const cwd of linkedCwds) {
    const parent = dirname(cwd)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [parent, n] of counts) {
    if (best === null || n > counts.get(best)!) best = parent
  }
  return best ?? join(home, 'GitHub')
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The user's repos, each with its folder: the clone already on this PC if there is one, otherwise
 *  where a new clone would go. */
export function availableRepos(repos: GithubRepo[], projectCwds: string[], cloneRoot: string,
  originOf: (cwd: string) => string | null = readOriginRepo): GithubRepoOption[] {
  const here = new Map<string, string>()
  for (const cwd of projectCwds) {
    const repo = originOf(cwd)?.toLowerCase()
    if (repo !== undefined && !here.has(repo)) here.set(repo, cwd)
  }
  return repos.map(repo => {
    const local = here.get(repo.fullName.toLowerCase())
    return { ...repo, destination: local ?? join(cloneRoot, repo.fullName.split('/')[1]!), onThisPc: local !== undefined }
  })
}

function isEmptyOrMissing(path: string): boolean {
  try {
    return readdirSync(path).length === 0
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** Makes `cwd` a current checkout of `repo`: clones if there is nothing there, pulls if it is already
 *  that repo. Any other files are left alone and refused. A pull that cannot fast-forward only warns,
 *  because local work there should not stop a chat from starting. */
export async function prepareRepo(run: Runner, options: { repo: string; cwd: string }): Promise<PrepareRepoOutcome> {
  const { repo } = options
  const cwd = options.cwd.trim()
  if (!isRepoName(repo)) return { ok: false, error: `"${repo}" is not a GitHub repository name.` }
  if (!isAbsolute(cwd)) return { ok: false, error: 'Choose a full folder path for the repository.' }
  try {
    if (isEmptyOrMissing(cwd)) {
      const cloned = await run('gh', ['repo', 'clone', repo, cwd], { timeoutMs: CLONE_TIMEOUT_MS })
      if (cloned.code !== 0) return { ok: false, error: `Couldn't clone ${repo}: ${cleanOutput(cloned.stderr) || 'gh gave no reason.'}` }
      return { ok: true, action: 'cloned' }
    }
    const existing = gitConfigDir(cwd) !== null && existsSync(join(cwd, '.git')) ? readOriginRepo(cwd) : null
    if (existing === null) return { ok: false, error: `${cwd} already has files and isn't a clone of ${repo}. Choose another folder.` }
    if (existing.toLowerCase() !== repo.toLowerCase()) {
      return { ok: false, error: `${cwd} is already a clone of ${existing}, not ${repo}. Choose another folder.` }
    }
    const pulled = await run('git', ['pull', '--ff-only'], { cwd, timeoutMs: CLONE_TIMEOUT_MS })
    if (pulled.code !== 0) {
      return { ok: true, action: 'kept', warning: `Couldn't update it, so it stays as it is: ${cleanOutput(pulled.stderr) || 'git gave no reason.'}` }
    }
    return { ok: true, action: 'pulled' }
  } catch (err) {
    return { ok: false, error: `Couldn't run the GitHub tools: ${cleanOutput(err instanceof Error ? err.message : String(err))}` }
  }
}
