import { existsSync, statSync } from 'node:fs'
import type { Catalog } from '../catalog/db'
import { indexFile, type IndexFileResult } from '../indexer/index-file'
import type { DiscoveredMain } from '../indexer/discover'

/** Task 10 review Finding 1's fix: `loadTranscript` (src/main/ipc.ts) only
 *  ever reads from the SQLite catalog, and the catalog is only ever populated
 *  by `runIndex()`/`indexFile()` -- which, before this module existed, ran
 *  exactly once at app mount. A live turn's watcher tails new durable rows
 *  and streams them to the renderer for immediate display, but nothing
 *  re-indexed the file into the catalog -- so switching away from a session
 *  mid/post-turn and back showed whatever the catalog had at mount, forever
 *  stale for any session with live turns. This module is the targeted,
 *  single-session catalog advance engine-ipc.ts calls on the live-turn row/
 *  event stream, reusing the SAME incremental `indexFile` the full-archive
 *  `runIndex()` walk uses -- never a second full re-walk of ~/.claude.
 *
 *  Electron-free (architecture.test.ts enforces this for all of
 *  src/main/engine except *-ipc.ts files) so it's unit-testable with a plain
 *  :memory: catalog and a real temp file, independent of engine-ipc's real
 *  webContents wiring. */

/** Looks up the catalog row for `sessionPk` and builds the minimal
 *  DiscoveredMain record `indexFile` needs to advance that one session's
 *  indexed offset -- without re-running `discover()`'s full filesystem walk.
 *  Returns null when the catalog has no row for this sessionPk (a stale/
 *  deleted reference -- e.g. a race with a prune) or its `file_path` doesn't
 *  exist on disk right now (the watcher fired before the file was flushed, or
 *  it was removed out from under the app): both degrade to "nothing to sync"
 *  rather than throwing, since this runs on every live-turn row batch and a
 *  transient miss must never crash engine-ipc's event wiring.
 *
 *  Subagent sessions are out of scope here: the coordinator only ever spawns
 *  and watches top-level chat sessions (`kind = 'main'`), so this always
 *  builds a `DiscoveredMain`, never a `DiscoveredSubagent`. */
export function buildDiscoveredFileForSession(db: Catalog, sessionPk: number): DiscoveredMain | null {
  const row = db.prepare(`
    SELECT s.file_path AS filePath, s.session_id AS sessionId, p.dir_name AS dirName
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(sessionPk) as { filePath: string; sessionId: string; dirName: string } | undefined
  if (row === undefined || !existsSync(row.filePath)) return null

  const st = statSync(row.filePath)
  return {
    kind: 'main',
    projectDir: row.dirName,
    sessionId: row.sessionId,
    filePath: row.filePath,
    size: st.size,
    mtimeMs: st.mtimeMs
  }
}

/** Advances one session's catalog entry from its stored `indexed_offset`,
 *  reusing `indexFile` -- the same incremental indexer `runIndex()` calls per
 *  file, so this is cheap (reads only appended bytes) and idempotent (safe to
 *  call repeatedly; a no-op past the file's current end reports `skipped`).
 *  Returns null (a no-op) when the session can't be resolved to a file on
 *  disk right now -- see `buildDiscoveredFileForSession`. */
export async function syncSessionToCatalog(db: Catalog, sessionPk: number): Promise<IndexFileResult | null> {
  const file = buildDiscoveredFileForSession(db, sessionPk)
  if (file === null) return null
  return indexFile(db, file)
}

export type IndexDebouncer = {
  /** Schedules a catalog sync for `sessionPk`, collapsing a burst of calls
   *  within the debounce window into at most one `indexFile` pass --
   *  `indexFile` is idempotent via its stored offset, but there's no reason
   *  to hammer it on every row batch of a fast-streaming turn. A repeated
   *  call for the SAME sessionPk before the window elapses resets the timer
   *  (trailing debounce); calls for a DIFFERENT sessionPk run independently. */
  schedule(sessionPk: number): void
  /** Runs the sync for `sessionPk` right away, cancelling any pending
   *  debounced call for it first -- used on a turn's `result` event, where
   *  the catalog should be current the instant the turn settles rather than
   *  waiting out the debounce window. */
  now(sessionPk: number): void
  /** Clears every pending timer. Called from engine-ipc's `dispose()` so a
   *  torn-down window never has a stray timer fire against it later. */
  dispose(): void
}

/** Builds an `IndexDebouncer` wired to `sync` (the actual `indexFile`-based
 *  catalog advance, e.g. `syncSessionToCatalog` bound to a real db) and
 *  `onIndexed` (invoked once per sync that actually resolved a file, with the
 *  sessionPk, so a caller can e.g. tell the renderer to reload). Kept
 *  electron-free and fully injectable so the debounce/collapse behavior is
 *  unit-testable with fake timers against a plain callback, independent of
 *  engine-ipc's real webContents.send. */
export function createIndexDebouncer(
  sync: (sessionPk: number) => Promise<IndexFileResult | null>,
  onIndexed: (sessionPk: number) => void,
  debounceMs = 150
): IndexDebouncer {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function run(sessionPk: number): void {
    void sync(sessionPk).then(result => {
      if (result !== null) onIndexed(sessionPk)
    })
  }

  return {
    schedule(sessionPk: number): void {
      const existing = timers.get(sessionPk)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(sessionPk, setTimeout(() => {
        timers.delete(sessionPk)
        run(sessionPk)
      }, debounceMs))
    },
    now(sessionPk: number): void {
      const existing = timers.get(sessionPk)
      if (existing !== undefined) {
        clearTimeout(existing)
        timers.delete(sessionPk)
      }
      run(sessionPk)
    },
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }
}
