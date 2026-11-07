import { existsSync, promises as fsp, statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { ClaudePaths } from './paths'
import { encodePath, isFullyQualified, isSamePath, isSameOrUnder, normalizePath, replacePrefix } from './paths'
import { PathRewriter } from './path-rewriter'
import { loadClaudeJson, saveClaudeJson } from './claude-json'
import { backupClaudeState, rewriteLines } from './safe-file'
import { isDir, isFile, listDir } from './fs-util'
import { forEachLine } from './search'
import { SessionsLiveError, type DeleteResult } from './delete'
import type { LiveSession } from './live'

/** Port of ClaudeMemoryTool's RenameService: moves a working folder and
 *  repoints every Claude Code reference at-or-under it, in every project:
 *  session logs (incl. subagent logs), encoded project/temp folders,
 *  .claude.json keys and githubRepoPaths, history.jsonl and background-job
 *  state files. */

export type RenamePlan = {
  oldDir: string
  newDir: string
  jsonlFiles: string[]
  dirRenames: { from: string; to: string }[]
  claudeJsonKeys: number
  historyLines: number
  jobFiles: string[]
  moveWorkingFolder: boolean
  siblingSuffixes: string[]
  warning: string | null
}

/** Outcome of a multi-step operation: what was done, what failed (with the
 *  reason), and the backup folder made first (if any). Same shape as Delete's. */
export type ExecuteResult = DeleteResult

/** Every running Claude Code session ("can't tell" must count as running). */
export type LiveSessionSource = () => LiveSession[] | Promise<LiveSession[]>

export { SessionsLiveError }

/** The rename is not allowed (target exists, nested, root, shared folder, ...). Thrown by `plan` before any change. */
export class RenameRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenameRefusedError'
  }
}

export const NEITHER_EXISTS_WARNING = "Neither folder exists on disk — only Claude's references will be repointed."

