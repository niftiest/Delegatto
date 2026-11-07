import { execFile } from 'node:child_process'
import { promises as fsp, type Dirent } from 'node:fs'
import { win32 } from 'node:path'
import type { ClaudePaths } from './paths'
import { isFullyQualified, isSamePath, isSameOrUnder, normalizePath } from './paths'
import type { FileRemover, ProjectInfo } from './types'
import type { ExecuteResult } from './rename'
import { forEachParallel } from './search'

/** Port of ClaudeMemoryTool's NoteIndex: finds and searches the *.md files
 *  inside projects' working folders (not Claude's own data). */

/** A Markdown file inside a project's working folder. `cloudOnly`: an
 *  online-only placeholder (OneDrive etc.) that would be downloaded if read,
 *  so its content is never searched. `modified` is epoch ms. */
export type NoteFile = {
  path: string
  workingDir: string
  relativePath: string
  modified: number
  sizeBytes: number
  cloudOnly: boolean
}

/** A note that matched a search: matching line count (content), the first
 *  matching line (1-based number, trimmed text), and whether the file name matched. */
export type NoteHit = {
  note: NoteFile
  matchCount: number
  firstLineNumber: number
  firstLineText: string
  nameMatch: boolean
}

/** Given files, returns the ones that are online-only cloud placeholders.
 *  Called once per scan / search with every candidate file. Must not read
 *  file contents. A file it can't check should be reported as cloud-only. */
export type CloudOnlyCheck = (files: readonly string[]) => Promise<Set<string>>

export type NoteIndexOptions = {
  /** Folder budget per project; a larger tree is reported as partly scanned. */
  maxDirsPerProject?: number
  /** Defaults to `oneDriveCloudCheck()` (one hidden PowerShell query for files under OneDrive). */
  cloudOnly?: CloudOnlyCheck
  /** Defaults to Windows, Program Files (x86) and ProgramData from the environment. */
  systemFolders?: readonly string[]
}

export type FindNotesResult = {
  notes: NoteFile[]
  /** Working folders whose tree was too large to walk completely ("partly scanned"). */
  truncated: string[]
}

/** Files larger than this are listed but not searched. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_DIRS = 20_000

/** FILE_ATTRIBUTE_OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS: cloud
 *  placeholders that download when opened. */
export const CLOUD_ATTRIBUTES = 0x1000 | 0x40000 | 0x400000

/** Folder names never descended into (dependencies, VCS, IDE state, git
 *  worktrees, Claude's .superpowers scratch). */
const SKIPPED_NAMES = new Set(['node_modules', '.git', '.venv', 'venv', '.vs', '.idea', '__pycache__', '.worktrees',
  'appdata', '.superpowers'])

/** Build-output names, skipped only when the folder beside them is a code
 *  project (so `docs\build\` or a `Library\` of notes is still searched). */
const BUILD_OUTPUT_NAMES = new Set(['bin', 'obj', 'build', 'dist', 'out', 'target', 'packages', 'library', 'temp', 'logs'])

