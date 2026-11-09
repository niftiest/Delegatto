import { describe, it, expect, vi, beforeEach } from 'vitest'

// A stand-in for the parts of electron the split window uses, so its open/close/quit
// bookkeeping can be checked without a real window.
const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const windows: unknown[] = []
  // The display's work area, and the native frame around a window's page.
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const frame = { width: 16, height: 39 }
  return { handlers, listeners, windows, area, frame }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWindow extends EventEmitter {
    static nextId = 1
    id = FakeWindow.nextId++
    destroyed = false
    maximized = false
    minimized = false
    bounds = { x: 0, y: 0, width: 1600, height: 900 }
    minimum: [number, number] | null = null
    reloads = 0
    webContents = Object.assign(new EventEmitter(), { id: this.id, send: () => {}, reload: () => { this.reloads++ } })
    constructor(readonly opts: { minWidth?: number; minHeight?: number; title?: string }) {
      super()
      this.title = opts.title ?? ''
      if (opts.minWidth !== undefined || opts.minHeight !== undefined) this.minimum = [opts.minWidth ?? 0, opts.minHeight ?? 0]
      fake.windows.push(this)
    }
    getSize() { return [this.bounds.width, this.bounds.height] }
    getContentSize() { return [this.bounds.width - fake.frame.width, this.bounds.height - fake.frame.height] }
    isDestroyed() { return this.destroyed }
    getNormalBounds() { return this.bounds }
    getBounds() { return this.bounds }
    setBounds(b: typeof this.bounds) { this.bounds = b }
    isMaximized() { return this.maximized }
    isMinimized() { return this.minimized }
    maximize() { this.maximized = true }
    minimize() { this.minimized = true }
    restore() { this.minimized = false }
    show() {}
    showInactive() {}
    focus() {}
    title = ''
    setTitle(t: string) { this.title = t }
    setMinimumSize(width: number, height: number) { this.minimum = [width, height] }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed') }
  }
  const area = fake.area
  return {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => { fake.handlers.set(ch, fn) },
      removeHandler: (ch: string) => { fake.handlers.delete(ch) },
      on: (ch: string, fn: (...a: unknown[]) => unknown) => { fake.listeners.set(ch, fn) },
      removeListener: (ch: string) => { fake.listeners.delete(ch) }
    },
    screen: {
      getAllDisplays: () => [{ workArea: area }],
      getDisplayMatching: () => ({ workArea: area }),
      getPrimaryDisplay: () => ({ workArea: area })
    }
  }
})

import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd, upsertSession } from '../src/main/catalog/repos'
import { loadSplitState } from '../src/main/catalog/split-view-store'
import { registerSplitWindow, splitMinSize } from '../src/main/split-window'
import { IPC } from '../src/shared/ipc'
import type { WindowHub } from '../src/main/window-hub'

type Win = {
  close(): void; isDestroyed(): boolean; minimum: [number, number] | null; reloads: number; title: string
  webContents: { emit(event: string, ...args: unknown[]): void }
}

function seed() {
  const db = openCatalog(':memory:')
  const p = upsertProject(db, 'C--GIT-PlantPal')
  setProjectCwd(db, p, 'C:\\GIT\\PlantPal')
  const q = upsertProject(db, 'C--GIT-ledger')
  setProjectCwd(db, q, 'C:\\GIT\\ledger')
  const a = upsertSession(db, { projectId: p, sessionId: 'a', kind: 'main', filePath: '/f/a.jsonl', fileSize: 1, fileMtimeMs: 1 })
  const b = upsertSession(db, { projectId: q, sessionId: 'b', kind: 'main', filePath: '/f/b.jsonl', fileSize: 1, fileMtimeMs: 1 })
  return { db, a, b }
}

const hub = { register: () => {}, send: () => {}, main: () => null } as unknown as WindowHub
const start = (db: ReturnType<typeof seed>['db']) => registerSplitWindow(db, hub, { preload: 'p.js', load: () => {} })

async function openSplit(a: number, b: number): Promise<void> {
  await fake.handlers.get(IPC.splitViewOpen)!({}, 'halves', [{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: b, projectDir: 'C--GIT-ledger' }])
}