const SEP = '\\'
const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g
const INVALID_SEGMENT_CHARS = /[<>"|?*:]/
// Path.GetInvalidPathChars() on Windows: '|' and the control chars 0-31.
// eslint-disable-next-line no-control-regex
const INVALID_PATH_CHARS = /[|\u0000-\u001f]/

export class RenameService {
  constructor(private readonly paths: ClaudePaths, private readonly liveSessions: LiveSessionSource) {}

  /** Builds the plan. Resumable: when oldDir is gone and newDir exists (an
   *  earlier run moved the folder and then failed), the move is skipped and the
   *  remaining references are planned; rewrites are idempotent.
   *  @throws RenameRefusedError when the rename is not allowed. */
  async plan(oldDir: string, newDir: string): Promise<RenamePlan> {
    const paths = this.paths
    const oldN = normalizePath(oldDir)
    const newN = normalizePath(newDir)
    if (oldN.length === 0 || newN.length === 0) throw new RenameRefusedError('Both the old and the new path are required.')
    if (!isFullyQualified(oldN)) throw new RenameRefusedError(`${oldDir} is not a full path.`)
    validateNewPath(newDir, newN)
    if (sameRoot(pathRoot(oldN), oldN)) throw new RenameRefusedError(`${oldN} is a drive or share root and cannot be renamed.`)
    if (isSameOrUnder(newN, oldN)) throw new RenameRefusedError(`${newN} is the same as or inside ${oldN}.`)
    if (isSameOrUnder(paths.claudeDir, oldN) || isSameOrUnder(paths.tempClaudeDir, oldN))
      throw new RenameRefusedError(`${oldN} contains Claude Code's own data folders and cannot be renamed.`)

    const move = await isDir(oldN)
    if (await isFile(newN) || (move && await isDir(newN))) throw new RenameRefusedError(`${newN} already exists.`)
    if (move) {
      const parent = win32.dirname(newN)
      if (!parent || !await isDir(parent))
        throw new RenameRefusedError(`The parent folder of ${newN} does not exist.`)
      if (pathRoot(win32.resolve(oldN)).toLowerCase() !== pathRoot(win32.resolve(newN)).toLowerCase())
        throw new RenameRefusedError('The working folder can only be moved within the same drive.')
    }

    // One pass over every transcript: each folder's cwds, its working dir, and the files that may
    // need a rewrite. Sibling suffixes (which only narrow the matches) aren't known yet, so
    // candidates are found with a suffix-less rewriter and re-checked once they are.
    const loose = new PathRewriter(oldN, newN)
    const looseTouched: string[] = []
    const folderCwds = new Map<string, string[]>() // key: lower-cased folder path
    const folders: string[] = []
    // Every path Claude's state names as a project / repo folder.
    const known: string[] = []
    if (await isDir(paths.projectsDir)) {
      for (const folder of await subdirs(paths.projectsDir)) {
        const scan = await scanProjectFolder(folder, loose, looseTouched)
        folders.push(folder)
        folderCwds.set(folder.toLowerCase(), scan.cwds)
        if (scan.workingDir !== null) known.push(scan.workingDir)
      }
    }

    let jsonKeys = 0
    if (existsSync(paths.claudeJson)) {
      const root = loadClaudeJson(paths.claudeJson).root
      const projects = asObject(root.projects)
      if (projects) {
        const keys = Object.keys(projects)
        known.push(...keys)
        for (const k of keys.filter(k => isSameOrUnder(k, oldN))) {
          jsonKeys++
          const target = replacePrefix(k, oldN, newN)
          if (keys.some(o => !isSameOrUnder(o, oldN) && isSamePath(o, target)))
            throw new RenameRefusedError(`.claude.json already has an entry for ${target}.`)
        }
      }
      const repos = asObject(root.githubRepoPaths)
      if (repos) {
        for (const value of Object.values(repos)) {
          if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') known.push(v)
        }
      }
    }
    known.push(...await this.historyProjects())

    const suffixes = siblingSuffixes(oldN, [...known, ...await diskSiblings(oldN)])
    const rw = new PathRewriter(oldN, newN, suffixes)

    const candidates = known.filter(k => isSameOrUnder(k, oldN))
    const jsonl: string[] = []
    for (const f of looseTouched) if (suffixes.length === 0 || await fileTouches(f, rw)) jsonl.push(f)
    for (const folder of folders) {
      // Resume: sessions already rewritten to newDir still sit in a folder named after oldDir.
      const name = win32.basename(folder)
      for (const c of folderCwds.get(folder.toLowerCase())!.filter(c => isSameOrUnder(c, newN))) {
        const oldEquivalent = replacePrefix(c, newN, oldN)
        if (encodePath(oldEquivalent).toLowerCase() === name.toLowerCase()) candidates.push(oldEquivalent)
      }
    }

    const foreign = known.filter(k => !isSameOrUnder(k, oldN) && !isSameOrUnder(k, newN))
    const dirRenames = await this.planDirRenames(candidates, foreign, folderCwds, oldN, newN)

    const jobRewriters = this.jobRewriters(rw, dirRenames)
    const jobs: string[] = []
    if (await isDir(paths.jobsDir)) {
      for (const d of await subdirs(paths.jobsDir)) {
        const state = win32.join(d, 'state.json')
        if (!await isFile(state)) continue
        for (const r of jobRewriters) {
          if (await fileTouches(state, r)) { jobs.push(state); break }
        }
      }
    }

    const historyLines = existsSync(paths.historyFile) ? await countTouchingLines(paths.historyFile, rw) : 0
    const warning = !move && !await isDir(newN) ? NEITHER_EXISTS_WARNING : null
    return {
      oldDir: oldN, newDir: newN, jsonlFiles: jsonl, dirRenames, claudeJsonKeys: jsonKeys, historyLines,
      jobFiles: jobs, moveWorkingFolder: move, siblingSuffixes: suffixes, warning
    }
  }

  /** Order: live-session check (throws before any change) → backup → move
   *  working folder → session logs → job files → encoded folders →
   *  .claude.json → history.jsonl. Stops at the first failure and reports what
   *  was done; running Rename again with the same paths resumes.
   *  @throws SessionsLiveError when any Claude Code session is running (nothing changed).
   *  Also throws, before any change, if the backup can't be made. */
  async execute(plan: RenamePlan): Promise<ExecuteResult> {
    const paths = this.paths
    const sessions = await this.liveSessions()
    if (sessions.length > 0) throw new SessionsLiveError(sessions)

    const done: string[] = []
    const failures: { path: string; error: string }[] = []
    const backupDir = backupClaudeState(paths) // throws before any change if it can't back up
    const result: ExecuteResult = { done, failures, backupDir }

    const step = async (path: string, action: () => boolean | Promise<boolean>, doneLabel?: string): Promise<boolean> => {
      try {
        if (await action()) done.push(doneLabel ?? path)
        return true
      } catch (e) {
        failures.push({ path, error: errorMessage(e) })
        return false
      }
    }

    const rw = new PathRewriter(plan.oldDir, plan.newDir, plan.siblingSuffixes)

    if (plan.moveWorkingFolder && await isDir(plan.oldDir) &&
      !await step(plan.oldDir, async () => { await moveDirectory(plan.oldDir, plan.newDir); return true },
        `Moved ${plan.oldDir} → ${plan.newDir}`))
      return result

    for (const f of plan.jsonlFiles) {
      if (!await step(f, () => { rewriteLines(f, rw.rewrite, true); return true })) return result
    }

    const jobRewriters = this.jobRewriters(rw, plan.dirRenames)
    for (const f of plan.jobFiles) {
      if (!await step(f, () => {
        rewriteLines(f, line => jobRewriters.reduce((s, r) => r.rewrite(s), line), false)
        return true
      })) return result
    }

    for (const { from, to } of plan.dirRenames) {
      if (!await step(from, async () => { await moveDirectory(from, to); return true })) return result
    }

    if (existsSync(paths.claudeJson) && !await step(paths.claudeJson, () => this.editClaudeJson(plan.oldDir, plan.newDir)))
      return result

    if (existsSync(paths.historyFile))
      await step(paths.historyFile, () => { rewriteLines(paths.historyFile, rw.rewrite, true); return true })

    return result
  }

  /** Every projects\* and temp\claude\* folder whose name is the encoding of a
   *  dir at-or-under oldDir is renamed to the encoding of that dir with oldDir
   *  replaced by newDir. The encoding is lossy (D:\A\b and D:\A-b share a
   *  folder), so a folder that also belongs to a path outside oldDir is refused. */
  private async planDirRenames(candidates: string[], foreign: string[], folderCwds: Map<string, string[]>,
    oldN: string, newN: string): Promise<{ from: string; to: string }[]> {
    const map = new Map<string, string>()
    for (const d of candidates) {
      const k = encodePath(d).toLowerCase()
      if (!map.has(k)) map.set(k, encodePath(replacePrefix(d, oldN, newN)))
    }
    const foreignNames = new Map<string, string>()
    for (const f of foreign) {
      const k = encodePath(f).toLowerCase()
      if (!foreignNames.has(k)) foreignNames.set(k, f)
    }

    const result: { from: string; to: string }[] = []
    for (const root of [this.paths.projectsDir, this.paths.tempClaudeDir]) {
      if (!await isDir(root)) continue
      for (const dir of await subdirs(root)) {
        const name = win32.basename(dir)
        const newName = map.get(name.toLowerCase())
        if (newName === undefined || name.toLowerCase() === newName.toLowerCase()) continue
        const other = foreignNames.get(name.toLowerCase())
        if (other !== undefined)
          throw new RenameRefusedError(`${dir} is shared with ${other}, which is outside ${oldN}. Rename refused.`)
        const cwds = folderCwds.get(dir.toLowerCase())
        if (cwds) {
          const outside = cwds.find(c => !isSameOrUnder(c, oldN) && !isSameOrUnder(c, newN))
          if (outside !== undefined)
            throw new RenameRefusedError(`${dir} also holds sessions of ${outside}, which is outside ${oldN}. Rename refused.`)
        }
        const to = win32.join(root, newName)
        if (existsSync(to)) throw new RenameRefusedError(`${to} already exists.`)
        if (result.some(r => r.to.toLowerCase() === to.toLowerCase()))
          throw new RenameRefusedError(`More than one folder would be renamed to ${to}.`)
        result.push({ from: dir, to })
      }
    }
    return result
  }

  /** Job state files also point into the encoded project folders
   *  (linkScanPath), so they are rewritten for the renamed project folders as
   *  well as for the working folder. */
  private jobRewriters(rw: PathRewriter, dirRenames: { from: string; to: string }[]): PathRewriter[] {
    return [rw, ...dirRenames
      .filter(d => isSamePath(win32.dirname(d.from), this.paths.projectsDir))
      .map(d => new PathRewriter(d.from, d.to))]
  }

  /** Every history.jsonl "project" value. */
  private async historyProjects(): Promise<string[]> {
    const result: string[] = []
    if (!existsSync(this.paths.historyFile)) return result
    await forEachLine(this.paths.historyFile, line => {
      if (line.length === 0) return
      try {
        const v = JSON.parse(line) as unknown
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          const pr = (v as Record<string, unknown>).project
          if (typeof pr === 'string') result.push(pr)
        }
      } catch { /* malformed */ }
    })
    return result
  }

  /** @returns true when the file was rewritten. */
  private editClaudeJson(oldN: string, newN: string): boolean {
    const file = loadClaudeJson(this.paths.claudeJson)
    const root = file.root
    let changed = false

    const projects = asObject(root.projects)
    if (projects && Object.keys(projects).some(k => isSameOrUnder(k, oldN))) {
      // Rebuild to keep the original key order.
      const rebuilt: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(projects)) {
        const newKey = isSameOrUnder(key, oldN) ? restyle(key, replacePrefix(key, oldN, newN)) : key
        if (Object.prototype.hasOwnProperty.call(rebuilt, newKey))
          throw new Error(`.claude.json already has an entry for ${newKey}; left unchanged.`)
        rebuilt[newKey] = value
      }
      root.projects = rebuilt
      changed = true
    }

    const repos = asObject(root.githubRepoPaths)
    if (repos) {
      for (const value of Object.values(repos)) {
        if (!Array.isArray(value)) continue
        for (let i = 0; i < value.length; i++) {
          const s: unknown = value[i]
          if (typeof s !== 'string' || !isSameOrUnder(s, oldN)) continue
          value[i] = restyle(s, replacePrefix(s, oldN, newN))
          changed = true
        }
      }
    }

    if (!changed) return false
    saveClaudeJson(this.paths.claudeJson, file)
    return true
  }
}

