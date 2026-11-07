import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog, closeCatalog } from '../src/main/catalog/db'
import { SCHEMA_VERSION } from '../src/main/catalog/schema'
import { upsertProject } from '../src/main/catalog/repos'
import { runIndex } from '../src/main/indexer/indexer'
import {
  getChannelMeta, setFriendlyName, setStarred, setChannelIcon, setChannelGroup,
  allChannelMeta, listGroups, createGroup, renameGroup, deleteGroup, setHidden, setGroupIcon
} from '../src/main/catalog/metadata'

describe('channel metadata', () => {
  it('returns defaults when no row exists', () => {
    const db = openCatalog(':memory:')
    const meta = getChannelMeta(db, 'some-dir')
    expect(meta).toEqual({
      dirName: 'some-dir', friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false
    })
    closeCatalog(db)
  })

  it('sets and clears the hidden flag', () => {
    const db = openCatalog(':memory:')
    expect(getChannelMeta(db, 'd1').hidden).toBe(false)
    setHidden(db, 'd1', true)
    expect(getChannelMeta(db, 'd1').hidden).toBe(true)
    setHidden(db, 'd1', false)
    expect(getChannelMeta(db, 'd1').hidden).toBe(false)
    closeCatalog(db)
  })

  it('sets and reads back the friendly name', () => {
    const db = openCatalog(':memory:')
    setFriendlyName(db, 'd1', 'My Project')
    expect(getChannelMeta(db, 'd1').friendlyName).toBe('My Project')
    closeCatalog(db)
  })

  it('trims a friendly name and stores empty/whitespace as null (no custom name)', () => {
    const db = openCatalog(':memory:')
    setFriendlyName(db, 'd1', '  Padded Name  ')
    expect(getChannelMeta(db, 'd1').friendlyName).toBe('Padded Name')

    setFriendlyName(db, 'd2', '')
    expect(getChannelMeta(db, 'd2').friendlyName).toBeNull()

    setFriendlyName(db, 'd3', '   ')
    expect(getChannelMeta(db, 'd3').friendlyName).toBeNull()

    // Clearing an existing name back to null works too.
    setFriendlyName(db, 'd1', null)
    expect(getChannelMeta(db, 'd1').friendlyName).toBeNull()
    closeCatalog(db)
  })

  it('sets and reads back starred', () => {
    const db = openCatalog(':memory:')
    expect(getChannelMeta(db, 'd1').starred).toBe(false)
    setStarred(db, 'd1', true)
    expect(getChannelMeta(db, 'd1').starred).toBe(true)
    setStarred(db, 'd1', false)
    expect(getChannelMeta(db, 'd1').starred).toBe(false)
    closeCatalog(db)
  })

  it('round-trips every icon kind', () => {
    const db = openCatalog(':memory:')
    setChannelIcon(db, 'd1', { kind: 'initials' })
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'initials' })

    setChannelIcon(db, 'd1', { kind: 'emoji', emoji: '🚀' })
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'emoji', emoji: '🚀' })

    setChannelIcon(db, 'd1', { kind: 'color', color: '#ff00aa' })
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'color', color: '#ff00aa' })

    setChannelIcon(db, 'd1', { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
    closeCatalog(db)
  })

  it('falls back to initials for a missing icon_json', () => {
    const db = openCatalog(':memory:')
    // No row at all.
    expect(getChannelMeta(db, 'never-set').icon).toEqual({ kind: 'initials' })
    closeCatalog(db)
  })

  it('falls back to initials for malformed icon_json', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO channel_meta (dir_name, icon_json) VALUES ('d1', 'not json{{{')").run()
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'initials' })
    closeCatalog(db)
  })

  it('falls back to initials for icon_json that is valid JSON but not an object', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO channel_meta (dir_name, icon_json) VALUES ('d1', '42')").run()
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'initials' })
    closeCatalog(db)
  })

  it('falls back to initials for an unknown icon kind', () => {
    const db = openCatalog(':memory:')
    db.prepare(`INSERT INTO channel_meta (dir_name, icon_json) VALUES ('d1', '${JSON.stringify({ kind: 'sparkle' })}')`).run()
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'initials' })
    closeCatalog(db)
  })

  it('falls back to initials when a known kind is missing its required field', () => {
    const db = openCatalog(':memory:')
    db.prepare(`INSERT INTO channel_meta (dir_name, icon_json) VALUES ('d1', '${JSON.stringify({ kind: 'emoji' })}')`).run()
    expect(getChannelMeta(db, 'd1').icon).toEqual({ kind: 'initials' })

    db.prepare(`INSERT INTO channel_meta (dir_name, icon_json) VALUES ('d2', '${JSON.stringify({ kind: 'emoji', emoji: 5 })}')`).run()
    expect(getChannelMeta(db, 'd2').icon).toEqual({ kind: 'initials' })
    closeCatalog(db)
  })

  it('tolerates a genuinely dangling group_id without throwing (getChannelMeta does not join/validate)', () => {
    const db = openCatalog(':memory:')
    const groupId = createGroup(db, 'Temp')
    setChannelGroup(db, 'd1', groupId)

    // Force a truly dangling reference: turn FK enforcement off for this
    // statement so deleting the group does NOT trigger ON DELETE SET NULL,
    // leaving channel_meta.group_id pointing at a row that no longer
    // exists. This is the scenario getChannelMeta must tolerate -- it reads
    // the stored group_id as-is and never joins against channel_groups, so
    // an unresolvable id round-trips instead of throwing.
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM channel_groups WHERE id = ?').run(groupId)
    db.pragma('foreign_keys = ON')

    expect(() => getChannelMeta(db, 'd1')).not.toThrow()
    expect(getChannelMeta(db, 'd1').groupId).toBe(groupId)
    closeCatalog(db)
  })

  it('deleteGroup ungroups channels via the ON DELETE SET NULL FK action itself', () => {
    const db = openCatalog(':memory:')
    const groupId = createGroup(db, 'Temp')
    setChannelGroup(db, 'd1', groupId)
    db.prepare('DELETE FROM channel_groups WHERE id = ?').run(groupId)
    expect(getChannelMeta(db, 'd1').groupId).toBeNull()
    closeCatalog(db)
  })

  it('groups: create, list, rename, and delete (delete ungroups member channels)', () => {
    const db = openCatalog(':memory:')
    const g1 = createGroup(db, 'Work')
    const g2 = createGroup(db, 'Personal')

    expect(listGroups(db)).toEqual([
      { id: g1, name: 'Work', sortOrder: 0, icon: { kind: 'initials' } },
      { id: g2, name: 'Personal', sortOrder: 0, icon: { kind: 'initials' } }
    ])

    renameGroup(db, g1, 'Client Work')
    expect(listGroups(db).find(g => g.id === g1)?.name).toBe('Client Work')

    // Custom group icon round-trips; defaults to initials.
    expect(listGroups(db).find(g => g.id === g2)?.icon).toEqual({ kind: 'initials' })
    setGroupIcon(db, g2, { kind: 'emoji', emoji: '🎯' })
    expect(listGroups(db).find(g => g.id === g2)?.icon).toEqual({ kind: 'emoji', emoji: '🎯' })

    setChannelGroup(db, 'chan-a', g1)
    setChannelGroup(db, 'chan-b', g1)
    setChannelGroup(db, 'chan-c', g2)

    deleteGroup(db, g1)

    expect(listGroups(db)).toEqual([{ id: g2, name: 'Personal', sortOrder: 0, icon: { kind: 'emoji', emoji: '🎯' } }])
    expect(getChannelMeta(db, 'chan-a').groupId).toBeNull()
    expect(getChannelMeta(db, 'chan-b').groupId).toBeNull()
    expect(getChannelMeta(db, 'chan-c').groupId).toBe(g2)
    closeCatalog(db)
  })

  it('setChannelGroup can move a channel back to ungrouped', () => {
    const db = openCatalog(':memory:')
    const g1 = createGroup(db, 'Work')
    setChannelGroup(db, 'chan-a', g1)
    expect(getChannelMeta(db, 'chan-a').groupId).toBe(g1)
    setChannelGroup(db, 'chan-a', null)
    expect(getChannelMeta(db, 'chan-a').groupId).toBeNull()
    closeCatalog(db)
  })

  it('allChannelMeta returns a Map keyed by dirName', () => {
    const db = openCatalog(':memory:')
    setFriendlyName(db, 'd1', 'Alpha')
    setStarred(db, 'd2', true)

    const map = allChannelMeta(db)
    expect(map).toBeInstanceOf(Map)
    expect(map.size).toBe(2)
    expect(map.get('d1')?.friendlyName).toBe('Alpha')
    expect(map.get('d2')?.starred).toBe(true)
    expect(map.get('missing')).toBeUndefined()
    closeCatalog(db)
  })

  it('survives a simulated re-index: indexFile/runIndex never touch channel_meta rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-meta-reindex-'))
    try {
      const db = openCatalog(':memory:')
      const dirName = 'C--Users-x-GIT-Demo'
      upsertProject(db, dirName)
      setFriendlyName(db, dirName, 'Renamed Channel')
      setStarred(db, dirName, true)
      setChannelIcon(db, dirName, { kind: 'emoji', emoji: '🔥' })

      // An empty ~/.claude home is enough: runIndex just needs to execute
      // its normal discover+index pass over *some* project tree without
      // ever referencing channel_meta.
      await runIndex(db, { home })

      const meta = getChannelMeta(db, dirName)
      expect(meta.friendlyName).toBe('Renamed Channel')
      expect(meta.starred).toBe(true)
      expect(meta.icon).toEqual({ kind: 'emoji', emoji: '🔥' })
      closeCatalog(db)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  describe('migration from a pre-Task-1 (v1) catalog', () => {
    let dir: string
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('adds channel_meta + channel_groups on reopen, bumps schema_version, and keeps existing data intact', () => {
      dir = mkdtempSync(join(tmpdir(), 'cc-meta-migration-'))
      const file = join(dir, 'catalog.db')

      // Build a DB at the current schema, then roll it back to look like a
      // real v1 DB from before this task: drop the new tables and lower the
      // stored schema_version. This is the shape a genuine user's on-disk
      // catalog would have had prior to this migration.
      const db1 = openCatalog(file)
      db1.prepare("INSERT INTO projects (dir_name) VALUES ('legacy-project')").run()
      db1.prepare("INSERT INTO sessions (project_id, session_id, file_path, kind, title) VALUES (1,'sess-1','/f/sess-1.jsonl','main','Legacy session')").run()
      db1.prepare("INSERT INTO messages (session_pk, uuid, seq, role, byte_offset, text) VALUES (1,'u1',0,'user',0,'legacy message')").run()
      db1.prepare('DROP TABLE channel_meta').run()
      db1.prepare('DROP TABLE channel_groups').run()
      db1.prepare("UPDATE meta SET value = '1' WHERE key='schema_version'").run()
      closeCatalog(db1)

      const db2 = openCatalog(file)

      const versionRow = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(versionRow.value).toBe(String(SCHEMA_VERSION))

      const tableNames = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      const names = new Set(tableNames.map(t => t.name))
      expect(names.has('channel_meta')).toBe(true)
      expect(names.has('channel_groups')).toBe(true)

      // Pre-existing data survived the migration untouched.
      const projects = db2.prepare('SELECT dir_name FROM projects').all() as { dir_name: string }[]
      expect(projects).toEqual([{ dir_name: 'legacy-project' }])
      const sessions = db2.prepare('SELECT title FROM sessions').all() as { title: string }[]
      expect(sessions).toEqual([{ title: 'Legacy session' }])
      const messages = db2.prepare('SELECT text FROM messages').all() as { text: string }[]
      expect(messages).toEqual([{ text: 'legacy message' }])

      // The new tables are fully usable post-migration, not just present.
      setFriendlyName(db2, 'legacy-project', 'Now Named')
      expect(getChannelMeta(db2, 'legacy-project').friendlyName).toBe('Now Named')

      closeCatalog(db2)
    })
  })
})
