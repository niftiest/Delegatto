import { formatClock, plainPreview } from '../lib'
import type { PinnedMessage } from '../../shared/engine-ipc-contract'
import { UpdateIcon } from './UpdatesPanel'
import type { ContextUsage } from '../../shared/project-options'
import type { SessionSummary } from '../../shared/types'
import type { FsEntry } from '../../shared/ipc'
import { costOfSession, formatCost } from '../../shared/models'

/** Compact token count: 412000 -> "412k", 2_100_000 -> "2.1M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** 300px right context rail: a single panel -- the project file tree (bounded,
 *  with git status) on top, and the session's token usage + estimated list
 *  price pinned at the bottom. Read-only. Collapses to the 46px strip. */
/** Claude compacts by itself near the limit; this is the point to think about it. */
const CONTEXT_WARN_PERCENT = 80

export type RailView = 'files' | 'pins'

/** A pin, as an icon: the rail's way to its pinned messages. */
function PinIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9.8 1.3a.8.8 0 0 1 1.1 0l3.8 3.8a.8.8 0 0 1 0 1.1l-.5.5a1.5 1.5 0 0 1-1.6.3l-2.3 2.7.2 2.3a.8.8 0 0 1-.2.6l-.6.6a.8.8 0 0 1-1.1 0L6.2 10.4l-3.7 3.7-.6-.6 3.7-3.7L3.2 7.4a.8.8 0 0 1 0-1.1l.6-.6a.8.8 0 0 1 .6-.2l2.3.2 2.7-2.3a1.5 1.5 0 0 1 .3-1.6z" /></svg>
}

/** One project's pinned messages. Clicking one goes to it, in whichever chat it's in. */
function PinsList({ pins, openChatId, onJump, onUnpin }: { pins: PinnedMessage[]; openChatId: number | null; onJump: (pin: PinnedMessage) => void; onUnpin: (pin: PinnedMessage) => void }) {
  if (pins.length === 0) return <p className="settings-note" style={{ padding: '8px 10px' }}>No pinned messages yet. Right-click a message in the chat and choose Pin Message.</p>
  return (
    <div className="pins-list">
      {pins.map(pin => (
        <div className="pin-row" key={`${pin.sessionPk}:${pin.uuid}`}>
          <button type="button" className="pin-open" title={pin.text ?? ''} onClick={() => onJump(pin)}>
            <span className="pin-meta">
              <span className="pin-author">{pin.role === 'user' ? 'You' : 'Claude'}</span>
              {pin.sessionPk !== openChatId && pin.chatTitle !== null && <span className="pin-chat">{pin.chatTitle}</span>}
              <time className="pin-time">{formatClock(pin.ts)}</time>
            </span>
            <span className="pin-text">{plainPreview(pin.text ?? '')}</span>
          </button>
          <button type="button" className="term-prompt-x" aria-label="Unpin message" title="Unpin" onClick={() => onUnpin(pin)}>✕</button>
        </div>
      ))}
    </div>
  )
}

