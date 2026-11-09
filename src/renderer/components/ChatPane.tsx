import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import type { ChannelRow, SessionSummary, RenderItem } from '../../shared/types'
import { FOLDER_MISSING, type BackgroundTask, type ExternalLock } from '../../shared/engine-types'
import { currentWindow, planLabel, type PlanUsage } from '../../shared/plan-usage'
import { costOfSession } from '../../shared/models'
import { ContextRail, ContextRailStrip } from './ContextRail'
import { Transcript } from './Transcript'
import { Composer } from './Composer'
import { composeStore } from '../compose-store'
import { OpenSubagentContext, SubagentViewer } from './SubagentViewer'
import { LiveIndicator } from './LiveIndicator'
import { ChatHeaderControls } from './ChatHeaderControls'
import type { SettingsSection } from './SettingsWindow'
import { SyncChatBanner, type useSyncChat } from './SyncChat'
import type { ProjectSyncState } from '../../shared/sync-types'
import { RemoteBadge } from './RemoteBadge'
import { isSignedOutError } from '../../shared/login-types'
import { UpdateIcon } from './UpdatesPanel'
import { TextWithLinks } from './Markdown'
import type { DeleteTarget } from '../../shared/manage-types'
import { McpChip } from './McpChip'
import { ProjectOptions } from './ProjectOptions'
import { OpenInTerminalButton } from './OpenInTerminalButton'
import { SplitLauncher } from './SplitLauncher'
import { DialogTarget } from './DialogHost'
import { effectiveThinkingDisplay, effectiveToolDisplay, shownToolDisplay, type ProjectSettings, type ContextUsage } from '../../shared/project-options'
import { ShellRuns } from './ShellRuns'
import { WorkingLine, BackgroundTasksLine, SubagentsLive } from './WorkingLine'
import { RewindDialog } from './RewindDialog'
import { TaskOutputDialog } from './TaskOutputDialog'
import { DiffDialog, ExportDialog, HooksDialog, TasksDialog } from './CommandPanels'
import { ProjectSearchBox, ProjectSearchResults } from './ProjectSearch'
import type { ProjectSearchResult } from '../../shared/project-search'
import type { ShellRun } from '../../shared/shell-run-types'
import type { McpServerStatus } from '../../shared/claude-info-types'
import { NO_AGENT_RUNS, type AppData, type PermissionDecision } from '../app-data'
import { readStoredBool, type ProjectRail } from '../project-rail'
import { paneBus } from '../pane-bus'
import {
  resolveChannelName, isStaleResponse, buildOutgoingText, terminalOnlyCommand, isClearCommand, reduceLivePreview, appendRowsToItems, retryLabel, nextPermissionMode, permissionModeLabel, isRewindCommand, spawnErrorNotice, sideQuestionOf, renameCommandOf, addDirCommandOf, mcpCommandOf, type McpCommand, appCommandOf, type AppCommand, nthLatestReply, isForkCommand,
  renderItemsFromStreamedRows, applyStreamedToolResults, pendingTools, shouldApplyReload, clearsRunning, hasAssistantRenderItem, suppressSealedPreview, mergeReloadedPage, dropCancelledMessage,
  type ComposerImage, type PastedTextChip, type LivePreview
} from '../lib'

const NO_ITEMS: RenderItem[] = []

/** What a chat asks of the window around it: the app-wide screens and dialogs. */
export type AppActions = {
  openSettings(section?: SettingsSection): void
  openSearch(): void
  openMemory(project: ChannelRow): void
  openNewChat(cwd: string | null): void
  deleteChat(target: DeleteTarget): void
  /** Sets up, turns on or turns off sync for a project, by its state in the chat list. */
  syncProject(state: ProjectSyncState): void
  signIn(reason: 'expired' | 'asked'): void
  /** `/clear`: a new chat in the same folder, which the window opens. Answers an error to show. */
  clearChat(sessionPk: number): Promise<string | null>
}

/** Sync for the chat on screen. The window owns it, so a conflict shows once whichever chat
 *  sent the message, along with the message it holds back. */
export type PaneSync = {
  chat: ReturnType<typeof useSyncChat>
  /** `message` is what `resend` would send, for a window with no conflict dialog of its own. */
  holdMessage(resend: (() => void) | null, message?: { text: string; images: ComposerImage[] }): void
}

