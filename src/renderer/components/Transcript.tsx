import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, useState, useSyncExternalStore } from 'react'
import type { RenderItem } from '../../shared/types'
import type { PermissionRequest } from '../../shared/engine-types'
import type { ChannelIcon } from '../../shared/shell-types'
import { ClaudeAvatar } from './ClaudeAvatar'
import { ToolCard } from './ToolCard'
import { ChatImage } from './ChatImage'
import { Markdown, TextWithLinks } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { parseQuestions } from '../question-form'
import type { Elicitation, ElicitationAnswer } from '../../shared/engine-types'
import { ElicitationCard, QuestionCard } from './QuestionCard'
import { PlanApprovalCard } from './PlanApprovalCard'
import { groupToolRuns, toolRunSummary, thoughtRuns, thoughtsLabel, stableItemKeys, groupIntoTurns, hideAnsweredCommands,userMessageParts, shouldScrollToBottom, followAfterScroll, isPlanApproval, isQuestion, formatClock, localDayKey, dayDividerLabel, type LivePreview } from '../lib'
import { PinBadge, PinnedMessages } from './PinBadge'
import { hideClearedLimitNotices, limitCleared } from '../usage-limit'

const NO_PINS: ReadonlySet<string> = new Set()

type ResolvePermission = (id: string, decision: 'allow' | 'allow_always' | 'allow_folder' | 'deny', editedInput?: unknown, denyMessage?: string) => void

/** How long the view stays on a message it just went to, unless the reader moves it. */
const JUMP_HOLD_MS = 1200

/** How long after clicking a card's header a change of height is put down to that card. */
const CARD_OPEN_MS = 400
/** How far above the end the reader has to be before the jump button shows. */
const JUMP_BUTTON_GAP = 200

/** What a `!` command printed, folded to one line until it's opened: in the chat it's a
 *  record of what ran, and a long one would bury the conversation. */
function ShellOutput({ uuid, text }: { uuid: string; text: string }) {
  const lines = text.split('\n')
  const first = lines.find(l => l.trim() !== '')?.trim() ?? ''
  return (
    <div className="bubble-claude shell-output-card" data-msg={uuid}>
      <PinBadge uuid={uuid} />
      <details>
        <summary className="shell-output-summary">
          <span className="shell-output-label">Output · {lines.length === 1 ? '1 line' : `${lines.length.toLocaleString('en-US')} lines`}</span>
          <span className="shell-output-preview">{first}</span>
        </summary>
        <pre className="shell-output">{text}</pre>
      </details>
    </div>
  )
}

