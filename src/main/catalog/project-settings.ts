import type { Catalog } from './db'
import type { ProjectSettings, ThinkingDisplay, ToolDisplay } from '../../shared/project-options'
import { THINKING_DISPLAYS, TOOL_DISPLAYS } from '../../shared/project-options'

/** One set of settings per project: every chat in a folder shares them, because a
 *  folder is one row in the chat list. A stored value that doesn't validate is
 *  dropped rather than trusted. */
function clean(raw: unknown): ProjectSettings {
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: ProjectSettings = {}
  if (typeof r.model === 'string' && r.model.length > 0) out.model = r.model
  if (typeof r.effort === 'string' && r.effort.length > 0) out.effort = r.effort
  if (typeof r.skipPermissions === 'boolean') out.skipPermissions = r.skipPermissions
  if (typeof r.promptSuggestions === 'boolean') out.promptSuggestions = r.promptSuggestions
  if (typeof r.filesExpanded === 'boolean') out.filesExpanded = r.filesExpanded
  if (TOOL_DISPLAYS.includes(r.toolDisplay as ToolDisplay)) out.toolDisplay = r.toolDisplay as ToolDisplay
  if (THINKING_DISPLAYS.includes(r.thinkingDisplay as ThinkingDisplay)) out.thinkingDisplay = r.thinkingDisplay as ThinkingDisplay
  if (Array.isArray(r.extraDirs)) {
    const dirs = r.extraDirs.filter((d): d is string => typeof d === 'string' && d.length > 0)
    if (dirs.length > 0) out.extraDirs = dirs
  }
  return out
}

function parsed(json: string | undefined): ProjectSettings {
  if (json === undefined) return {}
  try { return clean(JSON.parse(json)) } catch { return {} }
}

/** The settings of the project this chat belongs to. */
export function getProjectSettings(db: Catalog, sessionPk: number): ProjectSettings {
  const row = db.prepare(`
    SELECT ps.json FROM project_settings ps JOIN sessions s ON s.project_id = ps.project_id WHERE s.id = ?
  `).get(sessionPk) as { json: string } | undefined
  return parsed(row?.json)
}

/** By the project's folder name under ~/.claude/projects, for a chat not created yet. */
export function getProjectSettingsByDir(db: Catalog, dirName: string): ProjectSettings {
  const row = db.prepare(`
    SELECT ps.json FROM project_settings ps JOIN projects p ON p.id = ps.project_id WHERE p.dir_name = ?
  `).get(dirName) as { json: string } | undefined
  return parsed(row?.json)
}

/** Merges `patch` into the settings of the project this chat belongs to. A field set
 *  to undefined goes back to following Settings. */
export function updateProjectSettings(db: Catalog, sessionPk: number, patch: Partial<Record<keyof ProjectSettings, unknown>>): ProjectSettings {
  const session = db.prepare('SELECT project_id AS projectId FROM sessions WHERE id = ?').get(sessionPk) as { projectId: number } | undefined
  if (session === undefined) return {}
  const next = clean({ ...getProjectSettings(db, sessionPk), ...patch })
  db.prepare('INSERT INTO project_settings (project_id, json) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET json = excluded.json')
    .run(session.projectId, JSON.stringify(next))
  return next
}
