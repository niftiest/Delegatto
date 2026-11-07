import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCatalog } from '../../src/main/catalog/db'
import { retireRenamedProject } from '../../src/main/delete-channel'
import { encodePath } from '../../src/main/manage/paths'
import { permanentRemover } from '../../src/main/manage/fs-util'
import type { FileRemover } from '../../src/main/manage/types'
import type { LiveSession } from '../../src/main/manage/live'
import { ManageController, type ControllerHooks } from '../../src/main/manage/controller'
import type { ManageDeps } from '../../src/main/manage/wizard'
import type { ContentSearchEvent } from '../../src/shared/manage-types'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

const recyclable: FileRemover = { ...permanentRemover, recyclable: () => true }

function controller(t: FakeClaudeTree, live: { current: LiveSession[] } = { current: [] }, hooks: ControllerHooks = {}): ManageController {
  const deps: ManageDeps = {
    paths: t.paths, getRemover: async () => recyclable, live: () => live.current,
    ownedSessionIds: () => ['owned-1'], stopOwned: () => {}, endExternal: async () => ({ ended: [], failures: [] })
  }
  return new ManageController(deps, hooks, { cloudOnly: async () => new Set(), systemFolders: [] })
}

const LIVE: LiveSession = { pid: 4242, sessionId: 'owned-1', cwd: 'C:\\x', name: 'n', procStart: null }

function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  return new Promise((res, rej) => {
    const tick = (): void => {
      if (cond()) res()
      else if (Date.now() - t0 > ms) rej(new Error('timeout'))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

describe('ManageController: projects', () => {
  it('lists projects and details with memory files marked editable', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    t.addMemory(a, 'MEMORY.md', 'hello')
    const c = controller(t)
    const rows = await c.listProjects()
    expect(rows.map(r => r.workingDir)).toEqual([a])
    expect(rows[0]!.sessions).toBe(1)
    const detail = await c.projectDetail(a)
    const mem = detail.find(d => d.child)!
    expect(mem.path.endsWith('MEMORY.md')).toBe(true)
    expect(mem.editable).toBe(true)
    expect(detail.find(d => d.kind === 'ProjectFolder')!.editable).toBe(false)
    expect(await c.canOpenInEditor(mem.path)).toBe(true)
    expect(await c.canOpenInEditor(join(a, 'random.md'))).toBe(false)
    await expect(c.projectDetail('C:\\not-listed')).rejects.toThrow()
  })

  it('streams content matches with where they matched, then done', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    const b = t.workDir('Beta')
    t.addSession(a, 's1', JSON.stringify({ type: 'user', message: { content: 'the zebra word' } }))
    t.addSession(b, 's2')
    t.addMemory(b, 'm.md', 'a ZEBRA in memory')
    const c = controller(t)
    await c.listProjects()
    const events: ContentSearchEvent[] = []
    c.startSearch(7, 'zebra', e => events.push(e))
    await until(() => events.some(e => e.type === 'done'))
    const matches = events.filter((e): e is Extract<ContentSearchEvent, { type: 'match' }> => e.type === 'match')
    expect(new Map(matches.map(m => [m.workingDir, m.places]))).toEqual(new Map([[a, ['chat']], [b, ['memory']]]))
    expect(events.every(e => e.id === 7)).toBe(true)
  })

  it('a cancelled search reports nothing more', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1', JSON.stringify({ type: 'user', message: { content: 'zebra' } }))
    const c = controller(t)
    await c.listProjects()
    const events: ContentSearchEvent[] = []
    c.startSearch(1, 'zebra', e => events.push(e))
    c.cancelSearch(1)
    await new Promise(r => setTimeout(r, 200))
    expect(events).toEqual([])
  })
})

describe('ManageController: rename', () => {
  it('previews, refuses a stale preview, then renames and reports the moved project folder', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    t.addClaudeJsonProject(a)
    const moved: Array<{ from: string; to: string }> = []
    let changed = 0
    const c = controller(t, { current: [] }, { projectFoldersRenamed: p => moved.push(...p), changed: () => { changed++ } })
    await c.listProjects()
    const to = join(t.root, 'work', 'Alpha2')
    const p = await c.renamePlan(a, to)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.plan.lines[0]).toContain('→')
    const stale = await c.renameExecute(a, to, 'not-the-signature')
    expect(stale.kind).toBe('changed')
    expect(existsSync(a)).toBe(true) // nothing done
    const r = await c.renameExecute(a, to, p.plan.signature)
    expect(r.kind).toBe('done')
    expect(existsSync(to) && !existsSync(a)).toBe(true)
    expect(moved).toEqual([{ from: encodePath(a), to: encodePath(to) }])
    expect(changed).toBe(1)
  })

  it('refuses while a session runs (Delegatto-owned shown as such) and changes nothing', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    const live = { current: [] as LiveSession[] }
    const c = controller(t, live)
    await c.listProjects()
    const to = join(t.root, 'work', 'Alpha2')
    const p = await c.renamePlan(a, to)
    if (!p.ok) throw new Error(p.error)
    live.current = [LIVE]
    const r = await c.renameExecute(a, to, p.plan.signature)
    expect(r.kind).toBe('sessions')
    if (r.kind !== 'sessions') return
    expect(r.sessions[0]!.owner).toBe('app')
    expect(existsSync(a)).toBe(true)
    expect(existsSync(to)).toBe(false)
  })

  it('reports a refused rename as an error', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    const c = controller(t)
    await c.listProjects()
    const r = await c.renamePlan(a, 'relative\\path')
    expect(r.ok).toBe(false)
  })
})

