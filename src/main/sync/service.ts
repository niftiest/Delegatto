import { randomUUID, createHash } from 'node:crypto'
import { existsSync, promises as fsp, readFileSync, readdirSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ClaudePaths } from '../manage/paths'
import { encodePath, isFullyQualified, isSameOrUnder, isSamePath, normalizePath } from '../manage/paths'
import { PathRewriter } from '../manage/path-rewriter'
import { atomicWriteBytes, atomicWriteText } from '../manage/safe-file'
import { scanProject as scanOneProject, scanProjects } from '../manage/scanner'
import { dirSize } from '../manage/fs-util'
import type { ProjectInfo } from '../manage/types'
import { defaultCloneRoot, prepareRepo, readOriginRepo, type Runner } from '../engine/github'
import {
  deriveKey, formatRecoveryKey, keyCheck, newKdf, newRecoveryKey, SyncCodec, verifyKeyCheck, type KdfHeader
} from './crypto'
import { codeState, SyncGit } from './git'
import { countImages, mergeFinding, redactSecrets, scanText } from './secret-scan'
import { isSessionId, isTextFile, keyEndingAt, locateRow, readRows, rowKey } from './transcript'
import type {
  EnableProgress, SyncIncoming, FindingDecisions, GithubState, LinkOutcome, ProjectScan, RemoteProject, RepoSearch, ResolveOutcome, ScanProgress,
  SecretFinding, SetupOutcome, TurnOnOutcome, SyncChatInfo, SyncConflict, SyncDevice, SyncProjectRow, SyncResult, SyncStatus
} from '../../shared/sync-types'

/** Keeps chosen projects' chats the same across PCs through a private GitHub repo.
 *
 *  Repo layout. Rows and blobs are only ever added, so a sync uploads just what's new:
 *    delegatto-sync.json                     format, encryption header
 *    catalog/<project>.bin                    what the project is
 *    data/<project>/files.bin, pf-<hash>.bin  project memory
 *    data/<project>/chats/<chat>/index.bin    the chat's order of rows, and its other files
 *    data/<project>/chats/<chat>/r<n>-<hash>.bin   new rows, up to CHUNK_BYTES of them
 *    data/<project>/chats/<chat>/f-<hash>.bin      subagent logs, tool results, todos
 *
 *  What's stored keeps the paths of the PC that wrote it, along with that PC's folder.
 *  Each PC translates to its own folder as it reads, and never uploads a translation. */

const FORMAT = 'delegatto-sync'
const FORMAT_VERSION = 1
const HEADER_FILE = 'delegatto-sync.json'
/** What the sync repo is called on the user's account, unless that name is taken. */
const DEFAULT_REPO = 'delegatto-sync'
const CHUNK_BYTES = 32 * 1024 * 1024
/** GitHub refuses files over 100 MB. */
const MAX_REPO_FILE = 95 * 1024 * 1024
const MAX_SIDE_FILE = 256 * 1024 * 1024
const PUSH_ATTEMPTS = 4
const STALE_CHECK_MS = 3 * 60_000
const PRESENCE_EVERY_MS = 3 * 60_000
/** With a heartbeat every 3 minutes, past this a PC has probably gone away. */
const ACTIVE_WITHIN_MS = 7 * 60_000
const CLOSE_WAIT_MS = 8_000
const SCAN_CACHE_MS = 60_000

export type SyncHub = {
  status(): Promise<GithubState>
  view(repo: string): Promise<{ exists: boolean; isPrivate: boolean | null }>
  create(repo: string): Promise<void>
  sizeBytes(repo: string): Promise<number | null>
  header(repo: string): Promise<string | null>
  /** The account's own private repos holding this file, with its text. */
  privateReposWithFile(file: string): Promise<Array<{ repo: string; text: string }>>
}

/** The repo key, and the recovery key it came from when this PC was given or made one. */
export type KeyStore = {
  load(): Buffer | null
  loadRecovery(): string | null
  canSave(): boolean
  save(key: Buffer, recoveryKey: string | null): void
  clear(): void
}

export type SyncDeps = {
  paths: ClaudePaths
  run: Runner
  hub: SyncHub
  keys: KeyStore
  /** Delegatto's own settings and sync files live here. */
  dataDir: string
  hostname: string
  remoteUrl(repo: string): string
  credentialArgs: string[]
  isChatBusy(sessionId: string): boolean
  isChatOpen(sessionId: string): boolean
  isExternallyLive(sessionId: string): boolean
  stopChat(sessionId: string): void
  afterLocalChange(): Promise<void>
  sessionPkOf(filePath: string): number | null
  /** Delegatto lists a chat under its first message, so a chat renamed by a row needs telling. */
  setChatTitle(filePath: string, title: string): void
  trustFolder(path: string): void
  onChange(): void
  /** Which chats are getting messages from another PC, each time that changes. */
  onIncoming?(list: SyncIncoming[]): void
  now?(): number
  sleep?(ms: number): Promise<void>
}

type FileEntry = { blob: string; size: number; mtimeMs: number }

type ChatState = {
  projectId: string
  /** How many rows both sides agree on. */
  baseRows: number
  baseKey: string | null
  /** Where those rows end in the local file. */
  offset: number
  size: number
  mtimeMs: number
  files: Record<string, FileEntry>
  localDeleted?: boolean
}

type ProjectState = {
  projectId: string
  root: string
  excludedChats: string[]
  redact: string[]
  allow: string[]
  pendingFindings: SecretFinding[]
  lastSyncAt: number | null
  warnings: string[]
  files: Record<string, FileEntry>
}

type SavedState = {
  version: 1
  deviceId: string
  deviceName: string | null
  repo: string | null
  encrypted: boolean
  auto: boolean
  remoteSha: string | null
  lastSyncAt: number | null
  projects: Record<string, ProjectState>
  chats: Record<string, ChatState>
  conflicts: Record<string, SyncConflict>
  /** This PC chose to disconnect, so it isn't offered the repo again unprompted. */
  leftSync?: boolean
}

type Origin = { root: string; claudeDir: string; siblings: string[] }

type ChunkEntry = { name: string; rows: number; lastKey: string } & Origin & { device: string; at: number }

type RemoteFile = { blob: string; size: number; device: string; at: number } & Origin

type ChatIndex = {
  sessionId: string
  rows: number
  chunks: ChunkEntry[]
  files: Record<string, RemoteFile>
  device: { id: string; name: string }
  at: number
  code: { branch: string | null; head: string | null }
  title: string | null
}

type ProjectMeta = {
  projectId: string
  name: string
  github: string | null
  branch: string | null
  head: string | null
  unpushed: number
  uncommitted: number
  chats: number
  updatedBy: string
  updatedById?: string
  updatedAt: number
}

/** `repos` lists the GitHub repos of synced projects, readable without the key, so a PC that
 *  isn't linked yet can tell which of its repos have chats waiting. Nothing else is. */
type Header = { format: string; version: number; encrypted: boolean; kdf: KdfHeader | null; check: string | null; repos?: string[] }

type PresenceBody = { name: string; hostname: string; at: number; openChats: string[] }

