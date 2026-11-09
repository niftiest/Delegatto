import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { api } from './api'
import type { ChannelRow } from '../shared/types'
import { FOLDER_MISSING, SHELL_OUTPUT_SENT, type Elicitation, type PermissionRequest, type RemoteSession } from '../shared/engine-types'
import { limitCleared } from './usage-limit'
import type { AppSettings } from '../shared/shell-types'
import { NO_PLAN_USAGE, type PlanUsage } from '../shared/plan-usage'
import { projectSyncState, type ProjectSyncState, type SyncIncoming, type SyncStatus } from '../shared/sync-types'
import { reduceAgentRuns, type AgentRun } from '../shared/subagent-activity'
import { composeStore } from './compose-store'
import { paneBus } from './pane-bus'
import { useSyncStatus } from './components/SyncChat'
import { clearsRunning, dropCancelledMessage, hasUserRenderItem, renderItemsFromStreamedRows } from './lib'

export const NO_AGENT_RUNS: AgentRun[] = []

export type PermissionDecision = 'allow' | 'allow_always' | 'allow_folder' | 'deny'

/** What every chat in a window reads, whichever chats are on screen: the app-wide state and the
 *  pk-keyed maps, with the listeners that keep them current. Each pane takes its own slice. */
export type AppData = {
  settings: AppSettings | null
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  channels: ChannelRow[]
  setChannels: Dispatch<SetStateAction<ChannelRow[]>>
  channelsRef: MutableRefObject<ChannelRow[]>
  /** Re-pulls what the nav shows. The window supplies what that means for it. */
  refreshNav: () => void
  planUsage: PlanUsage
  incoming: SyncIncoming[]
  remote: RemoteSession[]
  syncStatus: SyncStatus | null
  syncStates: Map<number, ProjectSyncState>
  permissionsByPk: Map<number, PermissionRequest[]>
  permArrivedRef: MutableRefObject<Map<string, number>>
  onResolvePermission: (sessionPk: number, id: string, decision: PermissionDecision, editedInput?: unknown, denyMessage?: string) => void
  elicitations: Map<number, Elicitation[]>
  setChatElicitations: (pk: number, change: (list: Elicitation[]) => Elicitation[]) => void
  sendingPks: ReadonlySet<number>
  markSending: (pk: number, on: boolean) => void
  agentRunsByPk: ReadonlyMap<number, AgentRun[]>
  draftsRef: MutableRefObject<Map<number, string>>
  refreshUpdateHold: () => void
}

