import type { Catalog } from './db'
import type { PinnedMessage } from '../../shared/engine-ipc-contract'

/** Messages the user has pinned, to come back to later. The app's own record: a transcript
 *  belongs to Claude Code, and a pin isn't something it knows about. */

const MAX_PINS = 500

/** Pins a message. False if the catalog doesn't have it (yet). */
export function pinMessage(db: Catalog, sessionPk: number, uuid: string, now: number): boolean {
  const found = db.prepare('SELECT 1 FROM messages WHERE session_pk = ? AND uuid = ?').get(sessionPk, uuid)
  if (found === undefined) return false
  db.prepare('INSERT INTO pinned_messages (session_pk, uuid, pinned_at) VALUES (?, ?, ?) ON CONFLICT(session_pk, uuid) DO NOTHING').run(sessionPk, uuid, now)
  return true
}

export function unpinMessage(db: Catalog, sessionPk: number, uuid: string): void {
  db.prepare('DELETE FROM pinned_messages WHERE session_pk = ? AND uuid = ?').run(sessionPk, uuid)
}

/** A project's pins, most recently pinned first. A message a rewind went past isn't part of
 *  its chat any more, so it doesn't show, though it comes back if that row ever does. */
export function listPins(db: Catalog, projectId: number): PinnedMessage[] {
  return db.prepare(`
    SELECT p.session_pk AS sessionPk, p.uuid, p.pinned_at AS pinnedAt, m.seq, m.role, m.ts,
           SUBSTR(m.text, 1, 400) AS text, COALESCE(s.custom_title, s.ai_title, s.title) AS chatTitle
    FROM pinned_messages p
    JOIN sessions s ON s.id = p.session_pk
    JOIN messages m ON m.session_pk = p.session_pk AND m.uuid = p.uuid
    WHERE s.project_id = ? AND m.rewound = 0
    ORDER BY p.pinned_at DESC, p.rowid DESC
    LIMIT ${MAX_PINS}
  `).all(projectId) as PinnedMessage[]
}
