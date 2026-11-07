import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where Claude Code keeps its data (port of ClaudeMemoryTool's ClaudePaths).
 *  Electron-free: everything under src/main/manage is unit-tested against a
 *  fake tree built by tests/manage/fake-tree.ts, never the real ~/.claude. */
export type ClaudePaths = {
  claudeDir: string
  claudeJson: string
  tempClaudeDir: string
  projectsDir: string
  historyFile: string
  sessionsDir: string
  jobsDir: string
  backupsDir: string
  /** Zips made by Delete's "Create a restore point first". */
  restorePointsDir: string
}

function build(claudeDir: string, claudeJson: string, tempClaudeDir: string): ClaudePaths {
  const backupsDir = join(claudeDir, 'backups', 'memory-tool')
  return {
    claudeDir, claudeJson, tempClaudeDir,
    projectsDir: join(claudeDir, 'projects'),
    historyFile: join(claudeDir, 'history.jsonl'),
    sessionsDir: join(claudeDir, 'sessions'),
    jobsDir: join(claudeDir, 'jobs'),
    backupsDir,
    restorePointsDir: join(backupsDir, 'restore-points')
  }
}

export function defaultPaths(): ClaudePaths {
  const home = homedir()
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside it too.
  return build(claudeDir, join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json'), join(tmpdir(), 'claude'))
}

/** A fake profile rooted at `root` (tests). */
export function pathsFor(root: string): ClaudePaths {
  return build(join(root, '.claude'), join(root, '.claude.json'), join(root, 'temp', 'claude'))
}

/** Claude Code's project folder name: every char outside [A-Za-z0-9] becomes '-'. */
export function encodePath(workingDir: string): string {
  return workingDir.replace(/[^A-Za-z0-9]/g, '-')
}

const SEP = '\\'

/** Backslashes, MSYS `/d/x` -> `D:\x`, no trailing separator except a drive root. */
export function normalizePath(p: string): string {
  if (!p) return ''
  p = p.replace(/\//g, SEP)
  const m = /^\\([A-Za-z])(?=\\|$)/.exec(p)
  if (m) p = m[1]!.toUpperCase() + ':' + p.slice(m[0].length)
  const driveRoot = p.length === 3 && p[1] === ':' && p[2] === SEP
  if (!driveRoot) p = p.replace(/\\+$/, '')
  if (p.length === 2 && p[1] === ':') p += SEP
  return p
}

export function isSamePath(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
}

/** Prefix-on-separator: `D:\X` matches `D:\X` and `D:\X\sub`, never `D:\X.com`. */
export function isSameOrUnder(candidate: string, root: string): boolean {
  const c = normalizePath(candidate).toLowerCase()
  const r = normalizePath(root).toLowerCase()
  if (r.length === 0) return false
  if (c === r) return true
  return c.startsWith(r.endsWith(SEP) ? r : r + SEP)
}

/** Replaces oldRoot with newRoot, keeping the tail. Caller ensures candidate is same-or-under oldRoot. */
export function replacePrefix(candidate: string, oldRoot: string, newRoot: string): string {
  const c = normalizePath(candidate)
  const o = normalizePath(oldRoot)
  let tail = c.slice(Math.min(o.length, c.length))
  const n = normalizePath(newRoot)
  if (n.endsWith(SEP) && tail.startsWith(SEP)) tail = tail.slice(1)
  return n + tail
}

/** `C:\...` or a UNC `\\server\share...` (after normalization). */
export function isFullyQualified(p: string): boolean {
  const n = normalizePath(p)
  return /^[A-Za-z]:\\/.test(n) || n.startsWith('\\\\')
}