describe('split window across restarts', () => {
  beforeEach(() => {
    fake.handlers.clear(); fake.listeners.clear(); fake.windows.length = 0
    Object.assign(fake.area, { x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('reopens after quitting (or an update restart) while it was open', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    await openSplit(a, b)
    expect(fake.windows).toHaveLength(1)

    // Quitting disposes before the windows close, as before-quit does.
    first.dispose()
    ;(fake.windows[0] as Win).close()
    expect(loadSplitState(db)?.open).toBe(true)

    // The next launch.
    const second = start(db)
    second.restore()
    expect(fake.windows).toHaveLength(2)
    expect(loadSplitState(db)?.panes.map(p => p?.sessionPk)).toEqual([a, b])
  })

  it('stays closed after the user closes it', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    await openSplit(a, b)
    ;(fake.windows[0] as Win).close()
    first.dispose()
    expect(loadSplitState(db)?.open).toBe(false)

    const second = start(db)
    second.restore()
    expect(fake.windows).toHaveLength(1)
    // The panes are kept, so opening again starts from them.
    expect(loadSplitState(db)?.panes.map(p => p?.sessionPk)).toEqual([a, b])
  })

  it('sizes the window for every column and row at its minimum', () => {
    expect(splitMinSize('halves')).toEqual({ width: 720, height: 320 })
    expect(splitMinSize('thirds')).toEqual({ width: 1080, height: 320 })
    expect(splitMinSize('one-two')).toEqual({ width: 720, height: 600 })
    expect(splitMinSize('grid')).toEqual({ width: 720, height: 600 })
  })

  it('takes the panes the user chose to keep with a layout change, or rearranges them itself', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    const pa = { sessionPk: a, projectDir: 'C--GIT-PlantPal' }
    const pb = { sessionPk: b, projectDir: 'C--GIT-ledger' }
    await fake.handlers.get(IPC.splitViewOpen)!({}, 'grid', [pa, null, null, pb])
    await fake.handlers.get(IPC.splitViewSetLayout)!({}, 'thirds')
    expect(loadSplitState(db)?.panes).toEqual([pa, pb, null])
    await fake.handlers.get(IPC.splitViewSetLayout)!({}, 'halves', [pb, null])
    expect(loadSplitState(db)).toMatchObject({ layout: 'halves', panes: [pb, null] })
    first.dispose()
  })

  it('keeps both of three side by side\'s dividers', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    await openSplit(a, b)
    await fake.handlers.get(IPC.splitViewSetRatios)!({}, 'thirds', { col: 0.3, row: 0.5, col2: 0.55 })
    expect(loadSplitState(db)?.ratios.thirds).toEqual({ col: 0.3, row: 0.5, col2: 0.55 })
    first.dispose()
  })

  it('takes each pane\'s project from its chat, not from what the window said', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    // The window names the wrong projects, swapped.
    await fake.handlers.get(IPC.splitViewOpen)!({}, 'halves', [{ sessionPk: a, projectDir: 'C--GIT-ledger' }, { sessionPk: b, projectDir: 'C--GIT-PlantPal' }])
    expect(loadSplitState(db)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: b, projectDir: 'C--GIT-ledger' }])
    first.dispose()
  })

  it('keeps one project to a pane however the window names them', async () => {
    const { db, a, b } = seed()
    const plant = db.prepare('SELECT project_id AS id FROM sessions WHERE id = ?').get(a) as { id: number }
    const c = upsertSession(db, { projectId: plant.id, sessionId: 'c', kind: 'main', filePath: '/f/c.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const first = start(db)
    // Opening: a second PlantPal chat that claims to be ledger's.
    await fake.handlers.get(IPC.splitViewOpen)!({}, 'halves', [{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: c, projectDir: 'C--GIT-ledger' }])
    expect(loadSplitState(db)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, null])
    // Putting it in a pane.
    await fake.handlers.get(IPC.splitViewSetPane)!({}, 1, { sessionPk: c, projectDir: 'C--GIT-ledger' })
    expect(loadSplitState(db)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, null])
    await fake.handlers.get(IPC.splitViewSetPane)!({}, 1, { sessionPk: b, projectDir: 'whatever' })
    expect(loadSplitState(db)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: b, projectDir: 'C--GIT-ledger' }])
    // Changing the layout with the panes the window kept.
    await fake.handlers.get(IPC.splitViewSetLayout)!({}, 'thirds', [{ sessionPk: a, projectDir: 'x' }, { sessionPk: c, projectDir: 'y' }, { sessionPk: b, projectDir: 'z' }])
    expect(loadSplitState(db)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, null, { sessionPk: b, projectDir: 'C--GIT-ledger' }])
    first.dispose()
  })

  it('swaps two panes in one step, so neither is emptied as a duplicate project', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    const sent: unknown[] = []
    const watching = { ...hub, send: (_ch: string, s: unknown) => { sent.push(s) } } as unknown as WindowHub
    first.dispose()
    const second = registerSplitWindow(db, watching, { preload: 'p.js', load: () => {} })
    const pa = { sessionPk: a, projectDir: 'C--GIT-PlantPal' }
    const pb = { sessionPk: b, projectDir: 'C--GIT-ledger' }
    await fake.handlers.get(IPC.splitViewOpen)!({}, 'thirds', [pa, null, pb])
    sent.length = 0
    const w = fake.windows[fake.windows.length - 1] as Win
    expect(w.title).toBe('Delegatto: Split view (PlantPal, ledger)')
    await fake.handlers.get(IPC.splitViewSwap)!({}, 0, 2)
    expect(loadSplitState(db)?.panes).toEqual([pb, null, pa])
    expect(sent).toHaveLength(1)
    // The title lists the projects in their new order.
    expect(w.title).toBe('Delegatto: Split view (ledger, PlantPal)')
    // Into an empty slot: the pane moves and its old slot is left empty.
    await fake.handlers.get(IPC.splitViewSwap)!({}, 2, 1)
    expect(loadSplitState(db)?.panes).toEqual([pb, pa, null])
    // Bad indexes change nothing and announce nothing.
    sent.length = 0
    for (const [x, y] of [[0, 3], [-1, 0], [0.5, 1], ['0', 1], [1, 1]]) await fake.handlers.get(IPC.splitViewSwap)!({}, x, y)
    expect(loadSplitState(db)?.panes).toEqual([pb, pa, null])
    expect(sent).toHaveLength(0)
    second.dispose()
    expect(fake.handlers.has(IPC.splitViewSwap)).toBe(false)
  })

  it('makes the page, not the outer window, big enough for every pane', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    await openSplit(a, b)
    const w = fake.windows[0] as Win
    expect(w.minimum).toEqual([720 + 16, 320 + 39])
    await fake.handlers.get(IPC.splitViewSetLayout)!({}, 'thirds')
    expect(w.minimum).toEqual([1080 + 16, 320 + 39])
    first.dispose()
  })

  it('never asks for a minimum bigger than the screen', async () => {
    const { db, a, b } = seed()
    // 1024 x 768 at 150%, less the taskbar.
    Object.assign(fake.area, { width: 683, height: 480 })
    const first = start(db)
    await fake.handlers.get(IPC.splitViewOpen)!({}, 'grid', [{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: b, projectDir: 'C--GIT-ledger' }, null, null])
    const w = fake.windows[0] as Win
    expect(w.minimum).toEqual([683, 480])
    first.dispose()
  })

  it('reloads a split window whose page crashed, and stops counting what it showed', async () => {
    const { db, a, b } = seed()
    const gone: unknown[] = []
    const first = registerSplitWindow(db, hub, { preload: 'p.js', load: () => {}, onRendererGone: c => gone.push(c) })
    await openSplit(a, b)
    const w = fake.windows[0] as Win
    w.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(w.reloads).toBe(1)
    expect(w.isDestroyed()).toBe(false)
    expect(gone).toEqual([w.webContents])
    first.dispose()
  })

  it('closes it, as the user would, if the page crashes again', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    await openSplit(a, b)
    const w = fake.windows[0] as Win
    w.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    w.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(w.reloads).toBe(1)
    expect(w.isDestroyed()).toBe(true)
    expect(loadSplitState(db)).toMatchObject({ open: false, panes: [{ sessionPk: a }, { sessionPk: b }] })
    first.dispose()
  })

  it('keeps a deleted chat\'s slot empty when it comes back', async () => {
    const { db, a, b } = seed()
    const first = start(db)
    await openSplit(a, b)
    first.dispose()
    db.prepare('DELETE FROM sessions WHERE id = ?').run(b)

    const second = start(db)
    second.restore()
    expect(fake.windows).toHaveLength(2)
    expect(loadSplitState(db)?.panes.map(p => p?.sessionPk ?? null)).toEqual([a, null])
  })
})
