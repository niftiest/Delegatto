import { rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Catalog } from './catalog/db'
import { claudeHome } from './indexer/discover'

export type DeleteChannelResult = { dirName: string; deletedSessions: number; deletedDir: string }

/**
 * PERMANENTLY delete a channel (one project directory): removes its whole
 * `<home>/projects/<dirName>/` tree from disk — every transcript, subagent
 * file, meta sidecar, and the memory/ subdir — and its catalog rows. This is
 * irreversible; the transcripts are gone from Claude Code too (no `--resume`).
 *
 * Safety:
 *  - The dir name is validated to be a single path segment that resolves
 *    strictly inside the projects root. A caller-supplied name containing a
 *    separator or `..` (or that otherwise escapes the root) is rejected before
 *    anything is touched — the renderer is not trusted to only send real slugs.
 *  - Files are removed BEFORE the catalog rows, so if the fs delete throws
 *    (e.g. a live `claude` still holds a transcript open) the catalog is left
 *    intact and the channel simply remains — the user can retry — rather than
 *    the row vanishing while the files linger.
 */
export function deleteChannel(db: Catalog, dirName: string, home: string = claudeHome()): DeleteChannelResult {
  if (typeof dirName !== 'string' || dirName.length === 0) {
    throw new Error('deleteChannel: empty dir name')
  }
  if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
    throw new Error(`deleteChannel: refusing suspicious dir name "${dirName}"`)
  }
  const projectsRoot = resolve(join(home, 'projects'))
  const target = resolve(join(projectsRoot, dirName))
  // Must be a direct child of the projects root — not the root itself, not an
  // escape via symlink-free path arithmetic.
  if (target === projectsRoot || !target.startsWith(projectsRoot + sep)) {
    throw new Error(`deleteChannel: "${dirName}" resolves outside the projects root`)
  }

  const countRow = db.prepare(
    `SELECT COUNT(*) AS c FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE p.dir_name = ? AND s.kind = 'main'`
  ).get(dirName) as { c: number }
  const deletedSessions = countRow.c

  // Files first (see doc comment): a throw here leaves the catalog untouched.
  rmSync(target, { recursive: true, force: true })

  // Then the catalog, atomically. Deleting the project cascades to its
  // sessions -> messages -> FTS (ON DELETE CASCADE + the messages_ad trigger);
  // channel_meta is keyed by dir_name (not an FK to projects) so it's removed
  // explicitly.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM projects WHERE dir_name = ?').run(dirName)
    db.prepare('DELETE FROM channel_meta WHERE dir_name = ?').run(dirName)
  })
  tx()

  return { dirName, deletedSessions, deletedDir: target }
}

/** Drops a project's catalog rows (sessions -> messages -> FTS cascade) and
 *  its channel metadata, WITHOUT touching disk -- for after the Delete wizard
 *  has removed the files itself (Recycle Bin, restore point, per-item report). */
export function removeProjectFromCatalog(db: Catalog, dirName: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM projects WHERE dir_name = ?').run(dirName)
    db.prepare('DELETE FROM channel_meta WHERE dir_name = ?').run(dirName)
  })()
}

/** Drops one chat's catalog rows: the main session and its subagent sessions
 *  (same session_id within the project), cascading to their messages. */
export function removeChatFromCatalog(db: Catalog, sessionPk: number): void {
  const row = db.prepare('SELECT project_id AS projectId, session_id AS sessionId FROM sessions WHERE id = ?')
    .get(sessionPk) as { projectId: number; sessionId: string } | undefined
  if (row === undefined) return
  db.prepare('DELETE FROM sessions WHERE project_id = ? AND session_id = ?').run(row.projectId, row.sessionId)
}

/** After a Manage rename moved `projects/<from>` to `projects/<to>`: carries
 *  the channel's metadata (friendly name, star, group, icon, hidden) over to
 *  the new folder name unless it already has its own, then drops the old
 *  catalog rows. The new folder's transcripts are picked up by the next
 *  external-change sweep. Disk is not touched. */
export function retireRenamedProject(db: Catalog, from: string, to: string): void {
  if (from === to) return
  db.transaction(() => {
    const has = db.prepare('SELECT 1 FROM channel_meta WHERE dir_name = ?').get(to) !== undefined
    if (!has) db.prepare('UPDATE channel_meta SET dir_name = ? WHERE dir_name = ?').run(to, from)
    db.prepare('DELETE FROM projects WHERE dir_name = ?').run(from)
    db.prepare('DELETE FROM channel_meta WHERE dir_name = ?').run(from)
  })()
}