/** What the window calls on the pane directly.
 *
 *  Changing the `session` prop is enough to show another chat: before the next paint the
 *  pane sees a chat it hasn't loaded and opens it itself (reset, then load, with the same
 *  guards). `openSession` is for doing that in the same update as the prop change, so the
 *  old chat's state is never rendered with the new one, and for opening the same chat
 *  again, which reloads it. A window that calls it also changes the prop; the pane loads
 *  once. */
export type ChatPaneHandle = {
  /** Shows a chat in the pane, or the same chat again, which reloads it. */
  openSession(next: SessionSummary): Promise<void>
  /** The window is moving to another chat it hasn't picked yet (a project click, a search
   *  result): whatever the pane is still loading is dropped rather than shown meanwhile. */
  supersede(): void
  /** Ctrl+F: the find box above the chat. */
  focusFind(): void
}

type ChatPaneProps = {
  ref?: Ref<ChatPaneHandle>
  /** The chat shown. The window keeps it, since its nav footer and chat list read it too. */
  session: SessionSummary
  project: ChannelRow
  /** The project's chats, for Project options' list. */
  sessions: SessionSummary[]
  data: AppData
  rail: ProjectRail
  sync: PaneSync
  /** Where the rail goes: the main window keeps it at the right edge, outside the chat column.
   *  No slot, no rail. */
  railSlot: HTMLElement | null
  /** Something else has the chat's place (Manage), so the rail goes too. */
  hidden: boolean
  /** 'split' hides the context rail by default and uses the compact header. The split window
   *  uses it; the main window passes 'main' and nothing changes. */
  variant: 'main' | 'split'
  /** The pane keyboard shortcuts act on. Always true in the main window. */
  focused: boolean
  /** The user clicked or typed in the pane. Split variant only. */
  onFocus(): void
  /** Split variant: what the compact header shows before its own controls (the project and
   *  chat picker) and after them (the pane's buttons). The main header ignores them. */
  headerStart?: ReactNode
  headerEnd?: ReactNode
  /** Split variant: the pane's box for its own dialogs, so they cover this pane only. Without
   *  one they go to the page. */
  dialogSlot?: HTMLElement | null
  /** In-pane navigation to another chat: find and pin jumps. */
  onOpenSession(sessionPk: number, projectDir: string): void
  /** Fork and Project options' chat list, which already have the chat's summary. */
  onOpenChat(session: SessionSummary): void
  /** The chat's summary changed: token totals after a sync, a rename. */
  onSessionUpdated(sessionPk: number, change: (s: SessionSummary) => SessionSummary): void
  /** Rename and fork refresh the Blade list; a reload brings its own list. */
  onSessionsChanged(list?: SessionSummary[]): Promise<void>
  /** The chat the pane mounted with has had its first load (or was superseded), or that
   *  load failed (`error`). Without it a failure is logged here. */
  onMountOpened?(error?: unknown): void
  app: AppActions
}

/** One open chat: its header, transcript, live turn, composer and rail. The main window shows
 *  one; it stays mounted while the user moves between chats, and opening a chat resets what
 *  belongs to the last one (see openSession). */
