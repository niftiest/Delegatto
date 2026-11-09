import { statSync } from 'node:fs'
import type { Catalog } from '../catalog/db'
import { discover, readSubagentMeta, claudeHome, type DiscoveredFile } from '../indexer/discover'
import { indexFile } from '../indexer/index-file'
import { syncSessionToCatalog } from './catalog-sync'

/** Keeps the catalog current with transcripts written OUTSIDE Delegatto (a
 *  `claude` terminal session continuing a chat, or a brand-new one). The
 *  catalog is otherwise only advanced by the startup `runIndex()` and by
 *  Delegatto's own live-turn watcher, so without this a chat used from a
 *  terminal stays frozen at whatever the app saw at launch -- stale
 *  transcript, stale nav preview, stale "Today" ordering.
 *
 *  Cheap by construction: a sweep is one directory walk + one `stat` per
 *  transcript (OS-cached metadata, no file reads), compared against the
 *  size/mtime the catalog last recorded. Only files that actually changed are
 *  re-indexed, and `indexFile` reads only the bytes appended since the stored
 *  offset. Electron-free (see tests/architecture.test.ts). */

type StoredStat = { size: number; mtimeMs: number }

/** True when `file` differs from what the catalog last recorded for it (or
 *  the catalog has never seen it). */
function hasChanged(file: { filePath: string; size: number; mtimeMs: number }, stored: StoredStat | undefined): boolean {
  return stored === undefined || stored.size !== file.size || stored.mtimeMs !== file.mtimeMs
}

function loadStoredStats(db: Catalog): Map<string, StoredStat> {
  const rows = db.prepare('SELECT file_path AS p, file_size AS size, file_mtime_ms AS mtimeMs FROM sessions')
    .all() as Array<{ p: string; size: number; mtimeMs: number }>
  return new Map(rows.map(r => [r.p, { size: r.size, mtimeMs: r.mtimeMs }]))
}

export type SweepResult = {
  /** sessionPks of top-level chats whose catalog entry changed this sweep. */
  changedMain: number[]
  /** Count of subagent transcripts re-indexed (they feed nested tool cards,
   *  not the nav, so callers generally only need the count). */
  changedSubagents: number
}

/** One sweep over ~/.claude/projects. `skip(filePath)` lets the caller exclude
 *  transcripts it is already tracking live (a Delegatto turn mid-stream),
 *  so the sweep never races that turn's own watcher-driven indexing. A
 *  per-file failure is logged and skipped, never thrown -- the file keeps its
 *  old stored stat, so the next sweep simply retries it. */
export async function sweepExternalChanges(
  db: Catalog,
  opts: { home?: string; skip?: (filePath: string) => boolean } = {}
): Promise<SweepResult> {
  const stored = loadStoredStats(db)
  const differing = discover(opts.home ?? claudeHome(), { readMeta: false }).filter(f => hasChanged(f, stored.get(f.filePath)))
  const skipped = differing.filter(f => opts.skip?.(f.filePath) ?? false)
  const changed = differing.filter(f => !skipped.includes(f))
  if (skipped.length > 0) console.log(`[sweep] left for later, a reply is running: ${skipped.map(f => f.filePath).join(", ")}`)
  // Main transcripts first so a new subagent's toolUseId resolves against a
  // present parent (same ordering runIndex uses).
  changed.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1))

  const result: SweepResult = { changedMain: [], changedSubagents: 0 }
  for (const file of changed) {
    const toIndex: DiscoveredFile = file.kind === 'subagent'
      ? { ...file, meta: readSubagentMeta(file.filePath) }
      : file
    try {
      const r = await indexFile(db, toIndex)
      if (file.kind === 'main') result.changedMain.push(r.sessionPk)
      else result.changedSubagents++
    } catch (err) {
      console.error(`[external-sync] failed to index ${file.filePath}:`, err)
    }
  }
  if (result.changedMain.length > 0) console.log(`[sweep] re-indexed chats ${result.changedMain.join(", ")}`)
  return result
}

/** Refresh-on-open: if the session's transcript on disk differs from what the
 *  catalog last recorded, advance the catalog before the transcript is
 *  loaded. Returns true when it re-indexed (so the caller can refresh the nav
 *  too), false when already current or the file is missing/unknown. */
export async function syncSessionIfStale(db: Catalog, sessionPk: number): Promise<boolean> {
  const row = db.prepare('SELECT file_path AS p, file_size AS size, file_mtime_ms AS mtimeMs FROM sessions WHERE id = ?')
    .get(sessionPk) as { p: string; size: number; mtimeMs: number } | undefined
  if (row === undefined) return false
  let size: number, mtimeMs: number
  try {
    const st = statSync(row.p)
    size = st.size; mtimeMs = st.mtimeMs
  } catch {
    return false // missing file -- loadTranscript reports fileMissing itself
  }
  if (!hasChanged({ filePath: row.p, size, mtimeMs }, { size: row.size, mtimeMs: row.mtimeMs })) return false
  try {
    return (await syncSessionToCatalog(db, sessionPk)) !== null
  } catch (err) {
    console.error(`[external-sync] refresh-on-open failed for session ${sessionPk}:`, err)
    return false
  }
}

export type PeriodicSweep = {
  /** Run a sweep now (e.g. on window focus) unless one is already running or
   *  one finished less than `minGapMs` ago. */
  poke(): void
  dispose(): void
}

/** Runs `sweep` every `intervalMs`, single-flight (a tick that lands while a
 *  sweep is still running is dropped, never queued/overlapped). `poke()` adds
 *  an on-demand trigger -- throttled by `minGapMs` so rapid focus/blur
 *  toggling can't hammer the disk. */
export function createPeriodicSweep(
  sweep: () => Promise<void>,
  opts: { intervalMs?: number; minGapMs?: number; now?: () => number } = {}
): PeriodicSweep {
  const intervalMs = opts.intervalMs ?? 30_000
  const minGapMs = opts.minGapMs ?? 5_000
  const now = opts.now ?? Date.now
  let running = false
  let disposed = false
  let lastRunAt = -Infinity

  function run(): void {
    if (running || disposed) return
    running = true
    lastRunAt = now()
    sweep()
      .catch(err => console.error('[external-sync] sweep failed', err))
      .finally(() => { running = false })
  }

  const timer = setInterval(run, intervalMs)
  // Never keep the app process alive just for this timer.
  timer.unref?.()

  return {
    poke(): void {
      if (now() - lastRunAt < minGapMs) return
      run()
    },
    dispose(): void {
      disposed = true
      clearInterval(timer)
    }
  }
}
