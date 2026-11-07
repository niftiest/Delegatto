import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ClaudePaths } from './paths'
import { encodePath, isSamePath, isSameOrUnder, normalizePath } from './paths'
import type { Artifact, ArtifactKind, FileRemover, ProjectInfo } from './types'
import { collectChatArtifacts, collectProjectArtifacts } from './artifacts'
import { loadClaudeJson, saveClaudeJson } from './claude-json'
import { backupClaudeState, rewriteLines } from './safe-file'
import { readClaudeJsonProjectKeys, scanProjects } from './scanner'
import type { LiveSession } from './live'

/** Deletes Claude's data for one or many projects, or for one chat (port of
 *  ClaudeMemoryTool's DeleteService, plus the Delegatto chat scope).
 *
 *  Order: live-session check (throws before any change) -> backup of
 *  .claude.json / history.jsonl (throws before any change) -> .claude.json /
 *  history.jsonl edits -> file/folder removals. Only the artifacts passed in are
 *  acted on, and only those that a fresh re-collect still attributes to that
 *  exact project/chat. A failure on one item is recorded and the rest go ahead.
 *  The working folder itself is never removed (only its `.claude\` / `CLAUDE.md`,
 *  which are optional plan items). A restore point (zip) is the caller's job. */

export type DeleteFailure = { path: string; error: string }

export type DeleteResult = {
  /** Paths acted on: removed files/folders, and .claude.json / history.jsonl when rewritten. */
  done: string[]
  failures: DeleteFailure[]
  /** Where .claude.json / history.jsonl were copied before being edited, or null. */
  backupDir: string | null
}

/** A plan row: the artifact plus how the review screen should show it. */
export type PlannedArtifact = Artifact & {
  /** A removal on a drive without a Recycle Bin (`remover.recyclable` false): gone for good. */
  permanent: boolean
  /** Ticked by default: not optional and not permanent. */
  defaultSelected: boolean
  /** For the memory folder: the project folder that physically contains it (it
   *  goes with that folder and has no check box of its own). Else null. */
  containedIn: string | null
}

export type DeleteOptions = {
  /** Copy .claude.json / history.jsonl to backups/memory-tool/<stamp> before
   *  editing them (only when an edit is selected). Default true. */
  backup?: boolean
}

export class SessionsLiveError extends Error {
  constructor(readonly sessions: LiveSession[], what = 'deleting or renaming') {
    super(`${sessions.length} Claude Code session(s) still running. Close them before ${what}.`)
    this.name = 'SessionsLiveError'
  }
}

type Collect = (p: ProjectInfo) => Promise<Artifact[]>
type Live = () => LiveSession[] | Promise<LiveSession[]>

const SHARED_EDITS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(['ClaudeJsonEntry', 'GithubRepoPath', 'HistoryLines'])
const FILE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(['Todos', 'InDirClaudeMd', 'SessionTranscript'])

/** Edits inside .claude.json / history.jsonl (everything else is removed from disk). */
export function isSharedFileEdit(k: ArtifactKind): boolean { return SHARED_EDITS.has(k) }

export class DeleteService {
  /** @param live lists running sessions (normally `() => getLiveSessions(paths)`).
   *  @param collect test seam replacing collectProjectArtifacts (used by plan and the re-check in execute). */
  constructor(
    private readonly paths: ClaudePaths,
    private readonly remover: FileRemover,
    private readonly live: Live,
    private readonly collect: Collect = p => collectProjectArtifacts(paths, p)
  ) {}

  /** Every removable item and shared-file edit for the project. Display-only
   *  children (memory\*.md files) are left out: they go with their folder. */
  async plan(p: ProjectInfo): Promise<Artifact[]> {
    return (await this.collect(p)).filter(a => a.parent === undefined)
  }

  /** `plan` annotated for the review screen (Recycle Bin vs permanent, default ticks). */
  async planForReview(p: ProjectInfo): Promise<PlannedArtifact[]> {
    return this.annotate(await this.plan(p))
  }

  /** Every item of one chat (see collectChatArtifacts), annotated for review. */
  async planChat(projectDir: string, sessionId: string): Promise<PlannedArtifact[]> {
    return this.annotate(await collectChatArtifacts(this.paths, projectDir, sessionId))
  }

  private annotate(plan: Artifact[]): PlannedArtifact[] {
    return plan.map(a => {
      const permanent = !isSharedFileEdit(a.kind) && !safeRecyclable(this.remover, a.path)
      const container = containingProjectFolder(a, plan)
      return { ...a, permanent, defaultSelected: !a.optional && !permanent, containedIn: container?.path ?? null }
    })
  }

  execute(p: ProjectInfo, selected: Artifact[], opts?: DeleteOptions): Promise<DeleteResult> {
    return this.executeMany([{ project: p, selected }], opts)
  }