export function ChatPane({ ref, session, project, sessions, data, rail, sync, railSlot, hidden, variant, focused, onFocus, headerStart, headerEnd, dialogSlot, onOpenSession, onOpenChat, onSessionUpdated, onSessionsChanged, onMountOpened, app }: ChatPaneProps) {
  const split = variant === 'split'
  const { settings, setSettings, channels, planUsage, incoming, remote, syncStates, permissionsByPk, elicitations, setChatElicitations, sendingPks, markSending, agentRunsByPk, draftsRef, refreshUpdateHold } = data
  const refreshNavRef = useRef(data.refreshNav)
  refreshNavRef.current = data.refreshNav
  const syncChat = sync.chat
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
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
  const [items, setItems] = useState<RenderItem[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [oldestSeq, setOldestSeq] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  // Starts true: the pane mounts with a chat and opens it straight away (see the end of the
  // pane), so its first paint is the same as openSession's.
  const [sessionLoading, setSessionLoading] = useState(true)
  // True when the open session's JSONL was removed from disk (Claude Code's
  // cleanupPeriodDays) but the catalog still has it -- drives an "archived"
  // transcript message instead of "no messages".
  const [transcriptFileMissing, setTranscriptFileMissing] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
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
  const [savedTextOnly, setSavedTextOnly] = useState(false)
  const lastSentRef = useRef('')
  const [subagentOpen, setSubagentOpen] = useState<string | null>(null)
  const [liveThinking, setLiveThinking] = useState<string | null>(null)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [taskOutputOpen, setTaskOutputOpen] = useState<{ id: string; title: string } | null>(null)
  /** The screen a terminal command opened: /hooks, /diff, /tasks or /export. */
  const [panel, setPanel] = useState<'hooks' | 'diff' | 'tasks' | 'export' | null>(null)
  const closePanel = useCallback((): void => setPanel(null), [])
  const closeSubagent = useCallback((): void => setSubagentOpen(null), [])
  const closeRewind = useCallback((): void => setRewindOpen(false), [])
  const closeTaskOutput = useCallback((): void => setTaskOutputOpen(null), [])
  // A `/btw` question, and its answer once it comes.
  const [sideQuestion, setSideQuestion] = useState<{ question: string; answer: string | null; error: string | null } | null>(null)
  const [chatMode, setChatMode] = useState('default')
  const [liveActivity, setLiveActivity] = useState<string | null>(null)
  const [shellStops, setShellStops] = useState(0)
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
  // The open chat getting messages from another PC: it can't be written to until they're
  // in, and then it reloads to show them.
  const syncingIn = incoming.find(i => i.sessionId.toLowerCase() === session.sessionId.toLowerCase()) ?? null
  const wasSyncingIn = useRef<string | null>(null)
  useEffect(() => {
    const now = syncingIn === null ? null : syncingIn.sessionId
    if (wasSyncingIn.current !== null && now === null && session.sessionId.toLowerCase() === wasSyncingIn.current.toLowerCase()) {
      api.appLog(`incoming done for the open chat ${session.sessionId.slice(0, 8)}: reopening it`)
      void openSessionRef.current(session)
      refreshNavRef.current()
    }
    wasSyncingIn.current = now
  }, [syncingIn?.sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo(() => pendingTools(items, running), [items, running])
  const pendingToolIds = useMemo(() => new Set(pending.map(p => p.toolUseId)), [pending])
  const remoteSessions = useMemo(() => new Set(remote.map(r => r.sessionPk)), [remote])
  // The window's open project, mirrored into a ref for the listeners below, which are
  // registered per chat and must not re-subscribe on every project change.
  const projectIdRef = useRef<number | null>(project.id)
  useEffect(() => { projectIdRef.current = project.id }, [project])
  // The chat on screen, for answers that arrive after the user may have moved on.
  const sessionPkRef = useRef(session.id)
  useEffect(() => { sessionPkRef.current = session.id }, [session])
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

  // Guards two independent races the naive version misses:
  //  - clicking channels/sessions faster than their fetches resolve, which
  //    would otherwise let a stale response overwrite a newer selection
  //  - loadOlder firing twice before the first call resolves (fast repeated
  //    scroll or the auto-load-if-too-short effect racing a manual scroll),
  //    which would otherwise double-fetch and duplicate-prepend a page
  // sessionReqId is bumped synchronously on every openSession call (the
  // window keeps its own counter for project clicks); loadingOlderRef is a ref
  // (not state) so the check is synchronous and not subject to React's
  // state-update batching.
  const sessionReqId = useRef(0)
  const loadingOlderRef = useRef(false)
  // Task 10 fix pass 2: guards the onIndexed reload effect below against a
  // back-to-back QUEUED turn on the SAME still-open session. Composer drains
  // its queue the instant turn A's `result` flips `running` false, calling
  // the pane's onSend -- which bumps this ref -- to dispatch turn B immediately.
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
  // The chat the pane's state belongs to, set the moment openSession starts. A `session`
  // prop that differs is a chat the pane hasn't opened yet (see ChatPaneHandle).
  const loadedForRef = useRef<number | null>(null)

  // Opening a session loads only the newest page; older pages arrive on scroll.
  // The window has already made `next` the pane's session; this resets what
  // belonged to the last one and loads it.
  async function openSession(next: SessionSummary) {
    const reqId = ++sessionReqId.current
    loadedForRef.current = next.id
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
      api.appLog(`open ${next.id}: ${page.items.length} items loaded${isStaleResponse(reqId, sessionReqId.current) ? ", superseded" : ""}${refreshed ? ", re-indexed first" : ""}`)
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

  // /clear: this chat stays in the history; a new one opens in the same folder.
  async function clearChat(): Promise<void> {
    const error = await app.clearChat(session.id)
    if (error !== null) setTerminalNotice(error)
  }
  const clearChatRef = useRef(clearChat)
  clearChatRef.current = clearChat

  // Wrapped in useCallback so its identity is stable across unrelated
  // re-renders: it's passed to Transcript as onReachTop, which sits in a
  // useLayoutEffect dependency array there, and a fresh function every render
  // would re-run that effect constantly. session/oldestSeq/hasMore are its
  // only reactive dependencies — sessionReqId and loadingOlderRef are refs
  // (stable identity, read via .current) and the setters are stable too.
  const loadOlder = useCallback(async (fromSeq?: number) => {
    if (oldestSeq === null || loadingOlderRef.current || !hasMore || loadedForRef.current !== session.id) return
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

  // Going to a search result: load back to it, then Transcript scrolls there.
  useEffect(() => {
    if (jumpTarget === null || session.id !== jumpTarget.sessionPk) return
    if (sessionLoading || loadingOlder || oldestSeq === null || oldestSeq <= jumpTarget.seq) return
    if (hasMore) void loadOlder(jumpTarget.seq)
    else setJumpTarget(null)
  }, [jumpTarget, session, sessionLoading, loadingOlder, oldestSeq, hasMore, loadOlder])
  // Reading a different chat by now: don't yank the view when coming back to that one.
  const openSessionId = session.id
  useEffect(() => {
    setJumpTarget(t => t !== null && t.sessionPk !== openSessionId && !jumpPendingRef.current ? null : t)
    jumpPendingRef.current = false
  }, [openSessionId])

  // Messages the window has for this chat: a message Esc took back, a notice.
  useEffect(() => paneBus.on(session.id, msg => {
    if (msg.kind === 'dropCancelled') setItems(prev => dropCancelledMessage(prev, msg.uuid))
    else setTerminalNotice(msg.text)
  }), [session.id])

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
      // An expired or missing sign-in gets the sign-in dialog rather than Claude Code's error.
      if (ev.kind === 'assistant' && ev.apiError !== undefined && (ev.apiError === 'authentication_failed' || isSignedOutError(ev.apiError))) app.signIn('expired')
      if (ev.kind === 'result' && ev.isError && isSignedOutError(ev.text)) app.signIn('expired')
      else if (ev.kind === 'result' && ev.isError) setTerminalNotice(ev.text)
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
  }, [session]) // eslint-disable-line react-hooks/exhaustive-deps

  // MCP status for the open chat. A process already running answers straight away;
  // otherwise the first turn's init event brings it. While any server is still
  // starting, ask again: nothing else would report how it turned out.
  const sessionPk = session.id
  // A search belongs to what was on screen: opening a chat goes back to reading it.
  useEffect(() => { setFindQuery('') }, [sessionPk])
  const findProjectId = project.id
  // New messages can match too, so a change in the chat searches again. Debounced, and
  // an answer to an older search is dropped.
  const findTerms = findQuery.trim()
  useEffect(() => {
    if (findTerms === '') { setFindResult(null); setFindLoading(false); return }
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
    let alive = true
    void api.backgroundTasks(sessionPk).then(t => { if (alive) setBackgroundTasks(t) })
    return () => { alive = false }
  }, [sessionPk])
  useEffect(() => {
    setMcpServers(null)
    let alive = true
    void api.mcpStatus(sessionPk).then(s => { if (alive) setMcpServers(s) })
    return () => { alive = false }
  }, [sessionPk])
  useEffect(() => {
    setShellRuns([])
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
  const setRailExpanded = rail.setExpanded
  useEffect(() => {
    setSuggestion(null)
    setLiveModel(null)
    setContext(null)
    setProjectSettings({})
    let alive = true
    void api.getProjectSettings(sessionPk).then(c => {
      if (!alive) return
      setProjectSettings(c)
      setRailExpanded(c.filesExpanded ?? readStoredBool('rail', true))
    })
    void api.contextUsage(sessionPk).then(c => { if (alive) setContext(c) })
    return () => { alive = false }
  }, [sessionPk, setRailExpanded])
  const toolDisplay = effectiveToolDisplay(settings?.toolDisplay ?? 'grouped', projectSettings)
  const showThinking = effectiveThinkingDisplay(settings?.thinkingDisplay ?? 'show', projectSettings) === 'show'
  // The Files panel is remembered per project. The last choice is also kept as the
  // starting point for projects that haven't made one.
  const toggleFiles = (open: boolean): void => {
    rail.setExpanded(open)
    window.localStorage.setItem('cc.ui.rail', open ? '1' : '0')
    void api.setProjectSettings(sessionPk, { filesExpanded: open }).then(setProjectSettings)
  }
  const mcpStarting = mcpServers?.some(s => s.status === 'pending') ?? false
  useEffect(() => {
    if (!mcpStarting) return
    const timer = setInterval(() => { void api.mcpStatus(sessionPk).then(setMcpServers) }, 4000)
    return () => clearInterval(timer)
  }, [sessionPk, mcpStarting])

  // Keeps the open chat's external-lock state current (a terminal taking it
  // over or releasing it while it's open).
  useEffect(() => {
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
          if (updated !== undefined) onSessionUpdated(sid, () => updated)
        }).catch(() => { /* keep prior */ })
      }

      // Only reconcile the TRANSCRIPT when the user is following at the bottom.
      // If they've scrolled up reading history (possibly with older pages
      // loaded), a wholesale reload to the newest page would collapse those
      // pages and jump them to the bottom -- so leave their view untouched.
      if (!atBottomRef.current) { api.appLog(`indexed ${sid}: held, not at the bottom`); heldReloadRef.current = reload; return }
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
          if (!shouldApplyReload(reqId, sessionReqId.current, gen, reloadGenRef.current)) {
            api.appLog(`indexed ${sid}: reload skipped (request ${reqId} vs ${sessionReqId.current}, turn ${gen} vs ${reloadGenRef.current})`)
            return
          }
          api.appLog(`indexed ${sid}: reloaded, ${page.items.length} items, ${itemsRef.current.length} before`)
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
            if (shouldApplyReload(reqId, sessionReqId.current, gen, reloadGenRef.current)) void onSessionsChanged(sessList)
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
  }, [session]) // eslint-disable-line react-hooks/exhaustive-deps

  // Forwards a PermissionCard/PlanApprovalCard decision (see AppData's
  // onResolvePermission), then -- for 'allow_folder' -- re-reads the project
  // options so they list the folder, and it can be taken back out from there.
  const resolvePermission = (id: string, decision: PermissionDecision, editedInput?: unknown, denyMessage?: string): void => {
    const pk = session.id
    data.onResolvePermission(pk, id, decision, editedInput, denyMessage)
    if (decision === 'allow_folder') void api.getProjectSettings(pk).then(c => { if (sessionPkRef.current === pk) setProjectSettings(c) })
  }

  useEffect(() => {
    let alive = true
    void api.chatMode(sessionPk).then(m => { if (alive) setChatMode(m) })
    return () => { alive = false }
  }, [sessionPk])
  const changeChatMode = useCallback((mode: string): void => {
    setChatMode(mode)
    void api.setChatMode(sessionPk, mode)
  }, [sessionPk])

  const renameChat = (title: string): void => {
    const pk = session.id
    const name = title.trim()
    void api.renameChat(pk, name).then(async () => {
      onSessionUpdated(pk, s => ({ ...s, title: name }))
      await onSessionsChanged()
    })
  }
  const forkChat = (): void => {
    void api.forkChat(session.id).then(async r => {
      if (!r.ok) { setTerminalNotice(r.error); return }
      await onSessionsChanged()
      refreshNavRef.current()
      onOpenChat(r.session)
    })
  }
  const renameChatRef = useRef(renameChat)
  renameChatRef.current = renameChat
  const forkChatRef = useRef(forkChat)
  forkChatRef.current = forkChat

  const onSendRef = useRef<(text: string, images: ComposerImage[], pastedTexts: PastedTextChip[], uuid?: string) => void>(() => {})
  const checkingSyncRef = useRef(new Map<number, { text: string; images: ComposerImage[]; cancelled: boolean }>())

  /** `/mcp`, as the terminal does it: the servers, or reconnect / turn on / turn off right away.
   *  Only state setters are used, so it's safe to call from onSend without being a dependency. */
  const runMcpCommand = async (pk: number, cmd: McpCommand): Promise<void> => {
    if (cmd.action === 'open') { app.openSettings('mcp'); return }
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
      case 'settings': app.openSettings(cmd.section); return
      case 'memory': app.openMemory(project); return
      case 'search': app.openSearch(); return
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
        const cost = costOfSession(session.model, session)
        say([parts.length > 0 ? `${planLabel(planUsage.plan)}: ${parts.join('; ')}.` : 'Plan usage shows after the next reply.',
          typeof cost === 'number' ? `This chat so far: about $${cost.toFixed(2)} at list price.` : null,
          'The chat list’s footer and the right-hand panel keep this up to date.'].filter(Boolean).join(' '))
        return
      }
      case 'status':
        void api.claudeInfo(project.cwd ?? null).then(r => {
          const servers = mcpServers ?? []
          const connected = servers.filter(s => s.status === 'connected').length
          say([
            r.ok && r.info.version !== null ? `Claude Code ${r.info.version}` : 'Claude Code',
            planUsage.plan !== null ? planLabel(planUsage.plan) : null,
            session.model != null ? `model ${session.model}` : null,
            `mode ${permissionModeLabel(chatMode)}`,
            project.cwd != null ? `in ${project.cwd}` : null,
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
        void api.pluginAction(project.cwd ?? null, cmd.args).then(r => {
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
          sync.holdMessage(resend, { text: outgoing, images })
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
    // Signing in is done here, without a terminal.
    if (command === '/login') { app.signIn('asked'); return }
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
  }, [session, syncChat.info.synced, markSending]) // eslint-disable-line react-hooks/exhaustive-deps
  onSendRef.current = onSend

  // "Open in terminal" (header button, or the prompt for terminal-only
  // commands): hands the chat to the interactive Claude Code; the lock monitor
  // then keeps it read-only here until that terminal exits.
  const [terminalPrompt, setTerminalPrompt] = useState<{ command: string; text: string; images: ComposerImage[] } | null>(null)
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null)
  /** The notice that's good news, so it doesn't read as an error. */
  const [goodNotice, setGoodNotice] = useState<string | null>(null)
  const bypassTerminalCheck = useRef(false)
  useEffect(() => { setTerminalPrompt(null); setTerminalNotice(null) }, [session.id])
  // Declared after the line above, so a notice that waited for this chat outlasts opening it.
  const waitingNotice = useSyncExternalStore(composeStore.subscribe, () => composeStore.get(session.id).notice ?? null)
  useEffect(() => {
    if (waitingNotice === null) return
    composeStore.update(session.id, s => ({ ...s, notice: null }))
    setTerminalNotice(waitingNotice)
  }, [waitingNotice, session])
  const openChatInTerminal = useCallback(() => {
    setTerminalNotice(null)
    void api.openInTerminal(session.id).then(r => {
      if (r.ok) setTerminalPrompt(null)
      else if (r.cancelled !== true) setTerminalNotice(r.error)
    })
  }, [session])

  const onInterrupt = useCallback(() => {
    composeStore.beginCancel(session.id)
    api.interrupt(session.id)
  }, [session])

  // Esc while a message is still waiting on the sync check: it comes straight back.
  const onCancelSending = useCallback((): boolean => {
    const pending = checkingSyncRef.current.get(session.id)
    if (pending === undefined) return false
    pending.cancelled = true
    checkingSyncRef.current.delete(session.id)
    sync.holdMessage(null)
    markSending(session.id, false)
    composeStore.returnMessage(session.id, pending)
    return true
  }, [session, markSending]) // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    openSession: next => openSessionRef.current(next),
    supersede: () => { ++sessionReqId.current },
    focusFind: () => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
  }), [])
  // Ctrl+F in the split window: the focused pane's find box. The main window binds it in
  // App, which knows what's open on top of the chat.
  useEffect(() => {
    if (!split || !focused) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return
      e.preventDefault()
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [split, focused])
  // A chat the pane hasn't opened: the one it mounted with, or a `session` prop changed
  // without the handle. Opened before the first paint. When the window opened it through
  // the handle in the same update, it's already the loaded one and nothing happens here.
  const firstOpenRef = useRef(true)
  useLayoutEffect(() => {
    if (session.id === loadedForRef.current) return
    const first = firstOpenRef.current
    firstOpenRef.current = false
    const load = openSessionRef.current(session)
    if (!first) { void load; return }
    load.then(() => onMountOpened?.(), err => {
      if (onMountOpened !== undefined) onMountOpened(err)
      else console.error('Opening the chat failed', err)
    })
  }, [session.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Until then, what's in state belongs to another chat (or none): it isn't shown as this one's.
  const stale = session.id !== loadedForRef.current

  const archived = channels.find(c => c.id === project.id)?.archived === true
  const showRail = !hidden && (settings?.showContextRail ?? true)
  const railNode = showRail && (
    rail.expanded
      ? <ContextRail session={session} fsEntries={rail.fsEntries}
          hasKey={(settings?.openRouterKey ?? '').trim().length > 0}
          canCreateImage={typeof project.cwd === 'string' && project.cwd.length > 0}
          onCreateImage={() => rail.setCreateImageOpen(true)}
          onCollapse={() => toggleFiles(false)} context={context}
          view={rail.view} onView={rail.setView} pins={rail.pins} openChatId={session.id}
          onJumpToPin={pin => {
            setFindQuery('')
            setJumpTarget({ sessionPk: pin.sessionPk, uuid: pin.uuid, seq: pin.seq })
            if (pin.sessionPk !== session.id) {
              jumpPendingRef.current = true
              onOpenSession(pin.sessionPk, project.dirName)
            }
          }}
          onUnpin={pin => { void api.unpinMessage(pin.sessionPk, pin.uuid).then(rail.refreshPins) }}
          onCompact={!running && externalLock === null ? () => onSend('/compact', [], []) : undefined} />
      : <ContextRailStrip fsEntries={rail.fsEntries} view={rail.view} pinCount={rail.pins.length} onExpand={() => toggleFiles(true)}
          onOpenView={v => { rail.setView(v); toggleFiles(true) }} />
  )

  const liveIndicator = <LiveIndicator running={running} queuedCount={queuedCount} />
  const mcpChip = mcpServers !== null && (
    <McpChip sessionPk={session.id} cwd={project.cwd ?? null} servers={mcpServers}
      ignored={settings?.mcpWarnIgnore ?? []} onServers={setMcpServers}
      onIgnore={name => { void api.updateSettings({ mcpWarnIgnore: [...(settings?.mcpWarnIgnore ?? []), name] }).then(setSettings) }}
      onOpenSettings={() => app.openSettings('mcp')} />
  )
  const rcTag = remoteSessions.has(session.id) && (
    <span className="rc-tag" title="Remote Control on — this chat can be driven from claude.ai or the Claude app">
      <RemoteBadge className="rc-badge-inline" />Remote Control
    </span>
  )
  const headerTools = (
    <>
      <ProjectSearchBox ref={findInputRef} value={findQuery} onChange={setFindQuery} />
      {!split && <SplitLauncher session={session} project={project} channels={channels} settings={settings} />}
      {!archived && (
        <OpenInTerminalButton running={running} onOpen={openChatInTerminal} />
      )}
      {settings !== null && (
        <ProjectOptions settings={settings} chat={projectSettings}
          onChange={patch => { void api.setProjectSettings(session.id, patch).then(setProjectSettings) }}
          onOpenSettings={() => app.openSettings('appearance')}
          session={session} sessions={sessions} onOpenChat={s => onOpenChat(s)} onFork={forkChat}
          summary={`${permissionModeLabel(chatMode)} · ${liveModel ?? session.model ?? 'Default model'}`}
          sync={syncStates.get(project.id) ?? null} onSync={app.syncProject}>
          <ChatHeaderControls key={`${session.id}-${headerRev}`} session={session} liveModel={liveModel} mode={chatMode} onChangeMode={changeChatMode} />
        </ProjectOptions>
      )}
    </>
  )
  // The split window's panes share one row: the window's project and chat picker, the
  // chat's own controls, then the pane's buttons. No folder line and no update icon.
  const header = split
    ? (
        <header className="chead chead-compact">
          <div className="chead-compact-start">
            {headerStart}
            {liveIndicator}
            {mcpChip}
            {rcTag}
          </div>
          {headerTools}
          {headerEnd}
        </header>
      )
    : (
        <header className="chead">
          <div className="chead-main">
            <div className="chead-title-row">
              <h1>{resolveChannelName(project.meta, project.cwd, project.dirName)}</h1>
              {liveIndicator}
              {mcpChip}
              {rcTag}
            </div>
            <div className="path">{project.cwd ?? `${channels.length} projects indexed`}</div>
          </div>
          {headerTools}
          {(hidden || !(settings?.showContextRail ?? true)) && <UpdateIcon />}
        </header>
      )

  const body = (
    <OpenSubagentContext.Provider value={setSubagentOpen}>
        {header}
        <SyncChatBanner info={syncChat.info} onOpenSettings={() => app.openSettings('sync')} />
          {/* Keyed on the session id: forces a fresh Transcript instance (and
              fresh internal scroll/height refs) per session, so the scroll-
              preservation math never mixes geometry from a previously open
              session into the next one's first paint.
              Passed by reference (not wrapped in a new arrow) so its identity
              stays stable across renders, matching loadOlder's own useCallback
              stability -- see Finding 5 in the fix-pass report.
              Key is prefixed and distinct from the Composer's below: both are
              direct children of <main> and both remount per session, but two
              siblings sharing the same key value (session.id) is a duplicate-key
              collision — React then fails to unmount the previous Transcript on a
              session switch, stacking a new .stream under the stale one (each
              switch leaked one, splitting the chat into 50/50 scroll boxes). */}
          <div style={{ display: findTerms === '' ? 'contents' : 'none' }}><Transcript key={`transcript-${session.id}`} items={stale ? NO_ITEMS : items} hasMore={hasMore && !stale} loadingOlder={loadingOlder && !stale}
              loading={sessionLoading || stale} onReachTop={loadOlder} livePreview={stale ? null : livePreview} liveThinking={showThinking ? liveThinking : null} showThinking={showThinking} sending={sendingPks.has(session.id)} savedTextOnly={savedTextOnly}
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
              onResolvePermission={resolvePermission} /></div>
              {findTerms !== '' && (
                <ProjectSearchResults query={findQuery} result={findResult} loading={findLoading} currentSessionPk={session.id}
                  claudeIcon={settings?.claudeIcon ?? { kind: 'initials' }}
                  onJump={hit => {
                    setFindQuery('')
                    setJumpTarget({ sessionPk: hit.sessionPk, uuid: hit.uuid, seq: hit.seq })
                    if (hit.sessionPk !== session.id) {
                      jumpPendingRef.current = true
                      onOpenSession(hit.sessionPk, project.dirName)
                    }
                  }} />
              )}
        {(terminalPrompt !== null || terminalNotice !== null) && (
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
        {running && (
          <WorkingLine startedAt={turnStartedAt} tokens={turnTokens} status={liveStatus} pending={pending} lastActivity={lastEventAt}
            waitingOnYou={(permissionsByPk.get(session.id)?.length ?? 0) > 0 || (elicitations.get(session.id)?.length ?? 0) > 0} activity={liveActivity} />
        )}
        <SubagentsLive runs={agentRunsByPk.get(session.id) ?? NO_AGENT_RUNS} onView={setSubagentOpen} />
        <BackgroundTasksLine tasks={backgroundTasks} running={running} onStop={id => { void api.stopTask(session.id, id) }} onShowOutput={(id, title) => setTaskOutputOpen({ id, title })} />
        {panel === 'hooks' && <HooksDialog sessionPk={session.id} onClose={closePanel} />}
        {panel === 'diff' && <DiffDialog sessionPk={session.id} onClose={closePanel} />}
        {panel === 'tasks' && <TasksDialog tasks={backgroundTasks} onStop={id => { void api.stopTask(session.id, id) }} onShowOutput={(id, title) => { setPanel(null); setTaskOutputOpen({ id, title }) }} onClose={closePanel} />}
        {panel === 'export' && <ExportDialog sessionPk={session.id} onClose={closePanel}
          onDone={(text, good) => { setPanel(null); if (good) setGoodNotice(text); setTerminalNotice(text) }} />}
        {taskOutputOpen !== null && <TaskOutputDialog sessionPk={session.id} taskId={taskOutputOpen.id} title={taskOutputOpen.title} onClose={closeTaskOutput} />}
        {rewindOpen && (
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
        <ShellRuns runs={shellRuns} />
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
        {archived && (
          <div className="composer composer-archived" role="status">
            This project's folder no longer exists{project.cwd ? ` (${project.cwd})` : ''}, so this chat is read-only.
          </div>
        )}
        {!archived && (
          // Keyed on the session id (same reasoning as Transcript above): a
          // fresh Composer instance per session, so nothing bleeds from one
          // session into another. What's in progress survives the switch: text
          // via draftsRef, chips and the queue in composeStore.
          <Composer key={`composer-${session.id}`} sessionPk={session.id} running={running && !stale} focused={focused} settled={settledPk === session.id} shellStops={shellStops} onCycleMode={() => { const next = nextPermissionMode(chatMode); changeChatMode(next); return permissionModeLabel(next) }} lock={externalLock} syncing={syncingIn} cwd={project.cwd ?? null} suggestion={suggestion}
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
        {railNode !== false && railSlot !== null && createPortal(railNode, railSlot)}
    </OpenSubagentContext.Provider>
  )
  if (!split) return body
  // A click or a key anywhere in the pane makes it the focused one. The box takes no part
  // in the layout, so the pane lays out as it would in the main window.
  return (
    <DialogTarget.Provider value={dialogSlot ?? null}>
      <div className="split-pane-events" style={{ display: 'contents' }} onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
        {body}
      </div>
    </DialogTarget.Provider>
  )
}
