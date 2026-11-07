import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../../shared/types'
import { clampMenuPosition } from '../lib'
import { RemoteBadge } from './RemoteBadge'

/** Right-click menu for one session in the list. */
function SessionMenu({ x, y, onDelete, onClose }: { x: number; y: number; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    if (ref.current === null) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos(clampMenuPosition(x, y, width, height, window.innerWidth, window.innerHeight))
  }, [x, y])
  useEffect(() => {
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) onClose() }
    // Ahead of everything else: behind this menu, Esc would stop Claude or take back a message.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation(); onClose()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu" aria-label="Session options">
      <button type="button" className="ctx-item ctx-danger" role="menuitem" onClick={() => { onDelete(); onClose() }}>Delete chat…</button>
    </div>
  )
}

export function Blade({ sessions, selectedId, remote = new Set<number>(), collapsed, width, onToggle, onSelect, onDelete }: {
  sessions: SessionSummary[]
  /** Session ids under Remote Control (/rc). */
  remote?: Set<number>
  selectedId: number | null
  collapsed: boolean
  width: number
  onToggle: () => void
  onSelect: (session: SessionSummary) => void
  /** Opens the Delete wizard for this one chat. */
  onDelete: (session: SessionSummary) => void
}) {
  const [menu, setMenu] = useState<{ session: SessionSummary; x: number; y: number } | null>(null)
  const closeMenu = useRef(() => setMenu(null)).current
  return (
    <aside className={collapsed ? 'blade collapsed' : 'blade'} aria-label="Sessions"
      style={collapsed ? undefined : { width }}>
      <button className="blade-toggle" onClick={onToggle}
        aria-expanded={!collapsed} title={collapsed ? 'Show sessions' : 'Hide sessions'}>
        {collapsed ? '▶' : `◀  SESSIONS — ${sessions.length}`}
      </button>
      {!collapsed && sessions.length === 0 && <div className="empty">No sessions in this project.</div>}
      {!collapsed && sessions.map(s => (
        <div key={s.id} className="sess" role="option" tabIndex={0}
          aria-selected={s.id === selectedId}
          onClick={() => onSelect(s)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s) } }}
          onContextMenu={e => { e.preventDefault(); setMenu({ session: s, x: e.clientX, y: e.clientY }) }}>
          <div className="sess-t">{remote.has(s.id) && <RemoteBadge className="rc-badge-inline" />}{s.title ?? `Untitled · ${s.sessionId.slice(0, 8)}`}</div>
          <div className="sess-m">
            <span>{s.lastTs?.slice(0, 10) ?? '—'}</span>
            <span>{s.messageCount} msg</span>
          </div>
        </div>
      ))}
      {menu !== null && <SessionMenu x={menu.x} y={menu.y} onDelete={() => onDelete(menu.session)} onClose={closeMenu} />}
    </aside>
  )
}
