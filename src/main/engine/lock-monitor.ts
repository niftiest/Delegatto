import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { mkdirSync } from 'node:fs'
import type { ExternalLock, RemoteSession } from '../../shared/engine-types'
import { readLiveSessions, isPidAlive, findExternalLock, type LiveSessionEntry, type OwnedProcess } from './live-sessions'

/** Tracks which chats are held open by a `claude` process OUTSIDE Delegatto
 *  (a terminal), so the UI can make them read-only while that lasts.
 *
 *  Event-driven: Claude Code writes/updates/removes `~/.claude/sessions/
 *  <pid>.json` as processes start, change status, and exit, so a chokidar
 *  watch on that directory sees takeovers and releases within ~200ms. A
 *  process that dies WITHOUT removing its lock (crash, kill -9) produces no
 *  fs event -- `refresh()` re-checks PID liveness, and the caller re-runs it
 *  on its periodic sweep to catch those. Electron-free (architecture test). */

export type LockTarget = { sessionPk: number; filePath: string; projectId: number }

export type LockMonitorOpts = {
  sessionsDir: string
  /** Delegatto's own live processes (pool snapshot) -- never reported. */
  owned: () => OwnedProcess[]
  /** Maps a lock's sessionId to the catalog's top-level chat, or null when
   *  the catalog doesn't know it yet (a brand-new terminal chat, picked up by
   *  the next sweep; the caller refreshes after sweeping). */
  resolve: (sessionId: string) => LockTarget | null
  /** Fires only on a CHANGE in a chat's lock state (acquired, released, or
   *  a different holder/status). */
  onChange: (target: LockTarget, lock: ExternalLock | null) => void
  /** Fires when the set of chats under Remote Control (/rc) changes. Any live
   *  process counts here -- a terminal or Delegatto's own. */
  onRemoteChange?: (remote: RemoteSession[]) => void
  debounceMs?: number
  readSessions?: (dir: string) => LiveSessionEntry[]
  isAlive?: (pid: number) => boolean
}

function sameLock(a: ExternalLock | undefined, b: ExternalLock | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.pid === b.pid && a.entrypoint === b.entrypoint && a.status === b.status
}

export class LockMonitor {
  private readonly opts: LockMonitorOpts
  private readonly current = new Map<number, { target: LockTarget; lock: ExternalLock }>()
  private remote: RemoteSession[] = []
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(opts: LockMonitorOpts) {
    this.opts = opts
  }

  /** Starts watching the sessions directory and runs an initial refresh. */
  start(): void {
    // chokidar never notices a directory created after watch() if it didn't
    // exist at watch time (same finding as SessionWatcher), so ensure it.
    try { mkdirSync(this.opts.sessionsDir, { recursive: true }) } catch { /* degrade to refresh-only */ }
    const w = chokidarWatch(this.opts.sessionsDir, { ignoreInitial: true, depth: 0 })
    const schedule = (path: string): void => { if (path.endsWith('.json')) this.scheduleRefresh() }
    w.on('add', schedule)
    w.on('change', schedule)
    w.on('unlink', schedule)
    w.on('error', (err) => console.warn('[lock-monitor] watch error', err))
    this.watcher = w
    this.refresh()
  }

  private scheduleRefresh(): void {
    if (this.disposed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.refresh() }, this.opts.debounceMs ?? 200)
  }

  /** Recomputes every chat's external-lock state and fires onChange for each
   *  chat whose state differs from the last refresh. Synchronous and cheap:
   *  one readdir + a handful of tiny JSON reads. Never throws. */
  refresh(): void {
    if (this.disposed) return
    let sessions: LiveSessionEntry[]
    try {
      sessions = (this.opts.readSessions ?? readLiveSessions)(this.opts.sessionsDir)
    } catch (err) {
      console.warn('[lock-monitor] failed to read sessions', err)
      return
    }
    const alive = this.opts.isAlive ?? ((pid: number) => isPidAlive(pid))
    const deps = { sessionsDir: this.opts.sessionsDir, owned: this.opts.owned, isAlive: alive }

    const next = new Map<number, { target: LockTarget; lock: ExternalLock }>()
    for (const sessionId of new Set(sessions.map(s => s.sessionId))) {
      const target = this.opts.resolve(sessionId)
      if (target === null) continue
      const ext = findExternalLock(target.filePath, deps, sessions)
      if (ext === null) continue
      next.set(target.sessionPk, {
        target,
        lock: { pid: ext.pid, entrypoint: ext.entrypoint ?? null, status: ext.status ?? null }
      })
    }

    // Remote Control: any live lock (ours or not) carrying a bridge session.
    const remote: RemoteSession[] = []
    const seenRemote = new Set<number>()
    for (const s of sessions) {
      if (s.bridgeSessionId === undefined || !alive(s.pid)) continue
      const target = this.opts.resolve(s.sessionId)
      if (target === null || seenRemote.has(target.sessionPk)) continue
      seenRemote.add(target.sessionPk)
      remote.push({ sessionPk: target.sessionPk, projectId: target.projectId })
    }
    remote.sort((a, b) => a.sessionPk - b.sessionPk)
    const remoteChanged = remote.length !== this.remote.length ||
      remote.some((r, i) => r.sessionPk !== this.remote[i]!.sessionPk)
    this.remote = remote

    const prev = new Map(this.current)
    this.current.clear()
    for (const [pk, v] of next) this.current.set(pk, v)

    for (const [pk, v] of next) {
      if (!sameLock(prev.get(pk)?.lock, v.lock)) this.opts.onChange(v.target, v.lock)
    }
    for (const [pk, v] of prev) {
      if (!next.has(pk)) this.opts.onChange(v.target, null)
    }
    if (remoteChanged) this.opts.onRemoteChange?.(remote)
  }

  /** Chats under Remote Control as of the last refresh. */
  getRemote(): RemoteSession[] {
    return this.remote
  }

  /** The chat's lock as of the last refresh. */
  get(sessionPk: number): ExternalLock | null {
    return this.current.get(sessionPk)?.lock ?? null
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const w = this.watcher
    this.watcher = null
    if (w !== null) void w.close().catch(() => {})
  }
}
