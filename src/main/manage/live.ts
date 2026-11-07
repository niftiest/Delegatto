import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudePaths } from './paths'
import { isPidAlive, parseProcStart } from '../engine/live-sessions'

/** Running Claude Code sessions, from the `~/.claude/sessions/<pid>.json` locks
 *  (port of ClaudeMemoryTool's LiveSessionDetector). Delete / Rename / project
 *  Import refuse to run while any of these exist.
 *
 *  Unlike the engine's `readLiveSessions` (which needs a sessionId to map a lock
 *  to a chat), this errs on the side of "live": a lock with no sessionId still
 *  counts, and an unreadable/unparseable `<pid>.json` falls back to the pid in
 *  its file name -- "can't tell" must never let a delete through. */
export type LiveSession = {
  pid: number
  /** '' when the lock didn't record one (or couldn't be read). */
  sessionId: string
  cwd: string
  name: string | null
  /** Recorded process start (FILETIME UTC, canonical decimal), or null on
   *  older CLI versions / unreadable locks. Tells the session's own process
   *  apart from a later one that reused the pid. */
  procStart: string | null
}

const INT32_MAX = 2147483647

export function getLiveSessions(paths: ClaudePaths, isAlive: (pid: number) => boolean = defaultIsAlive): LiveSession[] {
  let files: string[]
  try { files = readdirSync(paths.sessionsDir) } catch { return [] }
  const result: LiveSession[] = []
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.json')) continue
    const s = tryRead(join(paths.sessionsDir, f)) ?? fromFileName(f)
    if (s !== null && isAlive(s.pid)) result.push(s)
  }
  return result
}

function validPid(v: unknown): v is number {
  // Positive only: process.kill(pid <= 0) means a process group on POSIX.
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= INT32_MAX
}

function tryRead(file: string): LiveSession | null {
  let text: string
  let root: unknown
  try {
    text = readFileSync(file, 'utf8')
    root = JSON.parse(text)
  } catch { return null }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return null
  const r = root as Record<string, unknown>
  if (!validPid(r.pid)) return null
  const str = (k: string): string => typeof r[k] === 'string' ? r[k] as string : ''
  const name = str('name')
  return {
    pid: r.pid, sessionId: str('sessionId'), cwd: str('cwd'),
    name: name.length === 0 ? null : name,
    procStart: parseProcStart(r.procStart, text) ?? null
  }
}

function fromFileName(f: string): LiveSession | null {
  const stem = f.slice(0, -'.json'.length)
  if (!/^\d+$/.test(stem)) return null
  const pid = Number(stem)
  return validPid(pid) ? { pid, sessionId: '', cwd: '', name: null, procStart: null } : null
}

/** Running, or exists but can't be signalled (access denied counts as live). */
function defaultIsAlive(pid: number): boolean {
  return isPidAlive(pid)
}
