import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

/** A read-only, bounded project file tree + git status for the context rail's
 *  Files tab. Deliberately shallow and capped (this is a glance, not a file
 *  manager) and walked on demand -- no watcher yet. Pure-ish: takes a cwd and
 *  returns a flat, depth-tagged list the renderer indents. */
export type FsEntry = {
  name: string
  relPath: string
  depth: number
  isDir: boolean
  /** git porcelain status letter (M/A/D/?/…) or null when clean/unknown. */
  git: string | null
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', 'coverage', '.cache'])
const MAX_DEPTH = 2
const MAX_ENTRIES = 400

/** Map `git status --porcelain` output to { relPath -> status letter }. The
 *  first non-space of the two-column XY code is the status we surface (`??` ->
 *  `?`). Paths use forward slashes from git; we normalise to the OS separator
 *  so they match the walked relPaths. Never throws -- a non-repo or missing git
 *  just yields an empty map. */
function gitStatusMap(cwd: string): Map<string, string> {
  const map = new Map<string, string>()
  let out: string
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd, encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch { return map }
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2).trim()
    let path = line.slice(3).trim()
    if (path.includes('->')) path = path.slice(path.indexOf('->') + 2).trim() // renames: keep the new name
    if ((path.startsWith('"') && path.endsWith('"'))) path = path.slice(1, -1)
    const letter = code[0] === ' ' ? code[1] : code[0]
    if (letter) map.set(path.split('/').join(sep), letter)
  }
  return map
}

function walk(root: string, dir: string, depth: number, git: Map<string, string>, out: FsEntry[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  // Dirs first, then files, each alphabetical -- a stable, glanceable order.
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return
    if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.gitignore') { if (SKIP.has(e.name)) continue }
    if (SKIP.has(e.name)) continue
    const abs = join(dir, e.name)
    const relPath = relative(root, abs)
    const isDir = e.isDirectory()
    out.push({ name: e.name, relPath, depth, isDir, git: git.get(relPath) ?? null })
    if (isDir) walk(root, abs, depth + 1, git, out)
  }
}

export function readFsTree(cwd: string | null | undefined): FsEntry[] {
  if (typeof cwd !== 'string' || cwd.length === 0) return []
  const out: FsEntry[] = []
  walk(cwd, cwd, 0, gitStatusMap(cwd), out)
  return out
}
