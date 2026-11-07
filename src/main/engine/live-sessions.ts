import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Authoritative "is a session running elsewhere" check, replacing Plan 2's
 *  interim mtime heuristic. Claude Code writes `~/.claude/sessions/<pid>.json`
 *  for every live process: `{pid, sessionId, cwd, status}`. A session is
 *  externally live iff some sessions file names its sessionId with a PID that
 *  is still running AND our own pool doesn't own it (we spawned it ourselves).
 *  Everything here is pure/injectable so it's unit-testable without a real
 *  ~/.claude or real processes. */

export type LiveSessionEntry = {
  pid: number; sessionId: string; cwd: string; status?: string
  /** How the process was launched: 'sdk-cli' is Delegatto's own headless
   *  spawn; 'cli' is a normal interactive terminal session. Used by the
   *  stale-lock sweep to only clean up Delegatto's own leftovers. */
  entrypoint?: string
  /** Epoch ms the process started (written by the CLI). Used to attribute an
   *  `sdk-cli` lock to Delegatto's own spawn when its pid isn't the one we
   *  spawned (see isOwnLock). */
  startedAt?: number
  /** The process start time the CLI recorded, as a Windows FILETIME (100 ns
   *  ticks since 1601, UTC) in canonical decimal form. A string, not a number:
   *  FILETIMEs exceed 2^53 and must compare exactly (pid-reuse check before
   *  ending a process). Absent on older CLI versions. */
  procStart?: string
  /** The session's display name, when the CLI recorded a non-empty one. */
  name?: string
  /** Set while the session is under Remote Control (`/rc` / --remote-control):
   *  the claude.ai bridge session it's paired with. Verified against real lock
   *  files: present on remote-controlled sessions, absent otherwise. */
  bridgeSessionId?: string
}

const INT64_MAX = 9223372036854775807n

/** `procStart` as Claude Code writes it -- a decimal string (current CLI) or a
 *  JSON number -- in canonical decimal form, or undefined when absent/invalid.
 *  A JSON number past 2^53 has already lost digits in `JSON.parse`, so pass the
 *  file's `rawText` to recover the exact literal. Mirrors the C# tool: a string
 *  must be plain digits (no sign/space), a number any int64. */
export function parseProcStart(value: unknown, rawText?: string): string | undefined {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return undefined
    const n = BigInt(value)
    return n <= INT64_MAX ? n.toString() : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  let literal: string | undefined
  if (Number.isSafeInteger(value)) literal = String(value)
  else if (rawText !== undefined) {
    const m = /"procStart"\s*:\s*(-?\d+)\s*[,}]/.exec(rawText)
    // Only trust the literal when it is the number JSON.parse saw.
    if (m && Number(m[1]) === value) literal = m[1]
  }
  if (literal === undefined) return undefined
  const n = BigInt(literal)
  return n <= INT64_MAX && n >= -INT64_MAX - 1n ? n.toString() : undefined
}

/** Read + tolerantly parse every sessions/*.json entry. Malformed files are
 *  skipped, never thrown. */
export function readLiveSessions(sessionsDir: string): LiveSessionEntry[] {
  let files: string[]
  try { files = readdirSync(sessionsDir) } catch { return [] }
  const out: LiveSessionEntry[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const text = readFileSync(join(sessionsDir, f), 'utf8')
      const raw = JSON.parse(text) as unknown
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      if (typeof r.pid !== 'number' || typeof r.sessionId !== 'string') continue
      const procStart = parseProcStart(r.procStart, text)
      out.push({
        pid: r.pid,
        sessionId: r.sessionId,
        cwd: typeof r.cwd === 'string' ? r.cwd : '',
        status: typeof r.status === 'string' ? r.status : undefined,
        entrypoint: typeof r.entrypoint === 'string' ? r.entrypoint : undefined,
        startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
        ...(procStart !== undefined ? { procStart } : {}),
        ...(typeof r.name === 'string' && r.name.length > 0 ? { name: r.name } : {}),
        ...(typeof r.bridgeSessionId === 'string' && r.bridgeSessionId.length > 0 ? { bridgeSessionId: r.bridgeSessionId } : {})
      })
    } catch { /* skip malformed */ }
  }
  return out
}

/** True if `pid` is a running process. `process.kill(pid, 0)` throws ESRCH when
 *  the process is gone, EPERM when it exists but we can't signal it (still
 *  alive). Injectable for tests. */
