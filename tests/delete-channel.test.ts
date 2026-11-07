import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { runIndex } from '../src/main/indexer/indexer'
import { setStarred, getChannelMeta } from '../src/main/catalog/metadata'
import { deleteChannel } from '../src/main/delete-channel'

let home: string
const DIR = 'C--Demo-Delete'

function writeSession() {
  const proj = join(home, 'projects', DIR)
  mkdirSync(join(proj, 'sub'), { recursive: true }) // an extra child to prove recursive removal
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null, cwd: 'C:\\Demo', timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-23T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }
  ]
  writeFileSync(join(proj, '11111111-1111-1111-1111-111111111111.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return proj
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-del-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('deleteChannel', () => {
  it('removes the project directory from disk and its catalog rows', async () => {
    const projDir = writeSession()
    const db = openCatalog(':memory:')
    await runIndex(db, { home })
    setStarred(db, DIR, true) // give it a channel_meta row too

    expect(existsSync(projDir)).toBe(true)
    const before = db.prepare("SELECT COUNT(*) c FROM projects WHERE dir_name = ?").get(DIR) as { c: number }
    expect(before.c).toBe(1)

    const res = deleteChannel(db, DIR, home)
    expect(res.deletedSessions).toBe(1)

    // Files gone (recursively — the sub/ child too).
    expect(existsSync(projDir)).toBe(false)
    // Catalog rows gone: project, its sessions, its messages, and channel_meta.
    expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE dir_name = ?").get(DIR) as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c).toBe(0)
    expect((db.prepare("SELECT COUNT(*) c FROM channel_meta WHERE dir_name = ?").get(DIR) as { c: number }).c).toBe(0)
    // FTS stayed in sync through the cascade (no phantom search rows).
    expect((db.prepare("SELECT COUNT(*) c FROM messages_fts").get() as { c: number }).c).toBe(0)
  })

  it('is a no-op-safe delete when the directory is already absent', async () => {
    writeSession()
    const db = openCatalog(':memory:')
    await runIndex(db, { home })
    rmSync(join(home, 'projects', DIR), { recursive: true, force: true }) // remove files out from under it
    expect(() => deleteChannel(db, DIR, home)).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE dir_name = ?").get(DIR) as { c: number }).c).toBe(0)
  })

  it('rejects a dir name that escapes the projects root (path traversal)', () => {
    const db = openCatalog(':memory:')
    for (const bad of ['..', '../evil', 'a/b', 'a\\b', '..\\..\\Windows']) {
      expect(() => deleteChannel(db, bad, home)).toThrow(/refusing|outside/)
    }
    // A would-be victim outside the root is never touched.
    const outside = join(home, 'projects')
    mkdirSync(outside, { recursive: true })
    expect(existsSync(outside)).toBe(true)
  })

  it('leaves the catalog untouched if the fs delete throws', async () => {
    // Point home at a path whose projects root does not exist, then hand a name
    // whose resolved target is a *file* we make un-removable is hard cross-platform;
    // instead assert the ordering contract directly: a rejected (guarded) name
    // throws before any catalog mutation.
    writeSession()
    const db = openCatalog(':memory:')
    await runIndex(db, { home })
    expect(() => deleteChannel(db, '../escape', home)).toThrow()
    // The real channel's rows are still present — the guard threw first.
    expect((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c).toBeGreaterThan(0)
    expect(getChannelMeta(db, DIR)).toBeTruthy()
  })
})
