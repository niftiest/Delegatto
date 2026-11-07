import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Catalog } from './db'
import { listSessions } from './repos'
import type { SessionSummary } from '../../shared/types'

/** Projects whose folder no longer exists: moved or deleted. Claude can't run in them, so
 *  they're shown as archived, read-only history. Nothing here deletes a chat: the catalog
 *  may hold the only copy left of one whose transcript has gone too. A folder coming back
 *  undoes all of this, since it's worked out afresh from the disk each time. */

type Exists = (path: string) => boolean

/** Only a folder on a drive that's present counts as gone: an unplugged drive doesn't mean
 *  its projects were moved. A network path can't be told apart from a share that's down. */
export function folderGone(cwd: string | null, exists: Exists = existsSync): boolean {
  if (cwd === null || cwd.length === 0) return false
  const drive = /^[A-Za-z]:[\\/]/.exec(cwd)
  if (drive === null || !exists(drive[0])) return false
  return !exists(cwd)
}

function nameOf(cwd: string): string {
  return basename(cwd.replace(/\\/g, '/').replace(/\/+$/, '')).toLowerCase()
}

/** The project's chats, leaving out any that also exist, at least as complete, in a project
 *  whose folder is still there: those moved with it, and belong there. */
export function chatsToShow(db: Catalog, projectId: number, exists: Exists = existsSync): SessionSummary[] {
  const sessions = listSessions(db, projectId)
  const row = db.prepare('SELECT cwd FROM projects WHERE id = ?').get(projectId) as { cwd: string | null } | undefined
  if (row === undefined || !folderGone(row.cwd, exists)) return sessions
  const copies = db.prepare(`
    SELECT p.cwd FROM sessions other
    JOIN projects p ON p.id = other.project_id
    WHERE other.session_id = ? AND other.kind = 'main' AND other.project_id <> ? AND other.message_count >= ?
  `)
  return sessions.filter(s => {
    const elsewhere = copies.all(s.sessionId, projectId, s.messageCount) as Array<{ cwd: string | null }>
    return !elsewhere.some(c => c.cwd !== null && c.cwd.length > 0 && !folderGone(c.cwd, exists) && exists(c.cwd))
  })
}

/** Search hits, leaving out chats hidden because they moved with their project. */
export function withoutMovedChats<T extends { sessionPk: number }>(db: Catalog, hits: T[], exists: Exists = existsSync): T[] {
  const known = new Map<number, boolean>()
  const inProject = db.prepare("SELECT project_id AS projectId FROM sessions WHERE id = ?")
  const shown = (pk: number): boolean => {
    const cached = known.get(pk)
    if (cached !== undefined) return cached
    const row = inProject.get(pk) as { projectId: number } | undefined
    const result = row === undefined || chatsToShow(db, row.projectId, exists).some(s => s.id === pk)
    known.set(pk, result)
    return result
  }
  return hits.filter(h => shown(h.sessionPk))
}

type MetaRow = { dir_name: string; friendly_name: string | null; starred: number; group_id: number | null; icon_json: string | null }

/** Gives a project that moved the star, name, icon and group left on its old row, wherever
 *  it doesn't already have its own. It's the old row's only if exactly one project still on
 *  disk has that folder name. `backup` runs once, before the first change. */
export function moveCustomisations(db: Catalog, backup: () => void, exists: Exists = existsSync): number {
  const projects = db.prepare('SELECT dir_name, cwd FROM projects').all() as Array<{ dir_name: string; cwd: string | null }>
  const live = projects.filter(p => p.cwd !== null && p.cwd.length > 0 && !folderGone(p.cwd, exists) && exists(p.cwd))
  const metaOf = db.prepare('SELECT dir_name, friendly_name, starred, group_id, icon_json FROM channel_meta WHERE dir_name = ?')
  const moves: Array<{ from: MetaRow; to: string; target: MetaRow | undefined }> = []
  for (const p of projects) {
    if (!folderGone(p.cwd, exists)) continue
    const from = metaOf.get(p.dir_name) as MetaRow | undefined
    if (from === undefined || (from.starred !== 1 && from.friendly_name === null && from.icon_json === null && from.group_id === null)) continue
    const twins = live.filter(q => nameOf(q.cwd!) === nameOf(p.cwd!))
    if (twins.length !== 1) continue
    const target = metaOf.get(twins[0]!.dir_name) as MetaRow | undefined
    const adds = (from.starred === 1 && target?.starred !== 1)
      || (from.friendly_name !== null && (target?.friendly_name ?? null) === null)
      || (from.icon_json !== null && (target?.icon_json ?? null) === null)
      || (from.group_id !== null && (target?.group_id ?? null) === null)
    if (adds) moves.push({ from, to: twins[0]!.dir_name, target })
  }
  if (moves.length === 0) return 0
  backup()
  db.transaction(() => {
    const save = db.prepare(`
      INSERT INTO channel_meta (dir_name, friendly_name, starred, group_id, icon_json) VALUES (@to, @name, @starred, @group, @icon)
      ON CONFLICT(dir_name) DO UPDATE SET friendly_name = @name, starred = @starred, group_id = @group, icon_json = @icon
    `)
    const clear = db.prepare(`
      UPDATE channel_meta SET
        friendly_name = CASE WHEN @movedName THEN NULL ELSE friendly_name END,
        starred = CASE WHEN @movedStar THEN 0 ELSE starred END,
        group_id = CASE WHEN @movedGroup THEN NULL ELSE group_id END,
        icon_json = CASE WHEN @movedIcon THEN NULL ELSE icon_json END
      WHERE dir_name = @from
    `)
    for (const { from, to, target } of moves) {
      const movedName = from.friendly_name !== null && (target?.friendly_name ?? null) === null
      const movedIcon = from.icon_json !== null && (target?.icon_json ?? null) === null
      const movedGroup = from.group_id !== null && (target?.group_id ?? null) === null
      const movedStar = from.starred === 1 && target?.starred !== 1
      save.run({
        to,
        name: movedName ? from.friendly_name : target?.friendly_name ?? null,
        starred: movedStar ? 1 : target?.starred ?? 0,
        group: movedGroup ? from.group_id : target?.group_id ?? null,
        icon: movedIcon ? from.icon_json : target?.icon_json ?? null
      })
      clear.run({ from: from.dir_name, movedName: movedName ? 1 : 0, movedIcon: movedIcon ? 1 : 0, movedGroup: movedGroup ? 1 : 0, movedStar: movedStar ? 1 : 0 })
    }
  })()
  return moves.length
}

/** A copy of the catalog, kept once: the first time anything in it is changed for this. */
export function backupCatalogOnce(db: Catalog, path: string, exists: Exists = existsSync): void {
  if (exists(path)) return
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
}

/** Text saved in the catalog that isn't part of the conversation. */
const NOT_CONVERSATION = [
  '<task-notification>', '[Request interrupted by user', 'No response requested.', '<local-command', '<command-',
  '<bash-std', '<system-reminder>', '[Image: ', 'Base directory for this skill:', 'This session is being continued from a previous conversation'
]

export function isConversationText(text: string | null): text is string {
  if (text === null || text.trim().length === 0) return false
  return !NOT_CONVERSATION.some(start => text.startsWith(start))
}
