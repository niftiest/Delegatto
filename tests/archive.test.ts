import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd, upsertSession } from '../src/main/catalog/repos'
import { backupCatalogOnce, chatsToShow, folderGone, isConversationText, moveCustomisations, withoutMovedChats } from '../src/main/catalog/archive'
import { setChannelGroup, setChannelIcon, setFriendlyName, setStarred, getChannelMeta, createGroup } from '../src/main/catalog/metadata'
import { groupChannels } from '../src/renderer/lib'
import { archivedNoticeText } from '../src/renderer/components/ArchivedNotice'
import type { ChannelRow } from '../src/shared/types'

const DISK = new Set(['C:\\', 'D:\\', 'D:\\GIT\\Demo', 'D:\\GIT\\Other', 'E:\\'])
const exists = (p: string): boolean => DISK.has(p)
const OLD = 'C:\\OneDrive\\GIT\\Demo'
const NEW = 'D:\\GIT\\Demo'

function project(db: ReturnType<typeof openCatalog>, dir: string, cwd: string | null): number {
  const id = upsertProject(db, dir)
  if (cwd !== null) setProjectCwd(db, id, cwd)
  return id
}
function chat(db: ReturnType<typeof openCatalog>, projectId: number, sessionId: string, messages: number): number {
  const id = upsertSession(db, { projectId, sessionId, kind: 'main', filePath: `/f/${projectId}/${sessionId}.jsonl`, fileSize: 1, fileMtimeMs: 1 })
  db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(messages, id)
  return id
}
const noBackup = (): void => {}

describe('a project folder that is gone', () => {
  it('counts only when its drive is there', () => {
    expect(folderGone(OLD, exists)).toBe(true)
    expect(folderGone(NEW, exists)).toBe(false)
    expect(folderGone('F:\\GIT\\Unplugged', exists)).toBe(false)
  })

  it('never counts a network path, or a project with no known folder', () => {
    expect(folderGone('\\\\server\\share\\Demo', exists)).toBe(false)
    expect(folderGone(null, exists)).toBe(false)
    expect(folderGone('', exists)).toBe(false)
  })
})