type LocalFile = { path: string; size: number; mtimeMs: number }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 40)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A relative path that can't climb out of where it's put. */
function isSafeRelative(rel: string): boolean {
  if (rel.length === 0 || isAbsolute(rel) || rel.includes(':') || rel.includes('\0') || rel.includes('\\')) return false
  return rel.split('/').every(s => s.length > 0 && s !== '.' && s !== '..' && !s.endsWith('.') && !s.endsWith(' '))
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    const st = await fsp.stat(path)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

async function walkFiles(dir: string, rel: string, out: Map<string, LocalFile>): Promise<void> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const path = join(dir, e.name)
    const childRel = `${rel}/${e.name}`
    if (e.isDirectory()) await walkFiles(path, childRel, out)
    else if (e.isFile()) {
      const st = await statOrNull(path)
      if (st !== null) out.set(childRel, { path, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
}

/** Sorted, each repo once whatever its case, keeping the first spelling seen. */
function uniqueRepos(repos: string[]): string[] {
  const seen = new Map<string, string>()
  for (const r of repos) if (typeof r === 'string' && r.length > 0 && !seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r)
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/** Every file in the sync repo's checkout, by its path in the repo. */
async function repoFiles(repoDir: string): Promise<string[]> {
  const out = new Map<string, LocalFile>()
  for (const e of await fsp.readdir(repoDir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    if (e.isDirectory()) await walkFiles(join(repoDir, e.name), e.name, out)
    else if (e.isFile()) out.set(e.name, { path: join(repoDir, e.name), size: 0, mtimeMs: 0 })
  }
  return [...out.keys()].sort()
}

function replaceSessionId(line: string, from: string, to: string): string {
  return line.split(`"sessionId":"${from}"`).join(`"sessionId":"${to}"`).split(`"session_id":"${from}"`).join(`"session_id":"${to}"`)
}

function textOfUserRow(row: Record<string, unknown>): string | null {
  const content = (row.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.filter(c => isObject(c) && c.type === 'text' && typeof c.text === 'string').map(c => (c as { text: string }).text)
    return parts.length > 0 ? parts.join('\n') : null
  }
  return null
}

const isRealPrompt = (text: string): boolean => text.trim().length > 0 && !/^(?:<(?:command|local-command|system-reminder|task-notification|bash-)|\[Request interrupted|Caveat:)/.test(text.trimStart())

export class SyncService {
  private state: SavedState
  private codec: SyncCodec | null = null
  private git: SyncGit | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private busyCount = 0
  private activity: string | null = null
  private lastError: string | null = null
  private lastCheckAt: number | null = null
  private repoSize: number | null = null
  /** Chats getting messages from another PC in this pass, by session id. */
  private incoming = new Map<string, SyncIncoming>()
  private incomingSentAt = 0

  /** Set while a project's first sync runs, so its dialog can show how far along it is. */
  private enableProgress: { root: string; report: (p: EnableProgress) => void } | null = null
  private catalog = new Map<string, ProjectMeta>()
  private chatMeta = new Map<string, { device: string; deviceId: string; at: number; head: string | null; title: string | null }>()
  private devices: SyncDevice[] = []
  private presenceShas = new Map<string, string>()
  private presenceSentAt = 0
  private presenceSent = ''
  private openChat: string | null = null
  private github: GithubState = { state: 'missing', account: null }
  private discovered: string[] = []
  /** GitHub repos with synced chats, from the headers of the sync repos found above. */
  private discoveredSynced: string[] = []
  private discoveredAt: number | null = null
  private githubAt = 0
  private scanCache: { at: number; projects: ProjectInfo[] } | null = null
  private titlesToApply = new Map<string, string>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly stateFile: string
  private readonly repoDir: string

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.stateFile = join(deps.dataDir, 'sync-state.json')
    this.repoDir = join(deps.dataDir, 'sync-repo')
    this.state = this.loadState()
    this.openRepo()
  }

  // ---------------------------------------------------------------- state

  private loadState(): SavedState {
    const fresh: SavedState = {
      version: 1, deviceId: randomUUID().slice(0, 12), deviceName: null, repo: null, encrypted: true, auto: true,
      remoteSha: null, lastSyncAt: null, projects: {}, chats: {}, conflicts: {}
    }
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<SavedState>
      return { ...fresh, ...saved }
    } catch {
      return fresh
    }
  }

  private save(): void {
    atomicWriteText(this.stateFile, JSON.stringify(this.state))
  }

  private openRepo(): void {
    if (this.state.repo === null) return
    const key = this.deps.keys.load()
    if (this.state.encrypted && key === null) return
    this.codec = new SyncCodec(this.state.encrypted ? key : null)
    this.git = new SyncGit(this.deps.run, this.repoDir, this.deps.remoteUrl(this.state.repo), this.deps.credentialArgs)
    this.readCatalog()
  }

  get deviceName(): string {
    return this.state.deviceName ?? this.deps.hostname
  }

  // ---------------------------------------------------------------- queue

  /** One sync job at a time: they share one local copy of the repo. */
  private enqueue<T>(label: string, job: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.busyCount++
      this.activity = label
      this.deps.onChange()
      try {
        return await job()
      } finally {
        this.busyCount--
        if (this.busyCount === 0) this.activity = null
        this.deps.onChange()
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private guarded(label: string, job: () => Promise<void>): Promise<SyncResult> {
    return this.enqueue(label, async () => {
      try {
        await job()
        this.lastError = null
        return { ok: true as const }
      } catch (e) {
        this.lastError = errorText(e)
        return { ok: false as const, error: this.lastError }
      }
    })
  }

  // ---------------------------------------------------------------- setup

  private repoName(name: string, account: string | null): string | null {
    const text = name.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '')
    if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(text)) return text
    if (/^[A-Za-z0-9._-]+$/.test(text) && account !== null) return `${account}/${text}`
    return null
  }

  async findRepo(name: string): Promise<RepoSearch> {
    const github = await this.deps.hub.status()
    const repo = this.repoName(name, github.account)
    if (repo === null) return { repo: name, exists: false, isPrivate: null, encrypted: null, isSyncRepo: false, error: 'Enter a repository name.' }
    try {
      const view = await this.deps.hub.view(repo)
      if (!view.exists) return { repo, exists: false, isPrivate: null, encrypted: null, isSyncRepo: false, error: null }
      const text = await this.deps.hub.header(repo)
      const header = text === null ? null : this.parseHeader(text)
      return { repo, exists: true, isPrivate: view.isPrivate, encrypted: header?.encrypted ?? null, isSyncRepo: header !== null, error: null }
    } catch (e) {
      return { repo, exists: false, isPrivate: null, encrypted: null, isSyncRepo: false, error: errorText(e) }
    }
  }

  /** Looks for sync repos on the account, for a PC that isn't linked to one. Runs behind the
   *  status it's called from, and reports again if it found anything different. */
  private discoverRepos(): void {
    if (this.discoveredAt !== null && this.now() - this.discoveredAt < STALE_CHECK_MS) return
    this.discoveredAt = this.now()
    void this.deps.hub.privateReposWithFile(HEADER_FILE).then(found => {
      const headers = found.flatMap(f => { const h = this.parseHeader(f.text); return h === null ? [] : [{ repo: f.repo, header: h }] })
      const repos = headers.map(h => h.repo).sort()
      const synced = uniqueRepos(headers.flatMap(h => h.header.repos ?? []))
      if (repos.join() === this.discovered.join() && synced.join() === this.discoveredSynced.join()) return
      this.discovered = repos
      this.discoveredSynced = synced
      this.deps.onChange()
    }).catch(err => console.warn('[sync] could not look for a sync repo', err))
  }

  private parseHeader(text: string): Header | null {
    try {
      const h = JSON.parse(text) as Header
      return h.format === FORMAT && typeof h.version === 'number' ? h : null
    } catch {
      return null
    }
  }

  setupNew(options: { name: string; encrypted: boolean }): Promise<SetupOutcome> {
    return this.enqueue('Setting up sync', async () => {
      try {
        const github = await this.deps.hub.status()
        if (github.state !== 'ready') return { ok: false, error: 'Sign in to GitHub first.' }
        const repo = this.repoName(options.name, github.account)
        if (repo === null) return { ok: false, error: 'Enter a repository name.' }
        const view = await this.deps.hub.view(repo)
        if (view.exists) {
          if (view.isPrivate !== true) return { ok: false, error: `${repo} is public. Sync only uses private repositories.` }
          if (await this.deps.hub.header(repo) !== null) return { ok: false, error: `${repo} is already a sync repo. Link to it instead.` }
          return { ok: false, error: `${repo} already exists and isn't a sync repo. Choose another name.` }
        }
        await this.deps.hub.create(repo)
        const check = await this.deps.hub.view(repo)
        if (check.isPrivate !== true) return { ok: false, error: `${repo} didn't come out private, so nothing was uploaded.` }

        let recoveryKey: string | null = null
        let key: Buffer | null = null
        let header: Header = { format: FORMAT, version: FORMAT_VERSION, encrypted: false, kdf: null, check: null }
        if (options.encrypted) {
          recoveryKey = newRecoveryKey()
          const kdf = newKdf()
          key = await deriveKey(recoveryKey, kdf)
          header = { format: FORMAT, version: FORMAT_VERSION, encrypted: true, kdf, check: keyCheck(key) }
        }
        await this.freshClone(repo)
        atomicWriteText(join(this.repoDir, HEADER_FILE), JSON.stringify(header, null, 2))
        await this.git!.commitAndPush('Set up Delegatto sync')
        this.activate(repo, options.encrypted, key, recoveryKey)
        return { ok: true, repo, recoveryKey, encrypted: options.encrypted }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    })
  }

  setupExisting(options: { name: string; recoveryKey: string }): Promise<SetupOutcome> {
    return this.enqueue('Linking to the sync repo', async () => {
      try {
        const github = await this.deps.hub.status()
        if (github.state !== 'ready') return { ok: false, error: 'Sign in to GitHub first.' }
        const repo = this.repoName(options.name, github.account)
        if (repo === null) return { ok: false, error: 'Enter a repository name.' }
        const view = await this.deps.hub.view(repo)
        if (!view.exists) return { ok: false, error: `Couldn't find ${repo}. Check this GitHub account can reach it.` }
        if (view.isPrivate !== true) return { ok: false, error: `${repo} is public. Sync only uses private repositories.` }
        const text = await this.deps.hub.header(repo)
        const header = text === null ? null : this.parseHeader(text)
        if (header === null) return { ok: false, error: `${repo} isn't a Delegatto sync repo.` }
        if (header.version > FORMAT_VERSION) return { ok: false, error: 'This sync repo was made by a newer Delegatto. Update this PC first.' }
        let key: Buffer | null = null
        if (header.encrypted) {
          if (header.kdf === null || header.check === null) return { ok: false, error: "This sync repo's encryption details are missing." }
          key = await deriveKey(options.recoveryKey, header.kdf)
          if (!verifyKeyCheck(key, header.check)) return { ok: false, error: "That recovery key doesn't match this sync repo." }
        }
        await this.freshClone(repo)
        this.activate(repo, header.encrypted, key, header.encrypted ? formatRecoveryKey(options.recoveryKey) : null)
        this.readCatalog()
        await this.refreshPresence(true)
        return { ok: true, repo, recoveryKey: null, encrypted: header.encrypted }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    })
  }

  /** Turns on project sync with no choices to make: links to the account's sync repo when it
   *  has one (which needs the recovery key), or makes a private one with a new key. */
  async turnOn(recoveryKey: string | null): Promise<TurnOnOutcome> {
    const github = await this.deps.hub.status()
    if (github.state !== 'ready' || github.account === null) return { ok: false, error: 'Sign in to GitHub first.' }
    let found: Array<{ repo: string; text: string }>
    try {
      found = (await this.deps.hub.privateReposWithFile(HEADER_FILE)).filter(f => this.parseHeader(f.text) !== null)
    } catch (e) {
      return { ok: false, error: `Couldn't check GitHub for an existing sync repo: ${errorText(e)}` }
    }
    const preferred = `${github.account}/${DEFAULT_REPO}`.toLowerCase()
    const existing = found.find(f => f.repo.toLowerCase() === preferred) ?? found.sort((a, b) => a.repo.localeCompare(b.repo))[0]
    if (existing !== undefined) {
      const header = this.parseHeader(existing.text)!
      if (header.encrypted && (recoveryKey === null || recoveryKey.trim().length === 0)) return { ok: false, needsKey: true, repo: existing.repo }
      return this.setupExisting({ name: existing.repo, recoveryKey: recoveryKey ?? '' })
    }
    for (let n = 1; n <= 5; n++) {
      const name = n === 1 ? DEFAULT_REPO : `${DEFAULT_REPO}-${n}`
      const view = await this.deps.hub.view(`${github.account}/${name}`).catch(() => ({ exists: true, isPrivate: null }))
      if (!view.exists) return this.setupNew({ name, encrypted: true })
    }
    return { ok: false, error: `Couldn't find a free name for the sync repo. Rename or delete your ${DEFAULT_REPO} repos and try again.` }
  }

  private async freshClone(repo: string): Promise<void> {
    await this.removeRepoDir()
    this.git = new SyncGit(this.deps.run, this.repoDir, this.deps.remoteUrl(repo), this.deps.credentialArgs)
    await this.git.clone(this.deps.dataDir)
  }

  private async removeRepoDir(): Promise<void> {
    // Inside our own data folder, under a fixed name, so this can't reach anything else.
    if (!isSameOrUnder(this.repoDir, this.deps.dataDir)) throw new Error('The sync folder is in an unexpected place.')
    await fsp.rm(this.repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  private activate(repo: string, encrypted: boolean, key: Buffer | null, recoveryKey: string | null): void {
    if (key !== null) this.deps.keys.save(key, recoveryKey)
    this.state.repo = repo
    this.state.leftSync = false
    this.state.encrypted = encrypted
    this.state.remoteSha = null
    this.state.projects = {}
    this.state.chats = {}
    this.state.conflicts = {}
    this.codec = new SyncCodec(key)
    this.save()
  }

  disconnect(): Promise<SyncResult> {
    return this.guarded('Disconnecting', async () => {
      await this.removeRepoDir()
      this.deps.keys.clear()
      this.state.repo = null
      this.state.leftSync = true
      this.state.remoteSha = null
      this.state.projects = {}
      this.state.chats = {}
      this.state.conflicts = {}
      this.state.lastSyncAt = null
      this.codec = null
      this.git = null
      this.catalog.clear()
      this.chatMeta.clear()
      this.devices = []
      this.save()
    })
  }

  setDeviceName(name: string): void {
    const clean = name.trim().slice(0, 60)
    this.state.deviceName = clean.length === 0 ? null : clean
    this.save()
    this.deps.onChange()
    if (this.state.repo !== null) void this.enqueue('Updating this PC’s name', () => this.publishPresence(true)).catch(() => {})
  }

  setAuto(on: boolean): void {
    this.state.auto = on
    this.save()
    this.deps.onChange()
  }

  // ---------------------------------------------------------------- local layout

  private projectDir(root: string): string {
    return join(this.deps.paths.projectsDir, encodePath(normalizePath(root)))
  }

  private transcriptPath(root: string, sessionId: string): string {
    return join(this.projectDir(root), `${sessionId}.jsonl`)
  }

  private chatFolder(projectId: string, sessionId: string): string {
    return `data/${projectId}/chats/${sessionId}`
  }

  /** Everything a chat has besides its transcript. Environment files, background jobs,
   *  rewind backups and prompt history stay on each PC: they can hold secrets or only
   *  mean something on the PC that made them. */
  private async chatFiles(root: string, sessionId: string): Promise<Map<string, LocalFile>> {
    const out = new Map<string, LocalFile>()
    await walkFiles(join(this.projectDir(root), sessionId), 'session', out)
    await walkFiles(join(this.deps.paths.claudeDir, 'tasks', sessionId), 'tasks', out)
    await walkFiles(join(this.deps.paths.claudeDir, 'uploads', sessionId), 'uploads', out)
    let todos: string[] = []
    try { todos = readdirSync(join(this.deps.paths.claudeDir, 'todos')) } catch { /* none */ }
    for (const name of todos) {
      if (!name.toLowerCase().startsWith(sessionId.toLowerCase()) || !name.toLowerCase().endsWith('.json')) continue
      const path = join(this.deps.paths.claudeDir, 'todos', name)
      const st = await statOrNull(path)
      if (st !== null) out.set(`todos/${name}`, { path, size: st.size, mtimeMs: st.mtimeMs })
    }
    return out
  }

  private chatFileTarget(root: string, sessionId: string, rel: string): string | null {
    if (!isSafeRelative(rel)) return null
    const slash = rel.indexOf('/')
    const area = rel.slice(0, slash)
    const rest = rel.slice(slash + 1).split('/').join(sep)
    const claude = this.deps.paths.claudeDir
    switch (area) {
      case 'session': return resolve(this.projectDir(root), sessionId, rest)
      case 'tasks': return resolve(claude, 'tasks', sessionId, rest)
      case 'uploads': return resolve(claude, 'uploads', sessionId, rest)
      case 'todos':
        if (rest.includes(sep) || !rest.toLowerCase().startsWith(sessionId.toLowerCase())) return null
        return resolve(claude, 'todos', rest)
      default: return null
    }
  }

  private async projectFiles(root: string): Promise<Map<string, LocalFile>> {
    const out = new Map<string, LocalFile>()
    await walkFiles(join(this.projectDir(root), 'memory'), 'memory', out)
    return out
  }

  private projectFileTarget(root: string, rel: string): string | null {
    if (!isSafeRelative(rel) || !rel.startsWith('memory/')) return null
    return resolve(this.projectDir(root), rel.split('/').join(sep))
  }

  private listLocalChats(root: string): string[] {
    try {
      return readdirSync(this.projectDir(root))
        .filter(n => n.toLowerCase().endsWith('.jsonl'))
        .map(n => n.slice(0, -'.jsonl'.length))
        .filter(isSessionId)
    } catch {
      return []
    }
  }

  private originOf(root: string): Origin {
    let siblings: string[] = []
    try {
      const name = basename(root).toLowerCase()
      siblings = readdirSync(dirname(root))
        .filter(n => n.toLowerCase().startsWith(name) && n.length > name.length)
        .map(n => n.slice(name.length))
    } catch { /* the folder's parent isn't there */ }
    return { root, claudeDir: this.deps.paths.claudeDir, siblings }
  }

  /** A function turning another PC's paths into this one's. */
  private translator(origin: Origin, root: string): (line: string) => string {
    const rewriters: PathRewriter[] = []
    if (!isSamePath(origin.root, root)) rewriters.push(new PathRewriter(origin.root, root, origin.siblings))
    if (!isSamePath(origin.claudeDir, this.deps.paths.claudeDir)) rewriters.push(new PathRewriter(origin.claudeDir, this.deps.paths.claudeDir))
    if (rewriters.length === 0) return line => line
    return line => rewriters.reduce((text, r) => r.rewrite(text), line)
  }

  // ---------------------------------------------------------------- repo files

  private repoPath(name: string): string {
    return join(this.repoDir, name.split('/').join(sep))
  }

  private async readRepoJson<T>(name: string): Promise<T | null> {
    let data: Buffer
    try { data = await fsp.readFile(this.repoPath(name)) } catch { return null }
    return this.codec!.unpackJson<T>(data, name)
  }

  private async writeRepoFile(name: string, data: Buffer): Promise<void> {
    if (data.length > MAX_REPO_FILE) throw new Error(`${name} is too large for GitHub (${Math.round(data.length / 1048576)} MB).`)
    const path = this.repoPath(name)
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.writeFile(path, data)
  }

  private readCatalog(): void {
    if (this.codec === null) return
    void this.loadCatalog().then(() => this.deps.onChange())
  }

  /** Swaps the whole list in at once, so anything reading it never sees it half-built. */
  private async loadCatalog(): Promise<void> {
    const next = new Map<string, ProjectMeta>()
    let names: string[] = []
    try { names = await fsp.readdir(this.repoPath('catalog')) } catch { /* nothing yet */ }
    for (const n of names) {
      if (!n.endsWith('.bin')) continue
      try {
        const meta = await this.readRepoJson<ProjectMeta>(`catalog/${n}`)
        if (meta !== null) next.set(meta.projectId, meta)
      } catch { /* one unreadable entry shouldn't hide the rest */ }
    }
    this.catalog = next
  }

  // ---------------------------------------------------------------- scanning

  /** What's in a project, for the warning before it's opted in. */
  async scanProjectFor(workingDir: string, progress?: (p: ScanProgress) => void): Promise<ProjectScan> {
    const root = normalizePath(workingDir)
    const chats = this.listLocalChats(root)
    const findings = new Map<string, SecretFinding>()
    let images = 0
    let bytes = 0
    let done = 0
    for (const sessionId of chats) {
      const file = this.transcriptPath(root, sessionId)
      bytes += (await statOrNull(file))?.size ?? 0
      for await (const row of readRows(file)) {
        images += countImages(row.text)
        for (const f of scanText(row.text)) mergeFinding(findings, f, { sessionId })
      }
      for (const [rel, local] of await this.chatFiles(root, sessionId)) {
        bytes += local.size
        if (!isTextFile(rel) || local.size > MAX_SIDE_FILE) continue
        for (const f of scanText(await fsp.readFile(local.path, 'utf8'))) mergeFinding(findings, f, { sessionId })
      }
      progress?.({ workingDir: root, done: ++done, total: chats.length })
    }
    for (const [rel, local] of await this.projectFiles(root)) {
      bytes += local.size
      if (!isTextFile(rel) || local.size > MAX_SIDE_FILE) continue
      for (const f of scanText(await fsp.readFile(local.path, 'utf8'))) mergeFinding(findings, f, { file: rel })
    }
    return {
      workingDir: root, chats: chats.length, bytes, images,
      findings: [...findings.values()].sort((a, b) => Number(a.confidence === 'possible') - Number(b.confidence === 'possible') || b.count - a.count)
    }
  }

  // ---------------------------------------------------------------- opting in and out

  enableProject(workingDir: string, decisions: FindingDecisions, progress?: (p: EnableProgress) => void): Promise<SyncResult> {
    return this.guarded('Starting to sync the project', async () => {
      this.requireRepo()
      const root = normalizePath(workingDir)
      if (!isFullyQualified(root)) throw new Error('Choose a project with a full folder path.')
      if (Object.values(this.state.projects).some(p => isSamePath(p.root, root))) return
      this.enableProgress = progress === undefined ? null : { root, report: progress }
      try {
        await this.enableNow(root, decisions)
      } finally {
        this.enableProgress = null
      }
    })
  }

  private async enableNow(root: string, decisions: FindingDecisions): Promise<void> {
    this.enableProgress?.report({ workingDir: root, phase: 'download', done: 0, total: 0 })
    await this.git!.pull()
    await this.loadCatalog()
    // The same repo already synced from another PC is the same project.
    const github = readOriginRepo(root)
    const match = github === null ? undefined : [...this.catalog.values()].find(m => m.github?.toLowerCase() === github.toLowerCase() &&
      this.state.projects[m.projectId] === undefined)
    const projectId = match?.projectId ?? randomUUID()
    this.state.projects[projectId] = {
      projectId, root, excludedChats: decisions.excludeChats, redact: decisions.redact, allow: decisions.allow,
      pendingFindings: [], lastSyncAt: null, warnings: [], files: {}
    }
    this.save()
    await this.applySparse()
    await this.cycle()
  }

  disableProject(projectId: string): Promise<SyncResult> {
    return this.guarded('Stopping sync for the project', async () => {
      this.forgetProject(projectId)
      await this.applySparse()
    })
  }

  /** A project's Claude data was deleted on this PC: stop syncing it here, as De-sync does. Its
   *  copy on GitHub stays for the other PCs, and New chat can bring it back. */
  projectDeleted(workingDir: string): Promise<SyncResult> {
    return this.guarded('Stopping sync for a deleted project', async () => {
      const p = Object.values(this.state.projects).find(x => isSamePath(x.root, normalizePath(workingDir)))
      if (p === undefined) return
      this.forgetProject(p.projectId)
      if (this.git !== null) await this.applySparse()
    })
  }

  private forgetProject(projectId: string): void {
    delete this.state.projects[projectId]
    for (const [id, chat] of Object.entries(this.state.chats)) if (chat.projectId === projectId) delete this.state.chats[id]
    for (const [id, c] of Object.entries(this.state.conflicts)) if (c.projectId === projectId) delete this.state.conflicts[id]
    this.save()
  }

  removeFromGithub(projectId: string): Promise<SyncResult> {
    return this.guarded('Removing the project from GitHub', async () => {
      this.requireRepo()
      await this.git!.pull()
      await this.git!.removePath(`data/${projectId}`)
      await this.git!.removePath(`catalog/${projectId}.bin`)
      await this.updateHeaderRepos()
      if (await this.git!.hasChanges() && !await this.git!.commitAndPush('Remove a project')) {
        throw new Error('Another PC synced at the same moment. Try again.')
      }
      this.forgetProject(projectId)
      this.state.remoteSha = await this.git!.currentHead()
      this.save()
      await this.applySparse()
      await this.loadCatalog()
    })
  }

  /** Removes old versions from GitHub's history. Everything current stays. */
  startFresh(): Promise<SyncResult> {
    return this.guarded('Rebuilding the repo', async () => {
      this.requireRepo()
      await this.git!.pull()
      await this.git!.disableSparse()
      await this.git!.startFresh('Start fresh')
      this.state.remoteSha = await this.git!.currentHead()
      this.save()
      await this.applySparse()
      this.repoSize = await this.deps.hub.sizeBytes(this.state.repo!).catch(() => null)
    })
  }

  /** The recovery key, when this PC made the repo or was linked with it. */
  recoveryKey(): string | null {
    return this.state.repo !== null && this.state.encrypted ? this.deps.keys.loadRecovery() : null
  }

  /** Encrypts the whole repo again under a new recovery key, for when nobody has the old one.
   *  Old history goes too, since it was encrypted with the old key. Other PCs link again. */
  replaceRecoveryKey(): Promise<SetupOutcome> {
    return this.enqueue('Making a new recovery key', async () => {
      try {
        this.requireRepo()
        if (!this.state.encrypted) return { ok: false, error: "This sync repo isn't encrypted, so it has no recovery key." }
        if (!this.deps.keys.canSave()) return { ok: false, error: "Windows can't protect the sync key on this PC." }
        const git = this.git!
        await git.pull()
        const header = this.parseHeader(await fsp.readFile(join(this.repoDir, HEADER_FILE), 'utf8').catch(() => ''))
        if (header === null || header.check === null || !this.codec!.matches(header.check)) {
          throw new Error("This PC's key doesn't match the sync repo any more, so it can't re-encrypt it.")
        }
        await git.disableSparse()
        const recoveryKey = newRecoveryKey()
        const kdf = newKdf()
        const key = await deriveKey(recoveryKey, kdf)
        const next = new SyncCodec(key)
        for (const name of await repoFiles(this.repoDir)) {
          if (name === HEADER_FILE) continue
          const plain = await this.codec!.unpack(await fsp.readFile(this.repoPath(name)), name)
          await this.writeRepoFile(name, await next.pack(plain, name))
        }
        atomicWriteText(join(this.repoDir, HEADER_FILE), JSON.stringify({ ...header, kdf, check: keyCheck(key) }, null, 2))
        await git.startFresh('New recovery key')
        this.deps.keys.save(key, recoveryKey)
        this.codec = next
        this.state.remoteSha = await git.currentHead()
        this.save()
        await this.applySparse()
        await this.publishPresence(true)
        await this.refreshPresence(true)
        this.lastError = null
        return { ok: true, repo: this.state.repo!, recoveryKey, encrypted: true }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    })
  }

  /** The header's list of GitHub repos with synced chats, as it stands in the local copy. */
  private headerRepos(): string[] {
    try {
      return this.parseHeader(readFileSync(join(this.repoDir, HEADER_FILE), 'utf8'))?.repos ?? []
    } catch {
      return []
    }
  }

  /** Brings the header's repo list in line with the catalog. Each PC works it out the same way,
   *  so two PCs never write it back and forth. */
  private async updateHeaderRepos(): Promise<void> {
    await this.loadCatalog()
    const path = join(this.repoDir, HEADER_FILE)
    let header: Header | null
    try { header = this.parseHeader(await fsp.readFile(path, 'utf8')) } catch { return }
    if (header === null) return
    const repos = uniqueRepos([...this.catalog.values()].flatMap(m => m.github === null ? [] : [m.github]))
    if (repos.join('\n') === (header.repos ?? []).join('\n')) return
    atomicWriteText(path, JSON.stringify({ ...header, repos }, null, 2))
  }

  /** Stops before reading anything if another PC has put the repo under a new key. */
  private checkRepoKey(): void {
    if (!this.state.encrypted) return
    let text: string
    try { text = readFileSync(join(this.repoDir, HEADER_FILE), 'utf8') } catch { return }
    const header = this.parseHeader(text)
    if (header?.check != null && !this.codec!.matches(header.check)) {
      throw new Error('This sync repo has a new recovery key, made on another PC. Disconnect this PC, then link it again with the new key.')
    }
  }

  private requireRepo(): void {
    if (this.state.repo === null || this.git === null || this.codec === null) throw new Error('Sync isn’t set up on this PC.')
  }

  private async applySparse(): Promise<void> {
    await this.git!.setProjects(Object.keys(this.state.projects))
  }

  /** Puts a project from the sync repo on this PC: makes the folder, clones the project's own
   *  repo there if it has one, then brings in the chats with their paths pointing at it. */
  linkProject(projectId: string, folder: string, progress?: (p: EnableProgress) => void): Promise<LinkOutcome> {
    return this.enqueue('Setting up the project here', async () => {
      try {
        if (progress !== undefined) progress({ workingDir: normalizePath(folder.trim()), phase: 'download', done: 0, total: 0 })
        this.requireRepo()
        await this.git!.pull()
        await this.loadCatalog()
        const meta = this.catalog.get(projectId)
        if (meta === undefined) return { ok: false, error: "That project isn't in the sync repo any more." }
        const root = normalizePath(folder.trim())
        if (!isFullyQualified(root)) return { ok: false, error: 'Choose a full folder path.' }
        if (isSameOrUnder(root, this.deps.paths.claudeDir) || isSameOrUnder(this.deps.paths.claudeDir, root)) {
          return { ok: false, error: "That folder holds Claude's own data. Choose another." }
        }
        const taken = Object.values(this.state.projects).find(p => isSamePath(p.root, root))
        if (taken !== undefined) return { ok: false, error: `${root} is already synced as another project.` }

        this.enableProgress = progress === undefined ? null : { root, report: progress }
        const warnings: string[] = []
        if (meta.github !== null) {
          this.enableProgress?.report({ workingDir: root, phase: 'clone', done: 0, total: 0 })
          const prepared = await prepareRepo(this.deps.run, { repo: meta.github, cwd: root })
          if (!prepared.ok) return { ok: false, error: prepared.error }
          if (prepared.warning !== undefined) warnings.push(prepared.warning)
          if (meta.branch !== null && meta.branch !== 'HEAD') {
            const here = await codeState(this.deps.run, root)
            if (here.branch !== meta.branch) {
              const moved = await this.deps.run('git', ['checkout', '-q', meta.branch], { cwd: root })
              if (moved.code !== 0) warnings.push(`The chat last used branch ${meta.branch}, which isn't available here, so the folder stays on ${here.branch ?? 'its default branch'}.`)
            }
          }
          if (meta.unpushed > 0) warnings.push(`${meta.updatedBy} has ${meta.unpushed} commit${meta.unpushed === 1 ? '' : 's'} not pushed to GitHub, so this copy doesn't have them.`)
          if (meta.uncommitted > 0) warnings.push(`${meta.updatedBy} has ${meta.uncommitted} changed file${meta.uncommitted === 1 ? '' : 's'} not committed, so this copy doesn't have them.`)
        } else {
          if (existsSync(root) && !(await fsp.stat(root)).isDirectory()) return { ok: false, error: `${root} is a file. Choose a folder.` }
          await fsp.mkdir(root, { recursive: true })
          warnings.push("This project has no GitHub repo, so its code isn't here. Only its chats were brought over.")
        }

        this.deps.trustFolder(root)
        this.state.projects[projectId] = {
          projectId, root, excludedChats: [], redact: [], allow: [], pendingFindings: [], lastSyncAt: null, warnings: [], files: {}
        }
        this.save()
        // Fetching the project's part of the sync repo is the slow part: it's all its chats.
        this.enableProgress?.report({ workingDir: root, phase: 'download', done: 0, total: 0 })
        await this.applySparse()
        await this.cycle()
        await this.refreshCatalogue()
        return { ok: true, workingDir: root, chats: this.listLocalChats(root).length, warnings }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      } finally {
        this.enableProgress = null
      }
    })
  }

  /** A project's folder was renamed through Delegatto, so its chats moved with it. */
  async projectFolderRenamed(fromEncoded: string, toEncoded: string): Promise<void> {
    for (const p of Object.values(this.state.projects)) {
      if (encodePath(p.root).toLowerCase() !== fromEncoded.toLowerCase()) continue
      const info = await scanOneProject(this.deps.paths, toEncoded)
      if (info !== null && info.workingDirKnown) {
        p.root = normalizePath(info.workingDir)
        this.save()
      }
    }
  }

  decideFindings(projectId: string, decisions: FindingDecisions): Promise<SyncResult> {
    return this.guarded('Saving your choices', async () => {
      const p = this.state.projects[projectId]
      if (p === undefined) throw new Error("That project isn't synced.")
      p.redact = [...new Set([...p.redact, ...decisions.redact])]
      p.allow = [...new Set([...p.allow, ...decisions.allow])]
      p.excludedChats = [...new Set([...p.excludedChats, ...decisions.excludeChats])]
      const decided = new Set([...decisions.redact, ...decisions.allow])
      p.pendingFindings = p.pendingFindings
        .map(f => ({ ...f, sessionIds: f.sessionIds.filter(id => !decisions.excludeChats.includes(id)) }))
        .filter(f => !decided.has(f.fingerprint) && (f.sessionIds.length > 0 || f.files.length > 0))
      this.save()
      await this.cycle()
    })
  }

  // ---------------------------------------------------------------- the sync itself

  syncNow(): Promise<SyncResult> {
    return this.guarded('Syncing', async () => {
      this.requireRepo()
      await this.cycle()
      await this.publishPresence(false)
      await this.refreshPresence(true)
    })
  }

  /** The periodic check: one small request, and a full sync only if something changed. */
  tick(): Promise<void> {
    if (this.state.repo === null || !this.state.auto) return Promise.resolve()
    return this.enqueue('Checking for changes', async () => {
      try {
        await this.checkOnce()
        this.lastError = null
      } catch (e) {
        this.lastError = errorText(e)
      }
    })
  }

  private async checkOnce(): Promise<void> {
    if (this.git === null || this.codec === null) return
    this.lastCheckAt = this.now()
    const remote = await this.git.listRemote()
    if (remote.main !== this.state.remoteSha || await this.localChanged()) await this.cycle()
    const changed = remote.presence.size !== this.presenceShas.size ||
      [...remote.presence].some(([id, sha]) => this.presenceShas.get(id) !== sha)
    if (changed) await this.refreshPresence(false)
    await this.publishPresence(false)
  }

  private async localChanged(): Promise<boolean> {
    for (const p of Object.values(this.state.projects)) {
      for (const sessionId of this.listLocalChats(p.root)) {
        if (p.excludedChats.includes(sessionId)) continue
        const st = this.state.chats[sessionId]
        if (st === undefined) return true
        if (st.localDeleted === true) continue
        const file = await statOrNull(this.transcriptPath(p.root, sessionId))
        if (file !== null && (file.size !== st.size || file.mtimeMs !== st.mtimeMs)) return true
        for (const [rel, local] of await this.chatFiles(p.root, sessionId)) {
          const known = st.files[rel]
          if (known === undefined || known.size !== local.size || known.mtimeMs !== local.mtimeMs) return true
        }
      }
      for (const [rel, local] of await this.projectFiles(p.root)) {
        const known = p.files[rel]
        if (known === undefined || known.size !== local.size || known.mtimeMs !== local.mtimeMs) return true
      }
    }
    return false
  }

  incomingChats(): SyncIncoming[] {
    return [...this.incoming.values()]
  }

  private sendIncoming(force: boolean): void {
    // Progress while writing comes often; a few updates a second is plenty.
    if (!force && this.now() - this.incomingSentAt < 150) return
    this.incomingSentAt = this.now()
    this.deps.onIncoming?.(this.incomingChats())
  }

  /** Notes the chats a pull is about to change, from the list of files it changes. Only ones this
   *  PC syncs and still has, and only what another PC wrote. */
  private markIncoming(paths: string[], lastBy: string | null): void {
    const deviceId = lastBy?.endsWith(' sync') === true ? lastBy.slice(0, -' sync'.length) : null
    if (deviceId === this.state.deviceId) return
    const named = this.devices.find(d => d.id === deviceId)?.name ?? null
    let added = false
    for (const path of paths) {
      const m = /^data\/([^/]+)\/chats\/([^/]+)\//.exec(path)
      if (m === null || this.state.projects[m[1]!] === undefined || !isSessionId(m[2]!)) continue
      if (this.state.chats[m[2]!]?.localDeleted === true || this.incoming.has(m[2]!)) continue
      // The PCs list may not have loaded yet; the chat itself knows who wrote to it last.
      const meta = this.chatMeta.get(m[2]!)
      const from = named ?? (meta !== undefined && meta.deviceId === deviceId ? meta.device : 'another PC')
      this.incoming.set(m[2]!, { sessionId: m[2]!, from, phase: 'download', done: 0, total: 0 })
      added = true
    }
    if (added) this.sendIncoming(true)
  }

  /** Once a pass is over, the chats it changed are listed again before they're let go, so a
   *  chat reloads with its new messages rather than without them. */
  private async finishIncoming(): Promise<void> {
    if (this.incoming.size === 0) return
    await this.refreshCatalogue().catch(() => {})
    this.incoming.clear()
    this.sendIncoming(true)
  }

  /** Download what's new, upload what's new. Git refuses a push from a PC that's behind,
   *  even if two push at the same moment, and then the whole pass is simply redone. */
  private async cycle(): Promise<void> {
    try {
      await this.cycleOnce()
    } finally {
      await this.finishIncoming()
    }
  }

  private async cycleOnce(): Promise<void> {
    this.requireRepo()
    const git = this.git!
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      const watch = this.enableProgress
      watch?.report({ workingDir: watch.root, phase: 'download', done: 0, total: 0 })
      const main = await git.pull((paths, lastBy) => this.markIncoming(paths, lastBy))
      this.checkRepoKey()
      await this.loadCatalog()
      const pending: Array<() => void> = []
      let localChanges = false
      for (const p of Object.values(this.state.projects)) {
        if (await this.syncProject(p, pending)) localChanges = true
      }
      if (localChanges) void this.refreshCatalogue().catch(() => {})
      await this.updateHeaderRepos()
      if (!await git.hasChanges()) {
        for (const done of pending) done()
        this.state.remoteSha = main
        this.finishCycle()
        return
      }
      const onPercent = watch === null ? undefined
        : (percent: number) => watch.report({ workingDir: watch.root, phase: 'upload', done: percent, total: 100 })
      onPercent?.(0)
      if (await git.commitAndPush(`${this.state.deviceId} sync`, onPercent)) {
        for (const done of pending) done()
        this.state.remoteSha = await git.currentHead()
        this.finishCycle()
        this.repoSize = await this.deps.hub.sizeBytes(this.state.repo!).catch(() => this.repoSize)
        return
      }
    }
    throw new Error('Other PCs kept syncing at the same moment. It will try again shortly.')
  }

  private async refreshCatalogue(): Promise<void> {
    await this.deps.afterLocalChange()
    for (const [file, title] of this.titlesToApply) this.deps.setChatTitle(file, title)
    this.titlesToApply.clear()
  }

  private finishCycle(): void {
    const at = this.now()
    this.state.lastSyncAt = at
    this.lastCheckAt = at
    for (const p of Object.values(this.state.projects)) p.lastSyncAt = at
    this.save()
    void this.loadCatalog().then(() => this.deps.onChange())
  }

  private async syncProject(p: ProjectState, pending: Array<() => void>): Promise<boolean> {
    p.warnings = []
    const newFindings = new Map<string, SecretFinding>(p.pendingFindings.map(f => [f.fingerprint, f]))
    if (!existsSync(p.root)) p.warnings.push(`${p.root} doesn't exist any more. Its chats still sync.`)

    const chats = new Set(this.listLocalChats(p.root))
    try {
      for (const name of await fsp.readdir(this.repoPath(`data/${p.projectId}/chats`))) if (isSessionId(name)) chats.add(name)
    } catch { /* nothing uploaded yet */ }

    let localChanges = false
    const uploadsBefore = pending.length
    const code = await codeState(this.deps.run, p.root)
    const included = [...chats].filter(id => !p.excludedChats.includes(id))
    const watch = this.enableProgress !== null && isSamePath(this.enableProgress.root, p.root) ? this.enableProgress : null
    let done = 0
    watch?.report({ workingDir: watch.root, phase: 'pack', done, total: included.length })
    for (const sessionId of included) {
      try {
        if (await this.syncChat(p, sessionId, code, newFindings, pending)) localChanges = true
      } catch (e) {
        p.warnings.push(`A chat couldn't sync: ${errorText(e)}`)
      }
      watch?.report({ workingDir: watch.root, phase: 'pack', done: ++done, total: included.length })
    }
    try {
      if (await this.syncProjectFiles(p, newFindings, pending)) localChanges = true
    } catch (e) {
      p.warnings.push(`The project's memory couldn't sync: ${errorText(e)}`)
    }
    p.pendingFindings = [...newFindings.values()].filter(f => !p.redact.includes(f.fingerprint) && !p.allow.includes(f.fingerprint))
    await this.writeProjectMeta(p, code, chats.size, pending.length > uploadsBefore)
    return localChanges
  }

  /** Describes the PC that last uploaded. Other PCs leave it alone until they upload something
   *  too, or two PCs on different commits would rewrite it back and forth on every sync. */
  private async writeProjectMeta(p: ProjectState, code: Awaited<ReturnType<typeof codeState>>, chatCount: number, uploaded: boolean): Promise<void> {
    const name = `catalog/${p.projectId}.bin`
    const existing = await this.readRepoJson<ProjectMeta>(name).catch(() => null)
    if (existing !== null && !uploaded && existing.updatedById !== this.state.deviceId) return
    const meta: ProjectMeta = {
      projectId: p.projectId, name: existing?.name ?? basename(p.root), github: readOriginRepo(p.root) ?? existing?.github ?? null,
      branch: code.branch, head: code.head, unpushed: code.unpushed, uncommitted: code.uncommitted, chats: chatCount,
      updatedBy: this.deviceName, updatedById: this.state.deviceId, updatedAt: this.now()
    }
    const same = existing !== null && existing.updatedById === this.state.deviceId && existing.updatedBy === meta.updatedBy && existing.github === meta.github && existing.branch === meta.branch && existing.head === meta.head &&
      existing.unpushed === meta.unpushed && existing.uncommitted === meta.uncommitted && existing.chats === meta.chats && existing.name === meta.name
    if (!same) await this.writeRepoFile(name, await this.codec!.packJson(meta, name))
  }

  private async verifyBase(file: string, st: ChatState, stat: Stats | null): Promise<void> {
    if (st.baseRows === 0) { st.offset = 0; return }
    if (stat === null) return
    if (stat.size === st.size && stat.mtimeMs === st.mtimeMs) return
    if (await keyEndingAt(file, st.offset).catch(() => null) === st.baseKey) return
    // The file changed underneath, such as a folder rename rewriting its paths.
    const at = await locateRow(file, st.baseRows, st.baseKey)
    if (at !== null) { st.offset = at; return }
    st.baseRows = 0
    st.baseKey = null
    st.offset = 0
  }

  private async *remoteRows(projectId: string, sessionId: string, index: ChatIndex, fromRow: number): AsyncGenerator<{ text: string; chunk: ChunkEntry }> {
    let row = 0
    for (const chunk of index.chunks) {
      if (row + chunk.rows <= fromRow) { row += chunk.rows; continue }
      if (!/^r\d+-[0-9a-f]+\.bin$/.test(chunk.name)) throw new Error('A chat in the sync repo has a bad file name.')
      const name = `${this.chatFolder(projectId, sessionId)}/${chunk.name}`
      const data = await fsp.readFile(this.repoPath(name))
      const lines = (await this.codec!.unpack(data, name)).toString('utf8').split('\n')
      for (const text of lines) {
        if (text.length === 0) continue
        if (row++ >= fromRow) yield { text, chunk }
      }
    }
  }

  private async countLocal(file: string, offset: number, stat: Stats | null): Promise<{ rows: number; end: number }> {
    if (stat === null || stat.size <= offset) return { rows: 0, end: offset }
    let rows = 0
    let end = offset
    for await (const row of readRows(file, offset)) { rows++; end = row.endOffset }
    return { rows, end }
  }

  private async syncChat(p: ProjectState, sessionId: string, code: Awaited<ReturnType<typeof codeState>>,
    findings: Map<string, SecretFinding>, pending: Array<() => void>): Promise<boolean> {
    const indexName = `${this.chatFolder(p.projectId, sessionId)}/index.bin`
    let index = await this.readRepoJson<ChatIndex>(indexName)
    const file = this.transcriptPath(p.root, sessionId)
    let stat = await statOrNull(file)
    if (index !== null && index.sessionId !== sessionId) throw new Error('A chat in the sync repo is filed under the wrong name.')
    if (index !== null) {
      this.chatMeta.set(sessionId, { device: index.device.name, deviceId: index.device.id, at: index.at, head: index.code.head, title: index.title })
    }

    const st: ChatState = this.state.chats[sessionId] ?? {
      projectId: p.projectId, baseRows: 0, baseKey: null, offset: 0, size: 0, mtimeMs: 0, files: {}
    }
    if (st.localDeleted === true) return false
    if (stat === null && index === null) return false
    // Deleted on this PC: don't bring it back, and don't touch the other PCs' copy.
    if (stat === null && st.baseRows > 0) {
      st.localDeleted = true
      this.state.chats[sessionId] = st
      delete this.state.conflicts[sessionId]
      return false
    }
    if (this.deps.isChatBusy(sessionId)) return false

    await this.verifyBase(file, st, stat)
    if (index !== null && index.rows < st.baseRows) {
      st.baseRows = 0
      st.baseKey = null
      st.offset = 0
    }
    let local = await this.countLocal(file, st.offset, stat)
    let remoteNew = (index?.rows ?? 0) - st.baseRows

    // Rows both sides already share, such as the same chat present on both PCs at first sync.
    if (local.rows > 0 && remoteNew > 0 && index !== null) {
      const remote = this.remoteRows(p.projectId, sessionId, index, st.baseRows)
      for await (const row of readRows(file, st.offset)) {
        const other = await remote.next()
        if (other.done === true || rowKey(row.text) !== rowKey(other.value.text)) break
        st.baseRows++
        st.baseKey = rowKey(row.text)
        st.offset = row.endOffset
      }
      await remote.return(undefined)
      local = await this.countLocal(file, st.offset, stat)
      remoteNew = index.rows - st.baseRows
    }

    if (local.rows > 0 && remoteNew > 0 && index !== null) {
      this.state.conflicts[sessionId] = {
        sessionId, projectId: p.projectId, title: index.title ?? 'A chat', otherDevice: index.device.name, otherAt: index.at,
        localRows: local.rows, remoteRows: remoteNew, sessionPk: this.deps.sessionPkOf(file)
      }
      this.state.chats[sessionId] = st
      this.save()
      return false
    }
    delete this.state.conflicts[sessionId]

    let changedHere = false
    let indexChanged = false
    if (remoteNew > 0 && index !== null) {
      if (!await this.closeForChange(sessionId)) { this.state.chats[sessionId] = st; return false }
      const from = index.device.name
      const progress = (done: number): void => {
        this.incoming.set(sessionId, { sessionId, from, phase: 'write', done, total: remoteNew })
        this.sendIncoming(done === 0 || done === remoteNew)
      }
      progress(0)
      await this.appendRemoteRows(p, sessionId, index, st, file, progress)
      stat = await statOrNull(file)
      changedHere = true
    }
    this.state.chats[sessionId] = st

    let held = false
    const next: ChatIndex = index ?? {
      sessionId, rows: 0, chunks: [], files: {}, device: { id: this.state.deviceId, name: this.deviceName }, at: this.now(), code: { branch: null, head: null }, title: null
    }
    const after: Array<() => void> = []
    if (local.rows > 0 && stat !== null) {
      const uploaded = await this.uploadRows(p, sessionId, file, st, stat, local.end, next, findings)
      if (uploaded === null) held = true
      else {
        indexChanged = true
        after.push(() => {
          st.baseRows = uploaded.baseRows
          st.baseKey = uploaded.baseKey
          st.offset = uploaded.offset
          st.size = uploaded.size
          st.mtimeMs = uploaded.mtimeMs
        })
      }
    } else if (stat !== null && local.rows === 0) {
      st.size = stat.size
      st.mtimeMs = stat.mtimeMs
    }

    const localFiles = await this.chatFiles(p.root, sessionId)
    const filesResult = await this.syncFileSet({
      root: p.root, local: localFiles, remote: next.files, known: st.files, project: p, sessionId,
      repoFolder: this.chatFolder(p.projectId, sessionId), blobPrefix: 'f-',
      target: rel => this.chatFileTarget(p.root, sessionId, rel), findings, after,
      canWrite: () => !this.deps.isChatOpen(sessionId) && !this.deps.isExternallyLive(sessionId)
    })
    if (filesResult.applied) changedHere = true
    if (filesResult.uploaded) indexChanged = true

    if (indexChanged && !held) {
      next.device = { id: this.state.deviceId, name: this.deviceName }
      next.at = this.now()
      next.code = { branch: code.branch, head: code.head }
      next.title = await this.titleOf(file) ?? next.title
      await this.writeRepoFile(indexName, await this.codec!.packJson(next, indexName))
      pending.push(() => { for (const f of after) f() })
    } else if (indexChanged && filesResult.uploaded) {
      // Rows are held for a decision, but its side files are fine.
      await this.writeRepoFile(indexName, await this.codec!.packJson(next, indexName))
      pending.push(() => { for (const f of after) f() })
    }
    return changedHere
  }

  /** A chat's process has to be closed before its transcript changes underneath it. It starts
   *  again on the next message. False when it can't be closed, and the chat waits. */
  private async closeForChange(sessionId: string): Promise<boolean> {
    if (this.deps.isExternallyLive(sessionId)) return false
    if (!this.deps.isChatOpen(sessionId)) return true
    this.deps.stopChat(sessionId)
    const deadline = this.now() + CLOSE_WAIT_MS
    while (this.deps.isChatOpen(sessionId)) {
      if (this.now() > deadline) return false
      await this.sleep(150)
    }
    return true
  }

  private async appendRemoteRows(p: ProjectState, sessionId: string, index: ChatIndex, st: ChatState, file: string, progress?: (done: number) => void): Promise<void> {
    await fsp.mkdir(dirname(file), { recursive: true })
    const current = await statOrNull(file)
    if (current !== null && current.size > 0) {
      // A line without its newline would join onto the first new row.
      const handle = await fsp.open(file, 'r')
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, current.size - 1)
      await handle.close()
      if (last[0] !== 0x0a) await fsp.appendFile(file, '\n')
    }
    let parts: string[] = []
    let held = 0
    let translate: (line: string) => string = line => line
    let translating: ChunkEntry | null = null
    let lastKey = st.baseKey
    let written = 0
    const flush = async (): Promise<void> => {
      if (parts.length === 0) return
      await fsp.appendFile(file, parts.join(''))
      parts = []
      held = 0
    }
    for await (const { text, chunk } of this.remoteRows(p.projectId, sessionId, index, st.baseRows)) {
      if (chunk !== translating) {
        translating = chunk
        translate = this.translator(chunk, p.root)
      }
      const line = translate(text)
      if (line.includes('"customTitle"')) {
        try {
          const title = (JSON.parse(line) as { customTitle?: unknown }).customTitle
          if (typeof title === 'string') this.titlesToApply.set(file, title)
        } catch { /* not a title row */ }
      }
      parts.push(`${line}\n`)
      held += line.length
      lastKey = rowKey(line)
      if (held > CHUNK_BYTES) await flush()
      progress?.(++written)
    }
    await flush()
    const after = await fsp.stat(file)
    st.baseRows = index.rows
    st.baseKey = lastKey
    st.offset = after.size
    st.size = after.size
    st.mtimeMs = after.mtimeMs
  }

  /** Adds the chat's new rows to `next`. Null when a likely secret needs a decision first. */
  private async uploadRows(p: ProjectState, sessionId: string, file: string, st: ChatState, stat: Stats, end: number,
    next: ChatIndex, findings: Map<string, SecretFinding>): Promise<{ baseRows: number; baseKey: string | null; offset: number; size: number; mtimeMs: number } | null> {
    let undecided = false
    for await (const row of readRows(file, st.offset)) {
      if (row.endOffset > end) break
      for (const f of scanText(row.text)) {
        if (p.redact.includes(f.fingerprint) || p.allow.includes(f.fingerprint)) continue
        undecided = true
        mergeFinding(findings, f, { sessionId })
      }
    }
    if (undecided) return null

    const origin = this.originOf(p.root)
    let parts: string[] = []
    let held = 0
    let rows = 0
    let total = st.baseRows
    let lastKey = st.baseKey
    const flush = async (): Promise<void> => {
      if (rows === 0) return
      const plain = Buffer.from(parts.join(''), 'utf8')
      const name = `r${String(next.chunks.length).padStart(6, '0')}-${sha256(plain)}.bin`
      const path = `${this.chatFolder(p.projectId, sessionId)}/${name}`
      await this.writeRepoFile(path, await this.codec!.pack(plain, path))
      next.chunks.push({ name, rows, lastKey: lastKey ?? '', ...origin, device: this.deviceName, at: this.now() })
      next.rows = total
      parts = []
      held = 0
      rows = 0
    }
    for await (const row of readRows(file, st.offset)) {
      if (row.endOffset > end) break
      let text = row.text
      if (p.redact.length > 0) {
        const redact = scanText(text).filter(f => p.redact.includes(f.fingerprint))
        if (redact.length > 0) text = redactSecrets(text, redact)
      }
      parts.push(`${text}\n`)
      held += text.length
      rows++
      total++
      lastKey = rowKey(row.text)
      if (held >= CHUNK_BYTES) await flush()
    }
    await flush()
    return { baseRows: total, baseKey: lastKey, offset: end, size: stat.size, mtimeMs: stat.mtimeMs }
  }

  private async syncFileSet(o: {
    root: string
    local: Map<string, LocalFile>
    remote: Record<string, RemoteFile>
    known: Record<string, FileEntry>
    project: ProjectState
    sessionId?: string
    repoFolder: string
    blobPrefix: string
    target: (rel: string) => string | null
    findings: Map<string, SecretFinding>
    after: Array<() => void>
    canWrite: () => boolean
  }): Promise<{ applied: boolean; uploaded: boolean }> {
    let applied = false
    let uploaded = false

    for (const [rel, remote] of Object.entries(o.remote)) {
      const known = o.known[rel]
      if (known?.blob === remote.blob) continue
      const local = o.local.get(rel)
      // Changed here as well, or never seen in sync: keep this PC's copy, which uploads below.
      if (local !== undefined && (known === undefined || local.size !== known.size || local.mtimeMs !== known.mtimeMs)) continue
      if (!/^[A-Za-z-]+[0-9a-f]+\.bin$/.test(remote.blob)) throw new Error('A file in the sync repo has a bad name.')
      if (!o.canWrite()) continue
      const target = o.target(rel)
      if (target === null) {
        o.project.warnings.push(`Skipped ${rel}: it would land outside this project's data.`)
        continue
      }
      const name = `${o.repoFolder}/${remote.blob}`
      let plain = await this.codec!.unpack(await fsp.readFile(this.repoPath(name)), name)
      if (isTextFile(rel)) {
        const translate = this.translator(remote, o.root)
        plain = Buffer.from(translate(plain.toString('utf8')), 'utf8')
      }
      await fsp.mkdir(dirname(target), { recursive: true })
      atomicWriteBytes(target, plain)
      const st = await fsp.stat(target)
      o.known[rel] = { blob: remote.blob, size: st.size, mtimeMs: st.mtimeMs }
      o.local.delete(rel)
      applied = true
    }

    const origin = this.originOf(o.root)
    for (const [rel, local] of o.local) {
      const known = o.known[rel]
      if (known !== undefined && known.size === local.size && known.mtimeMs === local.mtimeMs) continue
      if (local.size > MAX_SIDE_FILE) {
        o.project.warnings.push(`Skipped ${rel}: it's too large to sync.`)
        continue
      }
      let plain = await fsp.readFile(local.path)
      if (isTextFile(rel)) {
        const text = plain.toString('utf8')
        const found = scanText(text)
        const open = found.filter(f => !o.project.redact.includes(f.fingerprint) && !o.project.allow.includes(f.fingerprint))
        if (open.length > 0) {
          for (const f of open) mergeFinding(o.findings, f, o.sessionId === undefined ? { file: rel } : { sessionId: o.sessionId })
          continue
        }
        const redact = found.filter(f => o.project.redact.includes(f.fingerprint))
        if (redact.length > 0) plain = Buffer.from(redactSecrets(text, redact), 'utf8')
      }
      const blob = `${o.blobPrefix}${sha256(plain)}.bin`
      const name = `${o.repoFolder}/${blob}`
      if (!existsSync(this.repoPath(name))) {
        const packed = await this.codec!.pack(plain, name)
        if (packed.length > MAX_REPO_FILE) {
          o.project.warnings.push(`Skipped ${rel}: it's too large for GitHub.`)
          continue
        }
        await this.writeRepoFile(name, packed)
      }
      o.remote[rel] = { blob, size: plain.length, device: this.deviceName, at: this.now(), ...origin }
      uploaded = true
      const size = local.size
      const mtimeMs = local.mtimeMs
      o.after.push(() => { o.known[rel] = { blob, size, mtimeMs } })
    }
    return { applied, uploaded }
  }

  private async syncProjectFiles(p: ProjectState, findings: Map<string, SecretFinding>, pending: Array<() => void>): Promise<boolean> {
    const name = `data/${p.projectId}/files.bin`
    const remote = await this.readRepoJson<Record<string, RemoteFile>>(name) ?? {}
    const after: Array<() => void> = []
    const result = await this.syncFileSet({
      root: p.root, local: await this.projectFiles(p.root), remote, known: p.files, project: p,
      repoFolder: `data/${p.projectId}`, blobPrefix: 'pf-', target: rel => this.projectFileTarget(p.root, rel),
      findings, after, canWrite: () => true
    })
    if (result.uploaded) {
      await this.writeRepoFile(name, await this.codec!.packJson(remote, name))
      pending.push(() => { for (const f of after) f() })
    }
    return result.applied
  }

  private async titleOf(file: string): Promise<string | null> {
    let custom: string | null = null
    let ai: string | null = null
    let first: string | null = null
    for await (const row of readRows(file)) {
      if (!row.text.includes('Title') && first !== null) continue
      try {
        const v = JSON.parse(row.text) as Record<string, unknown>
        if (typeof v.customTitle === 'string') custom = v.customTitle
        if (typeof v.aiTitle === 'string') ai = v.aiTitle
        if (first === null && v.type === 'user') {
          const text = textOfUserRow(v)
          if (text !== null && isRealPrompt(text)) first = text.slice(0, 80)
        }
      } catch { /* a bad row isn't a title */ }
    }
    return custom ?? ai ?? first
  }

  // ---------------------------------------------------------------- conflicts

  /** Keeps both. What's already synced stays as the main chat, and this PC's separate
   *  messages become their own linked chat. Neither is stitched into the other, because each
   *  side's replies were written without seeing the other's. */
  resolveConflict(sessionId: string): Promise<ResolveOutcome> {
    return this.enqueue('Separating the chats', async () => {
      try {
        const conflict = this.state.conflicts[sessionId]
        const st = this.state.chats[sessionId]
        const p = conflict === undefined ? undefined : this.state.projects[conflict.projectId]
        if (conflict === undefined || st === undefined || p === undefined) return { ok: false, error: "That chat isn't out of sync any more." }
        if (this.deps.isChatBusy(sessionId)) return { ok: false, error: "That chat is working. Try again when it's finished." }
        if (!await this.closeForChange(sessionId)) return { ok: false, error: 'That chat is open somewhere else on this PC. Close it first.' }
        await this.git!.pull()
        const indexName = `${this.chatFolder(p.projectId, sessionId)}/index.bin`
        const index = await this.readRepoJson<ChatIndex>(indexName)
        if (index === null) return { ok: false, error: "That chat isn't in the sync repo any more." }

        const file = this.transcriptPath(p.root, sessionId)
        const branchId = randomUUID()
        const branchFile = this.transcriptPath(p.root, branchId)
        const title = await this.titleOf(file) ?? 'Chat'
        const lines: string[] = []
        const prompts: string[] = []
        let lastReply: string | null = null
        for await (const row of readRows(file)) {
          lines.push(`${replaceSessionId(row.text, sessionId, branchId)}\n`)
          if (row.endOffset <= st.offset) continue
          try {
            const v = JSON.parse(row.text) as Record<string, unknown>
            const text = textOfUserRow(v)
            if (text === null) continue
            if (v.type === 'user' && v.isMeta !== true && isRealPrompt(text)) prompts.push(text)
            else if (v.type === 'assistant') lastReply = text
          } catch { /* unreadable row */ }
        }
        const branchTitle = `${title} (from ${this.deviceName})`
        lines.push(`${JSON.stringify({ type: 'custom-title', customTitle: branchTitle, sessionId: branchId })}\n`)
        this.titlesToApply.set(branchFile, branchTitle)
        atomicWriteBytes(branchFile, Buffer.from(lines.join(''), 'utf8'))
        await fsp.cp(join(this.projectDir(p.root), sessionId), join(this.projectDir(p.root), branchId), { recursive: true }).catch(() => {})

        // The branch is safely on disk, so the main chat can go back to where the PCs agreed.
        await fsp.truncate(file, st.offset)
        await this.appendRemoteRows(p, sessionId, index, st, file)
        delete this.state.conflicts[sessionId]
        this.save()
        await this.refreshCatalogue()
        await this.cycle()
        return {
          ok: true, branchSessionId: branchId, sessionPk: this.deps.sessionPkOf(file), branchPk: this.deps.sessionPkOf(branchFile),
          projectDir: encodePath(normalizePath(p.root)),
          summary: this.summaryOf(this.deviceName, prompts, lastReply)
        }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    })
  }

  private summaryOf(device: string, prompts: string[], lastReply: string | null): string {
    const clip = (s: string, n: number): string => s.length <= n ? s : `${s.slice(0, n)}…`
    const asked = prompts.slice(-10).map(t => `- ${clip(t.trim().replace(/\s+/g, ' '), 300)}`).join('\n')
    return [
      `For context, this is a report of separate work on ${device}, not part of this conversation. You didn't see it happen, and files there may differ from here.`,
      '', 'What was asked there:', asked || '- (nothing recorded)',
      ...(lastReply === null ? [] : ['', 'The last reply there:', clip(lastReply.trim(), 1200)])
    ].join('\n')
  }

  // ---------------------------------------------------------------- presence

  chatOpened(sessionId: string | null): void {
    this.openChat = sessionId
    if (this.state.repo !== null) void this.enqueue('Updating this PC’s status', () => this.publishPresence(false)).catch(() => {})
  }

  private presenceBody(): PresenceBody {
    return { name: this.deviceName, hostname: this.deps.hostname, at: this.now(), openChats: this.openChat === null ? [] : [this.openChat] }
  }

  private async publishPresence(force: boolean): Promise<void> {
    if (this.git === null || this.codec === null) return
    const body = this.presenceBody()
    const fingerprint = JSON.stringify({ ...body, at: 0 })
    const due = this.now() - this.presenceSentAt >= PRESENCE_EVERY_MS
    if (!force && fingerprint === this.presenceSent && !(due && this.openChat !== null)) return
    const packed = await this.codec.packJson(body, `presence/${this.state.deviceId}`)
    await this.git.writePresence(this.state.deviceId, packed.toString('base64'))
    this.presenceSent = fingerprint
    this.presenceSentAt = this.now()
  }

  private async refreshPresence(forceList: boolean): Promise<void> {
    if (this.git === null || this.codec === null) return
    const refs = await this.git.readPresence()
    if (forceList || refs.length > 0 || this.devices.length > 0) {
      const devices: SyncDevice[] = []
      this.presenceShas = new Map(refs.map(r => [r.deviceId, r.sha]))
      for (const ref of refs) {
        try {
          const body = await this.codec.unpackJson<PresenceBody>(Buffer.from(ref.message, 'base64'), `presence/${ref.deviceId}`)
          devices.push({
            id: ref.deviceId, name: String(body.name), hostname: String(body.hostname), lastSeenAt: Number(body.at),
            openChats: Array.isArray(body.openChats) ? body.openChats.filter((c): c is string => typeof c === 'string') : [],
            isThisPc: ref.deviceId === this.state.deviceId
          })
        } catch { /* another PC's status isn't worth failing over */ }
      }
      this.devices = devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    }
  }

  // ---------------------------------------------------------------- what the UI shows

  private async localProjects(): Promise<ProjectInfo[]> {
    if (this.scanCache !== null && this.now() - this.scanCache.at < SCAN_CACHE_MS) return this.scanCache.projects
    const projects = await scanProjects(this.deps.paths)
    this.scanCache = { at: this.now(), projects }
    return projects
  }

  private async refreshGithub(): Promise<GithubState> {
    if (this.now() - this.githubAt > SCAN_CACHE_MS || this.github.state !== 'ready') {
      this.github = await this.deps.hub.status().catch(() => ({ state: 'missing' as const, account: null }))
      this.githubAt = this.now()
    }
    return this.github
  }

  async status(): Promise<SyncStatus> {
    const github = await this.refreshGithub()
    if (github.state === 'ready' && this.state.repo === null) this.discoverRepos()
    const scanned = await this.localProjects().catch(() => [] as ProjectInfo[])
    const byRoot = new Map(Object.values(this.state.projects).map(p => [normalizePath(p.root).toLowerCase(), p]))
    const rows: SyncProjectRow[] = []
    for (const info of scanned) {
      if (!info.workingDirKnown || info.worktreeOf !== null || info.projectDir === null) continue
      const p = byRoot.get(normalizePath(info.workingDir).toLowerCase())
      rows.push(this.projectRow(info.workingDir, info.sessionIds.length, info.sizeBytes, p))
    }
    for (const p of Object.values(this.state.projects)) {
      if (rows.some(r => r.projectId === p.projectId)) continue
      rows.push(this.projectRow(p.root, this.listLocalChats(p.root).length, await dirSize(this.projectDir(p.root)).catch(() => 0), p))
    }
    rows.sort((a, b) => Number(b.projectId !== null) - Number(a.projectId !== null) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    const home = homedir()
    const cloneRoot = defaultCloneRoot(scanned.filter(i => i.workingDirKnown && i.exists).map(i => i.workingDir), home)
    const remoteProjects: RemoteProject[] = [...this.catalog.values()]
      .filter(m => this.state.projects[m.projectId] === undefined)
      .map(m => ({
        projectId: m.projectId, name: m.name, github: m.github, branch: m.branch, chats: m.chats, updatedBy: m.updatedBy, updatedAt: m.updatedAt,
        unpushed: m.unpushed, uncommitted: m.uncommitted, suggestedFolder: join(cloneRoot, m.name)
      }))

    return {
      github,
      configured: this.state.repo !== null && this.codec !== null,
      repo: this.state.repo,
      encrypted: this.state.encrypted,
      auto: this.state.auto,
      deviceName: this.deviceName,
      hostname: this.deps.hostname,
      busy: this.busyCount > 0,
      activity: this.activity,
      lastSyncAt: this.state.lastSyncAt,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      repoSizeBytes: this.repoSize,
      hasRecoveryKey: this.recoveryKey() !== null,
      syncedRepos: this.state.repo !== null ? this.headerRepos() : this.discoveredSynced,
      projects: rows,
      remoteProjects,
      discoveredRepos: this.discovered,
      leftSync: this.state.leftSync === true,
      conflicts: Object.values(this.state.conflicts).map(c => ({
        ...c, sessionPk: this.deps.sessionPkOf(this.transcriptPath(this.state.projects[c.projectId]?.root ?? '', c.sessionId)) ?? c.sessionPk
      })),
      devices: this.devices
    }
  }

  private projectRow(workingDir: string, chats: number, sizeBytes: number, p: ProjectState | undefined): SyncProjectRow {
    return {
      workingDir, name: basename(workingDir), chats, sizeBytes, github: readOriginRepo(workingDir),
      projectId: p?.projectId ?? null, lastSyncAt: p?.lastSyncAt ?? null, excludedChats: p?.excludedChats.length ?? 0,
      pendingFindings: p?.pendingFindings ?? [], warnings: p?.warnings ?? []
    }
  }

  async chatInfo(sessionId: string, cwd: string | null): Promise<SyncChatInfo> {
    const st = this.state.chats[sessionId]
    const project = st === undefined ? undefined : this.state.projects[st.projectId]
    const pending = project?.pendingFindings.filter(f => f.sessionIds.includes(sessionId)).length ?? 0
    const nothing: SyncChatInfo = { synced: false, elsewhere: null, conflict: null, pendingSecrets: 0, codeNote: null }
    if (project === undefined || project.excludedChats.includes(sessionId)) {
      const root = cwd === null ? undefined : Object.values(this.state.projects).find(p => isSamePath(p.root, cwd))
      return root === undefined || root.excludedChats.includes(sessionId) ? nothing : { ...nothing, synced: true }
    }

    let elsewhere: SyncChatInfo['elsewhere'] = null
    const others = this.devices.filter(d => !d.isThisPc && d.openChats.includes(sessionId))
    const newest = others[0]
    if (newest !== undefined) {
      elsewhere = { device: newest.name, hostname: newest.hostname, lastSeenAt: newest.lastSeenAt, active: this.now() - newest.lastSeenAt < ACTIVE_WITHIN_MS }
    }

    let codeNote: string | null = null
    const meta = this.chatMeta.get(sessionId)
    if (meta !== undefined && meta.deviceId !== this.state.deviceId && meta.head !== null) {
      const here = await codeState(this.deps.run, project.root)
      if (here.head === null) codeNote = `This chat last ran on ${meta.device}, and this folder isn't a clone of that project.`
      else if (here.head !== meta.head) codeNote = `This chat last ran on ${meta.device} at commit ${meta.head.slice(0, 7)}. This folder is on ${here.head.slice(0, 7)}, so its files may differ.`
    }
    return { synced: true, elsewhere, conflict: this.state.conflicts[sessionId] ?? null, pendingSecrets: pending, codeNote }
  }

  /** Only asks GitHub if the last check is a few minutes old, such as after the PC woke from
   *  sleep, and never holds a message up for long. */
  async beforeSend(sessionId: string, cwd: string | null, waitMs: number): Promise<SyncChatInfo> {
    const info = await this.chatInfo(sessionId, cwd)
    if (!info.synced || !this.state.auto) return info
    if (this.lastCheckAt !== null && this.now() - this.lastCheckAt < STALE_CHECK_MS) return info
    const check = this.tick()
    await Promise.race([check, this.sleep(waitMs)])
    return this.chatInfo(sessionId, cwd)
  }

  /** The project relative path of a synced file, for messages. */
  relativeTo(root: string, path: string): string {
    return relative(root, path)
  }
}
