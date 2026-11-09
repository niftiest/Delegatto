import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { ChannelRow, SessionSummary } from '../shared/types'
import type { IndexProgress as Progress } from '../shared/ipc'
import type { ChannelMeta, ChannelIcon, ChannelGroup } from '../shared/shell-types'
import { Nav, SHOW_NAV_STATUS } from './components/Nav'
import { IconRail } from './components/IconRail'
import { ContextRail, ContextRailStrip } from './components/ContextRail'
import { CreateImageDialog } from './components/CreateImageDialog'
import { Blade } from './components/Blade'
import { Resizer } from './components/Resizer'
import { IndexProgress } from './components/IndexProgress'
import { ArchivedNotice, readArchivedSeen, writeArchivedSeen } from './components/ArchivedNotice'
import { NewChatDialog } from './components/NewChatDialog'
import { SearchOverlay } from './components/SearchOverlay'
import { SettingsWindow, type SettingsSection } from './components/SettingsWindow'
import { BlockedBanner } from './components/BlockedBanner'
import { SyncConflictDialog, useSyncChat, useSyncOffer } from './components/SyncChat'
import { StartProjectSync } from './components/SyncSettings'
import type { ProjectSyncState } from '../shared/sync-types'
import { DeleteWizard } from './components/DeleteWizard'
import { SignInDialog } from './components/SignInDialog'
import { UpdateBar, UpdateIcon } from './components/UpdatesPanel'
import { RetentionNotice } from './components/RetentionNotice'
import { ManageView } from './components/manage/ManageView'
import type { DeleteTarget } from '../shared/manage-types'
import { EnginePool } from './components/EnginePool'
import { MemoryDialog } from './components/MemoryDialog'
import { TextMenuHost } from './components/TextMenu'
import { chatPaneTheme } from './theme'
import { useAppearance } from './appearance'
import type { MainAction } from '../shared/ipc'
import { ChatPane, type AppActions, type ChatPaneHandle, type PaneSync } from './components/ChatPane'
import { useAppData } from './app-data'
import { readStoredBool, useProjectRail } from './project-rail'
import { paneBus } from './pane-bus'
import {
  resolveChannelName, isStaleResponse, clamp,
  firstBlockedElsewhere, projectDirFromSessionKey,
  type NewProjectOptions
} from './lib'

const NAV_MIN = 220, NAV_MAX = 560, BLADE_MIN = 160, BLADE_MAX = 480