export function useAppData(refreshNav: () => void): AppData {
  const refreshNavRef = useRef(refreshNav)
  refreshNavRef.current = refreshNav
  const refreshNavLatest = useCallback((): void => refreshNavRef.current(), [])

  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [planUsage, setPlanUsage] = useState<PlanUsage>(NO_PLAN_USAGE)
  // App-wide settings, loaded once and kept live via SettingsWindow's
  // onSettingsChanged. Null until the first load resolves; the few things that
  // read it (e.g. showToolCalls in the transcript) fall back to sensible
  // defaults while null so nothing flickers on first paint.
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [agentRunsByPk, setAgentRunsByPk] = useState<ReadonlyMap<number, AgentRun[]>>(new Map())
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
  // Chats getting messages from another PC. The open one can't be written to until they're
  // in, and then it reloads to show them.
  const [incoming, setIncoming] = useState<SyncIncoming[]>([])
  useEffect(() => {
    void api.syncIncoming().then(setIncoming).catch(() => {})
    return api.onSyncIncoming(list => {
      if (list.length === 0 || list.some(i => i.phase === 'download' || i.done === 0 || i.done === i.total)) {
        api.appLog(`incoming: ${list.length === 0 ? 'none' : list.map(i => `${i.sessionId.slice(0, 8)} ${i.phase} ${i.done}/${i.total}`).join(', ')}`)
      }
      setIncoming(list)
    })
  }, [])
  // Chats a live claude has under Remote Control (/rc) -- badged in the rail,
  // chat list, session list and chat header. App-wide, pushed by main.
  const [remote, setRemote] = useState<RemoteSession[]>([])
  useEffect(() => {
    void api.listRemote().then(setRemote).catch(() => { /* engine not ready: stays empty */ })
    return api.onRemoteChanged(setRemote)
  }, [])
  // Pending permission/plan-approval requests (Plan 2 Task 9), keyed by the
  // sessionPk they belong to -- NOT filtered to just the open session, so a
  // request that arrives for a session the user isn't currently looking at
  // is kept (not lost, not silently answered) and simply doesn't render
  // until the user switches to that session. Plan.get(session.id) in the pane
  // is what actually narrows this down to what Transcript renders.
  const [permissionsByPk, setPermissionsByPk] = useState<Map<number, PermissionRequest[]>>(new Map())
  // Arrival times drive the blocked-turn banner countdown.
  const permArrivedRef = useRef<Map<string, number>>(new Map())
  // Per-session draft text, so switching away and back restores what was
  // being typed. A ref (not state) since it's read only when (re)mounting a
  // Composer, never needs to trigger a render itself.
  const draftsRef = useRef<Map<number, string>>(new Map())
  // Latest channels, mirrored into a ref so the app-wide onIndexed listener
  // (registered once) can diff against them without re-subscribing on every
  // channel change.
  const channelsRef = useRef<ChannelRow[]>([])
  useEffect(() => { channelsRef.current = channels }, [channels])

  // Drafts, queued messages and attachments live only in this window, so a restart for
  // an update waits for them.
  const updateHoldRef = useRef(false)
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
        // Only the panes showing this chat drop it (see dropCancelledMessage).
        paneBus.emit(pk, { kind: 'dropCancelled', uuid })
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
    // Answered here or in the other window.
    if (ev.kind === 'elicitationGone') setChatElicitations(pk, list => list.filter(r => r.requestId !== ev.requestId))
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
    // A real reply: whatever limit stopped the chats before is over, in every chat.
    if (ev.kind === 'assistant' && ev.apiError === undefined && ev.synthetic !== true && ev.blocks.length > 0) limitCleared.mark()
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

  // Plan usage for the chat-list footer.
  useEffect(() => {
    void api.planUsage().then(setPlanUsage).catch(() => {})
    return api.onPlanUsageChanged(setPlanUsage)
  }, [])

  // Load settings once so the transcript can honour display prefs (e.g.
  // hiding tool-call cards). Kept live via SettingsWindow.
  useEffect(() => { void api.getSettings().then(setSettings) }, [])
  // Saved in this window or another: both windows show the same theme, font and text sizes.
  useEffect(() => api.onAppSettingsChanged(setSettings), [])

  // Keep the nav live: whenever a catalog sync completes (for ANY session, not
  // just the open one), re-pull the channel list so previews/timestamps
  // reflect the newest message, and flag any channel whose activity advanced
  // while it wasn't the open project as unread. Registered once for the app's
  // lifetime; reads current channels/open-project via refs so it never needs
  // to re-subscribe. Distinct from the session-scoped onIndexed reload in
  // ChatPane, which only refreshes the open transcript.
  //
  // Coalesced: the external-change sweep can report several chats in one tick
  // (each its own `engine:indexed`), and a live turn emits one per row batch --
  // a short trailing debounce turns any burst into a single nav re-pull.
  // Also re-pulls the open project's session list so a chat continued
  // elsewhere bumps to the top of it even while the open transcript is
  // scrolled up (the session-scoped reload skips that case).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onIndexed(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refreshNavRef.current() }, 120)
    })
    return () => { off(); if (timer !== null) clearTimeout(timer) }
  }, [])

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

  // What was already waiting when this window opened (the split window opens later than the
  // main one). Merged with anything that arrived meanwhile, which the listeners hold already.
  useEffect(() => {
    let alive = true
    void api.pendingPermissions().then(list => {
      if (!alive || list.length === 0) return
      for (const { req } of list) if (!permArrivedRef.current.has(req.id)) permArrivedRef.current.set(req.id, Date.now())
      setPermissionsByPk(prev => {
        const next = new Map(prev)
        for (const { sessionPk, req } of list) {
          const have = next.get(sessionPk) ?? []
          if (!have.some(r => r.id === req.id)) next.set(sessionPk, [...have, req])
        }
        return next
      })
    }).catch(() => {})
    void api.pendingQuestions().then(list => {
      if (!alive) return
      for (const { sessionPk, request } of list) {
        setChatElicitations(sessionPk, have => (have.some(r => r.requestId === request.requestId) ? have : [...have, request]))
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [setChatElicitations])

  // Forwards a PermissionCard/PlanApprovalCard decision to the engine and
  // removes it from the pending list. `sessionPk` is passed explicitly
  // (rather than closing over the open session) so a decision on a request that
  // arrived for a session the user has since navigated away from still
  // removes it from the RIGHT session's list, not whatever is open now.
  // The pane that answered re-reads its project options after 'allow_folder'.
  const onResolvePermission = useCallback(
    (sessionPk: number, id: string, decision: PermissionDecision, editedInput?: unknown, denyMessage?: string) => {
      api.resolvePermission(id, decision, editedInput, denyMessage)
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

  const syncStatus = useSyncStatus()
  const syncStates = useMemo(() => {
    const states = new Map<number, ProjectSyncState>()
    if (syncStatus === null) return states
    for (const c of channels) {
      const state = projectSyncState(syncStatus, c)
      if (state !== null) states.set(c.id, state)
    }
    return states
  }, [syncStatus, channels])

  return {
    settings, setSettings, channels, setChannels, channelsRef, refreshNav: refreshNavLatest,
    planUsage, incoming, remote, syncStatus, syncStates,
    permissionsByPk, permArrivedRef, onResolvePermission,
    elicitations, setChatElicitations, sendingPks, markSending, agentRunsByPk,
    draftsRef, refreshUpdateHold
  }
}