/** The new path is written into every reference, so it must be a well-formed
 *  absolute path even when nothing is moved on disk: fully qualified (not "Foo"
 *  or "D:Foo"), no invalid characters, no ':' beyond the drive, no "." / ".."
 *  segments, and not a drive root. */
function validateNewPath(raw: string, newN: string): void {
  if (INVALID_PATH_CHARS.test(raw)) throw new RenameRefusedError(`${raw} contains characters that are not allowed in a path.`)
  if (!isFullyQualified(newN)) throw new RenameRefusedError(`${raw} is not a full path (for example D:\\Folder\\Name).`)
  const root = pathRoot(newN)
  if (sameRoot(root, newN)) throw new RenameRefusedError(`${newN} is a drive or share root.`)
  for (const segment of newN.slice(root.length).replace(/^\\+/, '').split(SEP)) {
    if (segment.length === 0) throw new RenameRefusedError(`${newN} contains an empty folder name.`)
    if (segment === '.' || segment === '..') throw new RenameRefusedError(`${newN} must not contain "." or ".." folder names.`)
    if (INVALID_SEGMENT_CHARS.test(segment))
      throw new RenameRefusedError(`${newN} contains characters that are not allowed in a folder name (< > " | ? * :).`)
  }
}

/** Like .NET Path.GetPathRoot for a normalized path: `D:\` or `\\server\share`. */
function pathRoot(p: string): string {
  const unc = /^\\\\[^\\]+(?:\\[^\\]+)?/.exec(p)
  if (unc) return unc[0]
  const drive = /^[A-Za-z]:\\?/.exec(p)
  return drive ? drive[0] : ''
}

