import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChannelRow } from '../../shared/types'
import type { ChannelIcon, ChannelGroup } from '../../shared/shell-types'
import type { ProjectSyncState } from '../../shared/sync-types'
import { resolveChannelName, clampMenuPosition } from '../lib'
import { IconPicker } from './IconPicker'

type View = 'menu' | 'rename' | 'move' | 'newGroup' | 'renameGroup' | 'icon'

/** Right-click menu for a nav channel row (Plan 3 Task 2): Rename (inline
 *  text edit), Favorite/Unfavorite, Move to group (submenu: existing groups
 *  + New group... + Remove from group + per-group delete), and Change icon
 *  (opens IconPicker). Positioned at the click point, then clamped fully
 *  on-screen via the pure `clampMenuPosition` once its real size is known
 *  (useLayoutEffect, before paint, so there's no visible jump). Closes on an
 *  outside click or Esc.
 *
 *  REQUIRES HUMAN VERIFICATION: the interactive menu chrome (open/close,
 *  submenu navigation, click-outside dismissal, on-screen clamping against a
 *  REAL measured menu size) is DOM-only and cannot be exercised by vitest --
 *  clampMenuPosition's own math is unit-tested in tests/renderer-lib.test.ts. */
export function ChannelContextMenu({
  channel, groups, x, y, onClose, onRename, onShowInExplorer, onManageMemory, onToggleStar, onMoveToGroup, onCreateGroup, onDeleteGroup,
  onRenameGroup, onSetGroupIcon, onSetIcon, onToggleHidden, onDeleteChannel, onDeleteChat, sync, onSync
}: {
  channel: ChannelRow
  groups: ChannelGroup[]
  x: number
  y: number
  onClose: () => void
  onRename: (dirName: string, name: string | null) => void
  onShowInExplorer: (channel: ChannelRow) => void
  onManageMemory: (channel: ChannelRow) => void
  onToggleStar: (dirName: string, starred: boolean) => void
  onMoveToGroup: (dirName: string, groupId: number | null) => void
  onCreateGroup: (name: string) => Promise<number>
  onDeleteGroup: (groupId: number) => void
  onRenameGroup: (groupId: number, name: string) => void
  onSetGroupIcon: (groupId: number, icon: ChannelIcon) => void
  onSetIcon: (dirName: string, icon: ChannelIcon) => void
  onToggleHidden: (dirName: string, hidden: boolean) => void
  /** Opens the Delete wizard for the whole project (Claude's data only). */
  onDeleteChannel: (dirName: string) => void
  /** Opens the Delete wizard for one chat (the open one, else the latest). */
  onDeleteChat: (channel: ChannelRow) => void
  /** Sync's state for this project; no value leaves the item out. */
  sync: ProjectSyncState | null
  onSync: (state: ProjectSyncState) => void
}) {
  const [view, setView] = useState<View>('menu')
  const [renameValue, setRenameValue] = useState(() => resolveChannelName(channel.meta, channel.cwd, channel.dirName))
  const [newGroupName, setNewGroupName] = useState('')
  // Which group the 'renameGroup' view is editing, plus its in-progress name.
  const [groupEdit, setGroupEdit] = useState<{ id: number; name: string } | null>(null)
  // Which group's icon the IconPicker is currently editing (null = not open).
  const [groupIconId, setGroupIconId] = useState<number | null>(null)
  const [pos, setPos] = useState({ x, y })
  const menuRef = useRef<HTMLDivElement>(null)

  // Clamp on-screen using the ACTUAL rendered menu size (varies by view --
  // the "move" submenu with many groups is taller than the base menu).
  useLayoutEffect(() => {
    const el = menuRef.current
    if (el === null) return
    const { width, height } = el.getBoundingClientRect()
    setPos(clampMenuPosition(x, y, width, height, window.innerWidth, window.innerHeight))
  }, [x, y, view])

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) onClose()
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [onClose])

  function submitRename() {
    const trimmed = renameValue.trim()
    onRename(channel.dirName, trimmed.length === 0 ? null : trimmed)
    onClose()
  }

  async function submitNewGroup() {
    const trimmed = newGroupName.trim()
    if (trimmed.length === 0) return
    const id = await onCreateGroup(trimmed)
    onMoveToGroup(channel.dirName, id)
    onClose()
  }

  function submitRenameGroup() {
    if (groupEdit === null) return
    const trimmed = groupEdit.name.trim()
    if (trimmed.length > 0) onRenameGroup(groupEdit.id, trimmed)
    setView('move')
  }

  if (view === 'icon') {
    return (
      <IconPicker current={channel.meta.icon}
        onCancel={onClose}
        onApply={icon => { onSetIcon(channel.dirName, icon); onClose() }} />
    )
  }

  if (groupIconId !== null) {
    const g = groups.find(gr => gr.id === groupIconId)
    if (g !== undefined) {
      return (
        <IconPicker current={g.icon}
          onCancel={() => setGroupIconId(null)}
          onApply={icon => { onSetGroupIcon(g.id, icon); onClose() }} />
      )
    }
  }

  return (
    <div ref={menuRef} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu"
      aria-label={`Options for ${resolveChannelName(channel.meta, channel.cwd, channel.dirName)}`}>
      {view === 'menu' && (
        <>
          <button type="button" className="ctx-item" role="menuitem" onClick={() => setView('rename')}>Rename</button>
          <button type="button" className="ctx-item" role="menuitem" disabled={channel.cwd === null}
            onClick={() => { onShowInExplorer(channel); onClose() }}>Show in Explorer</button>
          <button type="button" className="ctx-item" role="menuitem"
            onClick={() => { onManageMemory(channel); onClose() }}>Manage memory (CLAUDE.md)…</button>
          <button type="button" className="ctx-item" role="menuitem"
            onClick={() => { onToggleStar(channel.dirName, !channel.meta.starred); onClose() }}>
            {channel.meta.starred ? 'Unfavorite' : 'Favorite'}
          </button>
          <button type="button" className="ctx-item" role="menuitem" onClick={() => setView('move')}>Move to group ▸</button>
          <button type="button" className="ctx-item" role="menuitem" onClick={() => setView('icon')}>Change icon ▸</button>
          {sync !== null && (
            <button type="button" className="ctx-item" role="menuitem" onClick={() => { onSync(sync); onClose() }}>
              {sync.kind === 'on' ? 'Stop syncing' : 'Sync this project…'}
            </button>
          )}
          <div className="ctx-sep" />
          <button type="button" className="ctx-item" role="menuitem"
            onClick={() => { onToggleHidden(channel.dirName, !channel.meta.hidden); onClose() }}>
            {channel.meta.hidden ? 'Unhide' : 'Hide from list'}
          </button>
          <div className="ctx-sep" />
          <button type="button" className="ctx-item ctx-danger" role="menuitem"
            onClick={() => { onDeleteChat(channel); onClose() }}>
            {channel.sessionCount > 1 ? 'Delete latest chat…' : 'Delete chat…'}
          </button>
          <button type="button" className="ctx-item ctx-danger" role="menuitem"
            onClick={() => { onDeleteChannel(channel.dirName); onClose() }}>
            Delete project…
          </button>
        </>
      )}

      {view === 'rename' && (
        <div className="ctx-rename-wrap">
          <input className="ctx-rename-input" autoFocus type="text" value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') onClose() }} />
          <div className="ctx-rename-hint">Clear the field to use the default name.</div>
          <div className="modal-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={() => setView('menu')}>Back</button>
            <button type="button" className="btn-primary" onClick={submitRename}>Save</button>
          </div>
        </div>
      )}

      {view === 'move' && (
        <>
          <button type="button" className="ctx-item ctx-back" role="menuitem" onClick={() => setView('menu')}>‹ Back</button>
          <div className="ctx-sep" />
          {channel.meta.groupId !== null && (
            <button type="button" className="ctx-item" role="menuitem"
              onClick={() => { onMoveToGroup(channel.dirName, null); onClose() }}>
              Remove from group
            </button>
          )}
          {groups.map(g => (
            <div key={g.id} className="ctx-group-row">
              <button type="button" className="ctx-item" role="menuitem"
                onClick={() => { onMoveToGroup(channel.dirName, g.id); onClose() }}>
                {g.name}{channel.meta.groupId === g.id ? ' ✓' : ''}
              </button>
              <button type="button" className="ctx-group-edit" title={`Rename group "${g.name}"`}
                aria-label={`Rename group ${g.name}`}
                onClick={() => { setGroupEdit({ id: g.id, name: g.name }); setView('renameGroup') }}>✎</button>
              <button type="button" className="ctx-group-edit" title={`Set icon for "${g.name}"`}
                aria-label={`Set icon for ${g.name}`} onClick={() => setGroupIconId(g.id)}>🎨</button>
              <button type="button" className="ctx-group-del" title={`Delete group "${g.name}"`}
                aria-label={`Delete group ${g.name}`}
                onClick={() => onDeleteGroup(g.id)}>✕</button>
            </div>
          ))}
          <div className="ctx-sep" />
          <button type="button" className="ctx-item" role="menuitem" onClick={() => setView('newGroup')}>New group…</button>
        </>
      )}

      {view === 'renameGroup' && groupEdit !== null && (
        <div className="ctx-newgroup-wrap">
          <input className="ctx-newgroup-input" autoFocus type="text" placeholder="Group name" value={groupEdit.name}
            onChange={e => setGroupEdit({ id: groupEdit.id, name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') submitRenameGroup(); if (e.key === 'Escape') setView('move') }} />
          <div className="modal-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={() => setView('move')}>Back</button>
            <button type="button" className="btn-primary" disabled={groupEdit.name.trim().length === 0}
              onClick={submitRenameGroup}>Save</button>
          </div>
        </div>
      )}

      {view === 'newGroup' && (
        <div className="ctx-newgroup-wrap">
          <input className="ctx-newgroup-input" autoFocus type="text" placeholder="Group name" value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submitNewGroup(); if (e.key === 'Escape') setView('move') }} />
          <div className="modal-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={() => setView('move')}>Back</button>
            <button type="button" className="btn-primary" disabled={newGroupName.trim().length === 0}
              onClick={() => void submitNewGroup()}>Create</button>
          </div>
        </div>
      )}
    </div>
  )
}
