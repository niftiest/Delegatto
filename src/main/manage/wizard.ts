import { dirname } from 'node:path'
import type { Catalog } from '../catalog/db'
import { removeChatFromCatalog, removeProjectFromCatalog } from '../delete-channel'
import type { ClaudePaths } from './paths'
import { isSamePath } from './paths'
import { scanProject, scanProjects } from './scanner'
import { DeleteService, SessionsLiveError, isSharedFileEdit, sharedFolderOwners, type PlannedArtifact } from './delete'
import type { LiveSession } from './live'
import type { TerminateResult } from './terminate'
import { ArchiveService, RestorePointError } from './archive'
import type { Artifact, FileRemover, ProjectInfo } from './types'
import type {
  DeleteOutcome, DeletePlan, DeleteTarget, EndSessionsResult, SessionCheck, WizardItem, WizardProcess
} from '../../shared/manage-types'

/** The Delete wizard's main-process logic (chat / project / several projects),
 *  electron-free so it runs against a fake ~/.claude in tests. manage-ipc.ts
 *  injects the Recycle Bin remover, Delegatto's own process pool and the
 *  start-time-verified terminator. */

export type ManageDeps = {
  paths: ClaudePaths
  getRemover: () => Promise<FileRemover>
  /** Every running Claude Code session (normally getLiveSessions(paths)). */
  live: () => LiveSession[]
  /** Session ids of Delegatto's own pooled processes. */
  ownedSessionIds: () => string[]
  /** Close Delegatto's own processes gracefully (never the terminator). */
  stopOwned: (sessionIds: string[]) => void
  /** Ends other processes (normally terminate.ts endAll, start-time verified). */
  endExternal: (sessions: LiveSession[]) => Promise<TerminateResult>
  /** The Manage screen's last project scan, when there is one (saves a rescan). */
  knownProjects?: () => ProjectInfo[] | null
}

export function processView(deps: Pick<ManageDeps, 'ownedSessionIds'>): (s: LiveSession) => WizardProcess {
  const owned = new Set(deps.ownedSessionIds().map(id => id.toLowerCase()))
  return s => ({
    pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name,
    owner: s.sessionId !== '' && owned.has(s.sessionId.toLowerCase()) ? 'app' : 'external'
  })
}

/** Delegatto's own processes close gracefully through the pool; anything
 *  else goes through the start-time-verified terminator. */
export async function endSessions(deps: ManageDeps, pids: number[]): Promise<EndSessionsResult> {
  const wanted = deps.live().filter(s => pids.includes(s.pid))
  const ownedIds = new Set(deps.ownedSessionIds().map(id => id.toLowerCase()))
  const own = wanted.filter(s => s.sessionId !== '' && ownedIds.has(s.sessionId.toLowerCase()))
  const others = wanted.filter(s => !own.includes(s))
  const ended: number[] = []
  if (own.length > 0) {
    deps.stopOwned(own.map(s => s.sessionId))
    ended.push(...own.map(s => s.pid))
  }
  const failures: EndSessionsResult['failures'] = []
  if (others.length > 0) {
    const r = await deps.endExternal(others)
    ended.push(...r.ended.map(s => s.pid))
    failures.push(...r.failures.map(f => ({ pid: f.session.pid, error: f.error })))
  }
  return { ended, failures }
}

function itemKey(a: { kind: string; path: string; description: string }): string {
  return `${a.kind}\u0000${a.path}\u0000${a.description}`
}

function toItem(a: PlannedArtifact, key: string, group: string | null): WizardItem {
  return {
    key, path: a.path, kind: a.kind, description: a.description, sizeBytes: a.sizeBytes,
    optional: a.optional, permanent: a.permanent, defaultSelected: a.defaultSelected,
    containedIn: a.containedIn, sharedEdit: isSharedFileEdit(a.kind), group
  }
}

type Resolved =
  | { kind: 'chat'; project: ProjectInfo; projectDir: string; sessionId: string; title: string; sessionPk: number }
  | { kind: 'projects'; projects: ProjectInfo[]; title: string; missing: string[] }

/** A projects-folder name the renderer sent: one plain path segment. */
function validDirName(n: unknown): n is string {
  return typeof n === 'string' && n.length > 0 && !/[\\/:]/.test(n) && n !== '.' && n !== '..'
}

export class DeleteWizard {
  constructor(private readonly db: Catalog, private readonly deps: ManageDeps) {}

  private view(): (s: LiveSession) => WizardProcess { return processView(this.deps) }