function sameRoot(root: string, p: string): boolean {
  return root.replace(/\\+$/, '').toLowerCase() === p.replace(/\\+$/, '').toLowerCase()
}

/** Name tails of siblings that start with oldDir's name but are other folders,
 *  e.g. " Stuff" for D:\GIT\Old Stuff when renaming D:\GIT\Old. */
function siblingSuffixes(oldN: string, candidates: string[]): string[] {
  const result: string[] = []
  for (const p of candidates) {
    const n = normalizePath(p)
    if (n.length <= oldN.length || !n.toLowerCase().startsWith(oldN.toLowerCase()) || isSameOrUnder(n, oldN)) continue
    let rest = n.slice(oldN.length)
    const sep = rest.indexOf(SEP)
    if (sep >= 0) rest = rest.slice(0, sep)
    if (rest.length > 0 && !result.some(r => r.toLowerCase() === rest.toLowerCase())) result.push(rest)
  }
  return result
}

async function diskSiblings(oldN: string): Promise<string[]> {
  const parent = win32.dirname(oldN)
  const name = win32.basename(oldN)
  if (!parent || !name || sameRoot(parent, oldN) || !await isDir(parent)) return []
  const lower = name.toLowerCase()
  return (await listDir(parent)).filter(e => e.toLowerCase().startsWith(lower)).map(e => win32.join(parent, e))
}

