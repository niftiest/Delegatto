import { RemoteBadge } from './RemoteBadge'
import type { ProjectSyncState } from '../../shared/sync-types'
import { useEffect, useState } from 'react'
import type { ChannelRow } from '../../shared/types'
import { plainPreview, resolveChannelName, resolveChannelIcon, relativeTime, type NavSection, type ResolvedIcon } from '../lib'

/** Renders a single channel's circular avatar per its ResolvedIcon: the
 *  initials-default (deterministic text + background color, same look the
 *  pre-metadata nav always had), an emoji on a neutral background, a flat
 *  color swatch, or an uploaded image (cropped to fill the circle). */
function ChannelAvatar({ icon }: { icon: ResolvedIcon }) {
  switch (icon.kind) {
    case 'initials':
      return <span className="ch-avatar" style={{ background: icon.color }} aria-hidden="true">{icon.text}</span>
    case 'emoji':
      return <span className="ch-avatar ch-avatar-emoji" aria-hidden="true">{icon.emoji}</span>
    case 'color':
      return <span className="ch-avatar" style={{ background: icon.color }} aria-hidden="true" />
    case 'image':
      return <span className="ch-avatar" aria-hidden="true"><img src={icon.dataUrl} alt="" /></span>
  }
}

function RepoIcon({ repo }: { repo: string }) {
  const label = `Linked to GitHub: ${repo}`
  return (
    <span className="ch-repo" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    </span>
  )
}

function ChannelItem({ channel, selected, unread, remote, synced, showRepo, onSelect, onContextMenu }: {
  synced: boolean
  channel: ChannelRow
  selected: boolean
  unread: boolean
  remote: boolean
  showRepo: boolean
  onSelect: (channel: ChannelRow) => void
  onContextMenu: (channel: ChannelRow, x: number, y: number) => void
}) {
  const name = resolveChannelName(channel.meta, channel.cwd, channel.dirName)
  const icon = resolveChannelIcon(channel.meta, name)
  return (
    <div className={`ch${unread ? ' unread' : ''}`} role="option" tabIndex={0} title={name} data-channel={channel.id}
      aria-selected={selected}
      onClick={() => onSelect(channel)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(channel) } }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(channel, e.clientX, e.clientY) }}>
      <span className="ch-avatar-wrap">
        <ChannelAvatar icon={icon} />
        {remote && <RemoteBadge className="rc-badge-nav" />}
      </span>
      <div className="ch-body">
        <div className="ch-top">
          <span className="ch-name">{name}</span>
          {showRepo && channel.repo != null && <RepoIcon repo={channel.repo} />}
          {synced && <span className="ch-synced" role="img" aria-label="Syncing across your PCs" title="Syncing across your PCs">⟳</span>}
          {channel.meta.starred && <span className="ch-star" aria-label="Starred" title="Starred">★</span>}
          <time className="ch-time">{relativeTime(channel.lastActivity)}</time>
        </div>
        <div className="ch-preview">
          {(channel.preview !== null && channel.preview !== undefined ? plainPreview(channel.preview) : null) ?? `${channel.sessionCount} session${channel.sessionCount === 1 ? '' : 's'}`}
        </div>
      </div>
      {unread && <span className="ch-unread-badge" aria-label="Unread messages" title="Unread messages" />}
    </div>
  )
}

/** One collapsible section (Starred / a named group / Ungrouped). Section
 *  collapse state is purely local UI state (not persisted) -- reopening the
 *  app always shows every section expanded. */
function Section({ reveal, section, selectedId, unread, remote, syncStates, showRepos, onSelect, onContextMenu, defaultCollapsed = false }: {
  syncStates: ReadonlyMap<number, ProjectSyncState>
  reveal: number | null
  showRepos: boolean
  section: NavSection
  selectedId: number | null
  unread: Set<number>
  remote: Set<number>
  onSelect: (channel: ChannelRow) => void
  onContextMenu: (channel: ChannelRow, x: number, y: number) => void
  defaultCollapsed?: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  // Can't be brought into view while its section is shut.
  useEffect(() => {
    if (reveal !== null && section.channels.some(c => c.id === reveal)) setCollapsed(false)
  }, [reveal])
  return (
    <div className="nav-section">
      <button type="button" className="nav-section-head" aria-expanded={!collapsed}
        onClick={() => setCollapsed(c => !c)}>
        <span className={`nav-section-caret${collapsed ? ' collapsed' : ''}`} aria-hidden="true">▾</span>
        {section.kind === 'starred' && <span className="nav-section-star" aria-hidden="true">★</span>}
        <span>{section.title}</span>
        <span className="nav-sub" style={{ marginLeft: 'auto' }}>{section.channels.length}</span>
      </button>
      {!collapsed && (
        section.channels.length === 0
          ? <div className="nav-section-empty">No chats here yet.</div>
          : section.channels.map(c => (
            <ChannelItem key={c.id} channel={c} selected={c.id === selectedId} unread={unread.has(c.id)} remote={remote.has(c.id)} synced={syncStates.get(c.id)?.kind === 'on'} showRepo={showRepos}
              onSelect={onSelect} onContextMenu={onContextMenu} />
          ))
      )}
    </div>
  )
}

/** Renders the nav's sectioned model (Plan 3 Task 2): a Starred section
 *  pinning favorites at the top, each user group (in sortOrder) below it,
 *  and an Ungrouped section last -- exactly what `groupChannels`
 *  (src/renderer/lib.ts) computes. Right-clicking a row surfaces
 *  `onContextMenu`, which Nav.tsx wires to ChannelContextMenu. */
export function GroupedNav({ reveal = null, sections, selectedId, unread, remote = new Set<number>(), syncStates, showRepos = false, onSelect, onContextMenu }: {
  syncStates: ReadonlyMap<number, ProjectSyncState>
  reveal?: number | null
  /** Show which projects are linked to a GitHub repo: only when the GitHub CLI is ready. */
  showRepos?: boolean
  sections: NavSection[]
  selectedId: number | null
  unread: Set<number>
  remote?: Set<number>
  onSelect: (channel: ChannelRow) => void
  onContextMenu: (channel: ChannelRow, x: number, y: number) => void
}) {
  return (
    <>
      {sections.map(s => (
        <Section key={s.kind === 'group' ? `group:${s.groupId}` : s.kind === 'time' ? `time:${s.bucket}` : s.kind}
          reveal={reveal} section={s} selectedId={selectedId} unread={unread} remote={remote} syncStates={syncStates} showRepos={showRepos} onSelect={onSelect} onContextMenu={onContextMenu}
          defaultCollapsed={s.kind === 'hidden' || s.kind === 'archived'} />
      ))}
    </>
  )
}