  private async resolve(target: DeleteTarget): Promise<Resolved> {
    const paths = this.deps.paths
    if (target.scope === 'chat') {
      const row = this.db.prepare(`
        SELECT s.file_path AS filePath, s.session_id AS sessionId, s.title AS title, p.dir_name AS dirName
        FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
      `).get(target.sessionPk) as { filePath: string; sessionId: string; title: string | null; dirName: string } | undefined
      if (row === undefined) throw new Error('That chat is no longer in the catalog.')
      const project = await scanProject(paths, row.dirName)
      if (project === null) throw new Error("That chat's project folder no longer exists.")
      const name = row.title ?? row.sessionId.slice(0, 8)
      return { kind: 'chat', project, projectDir: dirname(row.filePath), sessionId: row.sessionId, sessionPk: target.sessionPk,
        title: `Delete chat “${name.length > 60 ? name.slice(0, 57) + '…' : name}”` }
    }
    if (target.scope === 'project') {
      if (!validDirName(target.dirName)) throw new Error('That is not a project folder name.')
      const project = await scanProject(paths, target.dirName)
      if (project === null) throw new Error('That project folder no longer exists.')
      return { kind: 'projects', projects: [project], missing: [], title: `Delete project ${project.workingDir}` }
    }
    const names = Array.isArray(target.dirNames) ? target.dirNames : []
    if (names.length === 0) throw new Error('No projects were selected.')
    const projects: ProjectInfo[] = []
    const missing: string[] = []
    let all: ProjectInfo[] | null = null
    for (const n of names) {
      let p: ProjectInfo | null | undefined
      if (typeof n === 'string' && /[\\:]/.test(n)) {
        // A .claude.json-only project: by its working dir (exact, no folder).
        all ??= this.deps.knownProjects?.() ?? await scanProjects(paths)
        p = all.find(x => x.projectDir === null && isSamePath(x.workingDir, n))
          ?? (await scanProjects(paths)).find(x => x.projectDir === null && isSamePath(x.workingDir, n))
      } else if (validDirName(n)) {
        p = await scanProject(paths, n)
      } else {
        throw new Error(`Not a project: ${String(n)}`)
      }
      if (p === null || p === undefined) { missing.push(String(n)); continue }
      if (!projects.some(x => isSamePath(x.workingDir, p!.workingDir) && x.projectDir === p!.projectDir)) projects.push(p)
    }
    if (projects.length === 0) throw new Error('None of the selected projects exist any more.')
    return {
      kind: 'projects', projects, missing,
      title: projects.length === 1 ? `Delete project ${projects[0]!.workingDir}` : `Delete ${projects.length} projects`
    }
  }

  private sessionCheck(r: Resolved): SessionCheck {
    const all = this.deps.live()
    const view = this.view()
    const mine = r.kind === 'chat'
      ? all.filter(s => s.sessionId.toLowerCase() === r.sessionId.toLowerCase())
      : all.filter(s => r.projects.some(p => p.sessionIds.some(id => id.toLowerCase() === s.sessionId.toLowerCase())))
    return { blocking: mine.map(view), allLive: all.map(view) }
  }

  private service(remover: FileRemover): DeleteService {
    return new DeleteService(this.deps.paths, remover, this.deps.live)
  }

