import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openCatalog, type Catalog } from '../../src/main/catalog/db'
import { encodePath } from '../../src/main/manage/paths'
import { permanentRemover } from '../../src/main/manage/fs-util'
import type { FileRemover } from '../../src/main/manage/types'
import type { LiveSession } from '../../src/main/manage/live'
import { ArchiveService } from '../../src/main/manage/archive'
import { DeleteWizard, endSessions, type ManageDeps } from '../../src/main/manage/wizard'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

/** Deletes for real (inside the fake tree) but says "Recycle Bin", so items start ticked. */
const recyclable: FileRemover = { ...permanentRemover, recyclable: () => true }

function deps(t: FakeClaudeTree, live: LiveSession[] = [], extra: Partial<ManageDeps> = {}): ManageDeps {
  return {
    paths: t.paths, getRemover: async () => recyclable, live: () => live,
    ownedSessionIds: () => [], stopOwned: () => {}, endExternal: async () => ({ ended: [], failures: [] }), ...extra
  }
}

function catalogWith(dirNames: string[]): Catalog {
  const db = openCatalog(':memory:')
  for (const d of dirNames) {
    const id = db.prepare('INSERT INTO projects (dir_name, cwd) VALUES (?, ?)').run(d, null).lastInsertRowid
    db.prepare("INSERT INTO sessions (project_id, session_id, kind, file_path) VALUES (?, 's', 'main', ?)").run(id, d + '.jsonl')
    db.prepare('INSERT INTO channel_meta (dir_name, friendly_name) VALUES (?, ?)').run(d, 'n')
  }
  return db
}

const projectRows = (db: Catalog): string[] =>
  (db.prepare('SELECT dir_name AS d FROM projects ORDER BY d').all() as Array<{ d: string }>).map(r => r.d)

function twoProjects(t: FakeClaudeTree): { a: string; b: string; c: string } {
  const a = t.workDir('Alpha')
  const b = t.workDir('Beta')
  const c = t.workDir('Gamma') // not selected: must survive
  for (const [wd, sid] of [[a, 'sa'], [b, 'sb'], [c, 'sc']] as const) {
    t.addSession(wd, sid)
    t.addMemory(wd, 'm.md', 'mem ' + sid)
    t.addClaudeJsonProject(wd)
    t.addHistory(wd, sid, 'hello ' + sid)
  }
  return { a, b, c }
}

