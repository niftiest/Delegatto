import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from './api'
import type { ChannelRow, SessionSummary } from '../shared/types'
import type { MainAction } from '../shared/ipc'
import {
  clampRatios, defaultRatios, focusShortcut, gridTemplate, layoutRows, nudgeRatios, paneCount, paneShowing, shownProjects, splitTitle,
  type SplitLayout, type SplitPane, type SplitRatios, type SplitState
} from '../shared/split-view'
import { useAppData } from './app-data'
import { useAppearance } from './appearance'
import { chatPaneTheme, type ThemeChoice } from './theme'
import { useProjectRail, type ProjectRail } from './project-rail'
import { paneBus } from './pane-bus'
import { composeStore } from './compose-store'
import { ChatPane, type AppActions, type PaneSync } from './components/ChatPane'
import { useSyncChat } from './components/SyncChat'
import { Resizer } from './components/Resizer'
import { TextMenuHost } from './components/TextMenu'
import { LayoutMenu } from './components/LayoutMenu'
import { ProjectIcon, SlotPicker } from './components/SlotPicker'
import { askChoiceInApp } from './components/AppDialog'
import { applyPicks, newSlotsRun, planLayoutChange, type PickRun } from './split-flow'
import { resolveChannelIcon, resolveChannelName } from './lib'
import { findCreated, startChatIn } from './start-chat'

/** How long after the last divider move its position is saved. */
const RATIOS_SAVE_MS = 300
const NEW_CHAT_VALUE = '__new__'

const chatLabel = (s: SessionSummary): string => s.title ?? `Untitled · ${s.sessionId.slice(0, 8)}`

/** The split window: 2 to 4 chats side by side, each a full ChatPane, with no nav. App-wide
 *  dialogs open in the main window; a pane's own small dialogs open in the pane. */