  /** Every project's annotated plan, keyed for the review list. A single
   *  project keeps the plain key (as before); several get an index prefix so
   *  identical paths (history.jsonl, .claude.json) stay distinct per project. */
  private async planProjects(svc: DeleteService, projects: ProjectInfo[]): Promise<Array<{ project: ProjectInfo; rows: Array<{ key: string; a: PlannedArtifact }> }>> {
    const out: Array<{ project: ProjectInfo; rows: Array<{ key: string; a: PlannedArtifact }> }> = []
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i]!
      const planned = await svc.planForReview(project)
      out.push({ project, rows: planned.map(a => ({ key: projects.length === 1 ? itemKey(a) : `${i}\u0001${itemKey(a)}`, a })) })
    }
    return out
  }

  async plan(target: DeleteTarget): Promise<DeletePlan> {
    const r = await this.resolve(target)
    const svc = this.service(await this.deps.getRemover())
    const check = this.sessionCheck(r)
    if (r.kind === 'chat') {
      const planned = await svc.planChat(r.projectDir, r.sessionId)
      return {
        target, title: r.title, workingDir: r.project.workingDir,
        items: planned.map(a => toItem(a, itemKey(a), null)), ...check,
        restorePointBytes: r.project.sizeBytes, warnings: []
      }
    }
    const multi = r.projects.length > 1
    const plans = await this.planProjects(svc, r.projects)
    const warnings: string[] = []
    const known = this.deps.knownProjects?.() ?? undefined
    for (const p of r.projects) {
      const twins = await sharedFolderOwners(this.deps.paths, p, known)
      if (twins.length > 0) {
        warnings.push(`Claude stores ${twins.join(', ')} under the same folder name as ${p.workingDir} (${p.encodedName}). ` +
          'Their chat logs and memory in the project and temp folders would be removed too. Untick those folders to keep them.')
      }
    }
    const empty = plans.filter(x => x.rows.length === 0).map(x => x.project.workingDir)
    if (empty.length > 0) warnings.push(`No Claude data found for: ${empty.join(', ')}`)
    if (r.missing.length > 0) warnings.push(`No longer there (skipped): ${r.missing.join(', ')}`)
    return {
      target, title: r.title,
      workingDir: multi ? r.projects.map(p => p.workingDir).join(' · ') : r.projects[0]!.workingDir,
      items: plans.flatMap(x => x.rows.map(({ key, a }) => toItem(a, key, multi ? x.project.workingDir : null))),
      ...check,
      restorePointBytes: r.projects.reduce((s, p) => s + p.sizeBytes, 0),
      warnings
    }
  }

  async check(target: DeleteTarget): Promise<SessionCheck> {
    return this.sessionCheck(await this.resolve(target))
  }

  async execute(target: DeleteTarget, selectedKeys: string[], restorePoint: boolean): Promise<DeleteOutcome> {
    const view = this.view()
    try {
      const r = await this.resolve(target)
      const svc = this.service(await this.deps.getRemover())
      const keys = new Set(selectedKeys)

      // Re-collect now and act only on what is still there AND was ticked.
      let batch: Array<{ project: ProjectInfo; selected: Artifact[] }>
      let chatSelected: Artifact[] = []
      if (r.kind === 'chat') {
        chatSelected = (await svc.planChat(r.projectDir, r.sessionId)).filter(a => keys.has(itemKey(a)))
        batch = []
        if (chatSelected.length === 0) return { ok: false, error: 'Nothing was selected.' }
      } else {
        batch = (await this.planProjects(svc, r.projects))
          .map(x => ({ project: x.project, selected: x.rows.filter(row => keys.has(row.key)).map(row => row.a as Artifact) }))
          .filter(b => b.selected.length > 0)
        if (batch.length === 0) return { ok: false, error: 'Nothing was selected.' }
      }

      // Refuse before making a restore point if the delete would refuse anyway.
      const check = this.sessionCheck(r)
      const needsAll = r.kind === 'projects' || chatSelected.some(a => a.kind === 'HistoryLines')
      const blocking = needsAll ? check.allLive : check.blocking
      if (blocking.length > 0) {
        return { ok: false, error: `${blocking.length} Claude Code session(s) still running. Close them first.`, sessions: blocking }
      }

      let zip: string | null = null
      if (restorePoint) {
        try {
          zip = await new ArchiveService(this.deps.paths).createRestorePoint(r.kind === 'chat' ? [r.project] : batch.map(b => b.project))
        } catch (err) {
          const detail = err instanceof RestorePointError ? err.failures.map(f => `${f.path}: ${f.error}`).join('; ') : String(err)
          return { ok: false, error: `The restore point could not be saved, so nothing was deleted. ${detail}` }
        }
      }

      const result = r.kind === 'chat'
        ? await svc.executeChat(r.projectDir, r.sessionId, chatSelected)
        : await svc.executeMany(batch)

      // Catalog follows the files: drop the rows only when the data they index is gone.
      if (r.kind === 'chat') {
        const transcript = chatSelected.find(a => a.kind === 'SessionTranscript')
        if (transcript !== undefined && result.done.includes(transcript.path)) removeChatFromCatalog(this.db, r.sessionPk)
      } else {
        for (const b of batch) {
          const folder = b.selected.find(a => a.kind === 'ProjectFolder')
          if (folder !== undefined && result.done.includes(folder.path)) removeProjectFromCatalog(this.db, b.project.encodedName)
        }
      }
      return { ok: true, done: result.done, failures: result.failures, backupDir: result.backupDir, restorePoint: zip }
    } catch (err) {
      if (err instanceof SessionsLiveError) {
        return { ok: false, error: err.message, sessions: err.sessions.map(view) }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