export function isPidAlive(pid: number, killFn: (pid: number, signal: number) => void = process.kill): boolean {
  try { killFn(pid, 0); return true } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The session id embedded in a session file path: `.../<sessionId>.jsonl`. */
export function sessionIdFromFilePath(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/i, '')
}

/** Remove Delegatto's OWN orphaned session-lock files: a
 *  `~/.claude/sessions/<pid>.json` written by a headless spawn (`entrypoint:
 *  'sdk-cli'`) whose PID is no longer running. The `claude` CLI removes this
 *  file itself on a clean exit, but Delegatto's pooled process didn't always
 *  exit cleanly (hard-killed on reap/quit/crash), leaving a dead lock that
 *  makes a later `claude --continue` in that dir report "no previous
 *  conversation". Deliberately scoped to `sdk-cli` + dead-PID only, so it never
 *  touches a real interactive terminal's lock or a still-running process.
 *  Returns the number of files removed. Fully injectable for testing. */
export function sweepStaleSdkLocks(
  sessionsDir: string,
  deps: {
    readSessions?: (dir: string) => LiveSessionEntry[]
    isAlive?: (pid: number) => boolean
    unlink?: (path: string) => void
  } = {}
): number {
  const read = deps.readSessions ?? readLiveSessions
  const alive = deps.isAlive ?? ((pid: number) => isPidAlive(pid))
  const rm = deps.unlink ?? ((p: string) => { try { unlinkSync(p) } catch { /* already gone */ } })
  let removed = 0
  for (const s of read(sessionsDir)) {
    if (s.entrypoint === 'sdk-cli' && !alive(s.pid)) {
      // The CLI names each lock file `<pid>.json`.
      rm(join(sessionsDir, `${s.pid}.json`))
      removed++
    }
  }
  return removed
}

/** One of Delegatto's own pooled `claude` processes, as the pool reports it. */
export type OwnedProcess = { sessionKey: string; pid: number | null; startedAt: number }

/** How far before our own spawn time a lock's `startedAt` may be and still be
 *  attributed to that spawn (clock granularity / write ordering slack). */
const OWN_LOCK_SLACK_MS = 2_000

/** Whether a lock entry for `sessionKey` belongs to Delegatto's own pool.
 *
 *  The pid the pool spawned is NOT guaranteed to be the pid in the lock file:
 *  observed on Windows, a `claude.exe` can relaunch itself as a child and the
 *  CHILD writes the lock. So a pid match is sufficient but not necessary. The
 *  fallback: an `sdk-cli` (headless/SDK) lock for a session our pool owns,
 *  started no earlier than our spawn, is ours. A terminal (`entrypoint: 'cli'`)
 *  is never ours. Residual blind spot: another SDK host (e.g. a second
 *  Delegatto) resuming the same chat while ours is pooled is misattributed. */
export function isOwnLock(entry: LiveSessionEntry, sessionKey: string, owned: OwnedProcess[]): boolean {
  if (owned.some(o => o.pid !== null && o.pid === entry.pid)) return true
  if (entry.entrypoint !== 'sdk-cli') return false
  const mine = owned.find(o => o.sessionKey === sessionKey)
  return mine !== undefined && entry.startedAt !== undefined && entry.startedAt >= mine.startedAt - OWN_LOCK_SLACK_MS
}

export type LockDeps = {
  sessionsDir: string
  /** Delegatto's own live processes (the pool snapshot). */
  owned: () => OwnedProcess[]
  readSessions?: (dir: string) => LiveSessionEntry[]
  isAlive?: (pid: number) => boolean
}

/** The live lock some process OUTSIDE Delegatto holds on this session, or
 *  null. Unlike the old "does our pool own it?" short-circuit, this still
 *  finds a terminal that resumed a chat while Delegatto's own process for it
 *  sat idle in the pool -- each lock entry is judged on its own. */
export function findExternalLock(filePath: string, deps: LockDeps, sessions?: LiveSessionEntry[]): LiveSessionEntry | null {
  const sessionId = sessionIdFromFilePath(filePath)
  const all = sessions ?? (deps.readSessions ?? readLiveSessions)(deps.sessionsDir)
  const alive = deps.isAlive ?? ((pid: number) => isPidAlive(pid))
  const owned = deps.owned()
  return all.find(s => s.sessionId === sessionId && !isOwnLock(s, filePath, owned) && alive(s.pid)) ?? null
}

/** The authoritative external-live decision (send-time guard). */
export function isExternallyLiveSession(filePath: string, deps: LockDeps): boolean {
  return findExternalLock(filePath, deps) !== null
}
