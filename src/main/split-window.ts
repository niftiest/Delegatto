import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import type { Catalog } from './catalog/db'
import { loadSplitState, saveSplitState, splitPaneNames, withPaneProjects } from './catalog/split-view-store'
import { usableBounds } from './update-resume'
import type { WindowHub } from './window-hub'
import { IPC, type MainAction } from '../shared/ipc'
import {
  MIN_PANE, SPLIT_LAYOUTS, coerceSplitState, layoutColumns, layoutRows, rearrange, splitTitle, swapPanes,
  type SplitLayout, type SplitRatios, type SplitState
} from '../shared/split-view'

/** How long window moves and resizes settle before they are saved. */
const SAVE_AFTER_MS = 500
/** The slim strip above the panes. */
const STRIP_HEIGHT = 40

export type SplitWindowOpts = {
  preload: string
  /** Loads the renderer with this query string (no leading `?`). */
  load: (win: BrowserWindow, query: string) => void
  icon?: string
  /** Each time the split window is made, before it loads. */
  onCreated?: (win: BrowserWindow) => void
  /** After the split window has gone. Its contents are passed because the window can no longer be asked for them. */
  onClosed?: (contents: WebContents) => void
  /** The split window's page crashed. Whatever it was showing has gone with it. */
  onRendererGone?: (contents: WebContents) => void
}

export type SplitWindowHandle = {
  /** Reopens the split window if it was open when the app last quit. */
  restore(how?: { inactive?: boolean; minimized?: boolean }): void
  /** Saves the window as it is, still open, and stops tracking it. For quitting. */
  dispose(): void
}

/** Smallest page that still fits every pane at its minimum size. */
export function splitMinSize(layout: SplitLayout): { width: number; height: number } {
  return { width: layoutColumns(layout) * MIN_PANE.width, height: layoutRows(layout) * MIN_PANE.height + STRIP_HEIGHT }
}

type Size = { width: number; height: number }

/** The outer window's minimum: the page's, plus the native frame around it, but never more
 *  than the screen it's on, where a window that big couldn't be placed. */
export function splitWindowMinSize(layout: SplitLayout, frame: Size, workArea: Size): Size {
  const page = splitMinSize(layout)
  return {
    width: Math.min(page.width + Math.max(0, frame.width), workArea.width),
    height: Math.min(page.height + Math.max(0, frame.height), workArea.height)
  }
}

const MAIN_ACTION_KINDS = new Set(['settings', 'search', 'newChat', 'memory', 'delete', 'syncProject', 'signIn'])
const isMainAction = (x: unknown): x is MainAction =>
  typeof x === 'object' && x !== null && MAIN_ACTION_KINDS.has((x as { kind?: unknown }).kind as string)