describe('DeleteWizard, several projects', () => {
  it('plans every project, grouped, with unique keys and the summed restore-point size', async () => {
    const t = tree()
    const { a, b } = twoProjects(t)
    const w = new DeleteWizard(catalogWith([]), deps(t))
    const plan = await w.plan({ scope: 'projects', dirNames: [encodePath(a), encodePath(b)] })
    expect(plan.title).toBe('Delete 2 projects')
    expect(new Set(plan.items.map(i => i.group))).toEqual(new Set([a, b]))
    expect(new Set(plan.items.map(i => i.key)).size).toBe(plan.items.length)
    // history.jsonl appears once per project, as distinct rows
    expect(plan.items.filter(i => i.kind === 'HistoryLines')).toHaveLength(2)
    expect(plan.restorePointBytes).toBeGreaterThan(0)
    expect(plan.warnings).toEqual([])
  })

  it('deletes only the selected projects, makes one restore point holding both, and drops their catalog rows', async () => {
    const t = tree()
    const { a, b, c } = twoProjects(t)
    const db = catalogWith([encodePath(a), encodePath(b), encodePath(c)])
    const w = new DeleteWizard(db, deps(t))
    const target = { scope: 'projects' as const, dirNames: [encodePath(a), encodePath(b)] }
    const plan = await w.plan(target)
    const keys = plan.items.filter(i => i.defaultSelected && i.containedIn === null).map(i => i.key)
    const r = await w.execute(target, keys, true)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.failures).toEqual([])
    expect(existsSync(join(t.paths.projectsDir, encodePath(a)))).toBe(false)
    expect(existsSync(join(t.paths.projectsDir, encodePath(b)))).toBe(false)
    expect(existsSync(join(t.paths.projectsDir, encodePath(c)))).toBe(true)
    expect(existsSync(a) && existsSync(b)).toBe(true) // working folders are never removed
    expect(r.restorePoint).not.toBeNull()
    const points = await new ArchiveService(t.paths).listRestorePoints()
    expect(points).toHaveLength(1)
    expect(new Set(points[0]!.projects)).toEqual(new Set([a, b]))
    expect(projectRows(db)).toEqual([encodePath(c)])
  })

  it('names a chat the way the chat list does: its own name, then the made-up one, then its first message', async () => {
    const t = tree()
    const db = catalogWith([encodePath('D:\\Gone\\Project')])
    const pk = (db.prepare('SELECT id FROM sessions').get() as { id: number }).id
    const w = new DeleteWizard(db, deps(t))
    db.prepare("UPDATE sessions SET title = 'test', ai_title = 'Fix the proxy relay' WHERE id = ?").run(pk)
    expect((await w.plan({ scope: 'chat', sessionPk: pk })).title).toBe('Delete chat “Fix the proxy relay”')
    db.prepare("UPDATE sessions SET custom_title = 'Hotspot debugging' WHERE id = ?").run(pk)
    expect((await w.plan({ scope: 'chat', sessionPk: pk })).title).toBe('Delete chat “Hotspot debugging”')
  })

  it('tells sync about each project it deleted, and only those', async () => {
    const t = tree()
    const { a, b } = twoProjects(t)
    const deleted: string[] = []
    const w = new DeleteWizard(catalogWith([]), deps(t, [], { projectDeleted: wd => deleted.push(wd) }))
    const target = { scope: 'projects' as const, dirNames: [encodePath(a)] }
    const plan = await w.plan(target)
    await w.execute(target, plan.items.filter(i => i.defaultSelected && i.containedIn === null).map(i => i.key), false)
    expect(deleted).toEqual([a])
    expect(deleted).not.toContain(b)
  })

  it('refuses while any session runs, before the restore point and before any change', async () => {
    const t = tree()
    const { a, b } = twoProjects(t)
    const live: LiveSession[] = [{ pid: 4242, sessionId: 'unrelated', cwd: 'C:\\x', name: 't', procStart: null }]
    const w = new DeleteWizard(catalogWith([]), deps(t, live))
    const target = { scope: 'projects' as const, dirNames: [encodePath(a), encodePath(b)] }
    const plan = await w.plan(target)
    expect(plan.allLive.map(p => p.pid)).toEqual([4242])
    const r = await w.execute(target, plan.items.map(i => i.key), true)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.sessions?.map(s => s.pid)).toEqual([4242])
    expect(existsSync(join(t.paths.projectsDir, encodePath(a)))).toBe(true)
    expect(await new ArchiveService(t.paths).listRestorePoints()).toEqual([])
  })

  it('takes a .claude.json-only project by its working dir, exactly', async () => {
    const t = tree()
    const only = t.workDir('JsonOnly')
    t.addClaudeJsonProject(only)
    t.addClaudeJsonProject(only + '.com') // a lookalike that must not be touched
    const w = new DeleteWizard(catalogWith([]), deps(t))
    const target = { scope: 'projects' as const, dirNames: [only] }
    const plan = await w.plan(target)
    expect(plan.items.map(i => i.kind)).toContain('ClaudeJsonEntry')
    const r = await w.execute(target, plan.items.filter(i => i.defaultSelected).map(i => i.key), false)
    expect(r.ok).toBe(true)
    const keys = Object.keys(JSON.parse((await import('node:fs')).readFileSync(t.paths.claudeJson, 'utf8')).projects)
    expect(keys).toEqual([only + '.com'])
  })

  it('takes a project off the list when its Claude data is already gone', async () => {
    const t = tree()
    const gone = encodePath('D:\\Gone\\Project')
    const db = catalogWith([gone, 'Kept'])
    const live: LiveSession[] = [{ pid: 4242, sessionId: 'unrelated', cwd: 'C:\\x', name: 't', procStart: null }]
    const w = new DeleteWizard(db, deps(t, live))
    const target = { scope: 'project' as const, dirName: gone }
    const plan = await w.plan(target)
    expect(plan.listOnly).toEqual({ chats: 1 })
    expect(plan.items).toEqual([])
    expect(plan.blocking).toEqual([]) // an unrelated session doesn't hold it up
    const r = await w.execute(target, [], true)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.restorePoint).toBeNull()
    expect(projectRows(db)).toEqual(['Kept'])
    await expect(w.plan(target)).rejects.toThrow('already deleted')
  })

  it('takes a chat off the list when its project\'s Claude data is already gone', async () => {
    const t = tree()
    const db = catalogWith([encodePath('D:\\Gone\\Project')])
    const pk = (db.prepare('SELECT id FROM sessions').get() as { id: number }).id
    const w = new DeleteWizard(db, deps(t))
    const plan = await w.plan({ scope: 'chat', sessionPk: pk })
    expect(plan.listOnly).toEqual({ chats: 1 })
    const r = await w.execute({ scope: 'chat', sessionPk: pk }, [], false)
    expect(r.ok).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 })
  })

  it('rejects folder names that are not one plain path segment', async () => {
    const t = tree()
    const w = new DeleteWizard(catalogWith([]), deps(t))
    await expect(w.plan({ scope: 'projects', dirNames: ['..'] })).rejects.toThrow()
    await expect(w.plan({ scope: 'project', dirName: '../x' })).rejects.toThrow()
  })
})

describe('endSessions', () => {
  it("routes Delegatto's own processes to the pool and the rest to the terminator", async () => {
    const t = tree()
    const live: LiveSession[] = [
      { pid: 1, sessionId: 'MINE', cwd: 'C:\\a', name: null, procStart: null },
      { pid: 2, sessionId: 'theirs', cwd: 'C:\\b', name: null, procStart: '1' },
      { pid: 3, sessionId: 'not-asked', cwd: 'C:\\c', name: null, procStart: '1' }
    ]
    const stopped: string[][] = []
    const terminated: number[][] = []
    const d = deps(t, live, {
      ownedSessionIds: () => ['mine'],
      stopOwned: ids => { stopped.push(ids) },
      endExternal: async s => { terminated.push(s.map(x => x.pid)); return { ended: s, failures: [] } }
    })
    const r = await endSessions(d, [1, 2])
    expect(stopped).toEqual([['MINE']])
    expect(terminated).toEqual([[2]])
    expect(r.ended.sort()).toEqual([1, 2])
  })
})
