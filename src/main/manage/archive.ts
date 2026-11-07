import { createReadStream, existsSync, promises as fsp, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { ClaudePaths } from './paths'
import { encodePath, isFullyQualified, isSamePath, isSameOrUnder, normalizePath } from './paths'
import type { FileRemover, ProjectInfo } from './types'
import { collectProjectArtifacts } from './artifacts'
import { ClaudeJsonError, hasUnsafeNumber, loadClaudeJson, saveClaudeJson } from './claude-json'
import { appendLines, backupClaudeState, uniqueStampedPath } from './safe-file'
import { isProjectLine, SessionsLiveError, type DeleteResult } from './delete'
import type { LiveSession } from './live'
import { dotnetJson, extractEntry, InvalidZipError, setMtime, writeZipAtomic, ZipReader, type ZipWriter } from './archive-zip'
import {
  ARCHIVE_FORMAT, ARCHIVE_VERSION, InvalidArchiveError, MANIFEST_ENTRY, parseManifest, serializeManifest,
  type ArchivedNote, type ArchivedProject, type ArchivedRepoPath, type ArchiveKind, type ArchiveManifest
} from './archive-manifest'

export {
  ARCHIVE_FORMAT, ARCHIVE_VERSION, InvalidArchiveError,
  type ArchivedNote, type ArchivedProject, type ArchivedRepoPath, type ArchiveKind, type ArchiveManifest
}

/** Exports a project's Claude data, or a set of notes, to a zip with a manifest,
 *  and restores such a zip (port of ClaudeMemoryTool's ArchiveService). Paths
 *  inside the zip are relative to ~\.claude, %TEMP%\claude or the working
 *  folder, so an export restores onto another user profile too. Import never
 *  overwrites: existing files, .claude.json entries and history lines are kept
 *  as they are. The zip layout and manifest are the C# tool's, so restore points
 *  and exports made by either app restore in the other. */

/** done / failures / backupDir, the shape every manage operation reports. */
export type ArchiveResult = DeleteResult

/** A zip in the restore-points folder. `error` is set when its manifest can't be read. */
export type RestorePoint = { path: string; created: Date; projects: string[]; sizeBytes: number; error: string | null }

/** What exportNotes needs of a note (NoteIndex's NoteFile satisfies it). */
export type NoteToExport = { path: string; workingDir: string; relativePath: string }

/** Lists running Claude sessions (normally `() => getLiveSessions(paths)`). */
export type LiveSessions = () => LiveSession[] | Promise<LiveSession[]>

/** A restore point that couldn't save everything; no zip was left behind and
 *  the caller must not delete anything. */
export class RestorePointError extends Error {
  constructor(readonly failures: Array<{ path: string; error: string }>) {
    super('The restore point could not save everything, so nothing was deleted:\r\n' +
      failures.slice(0, 10).map(f => `  ${f.path}: ${f.error}`).join('\r\n') +
      (failures.length > 10 ? `\r\n  … and ${failures.length - 10} more` : ''))
    this.name = 'RestorePointError'
  }
}

export type ArchiveOptions = {
  /** Test seam: opens a source file for export (default `fs.promises.open(path, 'r')`). */
  openFile?: (path: string) => Promise<FileHandle>
}

const CLAUDE_JSON_ENTRY = 'claude-json-entry.json'
const HISTORY_ENTRY = 'history.jsonl'

/** Top-level ~\.claude folders an import may write to (never settings, hooks, plugins…). */
const CLAUDE_SUBDIRS = ['projects', 'file-history', 'session-env', 'tasks', 'uploads', 'todos', 'jobs'] as const

type Failure = { path: string; error: string }

export async function readManifest(zipPath: string): Promise<ArchiveManifest> {
  const zip = await openExport(zipPath)
  try { return await manifestOf(zip) } finally { zip.close() }
}

export class ArchiveService {
  private readonly openFile: (path: string) => Promise<FileHandle>

  constructor(private readonly paths: ClaudePaths, opts: ArchiveOptions = {}) {
    this.openFile = opts.openFile ?? (p => fsp.open(p, 'r'))
  }

  // -------------------------------------------------------------- export

  async exportProjects(projects: ProjectInfo[], zipPath: string, signal?: AbortSignal): Promise<ArchiveResult> {
    const done: string[] = []
    const failures: Failure[] = []
    const manifest = newManifest('Projects')
    await writeZipAtomic(zipPath, async zip => {
      for (let i = 0; i < projects.length; i++) {
        signal?.throwIfAborted()
        const p = projects[i]!
        const entry = await this.exportProject(zip, p, 'p' + (i + 1), failures, signal)
        manifest.projects.push(entry)
        done.push(`${p.workingDir}: ${entry.files} files (${formatSize(entry.bytes)})` +
          (entry.claudeJsonKey === null ? '' : ', .claude.json entry') +
          (entry.githubRepoPaths.length === 0 ? '' : `, ${entry.githubRepoPaths.length} GitHub repo link(s)`) +
          (entry.historyLines === 0 ? '' : `, ${entry.historyLines} history lines`))
      }
      zip.addText(MANIFEST_ENTRY, serializeManifest(manifest))
    })
    done.push('Saved ' + zipPath)
    return { done, failures, backupDir: null }
  }

  /** Exports the projects to a new zip in `restorePointsDir` before a delete and
   *  returns its path. Throws RestorePointError (leaving no zip) if anything
   *  could not be saved, so the caller never deletes data the restore point
   *  doesn't hold. */
  async createRestorePoint(projects: ProjectInfo[], signal?: AbortSignal): Promise<string> {
    await fsp.mkdir(this.paths.restorePointsDir, { recursive: true })
    let label = projects.length === 1 ? basename(projects[0]!.workingDir.replace(/[\\/]+$/, '')) : `${projects.length} projects`
    if (label.trim() === '' || /["<>|:*?\\/\x00-\x1f]/.test(label)) label = 'project'
    const zip = uniqueStampedPath(this.paths.restorePointsDir, ` ${label}.zip`)

    const result = await this.exportProjects(projects, zip, signal)
    if (result.failures.length === 0) return zip
    try { await fsp.unlink(zip) } catch { /* best effort */ }
    throw new RestorePointError(result.failures)
  }

  /** The zips in `restorePointsDir`, newest first. One that can't be read is
   *  still listed, with `error` set. */
  async listRestorePoints(): Promise<RestorePoint[]> {
    let names: string[]
    try { names = await fsp.readdir(this.paths.restorePointsDir) } catch { return [] }
    const result: RestorePoint[] = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.zip')) continue
      const path = join(this.paths.restorePointsDir, name)
      let st: Stats
      try { st = await fsp.stat(path) } catch { continue }
      if (!st.isFile()) continue
      try {
        const m = await readManifest(path)
        result.push({ path, created: m.createdUtc, projects: m.projects.map(p => p.workingDir), sizeBytes: st.size,
          error: m.kind === 'Projects' ? null : 'Not a project export.' })
      } catch (e) {
        result.push({ path, created: st.mtime, projects: [], sizeBytes: st.size, error: (e as Error).message })
      }
    }
    return result.sort((a, b) => b.created.getTime() - a.created.getTime())
  }

  /** Removes restore points through `remover` (the Recycle Bin in the app). Only
   *  .zip files directly inside `restorePointsDir` are touched; each failure is
   *  reported and the rest still go ahead. */
  async deleteRestorePoints(zipPaths: string[], remover: FileRemover): Promise<ArchiveResult> {
    const done: string[] = []
    const failures: Failure[] = []
    for (const p of zipPaths) {
      if (!isSamePath(dirname(resolve(p)), this.paths.restorePointsDir) || !p.toLowerCase().endsWith('.zip')) {
        failures.push({ path: p, error: 'Not a restore point; not deleted.' })
        continue
      }
      try {
        await remover.removeFile(p)
        done.push(p)
      } catch (e) {
        failures.push({ path: p, error: (e as Error).message })
      }
    }
    return { done, failures, backupDir: null }
  }

  private async exportProject(zip: ZipWriter, p: ProjectInfo, folder: string, failures: Failure[], signal?: AbortSignal): Promise<ArchivedProject> {
    let files = 0
    let bytes = 0
    for (const a of await collectProjectArtifacts(this.paths, p)) {
      // Memory lives inside the project folder; .claude.json / history are exported as data below.
      if (a.parent !== undefined || a.kind === 'Memory' || a.kind === 'ClaudeJsonEntry' ||
          a.kind === 'GithubRepoPath' || a.kind === 'HistoryLines') continue
      const [root, prefix] =
        a.kind === 'TempScratch' ? [this.paths.tempClaudeDir, 'temp'] :
        a.kind === 'InDirClaudeFolder' || a.kind === 'InDirClaudeMd' ? [p.workingDir, 'workdir'] :
        [this.paths.claudeDir, 'claude']
      const sources = await isFile(a.path) ? single(a.path) : enumerateFiles(a.path, a.kind === 'InDirClaudeFolder')
      for await (const f of sources) {
        signal?.throwIfAborted()
        const rel = relative(root, f)
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
          failures.push({ path: f, error: 'Not exported: outside ' + root })
          continue
        }
        try {
          bytes += await this.addFile(zip, f, `${folder}/${prefix}/${rel.replace(/\\/g, '/')}`)
          files++
        } catch (e) {
          if (e instanceof ZipBroken) throw e.cause
          failures.push({ path: f, error: 'Not exported: ' + (e as Error).message })
        }
      }
    }

    let key: string | null = null
    const repos: ArchivedRepoPath[] = []
    if (existsSync(this.paths.claudeJson)) {
      try {
        const root = loadClaudeJson(this.paths.claudeJson).root
        const projects = root.projects
        if (isObj(projects)) {
          for (const [k, v] of Object.entries(projects)) {
            if (isSamePath(k, p.workingDir) && v !== null && v !== undefined) {
              key = k
              zip.addText(`${folder}/${CLAUDE_JSON_ENTRY}`, dotnetJson(v))
              break
            }
          }
        }
        const gh = root.githubRepoPaths
        if (isObj(gh)) {
          for (const [repo, v] of Object.entries(gh)) {
            if (!Array.isArray(v)) continue
            for (const s of v) if (typeof s === 'string' && isSamePath(s, p.workingDir)) repos.push({ repo, path: s })
          }
        }
      } catch (e) {
        failures.push({ path: this.paths.claudeJson, error: 'Project entry not exported: ' + (e as Error).message })
      }
    }

    const history: string[] = []
    if (existsSync(this.paths.historyFile)) {
      try {
        for await (const line of readLines(createReadStream(this.paths.historyFile))) {
          if (isProjectLine(line, p.workingDir)) history.push(line)
        }
        if (history.length > 0) zip.addText(`${folder}/${HISTORY_ENTRY}`, history.join('\n') + '\n')
      } catch (e) {
        failures.push({ path: this.paths.historyFile, error: 'History not exported: ' + (e as Error).message })
        history.length = 0
      }
    }
    return {
      workingDir: p.workingDir, folder, claudeJsonKey: key, githubRepoPaths: repos, historyLines: history.length,
      files, bytes, encodedName: p.encodedName
    }
  }

  async exportNotes(notes: NoteToExport[], zipPath: string, signal?: AbortSignal): Promise<ArchiveResult> {
    const done: string[] = []
    const failures: Failure[] = []
    const manifest = newManifest('Notes')
    await writeZipAtomic(zipPath, async zip => {
      const seen = new Set<string>()
      let i = 0
      for (const n of notes) {
        if (seen.has(n.path.toLowerCase())) continue
        seen.add(n.path.toLowerCase())
        signal?.throwIfAborted()
        const entry = `notes/${++i}/${basename(n.path)}`
        try {
          const mtime = await this.addFileGetMtime(zip, n.path, entry)
          manifest.notes.push({ path: n.path, workingDir: n.workingDir, relativePath: n.relativePath, entry, modifiedUtc: mtime })
          done.push(n.path)
        } catch (e) {
          if (e instanceof ZipBroken) throw e.cause
          failures.push({ path: n.path, error: 'Not exported: ' + (e as Error).message })
        }
      }
      zip.addText(MANIFEST_ENTRY, serializeManifest(manifest))
    })
    done.push('Saved ' + zipPath)
    return { done, failures, backupDir: null }
  }

  /** Streams one file into the zip, stamped with its last-write time; returns its size. */
  private async addFile(zip: ZipWriter, path: string, name: string): Promise<number> {
    return (await this.addFileStat(zip, path, name)).size
  }

  private async addFileGetMtime(zip: ZipWriter, path: string, name: string): Promise<Date> {
    return (await this.addFileStat(zip, path, name)).mtime
  }

  /** Errors opening the file are per-file failures (nothing was added). Once the
   *  entry is started, an error breaks the zip and is rethrown as ZipBroken. */
  private async addFileStat(zip: ZipWriter, path: string, name: string): Promise<Stats> {
    const fh = await this.openFile(path)
    let st: Stats
    try {
      st = await fh.stat()
      if (!st.isFile()) throw new Error('Not a file.')
    } catch (e) {
      await fh.close()
      throw e
    }
    try {
      await zip.addStream(name, fh.createReadStream(), st.mtime)
    } catch (e) {
      try { await fh.close() } catch { /* already closed */ }
      throw new ZipBroken(e as Error)
    }
    return st
  }

  // -------------------------------------------------------------- import

  /** Restores an export. A projects export edits .claude.json / history.jsonl
   *  (after a backup), so it refuses to run while any Claude Code session is
   *  live: SessionsLiveError, nothing changed. A notes export doesn't ask.
   *  @throws InvalidArchiveError not an export made by either tool. */
  async import(zipPath: string, live: LiveSessions): Promise<ArchiveResult> {
    const zip = await openExport(zipPath)
    try {
      const m = await manifestOf(zip)
      return m.kind === 'Notes' ? await this.importNotes(zip, m) : await this.importProjects(zip, m, live)
    } finally {
      zip.close()
    }
  }

  private async importNotes(zip: ZipReader, m: ArchiveManifest): Promise<ArchiveResult> {
    const done: string[] = []
    const failures: Failure[] = []
    for (const n of m.notes) {
      try {
        // Only a .md file inside the working folder it was exported from, and never
        // Claude's own data (~\.claude\CLAUDE.md, agents, commands…).
        const rel = n.relativePath.replace(/\//g, '\\')
        if (!isFullyQualified(n.workingDir) || !isPlainRelative(rel) || !rel.toLowerCase().endsWith('.md')) {
          throw new Error('Not a .md file inside a project folder; not restored.')
        }
        const target = resolve(normalizePath(n.workingDir), rel)
        if (!isSamePath(target, n.path) || !isStrictlyUnder(target, n.workingDir) || this.isClaudeOwnData(target)) {
          throw new Error("Outside its project folder or inside Claude's own data; not restored.")
        }
        const entry = zip.get(n.entry)
        if (entry === undefined) throw new Error('Missing from the zip.')
        if (await isFile(target)) {
          failures.push({ path: target, error: 'Skipped: a file with this name already exists (not overwritten).' })
          continue
        }
        await extractEntry(zip, entry, target)
        await setMtime(target, n.modifiedUtc)
        done.push(target)
      } catch (e) {
        failures.push({ path: n.path, error: (e as Error).message })
      }
    }
    return { done, failures, backupDir: null }
  }

  private async importProjects(zip: ZipReader, m: ArchiveManifest, live: LiveSessions): Promise<ArchiveResult> {
    const sessions = await live()
    if (sessions.length > 0) throw new SessionsLiveError(sessions, 'importing')

    const done: string[] = []
    const failures: Failure[] = []
    const valid: Array<{ p: ArchivedProject; enc: string }> = []
    for (const p of m.projects) {
      // A known working dir decides the folder name; an unknown one (only its encoded name survives) uses the stored name.
      const enc = isFullyQualified(p.workingDir) ? encodePath(normalizePath(p.workingDir)) : p.encodedName ?? p.workingDir
      if (isSafeFolderName(p.folder) && /^[A-Za-z0-9-]+$/.test(enc)) valid.push({ p, enc })
      else failures.push({ path: p.workingDir, error: 'Skipped: invalid project entry in the export.' })
    }
    const known = valid.filter(v => isFullyQualified(v.p.workingDir)).map(v => v.p)

    const editsState = known.some(p => p.claudeJsonKey !== null || p.githubRepoPaths.length > 0 || p.historyLines > 0)
    const backupDir = editsState ? backupClaudeState(this.paths) : null // throws before any change

    for (const { p, enc } of valid) {
      let restored = 0
      let kept = 0
      const prefix = p.folder + '/'
      for (const e of zip.entries) {
        if (!e.name.startsWith(prefix) || e.name.endsWith('/')) continue
        const rest = e.name.slice(prefix.length)
        if (rest === CLAUDE_JSON_ENTRY || rest === HISTORY_ENTRY) continue
        let target: string | null = null
        try {
          target = this.mapProjectFile(p, enc, rest)
          if (target === null) throw new Error('Outside the allowed folders; not restored.')
          if (await isFile(target)) { kept++; continue }
          await extractEntry(zip, e, target)
          await setMtime(target, ZipReader.lastWriteTime(e))
          restored++
        } catch (err) {
          failures.push({ path: target ?? e.name, error: (err as Error).message })
        }
      }
      done.push(`${p.workingDir}: restored ${restored} files` + (kept === 0 ? '' : `, kept ${kept} existing`))
    }

    if (known.some(p => p.claudeJsonKey !== null || p.githubRepoPaths.length > 0)) {
      try { done.push(...await this.mergeClaudeJson(zip, known, failures)) } catch (e) {
        failures.push({ path: this.paths.claudeJson, error: (e as Error).message })
      }
    }
    if (known.some(p => p.historyLines > 0)) {
      try { done.push(await this.mergeHistory(zip, known)) } catch (e) {
        failures.push({ path: this.paths.historyFile, error: (e as Error).message })
      }
    }
    return { done, failures, backupDir }
  }

  /** Where a project file from the zip goes, or null when it would land outside
   *  the folders an export writes (only Claude's per-project data under ~\.claude,
   *  the temp scratch folder, and the working folder's own .claude\ and CLAUDE.md). */
  private mapProjectFile(p: ArchivedProject, enc: string, rest: string): string | null {
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    const area = rest.slice(0, slash)
    const rel = rest.slice(slash + 1).replace(/\//g, '\\')
    if (!isPlainRelative(rel)) return null
    let target: string
    switch (area) {
      case 'claude': {
        target = resolve(this.paths.claudeDir, rel)
        // Strictly inside this project's folder, or inside one of the per-session folders.
        const allowed = CLAUDE_SUBDIRS.filter(d => d !== 'projects').map(d => join(this.paths.claudeDir, d))
        allowed.push(join(this.paths.projectsDir, enc))
        if (!allowed.some(r => isStrictlyUnder(target, r))) return null
        break
      }
      case 'temp':
        target = resolve(this.paths.tempClaudeDir, rel)
        if (!isStrictlyUnder(target, join(this.paths.tempClaudeDir, enc))) return null
        break
      case 'workdir': {
        if (!isFullyQualified(p.workingDir)) return null
        const wd = normalizePath(p.workingDir)
        target = resolve(wd, rel)
        if (!isStrictlyUnder(target, join(wd, '.claude')) && !isSamePath(target, join(wd, 'CLAUDE.md'))) return null
        if (this.isClaudeOwnData(target)) return null // a home-folder project: its .claude is Claude's own data
        break
      }
      default:
        return null
    }
    return target
  }

  private isClaudeOwnData(path: string): boolean {
    return isSameOrUnder(path, this.paths.claudeDir) || isSameOrUnder(path, this.paths.tempClaudeDir) ||
      isSamePath(path, this.paths.claudeJson)
  }

  private async mergeClaudeJson(zip: ZipReader, projects: ArchivedProject[], failures: Failure[]): Promise<string[]> {
    if (!existsSync(this.paths.claudeJson)) throw new Error('.claude.json not found; project settings were not restored.')
    const file = loadClaudeJson(this.paths.claudeJson)
    const root = file.root
    const done: string[] = []
    let changed = false
    for (const p of projects) {
      // The key and repo paths must name this project's own folder: an entry is only ever added for it.
      const entry = p.claudeJsonKey === null ? undefined : zip.get(`${p.folder}/${CLAUDE_JSON_ENTRY}`)
      if (p.claudeJsonKey !== null && !isSamePath(p.claudeJsonKey, p.workingDir)) {
        failures.push({ path: p.workingDir, error: `Skipped .claude.json entry "${p.claudeJsonKey}": it names another folder.` })
      } else if (p.claudeJsonKey !== null && entry !== undefined) {
        const map = ensureObj(root, 'projects')
        if (Object.keys(map).some(k => isSamePath(k, p.workingDir))) {
          done.push(`${p.workingDir}: kept the existing .claude.json entry`)
        } else {
          const text = await zip.readText(entry)
          const value = JSON.parse(text) as unknown // a bad entry fails the whole merge, before any save
          if (hasUnsafeNumber(text)) throw new ClaudeJsonError(`The exported .claude.json entry for ${p.workingDir} holds a number too large to restore exactly; .claude.json left unchanged.`)
          setOwn(map, p.claudeJsonKey, value)
          done.push(`${p.workingDir}: added the .claude.json entry`)
          changed = true
        }
      }
      for (const r of p.githubRepoPaths) {
        if (!isSamePath(r.path, p.workingDir)) {
          failures.push({ path: p.workingDir, error: `Skipped GitHub repo link ${r.repo}: it names another folder.` })
          continue
        }
        const gh = ensureObj(root, 'githubRepoPaths')
        const existing = getOwn(gh, r.repo)
        const list: unknown[] = Array.isArray(existing) ? existing : []
        if (list !== existing) setOwn(gh, r.repo, list)
        if (list.some(n => typeof n === 'string' && isSamePath(n, r.path))) continue
        list.push(r.path)
        done.push(`${p.workingDir}: added GitHub repo link ${r.repo}`)
        changed = true
      }
    }
    if (changed) saveClaudeJson(this.paths.claudeJson, file)
    return done
  }

  private async mergeHistory(zip: ZipReader, projects: ArchivedProject[]): Promise<string> {
    const existing = new Set<string>()
    if (existsSync(this.paths.historyFile)) {
      for await (const line of readLines(createReadStream(this.paths.historyFile))) existing.add(line)
    }
    const add: string[] = []
    for (const p of projects) {
      const entry = zip.get(`${p.folder}/${HISTORY_ENTRY}`)
      if (entry === undefined) continue
      for await (const line of readLines(await zip.openStream(entry))) {
        if (line.length > 0 && isProjectLine(line, p.workingDir) && !existing.has(line)) {
          existing.add(line)
          add.push(line)
        }
      }
    }
    await fsp.mkdir(this.paths.claudeDir, { recursive: true })
    appendLines(this.paths.historyFile, add)
    return `history.jsonl: added ${add.length} lines`
  }
}

// ------------------------------------------------------------------ helpers

/** A failure after a zip entry was started: the zip can't be finished. */
class ZipBroken extends Error {
  constructor(override readonly cause: Error) { super(cause.message) }
}

function newManifest(kind: ArchiveKind): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, kind, createdUtc: new Date(),
    machine: process.env.COMPUTERNAME ?? hostname(), projects: [], notes: []
  }
}

async function openExport(zipPath: string): Promise<ZipReader> {
  try {
    return await ZipReader.open(zipPath)
  } catch (e) {
    if (e instanceof InvalidZipError) throw new InvalidArchiveError(e.message)
    throw e
  }
}

async function manifestOf(zip: ZipReader): Promise<ArchiveManifest> {
  const entry = zip.get(MANIFEST_ENTRY)
  if (entry === undefined) throw new InvalidArchiveError('Not a Claude Memory Tool export (no manifest.json).')
  let text: string
  try { text = await zip.readText(entry) } catch (e) {
    throw new InvalidArchiveError("The export's manifest.json could not be read: " + (e as Error).message)
  }
  return parseManifest(text)
}

/** Lines as .NET's StreamReader.ReadLine splits them (\n, \r\n or \r; a leading BOM dropped). */
async function* readLines(input: Readable): AsyncGenerator<string> {
  const rl = createInterface({ input, crlfDelay: Infinity })
  let first = true
  try {
    for await (const line of rl) {
      yield first ? line.replace(/^﻿/, '') : line
      first = false
    }
  } finally {
    rl.close()
    input.destroy()
  }
}

async function* single(path: string): AsyncGenerator<string> { yield path }

/** Every file under `dir`, without following links into folders; `.claude\worktrees`
 *  (git working copies) is left out of a project's own .claude folder. Unreadable
 *  folders are skipped, like the C# walk. */
async function* enumerateFiles(dir: string, skipWorktrees: boolean): AsyncGenerator<string> {
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()!
    let entries
    try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { continue }
    const dirs: string[] = []
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isFile()) yield p
      else if (e.isSymbolicLink()) {
        // A file link is read through (like Directory.GetFiles); a folder link/junction is never walked.
        try { if ((await fsp.stat(p)).isFile()) yield p } catch { /* dangling */ }
      } else if (e.isDirectory()) {
        if (skipWorktrees && isSamePath(p, join(dir, 'worktrees'))) continue
        dirs.push(p)
      }
    }
    stack.push(...dirs)
  }
}

