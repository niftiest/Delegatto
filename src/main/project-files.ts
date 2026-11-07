import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Project paths for the composer's `@` picker: forward-slashed and relative to
 *  the project, with folders ending in "/". Uses git when it can, so ignored
 *  files stay out of the list; otherwise a bounded walk. Read-only. */

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', 'coverage', '.cache', '__pycache__', '.venv'])
export const MAX_PROJECT_PATHS = 50_000

function fromGit(cwd: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.split('\0').filter(p => p.length > 0)
  } catch {
    return null // not a repo, or git isn't installed
  }
}

function fromWalk(cwd: string): string[] {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < MAX_PROJECT_PATHS) {
    const rel = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(join(cwd, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) { if (!SKIP.has(e.name)) queue.push(path) } else files.push(path)
    }
  }
  return files
}

export function listProjectFiles(cwd: string | null): string[] {
  if (cwd === null || cwd.length === 0) return []
  const files = (fromGit(cwd) ?? fromWalk(cwd)).slice(0, MAX_PROJECT_PATHS)
  const folders = new Set<string>()
  for (const file of files) {
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) folders.add(file.slice(0, i + 1))
  }
  return [...folders, ...files]
}
