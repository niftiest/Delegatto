import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { ChannelRow, SessionSummary } from '../../shared/types'
import type { PlanUsage } from '../../shared/plan-usage'
import type { ChannelIcon, ChannelGroup } from '../../shared/shell-types'
import type { ProjectSyncState, SyncOffer } from '../../shared/sync-types'
import { CLAUDE_SETUP_URL, groupChannels } from '../lib'
import { formatCostWhole } from '../../shared/models'
import { GroupedNav } from './GroupedNav'
import { UsageFooter } from './UsageFooter'
import { useFollowSelected, useRevealChannel } from './useRevealChannel'
import { ChannelContextMenu } from './ChannelContextMenu'

/** Chats running and elevation level, which used to fill the footer. Hidden for now,
 *  kept in case they're wanted later. */
export const SHOW_NAV_STATUS: boolean = false

/** Nothing to list, and why. Delegatto only shows Claude Code's chats, which a person using
 *  claude.ai or the desktop app has none of. Looks again when the window comes back, in case
 *  they've just gone off to install it; chats themselves turn up by themselves. */
function EmptyProjects() {
  const [found, setFound] = useState<boolean | null>(null)
  useEffect(() => {
    const check = (): void => { void api.claudeFound().then(setFound).catch(() => {}) }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  if (found === null) return null
  return (
    <div className="empty nav-empty">
      <div className="nav-empty-title">{found ? 'No Claude Code chats yet' : "Claude Code isn't installed, or Delegatto can't find it"}</div>
      <p>{found ? 'Press + above to start one. Chats you have in Claude Code will appear here by themselves.' : 'Delegatto shows chats from Claude Code, so it needs that installed.'}</p>
      <p>Chats on claude.ai or in the Claude desktop app aren't stored on this PC, so they won't appear here.</p>
      {!found && <a href={CLAUDE_SETUP_URL} onClick={e => { e.preventDefault(); void api.openLink(CLAUDE_SETUP_URL) }}>How to install Claude Code</a>}
    </div>
  )
}

export function Nav({
  reveal = null, onRevealed, channels, groups, selectedId, width, unread, remote, showRepos, totalCost, elevated, activeChats, planUsage, session, onSelect, onShowInExplorer, onManageMemory, onNewChat, onOpenSearch, onOpenManage, onOpenSettings, onCollapse, onOpenPool,
  onRename, onToggleStar, onMoveToGroup, onCreateGroup, onDeleteGroup, onRenameGroup, onSetGroupIcon, onSetIcon,
  onToggleHidden, onDeleteChannel, onDeleteChat, syncOffer, onOpenSyncOffer, onDismissSyncOffer, syncStates, onSyncProject
}: {
  /** A project to bring into view, opened from outside this list. */
  reveal?: number | null
  onRevealed?: () => void
  channels: ChannelRow[]
  groups: ChannelGroup[]
  selectedId: number | null
  width: number
  /** Channel ids with unread activity (App-owned) -- rendered with a glow. */
  unread: Set<number>
  /** Project ids holding a chat under Remote Control (/rc). */
  remote?: Set<number>
  /** The GitHub CLI is installed and signed in, so repo links are shown. */
  showRepos?: boolean
  /** Total estimated USD cost across all sessions, shown in the header subline. */
  totalCost: number
  /** Running elevated (Windows) -- surfaces the ADMIN badge in the footer strip. */
  elevated: boolean
  /** Live engine count for the footer strip (opens the pool HUD). */
  activeChats: number
  planUsage: PlanUsage
  /** The open chat, whose tokens and cost the footer shows on an API key. */
  session: SessionSummary | null
  onSelect: (channel: ChannelRow) => void
  /** Opens the New-Chat dialog (Plan 2 Task 8) -- the "+" in the list header. */
  onShowInExplorer: (channel: ChannelRow) => void
  onManageMemory: (channel: ChannelRow) => void
  onNewChat: () => void
  onOpenManage: () => void
  onOpenSettings: () => void
  onCollapse: () => void
  /** Opens the global search overlay (also reachable from the rail + Ctrl+K). */
  onOpenSearch: () => void
  /** Opens the engine pool HUD from the footer strip. */
  onOpenPool: () => void
  /** Plan 3 Task 2 editing callbacks, wired by App.tsx to the metadata IPC
   *  (optimistic local update + persist -- see App's handlers for the
   *  precise contract each one follows). */
  onRename: (dirName: string, name: string | null) => void
  onToggleStar: (dirName: string, starred: boolean) => void
  onMoveToGroup: (dirName: string, groupId: number | null) => void
  onCreateGroup: (name: string) => Promise<number>
  onDeleteGroup: (groupId: number) => void
  onRenameGroup: (groupId: number, name: string) => void
  onSetGroupIcon: (groupId: number, icon: ChannelIcon) => void
  onSetIcon: (dirName: string, icon: ChannelIcon) => void
  onToggleHidden: (dirName: string, hidden: boolean) => void
  onDeleteChannel: (dirName: string) => void
  onDeleteChat: (channel: ChannelRow) => void
  /** Something waiting on GitHub for this PC, if any. */
  syncOffer: SyncOffer | null
  onOpenSyncOffer: () => void
  onDismissSyncOffer: () => void
  /** Sync's state for each project it applies to, by id. */
  syncStates: ReadonlyMap<number, ProjectSyncState>
  onSyncProject: (state: ProjectSyncState) => void
}) {
  const totalSessions = channels.reduce((sum, c) => sum + c.sessionCount, 0)
  const sections = useMemo(() => groupChannels(channels, groups), [channels, groups])
  const [contextMenu, setContextMenu] = useState<{ channel: ChannelRow; x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useRevealChannel(listRef, reveal, onRevealed)
  useFollowSelected(listRef, sections, selectedId)

  return (
    <nav className="nav" aria-label="Channels" style={{ width }}>
      <header className="nav-head">
        <div className="nav-head-main">
          <h1 className="nav-title">Delegatto</h1>
          <p className="nav-sub">
            {channels.length} projects · {totalSessions} chats · {formatCostWhole(totalCost)}
          </p>
        </div>
        <div className="nav-head-actions">
          <button type="button" className="nav-new-chat" title="New chat" aria-label="New chat"
            onClick={onNewChat}>+</button>
        </div>
      </header>
      <button type="button" className="nav-search" onClick={onOpenSearch}>
        <span aria-hidden="true">⌕</span>
        <span style={{ flex: 1, textAlign: 'left' }}>Search chats</span>
        <span className="nav-search-key">⌃K</span>
      </button>
      {syncOffer !== null && (
        <div className="sync-offer">
          <button type="button" className="sync-offer-text" onClick={onOpenSyncOffer}>{syncOffer.text}</button>
          <button type="button" className="sync-offer-close" aria-label="Dismiss" title="Dismiss" onClick={onDismissSyncOffer}>×</button>
        </div>
      )}
      {channels.length === 0 && <EmptyProjects />}
      <div className="nav-list" ref={listRef}>
        <GroupedNav reveal={reveal} sections={sections} selectedId={selectedId} unread={unread} remote={remote} syncStates={syncStates} showRepos={showRepos} onSelect={onSelect}
          onContextMenu={(channel, x, y) => setContextMenu({ channel, x, y })} />
      </div>
      <button type="button" className="nav-foot" onClick={onOpenPool} title="Open the list of running Claude processes">
        <div className="nav-foot-main">
          <UsageFooter usage={planUsage} session={session} />
          {SHOW_NAV_STATUS && <div className="nav-foot-sub">{activeChats === 0 ? 'No chats running actively' : `${activeChats} chat${activeChats === 1 ? '' : 's'} running actively`}</div>}
          {SHOW_NAV_STATUS && (
            <div className="nav-foot-sub" title={elevated ? 'Delegatto is running as Administrator, so its chats run with full admin rights' : 'Delegatto is not running as Administrator, so its chats run with normal rights'}>
              Chat elevation level: <span className={elevated ? 'elevation-admin' : undefined}>{elevated ? 'Administrator' : 'Regular'}</span>
            </div>
          )}
        </div>
      </button>
      <div className="nav-actions">
        <button type="button" className="iconrail-btn" title="Collapse chat list" aria-label="Collapse chat list" onClick={onCollapse}>«</button>
        <button type="button" className="iconrail-btn" title="Search (Ctrl+K)" aria-label="Search" onClick={onOpenSearch}>⌕</button>
        <button type="button" className="iconrail-btn" title="Manage Claude data (projects, notes, restore points)" aria-label="Manage" onClick={onOpenManage}>▤</button>
        <button type="button" className="iconrail-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>⚙</button>
      </div>
      {contextMenu !== null && (
        <ChannelContextMenu
          channel={contextMenu.channel}
          sync={syncStates.get(contextMenu.channel.id) ?? null}
          onSync={onSyncProject}
          groups={groups}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onRename={onRename}
          onShowInExplorer={onShowInExplorer}
          onManageMemory={onManageMemory}
          onToggleStar={onToggleStar}
          onMoveToGroup={onMoveToGroup}
          onCreateGroup={onCreateGroup}
          onDeleteGroup={onDeleteGroup}
          onRenameGroup={onRenameGroup}
          onSetGroupIcon={onSetGroupIcon}
          onSetIcon={onSetIcon}
          onToggleHidden={onToggleHidden}
          onDeleteChannel={onDeleteChannel} onDeleteChat={onDeleteChat}
        />
      )}
    </nav>
  )
}