export function Transcript({ pendingToolIds, groupToolCalls = true, items: allItems, hasMore, loadingOlder, loading, onReachTop, permissionRequests, onResolvePermission, elicitations = [], onAnswerElicitation, onOpenLink, livePreview, liveThinking = null, sending = false, savedTextOnly = false, showToolCalls = true, showThinking = true, onAtBottomChange, fileMissing = false, claudeIcon = { kind: 'initials' }, scrollToBottomSignal, thinkingExpanded = false, toolCardsExpanded = false, jumpTo = null, onJumped, pinnedUuids = NO_PINS }: {
  items: RenderItem[]
  hasMore: boolean
  loadingOlder: boolean
  /** True while the very first page of this session is still in flight. Lets
   *  us tell "nothing has loaded yet" apart from "this session is genuinely
   *  empty" instead of flashing an incorrect empty state on a slow IPC round trip. */
  loading: boolean
  onReachTop: () => void
  /** Pending permission/plan-approval requests for the open session (Plan 2
   *  Task 9), rendered inline after the messages — they block the turn. */
  permissionRequests?: PermissionRequest[]
  onResolvePermission?: ResolvePermission
  /** Transient "assistant is typing" preview (Plan 2 Task 10) accumulated from
   *  live engine:event deltas, rendered after the messages while a turn streams. */
  /** What MCP servers are asking the user. */
  elicitations?: Elicitation[]
  onAnswerElicitation?: (requestId: string, answer: ElicitationAnswer) => void
  onOpenLink?: (url: string) => void
  livePreview?: LivePreview | null
  /** Claude's thinking so far, while it's still thinking. */
  liveThinking?: string | null
  /** A message of the user's is on its way and isn't in `items` yet. */
  sending?: boolean
  /** The transcript has gone, and this is the text the catalog saved of it. */
  savedTextOnly?: boolean
  /** When false, tool-call cards are dropped from the transcript (Appearance
   *  setting "Show tool calls") -- for readers who only want the conversation. */
  showToolCalls?: boolean
  /** Claude's thoughts in the chat. Hidden here, like tool calls, so turning them back on needs no reload. */
  showThinking?: boolean
  /** Collapse each run of tool calls and thoughts into one line. */
  groupToolCalls?: boolean
  /** Reports whether the view is pinned near the bottom (following live) vs
   *  scrolled up (reading history). App uses this to skip the disruptive
   *  background-sync reload while the user is reading older messages. */
  onAtBottomChange?: (atBottom: boolean) => void
  /** The session's transcript file was removed from disk (Claude Code's
   *  cleanupPeriodDays) though the catalog still has it -- show an archived
   *  message instead of the misleading "no messages". */
  fileMissing?: boolean
  /** App-wide avatar for Claude's turns (Settings → Appearance). */
  claudeIcon?: ChannelIcon
  /** Changes (any new value) request an imperative jump to the absolute bottom
   *  -- App bumps it when the user sends a message so the view catches up even
   *  if they were scrolled up reading history. */
  scrollToBottomSignal?: number
  /** Thinking blocks / tool cards start open (Settings → Appearance). */
  thinkingExpanded?: boolean
  toolCardsExpanded?: boolean
  /** Tool calls in the running turn still waiting for a result. */
  pendingToolIds?: ReadonlySet<string>
  /** A message to scroll to and flash, once it's among `items`. */
  jumpTo?: string | null
  onJumped?: () => void
  /** The chat's pinned messages: each gets a small pin at its top right. */
  pinnedUuids?: ReadonlySet<string>
}) {
  const pending = permissionRequests ?? []
  const preview = livePreview ?? null
  // Filter tool cards out here (not upstream) so the durable render model is
  // untouched and toggling the setting re-shows them without a reload.
  const limitClearedAt = useSyncExternalStore(limitCleared.subscribe, limitCleared.get)
  const items = useMemo(() => {
    const shown = hideClearedLimitNotices(hideAnsweredCommands(allItems), limitClearedAt)
    return showToolCalls && showThinking ? shown : shown.filter(it => (showToolCalls || it.kind !== 'tool') && (showThinking || it.kind !== 'thinking'))
  }, [allItems, showToolCalls, showThinking, limitClearedAt])
  const parentRef = useRef<HTMLDivElement>(null)
  // Stable React keys so a loadOlder prepend reconciles the existing message
  // DOM in place (no remount), which is what keeps the scroll-preservation
  // below correct. A single message uuid can emit several RenderItems (a text
  // item + a tool item from one turn), so uuid alone isn't unique;
  // stableItemKeys appends a per-uuid run counter that survives a prepend.
  const itemKeys = useMemo(() => stableItemKeys(items), [items])
  // Group the flat list into user/Claude turns so the transcript reads as a
  // back-and-forth; keys still come from itemKeys[startIndex + i] so a
  // loadOlder prepend reconciles in place (scroll preservation below relies on it).
  const turns = useMemo(() => groupIntoTurns(items), [items])

  // Day dividers: the label to render *before* each turn, or null
  // if that turn is on the same local day as the previous dated turn. Turns with
  // no timestamp (e.g. a tool-only turn) inherit the running day and never force
  // a divider, so a dateless turn between two same-day turns doesn't split them.
  const dividers = useMemo(() => {
    let prevKey: number | null = null
    return turns.map(turn => {
      const first = firstTs(turn.items)
      const key = localDayKey(first)
      if (key === null || key === prevKey) return null
      prevKey = key
      return dayDividerLabel(first)
    })
  }, [turns])

  // Chat scroll behaviour (no virtualization — the paged loader caps the DOM
  // at ~60 messages/page, so a plain flowing column scrolls as one, which is
  // exactly what a chat wants; a virtualizer boxed each message into its own
  // scroll region). This component is remounted (key={session.id} in App) on
  // every session switch, so neither ref carries stale geometry across sessions.
  // Following the end of the chat, or reading further up. Only scrolling changes this:
  // content growing below doesn't, however far it grows, so a message taller than the
  // gap can't make the chat look as if the reader left.
  const BOTTOM_MARGIN = 80
  const following = useRef(true)
  const lastScrollTop = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const openedCardAt = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const gapBelow = (el: HTMLElement): number => el.scrollHeight - el.scrollTop - el.clientHeight
  const reportAtBottom = (): void => {
    onAtBottomChange?.(following.current)
    const el = parentRef.current
    setShowJump(el !== null && !following.current && gapBelow(el) > JUMP_BUTTON_GAP)
  }
  const jumpToEnd = (): void => {
    const el = parentRef.current
    if (el === null) return
    releaseJump()
    following.current = true
    el.scrollTop = el.scrollHeight
    reportAtBottom()
  }

  const prevHeight = useRef(0)
  const prevFirstKey = useRef<string | null>(null)
  const scrolledToBottom = useRef(false)

  useLayoutEffect(() => {
    const el = parentRef.current
    if (el === null) return
    const firstKey = itemKeys[0] ?? null
    if (shouldScrollToBottom(scrolledToBottom.current, items.length)) {
      // First non-empty render of this session: land on the newest message.
      el.scrollTop = el.scrollHeight
      scrolledToBottom.current = true
      following.current = true
    } else if (following.current) {
      if (!holdingJump()) el.scrollTop = el.scrollHeight
    } else if (prevFirstKey.current !== null && firstKey !== prevFirstKey.current && el.scrollHeight > prevHeight.current) {
      // An older page arrived above: stay on the same message. Anything added below
      // leaves the reading position alone without help.
      el.scrollTop += el.scrollHeight - prevHeight.current
    }
    prevHeight.current = el.scrollHeight
    prevFirstKey.current = firstKey
    reportAtBottom()
  }, [items])

  // The height a message ends up with often isn't known when it's added: a picture
  // has none until it decodes, and text reflows as fonts and highlighting land. So
  // follow the height itself, as well as the chat's own box getting shorter when the
  // composer grows. This runs before the frame is painted, so nothing shows cut off.
  const hasStream = items.length > 0 || pending.length > 0 || elicitations.length > 0 || preview !== null || liveThinking !== null || sending
  useEffect(() => {
    const el = parentRef.current
    const content = contentRef.current
    if (el === null || content === null) return
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === 0) return
      if (holdingJump() || !following.current) { reportAtBottom(); return }
      // Opening a card to read it stays put, rather than scrolling its top out of view.
      if (Date.now() - openedCardAt.current < CARD_OPEN_MS) {
        following.current = gapBelow(el) < BOTTOM_MARGIN
        reportAtBottom()
        return
      }
      el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    observer.observe(content)
    return () => observer.disconnect()
  }, [hasStream])

  // If a page renders shorter than the viewport, the container never becomes
  // scrollable and the user can't scroll-to-top to pull the next page — so
  // pull it proactively until content fills the viewport or hasMore is false.
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el === null || loadingOlder || !hasMore || holdingJump()) return
    if (el.scrollHeight <= el.clientHeight) onReachTop()
  }, [items, hasMore, loadingOlder, onReachTop])

  function handleScroll() {
    const el = parentRef.current
    if (el === null) return
    following.current = followAfterScroll(following.current, el.scrollTop, lastScrollTop.current, gapBelow(el), BOTTOM_MARGIN)
    lastScrollTop.current = el.scrollTop
    reportAtBottom()
    if (loadingOlder || !hasMore || holdingJump()) return
    if (el.scrollTop < 240) onReachTop()
  }

  // Going to one message. Runs after the layout effects above, which keep the reading
  // position across a prepend, and stops them holding the view at the bottom. For a
  // moment it then stays on the message: rendering above it still moves things, and
  // landing near the top of what's loaded mustn't pull in another page and shift it.
  const jumpHold = useRef<{ timer: ReturnType<typeof setInterval>; until: number } | null>(null)
  const releaseJump = (): void => {
    if (jumpHold.current !== null) clearInterval(jumpHold.current.timer)
    jumpHold.current = null
  }
  useEffect(() => releaseJump, [])
  useEffect(() => {
    if (jumpTo === null) return
    const uuid = jumpTo
    const find = (): Element | null => parentRef.current?.querySelector(`[data-msg="${CSS.escape(uuid)}"]`) ?? null
    onJumped?.()
    const first = find()
    if (first === null) return
    following.current = false
    releaseJump()
    const center = (): void => { find()?.scrollIntoView({ block: 'center' }) }
    center()
    first.classList.remove('jump-flash')
    void (first as HTMLElement).offsetWidth // restart the animation on a second visit
    first.classList.add('jump-flash')
    const until = Date.now() + JUMP_HOLD_MS
    const timer = setInterval(() => {
      if (Date.now() >= until) { releaseJump(); return }
      center()
    }, 120)
    jumpHold.current = { timer, until }
    setTimeout(() => find()?.classList.remove('jump-flash'), 2200)
  }, [jumpTo])
  const holdingJump = (): boolean => jumpHold.current !== null && Date.now() < jumpHold.current.until

  // Imperative jump to the absolute bottom on demand (App bumps the signal when
  // the user sends). Re-arms follow so the just-sent turn — which lands a beat
  // later via the live stream — appends pinned to the bottom rather than off
  // screen. Skips the initial mount (the first-render effect already lands at
  // the bottom) so it never fights scroll restoration on a session switch.
  const didMountScroll = useRef(false)
  useLayoutEffect(() => {
    if (!didMountScroll.current) { didMountScroll.current = true; return }
    const el = parentRef.current
    if (el === null) return
    following.current = true
    el.scrollTop = el.scrollHeight
    reportAtBottom()
  }, [scrollToBottomSignal])

  if (!hasStream) {
    if (fileMissing) {
      return (
        <div className="empty transcript-archived">
          <div className="transcript-archived-title">Transcript no longer on disk</div>
          <p>Claude Code deletes chat transcripts older than its <code>cleanupPeriodDays</code> (30 days by
            default), so this conversation’s file is gone. Its cost and metadata are still recorded here.</p>
          <p>To keep future transcripts longer, raise <code>cleanupPeriodDays</code> in your Claude Code settings.</p>
        </div>
      )
    }
    return <div className="empty" style={{ flex: 1 }}>{loading ? 'Loading…' : 'No messages in this session.'}</div>
  }

  return (
    <PinnedMessages.Provider value={pinnedUuids}>
    <div className="stream" ref={parentRef} onScroll={handleScroll} onWheel={releaseJump} onMouseDown={releaseJump} onKeyDown={releaseJump}
      onClickCapture={e => { if ((e.target as Element).closest('summary') !== null) openedCardAt.current = Date.now() }}>
      <div className="stream-content" ref={contentRef}>
      {savedTextOnly && <div className="saved-text-note">This chat's transcript no longer exists. This is the text Delegatto saved of it, without tool calls or their output.</div>}
      {hasMore && <div className="empty">{loadingOlder ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}</div>}
      {turns.map((turn, ti) => {
        const keyAt = (li: number): string => itemKeys[turn.startIndex + li]!
        const ts = formatClock(firstTs(turn.items))
        const divider = dividers[ti]
        const dayDivider = divider !== null && divider !== undefined
          ? <div key={`day:${keyAt(0)}`} className="day-divider"><span>{divider}</span></div>
          : null

        if (turn.role === 'notice') {
          return (
            <Fragment key={keyAt(0)}>
              {dayDivider}
              <div className="turn-notice">
                {turn.items.map((it, li) => (
                  it.kind === 'notice'
                    ? <details key={keyAt(li)} className="notice-card">
                        <summary className="notice-summary">
                          <span className="notice-badge" aria-hidden="true">⚙</span>
                          <span className="notice-headline">{it.label ?? noticeHeadline(it.text)}</span>
                          {ts && <time className="notice-time">{ts}</time>}
                        </summary>
                        <pre className="notice-body">{it.text}</pre>
                      </details>
                    : null
                ))}
              </div>
            </Fragment>
          )
        }

        if (turn.role === 'user') {
          return (
            <Fragment key={keyAt(0)}>
              {dayDivider}
              <div className="turn-user">
                <div className="turn-user-col">
                  <div className="turn-meta">
                    {ts && <time className="turn-time">{ts}</time>}
                    <span className="turn-author">You</span>
                  </div>
                  {userMessageParts(turn.items).map(part => (
                    <div key={keyAt(part.first)} className="turn-user-msg">
                      {part.images.length > 0 && (
                        <div className="turn-user-images">
                          {part.images.map(li => {
                            const it = turn.items[li]!
                            return it.kind === 'image' ? <ChatImage key={keyAt(li)} source={it.source} /> : null
                          })}
                        </div>
                      )}
                      {part.texts.map(li => {
                        const it = turn.items[li]!
                        return it.kind === 'text' ? <div key={keyAt(li)} className="bubble-me txt" data-msg={it.uuid}><PinBadge uuid={it.uuid} /><TextWithLinks text={it.text} /></div> : null
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </Fragment>
          )
        }

        return (
          <Fragment key={keyAt(0)}>
            {dayDivider}
            <div className="turn">
              <ClaudeAvatar icon={claudeIcon} size={28} />
              <div className="turn-body">
                <div className="turn-meta">
                  <span className="turn-author claude">Claude</span>
                  {ts && <time className="turn-time">{ts}</time>}
                </div>
                {(() => {
                  // Thoughts in a row open and close as one. Its key is the first thought's, so
                  // one that's open stays open as more arrive.
                  const renderThoughts = (indices: number[]): ReactNode => {
                    const texts = indices.flatMap(i => { const it = turn.items[i]!; return it.kind === 'thinking' ? [it.text] : [] })
                    return (
                      <details key={keyAt(indices[0]!)} className="turn-thinking" open={thinkingExpanded || undefined}>
                        <summary className="thinking">✳ {thoughtsLabel(texts)}</summary>
                        {texts.map((text, i) => <div key={i} className="txt think-body">{text}</div>)}
                      </details>
                    )
                  }
                  const renderItem = (it: RenderItem, k: string): ReactNode => {
                    if (it.kind === 'text') return it.literal === true
                      ? <ShellOutput key={k} uuid={it.uuid} text={it.text} />
                      : <Markdown key={k} text={it.text} className="bubble-claude" anchor={it.uuid} />
                    if (it.kind === 'tool') return <ToolCard key={k} item={it} defaultOpen={toolCardsExpanded} pending={pendingToolIds?.has(it.toolUseId) ?? false} />
                    if (it.kind === 'image') return <ChatImage key={k} source={it.source} />
                    return null
                  }
                  const renderRun = (indices: number[]): ReactNode[] => thoughtRuns(indices, turn.items).map(run =>
                    turn.items[run[0]!]!.kind === 'thinking' ? renderThoughts(run) : renderItem(turn.items[run[0]!]!, keyAt(run[0]!)))
                  if (!groupToolCalls) return renderRun(turn.items.map((_, li) => li))
                  return groupToolRuns(turn.items).map(part => {
                    if (part.group === 'thoughts') return renderThoughts(part.indices)
                    if (!part.group) return renderRun([part.index])
                    const run = part.indices.map(i => turn.items[i]!)
                    return (
                      <details key={keyAt(part.indices[0]!)} className="tool-run" open={toolCardsExpanded || undefined}>
                        <summary className="tool-run-summary">{toolRunSummary(run)}</summary>
                        <div className="tool-run-body">{renderRun(part.indices)}</div>
                      </details>
                    )
                  })
                })()}
              </div>
            </div>
          </Fragment>
        )
      })}
      {sending && (
        <div className="turn-user">
          <div className="turn-user-col">
            <div className="turn-meta"><span className="turn-author">You</span></div>
            <div className="bubble-me bubble-sending" role="status">Sending message…</div>
          </div>
        </div>
      )}
      {liveThinking !== null && (
        <div className="turn">
          <ClaudeAvatar icon={claudeIcon} size={28} />
          <div className="turn-body">
            <div className="turn-meta">
              <span className="turn-author claude">Claude</span>
              <span className="live-typing-dot" aria-hidden="true">●</span>
              <span className="turn-typing">thinking</span>
            </div>
            <details className="turn-thinking" open={thinkingExpanded || undefined}>
              <summary className="thinking">✳ thinking · {liveThinking.length} chars</summary>
              <div className="txt think-body">{liveThinking}</div>
            </details>
          </div>
        </div>
      )}
      {preview !== null && (
        <div className="turn">
          <ClaudeAvatar icon={claudeIcon} size={28} />
          <div className="turn-body">
            <div className="turn-meta">
              <span className="turn-author claude">Claude</span>
              <span className="live-typing-dot" aria-hidden="true">●</span>
              <span className="turn-typing">typing</span>
            </div>
            <div className="bubble-claude streaming"><Markdown text={preview.text} highlight={false} /><span className="stream-caret" aria-hidden="true">▍</span></div>
          </div>
        </div>
      )}
      {(pending.length > 0 || elicitations.length > 0) && (
        <div className="turn">
          <ClaudeAvatar icon={claudeIcon} size={28} />
          <div className="turn-body perm-stack">
            {elicitations.map(request => (
              <ElicitationCard key={request.requestId} request={request}
                onAnswer={(id, answer) => onAnswerElicitation?.(id, answer)} onOpenLink={url => onOpenLink?.(url)} />
            ))}
            {pending.map(req => (
              isPlanApproval(req.tool)
                ? <PlanApprovalCard key={req.id} req={req}
                    onResolve={(id, decision, editedInput, denyMessage) => onResolvePermission?.(id, decision, editedInput, denyMessage)} />
                : isQuestion(req.tool) && parseQuestions(req.input) !== null
                ? <QuestionCard key={req.id} req={req}
                    onResolve={(id, decision, editedInput, denyMessage) => onResolvePermission?.(id, decision, editedInput, denyMessage)} />
                : <PermissionCard key={req.id} req={req}
                    onResolve={(id, decision, editedInput, denyMessage) => onResolvePermission?.(id, decision, editedInput, denyMessage)} />
            ))}
          </div>
        </div>
      )}
      </div>
      {showJump && (
        <div className="jump-latest">
          <button type="button" onClick={jumpToEnd}>↓ Jump to bottom</button>
        </div>
      )}
    </div>
    </PinnedMessages.Provider>
  )
}

/** A one-line label for a collapsed background-task notice: the wrapper's
 *  <summary> if it has one, otherwise a generic fallback. */
function noticeHeadline(text: string): string {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text)
  const summary = m?.[1]?.trim()
  return summary && summary.length > 0 ? summary : 'Background task update'
}

/** First timestamp in a turn: text/thinking/notice items carry `ts`; tool/image don't. */
function firstTs(items: RenderItem[]): string | null {
  for (const it of items) if ((it.kind === 'text' || it.kind === 'thinking' || it.kind === 'notice') && it.ts) return it.ts
  return null
}

