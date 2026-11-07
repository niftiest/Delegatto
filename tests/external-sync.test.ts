import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog, type Catalog } from '../src/main/catalog/db'
import { runIndex } from '../src/main/indexer/indexer'
import { listProjects, listSessions } from '../src/main/catalog/repos'
import { loadTranscript } from '../src/main/ipc'
import { sweepExternalChanges, syncSessionIfStale, createPeriodicSweep } from '../src/main/engine/external-sync'

const PROJECT = 'C--Users-x-GIT-Demo'
const userRow = (uuid: string, text: string, ts: string) => JSON.stringify({
  type: 'user', uuid, parentUuid: null, cwd: 'C:\\Users\\x\\GIT\\Demo',
  timestamp: ts, message: { role: 'user', content: text }
})

let home: string
let projDir: string
let db: Catalog

function sessionFile(id: string): string { return join(projDir, `${id}.jsonl`) }
function pkOf(id: string): number {
  return (db.prepare('SELECT id FROM sessions WHERE session_id = ?').get(id) as { id: number }).id
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-extsync-'))
  projDir = join(home, 'projects', PROJECT)
  mkdirSync(projDir, { recursive: true })
  writeFileSync(sessionFile('s-old'), `${userRow('u1', 'old chat', '2026-07-24T09:00:00Z')}\n`)
  writeFileSync(sessionFile('s-other'), `${userRow('v1', 'other chat', '2026-07-24T10:00:00Z')}\n`)
  db = openCatalog(':memory:')
  await runIndex(db, { home })
})
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }) })

describe('sweepExternalChanges', () => {
  it('is a no-op when nothing changed on disk', async () => {
    expect(await sweepExternalChanges(db, { home })).toEqual({ changedMain: [], changedSubagents: 0 })
  })

  it('indexes a chat appended to outside the app, bumping its ordering and preview', async () => {
    appendFileSync(sessionFile('s-old'), `${userRow('u2', 'continued in terminal', '2026-07-24T11:00:00Z')}\n`)
    const r = await sweepExternalChanges(db, { home })
    expect(r.changedMain).toEqual([pkOf('s-old')])

    const proj = listProjects(db)[0]!
    expect(proj.preview).toContain('continued in terminal')
    expect(proj.lastActivity).toBe('2026-07-24T11:00:00Z')
    // s-old was older than s-other; it now sorts first.
    expect(listSessions(db, proj.id).map(s => s.sessionId)).toEqual(['s-old', 's-other'])
    const page = await loadTranscript(db, pkOf('s-old'))
    expect(JSON.stringify(page.items)).toContain('continued in terminal')

    // A second sweep finds nothing new.
    expect((await sweepExternalChanges(db, { home })).changedMain).toEqual([])
  })

  it('picks up a brand-new chat created outside the app', async () => {
    writeFileSync(sessionFile('s-new'), `${userRow('w1', 'fresh terminal chat', '2026-07-24T12:00:00Z')}\n`)
    const r = await sweepExternalChanges(db, { home })
    expect(r.changedMain).toEqual([pkOf('s-new')])
  })

  it('skips files the caller says it is tracking live', async () => {
    appendFileSync(sessionFile('s-old'), `${userRow('u2', 'x', '2026-07-24T11:00:00Z')}\n`)
    const r = await sweepExternalChanges(db, { home, skip: fp => fp === sessionFile('s-old') })
    expect(r.changedMain).toEqual([])
    // Not marked as seen -- a later unskipped sweep still catches it.
    expect((await sweepExternalChanges(db, { home })).changedMain).toEqual([pkOf('s-old')])
  })

  it('treats an mtime-only change as changed (and indexes harmlessly)', async () => {
    const future = new Date(Date.now() + 60_000)
    utimesSync(sessionFile('s-other'), future, future)
    const r = await sweepExternalChanges(db, { home })
    expect(r.changedMain).toEqual([pkOf('s-other')])
    expect(listProjects(db)[0]!.preview).toContain('other chat')
  })
})

describe('syncSessionIfStale', () => {
  it('returns false for an up-to-date session and true after an external append', async () => {
    const pk = pkOf('s-old')
    expect(await syncSessionIfStale(db, pk)).toBe(false)
    appendFileSync(sessionFile('s-old'), `${userRow('u2', 'more', '2026-07-24T11:00:00Z')}\n`)
    expect(await syncSessionIfStale(db, pk)).toBe(true)
    expect(await syncSessionIfStale(db, pk)).toBe(false)
  })

  it('returns false for an unknown session or a missing file', async () => {
    expect(await syncSessionIfStale(db, 99999)).toBe(false)
    rmSync(sessionFile('s-old'))
    expect(await syncSessionIfStale(db, pkOf('s-old'))).toBe(false)
  })
})

describe('createPeriodicSweep', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('runs on the interval, never overlaps a still-running sweep, and stops on dispose', async () => {
    let calls = 0
    let release: () => void = () => {}
    const sweep = vi.fn(() => { calls++; return new Promise<void>(r => { release = r }) })
    const p = createPeriodicSweep(sweep, { intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(3000) // still running -- ticks dropped
    expect(calls).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)

    release()
    p.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
  })

  it('poke() runs immediately but is throttled by minGapMs', async () => {
    let t = 0
    const sweep = vi.fn(() => Promise.resolve())
    const p = createPeriodicSweep(sweep, { intervalMs: 60_000, minGapMs: 5000, now: () => t })
    p.poke()
    await Promise.resolve()
    expect(sweep).toHaveBeenCalledTimes(1)
    t = 2000; p.poke(); await Promise.resolve()
    expect(sweep).toHaveBeenCalledTimes(1)
    t = 6000; p.poke(); await Promise.resolve()
    expect(sweep).toHaveBeenCalledTimes(2)
    p.dispose()
  })
})