function readStoredWidth(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(`cc.width.${key}`)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** What the chat area shows with no chat open. A project still opening has no message: its
 *  newest chat is on the way. */
function EmptyPane({ project, onNewChat }: { project: ChannelRow | undefined; onNewChat: () => void }) {
  if (project === undefined) return <div className="empty">Pick a project to start reading.</div>
  if (project.sessionCount > 0) return <div className="empty" />
  return (
    <div className="empty">
      <div>No chats in this project yet.</div>
      {project.archived !== true && <button type="button" className="btn-primary empty-action" onClick={onNewChat}>New chat</button>}
    </div>
  )
}

export function App() {
  const [githubReady, setGithubReady] = useState(false)
  useEffect(() => { void api.githubStatus().then(s => setGithubReady(s.state === 'ready')) }, [])
  const [progress, setProgress] = useState<Progress | null>(null)
  // App-wide data and the pk-keyed maps every chat reads (see useAppData). refreshNav is
  // declared below; the data hook always calls the latest one.
  const data = useAppData(() => refreshNavRef.current())
  const { settings, setSettings, channels, setChannels, channelsRef, planUsage, remote, syncStatus, syncStates, permissionsByPk, permArrivedRef, onResolvePermission } = data
  const [groups, setGroups] = useState<ChannelGroup[]>([])
  const [project, setProject] = useState<ChannelRow | null>(null)
  const [memoryChannel, setMemoryChannel] = useState<ChannelRow | null>(null)
  // The project's chats, for the Blade, and the one on screen. The chat's own state lives in
  // its ChatPane; these stay here because the nav, the Blade and the dialogs read them too.
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<SessionSummary | null>(null)
  const paneRef = useRef<ChatPaneHandle | null>(null)
  // Where the main pane puts its context rail: to the right of the chat column.
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null)
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('cc.blade.collapsed') === 'true')
  const [newChatOpen, setNewChatOpen] = useState(false)
  // A folder to start in: only from an empty project's own New chat button.
  const [newChatCwd, setNewChatCwd] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  // A project opened from outside the chat list, which has to bring it into view.
  const [revealChannel, setRevealChannel] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const [poolOpen, setPoolOpen] = useState(false)
  const [activeChats, setActiveChats] = useState(0)
  // Channel ids with new activity the user hasn't looked at yet -- drives the
  // nav's unread glow. A channel is marked when a background catalog sync
  // advances its lastActivity while it ISN'T the open project or shown in any
  // window, and cleared the moment the user opens it (openProject) or a window
  // shows one of its chats.
  const [unread, setUnread] = useState<Set<number>>(new Set())
  // Total estimated USD cost across every session -- the nav header figure.
  // Refreshed alongside the channel list on each catalog sync.
  const [totalCost, setTotalCost] = useState(0)
  const [elevated, setElevated] = useState(false)
  const [navWidth, setNavWidth] = useState(() => readStoredWidth('nav', 264))
  const [bladeWidth, setBladeWidth] = useState(() => readStoredWidth('blade', 216))
  // Command-deck redesign: the chat list is the expanded half of the sidebar;
  // collapsing it leaves just the 68px icon rail. Persisted window-local.
  const [sidebarExpanded, setSidebarExpanded] = useState(() => readStoredBool('sidebar', true))
  // The open project's files and pins, for the context rail.
  const rail = useProjectRail(project)
  // Projects newly found with their folder gone, until the user has seen the notice.
  const [newlyArchived, setNewlyArchived] = useState<ChannelRow[]>([])
  // The sign-in dialog: opened by an expired login, or by /login.
  const [signIn, setSignIn] = useState<'expired' | 'asked' | null>(null)
  // Chats a live claude has under Remote Control (/rc) -- badged in the rail,
  // chat list, session list and chat header. App-wide, pushed by main.
  const remoteProjects = useMemo(() => new Set(remote.map(r => r.projectId)), [remote])
  const remoteSessions = useMemo(() => new Set(remote.map(r => r.sessionPk)), [remote])
  // Request ids whose blocked-turn banner the user dismissed (banner stays gone
  // until a new request arrives).
  const [dismissedPerms, setDismissedPerms] = useState<Set<string>>(new Set())
  // The open-project id, mirrored into a ref so the app-wide onIndexed listener
  // (registered once, in useAppData) can diff against it without re-subscribing
  // on every project change.
  const projectIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (channels.length === 0) return
    const archived = channels.filter(c => c.archived === true)
    const seen = new Set(readArchivedSeen())
    setNewlyArchived(archived.filter(c => !seen.has(c.dirName)))
    // A folder that came back is forgotten, so losing it again is news.
    const stillArchived = [...seen].filter(d => archived.some(c => c.dirName === d))
    if (stillArchived.length !== seen.size) writeArchivedSeen(stillArchived)
  }, [channels])
  useEffect(() => { projectIdRef.current = project?.id ?? null }, [project])

  // Persist panel widths so a drag survives relaunch.
  useEffect(() => { window.localStorage.setItem('cc.width.nav', String(navWidth)) }, [navWidth])
  useEffect(() => { window.localStorage.setItem('cc.width.blade', String(bladeWidth)) }, [bladeWidth])
  useEffect(() => { window.localStorage.setItem('cc.blade.collapsed', String(collapsed)) }, [collapsed])
  useEffect(() => { window.localStorage.setItem('cc.ui.sidebar', sidebarExpanded ? '1' : '0') }, [sidebarExpanded])

  // Footer "Chat elevation level" line (Windows).
  useEffect(() => { void api.isElevated().then(setElevated) }, [])

  // Theme, font, text sizes and Ctrl + wheel chat zoom, the same in every window.
  const { themeChoice, chatScaleNote } = useAppearance(settings, setSettings)

  // Poll the engine pool for the chat-list footer count (the pool HUD polls
  // its own detail while open). Cheap and bounded to a handful of engines.
  useEffect(() => {
    if (!SHOW_NAV_STATUS) return
    let alive = true
    const tick = (): void => { void api.listEngines().then(e => { if (alive) setActiveChats(e.filter(x => x.busy).length) }).catch(() => {}) }
    tick()
    const id = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Projects with a chat shown in any window, as main last said.
  const shownProjectsRef = useRef<ReadonlySet<number>>(new Set())
  // Re-pulls everything the nav derives from the catalog: channel list
  // (previews, timestamps, Today/Yesterday ordering), unread flags, the open
  // project's session list, and the total-cost figure. Held in a ref so the
  // once-registered onIndexed listener always calls the latest closure.
  function refreshNav(): void {
    void api.listChannels().then(list => {
      const prevActivity = new Map(channelsRef.current.map(c => [c.id, c.lastActivity] as const))
      setUnread(prev => {
        const next = new Set(prev)
        let changed = false
        for (const c of list) {
          if (c.id === projectIdRef.current) continue // the open channel is, by definition, read
          if (shownProjectsRef.current.has(c.id)) continue // so is one shown in any window
          const before = prevActivity.get(c.id)
          // `before === undefined` = a channel we hadn't seen before this
          // sync (e.g. a brand-new project); don't retroactively flag it.
          if (before !== undefined && c.lastActivity !== before && !next.has(c.id)) {
            next.add(c.id); changed = true
          }
        }
        return changed ? next : prev
      })
      setChannels(list)
      // The open project left the list, with no chat of its own still open: its last chat went.
      const open = projectIdRef.current
      if (open !== null && sessionRef.current === null && !list.some(c => c.id === open)) { setProject(null); setSessions([]) }
    }).catch(err => console.error('Nav refresh after catalog sync failed', err))
    void api.totalCost().then(setTotalCost).catch(() => { /* keep prior total */ })
    const pid = projectIdRef.current
    if (pid !== null) {
      void api.listSessions(pid).then(list => {
        if (projectIdRef.current === pid) setSessions(list)
      }).catch(() => { /* keep prior list */ })
    }
  }
  const refreshNavRef = useRef(refreshNav)
  refreshNavRef.current = refreshNav

  // A chat shown in any window, this one or another, counts as read: its project loses the glow.
  useEffect(() => api.onVisibleChatsChanged(shown => {
    const projects = new Set(shown.projects)
    shownProjectsRef.current = projects
    setUnread(prev => {
      if (![...prev].some(id => projects.has(id))) return prev
      return new Set([...prev].filter(id => !projects.has(id)))
    })
  }), [])

  // Auto-clean removed old chats: drop them from the nav.
  useEffect(() => api.onRetentionCleaned(() => refreshNavRef.current()), [])

  // Ctrl/Cmd+K opens the global full-text search overlay from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Open a search result: resolve its channel by project slug, load that
  // channel's sessions, and open the specific session the hit belongs to
  // (which may live in a channel that isn't currently loaded).
  const openChatRef = useRef<(sessionPk: number, projectDir: string) => void>(() => {})
  // A desktop notification was clicked: open that chat.
  useEffect(() => api.onOpenChat((pk, dir) => openChatRef.current(pk, dir)), [])

  async function openSearchResult(sessionPk: number, projectDir: string) {
    setSearchOpen(false)
    const channel = channels.find(c => c.dirName === projectDir) ?? null
    const reqId = ++navReqId.current
    // As before the split: the open chat's in-flight load can no longer apply.
    paneRef.current?.supersede()
    if (channel !== null) { setProject(channel); setRevealChannel(channel.id) }
    const list = channel === null ? [] : await api.listSessions(channel.id)
    if (isStaleResponse(reqId, navReqId.current)) return
    setSessions(list)
    const target = list.find(s => s.id === sessionPk) ?? null
    if (target !== null) await openSession(target)
  }
  openChatRef.current = (pk, dir) => { setManageOpen(false); void openSearchResult(pk, dir) }

  // Guards clicking channels/sessions faster than their fetches resolve, which
  // would otherwise let a stale response overwrite a newer selection. Bumped
  // synchronously on every openSession/openProject call. The pane has its own
  // counter for the chat's loads (see ChatPane's sessionReqId).
  const navReqId = useRef(0)
  // Hard in-flight guard for createChat, mirroring the pane's loadingOlderRef: a
  // fast double-click on the dialog's Create button can call this handler
  // twice before React re-renders with the button's `disabled` (driven by
  // NewChatDialog's own `creating` state) reflecting the first click --
  // that state is soft (async, batched) and does not stop a second
  // synchronous invocation from slipping through. This ref is checked and
  // set synchronously as the very first thing createChat does, before any
  // `await`, so the second concurrent call always observes it already true
  // and returns without ever reaching api.newChat -- otherwise each call
  // mints its own randomUUID() session id, minting two orphan empty
  // sessions in the same project instead of one.
  const creatingChatRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const off = api.onIndexProgress(p => { if (!cancelled) setProgress(p) })
    void (async () => {
      try {
        await api.runIndex()
        const [list, groupList, cost] = await Promise.all([api.listChannels(), api.listGroups(), api.totalCost()])
        if (cancelled) return
        setChannels(list)
        setGroups(groupList)
        setTotalCost(cost)
        setProgress(null)
        // Back from an update: the same chat, open before the window shows.
        const resumed = await api.takeResumedChat()
        const channel = resumed === null ? undefined : list.find(c => c.dirName === resumed.projectDir)
        if (resumed !== null && channel !== undefined && !cancelled) {
          setProject(channel)
          const chats = await api.listSessions(channel.id)
          if (cancelled) return
          setSessions(chats)
          const target = chats.find(s => s.id === resumed.sessionPk)
          if (target !== undefined) await openSession(target)
        }
      } catch (err) {
        // A failed first-run index must not leave the overlay stuck forever;
        // surface an empty app rather than an unrecoverable progress screen.
        console.error('Initial index failed', err)
        if (!cancelled) setProgress(null)
      } finally {
        // Reveal the window (and drop the launch splash) only once the first
        // load is done -- after two frames, so the populated nav has painted
        // and the window never flashes an empty shell. Idempotent in main.
        requestAnimationFrame(() => requestAnimationFrame(() => api.appReady()))
      }
    })()
    return () => { cancelled = true; off() }
  }, [])

  // Callers waiting for a chat the pane is mounting to show (see openSession). A failed load
  // fails them, as an awaited openSession did before the split (startup logs it).
  const paneMountWaiters = useRef<Array<{ resolve: () => void; reject: (err: unknown) => void }>>([])
  const releaseMountWaiters = useCallback((error?: unknown): void => {
    const waiting = paneMountWaiters.current
    paneMountWaiters.current = []
    if (error !== undefined && waiting.length === 0) console.error('Opening the chat failed', error)
    for (const w of waiting) {
      if (error === undefined) w.resolve()
      else w.reject(error)
    }
  }, [])
  // No pane will mount for them: nothing to wait for.
  useEffect(() => { if (session === null || project === null) releaseMountWaiters() }, [session, project, releaseMountWaiters])

  // Shows a chat in the main pane, or the same chat again, which reloads it. The pane
  // resets what belonged to the last chat and loads this one (ChatPane's openSession), in
  // the same update. With no pane yet, it mounts with this chat and opens it itself; the
  // promise then settles when that first load has.
  function openSession(next: SessionSummary): Promise<void> {
    ++navReqId.current
    setSession(next)
    const pane = paneRef.current
    if (pane !== null) return pane.openSession(next)
    return new Promise<void>((resolve, reject) => { paneMountWaiters.current.push({ resolve, reject }) })
  }

  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  async function openProject(next: ChannelRow) {
    const reqId = ++navReqId.current
    paneRef.current?.supersede()
    setProject(next)
    // Opening a channel reads it: clear any unread glow it carried.
    setUnread(prev => {
      if (!prev.has(next.id)) return prev
      const n = new Set(prev); n.delete(next.id); return n
    })
    const list = await api.listSessions(next.id)
    if (isStaleResponse(reqId, navReqId.current)) return // a newer channel/session click won the race
    setSessions(list)
    // Spec: clicking a channel opens its newest-modified session.
    const newest = list[0] ?? null
    if (newest === null) {
      setSession(null)
      // The list may still be counting a chat that has gone.
      refreshNavRef.current()
      return
    }
    await openSession(newest)
  }

  // Submits the New-Chat dialog's resolved options to the engine, then --
  // on success -- refreshes the project/session lists (the new chat may
  // belong to a brand-new project the catalog didn't have a moment ago) and
  // opens the just-created session so the Composer is ready for its first
  // message. Mirrors openProject's own reqId-guarded refresh-then-open
  // shape; a stale response here (the user clicked a different
  // channel/session while this was in flight) is handled the same way --
  // silently dropped rather than clobbering whatever is now open.
  async function createChat(options: NewProjectOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    // See creatingChatRef's own comment above: this check-and-set happens
    // synchronously, before the first `await`, so a second synchronous
    // invocation (double-click) always observes the flag already set and
    // is a no-op here -- the in-flight call already owns this request.
    if (creatingChatRef.current) return { ok: true }
    creatingChatRef.current = true
    try {
      const outcome = await api.newChat(options)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      await openCreatedChat(options.cwd, outcome.sessionId)
      return { ok: true }
    } finally {
      creatingChatRef.current = false
    }
  }

  /** Shows a chat the main process just registered and opens it. */
  async function openCreatedChat(cwd: string, sessionId: string): Promise<void> {
    const list = await api.listChannels()
    setChannels(list)
    // setProjectCwd (main-process side of api.newChat) wrote this exact string,
    // so an exact match always finds it -- barring the defensive fallback below
    // for an unexpected catalog race.
    const proj = list.find(p => p.cwd === cwd) ?? null
    if (proj === null) {
      // The new chat is safely registered server-side regardless; it will simply
      // show up on the next listProjects refresh instead of opening immediately.
      setNewChatOpen(false)
      return
    }

    const reqId = ++navReqId.current
    paneRef.current?.supersede()
    setProject(proj)
    const sessList = await api.listSessions(proj.id)
    setNewChatOpen(false)
    if (isStaleResponse(reqId, navReqId.current)) return
    setSessions(sessList)
    const created = sessList.find(s => s.sessionId === sessionId) ?? null
    if (created !== null) await openSession(created)
  }

  /** Opens a project sync just brought to this PC. */
  async function openLinkedProject(workingDir: string): Promise<void> {
    setNewChatOpen(false)
    const list = await api.listChannels()
    setChannels(list)
    const same = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const found = list.find(c => c.cwd !== null && same(c.cwd) === same(workingDir))
    if (found !== undefined) { setRevealChannel(found.id); await openProject(found) }
  }

  // /clear: this chat stays in the history; a new one opens in the same folder.
  // Shares createChat's in-flight guard. Answers an error for the pane to show.
  async function clearChat(sessionPk: number): Promise<string | null> {
    if (creatingChatRef.current) return null
    creatingChatRef.current = true
    try {
      const outcome = await api.clearChat(sessionPk)
      if (!outcome.ok) return outcome.error
      if (outcome.unchanged) return null
      await openCreatedChat(outcome.cwd, outcome.sessionId)
      return null
    } finally {
      creatingChatRef.current = false
    }
  }

  // Which chat is on screen, in case an update restarts the app.
  const openChatId = session?.id ?? null
  const openChatDir = project?.dirName ?? null
  useEffect(() => {
    void api.setUpdateOpenChat(openChatId !== null && openChatDir !== null ? { sessionPk: openChatId, projectDir: openChatDir } : null)
  }, [openChatId, openChatDir])

  // A notice for the chat on screen, in its notice line. With no chat open there's no line.
  const noticeOpenChat = (text: string): void => {
    if (openChatId !== null) paneBus.emit(openChatId, { kind: 'notice', text })
  }

  // Pinning from the text menu: the open chat's messages.
  const refreshPins = rail.refreshPins
  const pinOpenMessage = useCallback((uuid: string): void => {
    if (openChatId === null) return
    void api.pinMessage(openChatId, uuid).then(ok => {
      if (ok) refreshPins()
      else paneBus.emit(openChatId, { kind: 'notice', text: "That message couldn't be pinned yet. Try again in a moment." })
    })
  }, [openChatId, refreshPins])
  const unpinOpenMessage = useCallback((uuid: string): void => {
    if (openChatId === null) return
    void api.unpinMessage(openChatId, uuid).then(refreshPins)
  }, [openChatId, refreshPins])

  // The main pane's chat. A conflict shows once, here, whichever chat it's in.
  const syncChat = useSyncChat(session?.id ?? null)
  const syncOfferNotice = useSyncOffer(syncStatus)
  const [startingSync, setStartingSync] = useState<{ workingDir: string; name: string } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const onSyncProject = (state: ProjectSyncState): void => {
    if (state.kind === 'setup') { setSettingsSection('sync'); setSettingsOpen(true) }
    else if (state.kind === 'off') setStartingSync({ workingDir: state.workingDir, name: state.name })
    else void api.syncDisableProject(state.projectId).then(r => { if (!r.ok) setSyncError(r.error) })
  }
  // A message held back by a sync conflict, sent once the conflict is resolved.
  const [syncHeld, setSyncHeld] = useState<(() => void) | null>(null)
  const paneSync: PaneSync = {
    chat: syncChat,
    holdMessage: resend => setSyncHeld(resend === null ? null : () => resend)
  }

  // ── Nav metadata editing (Plan 3 Task 2) ──────────────────────────────────
  // Every handler below is OPTIMISTIC: it updates `channels` (and, for group
  // create/delete, `groups`) synchronously from the same edit the user just
  // made, then fires the IPC call without awaiting it before returning --
  // the nav reflects the change immediately with no reload/flicker, and the
  // catalog write happens in the background. `patchMeta` is the shared
  // shape every per-field setter reduces to: replace one channel's `meta`
  // by dirName, leaving every other channel (and the channel's own other
  // meta fields) untouched.
  // The open project is a copy taken when it was opened, so a rename, icon or star
  // change made in the chat list shows in its header too.
  useEffect(() => {
    setProject(p => p === null ? p : (channels.find(c => c.id === p.id) ?? p))
  }, [channels])

  function patchMeta(dirName: string, patch: Partial<ChannelMeta>) {
    setChannels(prev => prev.map(c => (c.dirName === dirName ? { ...c, meta: { ...c.meta, ...patch } } : c)))
  }

  const onRenameChannel = useCallback((dirName: string, name: string | null) => {
    // Mirrors setFriendlyName's own normalization (metadata.ts): trim, and
    // store empty/whitespace-only as null -- so the optimistic update never
    // shows an untrimmed or blank name for the instant before the IPC round
    // trip would have corrected it anyway.
    const trimmed = name === null ? null : name.trim()
    patchMeta(dirName, { friendlyName: trimmed === null || trimmed.length === 0 ? null : trimmed })
    void api.setFriendlyName(dirName, name)
  }, [])

  const onToggleStar = useCallback((dirName: string, starred: boolean) => {
    patchMeta(dirName, { starred })
    void api.setStarred(dirName, starred)
  }, [])

  const onSetIcon = useCallback((dirName: string, icon: ChannelIcon) => {
    patchMeta(dirName, { icon })
    void api.setChannelIcon(dirName, icon)
  }, [])

  const onMoveToGroup = useCallback((dirName: string, groupId: number | null) => {
    patchMeta(dirName, { groupId })
    void api.setChannelGroup(dirName, groupId)
  }, [])

  const onToggleHidden = useCallback((dirName: string, hidden: boolean) => {
    patchMeta(dirName, { hidden })
    void api.setChannelHidden(dirName, hidden)
  }, [])

  // Delete wizard (port of ClaudeMemoryTool): project scope from the channel
  // menu, chat scope for the open chat or the channel's latest one.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const onDeleteChannel = useCallback((dirName: string) => {
    setDeleteTarget({ scope: 'project', dirName })
  }, [])
  const sessionRef = useRef<SessionSummary | null>(null)
  useEffect(() => { sessionRef.current = session }, [session])
  const onDeleteChat = useCallback((channel: ChannelRow) => {
    const open = sessionRef.current
    if (projectIdRef.current === channel.id && open !== null) { setDeleteTarget({ scope: 'chat', sessionPk: open.id }); return }
    void api.listSessions(channel.id).then(list => {
      const latest = list[0] // newest first
      if (latest !== undefined) setDeleteTarget({ scope: 'chat', sessionPk: latest.id })
    })
  }, [])
  // After a delete: if what was open is gone, drop back to the empty state;
  // then re-pull the nav (the catalog rows are already removed in main).
  const onDeleted = useCallback((target: DeleteTarget) => {
    const openProject = channelsRef.current.find(c => c.id === projectIdRef.current)
    const closeChat = target.scope === 'chat'
      ? sessionRef.current?.id === target.sessionPk
      : openProject !== undefined && (target.scope === 'project'
        ? openProject.dirName === target.dirName
        : target.dirNames.includes(openProject.dirName))
    if (closeChat) {
      setSession(null)
      if (target.scope !== 'chat') { setProject(null); setSessions([]) }
      else {
        // The open chat went: on to the project's next newest, if it has one.
        const pid = projectIdRef.current, reqId = navReqId.current
        if (pid !== null) {
          void api.listSessions(pid).then(list => {
            if (!isStaleResponse(reqId, navReqId.current) && list[0] !== undefined) void openSessionRef.current(list[0])
          })
        }
      }
    }
    setManageEpoch(e => e + 1)
    refreshNavRef.current()
  }, [channelsRef])

  // Manage screen (port of ClaudeMemoryTool): replaces the chat list + pane
  // while open. Its Delete… reuses the wizard above; `manageEpoch` tells it to
  // rescan after the wizard removed something.
  const [manageOpen, setManageOpen] = useState(false)
  // Main keeps which chats each window shows: this window's is the main pane's chat. It stays
  // reported while the Manage screen covers it, since the pane stays mounted and live.
  const mainPanePk = project !== null ? openChatId : null
  useEffect(() => { api.setVisibleChats(mainPanePk !== null ? [mainPanePk] : []) }, [mainPanePk])
  // Ctrl+F searches the open project, unless something is open on top of it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return
      e.preventDefault()
      if (settingsOpen || manageOpen || searchOpen) return
      paneRef.current?.focusFind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, manageOpen, searchOpen])

  const [manageEpoch, setManageEpoch] = useState(0)
  const onManageDelete = useCallback((target: DeleteTarget) => setDeleteTarget(target), [])
  // After a rename / import / restore: main has already re-synced the catalog;
  // re-pull the nav, and drop the open chat if its project is gone.
  const onManageChanged = useCallback(() => {
    void api.listChannels().then(list => {
      const pid = projectIdRef.current
      if (pid !== null && !list.some(c => c.id === pid)) {
        setSession(null); setProject(null); setSessions([])
      }
    }).catch(() => { /* the nav refresh below reports */ }).finally(() => refreshNavRef.current())
  }, [])
  const closeManage = useCallback(() => setManageOpen(false), [])

  // Awaited by ChannelContextMenu's "New group…" flow, which needs the new
  // group's id back so it can immediately move the channel into it (two
  // sequential edits from one submit).
  const onCreateGroup = useCallback(async (name: string): Promise<number> => {
    const id = await api.createGroup(name)
    setGroups(prev => [...prev, { id, name, sortOrder: 0, icon: { kind: 'initials' } }])
    return id
  }, [])

  // Optimistic group icon set (mirrors onSetIcon for channels).
  const onSetGroupIcon = useCallback((groupId: number, icon: ChannelIcon) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, icon } : g)))
    void api.setGroupIcon(groupId, icon)
  }, [])

  // Guard: deleting a group the selected channel belongs to moves it to
  // Ungrouped -- mirrors the schema's own ON DELETE SET NULL (metadata.ts's
  // deleteGroup), applied optimistically here across every member channel
  // (not just whichever one the context menu was opened on) so the nav's
  // grouping updates for all of them, not just one.
  const onDeleteGroup = useCallback((groupId: number) => {
    setGroups(prev => prev.filter(g => g.id !== groupId))
    setChannels(prev => prev.map(c => (c.meta.groupId === groupId ? { ...c, meta: { ...c.meta, groupId: null } } : c)))
    void api.deleteGroup(groupId)
  }, [setChannels])

  // Optimistic group rename (renameGroup IPC already existed; this just wires
  // it to the context menu). Updates the nav's section title immediately.
  const onRenameGroup = useCallback((groupId: number, name: string) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, name: trimmed } : g)))
    void api.renameGroup(groupId, trimmed)
  }, [])

  // What the main pane asks of the window.
  const appActions: AppActions = {
    openSettings: section => { setSettingsSection(section); setSettingsOpen(true) },
    openSearch: () => setSearchOpen(true),
    openMemory: p => setMemoryChannel(p),
    openNewChat: cwd => { setNewChatCwd(cwd); setNewChatOpen(true) },
    deleteChat: target => setDeleteTarget(target),
    syncProject: onSyncProject,
    signIn: reason => setSignIn(reason),
    clearChat
  }

  // What a split pane asked of this window: main has brought it to the front already.
  const onMainActionRef = useRef<(action: MainAction) => void>(() => {})
  onMainActionRef.current = action => {
    switch (action.kind) {
      case 'settings': setSettingsSection(action.section); setSettingsOpen(true); return
      case 'search': setSearchOpen(true); return
      case 'newChat': setNewChatCwd(action.cwd); setNewChatOpen(true); return
      case 'memory': {
        const channel = channelsRef.current.find(c => c.dirName === action.projectDir)
        if (channel !== undefined) setMemoryChannel(channel)
        return
      }
      case 'delete': setDeleteTarget(action.target); return
      case 'syncProject': setStartingSync({ workingDir: action.workingDir, name: action.name }); return
      case 'signIn': setSignIn(action.reason); return
    }
  }
  useEffect(() => api.onMainAction(action => onMainActionRef.current(action)), [])

  if (progress !== null) return <IndexProgress progress={progress} />

  // A pending permission request in a chat other than the open one raises the
  // app-wide banner (the open chat's own requests show as inline cards instead).
  const blocked = firstBlockedElsewhere(permissionsByPk, session?.id ?? null, dismissedPerms)
  const blockedChannel = blocked
    ? channels.find(c => c.dirName === projectDirFromSessionKey(blocked.req.sessionKey)) ?? null
    : null
  const blockedName = blockedChannel
    ? resolveChannelName(blockedChannel.meta, blockedChannel.cwd, blockedChannel.dirName)
    : 'Another chat'

  // The Files panel's open/closed choice, with no chat open to remember it for the project.
  const toggleFilesNoChat = (open: boolean): void => {
    rail.setExpanded(open)
    window.localStorage.setItem('cc.ui.rail', open ? '1' : '0')
  }
  const chatOpen = session !== null && project !== null

  return (
    <div className="shell" data-density={settings?.density ?? 'comfortable'} data-nav-density={settings?.navDensity ?? 'comfortable'}>
      <TextMenuHost pinned={rail.pinnedUuids} onPin={pinOpenMessage} onUnpin={unpinOpenMessage} />
      {/* The icon rail stands in for the chat list: its buttons move under the list while that's open. */}
      {(manageOpen || !sidebarExpanded) && (
        <IconRail channels={channels} groups={groups} selectedId={project?.id ?? null} unread={unread} remote={remoteProjects}
        sidebarExpanded={false} reveal={revealChannel} onRevealed={() => setRevealChannel(null)}
        onSelect={p => { setManageOpen(false); void openProject(p) }}
        onToggleSidebar={() => { setManageOpen(false); setSidebarExpanded(true) }}
        onNewChat={() => { setNewChatCwd(null); setNewChatOpen(true) }} onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => { setSettingsSection(undefined); setSettingsOpen(true) }}
        onOpenManage={() => setManageOpen(o => !o)} manageOpen={manageOpen} />
      )}
      {manageOpen && (
        <main className="main mg-main" data-theme={chatPaneTheme(themeChoice)}>
          <ManageView epoch={manageEpoch} onClose={closeManage} onDelete={onManageDelete} onChanged={onManageChanged} />
        </main>
      )}
      {!manageOpen && sidebarExpanded && (
        <>
          <Nav onShowInExplorer={c => { void api.showProjectFolder(c.id).then(r => { if (!r.ok) noticeOpenChat(r.error) }) }}
            onManageMemory={setMemoryChannel}
            onOpenManage={() => setManageOpen(true)} onOpenSettings={() => { setSettingsSection(undefined); setSettingsOpen(true) }}
            onCollapse={() => setSidebarExpanded(false)} channels={channels} groups={groups} selectedId={project?.id ?? null} width={navWidth}
            reveal={revealChannel} onRevealed={() => setRevealChannel(null)}
            unread={unread} remote={remoteProjects} showRepos={githubReady} totalCost={totalCost} elevated={elevated} activeChats={activeChats} planUsage={planUsage} session={session}
            onSelect={p => void openProject(p)} onNewChat={() => { setNewChatCwd(null); setNewChatOpen(true) }}
            onOpenSearch={() => setSearchOpen(true)} onOpenPool={() => setPoolOpen(true)}
            onRename={onRenameChannel} onToggleStar={onToggleStar} onMoveToGroup={onMoveToGroup}
            onCreateGroup={onCreateGroup} onDeleteGroup={onDeleteGroup} onRenameGroup={onRenameGroup}
            onSetGroupIcon={onSetGroupIcon} onSetIcon={onSetIcon}
            onToggleHidden={onToggleHidden} onDeleteChannel={onDeleteChannel} onDeleteChat={onDeleteChat}
            syncOffer={syncOfferNotice.offer} onDismissSyncOffer={syncOfferNotice.dismiss}
            syncStates={syncStates} onSyncProject={onSyncProject}
            onOpenSyncOffer={() => { setSettingsSection('sync'); setSettingsOpen(true) }} />
          <Resizer label="Resize channel list"
            onResize={dx => setNavWidth(w => clamp(w + dx, NAV_MIN, NAV_MAX))} />
        </>
      )}
      {/* Session Blade: on unless turned off in Settings → Appearance, and only
          when a project actually has more than one session to pick between. */}
      {!manageOpen && (settings?.showBlade ?? true) && sessions.length > 1 && (
        <>
          <Blade sessions={sessions} selectedId={session?.id ?? null} remote={remoteSessions} collapsed={collapsed} width={bladeWidth}
            onToggle={() => setCollapsed(c => !c)} onSelect={s => void openSession(s)} onDelete={s => setDeleteTarget({ scope: 'chat', sessionPk: s.id })} />
          {!collapsed && <Resizer label="Resize session list"
            onResize={dx => setBladeWidth(w => clamp(w + dx, BLADE_MIN, BLADE_MAX))} />}
        </>
      )}
      <main className="main" data-theme={chatPaneTheme(themeChoice)} hidden={manageOpen}>
        <UpdateBar />
        {chatScaleNote !== null && <div className="chat-scale-note" role="status">{chatScaleNote}%</div>}
        {newlyArchived.length > 0 && (
          <ArchivedNotice projects={newlyArchived} onDismiss={() => {
            writeArchivedSeen(channels.filter(c => c.archived === true).map(c => c.dirName))
            setNewlyArchived([])
          }} />
        )}
        {settings !== null && !settings.retentionNoticeDismissed && (
          <RetentionNotice
            settingsOpen={settingsOpen}
            onOpenSettings={() => { setSettingsSection('history'); setSettingsOpen(true) }}
            onDismiss={() => { void api.updateSettings({ retentionNoticeDismissed: true }).then(setSettings) }} />
        )}
        {blocked && (
          <BlockedBanner channelName={blockedName} tool={blocked.req.tool}
            arrivedAt={permArrivedRef.current.get(blocked.req.id) ?? null}
            onReview={() => {
              if (blockedChannel) void openProject(blockedChannel)
              setDismissedPerms(prev => new Set(prev).add(blocked.req.id))
            }}
            onDeny={() => onResolvePermission(blocked.sessionPk, blocked.req.id, 'deny', undefined, 'Denied by user')}
            onDismiss={() => setDismissedPerms(prev => new Set(prev).add(blocked.req.id))} />
        )}
        {chatOpen
          ? <ChatPane ref={paneRef} session={session} project={project} sessions={sessions}
              data={data} rail={rail} sync={paneSync} railSlot={railSlot} hidden={manageOpen}
              variant="main" focused={true} onFocus={() => {}}
              onOpenSession={(pk, dir) => void openSearchResult(pk, dir)}
              onOpenChat={s => void openSession(s)}
              onSessionUpdated={(pk, change) => setSession(prev => (prev !== null && prev.id === pk ? change(prev) : prev))}
              onSessionsChanged={async list => {
                if (list !== undefined) { setSessions(list); return }
                if (projectIdRef.current !== null) setSessions(await api.listSessions(projectIdRef.current))
              }}
              onMountOpened={releaseMountWaiters}
              app={appActions} />
          : <>
              {/* With no chat open the header has only the project's name and folder. */}
              <header className="chead">
                <div className="chead-main">
                  <div className="chead-title-row">
                    <h1>{project === null ? 'Delegatto' : resolveChannelName(project.meta, project.cwd, project.dirName)}</h1>
                  </div>
                  <div className="path">{project?.cwd ?? `${channels.length} projects indexed`}</div>
                </div>
                {(manageOpen || !(settings?.showContextRail ?? true)) && <UpdateIcon />}
              </header>
              <EmptyPane project={project === null ? undefined : channels.find(c => c.id === project.id)} onNewChat={() => { setNewChatCwd(project?.cwd ?? null); setNewChatOpen(true) }} />
            </>}
      </main>
      {/* The main pane's context rail goes here (see ChatPane's railSlot). Its box takes no
          part in the layout, so the rail sits in the window's row as before. */}
      <div ref={setRailSlot} style={{ display: 'contents' }} />
      {!chatOpen && !manageOpen && (settings?.showContextRail ?? true) && (
        rail.expanded
          ? <ContextRail session={null} fsEntries={rail.fsEntries}
              hasKey={(settings?.openRouterKey ?? '').trim().length > 0}
              canCreateImage={typeof project?.cwd === 'string' && project.cwd.length > 0}
              onCreateImage={() => rail.setCreateImageOpen(true)}
              onCollapse={() => toggleFilesNoChat(false)} context={null}
              view={rail.view} onView={rail.setView} pins={rail.pins} openChatId={null}
              onJumpToPin={pin => { if (project !== null) void openSearchResult(pin.sessionPk, project.dirName) }}
              onUnpin={pin => { void api.unpinMessage(pin.sessionPk, pin.uuid).then(rail.refreshPins) }}
              onCompact={undefined} />
          : <ContextRailStrip fsEntries={rail.fsEntries} view={rail.view} pinCount={rail.pins.length} onExpand={() => toggleFilesNoChat(true)}
              onOpenView={v => { rail.setView(v); toggleFilesNoChat(true) }} />
      )}
      {rail.createImageOpen && typeof project?.cwd === 'string' && project.cwd.length > 0 && (
        <CreateImageDialog cwd={project.cwd} onClose={() => rail.setCreateImageOpen(false)}
          onSaved={() => { const c = project?.cwd; if (c) void api.fsTree(c).then(rail.setFsEntries).catch(() => {}) }} />
      )}
      {deleteTarget !== null && (
        <DeleteWizard target={deleteTarget} onClose={() => setDeleteTarget(null)}
          onDeleted={() => onDeleted(deleteTarget)} />
      )}
      {startingSync !== null && (
        <StartProjectSync workingDir={startingSync.workingDir} name={startingSync.name} encrypted={syncStatus?.encrypted ?? true}
          onClose={() => setStartingSync(null)} />
      )}
      {signIn !== null && <SignInDialog reason={signIn} onClose={() => setSignIn(null)} />}
      {syncError !== null && (
        <div className="modal-overlay" role="presentation" onClick={() => setSyncError(null)}>
          <div className="modal sync-dialog" role="alertdialog" aria-label="Sync problem" onClick={e => e.stopPropagation()}>
            <div className="modal-error">{syncError}</div>
            <div className="modal-actions"><button type="button" className="btn-primary" onClick={() => setSyncError(null)}>Close</button></div>
          </div>
        </div>
      )}
      {newChatOpen && (
        // Seeds the dialog's cwd field from whatever project is currently
        // open (a convenience -- most new chats are "another chat in the
        // channel I'm already looking at"), never forces it: the field
        // stays freely editable and Browse still opens on any directory.
        <NewChatDialog
          defaults={{
            cwd: newChatCwd ?? settings?.defaultCwd ?? undefined,
            skipPermissions: settings?.defaultSkipPermissions ?? true,
            model: settings?.defaultModel ?? undefined,
            effort: settings?.defaultEffort ?? undefined
          }}
          confirmBypass={settings?.confirmBeforeBypass ?? false}
          onCancel={() => setNewChatOpen(false)}
          onCreate={createChat}
          onOpenProject={openLinkedProject}
        />
      )}
      {searchOpen && (
        <SearchOverlay
          channels={channels}
          onClose={() => setSearchOpen(false)}
          onOpen={(pk, dir) => void openSearchResult(pk, dir)}
        />
      )}
      {memoryChannel !== null && <MemoryDialog projectId={memoryChannel.id} title={resolveChannelName(memoryChannel.meta, memoryChannel.cwd, memoryChannel.dirName)} onClose={() => setMemoryChannel(null)} />}
      {syncChat.conflict !== null && (
        <SyncConflictDialog key={syncChat.conflict.sessionId} conflict={syncChat.conflict} heldMessage={syncHeld !== null}
          onLater={() => { syncChat.dismiss(syncChat.conflict!.sessionId); setSyncHeld(null) }}
          onResolved={() => { syncChat.finish(); syncChat.refresh(); const held = syncHeld; setSyncHeld(null); held?.() }}
          onOpenChat={(pk, dir) => openChatRef.current(pk, dir)} />
      )}
      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} onSettingsChanged={setSettings}
        projectCwd={project?.cwd ?? null} sessionPk={session?.id ?? null} initialSection={settingsSection}
        projects={channels.map(c => ({ dirName: c.dirName, cwd: c.cwd, name: resolveChannelName(c.meta, c.cwd, c.dirName) }))} />}
      {poolOpen && <EnginePool onClose={() => setPoolOpen(false)}
        channelNameFor={(sessionKey) => {
          const dir = projectDirFromSessionKey(sessionKey)
          const ch = dir !== null ? channels.find(c => c.dirName === dir) : undefined
          return ch ? resolveChannelName(ch.meta, ch.cwd, ch.dirName) : (sessionKey.split(/[\\/]/).pop() ?? 'chat')
        }} />}
    </div>
  )
}