/** The one split window: made and rearranged on request, remembered across restarts. */
export function registerSplitWindow(db: Catalog, hub: WindowHub, opts: SplitWindowOpts): SplitWindowHandle {
  let state: SplitState | null = loadSplitState(db)
  let win: BrowserWindow | null = null
  let disposed = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?')
  const chatExists = (pk: number): boolean => exists.get(pk) !== undefined
  const live = (): BrowserWindow | null => (win !== null && !win.isDestroyed() ? win : null)

  /** Reads the window's own state into `state`: normal bounds, maximized and minimized. */
  const takeWindow = (): void => {
    const w = live()
    if (w === null || state === null) return
    state = { ...state, bounds: w.getNormalBounds(), maximized: w.isMaximized(), minimized: w.isMinimized() }
  }
  const saveNow = (): void => {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
    if (state !== null) saveSplitState(db, state)
  }
  const saveSoon = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; takeWindow(); saveNow() }, SAVE_AFTER_MS)
  }
  const announce = (): void => hub.send(IPC.splitViewChanged, state)

  /** The native frame around the window's page, measured once the window is made and before
   *  it's maximized: the panes' minimums are for the page, and the minimum size is the window's. */
  let frame: Size = { width: 0, height: 0 }
  const fitMinimum = (w: BrowserWindow, layout: SplitLayout): void => {
    const area = screen.getDisplayMatching(w.getBounds()).workArea
    const min = splitWindowMinSize(layout, frame, area)
    w.setMinimumSize(min.width, min.height)
  }

  /** Brings the window's title and minimum size in line with the state. */
  const refreshWindow = (): void => {
    const w = live()
    if (w === null || state === null) return
    w.setTitle(splitTitle(splitPaneNames(db, state.panes)))
    fitMinimum(w, state.layout)
  }

  /** The state with these changes, checked the same way a stored one is. Null when they don't make a usable state. */
  const changed = (patch: Partial<SplitState>): SplitState | null => {
    const base: SplitState = state ?? { layout: 'halves', ratios: {}, panes: [], bounds: null, maximized: false, minimized: false, open: false }
    return coerceSplitState({ ...base, ...patch }, chatExists)
  }
  const apply = (next: SplitState): void => {
    state = next
    refreshWindow()
    saveNow()
    announce()
  }

  const bringToFront = (w: BrowserWindow): void => {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  const create = (how: 'focus' | 'inactive' | 'minimized'): void => {
    if (state === null || live() !== null) return
    const s = state
    const displays = screen.getAllDisplays().map(d => d.workArea)
    const remembered = s.bounds === null ? null : usableBounds(s.bounds, displays)
    // First time: on the main window's monitor, maximized.
    const main = hub.main()
    const area = (main !== null ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()).workArea
    const bounds = remembered ?? area
    const maximize = remembered === null || s.maximized

    const w = new BrowserWindow({
      // The minimum size is set below, once the frame around the page can be measured.
      ...bounds,
      show: false,
      title: splitTitle(splitPaneNames(db, s.panes)),
      ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
      backgroundColor: '#080B13',
      webPreferences: {
        preload: opts.preload,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    // Made on a monitor whose scaling differs from the main one, a window comes out scaled
    // by the difference. It's on the right monitor by now, so the same size sticks.
    w.setBounds(bounds)
    const [outerW = 0, outerH = 0] = w.getSize()
    const [pageW = 0, pageH = 0] = w.getContentSize()
    frame = { width: outerW - pageW, height: outerH - pageH }
    fitMinimum(w, s.layout)
    win = w
    const contents = w.webContents
    hub.register(w, 'split')

    // A crashed page is reloaded once. If it crashes again it's closed, as if the user had
    // closed it: the panes are kept for the next time.
    let reloaded = false
    contents.on('render-process-gone', () => {
      opts.onRendererGone?.(contents)
      if (disposed || w.isDestroyed()) return
      if (!reloaded) { reloaded = true; contents.reload(); return }
      w.close()
    })

    // The title is ours: the page's own <title> would replace it.
    w.on('page-title-updated', e => e.preventDefault())
    const moved = (): void => { if (!disposed) saveSoon() }
    // Moved to another screen, the cap on the minimum size is that screen's.
    w.on('moved', () => { if (!disposed && state !== null && !w.isDestroyed()) fitMinimum(w, state.layout) })
    w.on('move', moved)
    w.on('resize', moved)
    w.on('maximize', moved)
    w.on('unmaximize', moved)
    w.on('minimize', moved)
    w.on('restore', moved)
    // Windows is shutting down: the window closes with the app, so it should come back.
    w.on('session-end', () => handle.dispose())
    w.on('close', () => {
      if (disposed || state === null) return
      takeWindow()
      // The user closed it, so it doesn't come back at the next launch. The panes and ratios
      // are saved with it; opening it again from the main window starts a new set of panes,
      // with that window's chat first, and keeps only the ratios and the window's place.
      state = { ...state, open: false }
      saveNow()
    })
    w.on('closed', () => {
      if (win === w) win = null
      opts.onClosed?.(contents)
      if (!disposed) announce()
    })

    w.once('ready-to-show', () => {
      if (w.isDestroyed()) return
      if (maximize) w.maximize()
      if (how === 'minimized') {
        w.showInactive()
        w.minimize()
      } else if (how === 'inactive') {
        w.showInactive()
      } else {
        w.show()
        w.focus()
      }
    })

    opts.onCreated?.(w)
    opts.load(w, 'view=split')
  }

  ipcMain.handle(IPC.splitViewOpen, (_e, layout: unknown, panes: unknown) => {
    if (!SPLIT_LAYOUTS.includes(layout as SplitLayout) || !Array.isArray(panes)) return
    const next = changed({ layout: layout as SplitLayout, panes: withPaneProjects(db, panes), open: true })
    if (next === null) return
    apply(next)
    const w = live()
    if (w !== null) bringToFront(w)
    else create('focus')
  })
  ipcMain.handle(IPC.splitViewGet, () => state)
  ipcMain.handle(IPC.splitViewSetLayout, (_e, layout: unknown, panes?: unknown) => {
    if (state === null || !SPLIT_LAYOUTS.includes(layout as SplitLayout)) return
    // The panes the window chose to keep, or the usual rearranging: empty slots go first,
    // then the last filled panes. Coercing checks either, with the projects taken from the catalog.
    const kept = Array.isArray(panes) ? withPaneProjects(db, panes) : rearrange(state.panes, layout as SplitLayout).panes
    const next = changed({ layout: layout as SplitLayout, panes: kept })
    if (next !== null) apply(next)
  })
  ipcMain.handle(IPC.splitViewSetPane, (_e, index: unknown, pane: unknown) => {
    if (state === null || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= state.panes.length) return
    const panes = [...state.panes]
    // The project comes from the catalog: one project to a pane is checked on it.
    panes[index] = withPaneProjects(db, [pane])[0] ?? null
    const next = changed({ panes })
    if (next !== null) apply(next)
  })
  // Dragging a pane onto another: both slots change in one write. Two setPane calls would put
  // one project in two panes for a moment, and coercing would empty one of them.
  ipcMain.handle(IPC.splitViewSwap, (_e, a: unknown, b: unknown) => {
    if (state === null) return
    const n = state.panes.length
    const slot = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < n
    if (!slot(a) || !slot(b) || a === b) return
    const next = changed({ panes: withPaneProjects(db, swapPanes(state.panes, a, b)) })
    if (next !== null) apply(next)
  })
  ipcMain.handle(IPC.splitViewSetRatios, (_e, layout: unknown, ratios: unknown) => {
    if (state === null || !SPLIT_LAYOUTS.includes(layout as SplitLayout)) return
    const next = changed({ ratios: { ...state.ratios, [layout as SplitLayout]: ratios as SplitRatios } })
    // A bad ratio is dropped by coercing; only a change that survived is kept.
    if (next === null || next.ratios[layout as SplitLayout] === undefined) return
    apply(next)
  })
  const onFocusMain = (_e: Electron.IpcMainEvent, action: unknown): void => {
    if (!isMainAction(action)) return
    const main = hub.main()
    if (main === null) return
    bringToFront(main)
    main.webContents.send(IPC.mainAction, action)
  }
  ipcMain.on(IPC.focusMain, onFocusMain)

  const handle: SplitWindowHandle = {
    restore(how = {}) {
      if (disposed || state === null || !state.open || live() !== null) return
      // A chat deleted since may have emptied a slot; keep that.
      saveNow()
      create(how.minimized === true || state.minimized ? 'minimized' : how.inactive === true ? 'inactive' : 'focus')
    },
    dispose() {
      if (disposed) return
      takeWindow()
      saveNow()
      disposed = true
      for (const ch of [IPC.splitViewOpen, IPC.splitViewGet, IPC.splitViewSetLayout, IPC.splitViewSetPane, IPC.splitViewSetRatios, IPC.splitViewSwap]) ipcMain.removeHandler(ch)
      ipcMain.removeListener(IPC.focusMain, onFocusMain)
    }
  }
  return handle
}