async function subdirs(dir: string): Promise<string[]> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
  return entries.filter(e => e.isDirectory()).map(e => win32.join(dir, e.name))
}

/** Every *.jsonl under `dir` (session subfolders included). Links/junctions are not followed. */
async function jsonlFilesUnder(dir: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = win32.join(dir, e.name)
    if (e.isDirectory()) await jsonlFilesUnder(p, out)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) out.push(p)
  }
}

/** Adds every *.jsonl under `folder` (session subfolders included) that the
 *  rewriter touches to `touched`, and returns the distinct "cwd" values found
 *  in them, plus the folder's working dir as the project scanner sees it: the
 *  first top-level `cwd` (top-level transcripts in name order) whose encoding
 *  is the folder name. */
async function scanProjectFolder(folder: string, rw: PathRewriter, touched: string[]):
  Promise<{ cwds: string[]; workingDir: string | null }> {
  const name = win32.basename(folder).toLowerCase()
  const files: string[] = []
  await jsonlFilesUnder(folder, files)
  const top = (f: string): boolean => isSamePath(win32.dirname(f), folder)
  files.sort((a, b) => Number(!top(a)) - Number(!top(b)) || a.localeCompare(b, undefined, { sensitivity: 'base' }))
  const raw = new Set<string>()
  let workingDir: string | null = null
  for (const f of files) {
    let touches = false
    const isTop = top(f)
    await forEachLine(f, line => {
      if (!touches && rw.touches(line)) touches = true
      if (!line.includes('"cwd"')) return
      for (const m of line.matchAll(CWD_FIELD)) raw.add(m[1]!)
      if (workingDir === null && isTop) {
        try {
          const v = JSON.parse(line) as { cwd?: unknown }
          if (typeof v.cwd === 'string' && v.cwd.length > 0 && encodePath(v.cwd).toLowerCase() === name) workingDir = v.cwd
        } catch { /* malformed */ }
      }
    })
    if (touches) touched.push(f)
  }
  const cwds: string[] = []
  for (const r of raw) {
    try {
      const v = JSON.parse('"' + r + '"') as unknown
      if (typeof v === 'string' && v.length > 0 && !cwds.some(c => c.toLowerCase() === v.toLowerCase())) cwds.push(v)
    } catch { /* malformed escape */ }
  }
  return { cwds, workingDir }
}

async function countTouchingLines(file: string, rw: PathRewriter): Promise<number> {
  let n = 0
  await forEachLine(file, line => { if (rw.touches(line)) n++ })
  return n
}

async function fileTouches(file: string, rw: PathRewriter): Promise<boolean> {
  let hit = false
  await forEachLine(file, line => {
    if (rw.touches(line)) { hit = true; return false }
    return undefined
  })
  return hit
}

/** Directory.Move semantics: fails if the destination already exists. */
async function moveDirectory(from: string, to: string): Promise<void> {
  if (existsSync(to)) throw new Error(`Cannot move ${from}: ${to} already exists.`)
  if (!statSync(from).isDirectory()) throw new Error(`${from} is not a folder.`)
  await fsp.rename(from, to)
}

/** Keeps forward slashes when the original value used them (Claude writes "D:/x" keys on Windows). */
function restyle(original: string, replaced: string): string {
  return original.includes('/') && !original.includes('\\') ? replaced.replace(/\\/g, '/') : replaced
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
