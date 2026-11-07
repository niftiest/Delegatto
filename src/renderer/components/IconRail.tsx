import { RemoteBadge } from './RemoteBadge'
import { useRevealChannel } from './useRevealChannel'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelRow } from '../../shared/types'
import type { ChannelGroup } from '../../shared/shell-types'
import { resolveChannelName, resolveChannelIcon, resolveIconValue, groupChannels, type ResolvedIcon } from '../lib'

/** 68px icon rail -- the collapsed state of the sidebar, ordered the SAME way as
 *  the chat list (groupChannels): Starred first (star-badged), then each user
 *  group as a collapsible folder tile, then the rest by recency. Foot: search /
 *  Manage / settings / expand. */
function railIconStyle(icon: ResolvedIcon): React.CSSProperties {
  if (icon.kind === 'initials' || icon.kind === 'color') return { background: icon.color }
  if (icon.kind === 'emoji') return { background: 'var(--s3)', fontSize: 18 }
  return {}
}
function railIconInner(icon: ResolvedIcon): React.ReactNode {
  switch (icon.kind) {
    case 'initials': return icon.text
    case 'emoji': return icon.emoji
    case 'color': return null
    case 'image': return <img src={icon.dataUrl} alt="" />
  }
}

export function IconRail({
  reveal = null, onRevealed, channels, groups, selectedId, unread, remote = new Set<number>(), sidebarExpanded,
  onSelect, onToggleSidebar, onNewChat, onOpenSearch, onOpenSettings, onOpenManage, manageOpen = false
}: {
  /** A project to bring into view, opened from outside this list. */
  reveal?: number | null
  onRevealed?: () => void
  channels: ChannelRow[]
  groups: ChannelGroup[]
  selectedId: number | null
  unread: Set<number>
  /** Project ids holding a chat under Remote Control (/rc). */
  remote?: Set<number>
  sidebarExpanded: boolean
  onSelect: (channel: ChannelRow) => void
  onToggleSidebar: () => void
  onNewChat: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  /** Opens (or, when open, closes) the Manage screen. */
  onOpenManage: () => void
  manageOpen?: boolean
}) {
  const sections = useMemo(() => groupChannels(channels, groups), [channels, groups])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const toggleGroup = (id: number): void =>
    setCollapsed(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const scrollRef = useRef<HTMLDivElement>(null)
  useRevealChannel(scrollRef, reveal, onRevealed)
  useEffect(() => {
    if (reveal === null) return
    const home = sections.find(s => s.kind === 'group' && s.channels.some(c => c.id === reveal))
    if (home?.kind === 'group') setCollapsed(prev => { if (!prev.has(home.groupId)) return prev; const n = new Set(prev); n.delete(home.groupId); return n })
  }, [reveal])

  const avatar = (c: ChannelRow, starred: boolean): React.ReactNode => {
    const name = resolveChannelName(c.meta, c.cwd, c.dirName)
    const icon = resolveChannelIcon(c.meta, name)
    const active = c.id === selectedId
    return (
      <button key={c.id} type="button" data-channel={c.id}
        className={`iconrail-item${active ? ' active' : ''}${icon.kind === 'emoji' ? ' ch-avatar-emoji' : ''}${remote.has(c.id) ? ' has-rc' : ''}`}
        style={railIconStyle(icon)} title={name} aria-label={name} aria-current={active}
        onClick={() => onSelect(c)}>
        {railIconInner(icon)}
        {starred && <span className="iconrail-star" aria-hidden="true">★</span>}
        {remote.has(c.id) && <RemoteBadge className="rc-badge-rail" />}
        {!active && unread.has(c.id) && <span className="iconrail-badge" aria-hidden="true">●</span>}
      </button>
    )
  }

  return (
    <nav className="iconrail" aria-label="Projects">
      <div className="iconrail-scroll" ref={scrollRef}>
        {sections.map((s, si) => {
          if (s.kind === 'hidden' || s.kind === 'archived') return null
          const divider = si > 0 ? <div key={`d${si}`} className="iconrail-div" aria-hidden="true" /> : null
          if (s.kind === 'starred') {
            return <div key="starred" className="iconrail-sec">{divider}{s.channels.map(c => avatar(c, true))}</div>
          }
          if (s.kind === 'group') {
            const isCollapsed = collapsed.has(s.groupId)
            const gi = resolveIconValue(s.icon, s.title)
            return (
              <div key={`group:${s.groupId}`} className="iconrail-sec">
                {divider}
                <button type="button" className={`iconrail-grouptile${gi.kind === 'emoji' ? ' ch-avatar-emoji' : ''}`}
                  style={railIconStyle(gi)} title={`${s.title} (${s.channels.length})`}
                  aria-label={`${s.title}, ${isCollapsed ? 'expand' : 'collapse'}`} aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(s.groupId)}>{railIconInner(gi)}</button>
                {!isCollapsed && s.channels.map(c => avatar(c, false))}
              </div>
            )
          }
          // time buckets: just the avatars, in recency order
          return <div key={`time:${s.bucket}`} className="iconrail-sec">{divider}{s.channels.map(c => avatar(c, false))}</div>
        })}
        <button type="button" className="iconrail-item" style={{ background: 'var(--s1)', color: 'var(--good)', fontSize: 22, fontWeight: 300 }}
          title="New chat" aria-label="New chat" onClick={onNewChat}>+</button>
      </div>
      <div className="iconrail-foot">
        <button type="button" className="iconrail-btn" title="Search (Ctrl+K)" aria-label="Search" onClick={onOpenSearch}>⌕</button>
        <button type="button" className={`iconrail-btn${manageOpen ? ' active' : ''}`} title="Manage Claude data (projects, notes, restore points, sessions)"
          aria-label="Manage" aria-pressed={manageOpen} onClick={onOpenManage}>▤</button>
        <button type="button" className="iconrail-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>⚙</button>
        <button type="button" className="iconrail-btn"
          title={sidebarExpanded ? 'Collapse chat list' : 'Expand chat list'}
          aria-label={sidebarExpanded ? 'Collapse chat list' : 'Expand chat list'}
          onClick={onToggleSidebar}>{sidebarExpanded ? '«' : '»'}</button>
      </div>
    </nav>
  )
}
