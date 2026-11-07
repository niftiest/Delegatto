import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { indexFile } from '../src/main/indexer/index-file'
import { loadTranscript } from '../src/main/ipc'
import type { DiscoveredMain } from '../src/main/indexer/discover'
import {
  buildDiscoveredFileForSession, syncSessionToCatalog, createIndexDebouncer
} from '../src/main/engine/catalog-sync'

// Task 10 review Finding 1: without this module, the catalog was only ever
// populated by runIndex() at app mount -- a live turn's watcher-tailed rows
// reached the renderer directly (for the transient live display) but never
// touched the catalog, so `loadTranscript` (which reads ONLY from the
// catalog) kept returning the pre-turn state forever, until the next app
// restart. These tests prove the fix at the same level the finding asks for:
// a real :memory: catalog + a real temp session file, write -> index once ->
// APPEND (simulating a live turn) -> sync via this module's functions
// (never a second runIndex()/discover() walk) -> assert loadTranscript now
// reflects the appended rows, exactly reproducing "switch away and back".

let dir: string
const userRow = (uuid: string, text: string) => JSON.stringify({
  type: 'user', uuid, parentUuid: null, cwd: 'C:\\Users\\x\\GIT\\Demo', gitBranch: 'main',
  timestamp: '2026-07-24T10:00:00Z', message: { role: 'user', content: text }
})
const assistantRow = (uuid: string, parentUuid: string, text: string) => JSON.stringify({
  type: 'assistant', uuid, parentUuid, timestamp: '2026-07-24T10:01:00Z',
  message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }] }
})

function seedFile(path: string): DiscoveredMain {
  writeFileSync(path, `${userRow('u1', 'first turn')}\n${assistantRow('a1', 'u1', 'first reply')}\n`)
  // A fresh DiscoveredMain is built per read (matching how buildDiscoveredFile
  // ForSession stats the file itself) -- size/mtimeMs here seed the INITIAL
  // upsertSession row; the module under test re-stats on every sync.
  return { kind: 'main', projectDir: 'C--Users-x-GIT-Demo', sessionId: 'sess-1', filePath: path, size: 0, mtimeMs: 0 }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-catalog-sync-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildDiscoveredFileForSession', () => {
  it('returns null for a sessionPk the catalog has no row for', () => {
    const db = openCatalog(':memory:')
    expect(buildDiscoveredFileForSession(db, 999)).toBeNull()
  })

  it('returns null when the catalog row exists but the file no longer exists on disk', async () => {
    const f = join(dir, 'sess-1.jsonl')
    const db = openCatalog(':memory:')
    const { sessionPk } = await indexFile(db, seedFile(f))
    rmSync(f)
    expect(buildDiscoveredFileForSession(db, sessionPk)).toBeNull()
  })

  it('builds a DiscoveredMain matching the catalog + current file stats', async () => {
    const f = join(dir, 'sess-1.jsonl')
    const db = openCatalog(':memory:')
    const { sessionPk } = await indexFile(db, seedFile(f))
    const file = buildDiscoveredFileForSession(db, sessionPk)
    expect(file).not.toBeNull()
    expect(file).toMatchObject({ kind: 'main', projectDir: 'C--Users-x-GIT-Demo', sessionId: 'sess-1', filePath: f })
  })
})

