import type { Catalog } from './db'
import type { ChannelMeta, ChannelIcon, ChannelGroup } from '../../shared/shell-types'

const DEFAULT_ICON: ChannelIcon = { kind: 'initials' }

// icon_json is user/renderer-influenced (round-tripped through IPC + JSON
// storage), so it's treated as untrusted input here: absent, malformed JSON,
// a non-object, an unknown `kind`, or a kind whose required field is missing
// or the wrong type all fall back to the safe default rather than throwing --
// a corrupt row must never break the nav.
function parseIcon(json: string | null): ChannelIcon {
  if (json === null) return DEFAULT_ICON

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return DEFAULT_ICON
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_ICON

  const obj = parsed as Record<string, unknown>
  switch (obj.kind) {
    case 'initials':
      return { kind: 'initials' }
    case 'emoji':
      return typeof obj.emoji === 'string' ? { kind: 'emoji', emoji: obj.emoji } : DEFAULT_ICON
    case 'color':
      return typeof obj.color === 'string' ? { kind: 'color', color: obj.color } : DEFAULT_ICON
    case 'image':
      return typeof obj.dataUrl === 'string' ? { kind: 'image', dataUrl: obj.dataUrl } : DEFAULT_ICON
    default:
      return DEFAULT_ICON
  }
}

type ChannelMetaRow = {
  dir_name: string
  friendly_name: string | null
  starred: number
  group_id: number | null
  icon_json: string | null
  hidden: number
}

const SELECT_COLUMNS = 'dir_name, friendly_name, starred, group_id, icon_json, hidden'

function rowToMeta(row: ChannelMetaRow): ChannelMeta {
  return {
    dirName: row.dir_name,
    friendlyName: row.friendly_name,
    starred: row.starred === 1,
    // Not validated against channel_groups here on purpose: a group_id left
    // dangling by anything other than deleteGroup's transaction (or the
    // schema's own ON DELETE SET NULL) should still read back cleanly rather
    // than throw -- the nav can treat an unresolvable group like "ungrouped".
    groupId: row.group_id,
    icon: parseIcon(row.icon_json),
    hidden: row.hidden === 1
  }
}

function defaultMeta(dirName: string): ChannelMeta {
  return { dirName, friendlyName: null, starred: false, groupId: null, icon: DEFAULT_ICON, hidden: false }
}

function ensureRow(db: Catalog, dirName: string): void {
  db.prepare('INSERT INTO channel_meta (dir_name) VALUES (?) ON CONFLICT(dir_name) DO NOTHING').run(dirName)
}

export function getChannelMeta(db: Catalog, dirName: string): ChannelMeta {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM channel_meta WHERE dir_name = ?`)
    .get(dirName) as ChannelMetaRow | undefined
  return row === undefined ? defaultMeta(dirName) : rowToMeta(row)
}

export function setFriendlyName(db: Catalog, dirName: string, name: string | null): void {
  // An empty (or whitespace-only, once trimmed) name means "no custom name" --
  // store null so getChannelMeta/resolveChannelDisplay fall back to the
  // derived channel name instead of showing a blank.
  const trimmed = name === null ? null : name.trim()
  const value = trimmed === null || trimmed.length === 0 ? null : trimmed
  ensureRow(db, dirName)
  db.prepare('UPDATE channel_meta SET friendly_name = ? WHERE dir_name = ?').run(value, dirName)
}

export function setStarred(db: Catalog, dirName: string, starred: boolean): void {
  ensureRow(db, dirName)
  db.prepare('UPDATE channel_meta SET starred = ? WHERE dir_name = ?').run(starred ? 1 : 0, dirName)
}

export function setChannelIcon(db: Catalog, dirName: string, icon: ChannelIcon): void {
  ensureRow(db, dirName)
  db.prepare('UPDATE channel_meta SET icon_json = ? WHERE dir_name = ?').run(JSON.stringify(icon), dirName)
}

export function setChannelGroup(db: Catalog, dirName: string, groupId: number | null): void {
  ensureRow(db, dirName)
  db.prepare('UPDATE channel_meta SET group_id = ? WHERE dir_name = ?').run(groupId, dirName)
}

export function setHidden(db: Catalog, dirName: string, hidden: boolean): void {
  ensureRow(db, dirName)
  db.prepare('UPDATE channel_meta SET hidden = ? WHERE dir_name = ?').run(hidden ? 1 : 0, dirName)
}

export function allChannelMeta(db: Catalog): Map<string, ChannelMeta> {
  const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM channel_meta`).all() as ChannelMetaRow[]
  const map = new Map<string, ChannelMeta>()
  for (const row of rows) map.set(row.dir_name, rowToMeta(row))
  return map
}

export function listGroups(db: Catalog): ChannelGroup[] {
  const rows = db.prepare('SELECT id, name, sort_order AS sortOrder, icon_json FROM channel_groups ORDER BY sort_order, id')
    .all() as { id: number; name: string; sortOrder: number; icon_json: string | null }[]
  return rows.map(r => ({ id: r.id, name: r.name, sortOrder: r.sortOrder, icon: parseIcon(r.icon_json) }))
}

export function setGroupIcon(db: Catalog, id: number, icon: ChannelIcon): void {
  db.prepare('UPDATE channel_groups SET icon_json = ? WHERE id = ?').run(JSON.stringify(icon), id)
}

export function createGroup(db: Catalog, name: string): number {
  const info = db.prepare('INSERT INTO channel_groups (name) VALUES (?)').run(name)
  return Number(info.lastInsertRowid)
}

export function renameGroup(db: Catalog, id: number, name: string): void {
  db.prepare('UPDATE channel_groups SET name = ? WHERE id = ?').run(name, id)
}

export function deleteGroup(db: Catalog, id: number): void {
  // Explicit in one transaction rather than relying solely on the schema's
  // ON DELETE SET NULL: it documents the ungrouping as part of the delete's
  // contract, and keeps the behavior correct even on a connection where FK
  // enforcement was ever off. Same transaction means a mid-failure rolls
  // back to "group and its members both still there" rather than leaving
  // channels ungrouped with the group itself still present (or vice versa).
  const tx = db.transaction(() => {
    db.prepare('UPDATE channel_meta SET group_id = NULL WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM channel_groups WHERE id = ?').run(id)
  })
  tx()
}