describe('chats in an archived project', () => {
  it('leaves out one that moved with the project, and keeps the rest', () => {
    const db = openCatalog(':memory:')
    const oldP = project(db, 'old', OLD)
    const newP = project(db, 'new', NEW)
    chat(db, oldP, 'moved', 10)
    chat(db, oldP, 'only-here', 10)
    chat(db, newP, 'moved', 12)
    expect(chatsToShow(db, oldP, exists).map(s => s.sessionId)).toEqual(['only-here'])
    expect(chatsToShow(db, newP, exists).map(s => s.sessionId)).toEqual(['moved'])
  })

  it('keeps one whose other copy is shorter, or is also in a folder that has gone', () => {
    const db = openCatalog(':memory:')
    const oldP = project(db, 'old', OLD)
    const newP = project(db, 'new', NEW)
    const gone = project(db, 'gone', 'C:\\Elsewhere\\Demo')
    chat(db, oldP, 'longer-here', 10)
    chat(db, newP, 'longer-here', 3)
    chat(db, oldP, 'both-gone', 5)
    chat(db, gone, 'both-gone', 5)
    expect(chatsToShow(db, oldP, exists).map(s => s.sessionId).sort()).toEqual(['both-gone', 'longer-here'])
  })

  it('leaves the hidden copy out of search results', () => {
    const db = openCatalog(':memory:')
    const oldP = project(db, 'old', OLD)
    const newP = project(db, 'new', NEW)
    const hidden = chat(db, oldP, 'moved', 10)
    const kept = chat(db, oldP, 'only-here', 10)
    const live = chat(db, newP, 'moved', 12)
    const hits = [hidden, kept, live, hidden].map(sessionPk => ({ sessionPk }))
    expect(withoutMovedChats(db, hits, exists).map(h => h.sessionPk)).toEqual([kept, live])
  })

  it('does not touch the catalog to do so', () => {
    const db = openCatalog(':memory:')
    const oldP = project(db, 'old', OLD)
    const newP = project(db, 'new', NEW)
    chat(db, oldP, 'moved', 10)
    chat(db, newP, 'moved', 12)
    chatsToShow(db, oldP, exists)
    expect((db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n).toBe(2)
  })
})

describe('moving a star, name, icon and group to where the project is now', () => {
  function moved() {
    const db = openCatalog(':memory:')
    project(db, 'old', OLD)
    project(db, 'new', NEW)
    return db
  }

  it('moves all of them, backing up first', () => {
    const db = moved()
    const group = createGroup(db, 'Work')
    setStarred(db, 'old', true)
    setFriendlyName(db, 'old', 'My Demo')
    setChannelIcon(db, 'old', { kind: 'emoji', emoji: '🐷' })
    setChannelGroup(db, 'old', group)
    const order: string[] = []
    expect(moveCustomisations(db, () => order.push('backup'), exists)).toBe(1)
    expect(order).toEqual(['backup'])
    const to = getChannelMeta(db, 'new')
    expect(to).toMatchObject({ starred: true, friendlyName: 'My Demo', groupId: group })
    expect(to.icon).toMatchObject({ kind: 'emoji' })
    expect(getChannelMeta(db, 'old')).toMatchObject({ starred: false, friendlyName: null, groupId: null })
  })

  it('keeps what the new row already has, leaving the old row its own', () => {
    const db = moved()
    setFriendlyName(db, 'old', 'Old name')
    setStarred(db, 'old', true)
    setFriendlyName(db, 'new', 'New name')
    moveCustomisations(db, noBackup, exists)
    expect(getChannelMeta(db, 'new')).toMatchObject({ friendlyName: 'New name', starred: true })
    expect(getChannelMeta(db, 'old')).toMatchObject({ friendlyName: 'Old name', starred: false })
  })

  it('does nothing, and makes no backup, when there is nothing to move', () => {
    const db = moved()
    let backups = 0
    expect(moveCustomisations(db, () => { backups++ }, exists)).toBe(0)
    setStarred(db, 'old', true)
    moveCustomisations(db, () => { backups++ }, exists)
    expect(moveCustomisations(db, () => { backups++ }, exists)).toBe(0)
    expect(backups).toBe(1)
  })

  it('leaves it when no folder or several folders have that name', () => {
    const db = openCatalog(':memory:')
    project(db, 'old', OLD)
    setStarred(db, 'old', true)
    expect(moveCustomisations(db, noBackup, exists)).toBe(0)
    project(db, 'a', NEW)
    project(db, 'b', 'D:\\Demo')
    const twoCopies = (p: string): boolean => exists(p) || p === 'D:\\Demo'
    expect(moveCustomisations(db, noBackup, twoCopies)).toBe(0)
    expect(getChannelMeta(db, 'old').starred).toBe(true)
  })

  it('moves nothing if the backup fails', () => {
    const db = moved()
    setStarred(db, 'old', true)
    expect(() => moveCustomisations(db, () => { throw new Error('disk full') }, exists)).toThrow('disk full')
    expect(getChannelMeta(db, 'new').starred).toBe(false)
    expect(getChannelMeta(db, 'old').starred).toBe(true)
  })

  it('backs up once', () => {
    const made: string[] = []
    const db = { exec: (sql: string) => made.push(sql) } as unknown as ReturnType<typeof openCatalog>
    backupCatalogOnce(db, "C:\\it's\\a.db", () => false)
    backupCatalogOnce(db, "C:\\it's\\a.db", () => true)
    expect(made).toEqual(["VACUUM INTO 'C:\\it''s\\a.db'"])
  })
})

describe('the chat list and notice', () => {
  const row = (id: number, over: Partial<ChannelRow> = {}, meta = {}): ChannelRow => ({
    id, dirName: `d${id}`, cwd: `D:\\${id}`, sessionCount: 1, lastActivity: '2026-11-01T00:00:00Z', preview: null,
    meta: { dirName: `d${id}`, friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false, ...meta }, ...over
  })

  it('puts archived projects last and nowhere else, even if starred or hidden', () => {
    const sections = groupChannels([
      row(1), row(2, { archived: true }, { starred: true }), row(3, { archived: true }, { hidden: true }), row(4, {}, { hidden: true })
    ], [], Date.parse('2026-11-02T00:00:00Z'))
    expect(sections.at(-1)).toMatchObject({ kind: 'archived', title: 'Archived' })
    expect(sections.at(-1)!.channels.map(c => c.id).sort()).toEqual([2, 3])
    for (const s of sections.slice(0, -1)) expect(s.channels.every(c => c.archived !== true)).toBe(true)
    expect(sections.map(s => s.kind)).not.toContain('starred')
  })

  it('has no Archived section when there is nothing in it', () => {
    expect(groupChannels([row(1)], []).map(s => s.kind)).not.toContain('archived')
  })

  it('names one project, or a few and how many more', () => {
    expect(archivedNoticeText(['Demo'])).toContain("Demo's folder was moved or deleted")
    const many = archivedNoticeText(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(many).toContain('a, b, c, d, e and 2 more')
    expect(many).toContain('Archived')
  })

  it('tells conversation apart from what Claude Code stored around it', () => {
    expect(isConversationText('hello')).toBe(true)
    for (const noise of [null, '  ', '<system-reminder>x', '<task-notification>x', '[Request interrupted by user]', 'No response requested.']) {
      expect(isConversationText(noise)).toBe(false)
    }
  })
})
