import { existsSync, promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isSamePath, isSameOrUnder, normalizePath } from './paths'
import { scanProjects } from './scanner'
import { collectProjectArtifacts } from './artifacts'
import { isSharedFileEdit, SessionsLiveError } from './delete'
import { ArchiveService, readManifest } from './archive'
import { RenameRefusedError, RenameService, type RenamePlan } from './rename'
import { matchPlaces, searchContent } from './search'
import { MAX_NOTE_BYTES, NoteIndex, oneDriveCloudCheck, type CloudOnlyCheck, type NoteFile, type NoteHit } from './notes'
import type { ProjectInfo } from './types'
import { processView, type ManageDeps } from './wizard'
import type {
  ArchiveSummary, ContentSearchEvent, DetailRow, ManageResult, NoteHitRow, NotePreview, NoteRow, NoteSearchResult,
  NotesIndex, ProjectRow, RenameExecuteResult, RenamePlanView, RestorePointRow, WizardProcess
} from '../../shared/manage-types'

/** Main-process logic behind the Manage screen (Projects / Notes / Restore
 *  points / Live sessions), electron-free: manage-ipc.ts adds the native
 *  dialogs, the shell (open / show in folder) and the catalog re-sync.
 *
 *  Keeps the last project scan and notes index, so an action names its
 *  project/note by path and is checked against what was actually listed --
 *  the renderer can never make it touch a file the screen didn't show. */

export type ControllerHooks = {
  /** Claude data changed on disk (rename / import / restore / delete): re-sync the catalog. */
  changed?: () => void | Promise<void>
  /** Encoded projects-folder names that a rename moved (old -> new). */
  projectFoldersRenamed?: (pairs: Array<{ from: string; to: string }>) => void
}

export type ControllerOptions = {
  /** Test seam for NoteIndex (defaults to the OneDrive attribute check). */
  cloudOnly?: CloudOnlyCheck
  systemFolders?: readonly string[]
  maxDirsPerProject?: number
}

const PREVIEW_CLOUD = '(Online-only file — not downloaded for preview or search. Double-click to open it.)'

export function toProjectRow(p: ProjectInfo): ProjectRow {
  return {
    workingDir: p.workingDir, workingDirKnown: p.workingDirKnown, encodedName: p.encodedName, projectDir: p.projectDir,
    sessions: p.sessionIds.length, lastUsed: p.lastUsed, sizeBytes: p.sizeBytes, exists: p.exists, worktreeOf: p.worktreeOf
  }
}

function toNoteRow(n: NoteFile): NoteRow {
  return { path: n.path, workingDir: n.workingDir, relativePath: n.relativePath, modified: n.modified, sizeBytes: n.sizeBytes, cloudOnly: n.cloudOnly }
}

function toHitRow(h: NoteHit): NoteHitRow {
  return { ...toNoteRow(h.note), matchCount: h.matchCount, firstLineNumber: h.firstLineNumber, firstLineText: h.firstLineText, nameMatch: h.nameMatch }
}

function message(e: unknown): string { return e instanceof Error ? e.message : String(e) }

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

