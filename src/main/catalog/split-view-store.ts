import type { Catalog } from './db'
import { coerceSplitState, type SplitPane, type SplitState } from '../../shared/split-view'

const STORE_KEY = 'splitView'

/** The remembered split window, or null when there is none or it can't be read. A pane whose chat has since been deleted comes back empty. */
export function loadSplitState(db: Catalog): SplitState | null {
  const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(STORE_KEY) as { value: string } | undefined
  if (row === undefined) return null
  let parsed: unknown
  try { parsed = JSON.parse(row.value) } catch { return null }
  const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?')
  return coerceSplitState(parsed, pk => exists.get(pk) !== undefined)
}

export function saveSplitState(db: Catalog, s: SplitState): void {
  db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(STORE_KEY, JSON.stringify(s))
}

/** The panes as a window sent them, with each project taken from the catalog by the pane's
 *  chat, since one project per pane is checked on it. A pane whose chat isn't there, or isn't
 *  a pane at all, comes back empty. */
export function withPaneProjects(db: Catalog, panes: readonly unknown[]): SplitPane[] {
  const q = db.prepare('SELECT p.dir_name AS dirName FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?')
  return panes.map(pane => {
    if (typeof pane !== 'object' || pane === null) return null
    const pk = (pane as { sessionPk?: unknown }).sessionPk
    if (typeof pk !== 'number') return null
    const row = q.get(pk) as { dirName: string } | undefined
    return row === undefined ? null : { sessionPk: pk, projectDir: row.dirName }
  })
}

/** Each pane's project name for the window title: the given name, else the folder's name. Null for an empty slot or a chat that's gone. */
export function splitPaneNames(db: Catalog, panes: SplitPane[]): (string | null)[] {
  const q = db.prepare(`
    SELECT p.dir_name AS dirName, p.cwd AS cwd, m.friendly_name AS friendly
    FROM sessions s JOIN projects p ON p.id = s.project_id
    LEFT JOIN channel_meta m ON m.dir_name = p.dir_name
    WHERE s.id = ?`)
  return panes.map(pane => {
    if (pane === null) return null
    const row = q.get(pane.sessionPk) as { dirName: string; cwd: string | null; friendly: string | null } | undefined
    if (row === undefined) return null
    return row.friendly ?? (row.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? row.dirName)
  })
}