  /** Several projects: one live-session check (and one backup) for the whole
   *  batch, then each project in turn. A failure in one project is reported and
   *  the rest still go ahead. Throws SessionsLiveError (nothing changed) when any
   *  session is running, or the backup error (nothing changed) when it can't back up. */
  async executeMany(batch: Array<{ project: ProjectInfo; selected: Artifact[] }>, opts: DeleteOptions = {}): Promise<DeleteResult> {
    const sessions = await this.live()
    if (sessions.length > 0) throw new SessionsLiveError(sessions)

    const backupDir = (opts.backup ?? true) && batch.some(b => b.selected.some(a => isSharedFileEdit(a.kind)))
      ? backupClaudeState(this.paths) : null

    const done: string[] = []
    const failures: DeleteFailure[] = []
    for (const { project: p, selected } of batch) {
      const editProjects = selected.some(a => a.kind === 'ClaudeJsonEntry')
      const editGithub = selected.some(a => a.kind === 'GithubRepoPath')
      const editHistory = selected.some(a => a.kind === 'HistoryLines')

      if (editProjects || editGithub) {
        await attempt(this.paths.claudeJson, () => this.editClaudeJson(p.workingDir, editProjects, editGithub), done, failures)
      }
      if (editHistory) {
        await attempt(this.paths.historyFile, () => this.editHistory(line => isProjectLine(line, p.workingDir)), done, failures)
      }
      await this.removeSelected(
        selected,
        async () => (await this.plan(p)).filter(a => !isSharedFileEdit(a.kind)),
        p.projectDir ?? p.workingDir, 'project', done, failures)
    }
    return { done, failures, backupDir }
  }

  /** Deletes one chat's data (Delegatto addition): `selected` is (a subset of)
   *  collectChatArtifacts output. Only that chat's own process must be closed --
   *  unless its history.jsonl lines are selected, then every session must be
   *  (a running CLI appends to that shared file). History lines are matched by
   *  sessionId; project-level data is never touched. */
  async executeChat(projectDir: string, sessionId: string, selected: Artifact[], opts: DeleteOptions = {}): Promise<DeleteResult> {
    const editHistory = selected.some(a => a.kind === 'HistoryLines')
    const sessions = await this.live()
    const blocking = editHistory ? sessions : sessions.filter(s => s.sessionId.toLowerCase() === sessionId.toLowerCase())
    if (blocking.length > 0) throw new SessionsLiveError(blocking, 'deleting this chat')

    const backupDir = editHistory && (opts.backup ?? true) ? backupClaudeState(this.paths) : null
    const done: string[] = []
    const failures: DeleteFailure[] = []
    if (editHistory) {
      await attempt(this.paths.historyFile, () => this.editHistory(line => isSessionLine(line, sessionId)), done, failures)
    }
    // Chat scope never edits .claude.json; such rows are refused by the re-check.
    const unexpected = selected.filter(a => a.kind === 'ClaudeJsonEntry' || a.kind === 'GithubRepoPath')
    for (const a of unexpected) failures.push({ path: a.path, error: "Skipped: a chat delete never edits .claude.json." })
    await this.removeSelected(
      selected,
      async () => (await collectChatArtifacts(this.paths, projectDir, sessionId)).filter(a => !isSharedFileEdit(a.kind)),
      projectDir, 'chat', done, failures)
    return { done, failures, backupDir }
  }

  private async removeSelected(
    selected: Artifact[],
    recollect: () => Promise<Artifact[]>,
    scopePath: string,
    scope: 'project' | 'chat',
    done: string[],
    failures: DeleteFailure[]
  ): Promise<void> {
    // Folders shared by same-encoded twins in one batch are removed once, by the
    // first project (with everything inside them, such as the memory folder).
    const seen = new Set<string>()
    const removals = selected
      .filter(a => !isSharedFileEdit(a.kind) && a.parent === undefined)
      .filter(a => !done.some(d => isSameOrUnder(a.path, d)))
      .filter(a => { const k = key(a); if (seen.has(k)) return false; seen.add(k); return true })
    if (removals.length === 0) return

    // Re-collect now: only remove what still belongs to this exact project/chat
    // (guards stale or foreign selections). This runs after the .claude.json /
    // history.jsonl edits, so a failure here must not lose that result.
    let current: Set<string>
    try {
      current = new Set((await recollect()).map(key))
    } catch (e) {
      failures.push({ path: scopePath, error: `Could not re-check ${scope} data: ${errorText(e)}; nothing further was removed.` })
      return
    }

    const projectFolder = removals.find(a => a.kind === 'ProjectFolder' && current.has(key(a)))
    for (const a of removals) {
      if (!current.has(key(a))) {
        failures.push({ path: a.path, error: `Skipped: no longer part of this ${scope}'s data.` })
        continue
      }
      if (a.kind === 'Memory' && projectFolder !== undefined && isSameOrUnder(a.path, projectFolder.path)) continue // goes with the project folder
      await attempt(a.path, async () => {
        if (FILE_KINDS.has(a.kind)) await this.remover.removeFile(a.path)
        else await this.remover.removeDirectory(a.path)
        return true
      }, done, failures)
    }
  }