export function SplitApp() {
  // Every pane's project's chats, by project id: the chat pickers and the panes' summaries.
  const [sessionsByProject, setSessionsByProject] = useState<ReadonlyMap<number, SessionSummary[]>>(new Map())
  const data = useAppData(() => refreshRef.current())
  const { settings, setSettings, channels, setChannels } = data
  const { themeChoice, chatScaleNote } = useAppearance(settings, setSettings)

  // The window's state: main sends it on every change. Asked for once at the start, unless a
  // change has already said.
  const [split, setSplit] = useState<SplitState | null>(null)
  useEffect(() => {
    let heard = false
    const off = api.onSplitViewChanged(s => { heard = true; setSplit(s) })
    void api.splitViewGet().then(s => { if (!heard) setSplit(s) }).catch(() => {})
    return off
  }, [])

  useEffect(() => { void api.listChannels().then(setChannels).catch(() => {}) }, [setChannels])

  const layout = split?.layout ?? 'halves'
  const count = paneCount(layout)
  const panes: SplitPane[] = useMemo(() => {
    const given = split?.panes ?? []
    return Array.from({ length: count }, (_, i) => given[i] ?? null)
  }, [split, count])

  const projectOf = useCallback((pane: SplitPane): ChannelRow | undefined =>
    pane === null ? undefined : channels.find(c => c.dirName === pane.projectDir), [channels])

  // The projects the panes show, each loaded once however many panes show it.
  const paneProjectIds = useMemo(() => {
    const ids = new Set<number>()
    for (const p of panes) { const c = projectOf(p); if (c !== undefined) ids.add(c.id) }
    return [...ids].sort((a, b) => a - b)
  }, [panes, projectOf])
  const loadSessions = useCallback((projectId: number): Promise<SessionSummary[]> =>
    api.listSessions(projectId).then(list => {
      setSessionsByProject(prev => new Map(prev).set(projectId, list))
      return list
    }), [])
  const projectKey = paneProjectIds.join(',')
  useEffect(() => {
    for (const id of paneProjectIds) void loadSessions(id).catch(() => {})
  }, [projectKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // A catalog sync: the projects and every pane's chat list again.
  const refresh = (): void => {
    void api.listChannels().then(setChannels).catch(() => {})
    for (const id of paneProjectIds) void loadSessions(id).catch(() => {})
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // Summaries handed over with a chat to show (a fork), until the chat list has it.
  const handedOver = useRef(new Map<number, SessionSummary>())
  const sessionOf = (pane: SplitPane, project: ChannelRow | undefined): SessionSummary | undefined => {
    if (pane === null) return undefined
    const listed = project === undefined ? undefined : sessionsByProject.get(project.id)?.find(s => s.id === pane.sessionPk)
    return listed ?? handedOver.current.get(pane.sessionPk)
  }

  // A pane whose chat or project has gone (deleted while it was showing) becomes an empty slot.
  // Checked again first, so a list read just before a new chat landed can't empty its pane.
  const clearing = useRef(new Set<number>())
  useEffect(() => {
    if (channels.length === 0) return
    panes.forEach((pane, i) => {
      if (pane === null || clearing.current.has(pane.sessionPk)) return
      const project = projectOf(pane)
      const list = project === undefined ? undefined : sessionsByProject.get(project.id)
      if (list?.some(s => s.id === pane.sessionPk) === true) { handedOver.current.delete(pane.sessionPk); return }
      if (project !== undefined && list === undefined) return
      if (handedOver.current.has(pane.sessionPk)) return
      clearing.current.add(pane.sessionPk)
      void (async () => {
        try {
          const fresh = await api.listChannels()
          const p = fresh.find(c => c.dirName === pane.projectDir)
          const chats = p === undefined ? [] : await api.listSessions(p.id)
          // The slot may show something else by now; only the gone chat is cleared.
          if (!chats.some(s => s.id === pane.sessionPk) && panesRef.current[i]?.sessionPk === pane.sessionPk) await api.splitViewSetPane(i, null)
        } catch { /* keep the pane; the next sync checks again */ }
        finally { clearing.current.delete(pane.sessionPk) }
      })()
    })
  }, [panes, channels, sessionsByProject, projectOf])

  // ── Focus ──────────────────────────────────────────────────────────────────
  const [focusedIndex, setFocusedIndex] = useState(0)
  useEffect(() => { if (focusedIndex >= count) setFocusedIndex(0) }, [count, focusedIndex])
  const gridRef = useRef<HTMLDivElement>(null)
  /** Focuses a pane and puts the cursor in its message box. */
  const focusPane = useCallback((index: number): void => {
    setFocusedIndex(index)
    const pane = gridRef.current?.querySelector<HTMLElement>(`[data-pane="${index}"]`)
    const box = pane?.querySelector<HTMLElement>('.composer textarea')
    box?.focus()
    // A pane with no message box: keys mustn't still go to another pane's chat.
    const at = document.activeElement
    if (at instanceof HTMLElement && at !== document.body && pane?.contains(at) !== true) at.blur()
  }, [])
  // Ctrl+1 to Ctrl+4 focus a pane. Ctrl+K is the main window's search, as from a pane's /search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        api.focusMain({ kind: 'search' })
        return
      }
      const index = focusShortcut(e, count)
      if (index === null) return
      e.preventDefault()
      focusPane(index)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [count, focusPane])
  // A notification clicked for a chat this window shows: main has brought the window up.
  const panesRef = useRef(panes)
  panesRef.current = panes
  useEffect(() => api.onOpenChat(pk => {
    const index = panesRef.current.findIndex(p => p !== null && p.sessionPk === pk)
    if (index !== -1) focusPane(index)
  }), [focusPane])

  // Main keeps which chats each window shows: notifications, unread and sync presence.
  const visibleKey = panes.map(p => (p === null ? '' : String(p.sessionPk))).join(',')
  useEffect(() => {
    api.setVisibleChats(panes.flatMap(p => (p === null ? [] : [p.sessionPk])))
  }, [visibleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Dividers ───────────────────────────────────────────────────────────────
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = gridRef.current
    if (el === null) return
    const measure = (): void => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [split !== null]) // eslint-disable-line react-hooks/exhaustive-deps
  // While a drag is being saved, the window's own ratios lead.
  const [dragRatios, setDragRatios] = useState<{ layout: string; ratios: SplitRatios } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A save still waiting when the window closes goes now rather than being lost.
  const pendingSave = useRef<(() => void) | null>(null)
  useEffect(() => () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    pendingSave.current?.()
  }, [])
  // Once main's state has what was saved, it leads again.
  useEffect(() => {
    if (dragRatios === null || saveTimer.current !== null) return
    const saved = split?.ratios[dragRatios.layout as SplitState['layout']]
    if (saved !== undefined && saved.col === dragRatios.ratios.col && saved.row === dragRatios.ratios.row && saved.col2 === dragRatios.ratios.col2) setDragRatios(null)
  }, [split, dragRatios])
  const stored = split?.ratios[layout] ?? defaultRatios(layout)
  const wanted = dragRatios !== null && dragRatios.layout === layout ? dragRatios.ratios : stored
  const ratios = size === null ? wanted : clampRatios(layout, wanted, size)
  // The divider's place right now. A drag's handler is the one from when it started, so each
  // move reads and writes this rather than what that render saw.
  const liveRatios = useRef(ratios)
  liveRatios.current = ratios
  const saveRatios = (next: SplitRatios, now = false): void => {
    liveRatios.current = next
    setDragRatios({ layout, ratios: next })
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    const at = layout
    const save = (): void => {
      saveTimer.current = null
      pendingSave.current = null
      void api.splitViewSetRatios(at, next).catch(err => console.error('Saving the divider failed', err))
    }
    pendingSave.current = save
    if (now) save()
    else saveTimer.current = setTimeout(save, RATIOS_SAVE_MS)
  }
  const sizeRef = useRef(size)
  sizeRef.current = size
  const dragBy = (dx: number, dy: number, which: 'col' | 'col2' = 'col'): void => {
    const box = sizeRef.current
    if (box === null) return
    saveRatios(nudgeRatios(layout, liveRatios.current, dx, dy, box, which))
  }
  /** A double-click puts that one divider back where the layout starts it. */
  const resetRatio = (which: 'col' | 'col2' | 'row'): void => {
    const d = defaultRatios(layout)
    const next = { ...ratios, [which]: d[which] }
    saveRatios(size === null ? next : clampRatios(layout, next, size), true)
  }
  const template = gridTemplate(layout, ratios)

  // ── Actions ────────────────────────────────────────────────────────────────
  const focusMain = (action: MainAction): void => api.focusMain(action)
  const notice = (pk: number, text: string): void => paneBus.emit(pk, { kind: 'notice', text })
  const setPane = (index: number, pane: SplitPane): void => {
    void api.splitViewSetPane(index, pane).catch(err => console.error('Changing the pane failed', err))
  }
  /** A chat this pane navigates to (the chat picker, a fork, a find or pin jump, a new chat).
   *  A project fills one pane at most, so when another pane already shows this project, that
   *  pane is focused and shows the chat instead, and this pane stays as it is. */
  const showIn = (index: number, pane: NonNullable<SplitPane>): void => {
    const other = paneShowing(panesRef.current, pane.projectDir, index)
    if (other === -1) { setPane(index, pane); return }
    setPane(other, pane)
    focusPane(other)
  }
  /** Shows a chat main just registered in a pane: the catalog first, then the slot. */
  async function showCreated(index: number, cwd: string, sessionId: string): Promise<boolean> {
    const found = await findCreated(cwd, sessionId)
    setChannels(found.channels)
    if (found.project === null) return false
    const projectId = found.project.id
    setSessionsByProject(prev => new Map(prev).set(projectId, found.chats))
    if (found.created === null) return false
    showIn(index, { sessionPk: found.created.id, projectDir: found.project.dirName })
    return true
  }
  // One new chat at a time, as in the main window: a double click mustn't make two.
  const creating = useRef(false)
  /** A new chat in this pane's project, made the way the New chat dialog makes one. What
   *  needs the dialog (the folder trust check, confirming a chat that skips permissions) goes
   *  to the main window's dialog instead, and the chat opens there. */
  async function newChatIn(index: number, project: ChannelRow, fromPk: number): Promise<void> {
    if (creating.current) return
    creating.current = true
    try {
      const started = await startChatIn(project, settings)
      if (started.kind === 'dialog') { focusMain({ kind: 'newChat', cwd: started.cwd }); return }
      if (started.kind === 'error') { notice(fromPk, started.message); return }
      if (!(await showCreated(index, started.cwd, started.sessionId))) notice(fromPk, 'The new chat is ready. It shows in the chat list once the catalog has it.')
    } catch (err) {
      notice(fromPk, `Couldn't start a new chat: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      creating.current = false
    }
  }
  /** What a pane asks of the window. App-wide dialogs go to the main window. */
  const actionsFor = (index: number, pk: number): AppActions => ({
    openSettings: section => focusMain(section === undefined ? { kind: 'settings' } : { kind: 'settings', section }),
    openSearch: () => focusMain({ kind: 'search' }),
    openMemory: p => focusMain({ kind: 'memory', projectDir: p.dirName }),
    openNewChat: cwd => focusMain({ kind: 'newChat', cwd }),
    deleteChat: target => focusMain({ kind: 'delete', target }),
    syncProject: state => {
      if (state.kind === 'setup') focusMain({ kind: 'settings', section: 'sync' })
      else if (state.kind === 'off') focusMain({ kind: 'syncProject', workingDir: state.workingDir, name: state.name })
      else void api.syncDisableProject(state.projectId).then(r => { if (!r.ok) notice(pk, r.error) })
    },
    signIn: reason => focusMain({ kind: 'signIn', reason }),
    // /clear: the new chat takes this chat's place in the pane.
    clearChat: async sessionPk => {
      if (creating.current) return null
      creating.current = true
      try {
        const outcome = await api.clearChat(sessionPk)
        if (!outcome.ok) return outcome.error
        if (outcome.unchanged) return null
        await showCreated(index, outcome.cwd, outcome.sessionId)
        return null
      } finally {
        creating.current = false
      }
    }
  })

  // ── Layout and picker ──────────────────────────────────────────────────────
  const [pickRun, setPickRun] = useState<PickRun | null>(null)
  const pickFailed = (err: unknown): void => console.error('Changing the split view failed', err)
  /** The strip's layout menu: the same rearranging as from the main window. */
  const onLayoutPick = async (to: SplitLayout): Promise<void> => {
    if (split === null || to === split.layout) return
    const before = split.panes.length
    const next = await planLayoutChange(split, to, channels, askChoiceInApp)
    if (next === null) return
    // New slots are picked first; Cancel there keeps the old layout. Done applies the layout,
    // then the picks that still fit the window as it is by then.
    const run = newSlotsRun(before, next, to, picked => {
      const merged = applyPicks(panesRef.current, to, before, picked)
      void api.splitViewSetLayout(to).then(() => {
        picked.forEach((pick, k) => {
          const index = before + k
          if (pick !== null && merged[index] === pick) setPane(index, pick)
        })
      }).catch(pickFailed)
    })
    if (run !== null) { setPickRun(run); return }
    // The panes the user kept go with the layout, so main doesn't pick its own to close.
    await api.splitViewSetLayout(to, next)
  }
  /** An empty slot's Select project, or a pane's Replace. Its own project may be picked again. */
  const onPickSlot = (index: number): void => {
    setPickRun({
      layout, startIndex: index, count: 1, exclude: shownProjects(panesRef.current, index),
      done: picked => { const pane = picked[0] ?? null; if (pane !== null) setPane(index, pane) }
    })
  }

  // ── Dragging a pane by its name onto another ───────────────────────────────
  // `over` is the slot under the pointer, or null outside every pane. Set once the pointer
  // has moved far enough to count as a drag, so a click on the name is still a click.
  const [paneDrag, setPaneDrag] = useState<{ from: number; over: number | null } | null>(null)
  const endDrag = useRef<((drop: boolean) => void) | null>(null)
  // The pane being dragged. If main empties, replaces or moves it mid-drag (or the layout
  // changes), the drag is over: its grip may be gone, and with it the grip's listeners.
  const dragSource = useRef<{ from: number; pk: number } | null>(null)
  useEffect(() => () => endDrag.current?.(false), [])
  useEffect(() => {
    const src = dragSource.current
    if (src !== null && panes[src.from]?.sessionPk !== src.pk) endDrag.current?.(false)
  }, [panes])
  // The moved pane keeps the focus, ring and message box, once main's state has it in its new
  // slot. Before paint, so the old slot doesn't show the ring for a frame. Only the first
  // change after a swap is looked at: a swap that changed nothing leaves nothing behind.
  const follow = useRef<{ pk: number; at: number } | null>(null)
  useLayoutEffect(() => {
    const f = follow.current
    if (f === null) return
    follow.current = null
    if (panes[f.at]?.sessionPk === f.pk) focusPane(f.at)
  }, [panes, focusPane])
  /** One write in main for both slots: two setPane calls would show one project in two panes
   *  for a moment, and main would empty one of them. */
  const swapSlots = (from: number, to: number): void => {
    const moved = panesRef.current[from]
    follow.current = moved === null || moved === undefined ? null : { pk: moved.sessionPk, at: to }
    void api.splitViewSwap(from, to).catch(err => { follow.current = null; console.error('Moving the pane failed', err) })
  }
  const paneAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-pane]')
    if (el === null || el === undefined || gridRef.current?.contains(el) !== true) return null
    const i = Number(el.dataset.pane)
    return Number.isInteger(i) && i >= 0 && i < panesRef.current.length ? i : null
  }
  const startPaneDrag = (from: number, e: ReactPointerEvent<HTMLElement>): void => {
    const source = panesRef.current[from]
    if (e.button !== 0 || endDrag.current !== null || source === null || source === undefined) return
    // No text selection. The focus goes to this pane's message box when the pointer comes
    // up, as a click on the pane would put it.
    e.preventDefault()
    const grip = e.currentTarget
    const id = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    let started = false
    let over: number | null = null
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
      started = true
      over = paneAt(ev.clientX, ev.clientY)
      setPaneDrag({ from, over })
    }
    const onUp = (ev: PointerEvent): void => { if (ev.pointerId === id) end(true) }
    const onLost = (ev: PointerEvent): void => { if (ev.pointerId === id) end(false) }
    // Esc cancels the drag and nothing else: it doesn't reach the chat, where it would stop a turn.
    // Nor does it close a dialog of the pane's.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      end(false)
    }
    // On the document: the grip's events bubble there while it holds the pointer, and a grip
    // removed mid-drag loses the pointer with its lostpointercapture fired at the document.
    const end = (drop: boolean): void => {
      if (endDrag.current !== end) return
      endDrag.current = null
      dragSource.current = null
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onLost)
      document.removeEventListener('lostpointercapture', onLost)
      window.removeEventListener('keydown', onKey, true)
      if (grip.isConnected && grip.hasPointerCapture(id)) grip.releasePointerCapture(id)
      setPaneDrag(null)
      if (!drop) return
      if (!started) focusPane(from)
      else if (over !== null && over !== from) swapSlots(from, over)
    }
    endDrag.current = end
    dragSource.current = { from, pk: source.sessionPk }
    grip.setPointerCapture(id)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onLost)
    document.addEventListener('lostpointercapture', onLost)
    window.addEventListener('keydown', onKey, true)
  }
  /** What a slot says while a pane is dragged over it. */
  const dropLabel = (i: number): string | null =>
    paneDrag === null || paneDrag.over !== i || paneDrag.from === i ? null : panes[i] === null ? 'Move here' : 'Swap'

  // ── The right-click menu: pins act on the focused pane's chat ──────────────
  const [rails, setRails] = useState<ReadonlyMap<number, ProjectRail>>(new Map())
  const onRail = useCallback((index: number, rail: ProjectRail | null): void => {
    setRails(prev => {
      if (prev.get(index) === rail || (rail === null && !prev.has(index))) return prev
      const next = new Map(prev)
      if (rail === null) next.delete(index)
      else next.set(index, rail)
      return next
    })
  }, [])
  const focusedPane = panes[focusedIndex] ?? null
  const focusedRail = rails.get(focusedIndex)
  const NO_PINS = useMemo(() => new Set<string>(), [])
  const onPin = (uuid: string): void => {
    if (focusedPane === null) return
    const pk = focusedPane.sessionPk
    void api.pinMessage(pk, uuid).then(ok => {
      if (ok) focusedRail?.refreshPins()
      else notice(pk, "That message couldn't be pinned yet. Try again in a moment.")
    })
  }
  const onUnpin = (uuid: string): void => {
    if (focusedPane === null) return
    void api.unpinMessage(focusedPane.sessionPk, uuid).then(() => focusedRail?.refreshPins())
  }

  const names = panes.map(p => {
    const c = projectOf(p)
    return c === undefined ? null : resolveChannelName(c.meta, c.cwd, c.dirName)
  })
  const twoRows = layoutRows(layout) > 1

  return (
    <div className={`split-shell${paneDrag !== null ? ' pane-dragging' : ''}`} data-density={settings?.density ?? 'comfortable'}>
      <TextMenuHost pinned={focusedRail?.pinnedUuids ?? NO_PINS} onPin={onPin} onUnpin={onUnpin} />
      {chatScaleNote !== null && <div className="chat-scale-note" role="status">{chatScaleNote}%</div>}
      <div className="split-strip">
        <LayoutMenu look="strip" current={split === null ? null : layout} onPick={to => void onLayoutPick(to).catch(pickFailed)} />
        <div className="split-strip-title">{splitTitle(names)}</div>
      </div>
      <div className="split-grid" ref={gridRef}
        style={{ gridTemplateColumns: template.columns, gridTemplateRows: template.rows, gridTemplateAreas: template.areas.join(' ') }}>
        {split !== null && panes.map((pane, i) => {
          const project = projectOf(pane)
          const session = sessionOf(pane, project)
          const area = `p${i + 1}`
          const drop = dropLabel(i)
          const slotClass = `split-pane${i === focusedIndex ? ' focused' : ''}${drop !== null ? ' drop-target' : ''}`
          if (pane === null) {
            return {
              order: [1, i],
              node: (
                <section key={`empty-${i}`} data-pane={i} className={`${slotClass} split-empty`}
                  style={{ gridArea: area }} onPointerDownCapture={() => setFocusedIndex(i)}>
                  <button type="button" className="btn-primary split-select-project" onClick={() => onPickSlot(i)}>
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                    Select project
                  </button>
                  <DropOverlay label={drop} />
                </section>
              )
            }
          }
          if (project === undefined || session === undefined) {
            return {
              order: [1, i],
              node: (
                <section key={`loading-${i}`} data-pane={i} className={slotClass}
                  style={{ gridArea: area }} onPointerDownCapture={() => setFocusedIndex(i)}>
                  <div className="empty">Opening the chat…</div>
                  <DropOverlay label={drop} />
                </section>
              )
            }
          }
          // Keyed by project (one to a pane) and kept in the same place among the grid's
          // children, so a pane dragged to another slot only changes its grid area: React
          // neither remounts nor moves it, and its chat, scroll and focus stay as they were.
          return {
            order: [0, project.id],
            node: (
            <SplitPaneView key={`pane-${project.id}`} index={i} project={project} session={session}
              dragging={paneDrag?.from === i} dropLabel={drop} onGripPointerDown={e => startPaneDrag(i, e)}
              sessions={sessionsByProject.get(project.id) ?? [session]}
              data={data} themeChoice={themeChoice} focused={i === focusedIndex} onFocus={() => setFocusedIndex(i)}
              actions={actionsFor(i, session.id)} onRail={onRail}
              onShow={summary => {
                handedOver.current.set(summary.id, summary)
                showIn(i, { sessionPk: summary.id, projectDir: project.dirName })
              }}
              onShowPk={(pk, dir) => showIn(i, { sessionPk: pk, projectDir: dir })}
              onNewChat={() => void newChatIn(i, project, session.id)}
              onSessionUpdated={(pk, change) => setSessionsByProject(prev => {
                const list = prev.get(project.id)
                if (list === undefined || !list.some(s => s.id === pk)) return prev
                return new Map(prev).set(project.id, list.map(s => (s.id === pk ? change(s) : s)))
              })}
              onSessionsChanged={async list => {
                if (list !== undefined) setSessionsByProject(prev => new Map(prev).set(project.id, list))
                else await loadSessions(project.id).catch(() => {})
              }}
              onReplace={() => onPickSlot(i)} onClose={() => setPane(i, null)} />
            )
          }
        }).sort((x, y) => x.order[0]! - y.order[0]! || x.order[1]! - y.order[1]!).map(x => x.node)}
        {split !== null && size !== null && (
          <>
            <Resizer label={layout === 'thirds' ? 'Resize the left columns' : 'Resize the columns'} className="split-divider split-divider-col"
              style={{ left: ratios.col * size.width - 3, top: 0, height: size.height }}
              onResize={dx => dragBy(dx, 0)} onDoubleClick={() => resetRatio('col')} />
            {layout === 'thirds' && ratios.col2 !== undefined && (
              <Resizer label="Resize the right columns" className="split-divider split-divider-col"
                style={{ left: ratios.col2 * size.width - 3, top: 0, height: size.height }}
                onResize={dx => dragBy(dx, 0, 'col2')} onDoubleClick={() => resetRatio('col2')} />
            )}
            {twoRows && (
              <Resizer label="Resize the rows" orientation="horizontal" className="split-divider split-divider-row"
                style={{
                  top: ratios.row * size.height - 3,
                  left: layout === 'one-two' ? ratios.col * size.width : 0,
                  width: layout === 'one-two' ? (1 - ratios.col) * size.width : size.width
                }}
                onResize={dy => dragBy(0, dy)} onDoubleClick={() => resetRatio('row')} />
            )}
          </>
        )}
      </div>
      {pickRun !== null && (
        <SlotPicker layout={pickRun.layout} startIndex={pickRun.startIndex} count={pickRun.count} channels={channels}
          exclude={pickRun.exclude} settings={settings}
          onDone={picked => { setPickRun(null); pickRun.done(picked) }}
          onCancel={() => setPickRun(null)} />
      )}
    </div>
  )
}

/** One filled slot: the pane's header around a ChatPane, and its context rail as an overlay. */
function SplitPaneView({ index, project, session, dragging, dropLabel, onGripPointerDown, sessions, data, themeChoice, focused, onFocus, actions, onRail, onShow, onShowPk, onNewChat, onSessionUpdated, onSessionsChanged, onReplace, onClose }: {
  index: number
  project: ChannelRow
  session: SessionSummary
  /** This pane is being dragged to another slot. */
  dragging: boolean
  /** What this pane says while another is dragged over it, or null. */
  dropLabel: string | null
  /** The project's icon and name start a drag. */
  onGripPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  sessions: SessionSummary[]
  data: ReturnType<typeof useAppData>
  themeChoice: ThemeChoice
  focused: boolean
  onFocus: () => void
  actions: AppActions
  onRail: (index: number, rail: ProjectRail | null) => void
  /** Another chat in this pane, by its summary or by its pk. */
  onShow: (summary: SessionSummary) => void
  onShowPk: (sessionPk: number, projectDir: string) => void
  onNewChat: () => void
  onSessionUpdated: (sessionPk: number, change: (s: SessionSummary) => SessionSummary) => void
  onSessionsChanged: (list?: SessionSummary[]) => Promise<void>
  onReplace: () => void
  onClose: () => void
}) {
  const rail = useProjectRail(project)
  useEffect(() => { onRail(index, rail) }, [index, rail.pinnedUuids, rail.refreshPins]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onRail(index, null), [index, onRail])
  // The rail is hidden in a pane; the header's button shows it over the chat.
  const [railOpen, setRailOpen] = useState(false)
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null)
  // The pane's own dialogs (Rewind, task output, the terminal prompt, command screens) cover
  // this pane, not the window.
  const [dialogSlot, setDialogSlot] = useState<HTMLElement | null>(null)
  const showRail = data.settings?.showContextRail ?? true
  // It sits below the header, which can wrap to two lines in a narrow pane.
  const sectionRef = useRef<HTMLElement>(null)
  const [headHeight, setHeadHeight] = useState(0)
  useEffect(() => {
    const header = sectionRef.current?.querySelector<HTMLElement>('header.chead')
    if (header === null || header === undefined) return
    const measure = (): void => setHeadHeight(header.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  // A conflict with another PC is shown in the main window only. A message it held comes
  // back to the box here, with a note saying where to settle it.
  const syncChat = useSyncChat(session.id)
  const sync: PaneSync = {
    chat: syncChat,
    holdMessage: (resend, message) => {
      if (resend === null || message === undefined) return
      composeStore.returnMessage(session.id, message)
      paneBus.emit(session.id, { kind: 'notice', text: 'This chat changed on another PC as well, so the message wasn’t sent. Choose which version to keep in the main window, then send it again.' })
    }
  }

  const name = resolveChannelName(project.meta, project.cwd, project.dirName)
  const icon = resolveChannelIcon(project.meta, name)
  const listed = sessions.some(s => s.id === session.id) ? sessions : [session, ...sessions]

  const headerStart = (
    <div className="split-pane-title">
      <span className="split-pane-grip" title={`${project.cwd ?? name}\nDrag to move this pane`} onPointerDown={onGripPointerDown}>
        <ProjectIcon icon={icon} />
        <span className="split-pane-name">{name}</span>
      </span>
      <select className="chead-select split-chat-select" aria-label="Chat in this pane" value={String(session.id)}
        onChange={e => {
          const value = e.target.value
          if (value === NEW_CHAT_VALUE) { onNewChat(); return }
          const next = listed.find(s => String(s.id) === value)
          if (next !== undefined && next.id !== session.id) onShow(next)
        }}>
        {listed.map(s => <option key={s.id} value={String(s.id)}>{chatLabel(s)}</option>)}
        {project.archived !== true && <option value={NEW_CHAT_VALUE}>New chat</option>}
      </select>
    </div>
  )
  const headerEnd = (
    <div className="split-pane-buttons">
      {showRail && (
        <button type="button" className={`split-pane-btn${railOpen ? ' on' : ''}`} aria-pressed={railOpen}
          title={railOpen ? 'Hide files and pins' : 'Show files and pins'} aria-label="Files and pins" onClick={() => setRailOpen(o => !o)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" /><path d="M10 2.5v11" stroke="currentColor" /></svg>
        </button>
      )}
      <button type="button" className="split-pane-btn" title="Replace this pane" aria-label="Replace this pane" onClick={onReplace}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className="split-pane-btn" title="Close pane" aria-label="Close pane" onClick={onClose}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>
      </button>
    </div>
  )

  return (
    <section ref={sectionRef} data-pane={index} style={{ gridArea: `p${index + 1}` }}
      className={`split-pane${focused ? ' focused' : ''}${dragging ? ' dragging' : ''}${dropLabel !== null ? ' drop-target' : ''}`}
      onPointerDownCapture={onFocus}>
      <main className="main split-pane-main" data-theme={chatPaneTheme(themeChoice)}>
        <ChatPane session={session} project={project} sessions={listed}
          data={data} rail={rail} sync={sync} railSlot={railSlot} hidden={false}
          variant="split" focused={focused} onFocus={onFocus}
          headerStart={headerStart} headerEnd={headerEnd} dialogSlot={dialogSlot}
          onOpenSession={onShowPk}
          onOpenChat={onShow}
          onSessionUpdated={onSessionUpdated}
          onSessionsChanged={onSessionsChanged}
          app={actions} />
      </main>
      <div ref={setRailSlot} className="split-rail-overlay" style={{ top: headHeight }} hidden={!railOpen || !showRail} />
      <div ref={setDialogSlot} className="split-dialog-host" />
      <DropOverlay label={dropLabel} />
    </section>
  )
}

/** The highlight over the slot a dragged pane would land in. */
function DropOverlay({ label }: { label: string | null }) {
  if (label === null) return null
  return <div className="split-drop-overlay" aria-hidden="true"><span>{label}</span></div>
}
