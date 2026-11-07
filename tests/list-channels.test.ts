import { describe, it, expect } from 'vitest'
import { openCatalog, closeCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd, upsertSession } from '../src/main/catalog/repos'
import { setFriendlyName, setStarred, setChannelIcon, setChannelGroup, createGroup } from '../src/main/catalog/metadata'
import { removeChatFromCatalog } from '../src/main/delete-channel'
import { listChannels } from '../src/main/ipc'
import type { Catalog } from '../src/main/catalog/db'

function chat(db: Catalog, projectId: number, sessionId = 's1'): number {
  return upsertSession(db, { projectId, sessionId, kind: 'main', filePath: `/f/${projectId}/${sessionId}.jsonl`, fileSize: 1, fileMtimeMs: 1 })
}

describe('listChannels', () => {
  it('merges each project with its default metadata when none has been set', () => {
    const db = openCatalog(':memory:')
    chat(db, upsertProject(db, 'proj-a'))
    const channels = listChannels(db)
    expect(channels).toHaveLength(1)
    expect(channels[0]!.dirName).toBe('proj-a')
    expect(channels[0]!.meta).toEqual({
      dirName: 'proj-a', friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false
    })
    closeCatalog(db)
  })

  it('merges custom metadata (name/star/icon/group) onto the matching project', () => {
    const db = openCatalog(':memory:')
    const id = upsertProject(db, 'proj-b')
    setProjectCwd(db, id, '/home/me/proj-b')
    const groupId = createGroup(db, 'Work')
    setFriendlyName(db, 'proj-b', 'My Project')
    setStarred(db, 'proj-b', true)
    setChannelIcon(db, 'proj-b', { kind: 'emoji', emoji: '🚀' })
    setChannelGroup(db, 'proj-b', groupId)

    const channels = listChannels(db)
    expect(channels).toHaveLength(1)
    const c = channels[0]!
    expect(c.cwd).toBe('/home/me/proj-b')
    expect(c.meta.friendlyName).toBe('My Project')
    expect(c.meta.starred).toBe(true)
    expect(c.meta.icon).toEqual({ kind: 'emoji', emoji: '🚀' })
    expect(c.meta.groupId).toBe(groupId)
    closeCatalog(db)
  })

  it('keeps each channel keyed to its own metadata (no cross-contamination between channels)', () => {
    const db = openCatalog(':memory:')
    upsertProject(db, 'proj-a')
    upsertProject(db, 'proj-b')
    setFriendlyName(db, 'proj-a', 'Alpha')
    setStarred(db, 'proj-b', true)

    const byName = new Map(listChannels(db).map(c => [c.dirName, c]))
    expect(byName.get('proj-a')!.meta.friendlyName).toBe('Alpha')
    expect(byName.get('proj-a')!.meta.starred).toBe(false)
    expect(byName.get('proj-b')!.meta.friendlyName).toBeNull()
    expect(byName.get('proj-b')!.meta.starred).toBe(true)
    closeCatalog(db)
  })

  describe('a project with no chats', () => {
    const listed = (db: Catalog): string[] => listChannels(db).map(c => c.dirName)

    it('leaves the list when nothing about it was customized', () => {
      const db = openCatalog(':memory:')
      upsertProject(db, 'empty')
      chat(db, upsertProject(db, 'has-chat'))
      expect(listed(db)).toEqual(['has-chat'])
      closeCatalog(db)
    })
    it('leaves when only subagent transcripts are left', () => {
      const db = openCatalog(':memory:')
      const id = upsertProject(db, 'leftovers')
      upsertSession(db, { projectId: id, sessionId: 's1', kind: 'subagent', agentId: 'a', filePath: '/f/a.jsonl', fileSize: 1, fileMtimeMs: 1 })
      expect(listed(db)).toEqual([])
      closeCatalog(db)
    })
    it('stays if it has a name, a favorite, or an icon', () => {
      const db = openCatalog(':memory:')
      upsertProject(db, 'named'); setFriendlyName(db, 'named', 'Mine')
      upsertProject(db, 'favorite'); setStarred(db, 'favorite', true)
      upsertProject(db, 'iconic'); setChannelIcon(db, 'iconic', { kind: 'emoji', emoji: '🚀' })
      expect(listed(db).sort()).toEqual(['favorite', 'iconic', 'named'])
      expect(listChannels(db).every(c => c.sessionCount === 0)).toBe(true)
      closeCatalog(db)
    })
    it('goes once that is undone, and only then', () => {
      const db = openCatalog(':memory:')
      upsertProject(db, 'p'); setStarred(db, 'p', true)
      expect(listed(db)).toEqual(['p'])
      setStarred(db, 'p', false)
      expect(listed(db)).toEqual([])
      closeCatalog(db)
    })
    it('does not stay for being in a group or for the default icon', () => {
      const db = openCatalog(':memory:')
      upsertProject(db, 'p'); setChannelGroup(db, 'p', createGroup(db, 'Work')); setChannelIcon(db, 'p', { kind: 'initials' })
      expect(listed(db)).toEqual([])
      closeCatalog(db)
    })
    it('deleting its last chat takes it off the list, and a new chat brings it back with its row intact', () => {
      const db = openCatalog(':memory:')
      const id = upsertProject(db, 'p')
      const pk = chat(db, id)
      expect(listed(db)).toEqual(['p'])
      removeChatFromCatalog(db, pk)
      expect(listed(db)).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 })
      chat(db, id, 's2')
      expect(listed(db)).toEqual(['p'])
      closeCatalog(db)
    })
  })

  it('returns an empty array when there are no projects', () => {
    const db = openCatalog(':memory:')
    expect(listChannels(db)).toEqual([])
    closeCatalog(db)
  })
})