  /** @returns true when the file was rewritten. */
  private editClaudeJson(workingDir: string, editProjects: boolean, editGithub: boolean): boolean {
    const file = loadClaudeJson(this.paths.claudeJson)
    const root = file.root
    let changed = false
    const projects = root.projects
    if (editProjects && isObject(projects)) {
      for (const k of Object.keys(projects)) {
        if (isSamePath(k, workingDir)) { delete projects[k]; changed = true }
      }
    }
    const repos = root.githubRepoPaths
    if (editGithub && isObject(repos)) {
      for (const [repo, value] of Object.entries(repos)) {
        if (!Array.isArray(value)) continue
        const kept = value.filter(v => !(typeof v === 'string' && isSamePath(v, workingDir)))
        if (kept.length === value.length) continue
        if (kept.length === 0) delete repos[repo]
        else repos[repo] = kept
        changed = true
      }
    }
    if (!changed) return false
    saveClaudeJson(this.paths.claudeJson, file)
    return true
  }

  private editHistory(drop: (line: string) => boolean): boolean {
    rewriteLines(this.paths.historyFile, line => drop(line) ? null : line, true)
    return true
  }
}

/** The project-folder entry of `plan` that physically contains `a` (the memory
 *  folder lives inside the project folder and is removed with it), or undefined. */
export function containingProjectFolder(a: Artifact, plan: Artifact[]): Artifact | undefined {
  return a.kind === 'Memory'
    ? plan.find(f => f.kind === 'ProjectFolder' && isSameOrUnder(a.path, f.path))
    : undefined
}

/** Other known working dirs (scanned projects, .claude.json keys, history.jsonl
 *  projects) whose encoded folder name equals this project's, e.g. D:\GIT\X.com
 *  and D:\GIT\X-com. They share projects\<encoded> and the temp folder, so
 *  deleting those folders removes their data too.
 *  @param known already-scanned projects; omitted => scans again. */
export async function sharedFolderOwners(paths: ClaudePaths, project: ProjectInfo, known?: ProjectInfo[]): Promise<string[]> {
  const result: string[] = []
  if (!project.workingDirKnown) return result
  const enc = encodePath(normalizePath(project.workingDir)).toLowerCase()
  const candidates = [
    ...(known ?? await scanProjects(paths)).filter(p => p.workingDirKnown).map(p => p.workingDir),
    ...readClaudeJsonProjectKeys(paths),
    ...await readHistoryProjects(paths)
  ]
  for (const c of candidates) {
    if (!c) continue
    const n = normalizePath(c)
    if (isSamePath(n, project.workingDir)) continue
    if (encodePath(n).toLowerCase() !== enc) continue
    if (!result.some(r => isSamePath(r, n))) result.push(n)
  }
  return result
}

async function readHistoryProjects(paths: ClaudePaths): Promise<string[]> {
  const result: string[] = []
  if (!existsSync(paths.historyFile)) return result
  const rl = createInterface({ input: createReadStream(paths.historyFile), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const o = parseObject(line)
      if (o !== null && typeof o.project === 'string') result.push(o.project)
    }
  } catch { /* unreadable */ }
  return result
}

/** A history.jsonl line whose `project` is `workingDir` (malformed lines never match). */
export function isProjectLine(line: string, workingDir: string): boolean {
  const o = parseObject(line)
  return o !== null && typeof o.project === 'string' && isSamePath(o.project, workingDir)
}

/** A history.jsonl line recorded by chat `sessionId` (malformed lines never match). */
export function isSessionLine(line: string, sessionId: string): boolean {
  const o = parseObject(line)
  return o !== null && typeof o.sessionId === 'string' && o.sessionId.toLowerCase() === sessionId.toLowerCase()
}

function parseObject(line: string): Record<string, unknown> | null {
  if (line.length === 0) return null
  try {
    const v = JSON.parse(line) as unknown
    return isObject(v) ? v : null
  } catch { return null }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function key(a: Artifact): string {
  return `${a.kind}|${normalizePath(a.path).toUpperCase()}`
}

function safeRecyclable(r: FileRemover, path: string): boolean {
  try { return r.recyclable(path) } catch { return false }
}

async function attempt(path: string, action: () => boolean | Promise<boolean>, done: string[], failures: DeleteFailure[]): Promise<void> {
  try {
    if (await action()) done.push(path)
  } catch (e) {
    failures.push({ path, error: errorText(e) })
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