describe('ManageController: export / import / restore points', () => {
  it('exports, summarises the zip, and refuses a project import while sessions run', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    t.addHistory(a, 's1', 'hi')
    const live = { current: [] as LiveSession[] }
    const c = controller(t, live)
    await c.listProjects()
    const zip = join(t.root, 'out.zip')
    const e = await c.exportProjects([a], zip)
    expect(e.kind).toBe('done')
    const s = await c.readArchive(zip)
    expect(s.kind).toBe('Projects')
    expect(s.projects.map(p => p.workingDir)).toEqual([a])
    expect(s.projects[0]!.historyLines).toBe(1)
    live.current = [LIVE]
    const r = await c.importArchive(zip)
    expect(r.kind).toBe('sessions')
  })

  it('imports into the original place without overwriting, then forgets its scans', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    const transcript = t.addSession(a, 's1')
    let changed = 0
    const c = controller(t, { current: [] }, { changed: () => { changed++ } })
    await c.listProjects()
    const zip = join(t.root, 'out.zip')
    await c.exportProjects([a], zip)
    writeFileSync(transcript, 'local edit\n')
    const r = await c.importArchive(zip)
    expect(r.kind).toBe('done')
    expect(readFileSync(transcript, 'utf8')).toBe('local edit\n')
    expect(changed).toBe(1)
    expect(c.known()).toBeNull()
  })

  it('lists restore points and only deletes zips in the restore-points folder', async () => {
    const t = tree()
    mkdirSync(t.paths.restorePointsDir, { recursive: true })
    const outside = join(t.root, 'elsewhere.zip')
    writeFileSync(outside, 'x')
    const c = controller(t)
    expect(await c.listRestorePoints()).toEqual([])
    const r = await c.deleteRestorePoints([outside])
    expect(r.kind).toBe('done')
    if (r.kind !== 'done') return
    expect(r.failures).toHaveLength(1)
    expect(existsSync(outside)).toBe(true)
  })
})

describe('ManageController: notes', () => {
  it('finds, searches, previews and deletes only listed notes', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    writeFileSync(join(a, 'README.md'), 'line one\nfind the needle here\nneedle again')
    writeFileSync(join(a, 'other.md'), 'nothing')
    const c = controller(t)
    await c.listProjects()
    const idx = await c.findNotes(false)
    expect(idx.notes.map(n => n.relativePath).sort()).toEqual(['other.md', 'README.md'].sort())
    expect(idx.truncated).toEqual([])

    const all = await c.searchNotes('')
    expect(all.ok && all.hits.length).toBe(2)
    const hit = await c.searchNotes('NEEDLE')
    if (!hit.ok) throw new Error('cancelled')
    expect(hit.hits).toHaveLength(1)
    expect(hit.hits[0]).toMatchObject({ relativePath: 'README.md', matchCount: 2, firstLineNumber: 2, firstLineText: 'find the needle here' })

    const readme = join(a, 'README.md')
    expect(await c.previewNote(readme)).toEqual({ kind: 'text', text: 'line one\nfind the needle here\nneedle again' })
    expect((await c.previewNote(join(a, 'nope.md'))).kind).toBe('message')
    expect(await c.canOpenInEditor(readme)).toBe(true)

    const stray = join(t.root, 'stray.md')
    writeFileSync(stray, 'x')
    const d = await c.deleteNotes([readme, stray])
    expect(d.kind).toBe('done')
    if (d.kind !== 'done') return
    expect(d.done).toEqual([readme])
    expect(d.failures.map(f => f.path)).toEqual([stray])
    expect(existsSync(readme)).toBe(false)
    expect(existsSync(stray)).toBe(true)
    expect((await c.findNotes(false)).notes.map(n => n.relativePath)).toEqual(['other.md'])
  })

  it('previews a note over the size cap as a message', async () => {
    const t = tree()
    const a = t.workDir('Alpha')
    t.addSession(a, 's1')
    writeFileSync(join(a, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 10))
    const c = controller(t)
    await c.findNotes(false)
    const p = await c.previewNote(join(a, 'big.md'))
    expect(p.kind).toBe('message')
    expect(p.text).toContain('too large')
  })
})

describe('ManageController: live sessions', () => {
  it('labels Delegatto-owned sessions', () => {
    const t = tree()
    const c = controller(t, { current: [LIVE, { ...LIVE, pid: 5, sessionId: 'x' }] })
    expect(c.liveSessions().map(s => s.owner)).toEqual(['app', 'external'])
  })
})

describe('retireRenamedProject', () => {
  it('moves the channel metadata to the new folder name and drops the old rows', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO projects (dir_name) VALUES ('Old')").run()
    db.prepare("INSERT INTO channel_meta (dir_name, friendly_name, starred) VALUES ('Old', 'My chan', 1)").run()
    retireRenamedProject(db, 'Old', 'New')
    expect(db.prepare('SELECT dir_name AS d FROM projects').all()).toEqual([])
    expect(db.prepare('SELECT dir_name AS d, friendly_name AS n, starred AS s FROM channel_meta').all())
      .toEqual([{ d: 'New', n: 'My chan', s: 1 }])
  })
})
