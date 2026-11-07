import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api'
import type { ChannelRow, SessionSummary, RenderItem } from '../shared/types'
import type { IndexProgress as Progress } from '../shared/ipc'
import { FOLDER_MISSING, SHELL_OUTPUT_SENT, type Elicitation, type BackgroundTask, type PermissionRequest, type ExternalLock, type RemoteSession } from '../shared/engine-types'
import type { ChannelMeta, ChannelIcon, ChannelGroup, AppSettings } from '../shared/shell-types'
import { Nav, SHOW_NAV_STATUS } from './components/Nav'
import { NO_PLAN_USAGE, currentWindow, planLabel, type PlanUsage } from '../shared/plan-usage'
import { costOfSession } from '../shared/models'
import { IconRail } from './components/IconRail'
import { ContextRail, ContextRailStrip, type RailView } from './components/ContextRail'
import { CreateImageDialog } from './components/CreateImageDialog'
import { Blade } from './components/Blade'
import { Resizer } from './components/Resizer'
import { Transcript } from './components/Transcript'
import { IndexProgress } from './components/IndexProgress'
import { Composer } from './components/Composer'
import { composeStore } from './compose-store'
import { OpenSubagentContext, SubagentViewer } from './components/SubagentViewer'
import { ArchivedNotice, readArchivedSeen, writeArchivedSeen } from './components/ArchivedNotice'
import { NewChatDialog } from './components/NewChatDialog'
import { LiveIndicator } from './components/LiveIndicator'
import { ChatHeaderControls } from './components/ChatHeaderControls'
import { SearchOverlay } from './components/SearchOverlay'
import { SettingsWindow, type SettingsSection } from './components/SettingsWindow'
import { BlockedBanner } from './components/BlockedBanner'
import { SyncChatBanner, SyncConflictDialog, useSyncChat, useSyncOffer, useSyncStatus } from './components/SyncChat'
import { StartProjectSync } from './components/SyncSettings'
import { projectSyncState, type ProjectSyncState } from '../shared/sync-types'
import { RemoteBadge } from './components/RemoteBadge'
import { DeleteWizard } from './components/DeleteWizard'
import { UpdateBar, UpdateIcon } from './components/UpdatesPanel'
import { TextWithLinks } from './components/Markdown'
import { FONT_SCALE_DEFAULT, fontStack, stepFontScale } from '../shared/font-settings'
import { RetentionNotice } from './components/RetentionNotice'
import { ManageView } from './components/manage/ManageView'
import type { DeleteTarget } from '../shared/manage-types'
import { EnginePool } from './components/EnginePool'
import { McpChip } from './components/McpChip'
import { MemoryDialog } from './components/MemoryDialog'
import { ProjectOptions } from './components/ProjectOptions'
import { OpenInTerminalButton } from './components/OpenInTerminalButton'
import { effectiveThinkingDisplay, effectiveToolDisplay, shownToolDisplay, type ProjectSettings, type ContextUsage } from '../shared/project-options'
import { ShellRuns } from './components/ShellRuns'
import { WorkingLine, BackgroundTasksLine, SubagentsLive } from './components/WorkingLine'
import { RewindDialog } from './components/RewindDialog'
import { TextMenuHost } from './components/TextMenu'
import type { PinnedMessage } from '../shared/engine-ipc-contract'
import { TaskOutputDialog } from './components/TaskOutputDialog'
import { DiffDialog, ExportDialog, HooksDialog, TasksDialog } from './components/CommandPanels'
import { reduceAgentRuns, type AgentRun } from '../shared/subagent-activity'
import { ProjectSearchBox, ProjectSearchResults } from './components/ProjectSearch'
import type { ProjectSearchResult } from '../shared/project-search'
import type { ShellRun } from '../shared/shell-run-types'
import type { McpServerStatus } from '../shared/claude-info-types'
import { applyTheme, applyThemeColors, cachedTheme, chatPaneTheme, type ThemeChoice } from './theme'
import type { LocalTheme } from '../shared/themes'
import {
  resolveChannelName, isStaleResponse, clamp, buildOutgoingText, terminalOnlyCommand, isClearCommand, reduceLivePreview, appendRowsToItems, hasUserRenderItem, retryLabel, nextPermissionMode, permissionModeLabel, isRewindCommand, spawnErrorNotice, sideQuestionOf, renameCommandOf, addDirCommandOf, mcpCommandOf, type McpCommand, appCommandOf, type AppCommand, nthLatestReply, isForkCommand,
  renderItemsFromStreamedRows, applyStreamedToolResults, pendingTools, shouldApplyReload, clearsRunning, hasAssistantRenderItem, suppressSealedPreview, mergeReloadedPage, dropCancelledMessage,
  firstBlockedElsewhere, projectDirFromSessionKey,
  type ComposerImage, type PastedTextChip, type NewProjectOptions, type LivePreview
} from './lib'

const NAV_MIN = 220, NAV_MAX = 560, BLADE_MIN = 160, BLADE_MAX = 480