export function ContextRail({ session, fsEntries, hasKey, canCreateImage, onCreateImage, onCollapse, context = null, onCompact, view, onView, pins, openChatId, onJumpToPin, onUnpin }: {
  /** Which list the rail shows. */
  view: RailView
  onView: (view: RailView) => void
  pins: PinnedMessage[]
  openChatId: number | null
  onJumpToPin: (pin: PinnedMessage) => void
  onUnpin: (pin: PinnedMessage) => void
  /** How full the chat is, while it has a process running. */
  context?: ContextUsage | null
  /** Offered once the chat is getting full; undefined while it can't be done. */
  onCompact?: () => void
  session: SessionSummary | null
  fsEntries: FsEntry[]
  /** OpenRouter key is set -- enables the Create-Image tool. */
  hasKey: boolean
  /** There's a real working directory to save into. */
  canCreateImage: boolean
  onCreateImage: () => void
  onCollapse: () => void
}) {
  const tokens = {
    inputTokens: session?.inputTokens ?? 0,
    outputTokens: session?.outputTokens ?? 0,
    cacheRead: session?.cacheRead ?? 0,
    cacheWrite: session?.cacheWrite ?? 0
  }
  const cost = session ? costOfSession(session.model, tokens) : 0

  return (
    <aside className="crail" aria-label="Files & usage">
      <div className="crail-head">
        <button type="button" className="crail-collapse" title="Collapse rail" aria-label="Collapse context rail"
          onClick={onCollapse}>»</button>
        <span className="crail-title">{view === 'pins' ? 'Pinned' : 'Files'}</span>
        <button type="button" className={`crail-view${view === 'pins' ? ' active' : ''}`} title={view === 'pins' ? 'Show files' : 'Pinned messages'}
          aria-label={view === 'pins' ? 'Show files' : 'Pinned messages'} aria-pressed={view === 'pins'} onClick={() => onView(view === 'pins' ? 'files' : 'pins')}><PinIcon /></button>
        <UpdateIcon />
        <button type="button" className="crail-add" disabled={!hasKey || !canCreateImage}
          title={!hasKey ? 'Set an OpenRouter key in Settings to generate images'
            : !canCreateImage ? 'Open a chat with a working directory first'
            : 'Create image with AI'}
          aria-label="Create image with AI" onClick={onCreateImage}>＋</button>
      </div>

      <div className="crail-body">
        {view === 'pins'
          ? <PinsList pins={pins} openChatId={openChatId} onJump={onJumpToPin} onUnpin={onUnpin} />
          : fsEntries.length === 0
          ? <p className="settings-note" style={{ padding: '8px 10px' }}>No files{session ? '' : ' — open a chat'} to show.</p>
          : <div className="crail-tree">
              {fsEntries.map(e => (
                <div key={e.relPath} className="crail-file" title={e.relPath} style={{ paddingLeft: 8 + e.depth * 14 }}>
                  {e.isDir
                    ? <span className="crail-file-dir">▸ {e.name}</span>
                    : <>
                        {e.git && <span className={`crail-git crail-git-${e.git === '?' ? 'new' : 'mod'}`}>{e.git}</span>}
                        <span>{e.name}</span>
                      </>}
                </div>
              ))}
            </div>}
      </div>

      <div className="crail-foot">
        {context !== null && (
          <div className={`crail-context${context.percent >= CONTEXT_WARN_PERCENT ? ' crail-context-full' : ''}`}
            title={context.categories.map(c => `${c.name}: ${fmtTokens(c.tokens)}`).join('\n')}>
            <div className="crail-context-head">
              <span className="crail-usage-title">Context</span>
              <span>{Math.round(context.percent)}% · {fmtTokens(context.usedTokens)} / {fmtTokens(context.maxTokens)}</span>
            </div>
            <div className="crail-context-bar"><i style={{ width: `${context.percent}%` }} /></div>
            {context.percent >= CONTEXT_WARN_PERCENT && onCompact !== undefined && (
              <button type="button" className="btn-secondary" onClick={onCompact}>Compact now</button>
            )}
          </div>
        )}
        <div className="crail-usage-title">Session usage</div>
        <div className="crail-tilegrid">
          <div className="crail-tile"><div className="crail-tile-k">input</div><div className="crail-tile-v">{fmtTokens(tokens.inputTokens)}</div></div>
          <div className="crail-tile"><div className="crail-tile-k">output</div><div className="crail-tile-v">{fmtTokens(tokens.outputTokens)}</div></div>
          <div className="crail-tile"><div className="crail-tile-k">cache read</div><div className="crail-tile-v">{fmtTokens(tokens.cacheRead)}</div></div>
          <div className="crail-tile"><div className="crail-tile-k">cache write</div><div className="crail-tile-v">{fmtTokens(tokens.cacheWrite)}</div></div>
        </div>
        <div className="crail-price-row">
          <span>Est. list price</span>
          <span className="crail-price">{formatCost(cost)}</span>
        </div>
      </div>
    </aside>
  )
}

/** 46px collapsed strip: expand button, a Files icon, and an amber dot when the
 *  project has uncommitted changes. */
export function ContextRailStrip({ fsEntries, view, pinCount, onExpand, onOpenView }: {
  fsEntries: FsEntry[]
  view: RailView
  pinCount: number
  onExpand: () => void
  onOpenView: (view: RailView) => void
}) {
  const dirty = fsEntries.some(e => e.git)
  return (
    <aside className="crail-collapsed" aria-label="Files & usage (collapsed)">
      <button type="button" className="crail-strip-expand" title="Expand rail" aria-label="Expand context rail"
        onClick={onExpand}>«</button>
      <UpdateIcon />
      <div className="crail-strip-div" />
      <button type="button" className={`crail-strip-icon${view === 'pins' ? ' active' : ''}`} title={pinCount > 0 ? `Pinned messages (${pinCount})` : 'Pinned messages'} aria-label="Pinned messages" onClick={() => onOpenView('pins')}><PinIcon /></button>
      <button type="button" className={`crail-strip-icon${view === 'files' ? ' active' : ''}`} title="Files" aria-label="Files" onClick={() => onOpenView('files')}>🗀</button>
      {dirty && <span className="crail-strip-dot" title="Uncommitted changes" aria-hidden="true" style={{ marginTop: 'auto' }} />}
    </aside>
  )
}