/** Files or folders whose presence marks a code project root. */
const PROJECT_MARKER_NAMES = new Set(['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'cmakelists.txt', 'makefile', 'projectsettings'])
const PROJECT_MARKER_EXTS = ['.csproj', '.sln', '.slnx', '.vcxproj', '.fsproj']

function isProjectMarker(name: string): boolean {
  const l = name.toLowerCase()
  return PROJECT_MARKER_NAMES.has(l) || PROJECT_MARKER_EXTS.some(e => l.endsWith(e))
}

/** Windows, Program Files and ProgramData: projects there are system/vendor folders, not notes. */
export function defaultSystemFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.SystemRoot ?? env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
}

export class NoteIndex {
  private readonly maxDirs: number
  private readonly cloudOnly: CloudOnlyCheck
  private readonly systemFolders: string[]

  constructor(private readonly paths: ClaudePaths, opts: NoteIndexOptions = {}) {
    this.maxDirs = opts.maxDirsPerProject ?? DEFAULT_MAX_DIRS
    this.cloudOnly = opts.cloudOnly ?? oneDriveCloudCheck()
    this.systemFolders = [...(opts.systemFolders ?? defaultSystemFolders())]
  }

  /** Every *.md under each distinct, existing, fully-qualified working folder
   *  that isn't a drive root, a system folder or Claude's own data. A file in a
   *  nested project is listed once, under the innermost project. One bad
   *  project never stops the rest. Rejects if `signal` aborts. */
  async findNotes(projects: Iterable<ProjectInfo>, signal?: AbortSignal): Promise<FindNotesResult> {
    const claudeDirs = [full(this.paths.claudeDir), full(this.paths.tempClaudeDir)]
    const roots: string[] = []
    const rootSet = new Set<string>() // lower-cased
    for (const p of projects) {
      if (!p.workingDirKnown || !isFullyQualified(p.workingDir)) continue
      let dir: string
      try { dir = full(p.workingDir) } catch { continue }
      if (isSamePath(pathRoot(dir), dir)) continue
      if (claudeDirs.some(c => isSameOrUnder(dir, c)) || this.systemFolders.some(s => isSameOrUnder(dir, s))) continue
      const key = dir.toLowerCase()
      if (rootSet.has(key)) continue
      rootSet.add(key)
      if (!await isDirectory(dir)) continue
      roots.push(dir)
    }

    const notes: NoteFile[] = []
    const truncated: string[] = []
    for (const root of roots) {
      signal?.throwIfAborted()
      try {
        if (!await this.walk(root, rootSet, claudeDirs, notes, signal)) truncated.push(root)
      } catch (e) {
        if (signal?.aborted) throw e
        // one bad project never stops the rest
      }
    }

    if (notes.length > 0) {
      const cloud = await safeCloudCheck(this.cloudOnly, notes.map(n => n.path))
      for (const n of notes) if (cloud.has(n.path)) n.cloudOnly = true
    }
    return { notes, truncated }
  }

  /** Breadth-first walk of one project, so a capped walk still covers every
   *  top-level folder. Other project roots below it are skipped: they are
   *  walked as their own roots. Returns false when the folder budget ran out. */
  private async walk(root: string, roots: Set<string>, claudeDirs: string[], notes: NoteFile[],
    signal?: AbortSignal): Promise<boolean> {
    const queue: string[] = [root]
    let budget = this.maxDirs
    for (let qi = 0; qi < queue.length; qi++) {
      signal?.throwIfAborted()
      if (--budget < 0) return false
      const dir = queue[qi]!
      let entries: Dirent[]
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }

      let codeProject: boolean | null = null // checked only if a build-output name turns up
      for (const e of entries) {
        const p = win32.join(dir, e.name)
        try {
          // Windows reports every reparse point (links, junctions, but also
          // cloud placeholders) as a symbolic link: tell them apart.
          let isDirEntry = e.isDirectory()
          let isFileEntry = e.isFile()
          if (e.isSymbolicLink()) {
            if (await hasLinkTarget(p)) {
              // A real link: a linked file is still a note, a linked folder could loop or leave the project.
              isDirEntry = false
              isFileEntry = (await fsp.stat(p)).isFile()
            } else {
              const st = await fsp.stat(p)
              isDirEntry = st.isDirectory()
              isFileEntry = st.isFile()
            }
          }
          if (isFileEntry) {
            if (!e.name.toLowerCase().endsWith('.md')) continue
            const st = await fsp.stat(p)
            notes.push({
              path: p, workingDir: root, relativePath: win32.relative(root, p),
              modified: st.mtimeMs, sizeBytes: st.size, cloudOnly: false
            })
            continue
          }
          if (!isDirEntry) continue
          const lower = e.name.toLowerCase()
          if (SKIPPED_NAMES.has(lower)) continue
          if (BUILD_OUTPUT_NAMES.has(lower) && (codeProject ??= entries.some(x => isProjectMarker(x.name)))) continue
          if (lower === 'worktrees' && win32.basename(dir).toLowerCase() === '.claude') continue
          const np = normalizePath(p)
          if (roots.has(np.toLowerCase()) || claudeDirs.some(c => under(np, c))) continue
          queue.push(p)
        } catch { /* vanished / access denied: skip this entry */ }
      }
    }
    return true
  }

  /** Notes whose relative path or content contains `query` (case-insensitive);
   *  every note when the query is blank. Files over 2 MB and cloud-only files
   *  are matched by name only (re-checked now: a file may have grown, or
   *  OneDrive may have freed it since the scan). Unreadable files are skipped.
   *  `onHit` is called as each hit is found. Rejects if `signal` aborts. */
  async search(notes: readonly NoteFile[], query: string, onHit?: (hit: NoteHit) => void,
    signal?: AbortSignal): Promise<NoteHit[]> {
    signal?.throwIfAborted()
    const q = query.trim()
    if (q.length === 0) return notes.map(n => ({ note: n, matchCount: 0, firstLineNumber: 0, firstLineText: '', nameMatch: false }))

    const readable = notes.filter(n => n.sizeBytes <= MAX_NOTE_BYTES && !n.cloudOnly).map(n => n.path)
    const cloudNow = readable.length > 0 ? await safeCloudCheck(this.cloudOnly, readable) : new Set<string>()
    signal?.throwIfAborted()

    const ql = q.toLowerCase()
    const hits: NoteHit[] = []
    await forEachParallel(notes, 4, signal, async n => {
      const hit = await matchNote(n, ql, cloudNow, signal)
      if (hit) {
        hits.push(hit)
        onHit?.(hit)
      }
    })
    return hits
  }

  /** Removes the given note files (through `remover`, e.g. to the Recycle Bin).
   *  Only *.md files are touched; each failure is reported and the rest continue. */
  static async deleteNotes(notes: Iterable<NoteFile>, remover: FileRemover): Promise<ExecuteResult> {
    const done: string[] = []
    const failures: { path: string; error: string }[] = []
    const seen = new Set<string>()
    for (const n of notes) {
      const key = n.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      try {
        if (!key.endsWith('.md')) throw new Error('Not a .md file.')
        await remover.removeFile(n.path)
        done.push(n.path)
      } catch (e) {
        failures.push({ path: n.path, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { done, failures, backupDir: null }
  }
}

async function matchNote(n: NoteFile, ql: string, cloudNow: Set<string>, signal?: AbortSignal): Promise<NoteHit | null> {
  const nameMatch = n.relativePath.toLowerCase().includes(ql)
  let count = 0
  let first = 0
  let firstText = ''
  const nameOnly = (): NoteHit | null =>
    nameMatch ? { note: n, matchCount: 0, firstLineNumber: 0, firstLineText: '', nameMatch: true } : null
  if (n.sizeBytes <= MAX_NOTE_BYTES && !n.cloudOnly) {
    try {
      const st = await fsp.stat(n.path)
      if (st.size > MAX_NOTE_BYTES || cloudNow.has(n.path)) return nameOnly()
      let text = (await fsp.readFile(n.path)).toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const lines = text.split(/\r\n|\n|\r/)
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      for (let i = 0; i < lines.length; i++) {
        if ((i & 1023) === 0) signal?.throwIfAborted()
        const line = lines[i]!
        if (!line.toLowerCase().includes(ql)) continue
        if (count++ === 0) { first = i + 1; firstText = line.trim() }
      }
    } catch (e) {
      if (signal?.aborted) throw e
      // unreadable / vanished: no content match
    }
  }
  signal?.throwIfAborted()
  return count > 0 || nameMatch ? { note: n, matchCount: count, firstLineNumber: first, firstLineText: firstText, nameMatch } : null
}

/** A failing check must never let a cloud file be read: treat every file as cloud-only. */
async function safeCloudCheck(check: CloudOnlyCheck, files: string[]): Promise<Set<string>> {
  try { return await check(files) } catch { return new Set(files) }
}

/** The OneDrive roots from the environment (OneDrive, OneDriveConsumer, OneDriveCommercial). */
export function oneDriveRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const v = env[k]
    if (v && isFullyQualified(v) && !out.some(o => isSamePath(o, v))) out.push(v)
  }
  return out
}

/** Runs a PowerShell script hidden, feeding `input` on stdin; resolves stdout. */
export type PowerShellRunner = (script: string, input: string) => Promise<string>

export const runHiddenPowerShell: PowerShellRunner = (script, input) => new Promise((resolve, reject) => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = execFile('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout) => { if (err) reject(err); else resolve(String(stdout)) })
  child.stdin?.on('error', () => { /* surfaced through the exit callback */ })
  child.stdin?.end(input, 'utf8')
})

/** Reads UTF-8 paths (one per line) from stdin; prints the 0-based index of
 *  every file whose attributes have a cloud bit, or that can't be checked.
 *  GetAttributes reads metadata only; it never recalls file data. */
const CLOUD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$mask = ${CLOUD_ATTRIBUTES}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$i = 0
while ($null -ne ($line = $in.ReadLine())) {
  try {
    if (([int][System.IO.File]::GetAttributes($line) -band $mask) -ne 0) { $out.WriteLine($i) }
  } catch { $out.WriteLine($i) }
  $i++
}
$out.WriteLine('done')
$out.Flush()
`

/** The default cloud-only check: one hidden PowerShell attribute query per
 *  call, for the files under a OneDrive root only (other files are never
 *  placeholders here and aren't queried). If the query fails, every queried
 *  file counts as cloud-only, so it's never read. */
export function oneDriveCloudCheck(roots: () => string[] = () => oneDriveRoots(),
  run: PowerShellRunner = runHiddenPowerShell): CloudOnlyCheck {
  return async files => {
    const r = roots()
    const candidates = r.length === 0 ? [] : files.filter(f => r.some(root => isSameOrUnder(f, root)))
    const result = new Set<string>()
    if (candidates.length === 0) return result
    let out: string
    try {
      out = await run(CLOUD_SCRIPT, candidates.join('\n') + '\n')
    } catch {
      return new Set(candidates)
    }
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
    if (lines[lines.length - 1] !== 'done') return new Set(candidates) // cut short: can't tell
    for (const l of lines) {
      const i = Number(l)
      if (Number.isInteger(i) && i >= 0 && i < candidates.length) result.add(candidates[i]!)
    }
    return result
  }
}

/** Full path, `..` resolved, normalized (no trailing separator). */
function full(p: string): string {
  return normalizePath(win32.resolve(p))
}

/** Same-or-under for paths already normalized by `full` (no per-call regex on the hot path). */
function under(path: string, root: string): boolean {
  const p = path.toLowerCase()
  const r = root.toLowerCase()
  return p === r || p.startsWith(r.endsWith('\\') ? r : r + '\\')
}

/** `D:\` or `\\server\share`. */
function pathRoot(p: string): string {
  const unc = /^\\\\[^\\]+(?:\\[^\\]+)?/.exec(p)
  if (unc) return unc[0]
  const drive = /^[A-Za-z]:\\?/.exec(p)
  return drive ? drive[0] : ''
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isDirectory() } catch { return false }
}

/** True for a symlink or junction (it has a link target); false for other
 *  reparse points such as cloud placeholder folders. */
async function hasLinkTarget(p: string): Promise<boolean> {
  try { await fsp.readlink(p); return true } catch { return false }
}