async function isFile(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isFile() } catch { return false }
}

function isSafeFolderName(folder: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(folder)
}

/** A relative path with no root and no empty, "." or ".." segments. Stricter than
 *  the C#: a segment ending in '.' or ' ' (which Windows would silently trim, so
 *  "..." or ". ." could act as "..") or holding a NUL is refused too. */
function isPlainRelative(rel: string): boolean {
  return rel.length > 0 && !isAbsolute(rel) && !rel.includes(':') && !rel.includes('\0') &&
    rel.split('\\').every(s => s.length > 0 && !s.endsWith('.') && !s.endsWith(' '))
}

function isStrictlyUnder(path: string, root: string): boolean {
  return isSameOrUnder(path, root) && !isSamePath(path, root)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function getOwn(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
}

/** `o[k]` when it is a JSON object, else a new empty object stored there (like the C# `is not JsonObject` replace). */
function ensureObj(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = getOwn(o, k)
  if (isObj(v)) return v
  const fresh: Record<string, unknown> = {}
  setOwn(o, k, fresh)
  return fresh
}

/** Assigns an own property even for a key like "__proto__" (never touches a prototype). */
function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
}

function trimmed(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.?0+$/, '')
}

export function formatSize(bytes: number): string {
  if (bytes >= 2 ** 30) return `${trimmed(bytes / 2 ** 30, 2)} GB`
  if (bytes >= 2 ** 20) return `${trimmed(bytes / 2 ** 20, 1)} MB`
  if (bytes >= 2 ** 10) return `${trimmed(bytes / 2 ** 10, 1)} KB`
  return `${bytes} B`
}