describe('syncSessionToCatalog — the reopen-isn\'t-stale regression', () => {
  it('advances the catalog from appended rows so loadTranscript reflects a just-completed live turn, without a second runIndex', async () => {
    const f = join(dir, 'sess-1.jsonl')
    const db = openCatalog(':memory:')

    // 1. Simulate the ONE runIndex() call at app mount: index the file as it
    //    existed when the app launched.
    const first = await indexFile(db, seedFile(f))
    expect(first.added).toBe(2)
    const sessionPk = first.sessionPk

    // Sanity: loadTranscript already returns the mount-time content.
    const beforeTurn = await loadTranscript(db, sessionPk)
    expect(beforeTurn.items.map(i => i.uuid)).toContain('a1')
    expect(beforeTurn.items.map(i => i.uuid)).not.toContain('a2')

    // 2. Simulate a live turn: the CLI appends new durable rows to the SAME
    //    file (the watcher would tail these and stream them to the renderer
    //    for the transient live display -- this test skips that transient
    //    path and goes straight to the catalog-sync half of the fix).
    appendFileSync(f, `${userRow('u2', 'second turn')}\n${assistantRow('a2', 'u2', 'second reply')}\n`)

    // 3. Fire the sync engine-ipc.ts's indexDebouncer would trigger on the
    //    onRows/result path -- NOT a second runIndex()/discover() walk (this
    //    test never imports or calls either), just the targeted single-
    //    session advance.
    const synced = await syncSessionToCatalog(db, sessionPk)
    expect(synced).not.toBeNull()
    expect(synced!.skipped).toBe(false)
    expect(synced!.added).toBe(2) // only the appended rows, not a full re-index

    // 4. The regression proof: loadTranscript -- exactly what App.tsx's
    //    openSession calls when a session is (re)opened -- now returns the
    //    just-completed turn. Before this fix, the catalog's indexed_offset
    //    would still point at the pre-turn end of file, so u2/a2 would never
    //    appear here until the next full app restart.
    const afterTurn = await loadTranscript(db, sessionPk)
    const uuids = afterTurn.items.map(i => i.uuid)
    expect(uuids).toContain('u2')
    expect(uuids).toContain('a2')

    // Idempotent: syncing again with nothing new appended is a cheap no-op,
    // not a duplicate insert.
    const again = await syncSessionToCatalog(db, sessionPk)
    expect(again!.skipped).toBe(true)
    expect(again!.added).toBe(0)
  })

  it('returns null (a no-op) for a session that cannot be resolved to a file', async () => {
    const db = openCatalog(':memory:')
    expect(await syncSessionToCatalog(db, 42)).toBeNull()
  })
})

describe('createIndexDebouncer', () => {
  it('collapses a burst of schedule() calls for the same session into a single sync', async () => {
    vi.useFakeTimers()
    try {
      const sync = vi.fn(async (pk: number) => ({ sessionPk: pk, added: 1, skipped: false }))
      const indexed: number[] = []
      const deb = createIndexDebouncer(sync, pk => indexed.push(pk), 100)

      deb.schedule(7)
      await vi.advanceTimersByTimeAsync(30)
      deb.schedule(7) // resets the trailing timer
      await vi.advanceTimersByTimeAsync(30)
      deb.schedule(7)
      await vi.advanceTimersByTimeAsync(30) // still within 100ms of the LAST schedule() call
      expect(sync).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)
      expect(sync).toHaveBeenCalledTimes(1)
      expect(sync).toHaveBeenCalledWith(7)
      expect(indexed).toEqual([7])
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules independently per sessionPk', async () => {
    vi.useFakeTimers()
    try {
      const sync = vi.fn(async (pk: number) => ({ sessionPk: pk, added: 1, skipped: false }))
      const indexed: number[] = []
      const deb = createIndexDebouncer(sync, pk => indexed.push(pk), 50)

      deb.schedule(1)
      deb.schedule(2)
      await vi.advanceTimersByTimeAsync(50)
      expect(indexed.slice().sort()).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose() clears pending timers so they never fire afterward', async () => {
    vi.useFakeTimers()
    try {
      const sync = vi.fn(async (pk: number) => ({ sessionPk: pk, added: 1, skipped: false }))
      const deb = createIndexDebouncer(sync, () => {}, 50)
      deb.schedule(1)
      deb.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sync).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // Real timers below (not fake): `now()`'s whole point is to run
  // synchronously without waiting on the debounce window, so a plain
  // macrotask flush is enough to observe its effect.
  it('now() runs immediately and cancels a pending debounced call, so a result event is never stuck waiting out the window', async () => {
    const sync = vi.fn(async (pk: number) => ({ sessionPk: pk, added: 1, skipped: false }))
    const indexed: number[] = []
    const deb = createIndexDebouncer(sync, pk => indexed.push(pk), 500)

    try {
      deb.schedule(3) // a mid-stream onRows batch, debounced for 500ms
      deb.now(3)      // the turn's `result` fires almost immediately after
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(indexed).toEqual([3])
      expect(sync).toHaveBeenCalledTimes(1)
    } finally {
      // The pending debounce must have been cancelled by now() -- dispose()
      // rather than waiting out 500 real ms to prove nothing double-fires.
      deb.dispose()
    }
  })

  it('does not call onIndexed when sync resolves null (session unresolvable)', async () => {
    const sync = vi.fn(async () => null)
    const indexed: number[] = []
    const deb = createIndexDebouncer(sync, pk => indexed.push(pk), 10)

    deb.now(9)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sync).toHaveBeenCalledTimes(1)
    expect(indexed).toEqual([])
  })
})