function formatSizeShort(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`
  return `${n} B`
}

/** The C# RenameForm.Describe lines. */
export function describeRename(p: RenamePlan): string[] {
  const lines = [
    `${p.oldDir}  →  ${p.newDir}`,
    p.moveWorkingFolder ? 'Move the working folder on disk' : 'Working folder not moved (old folder does not exist)',
    `Rewrite ${p.jsonlFiles.length} session log file(s)`,
    `Rename ${p.dirRenames.length} encoded project/temp folder(s)`,
    `Re-key ${p.claudeJsonKeys} .claude.json project entr${p.claudeJsonKeys === 1 ? 'y' : 'ies'}`,
    `Rewrite ${p.historyLines} history.jsonl line(s)`,
    `Rewrite ${p.jobFiles.length} background job file(s)`
  ]
  if (!p.moveWorkingFolder && existsSync(p.newDir)) lines.push('Resuming an earlier rename: the folder is already at the new path.')
  return lines
}

function planView(p: RenamePlan): RenamePlanView {
  const lines = describeRename(p)
  return { oldDir: p.oldDir, newDir: p.newDir, lines, warning: p.warning, signature: JSON.stringify([lines, p.warning]) }
}

export class ManageController {
  private projects: ProjectInfo[] | null = null
  private scanning: Promise<ProjectInfo[]> | null = null
  private notes: NoteFile[] | null = null
  private truncated: string[] = []
  private scanMs = 0
  private notesFor: ProjectInfo[] | null = null
  private notesBuild: Promise<void> | null = null
  private readonly searches = new Map<number, AbortController>()
  private noteSearch: AbortController | null = null
  private readonly index: NoteIndex
  private readonly cloudOnly: CloudOnlyCheck

  constructor(private readonly deps: ManageDeps, private readonly hooks: ControllerHooks = {}, opts: ControllerOptions = {}) {
    this.cloudOnly = opts.cloudOnly ?? oneDriveCloudCheck()
    this.index = new NoteIndex(deps.paths, {
      cloudOnly: this.cloudOnly, systemFolders: opts.systemFolders, maxDirsPerProject: opts.maxDirsPerProject
    })
  }

  /** The last scan (the Delete wizard uses it for its twin-folder check). */
  known(): ProjectInfo[] | null { return this.projects }

  private view(): (s: { pid: number; sessionId: string; cwd: string; name: string | null; procStart: string | null }) => WizardProcess {
    return processView(this.deps)
  }

  // ------------------------------------------------------------ projects

  async listProjects(): Promise<ProjectRow[]> {
    // Concurrent callers share one walk.
    const run = this.scanning ?? (this.scanning = scanProjects(this.deps.paths).finally(() => { this.scanning = null }))
    const result = await run
    this.projects = result
    return result.map(toProjectRow)
  }

  private async ensureProjects(): Promise<ProjectInfo[]> {
    if (this.projects === null) await this.listProjects()
    return this.projects!
  }

  private async project(workingDir: string): Promise<ProjectInfo> {
    const found = (await this.ensureProjects()).find(p => p.workingDir === workingDir)
      ?? (await this.ensureProjects()).find(p => isSamePath(p.workingDir, workingDir))
    if (found === undefined) throw new Error(`Not a listed project: ${workingDir}`)
    return found
  }

  async projectDetail(workingDir: string): Promise<DetailRow[]> {
    const p = await this.project(workingDir)
    const items = await collectProjectArtifacts(this.deps.paths, p)
    return items.map(a => ({
      kind: a.kind, path: a.path, description: a.description, sizeBytes: a.sizeBytes, optional: a.optional,
      child: a.parent !== undefined,
      editable: a.parent !== undefined && a.kind === 'Memory' && a.path.toLowerCase().endsWith('.md'),
      sharedEdit: isSharedFileEdit(a.kind)
    }))
  }

  /** Memory + chat content search over the last scan. Emits matches as found,
   *  then exactly one `done` / `error` (nothing after a cancel). */
  startSearch(id: number, query: string, emit: (e: ContentSearchEvent) => void): void {
    this.cancelAllSearches()
    const ac = new AbortController()
    this.searches.set(id, ac)
    const q = query.trim()
    void (async () => {
      try {
        const projects = await this.ensureProjects()
        if (ac.signal.aborted) return
        await searchContent(projects, q, (workingDir, src) => {
          if (!ac.signal.aborted) emit({ id, type: 'match', workingDir, places: matchPlaces(src) })
        }, ac.signal)
        if (!ac.signal.aborted) emit({ id, type: 'done' })
      } catch (e) {
        if (!ac.signal.aborted && !isAbort(e)) emit({ id, type: 'error', error: message(e) })
      } finally {
        if (this.searches.get(id) === ac) this.searches.delete(id)
      }
    })()
  }

  cancelSearch(id: number): void {
    this.searches.get(id)?.abort()
    this.searches.delete(id)
  }

  /** A background search must not keep reading files a change is about to move or rewrite. */
  cancelAllSearches(): void {
    for (const ac of this.searches.values()) ac.abort()
    this.searches.clear()
    this.noteSearch?.abort()
    this.noteSearch = null
  }

  async exportProjects(workingDirs: string[], zipPath: string): Promise<ManageResult> {
    try {
      const list: ProjectInfo[] = []
      for (const wd of workingDirs) list.push(await this.project(wd))
      if (list.length === 0) return { kind: 'error', error: 'No projects were selected.' }
      const r = await new ArchiveService(this.deps.paths).exportProjects(list, zipPath)
      return { kind: 'done', done: r.done, failures: r.failures, backupDir: null, zip: zipPath }
    } catch (e) {
      return { kind: 'error', error: message(e) }
    }
  }

  /** Default file name for an export of these projects (the C# naming). */
  exportName(workingDirs: string[], now = new Date()): string {
    let name = workingDirs.length === 1 ? basename(workingDirs[0]!.replace(/[\\/]+$/, '')) : `${workingDirs.length}-projects`
    if (name.trim() === '' || /["<>|:*?\\/\x00-\x1f]/.test(name)) name = 'project'
    return `claude-${name}-${stamp(now)}.zip`
  }

  async readArchive(zipPath: string): Promise<ArchiveSummary> {
    const m = await readManifest(zipPath)
    return {
      kind: m.kind, created: m.createdUtc.getTime(), machine: m.machine,
      projects: m.projects.map(p => ({ workingDir: p.workingDir, files: p.files, historyLines: p.historyLines })),
      notes: m.notes.map(n => n.path)
    }
  }

  /** Import / Restore. A projects export refuses while any session runs
   *  (ArchiveService checks right before its first change). */
  async importArchive(zipPath: string): Promise<ManageResult> {
    this.cancelAllSearches()
    try {
      const r = await new ArchiveService(this.deps.paths).import(zipPath, () => this.deps.live())
      await this.afterChange()
      return { kind: 'done', done: r.done, failures: r.failures, backupDir: r.backupDir }
    } catch (e) {
      if (e instanceof SessionsLiveError) {
        const view = this.view()
        return { kind: 'sessions', error: e.message + ' Nothing was changed.', sessions: e.sessions.map(view) }
      }
      // Something may already be restored: re-sync either way.
      await this.afterChange()
      return { kind: 'error', error: message(e) }
    }
  }

  async renamePlan(oldDir: string, newDir: string): Promise<{ ok: true; plan: RenamePlanView } | { ok: false; error: string }> {
    try {
      const p = await this.project(oldDir)
      if (!p.workingDirKnown) return { ok: false, error: "This project's real path is unknown, so it can't be renamed." }
      const plan = await new RenameService(this.deps.paths, () => this.deps.live()).plan(p.workingDir, newDir.trim())
      return { ok: true, plan: planView(plan) }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  /** Re-plans (state may have changed since the preview); runs only when the
   *  plan is exactly what the user saw, else returns the new plan. */
  async renameExecute(oldDir: string, newDir: string, signature: string): Promise<RenameExecuteResult> {
    let plan: RenamePlan
    try {
      const p = await this.project(oldDir)
      if (!p.workingDirKnown) return { kind: 'error', error: "This project's real path is unknown, so it can't be renamed." }
      plan = await new RenameService(this.deps.paths, () => this.deps.live()).plan(p.workingDir, newDir.trim())
    } catch (e) {
      return { kind: 'error', error: (e instanceof RenameRefusedError ? 'Cannot rename: ' : '') + message(e) }
    }
    const v = planView(plan)
    if (v.signature !== signature) return { kind: 'changed', plan: v }

    this.cancelAllSearches()
    try {
      const r = await new RenameService(this.deps.paths, () => this.deps.live()).execute(plan)
      const projectsDir = normalizePath(this.deps.paths.projectsDir)
      const moved = plan.dirRenames
        .filter(d => isSamePath(dirname(d.from), projectsDir) && !existsSync(d.from) && existsSync(d.to))
        .map(d => ({ from: basename(d.from), to: basename(d.to) }))
      if (moved.length > 0) this.hooks.projectFoldersRenamed?.(moved)
      await this.afterChange()
      return { kind: 'done', done: r.done, failures: r.failures, backupDir: r.backupDir }
    } catch (e) {
      if (e instanceof SessionsLiveError) {
        const view = this.view()
        return { kind: 'sessions', error: e.message + ' Nothing was changed.', sessions: e.sessions.map(view) }
      }
      return { kind: 'error', error: message(e) }
    }
  }

  // ------------------------------------------------------------ restore points

  async listRestorePoints(): Promise<RestorePointRow[]> {
    const list = await new ArchiveService(this.deps.paths).listRestorePoints()
    return list.map(r => ({ path: r.path, created: r.created.getTime(), projects: r.projects, sizeBytes: r.sizeBytes, error: r.error }))
  }

  async deleteRestorePoints(paths: string[]): Promise<ManageResult> {
    try {
      // ArchiveService refuses anything that isn't a .zip directly in the restore-points folder.
      const r = await new ArchiveService(this.deps.paths).deleteRestorePoints(paths, await this.deps.getRemover())
      return { kind: 'done', done: r.done, failures: r.failures, backupDir: null }
    } catch (e) {
      return { kind: 'error', error: message(e) }
    }
  }

  // ------------------------------------------------------------ notes

  /** The notes index, rebuilt when asked, on first use, or after a project rescan. */
  async findNotes(rescan: boolean): Promise<NotesIndex> {
    const projects = await this.ensureProjects()
    if (rescan || this.notes === null || this.notesFor !== projects) {
      if (this.notesBuild === null || rescan) {
        const build = (async () => {
          this.noteSearch?.abort()
          const t0 = Date.now()
          const r = await this.index.findNotes(projects)
          this.notes = r.notes
          this.truncated = r.truncated
          this.scanMs = Date.now() - t0
          this.notesFor = projects
        })()
        this.notesBuild = build
        try { await build } finally { if (this.notesBuild === build) this.notesBuild = null }
      } else {
        await this.notesBuild
      }
    }
    return { notes: (this.notes ?? []).map(toNoteRow), truncated: this.truncated, scanMs: this.scanMs }
  }

  async searchNotes(query: string): Promise<NoteSearchResult> {
    this.noteSearch?.abort()
    const ac = new AbortController()
    this.noteSearch = ac
    try {
      if (this.notes === null) await this.findNotes(false)
      const t0 = Date.now()
      const hits = await this.index.search(this.notes ?? [], query, undefined, ac.signal)
      if (ac.signal.aborted) return { ok: false, cancelled: true }
      // Empty query: every note, newest first.
      if (query.trim() === '') hits.sort((a, b) => b.note.modified - a.note.modified)
      return { ok: true, hits: hits.map(toHitRow), searchMs: Date.now() - t0 }
    } catch (e) {
      if (ac.signal.aborted || isAbort(e)) return { ok: false, cancelled: true }
      throw e
    } finally {
      if (this.noteSearch === ac) this.noteSearch = null
    }
  }

  private knownNotes(paths: string[]): NoteFile[] {
    const byPath = new Map((this.notes ?? []).map(n => [n.path.toLowerCase(), n]))
    const out: NoteFile[] = []
    for (const p of paths) {
      const n = typeof p === 'string' ? byPath.get(p.toLowerCase()) : undefined
      if (n !== undefined && !out.includes(n)) out.push(n)
    }
    return out
  }

  /** Recycle Bin. Only notes of the current index; refused paths are reported. */
  async deleteNotes(paths: string[]): Promise<ManageResult> {
    this.noteSearch?.abort()
    try {
      const notes = this.knownNotes(paths)
      const unknown = paths.filter(p => !notes.some(n => n.path.toLowerCase() === String(p).toLowerCase()))
      const r = await NoteIndex.deleteNotes(notes, await this.deps.getRemover())
      const gone = new Set(r.done.map(d => d.toLowerCase()))
      if (this.notes !== null) this.notes = this.notes.filter(n => !gone.has(n.path.toLowerCase()))
      return {
        kind: 'done', done: r.done, backupDir: null,
        failures: [...r.failures, ...unknown.map(p => ({ path: String(p), error: 'Not a listed note; not deleted.' }))]
      }
    } catch (e) {
      return { kind: 'error', error: message(e) }
    }
  }

  async exportNotes(paths: string[], zipPath: string): Promise<ManageResult> {
    try {
      const notes = this.knownNotes(paths)
      if (notes.length === 0) return { kind: 'error', error: 'No listed notes were selected.' }
      const r = await new ArchiveService(this.deps.paths).exportNotes(notes, zipPath)
      return { kind: 'done', done: r.done, failures: r.failures, backupDir: null, zip: zipPath }
    } catch (e) {
      return { kind: 'error', error: message(e) }
    }
  }

  notesExportName(now = new Date()): string { return `claude-notes-${stamp(now)}.zip` }

  /** The note's text (size-capped, never a cloud-only file). */
  async previewNote(path: string): Promise<NotePreview> {
    const n = this.knownNotes([path])[0]
    if (n === undefined) return { kind: 'message', text: '(Not a listed note.)' }
    try {
      // Re-check now: OneDrive may have freed the file, or it may have grown, since the scan.
      if (n.cloudOnly) return { kind: 'message', text: PREVIEW_CLOUD }
      const st = await fsp.stat(n.path)
      if (st.size > MAX_NOTE_BYTES) {
        return { kind: 'message', text: `(File is ${formatSizeShort(st.size)} — too large to preview. Double-click to open it.)` }
      }
      let cloud: Set<string>
      try { cloud = await this.cloudOnly([n.path]) } catch { cloud = new Set([n.path]) }
      if (cloud.has(n.path)) return { kind: 'message', text: PREVIEW_CLOUD }
      let text = (await fsp.readFile(n.path)).toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      return { kind: 'text', text: text.replace(/\r\n/g, '\n') }
    } catch (e) {
      return { kind: 'message', text: 'Could not show this file: ' + message(e) }
    }
  }

  /** A path the screen may open in the editor: a listed note or a listed
   *  project's memory .md file. */
  async canOpenInEditor(path: string): Promise<boolean> {
    if (typeof path !== 'string' || !path.toLowerCase().endsWith('.md')) return false
    if (this.knownNotes([path]).length > 0) return true
    return (this.projects ?? []).some(p => p.projectDir !== null && isSameOrUnder(path, join(p.projectDir, 'memory'))
      && !isSamePath(path, join(p.projectDir, 'memory')))
  }

  // ------------------------------------------------------------ live sessions

  liveSessions(): WizardProcess[] {
    const view = this.view()
    return this.deps.live().map(view)
  }

  // ------------------------------------------------------------ after a change

  /** Data changed: forget the scans (the screen rescans) and re-sync the catalog. */
  async afterChange(): Promise<void> {
    this.projects = null
    this.notes = null
    this.notesFor = null
    try { await this.hooks.changed?.() } catch (e) { console.error('[manage] catalog re-sync failed', e) }
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