function readStoredWidth(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(`cc.width.${key}`)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Boolean UI prefs (sidebar/rail collapse) persist in localStorage, same as
 *  panel widths -- window-local chrome state, no need to round-trip the DB. */
function readStoredBool(key: string, fallback: boolean): boolean {
  const raw = window.localStorage.getItem(`cc.ui.${key}`)
  return raw === null ? fallback : raw === '1'
}

/** How far the wheel travels for one step of text size. A mouse's notch is more than this. */
const NO_AGENT_RUNS: AgentRun[] = []
const WHEEL_NOTCH = 50
const CHAT_SCALE_NOTE_MS = 1200
const CHAT_SCALE_SAVE_MS = 300

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
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [groups, setGroups] = useState<ChannelGroup[]>([])
  const [project, setProject] = useState<ChannelRow | null>(null)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [memoryChannel, setMemoryChannel] = useState<ChannelRow | null>(null)
  const [turnStartedAt, setTurnStartedAt] = useState(0)
  const [turnTokens, setTurnTokens] = useState(0)
  const [lastEventAt, setLastEventAt] = useState(0)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [liveModel, setLiveModel] = useState<string | null>(null)
  /** Bumped when a command changes the model or effort, so the header's pickers read it again. */
  const [headerRev, setHeaderRev] = useState(0)
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>({})
  const [shellRuns, setShellRuns] = useState<ShellRun[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerStatus[] | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<SessionSummary | null>(null)
  const [items, setItems] = useState<RenderItem[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [oldestSeq, setOldestSeq] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  // True when the open session's JSONL was removed from disk (Claude Code's
  // cleanupPeriodDays) but the catalog still has it -- drives an "archived"
  // transcript message instead of "no messages".
  const [transcriptFileMissing, setTranscriptFileMissing] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
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
  const [planUsage, setPlanUsage] = useState<PlanUsage>(NO_PLAN_USAGE)
  // App-wide settings, loaded once and kept live via SettingsWindow's
  // onSettingsChanged. Null until the first load resolves; the few things that
  // read it (e.g. showToolCalls in the transcript) fall back to sensible
  // defaults while null so nothing flickers on first paint.
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // Channel ids with new activity the user hasn't looked at yet -- drives the
  // nav's unread glow. A channel is marked when a background catalog sync
  // advances its lastActivity while it ISN'T the open project, and cleared the
  // moment the user opens it (openProject).
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
  const [railExpanded, setRailExpanded] = useState(() => readStoredBool('rail', true))
  const [fsEntries, setFsEntries] = useState<import('../shared/ipc').FsEntry[]>([])
  const [createImageOpen, setCreateImageOpen] = useState(false)
  // Whether a turn is currently running for the open session. Flips true
  // right when Composer's onSend fires, flips false on that session's
  // 'result' event. This flag is what Composer uses to decide send-vs-queue,
  // and (with queuedCount) what LiveIndicator shows in the header.
  const [running, setRunning] = useState(false)
  const runningRef = useRef(running)
  runningRef.current = running
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([])
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<ProjectSearchResult | null>(null)
  const [findLoading, setFindLoading] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const jumpPendingRef = useRef(false)
  const [jumpTarget, setJumpTarget] = useState<{ sessionPk: number; uuid: string; seq: number } | null>(null)
  const updateHoldRef = useRef(false)
  const [savedTextOnly, setSavedTextOnly] = useState(false)
  const lastSentRef = useRef('')
  const [subagentOpen, setSubagentOpen] = useState<string | null>(null)
  const [agentRunsByPk, setAgentRunsByPk] = useState<ReadonlyMap<number, AgentRun[]>>(new Map())
  const [liveThinking, setLiveThinking] = useState<string | null>(null)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [taskOutputOpen, setTaskOutputOpen] = useState<{ id: string; title: string } | null>(null)
  /** The screen a terminal command opened: /hooks, /diff, /tasks or /export. */
  const [panel, setPanel] = useState<'hooks' | 'diff' | 'tasks' | 'export' | null>(null)
  const closePanel = useCallback((): void => setPanel(null), [])
  const closeSubagent = useCallback((): void => setSubagentOpen(null), [])
  const closeRewind = useCallback((): void => setRewindOpen(false), [])
  const [railView, setRailView] = useState<RailView>(() => window.localStorage.getItem('cc.ui.railView') === 'pins' ? 'pins' : 'files')
  useEffect(() => { window.localStorage.setItem('cc.ui.railView', railView) }, [railView])
  const [pins, setPins] = useState<PinnedMessage[]>([])
  const closeTaskOutput = useCallback((): void => setTaskOutputOpen(null), [])
  // A `/btw` question, and its answer once it comes.
  const [sideQuestion, setSideQuestion] = useState<{ question: string; answer: string | null; error: string | null } | null>(null)
  const [chatMode, setChatMode] = useState('default')
  // What MCP servers are asking, by chat, kept for a chat that isn't on screen.
  const [elicitations, setElicitations] = useState<Map<number, Elicitation[]>>(new Map())
  const setChatElicitations = useCallback((pk: number, change: (list: Elicitation[]) => Elicitation[]): void => {
    setElicitations(prev => {
      const next = change(prev.get(pk) ?? [])
      if (next.length === 0 && !prev.has(pk)) return prev
      const map = new Map(prev)
      if (next.length === 0) map.delete(pk)
      else map.set(pk, next)
      return map
    })
  }, [])
  const [liveActivity, setLiveActivity] = useState<string | null>(null)
  const [shellStops, setShellStops] = useState(0)
  // Projects newly found with their folder gone, until the user has seen the notice.
  const [newlyArchived, setNewlyArchived] = useState<ChannelRow[]>([])
  // Chats with a message on its way: sent, but not in the transcript yet. On a chat with
  // no running process that can take a few seconds.
  const [sendingPks, setSendingPks] = useState<ReadonlySet<number>>(new Set())
  const sendingRef = useRef<ReadonlySet<number>>(sendingPks)
  const markSending = useCallback((pk: number, on: boolean): void => {
    if (sendingRef.current.has(pk) === on) return
    const next = new Set(sendingRef.current)
    if (on) next.add(pk)
    else next.delete(pk)
    sendingRef.current = next
    setSendingPks(next)
  }, [])
  // The open chat whose running state and lock have been read, so the message box can
  // act on them.
  const [settledPk, setSettledPk] = useState<number | null>(null)
  // Live-turn reconciliation (Plan 2 Task 10): a transient "typing" preview
  // built from accumulating engine:event deltas, rendered as a temporary
  // bubble at the bottom of Transcript while `running` is true. Cleared
  // (reduceLivePreview returns null) the instant `result` fires -- from then
  // on the durable engine:rows delivery (already appended into `items` via
  // appendRowsToItems as it arrived) is what's actually showing.
  const [livePreview, setLivePreview] = useState<LivePreview | null>(null)
  // Mirrors Composer's internal queue length (Task 10) purely for
  // LiveIndicator's 'queued' vs 'streaming' badge -- the queue's actual
  // add/remove/reorder state stays owned by Composer itself.
  const [queuedCount, setQueuedCount] = useState(0)
  // A process outside Delegatto (a terminal) holding the OPEN chat -- while
  // set, the composer is read-only. Seeded on open via api.getLock, then kept
  // current by engine:lockChanged.
  const [externalLock, setExternalLock] = useState<ExternalLock | null>(null)
  // Chats a live claude has under Remote Control (/rc) -- badged in the rail,
  // chat list, session list and chat header. App-wide, pushed by main.
  const [remote, setRemote] = useState<RemoteSession[]>([])
  const remoteProjects = useMemo(() => new Set(remote.map(r => r.projectId)), [remote])
  const pending = useMemo(() => pendingTools(items, running), [items, running])
  const pendingToolIds = useMemo(() => new Set(pending.map(p => p.toolUseId)), [pending])
  const remoteSessions = useMemo(() => new Set(remote.map(r => r.sessionPk)), [remote])
  useEffect(() => {
    void api.listRemote().then(setRemote).catch(() => { /* engine not ready: stays empty */ })
    return api.onRemoteChanged(setRemote)
  }, [])
  // Pending permission/plan-approval requests (Plan 2 Task 9), keyed by the
  // sessionPk they belong to -- NOT filtered to just the open session, so a
  // request that arrives for a session the user isn't currently looking at
  // is kept (not lost, not silently answered) and simply doesn't render
  // until the user switches to that session. Plan.get(session.id) below is
  // what actually narrows this down to what Transcript renders.
  const [permissionsByPk, setPermissionsByPk] = useState<Map<number, PermissionRequest[]>>(new Map())
  // Request ids whose blocked-turn banner the user dismissed (banner stays gone
  // until a new request arrives). Arrival times drive the banner countdown.
  const [dismissedPerms, setDismissedPerms] = useState<Set<string>>(new Set())
  const permArrivedRef = useRef<Map<string, number>>(new Map())
  // Per-session draft text, so switching away and back restores what was
  // being typed. A ref (not state) since it's read only when (re)mounting a
  // Composer, never needs to trigger a render itself.
  const draftsRef = useRef<Map<number, string>>(new Map())
  // Latest channels + open-project id, mirrored into refs so the app-wide
  // onIndexed listener (registered once, below) can diff against them without
  // re-subscribing on every channel/project change.
  const channelsRef = useRef<ChannelRow[]>([])
  const projectIdRef = useRef<number | null>(null)
  // Whether the transcript is following at the bottom (vs scrolled up reading
  // history). Reported by Transcript; gates the background-sync reload so a
  // sync never yanks the reader's scroll position. Defaults true -- a freshly
  // opened session lands at the bottom.
  const atBottomRef = useRef(true)
  // An update to the open chat that was held back while the reader was further up,
  // applied once they're back at the end.
  const heldReloadRef = useRef<(() => void) | null>(null)
  // Bumped whenever we want the transcript to jump to the absolute bottom
  // imperatively (e.g. right after the user sends a message). Transcript watches
  // it and scrolls; the value itself is meaningless, only that it changed.
  const [scrollToBottomTick, setScrollToBottomTick] = useState(0)
  useEffect(() => { channelsRef.current = channels }, [channels])
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

  // Drafts, queued messages and attachments live only in this window, so a restart for
  // an update waits for them.
  const refreshUpdateHold = useCallback((): void => {
    const hold = composeStore.hasUnsent() || [...draftsRef.current.values()].some(d => d.trim().length > 0)
    if (hold !== updateHoldRef.current) { updateHoldRef.current = hold; void api.setUpdateHold(hold) }
  }, [])
  useEffect(() => composeStore.subscribe(refreshUpdateHold), [refreshUpdateHold])
  // Every chat's queue, whichever chat is on screen.
  useEffect(() => api.onEvent((pk, ev) => {
    // Esc before any reply: Claude forgets the message and it goes back in the box. Read
    // before the store moves on, since the turn is over once this event has been handled.
    const takenBack = composeStore.settleCancel(pk, ev)
    if (takenBack !== null && takenBack.uuid !== undefined) {
      const uuid = takenBack.uuid
      void api.rewindUnanswered(pk, uuid).then(rewound => {
        if (!rewound) return
        composeStore.returnMessage(pk, takenBack)
        setItems(prev => dropCancelledMessage(prev, uuid))
      })
    }
    composeStore.handleEvent(pk, ev, (chat, command) => { void api.shellRun(chat, command) })
    setAgentRunsByPk(prev => {
      const runs = prev.get(pk) ?? NO_AGENT_RUNS
      const next = reduceAgentRuns(runs, ev)
      if (next === runs) return prev
      const map = new Map(prev)
      map.set(pk, next)
      return map
    })
    if (ev.kind === 'elicitation') setChatElicitations(pk, list => [...list, ev.request])
    if (ev.kind === 'permissionGone') {
      setPermissionsByPk(prev => {
        const list = prev.get(pk)
        if (list === undefined || !list.some(r => r.id === ev.id)) return prev
        const next = new Map(prev)
        const left = list.filter(r => r.id !== ev.id)
        if (left.length === 0) next.delete(pk)
        else next.set(pk, left)
        return next
      })
    }
    // The process that asked is gone, or the turn it asked in is over.
    if (ev.kind === 'exit' || ev.kind === 'result') setChatElicitations(pk, () => [])
    if (ev.kind === 'other' && ev.type === SHELL_OUTPUT_SENT) markSending(pk, true)
    // The folder went while the chat was open: its row moves to Archived.
    if (ev.kind === 'other' && ev.type === FOLDER_MISSING) refreshNavRef.current()
    // It isn't coming: refused, stopped, or a command that writes no message of its own.
    if (clearsRunning(ev)) markSending(pk, false)
  }), [markSending, setChatElicitations])
  // Whichever chat is on screen, so one opened later doesn't show it as still on its way.
  useEffect(() => api.onRows((pk, rows) => {
    if (sendingRef.current.has(pk) && hasUserRenderItem(renderItemsFromStreamedRows(rows))) markSending(pk, false)
  }), [markSending])

  // Persist panel widths so a drag survives relaunch.
  useEffect(() => { window.localStorage.setItem('cc.width.nav', String(navWidth)) }, [navWidth])
  useEffect(() => { window.localStorage.setItem('cc.width.blade', String(bladeWidth)) }, [bladeWidth])
  useEffect(() => { window.localStorage.setItem('cc.blade.collapsed', String(collapsed)) }, [collapsed])
  useEffect(() => { window.localStorage.setItem('cc.ui.sidebar', sidebarExpanded ? '1' : '0') }, [sidebarExpanded])

  // Load the project's file tree + git status for the context rail whenever the
  // open project changes. Walked on demand (no watcher yet); cheap + bounded.
  useEffect(() => {
    const cwd = project?.cwd ?? null
    if (cwd === null) { setFsEntries([]); return }
    let cancelled = false
    void api.fsTree(cwd).then(entries => { if (!cancelled) setFsEntries(entries) }).catch(() => { if (!cancelled) setFsEntries([]) })
    return () => { cancelled = true }
  }, [project?.cwd])

  // Plan usage for the chat-list footer.
  useEffect(() => {
    void api.planUsage().then(setPlanUsage).catch(() => {})
    return api.onPlanUsageChanged(setPlanUsage)
  }, [])

  // Footer "Chat elevation level" line (Windows).
  useEffect(() => { void api.isElevated().then(setElevated) }, [])

  // Load settings once so the transcript can honour display prefs (e.g.
  // hiding tool-call cards). Kept live below via SettingsWindow.
  useEffect(() => { void api.getSettings().then(setSettings) }, [])

  // Text sizes and font, on the page root so dialogs and pop-ups get the font too.
  const chatScaleRef = useRef(FONT_SCALE_DEFAULT)
  const chatScaleSaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [chatScaleNote, setChatScaleNote] = useState<number | null>(null)
  const chatFontScale = settings?.chatFontScale ?? FONT_SCALE_DEFAULT
  const sidebarFontScale = settings?.sidebarFontScale ?? FONT_SCALE_DEFAULT
  const appFont = settings?.appFont ?? ''
  useEffect(() => {
    // Mid-scroll the wheel is ahead of what's saved, so an older answer mustn't pull it back.
    if (chatScaleSaving.current !== null) return
    chatScaleRef.current = chatFontScale
    document.documentElement.style.setProperty('--chat-zoom', String(chatFontScale / 100))
  }, [chatFontScale])
  useEffect(() => { document.documentElement.style.setProperty('--sidebar-zoom', String(sidebarFontScale / 100)) }, [sidebarFontScale])
  useEffect(() => {
    const root = document.documentElement
    if (appFont === '') {
      root.removeAttribute('data-custom-font')
      root.style.removeProperty('--app-font')
    } else {
      root.setAttribute('data-custom-font', '')
      root.style.setProperty('--app-font', fontStack(appFont))
    }
  }, [appFont])

  // Ctrl + wheel over the chat: its text size, for every chat. Keeps the reader's place.
  useEffect(() => {
    let leftover = 0
    let hideNote: ReturnType<typeof setTimeout> | null = null
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      const stream = (e.target as Element | null)?.closest?.('.stream') ?? null
      if (stream === null) return
      e.preventDefault()
      leftover += e.deltaY
      if (Math.abs(leftover) < WHEEL_NOTCH) return
      const next = stepFontScale(chatScaleRef.current, leftover < 0 ? 'up' : 'down')
      leftover = 0
      if (next === chatScaleRef.current) return
      const place = stream.scrollTop / Math.max(stream.scrollHeight, 1)
      chatScaleRef.current = next
      document.documentElement.style.setProperty('--chat-zoom', String(next / 100))
      stream.scrollTop = place * stream.scrollHeight
      setChatScaleNote(next)
      if (hideNote !== null) clearTimeout(hideNote)
      hideNote = setTimeout(() => setChatScaleNote(null), CHAT_SCALE_NOTE_MS)
      if (chatScaleSaving.current !== null) clearTimeout(chatScaleSaving.current)
      chatScaleSaving.current = setTimeout(() => {
        chatScaleSaving.current = null
        void api.updateSettings({ chatFontScale: chatScaleRef.current }).then(setSettings)
      }, CHAT_SCALE_SAVE_MS)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('wheel', onWheel)
      if (hideNote !== null) clearTimeout(hideNote)
    }
  }, [])

  // Theme: `<html data-theme>` picks the theme's block in styles.css, or a theme
  // file from this PC's themes folder. Cached in localStorage so main.tsx can
  // apply it before first paint (no flash of the default while settings load).
  // `themeScope` decides whether the skin covers the whole window (<html>) or
  // just the chat pane (<main data-theme> below). Until settings load, the
  // cached choice is used so the first paint already matches.
  const cachedChoice = useMemo(cachedTheme, [])
  const themeChoice: ThemeChoice = settings === null
    ? cachedChoice
    : { theme: settings.theme, scope: settings.themeScope }
  // Read again on each change, so an edited theme file shows when it's chosen.
  const [localThemes, setLocalThemes] = useState<LocalTheme[] | null>(null)
  useEffect(() => { void api.listLocalThemes().then(setLocalThemes) }, [themeChoice.theme])
  useEffect(() => {
    if (settings === null) return
    applyTheme(themeChoice, localThemes ?? [])
    applyThemeColors(settings.themeColors)
  }, [themeChoice.theme, themeChoice.scope, localThemes, JSON.stringify(settings?.themeColors ?? {})])

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

  // Auto-clean removed old chats: drop them from the nav.
  useEffect(() => api.onRetentionCleaned(() => refreshNavRef.current()), [])

  // Keep the nav live: whenever a catalog sync completes (for ANY session, not
  // just the open one), re-pull the channel list so previews/timestamps
  // reflect the newest message, and flag any channel whose activity advanced
  // while it wasn't the open project as unread. Registered once for the app's
  // lifetime; reads current channels/open-project via refs so it never needs
  // to re-subscribe. Distinct from the session-scoped onIndexed reload below,
  // which only refreshes the open transcript.
  //
  // Coalesced: the external-change sweep can report several chats in one tick
  // (each its own `engine:indexed`), and a live turn emits one per row batch --
  // a short trailing debounce turns any burst into a single nav re-pull.
  // Also re-pulls the open project's session list so a chat continued
  // elsewhere bumps to the top of it even while the open transcript is
  // scrolled up (the session-scoped reload below skips that case).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onIndexed(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refreshNavRef.current() }, 120)
    })
    return () => { off(); if (timer !== null) clearTimeout(timer) }
  }, [])

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
    const reqId = ++sessionReqId.current
    if (channel !== null) { setProject(channel); setRevealChannel(channel.id) }
    const list = channel === null ? [] : await api.listSessions(channel.id)
    if (isStaleResponse(reqId, sessionReqId.current)) return
    setSessions(list)
    const target = list.find(s => s.id === sessionPk) ?? null
    if (target !== null) await openSession(target)
  }
  openChatRef.current = (pk, dir) => { setManageOpen(false); void openSearchResult(pk, dir) }

  // Guards two independent races the naive version misses:
  //  - clicking channels/sessions faster than their fetches resolve, which
  //    would otherwise let a stale response overwrite a newer selection
  //  - loadOlder firing twice before the first call resolves (fast repeated
  //    scroll or the auto-load-if-too-short effect racing a manual scroll),
  //    which would otherwise double-fetch and duplicate-prepend a page
  // sessionReqId is bumped synchronously on every openSession/openProject
  // call; loadingOlderRef is a ref (not state) so the check is synchronous
  // and not subject to React's state-update batching.
  const sessionReqId = useRef(0)
  const loadingOlderRef = useRef(false)
  // Task 10 fix pass 2: guards the onIndexed reload effect below against a
  // back-to-back QUEUED turn on the SAME still-open session. Composer drains
  // its queue the instant turn A's `result` flips `running` false, calling
  // App's onSend -- which bumps this ref -- to dispatch turn B immediately.
  // Meanwhile turn A's own `result` also kicked off a catalog sync whose
  // `engine:indexed` triggers an ASYNC `loadTranscript` reload; if that
  // reload resolves only after turn B's `onRows` has already appended durable
  // rows into `items`, a wholesale `setItems(page.items)` replace from turn
  // A's stale reload would drop turn B's rows from view (self-heals on turn
  // B's own settle, but a real, avoidable clobber in the meantime). The
  // reload effect captures this ref's value before its async
  // `loadTranscript`, then -- via `shouldApplyReload` -- only applies the
  // reload if the generation is STILL what it captured, i.e. no newer turn
  // has since started on this same session. `sessionReqId` alone can't catch
  // this: it only guards a reload against a session SWITCH, not a new turn
  // starting on the session that stayed open the whole time.
  const reloadGenRef = useRef(0)
  // Hard in-flight guard for createChat, mirroring loadingOlderRef above: a
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

  // Opening a session loads only the newest page; older pages arrive on scroll.
  async function openSession(next: SessionSummary) {
    const reqId = ++sessionReqId.current
    heldReloadRef.current = null
    // Any loadOlder still in flight belonged to whatever session was open a
    // moment ago; it can no longer apply here. Clearing the flag up front
    // (rather than waiting for that stale call's own finally) means this
    // session's first auto-load-if-too-short check is never blocked behind
    // someone else's pending fetch.
    loadingOlderRef.current = false
    // A newly opened session lands at the bottom (following), until Transcript
    // reports otherwise -- so a sync right after open isn't wrongly skipped.
    atBottomRef.current = true
    setSession(next)
    setItems([]); setOldestSeq(null); setHasMore(false); setSessionLoading(true)
    setLoadingOlder(false); setTranscriptFileMissing(false); setSavedTextOnly(false)
    // A running turn (and its live preview / queued count) belongs to
    // whatever session was open a moment ago; none of it carries over to the
    // newly opened one -- Composer itself remounts fresh too (key=session.id).
    setRunning(false)
    setLivePreview(null)
    setLiveThinking(null)
    setRewindOpen(false)
    setTaskOutputOpen(null)
    setPanel(null)
    setQueuedCount(0)
    setExternalLock(null)
    setSettledPk(null)
    try {
      // Refresh-on-open: if this chat's transcript changed on disk since the
      // catalog last saw it (continued from a terminal, say), re-index it
      // first so the page below is current -- and refresh the nav, whose
      // preview/ordering for this chat is just as stale.
      const refreshed = await api.syncSessionIfStale(next.id).catch(() => false)
      if (isStaleResponse(reqId, sessionReqId.current)) return
      if (refreshed) refreshNavRef.current()
      const page = await api.loadTranscript(next.id)
      if (isStaleResponse(reqId, sessionReqId.current)) return // superseded by a newer selection
      setItems(page.items); setOldestSeq(page.oldestSeq); setHasMore(page.hasMore)
      setTranscriptFileMissing(page.fileMissing ?? false)
      setSavedTextOnly(page.savedTextOnly ?? false)
      // Re-derive `running` when switching back to a session whose turn is
      // still streaming (Plan 3 Task 8 / Plan 2 review #6) — otherwise the
      // composer would wrongly allow a direct send into a live transport.
      const [live, lock] = await Promise.all([api.isSessionLive(next.id), api.getLock(next.id).catch(() => null)])
      if (!isStaleResponse(reqId, sessionReqId.current)) { setRunning(live); setExternalLock(lock); setSettledPk(next.id) }
    } finally {
      if (!isStaleResponse(reqId, sessionReqId.current)) setSessionLoading(false)
    }
  }

  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  async function openProject(next: ChannelRow) {
    const reqId = ++sessionReqId.current
    setProject(next)
    // Opening a channel reads it: clear any unread glow it carried.
    setUnread(prev => {
      if (!prev.has(next.id)) return prev
      const n = new Set(prev); n.delete(next.id); return n
    })
    const list = await api.listSessions(next.id)
    if (isStaleResponse(reqId, sessionReqId.current)) return // a newer channel/session click won the race
    setSessions(list)
    // Spec: clicking a channel opens its newest-modified session.
    const newest = list[0] ?? null
    if (newest === null) {
      setSession(null); setItems([]); setOldestSeq(null); setHasMore(false)
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
  async function createChat(options: NewProjectOptions, sync: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
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
      if (sync) setStartingSync({ workingDir: options.cwd, name: options.cwd.split(/[\\/]/).filter(p => p.length > 0).pop() ?? options.cwd })
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

    const reqId = ++sessionReqId.current
    setProject(proj)
    const sessList = await api.listSessions(proj.id)
    setNewChatOpen(false)
    if (isStaleResponse(reqId, sessionReqId.current)) return
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
  async function clearChat(): Promise<void> {
    if (session === null || creatingChatRef.current) return
    creatingChatRef.current = true
    try {
      const outcome = await api.clearChat(session.id)
      if (!outcome.ok) { setTerminalNotice(outcome.error); return }
      if (outcome.unchanged) return
      await openCreatedChat(outcome.cwd, outcome.sessionId)
    } finally {
      creatingChatRef.current = false
    }
  }
  const clearChatRef = useRef(clearChat)
  clearChatRef.current = clearChat

  // Wrapped in useCallback so its identity is stable across unrelated App
  // re-renders: it's passed to Transcript as onReachTop, which sits in a
  // useLayoutEffect dependency array there, and a fresh function every render
  // would re-run that effect constantly. session/oldestSeq/hasMore are its
  // only reactive dependencies — sessionReqId and loadingOlderRef are refs
  // (stable identity, read via .current) and the setters are stable too.
  const loadOlder = useCallback(async (fromSeq?: number) => {
    if (session === null || oldestSeq === null || loadingOlderRef.current || !hasMore) return
    const reqId = sessionReqId.current
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const page = await api.loadTranscript(session.id, fromSeq === undefined ? { before: oldestSeq } : { before: oldestSeq, fromSeq })
      if (isStaleResponse(reqId, sessionReqId.current)) return // the session changed while this page was in flight
      if (page.items.length > 0) {
        setItems(prev => [...page.items, ...prev])
        setOldestSeq(page.oldestSeq)
      }
      // Defends against a page that reports hasMore with zero items, which
      // would otherwise loop loadOlder forever with no progress.
      setHasMore(page.hasMore && page.items.length > 0)
    } finally {
      // Only the call that still owns the current session may release the
      // lock — otherwise a stale call resolving after a session switch would
      // clear a flag a newer, still-in-flight loadOlder for the new session
      // just set, letting a second concurrent fetch slip through for it.
      if (!isStaleResponse(reqId, sessionReqId.current)) {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    }
  }, [session, oldestSeq, hasMore])

  // Which chat is on screen, in case an update restarts the app.
  const openChatId = session?.id ?? null
  const openChatDir = project?.dirName ?? null
  useEffect(() => {
    void api.setUpdateOpenChat(openChatId !== null && openChatDir !== null ? { sessionPk: openChatId, projectDir: openChatDir } : null)
  }, [openChatId, openChatDir])

  // Pinned messages of the open project.
  const pinProjectId = project?.id ?? null
  const refreshPins = useCallback((): void => {
    if (pinProjectId === null) { setPins([]); return }
    void api.listPins(pinProjectId).then(setPins).catch(() => {})
  }, [pinProjectId])
  useEffect(() => { refreshPins() }, [refreshPins])
  const pinnedUuids = useMemo(() => new Set(pins.map(p => p.uuid)), [pins])
  const pinOpenMessage = useCallback((uuid: string): void => {
    if (openChatId === null) return
    void api.pinMessage(openChatId, uuid).then(ok => {
      if (ok) refreshPins()
      else setTerminalNotice("That message couldn't be pinned yet. Try again in a moment.")
    })
  }, [openChatId, refreshPins])
  const unpinOpenMessage = useCallback((uuid: string): void => {
    if (openChatId === null) return
    void api.unpinMessage(openChatId, uuid).then(refreshPins)
  }, [openChatId, refreshPins])

  // Going to a search result: load back to it, then Transcript scrolls there.
  useEffect(() => {
    if (jumpTarget === null || session === null || session.id !== jumpTarget.sessionPk) return
    if (sessionLoading || loadingOlder || oldestSeq === null || oldestSeq <= jumpTarget.seq) return
    if (hasMore) void loadOlder(jumpTarget.seq)
    else setJumpTarget(null)
  }, [jumpTarget, session, sessionLoading, loadingOlder, oldestSeq, hasMore, loadOlder])
  // Reading a different chat by now: don't yank the view when coming back to that one.
  const openSessionId = session?.id ?? null
  useEffect(() => {
    setJumpTarget(t => t !== null && openSessionId !== null && t.sessionPk !== openSessionId && !jumpPendingRef.current ? null : t)
    jumpPendingRef.current = false
  }, [openSessionId])

  // Tracks turn-running state AND the live typing preview for whatever
  // session is currently open, by watching engine events scoped to its pk.
  // Re-subscribes whenever the open session changes -- the closure captures
  // that session's id fresh each time, and the returned unsubscribe tears
  // down the previous session's listener, so a 'result' for a session that's
  // no longer open can never flip `running`/`livePreview` for whatever
  // session replaced it.
  //
  // reduceLivePreview owns the actual accumulate/replace/clear logic (Plan 2
  // Task 10): delta appends, assistant replaces wholesale, result clears.
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    const off = api.onEvent((sessionPk, ev) => {
      if (sessionPk !== sid) return
      setLastEventAt(Date.now())
      setLivePreview(prev => reduceLivePreview(prev, ev))
      if (ev.kind === 'thinkingDelta') setLiveThinking(t => (t ?? '') + ev.text)
      else if (ev.kind === 'delta' || ev.kind === 'assistant' || clearsRunning(ev)) setLiveThinking(null)
      if (ev.kind === 'init' && ev.mcpServers !== undefined) setMcpServers(ev.mcpServers)
      if (ev.kind === 'exit') setMcpServers(null)
      if (ev.kind === 'usage') setTurnTokens(n => n + ev.outputTokens)
      if (ev.kind === 'suggestion') setSuggestion(ev.text)
      if (ev.kind === 'init') setLiveModel(ev.model)
      if (ev.kind === 'init') setChatMode(ev.permissionMode)
      if (ev.kind === 'status' && ev.permissionMode !== undefined) setChatMode(ev.permissionMode)
      // Also how a turn nobody sent shows up: Claude Code carrying on after a background task.
      if (ev.kind === 'init') setRunning(true)
      if (ev.kind === 'background') setBackgroundTasks(ev.tasks)
      if (ev.kind === 'exit') setBackgroundTasks([])
      if (ev.kind === 'result') void api.contextUsage(sid).then(c => { if (c !== null) setContext(c) })
      // A failed turn writes nothing to the chat, so without this it just stops.
      if (ev.kind === 'result' && ev.isError) setTerminalNotice(ev.text)
      if (ev.kind === 'retry') setLiveActivity(retryLabel(ev))
      if (ev.kind === 'hook' && ev.phase === 'started') setLiveActivity(`Running hook: ${ev.name}`)
      if (ev.kind === 'hook' && ev.phase === 'finished') {
        setLiveActivity(null)
        // Exit code 2 is a hook saying no on purpose, not a hook going wrong.
        if (ev.outcome === 'error' && ev.exitCode !== 2) setTerminalNotice(`The ${ev.name} hook failed${ev.output.length > 0 ? `: ${ev.output.slice(0, 400)}` : '.'}`)
      }
      if (ev.kind === 'delta' || ev.kind === 'assistant' || clearsRunning(ev)) setLiveActivity(null)
      if (ev.kind === 'other' && ev.type === FOLDER_MISSING) {
        const unsent = lastSentRef.current
        void (unsent.length > 0 ? navigator.clipboard.writeText(unsent).then(() => true, () => false) : Promise.resolve(false)).then(copied => {
          setTerminalNotice(`That message wasn't sent: this project's folder no longer exists, so Claude can't run here.${copied ? ' Your message is on the clipboard.' : ''}`)
        })
      }
      if (ev.kind === 'other' && ev.type.startsWith('spawn-error')) setTerminalNotice(spawnErrorNotice(ev.type.slice('spawn-error: '.length)))
      if (ev.kind === 'status') setLiveStatus(ev.status === 'compacting' ? ev.status : null)
      else if (clearsRunning(ev)) setLiveStatus(null)
      // Task 10 review Fix 1: previously only a `result` event cleared
      // `running`, so any other way a turn ends -- the transport exiting
      // without ever sending one (spawn failure, an Esc-triggered SIGINT, a
      // crash), or a send refused before any transport was even spawned
      // (`refused-external-live` / `unknown-session`) -- left `running`
      // stuck true forever: the composer stayed wedged in "streaming" mode,
      // unable to drain its queue or accept a retry. clearsRunning widens
      // the check to cover all of those terminal cases; reduceLivePreview's
      // own `exit` case already clears livePreview alongside it above.
      if (clearsRunning(ev)) setRunning(false)
    })
    return off
  }, [session])

  // MCP status for the open chat. A process already running answers straight away;
  // otherwise the first turn's init event brings it. While any server is still
  // starting, ask again: nothing else would report how it turned out.
  const sessionPk = session?.id ?? null
  // A search belongs to what was on screen: opening a chat goes back to reading it.
  useEffect(() => { setFindQuery('') }, [sessionPk])
  const findProjectId = project?.id ?? null
  // New messages can match too, so a change in the chat searches again. Debounced, and
  // an answer to an older search is dropped.
  const findTerms = findQuery.trim()
  useEffect(() => {
    if (findTerms === '' || findProjectId === null) { setFindResult(null); setFindLoading(false); return }
    let alive = true
    setFindLoading(true)
    const timer = setTimeout(() => {
      void api.searchProject(findProjectId, findTerms)
        .then(r => { if (alive) { setFindResult(r); setFindLoading(false) } })
        .catch(() => { if (alive) { setFindResult({ hits: [], total: 0 }); setFindLoading(false) } })
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [findTerms, findProjectId, items.length])

  useEffect(() => {
    setBackgroundTasks([])
    if (sessionPk === null) return
    let alive = true
    void api.backgroundTasks(sessionPk).then(t => { if (alive) setBackgroundTasks(t) })
    return () => { alive = false }
  }, [sessionPk])
  useEffect(() => {
    setMcpServers(null)
    if (sessionPk === null) return
    let alive = true
    void api.mcpStatus(sessionPk).then(s => { if (alive) setMcpServers(s) })
    return () => { alive = false }
  }, [sessionPk])
  useEffect(() => {
    setShellRuns([])
    if (sessionPk === null) return
    let alive = true
    void api.shellList(sessionPk).then(r => { if (alive) setShellRuns(r) })
    const off = api.onShellChanged((pk, runs) => {
      if (pk !== sessionPk) return
      setShellRuns(prev => {
        // One that finished goes to Claude and a turn follows, which sends what's queued next.
        // One that was stopped has no turn to wait for.
        if (prev.some(p => p.state === 'running' && runs.find(r => r.id === p.id)?.state === 'stopped')) setShellStops(n => n + 1)
        return runs
      })
    })
    return () => { alive = false; off() }
  }, [sessionPk])
  useEffect(() => {
    if (!running) { setLiveStatus(null); return }
    const now = Date.now()
    setTurnStartedAt(now)
    setTurnTokens(0)
    setLastEventAt(now)
    setSuggestion(null)
    if (sessionPk === null) return
    // Coming back to a chat mid-turn: the engine pool knows the real figures.
    let alive = true
    void api.turnInfo(sessionPk).then(turn => {
      if (!alive || turn === null) return
      setTurnStartedAt(turn.startedAt)
      setTurnTokens(turn.tokens)
      setLastEventAt(turn.lastActivity)
    })
    return () => { alive = false }
  }, [running, sessionPk])
  // What belongs to one chat starts fresh when another opens.
  useEffect(() => {
    setSuggestion(null)
    setLiveModel(null)
    setContext(null)
    setProjectSettings({})
    if (sessionPk === null) return
    let alive = true
    void api.getProjectSettings(sessionPk).then(c => {
      if (!alive) return
      setProjectSettings(c)
      setRailExpanded(c.filesExpanded ?? readStoredBool('rail', true))
    })
    void api.contextUsage(sessionPk).then(c => { if (alive) setContext(c) })
    return () => { alive = false }
  }, [sessionPk])
  const toolDisplay = effectiveToolDisplay(settings?.toolDisplay ?? 'grouped', projectSettings)
  const showThinking = effectiveThinkingDisplay(settings?.thinkingDisplay ?? 'show', projectSettings) === 'show'
  // The Files panel is remembered per project. The last choice is also kept as the
  // starting point for projects that haven't made one.
  const toggleFiles = (open: boolean): void => {
    setRailExpanded(open)
    window.localStorage.setItem('cc.ui.rail', open ? '1' : '0')
    if (sessionPk !== null) void api.setProjectSettings(sessionPk, { filesExpanded: open }).then(setProjectSettings)
  }
  const mcpStarting = mcpServers?.some(s => s.status === 'pending') ?? false
  useEffect(() => {
    if (sessionPk === null || !mcpStarting) return
    const timer = setInterval(() => { void api.mcpStatus(sessionPk).then(setMcpServers) }, 4000)
    return () => clearInterval(timer)
  }, [sessionPk, mcpStarting])

  // Keeps the open chat's external-lock state current (a terminal taking it
  // over or releasing it while it's open).
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    return api.onLockChanged((sessionPk, lock) => { if (sessionPk === sid) setExternalLock(lock) })
  }, [session])

  // Reconciles durable engine:rows deliveries into the transcript while a
  // turn streams (Plan 2 Task 10): the watcher tails the session's growing
  // JSONL file and hands us newly-appended rows, converted to render items
  // via the SAME buildRenderItems the read path uses (renderItemsFromStream-
  // edRows), then appended via appendRowsToItems -- which de-dupes so a
  // re-delivered row (e.g. a session re-open racing the live tail) never
  // double-renders. Scoped to the OPEN session only, same rationale as the
  // running/livePreview effect above: rows for a session the user isn't
  // looking at right now aren't reflected in any visible transcript, so
  // there's nothing useful to do with them here (the watcher keeps running
  // regardless -- disposeSession is a later concern, not this task's).
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    const off = api.onRows((sessionPk, rows) => {
      if (sessionPk !== sid) return
      const newItems = renderItemsFromStreamedRows(rows)
      // A row carrying only a tool's result adds no item but completes an earlier one.
      setItems(prev => appendRowsToItems(applyStreamedToolResults(prev, rows), newItems))
      if (newItems.length === 0) return
      // Task 10 review Fix 5: once a durable assistant row for the current
      // turn has landed here, it's authoritative -- suppress the SEALED
      // livePreview bubble for that same (now-completed) message so a
      // tool-using turn doesn't render both for the whole intervening tool
      // call. suppressSealedPreview leaves an UNSEALED preview (the message
      // still actively streaming) untouched.
      const hasAssistantRow = hasAssistantRenderItem(newItems)
      if (hasAssistantRow) setLivePreview(prev => suppressSealedPreview(prev, hasAssistantRow))
    })
    return off
  }, [session])

  // Task 10 review Finding 1's fix: once engine-ipc.ts's indexDebouncer has
  // synced a live turn's durable rows into the catalog, `loadTranscript` for
  // this session now returns them -- reload it (for the OPEN session only) so
  // the transcript is replaced by the authoritative, freshly-indexed render
  // instead of relying solely on the live-appended `items` from onRows above.
  // This is what makes "switch channels and back" show the just-completed
  // turn instead of whatever the catalog held at app mount.
  //
  // Bumps sessionReqId the same way openSession/loadOlder do, so a reload for
  // a since-switched-away-from session can never clobber whatever a newer
  // openSession call already put in state (the `isStaleResponse` check
  // below). Also resets loadingOlderRef/loadingOlder the same way openSession
  // does: bumping sessionReqId while a loadOlder for THIS session is still in
  // flight would otherwise make that call's own finally see itself as
  // "stale" and skip clearing the flag, permanently wedging loadOlder for the
  // rest of this session's lifetime -- this reload supersedes any in-flight
  // older-page fetch just like a fresh openSession would.
  //
  // Fix pass 2: ALSO captures reloadGenRef before the async loadTranscript
  // and re-checks it via shouldApplyReload once the fetch resolves -- guards
  // against a back-to-back QUEUED turn on this SAME session (see
  // reloadGenRef's own comment above). sessionReqId alone only catches a
  // session SWITCH; it does nothing for a newer turn starting on the session
  // that never closed. When the generation has moved on, this reload bails
  // WITHOUT touching `items` or `livePreview` -- the newer turn's own
  // onRows/onIndexed cycle already owns both and reflects the appended rows;
  // wholesale-replacing here would clobber them with the pre-turn-B page.
  useEffect(() => {
    if (session === null) return
    const sid = session.id
    const off = api.onIndexed((sessionPk) => {
      if (sessionPk !== sid) return

      // Always refresh the open session's token totals so the header cost chip
      // tracks the conversation -- this is non-disruptive (just a header chip)
      // and must happen even while the user is reading history.
      const pid = projectIdRef.current
      if (pid !== null) {
        void api.listSessions(pid).then(sessList => {
          const updated = sessList.find(s => s.id === sid)
          if (updated !== undefined) setSession(prev => (prev !== null && prev.id === sid ? updated : prev))
        }).catch(() => { /* keep prior */ })
      }

      // Only reconcile the TRANSCRIPT when the user is following at the bottom.
      // If they've scrolled up reading history (possibly with older pages
      // loaded), a wholesale reload to the newest page would collapse those
      // pages and jump them to the bottom -- so leave their view untouched.
      if (!atBottomRef.current) { heldReloadRef.current = reload; return }
      reload()
    })
    const reload = (): void => {
      const reqId = ++sessionReqId.current
      const gen = reloadGenRef.current
      loadingOlderRef.current = false
      setLoadingOlder(false)
      void (async () => {
        try {
          const page = await api.loadTranscript(sid)
          if (!shouldApplyReload(reqId, sessionReqId.current, gen, reloadGenRef.current)) return
          // Only what the page covers changes. Earlier messages keep their place on
          // screen and their paging position, and text still being typed keeps going.
          const merged = mergeReloadedPage(itemsRef.current, page.items)
          setItems(merged.items)
          if (merged.keptAbove === 0) { setOldestSeq(page.oldestSeq); setHasMore(page.hasMore) }
          setLivePreview(prev => suppressSealedPreview(prev, true))
          // This reload bumped sessionReqId, so an openSession for this same
          // chat still in flight will treat itself as stale and skip clearing
          // its loading flag -- clear it here since this page supersedes it.
          setSessionLoading(false)
          const p2 = projectIdRef.current
          if (p2 !== null) {
            const sessList = await api.listSessions(p2)
            if (shouldApplyReload(reqId, sessionReqId.current, gen, reloadGenRef.current)) setSessions(sessList)
          }
        } catch (err) {
          // A reload failing (e.g. a transient IPC hiccup) must not crash the
          // app -- the transcript simply keeps showing whatever it had
          // (the live-appended rows, or the last successful load) until the
          // next indexed/openSession event gives it another chance.
          console.error('Reload after catalog sync failed', err)
        }
      })()
    }
    return off
  }, [session])

  // Subscribes once for the app's lifetime (not scoped to the open session --
  // a request for a session that isn't open must still be kept, per Task 9's
  // guard, so it can be shown later if the user switches to it).
  useEffect(() => {
    const off = api.onPermission((sessionPk, req) => {
      permArrivedRef.current.set(req.id, Date.now())
      setPermissionsByPk(prev => {
        const next = new Map(prev)
        next.set(sessionPk, [...(next.get(sessionPk) ?? []), req])
        return next
      })
    })
    return off
  }, [])

  // Forwards a PermissionCard/PlanApprovalCard decision to the engine and
  // removes it from the pending list. `sessionPk` is passed explicitly
  // (rather than closing over `session`) so a decision on a request that
  // arrived for a session the user has since navigated away from still
  // removes it from the RIGHT session's list, not whatever is open now.
  const onResolvePermission = useCallback(
    (sessionPk: number, id: string, decision: 'allow' | 'allow_always' | 'allow_folder' | 'deny', editedInput?: unknown, denyMessage?: string) => {
      api.resolvePermission(id, decision, editedInput, denyMessage)
      // So Project options lists the folder, and it can be taken back out from there.
      if (decision === 'allow_folder') void api.getProjectSettings(sessionPk).then(c => { if (sessionRef.current?.id === sessionPk) setProjectSettings(c) })
      setPermissionsByPk(prev => {
        const list = prev.get(sessionPk)
        if (list === undefined) return prev
        const next = new Map(prev)
        next.set(sessionPk, list.filter(r => r.id !== id))
        return next
      })
    },
    []
  )

  useEffect(() => {
    if (sessionPk === null) return
    let alive = true
    void api.chatMode(sessionPk).then(m => { if (alive) setChatMode(m) })
    return () => { alive = false }
  }, [sessionPk])
  const changeChatMode = useCallback((mode: string): void => {
    if (sessionPk === null) return
    setChatMode(mode)
    void api.setChatMode(sessionPk, mode)
  }, [sessionPk])

  const renameChat = (title: string): void => {
    if (session === null) return
    const pk = session.id
    const name = title.trim()
    void api.renameChat(pk, name).then(async () => {
      setSession(s => (s !== null && s.id === pk ? { ...s, title: name } : s))
      if (projectIdRef.current !== null) setSessions(await api.listSessions(projectIdRef.current))
    })
  }
  const forkChat = (): void => {
    if (session === null) return
    void api.forkChat(session.id).then(async r => {
      if (!r.ok) { setTerminalNotice(r.error); return }
      if (projectIdRef.current !== null) setSessions(await api.listSessions(projectIdRef.current))
      refreshNavRef.current()
      await openSession(r.session)
    })
  }
  const renameChatRef = useRef(renameChat)
  renameChatRef.current = renameChat
  const forkChatRef = useRef(forkChat)
  forkChatRef.current = forkChat

  const syncChat = useSyncChat(session?.id ?? null)
  const syncStatus = useSyncStatus()
  const syncOfferNotice = useSyncOffer(syncStatus)
  const syncStates = useMemo(() => {
    const states = new Map<number, ProjectSyncState>()
    if (syncStatus === null) return states
    for (const c of channels) {
      const state = projectSyncState(syncStatus, c)
      if (state !== null) states.set(c.id, state)
    }
    return states
  }, [syncStatus, channels])
  const [startingSync, setStartingSync] = useState<{ workingDir: string; name: string } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const onSyncProject = (state: ProjectSyncState): void => {
    if (state.kind === 'setup') { setSettingsSection('sync'); setSettingsOpen(true) }
    else if (state.kind === 'off') setStartingSync({ workingDir: state.workingDir, name: state.name })
    else void api.syncDisableProject(state.projectId).then(r => { if (!r.ok) setSyncError(r.error) })
  }
  const onSendRef = useRef<(text: string, images: ComposerImage[], pastedTexts: PastedTextChip[], uuid?: string) => void>(() => {})
  const checkingSyncRef = useRef(new Map<number, { text: string; images: ComposerImage[]; cancelled: boolean }>())
  const [syncHeld, setSyncHeld] = useState<(() => void) | null>(null)

  /** `/mcp`, as the terminal does it: the servers, or reconnect / turn on / turn off right away.
   *  Only state setters are used, so it's safe to call from onSend without being a dependency. */
  const runMcpCommand = async (pk: number, cmd: McpCommand): Promise<void> => {
    if (cmd.action === 'open') { setSettingsSection('mcp'); setSettingsOpen(true); return }
    const servers = await api.mcpStatus(pk).catch(() => null)
    if (servers === null) { setTerminalNotice('This chat has no process running yet. Send a message first, then try again.'); return }
    const want = cmd.target.toLowerCase()
    const fits = (s: McpServerStatus): boolean => cmd.action === 'enable' ? s.status === 'disabled' : s.status !== 'disabled'
    const targets = want === 'all' ? servers.filter(fits) : servers.filter(s => s.name.toLowerCase() === want)
    if (targets.length === 0) {
      setTerminalNotice(want === 'all' ? `No MCP servers to ${cmd.action === 'enable' ? 'turn on' : cmd.action === 'disable' ? 'turn off' : 'reconnect'}.` : `There's no MCP server called "${cmd.target}" in this chat.`)
      return
    }
    const failed: string[] = []
    for (const s of targets) {
      const r = cmd.action === 'reconnect' ? await api.mcpReconnect(pk, s.name) : await api.mcpToggle(pk, s.name, cmd.action === 'enable')
      if (!r.ok) failed.push(`${s.name}: ${r.error}`)
    }
    const done = targets.length - failed.length
    const verb = cmd.action === 'reconnect' ? 'Reconnected' : cmd.action === 'enable' ? 'Turned on' : 'Turned off'
    const names = done === 1 && failed.length === 0 ? targets[0]!.name : `${done} MCP server${done === 1 ? '' : 's'}`
    if (failed.length === 0) { setGoodNotice(`${verb} ${names}.`); setTerminalNotice(`${verb} ${names}.`) }
    else setTerminalNotice(`${done > 0 ? `${verb} ${done}. ` : ''}Couldn't with ${failed.join('; ')}`)
  }

  /** Terminal commands Delegatto answers itself (see appCommandOf), with the screen or
   *  action that does the same job here. Called through a ref: onSend is memoized, and
   *  this reads the chat's current state. */
  const runAppCommandRef = useRef<(pk: number, cmd: AppCommand) => void>(() => {})
  runAppCommandRef.current = (pk: number, cmd: AppCommand): void => {
    const say = (text: string, good = true): void => { if (good) setGoodNotice(text); setTerminalNotice(text) }
    switch (cmd.kind) {
      case 'settings': setSettingsSection(cmd.section); setSettingsOpen(true); return
      case 'memory': if (project !== null) setMemoryChannel(project); return
      case 'search': setSearchOpen(true); return
      case 'copy': {
        const reply = nthLatestReply(itemsRef.current, cmd.nth)
        if (reply === null) { say(cmd.nth === 1 ? 'Claude hasn’t replied in this chat yet.' : `There’s no reply ${cmd.nth} back.`, false); return }
        void navigator.clipboard.writeText(reply).then(
          () => say(cmd.nth === 1 ? 'Copied Claude’s last reply.' : `Copied the reply ${cmd.nth} back.`),
          () => say('Couldn’t copy to the clipboard.', false))
        return
      }
      case 'help': say('Type / in the message box to see every command with what it does. Commands that need Claude Code’s terminal offer to open it.'); return
      case 'plan':
        setChatMode('plan')
        void api.setChatMode(pk, 'plan').then(() => {
          if (cmd.text !== '') onSendRef.current(cmd.text, [], [])
          else say('Plan mode is on: Claude plans before making changes, and its plan shows in the chat for you to approve.')
        })
        return
      case 'usage': {
        const now = Date.now()
        const part = (label: string, w: PlanUsage['fiveHour']): string | null => {
          const cur = currentWindow(w, now)
          return cur === null ? null : `${label} ${Math.round(cur.percent)}%${cur.resetsAt !== null ? `, resets ${new Date(cur.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`
        }
        const parts = [part('5-hour', planUsage.fiveHour), part('week', planUsage.sevenDay)].filter((x): x is string => x !== null)
        const cost = session !== null ? costOfSession(session.model, session) : null
        say([parts.length > 0 ? `${planLabel(planUsage.plan)}: ${parts.join('; ')}.` : 'Plan usage shows after the next reply.',
          typeof cost === 'number' ? `This chat so far: about $${cost.toFixed(2)} at list price.` : null,
          'The chat list’s footer and the right-hand panel keep this up to date.'].filter(Boolean).join(' '))
        return
      }
      case 'status':
        void api.claudeInfo(project?.cwd ?? null).then(r => {
          const servers = mcpServers ?? []
          const connected = servers.filter(s => s.status === 'connected').length
          say([
            r.ok && r.info.version !== null ? `Claude Code ${r.info.version}` : 'Claude Code',
            planUsage.plan !== null ? planLabel(planUsage.plan) : null,
            session?.model != null ? `model ${session.model}` : null,
            `mode ${permissionModeLabel(chatMode)}`,
            project?.cwd != null ? `in ${project.cwd}` : null,
            servers.length > 0 ? `MCP ${connected} of ${servers.length} connected` : null
          ].filter(Boolean).join(' · ') + '. Account and connection details are in Claude Code’s own /status, in a terminal.')
        })
        return
      case 'hooks': setPanel('hooks'); return
      case 'diff': setPanel('diff'); return
      case 'tasks': setPanel('tasks'); return
      case 'export':
        if (cmd.fileName === '') { setPanel('export'); return }
        void api.exportChat(pk, 'file', cmd.fileName).then(r => {
          if (r.status === 'saved') say(`Saved this chat to ${r.path}`)
          else if (r.status === 'failed') say(`Couldn’t export: ${r.message}`, false)
        })
        return
      case 'pluginAction': {
        const what = cmd.args.join(' ')
        say(`Running claude plugin ${what}…`)
        void api.pluginAction(project?.cwd ?? null, cmd.args).then(r => {
          if (!r.ok) { say(`claude plugin ${what}: ${r.error}`, false); return }
          say([r.output !== '' ? r.output.split('\n').slice(-3).join(' ') : `Done: claude plugin ${what}.`, r.reloaded > 0 ? `Running chats reloaded their plugins.` : null].filter(Boolean).join(' '))
        })
        return
      }
      case 'releaseNotes': void api.openLink('https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'); return
      case 'exit': say('There’s nothing to exit here. Close the window, or pick another chat.'); return
      case 'note': say(cmd.text); return
      case 'model':
        api.setSessionOverrides(pk, { model: cmd.value })
        // The header reads the project's choice again once main has saved it.
        setTimeout(() => setHeaderRev(r => r + 1), 300)
        say(cmd.value === '' ? 'This project is back on the default model.' : `This project now uses ${cmd.value}.`)
        return
      case 'effort':
        api.setSessionOverrides(pk, { effort: cmd.value })
        setTimeout(() => setHeaderRev(r => r + 1), 300)
        say(cmd.value === '' ? 'Effort is back to the default for this project.' : `Effort is ${cmd.value} for this project.`)
        return
      case 'focus': {
        const focused = settings !== null && effectiveToolDisplay(settings.toolDisplay, projectSettings) === 'hidden' && effectiveThinkingDisplay(settings.thinkingDisplay, projectSettings) === 'hidden'
        const on = cmd.on ?? !focused
        const patch = on ? { toolDisplay: 'hidden' as const, thinkingDisplay: 'hidden' as const } : { toolDisplay: shownToolDisplay(settings?.toolDisplay ?? 'grouped'), thinkingDisplay: 'show' as const }
        void api.setProjectSettings(pk, patch).then(setProjectSettings)
        say(on ? 'Focus view: tool calls and thoughts are hidden in this project. /focus again, or Project options, brings them back.' : 'Tool calls and thoughts show again in this project.')
        return
      }
    }
  }

  const onSend = useCallback((text: string, images: ComposerImage[], pastedTexts: PastedTextChip[], uuid?: string) => {
    // Composer is only mounted while a session is open, so this is a
    // defensive no-op, not a reachable path.
    if (session === null) return
    // A synced chat: make sure this PC isn't behind before spending a turn. It only
    // asks GitHub if the last check is a few minutes old, and a chat that isn't
    // synced goes straight through.
    if (syncChat.info.synced && !syncChat.bypass.current) {
      const outgoing = buildOutgoingText(text, pastedTexts)
      const goesToClaude = (outgoing.trim().length > 0 || images.length > 0) && !isClearCommand(outgoing) && terminalOnlyCommand(outgoing) === null
      if (uuid === undefined && goesToClaude) markSending(session.id, true)
      // Nothing has gone anywhere yet, so Esc can simply call it off.
      const pk = session.id
      const pending = { text: outgoing, images, cancelled: false }
      if (uuid === undefined && goesToClaude) checkingSyncRef.current.set(pk, pending)
      void api.syncBeforeSend(session.id).then(info => {
        syncChat.setInfo(info)
        const resend = (): void => {
          if (pending.cancelled) return
          checkingSyncRef.current.delete(pk)
          syncChat.bypass.current = true
          onSendRef.current(text, images, pastedTexts, uuid)
          syncChat.bypass.current = false
        }
        if (info.conflict !== null) {
          syncChat.undismiss(info.conflict.sessionId)
          markSending(session.id, false)
          setSyncHeld(() => resend)
        } else resend()
      }).catch(() => {
        if (pending.cancelled) return
        checkingSyncRef.current.delete(pk)
        syncChat.bypass.current = true
        onSendRef.current(text, images, pastedTexts, uuid)
        syncChat.bypass.current = false
      })
      return
    }
    setFindQuery('') // the reply is what to look at now
    const combined = buildOutgoingText(text, pastedTexts)
    // Guard: an empty send (whitespace-only, no images) is a no-op.
    if (combined.trim().length === 0 && images.length === 0) return
    // Answered on the side, without touching the conversation or waiting for a turn.
    const side = sideQuestionOf(combined)
    if (side !== null) {
      const pk = session.id
      setSideQuestion({ question: side, answer: null, error: null })
      void api.sideQuestion(pk, side).then(r => setSideQuestion(r.ok ? { question: side, answer: r.answer, error: null } : { question: side, answer: null, error: r.error }))
      return
    }
    const newName = renameCommandOf(combined)
    if (newName !== null) { renameChatRef.current(newName); return }
    const addDir = addDirCommandOf(combined)
    if (addDir !== null) {
      const pk = session.id
      void api.addProjectDir(pk, addDir === '' ? null : addDir).then(r => {
        if (!r.ok) { setTerminalNotice(r.error); return }
        if (r.added === null) return
        setProjectSettings(r.settings)
        const note = `Claude can use ${r.added} in this project from your next message.`
        setGoodNotice(note)
        setTerminalNotice(note)
      })
      return
    }
    const mcp = mcpCommandOf(combined)
    if (mcp !== null) { void runMcpCommand(session.id, mcp); return }
    const appCommand = appCommandOf(combined)
    if (appCommand !== null && images.length === 0) { runAppCommandRef.current(session.id, appCommand); return }
    if (isForkCommand(combined)) { forkChatRef.current(); return }
    if (isRewindCommand(combined)) {
      if (runningRef.current) setTerminalNotice('Claude is still replying here. Press Esc to stop it, then rewind.')
      else setRewindOpen(true)
      return
    }
    // /clear would move Claude to a new session underneath this chat.
    if (isClearCommand(combined)) {
      void clearChatRef.current()
      return
    }
    // Terminal-only commands (/login, /hooks, …) can't work in headless mode:
    // offer to open the chat in a real Claude Code terminal instead.
    const command = terminalOnlyCommand(combined)
    if (command !== null && !bypassTerminalCheck.current) {
      setTerminalPrompt({ command, text: combined, images })
      return
    }
    bypassTerminalCheck.current = false
    setTerminalPrompt(null)
    setRunning(true)
    // Sending is an explicit "I'm caught up" gesture: jump the transcript to the
    // absolute bottom even if the user had scrolled up, and re-arm follow mode so
    // the reply streams in pinned to the bottom.
    atBottomRef.current = true
    setScrollToBottomTick(t => t + 1)
    // A new turn starts here -- invalidate any onIndexed reload for this
    // session that's still in flight (see reloadGenRef's own comment above):
    // it captured the PRE-bump generation, so shouldApplyReload will see it
    // as stale and bail rather than wholesale-replacing `items` out from
    // under this turn's own live rows.
    reloadGenRef.current++
    lastSentRef.current = combined
    // Every message is named, so one stopped before any reply can be taken back.
    const ownId = uuid === undefined ? crypto.randomUUID() : undefined
    composeStore.noteSent(session.id, combined, images, uuid, ownId)
    // A message for Claude's next step shows in the queue instead.
    if (uuid === undefined) markSending(session.id, true)
    api.send(session.id, combined, images.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })), uuid ?? ownId)
  }, [session, syncChat.info.synced, markSending])
  onSendRef.current = onSend

  // "Open in terminal" (header button, or the prompt for terminal-only
  // commands): hands the chat to the interactive Claude Code; the lock monitor
  // then keeps it read-only here until that terminal exits.
  const [terminalPrompt, setTerminalPrompt] = useState<{ command: string; text: string; images: ComposerImage[] } | null>(null)
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null)
  /** The notice that's good news, so it doesn't read as an error. */
  const [goodNotice, setGoodNotice] = useState<string | null>(null)
  const bypassTerminalCheck = useRef(false)
  useEffect(() => { setTerminalPrompt(null); setTerminalNotice(null) }, [session?.id])
  // Declared after the line above, so a notice that waited for this chat outlasts opening it.
  const waitingNotice = useSyncExternalStore(composeStore.subscribe, () => session === null ? null : composeStore.get(session.id).notice ?? null)
  useEffect(() => {
    if (waitingNotice === null || session === null) return
    composeStore.update(session.id, s => ({ ...s, notice: null }))
    setTerminalNotice(waitingNotice)
  }, [waitingNotice, session])
  const openChatInTerminal = useCallback(() => {
    if (session === null) return
    setTerminalNotice(null)
    void api.openInTerminal(session.id).then(r => {
      if (r.ok) setTerminalPrompt(null)
      else if (r.cancelled !== true) setTerminalNotice(r.error)
    })
  }, [session])

  const onInterrupt = useCallback(() => {
    if (session === null) return
    composeStore.beginCancel(session.id)
    api.interrupt(session.id)
  }, [session])

  // Esc while a message is still waiting on the sync check: it comes straight back.
  const onCancelSending = useCallback((): boolean => {
    if (session === null) return false
    const pending = checkingSyncRef.current.get(session.id)
    if (pending === undefined) return false
    pending.cancelled = true
    checkingSyncRef.current.delete(session.id)
    setSyncHeld(null)
    markSending(session.id, false)
    composeStore.returnMessage(session.id, pending)
    return true
  }, [session, markSending])

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
      setSession(null); setItems([]); setOldestSeq(null); setHasMore(false)
      if (target.scope !== 'chat') { setProject(null); setSessions([]) }
      else {
        // The open chat went: on to the project's next newest, if it has one.
        const pid = projectIdRef.current, reqId = sessionReqId.current
        if (pid !== null) {
          void api.listSessions(pid).then(list => {
            if (!isStaleResponse(reqId, sessionReqId.current) && list[0] !== undefined) void openSessionRef.current(list[0])
          })
        }
      }
    }
    setManageEpoch(e => e + 1)
    refreshNavRef.current()
  }, [])

  // Manage screen (port of ClaudeMemoryTool): replaces the chat list + pane
  // while open. Its Delete… reuses the wizard above; `manageEpoch` tells it to
  // rescan after the wizard removed something.
  const [manageOpen, setManageOpen] = useState(false)
  // Ctrl+F searches the open project, unless something is open on top of it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return
      e.preventDefault()
      if (settingsOpen || manageOpen || searchOpen) return
      findInputRef.current?.focus()
      findInputRef.current?.select()
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
        setSession(null); setItems([]); setOldestSeq(null); setHasMore(false); setProject(null); setSessions([])
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
  }, [])

  // Optimistic group rename (renameGroup IPC already existed; this just wires
  // it to the context menu). Updates the nav's section title immediately.
  const onRenameGroup = useCallback((groupId: number, name: string) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, name: trimmed } : g)))
    void api.renameGroup(groupId, trimmed)
  }, [])

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

  return (
    <div className="shell" data-density={settings?.density ?? 'comfortable'} data-nav-density={settings?.navDensity ?? 'comfortable'}>
      <TextMenuHost pinned={pinnedUuids} onPin={pinOpenMessage} onUnpin={unpinOpenMessage} />
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
          <Nav onShowInExplorer={c => { void api.showProjectFolder(c.id).then(r => { if (!r.ok) setTerminalNotice(r.error) }) }}
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
      <OpenSubagentContext.Provider value={setSubagentOpen}>
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
        <header className="chead">
          <div className="chead-main">
            <div className="chead-title-row">
              <h1>{project === null ? 'Delegatto' : resolveChannelName(project.meta, project.cwd, project.dirName)}</h1>
              {session !== null && <LiveIndicator running={running} queuedCount={queuedCount} />}
              {session !== null && mcpServers !== null && (
                <McpChip sessionPk={session.id} cwd={project?.cwd ?? null} servers={mcpServers}
                  ignored={settings?.mcpWarnIgnore ?? []} onServers={setMcpServers}
                  onIgnore={name => { void api.updateSettings({ mcpWarnIgnore: [...(settings?.mcpWarnIgnore ?? []), name] }).then(setSettings) }}
                  onOpenSettings={() => { setSettingsSection('mcp'); setSettingsOpen(true) }} />
              )}
              {session !== null && remoteSessions.has(session.id) && (
                <span className="rc-tag" title="Remote Control on — this chat can be driven from claude.ai or the Claude app">
                  <RemoteBadge className="rc-badge-inline" />Remote Control
                </span>
              )}
            </div>
            <div className="path">{project?.cwd ?? `${channels.length} projects indexed`}</div>
          </div>
          {session !== null && <ProjectSearchBox ref={findInputRef} value={findQuery} onChange={setFindQuery} />}
          {session !== null && channels.find(c => c.id === project?.id)?.archived !== true && (
            <OpenInTerminalButton running={running} onOpen={openChatInTerminal} />
          )}
          {session !== null && settings !== null && project !== null && (
            <ProjectOptions settings={settings} chat={projectSettings}
              onChange={patch => { void api.setProjectSettings(session.id, patch).then(setProjectSettings) }}
              onOpenSettings={() => { setSettingsSection('appearance'); setSettingsOpen(true) }}
              session={session} sessions={sessions} onOpenChat={s => void openSession(s)} onFork={forkChat}
              summary={`${permissionModeLabel(chatMode)} · ${liveModel ?? session.model ?? 'Default model'}`}
              sync={syncStates.get(project.id) ?? null} onSync={onSyncProject}>
              <ChatHeaderControls key={`${session.id}-${headerRev}`} session={session} liveModel={liveModel} mode={chatMode} onChangeMode={changeChatMode} />
            </ProjectOptions>
          )}
          {(manageOpen || !(settings?.showContextRail ?? true)) && <UpdateIcon />}
        </header>
        {session !== null && <SyncChatBanner info={syncChat.info} onOpenSettings={() => { setSettingsSection('sync'); setSettingsOpen(true) }} />}
        {session === null
          ? <EmptyPane project={project === null ? undefined : channels.find(c => c.id === project.id)} onNewChat={() => { setNewChatCwd(project?.cwd ?? null); setNewChatOpen(true) }} />
          // Keyed on the session id: forces a fresh Transcript instance (and
          // fresh internal scroll/height refs) per session, so the scroll-
          // preservation math never mixes geometry from a previously open
          // session into the next one's first paint.
          // Passed by reference (not wrapped in a new arrow) so its identity
          // stays stable across renders, matching loadOlder's own useCallback
          // stability -- see Finding 5 in the fix-pass report.
          // Key is prefixed and distinct from the Composer's below: both are
          // direct children of <main> and both remount per session, but two
          // siblings sharing the same key value (session.id) is a duplicate-key
          // collision — React then fails to unmount the previous Transcript on a
          // session switch, stacking a new .stream under the stale one (each
          // switch leaked one, splitting the chat into 50/50 scroll boxes).
          : <><div style={{ display: findTerms === '' ? 'contents' : 'none' }}><Transcript key={`transcript-${session.id}`} items={items} hasMore={hasMore} loadingOlder={loadingOlder}
              loading={sessionLoading} onReachTop={loadOlder} livePreview={livePreview} liveThinking={showThinking ? liveThinking : null} showThinking={showThinking} sending={sendingPks.has(session.id)} savedTextOnly={savedTextOnly}
              showToolCalls={toolDisplay !== 'hidden'} groupToolCalls={toolDisplay === 'grouped'} fileMissing={transcriptFileMissing}
              claudeIcon={settings?.claudeIcon ?? { kind: 'initials' }}
              thinkingExpanded={settings?.thinkingExpanded ?? false}
              toolCardsExpanded={settings?.toolCardsExpanded ?? false}
              pendingToolIds={pendingToolIds}
              jumpTo={jumpTarget !== null && jumpTarget.sessionPk === session.id && oldestSeq !== null && oldestSeq <= jumpTarget.seq ? jumpTarget.uuid : null}
              onJumped={() => setJumpTarget(null)}
              onAtBottomChange={v => {
                atBottomRef.current = v
                const held = heldReloadRef.current
                if (v && held !== null) { heldReloadRef.current = null; held() }
              }}
              scrollToBottomSignal={scrollToBottomTick}
              permissionRequests={permissionsByPk.get(session.id) ?? []}
              elicitations={elicitations.get(session.id) ?? []}
              onAnswerElicitation={(requestId, answer) => {
                setChatElicitations(session.id, list => list.filter(r => r.requestId !== requestId))
                void api.answerElicitation(session.id, requestId, answer)
              }}
              onOpenLink={url => { void api.openLink(url) }}
              onResolvePermission={(id, decision, editedInput, denyMessage) =>
                onResolvePermission(session.id, id, decision, editedInput, denyMessage)} /></div>
              {findTerms !== '' && (
                <ProjectSearchResults query={findQuery} result={findResult} loading={findLoading} currentSessionPk={session.id}
                  claudeIcon={settings?.claudeIcon ?? { kind: 'initials' }}
                  onJump={hit => {
                    setFindQuery('')
                    setJumpTarget({ sessionPk: hit.sessionPk, uuid: hit.uuid, seq: hit.seq })
                    if (hit.sessionPk !== session.id && project !== null) {
                      jumpPendingRef.current = true
                      void openSearchResult(hit.sessionPk, project.dirName)
                    }
                  }} />
              )}
            </>}
        {session !== null && (terminalPrompt !== null || terminalNotice !== null) && (
          <div className="term-prompt" role="status">
            {terminalPrompt !== null ? (
              <>
                <span><code>{terminalPrompt.command}</code> only works in Claude Code's terminal. Open this chat there? It continues right where it is, and Delegatto shows its replies.</span>
                <span className="term-prompt-actions">
                  <button type="button" className="btn-primary" onClick={openChatInTerminal}>Open in terminal</button>
                  <button type="button" className="btn-secondary" onClick={() => { bypassTerminalCheck.current = true; onSend(terminalPrompt.text, terminalPrompt.images, []) }}>Send anyway</button>
                  <button type="button" className="term-prompt-x" aria-label="Dismiss" onClick={() => setTerminalPrompt(null)}>✕</button>
                </span>
              </>
            ) : null}
            {terminalNotice !== null && (
              <span className={terminalNotice === goodNotice ? 'term-prompt-good' : 'term-prompt-error'}><TextWithLinks text={terminalNotice} />
                <button type="button" className="term-prompt-x" aria-label="Dismiss" onClick={() => setTerminalNotice(null)}>✕</button>
              </span>
            )}
          </div>
        )}
        {session !== null && running && (
          <WorkingLine startedAt={turnStartedAt} tokens={turnTokens} status={liveStatus} pending={pending} lastActivity={lastEventAt}
            waitingOnYou={(permissionsByPk.get(session.id)?.length ?? 0) > 0 || (elicitations.get(session.id)?.length ?? 0) > 0} activity={liveActivity} />
        )}
        {session !== null && <SubagentsLive runs={agentRunsByPk.get(session.id) ?? NO_AGENT_RUNS} onView={setSubagentOpen} />}
        {session !== null && <BackgroundTasksLine tasks={backgroundTasks} running={running} onStop={id => { void api.stopTask(session.id, id) }} onShowOutput={(id, title) => setTaskOutputOpen({ id, title })} />}
        {session !== null && panel === 'hooks' && <HooksDialog sessionPk={session.id} onClose={closePanel} />}
        {session !== null && panel === 'diff' && <DiffDialog sessionPk={session.id} onClose={closePanel} />}
        {session !== null && panel === 'tasks' && <TasksDialog tasks={backgroundTasks} onStop={id => { void api.stopTask(session.id, id) }} onShowOutput={(id, title) => { setPanel(null); setTaskOutputOpen({ id, title }) }} onClose={closePanel} />}
        {session !== null && panel === 'export' && <ExportDialog sessionPk={session.id} onClose={closePanel}
          onDone={(text, good) => { setPanel(null); if (good) setGoodNotice(text); setTerminalNotice(text) }} />}
        {session !== null && taskOutputOpen !== null && <TaskOutputDialog sessionPk={session.id} taskId={taskOutputOpen.id} title={taskOutputOpen.title} onClose={closeTaskOutput} />}
        {session !== null && rewindOpen && (
          <RewindDialog sessionPk={session.id} onClose={closeRewind} onDone={r => {
            const pk = session.id
            setRewindOpen(false)
            if (r.mode === 'code') {
              const note = 'Files restored. The conversation is unchanged.'
              setGoodNotice(note)
              setTerminalNotice(note)
              return
            }
            setItems(prev => dropCancelledMessage(prev, r.uuid))
            if (r.prefill !== null && r.prefill.length > 0) composeStore.returnMessage(pk, { text: r.prefill, images: [] })
          }} />
        )}
        {session !== null && <ShellRuns runs={shellRuns} />}
        {sideQuestion !== null && (
          // Keyed on the question, so a new one starts open however the last was left.
          <details key={sideQuestion.question} className={`tool side-question${sideQuestion.error !== null ? ' err' : ''}`} role="status" open>
            <summary>
              <span className="caret" aria-hidden="true">▸</span>
              <span className="nm">/btw</span>
              <span className="tool-args" title={sideQuestion.question}>{sideQuestion.question}</span>
              <span className="meta">{sideQuestion.error !== null ? 'error' : sideQuestion.answer === null ? 'asking…' : `${sideQuestion.answer.length} chars`}</span>
              <button type="button" className="update-bar-x" aria-label="Close" onClick={e => { e.preventDefault(); setSideQuestion(null) }}>✕</button>
            </summary>
            <div className="side-question-a">{sideQuestion.error ?? sideQuestion.answer ?? 'Asking…'}</div>
          </details>
        )}
        {subagentOpen !== null && <SubagentViewer toolUseId={subagentOpen} onClose={closeSubagent} />}
        {session !== null && channels.find(c => c.id === project?.id)?.archived === true && (
          <div className="composer composer-archived" role="status">
            This project's folder no longer exists{project?.cwd ? ` (${project.cwd})` : ''}, so this chat is read-only.
          </div>
        )}
        {session !== null && channels.find(c => c.id === project?.id)?.archived !== true && (
          // Keyed on the session id (same reasoning as Transcript above): a
          // fresh Composer instance per session, so nothing bleeds from one
          // session into another. What's in progress survives the switch: text
          // via draftsRef, chips and the queue in composeStore.
          <Composer key={`composer-${session.id}`} sessionPk={session.id} running={running} settled={settledPk === session.id} shellStops={shellStops} onCycleMode={() => { const next = nextPermissionMode(chatMode); changeChatMode(next); return permissionModeLabel(next) }} lock={externalLock} cwd={project?.cwd ?? null} suggestion={suggestion}
            onShellCommand={command => { void api.shellRun(session.id, command) }}
            onHijack={async () => {
              const r = await api.hijackChat(session.id)
              if (!r.ok) return r.error
              setExternalLock(await api.getLock(session.id))
              return null
            }}
            initialDraft={draftsRef.current.get(session.id) ?? ''}
            onDraftChange={text => {
              draftsRef.current.set(session.id, text)
              refreshUpdateHold()
            }}
            onSend={onSend} onSubmit={() => setTerminalNotice(null)} onInterrupt={onInterrupt} onRewind={() => setRewindOpen(true)} onCancelSending={onCancelSending} onQueueLengthChange={setQueuedCount} />
        )}
      </main>
      </OpenSubagentContext.Provider>
      {!manageOpen && (settings?.showContextRail ?? true) && (
        railExpanded
          ? <ContextRail session={session} fsEntries={fsEntries}
              hasKey={(settings?.openRouterKey ?? '').trim().length > 0}
              canCreateImage={typeof project?.cwd === 'string' && project.cwd.length > 0}
              onCreateImage={() => setCreateImageOpen(true)}
              onCollapse={() => toggleFiles(false)} context={context}
              view={railView} onView={setRailView} pins={pins} openChatId={session?.id ?? null}
              onJumpToPin={pin => {
                setFindQuery('')
                setJumpTarget({ sessionPk: pin.sessionPk, uuid: pin.uuid, seq: pin.seq })
                if (pin.sessionPk !== session?.id && project !== null) {
                  jumpPendingRef.current = true
                  void openSearchResult(pin.sessionPk, project.dirName)
                }
              }}
              onUnpin={pin => { void api.unpinMessage(pin.sessionPk, pin.uuid).then(refreshPins) }}
              onCompact={session !== null && !running && externalLock === null ? () => onSend('/compact', [], []) : undefined} />
          : <ContextRailStrip fsEntries={fsEntries} view={railView} pinCount={pins.length} onExpand={() => toggleFiles(true)}
              onOpenView={v => { setRailView(v); toggleFiles(true) }} />
      )}
      {createImageOpen && typeof project?.cwd === 'string' && project.cwd.length > 0 && (
        <CreateImageDialog cwd={project.cwd} onClose={() => setCreateImageOpen(false)}
          onSaved={() => { const c = project?.cwd; if (c) void api.fsTree(c).then(setFsEntries).catch(() => {}) }} />
      )}
      {deleteTarget !== null && (
        <DeleteWizard target={deleteTarget} onClose={() => setDeleteTarget(null)}
          onDeleted={() => onDeleted(deleteTarget)} />
      )}
      {startingSync !== null && (
        <StartProjectSync workingDir={startingSync.workingDir} name={startingSync.name} encrypted={syncStatus?.encrypted ?? true}
          onClose={() => setStartingSync(null)} />
      )}
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
