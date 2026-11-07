import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Catalog } from './db'
import { cwdToProjectDir } from '../indexer/discover'
import type { ProjectSummary, SessionSummary } from '../../shared/types'
import { costOfSession } from '../../shared/models'

export type SessionUpsert = {
  projectId: number; sessionId: string; kind: 'main' | 'subagent'; filePath: string
  fileSize: number; fileMtimeMs: number
  agentId?: string; toolUseId?: string; agentType?: string; agentDesc?: string
  title?: string; lastTs?: string; model?: string; gitBranch?: string
}

export function upsertProject(db: Catalog, dirName: string): number {
  db.prepare('INSERT INTO projects (dir_name) VALUES (?) ON CONFLICT(dir_name) DO NOTHING').run(dirName)
  const row = db.prepare('SELECT id FROM projects WHERE dir_name = ?').get(dirName) as { id: number }
  return row.id
}

/** The project's own folder, given a folder its chat recorded. Claude Code records the folder
 *  Claude is in on each line, which moves when it runs `cd`, but it names the project's
 *  directory after the folder the chat started in. So that folder is the one, of `cwd` and
 *  the folders above it, whose name matches. Null when none does. */
export function projectFolderFor(cwd: string, dirName: string): string | null {
  let current = cwd.replace(/[\\/]+$/, '')
  for (;;) {
    if (cwdToProjectDir(current) === dirName) return current
    const parent = dirname(current)
    if (parent === current || parent === '.') return null
    current = parent
  }
}

/** Keeps the project's own folder: a folder Claude moved into only counts through the
 *  project folder above it, and one that doesn't match is kept only while nothing better is known. */
export function setProjectCwd(db: Catalog, projectId: number, cwd: string): void {
  const row = db.prepare('SELECT dir_name, cwd FROM projects WHERE id = ?').get(projectId) as { dir_name: string; cwd: string | null } | undefined
  if (row === undefined) return
  const own = projectFolderFor(cwd, row.dir_name)
  if (own === null && row.cwd !== null) return
  const next = own ?? cwd
  if (next !== row.cwd) db.prepare('UPDATE projects SET cwd = ? WHERE id = ?').run(next, projectId)
}

/** Fixes a folder saved before setProjectCwd kept to the project's own (one Claude had `cd`'d into). */
export function repairProjectCwds(db: Catalog): number {
  const rows = db.prepare('SELECT id, dir_name, cwd FROM projects WHERE cwd IS NOT NULL').all() as Array<{ id: number; dir_name: string; cwd: string }>
  const update = db.prepare('UPDATE projects SET cwd = ? WHERE id = ?')
  let fixed = 0
  for (const r of rows) {
    if (cwdToProjectDir(r.cwd) === r.dir_name) continue
    const own = projectFolderFor(r.cwd, r.dir_name)
    if (own !== null) { update.run(own, r.id); fixed++ }
  }
  return fixed
}

export function upsertSession(db: Catalog, s: SessionUpsert): number {
  db.prepare(`
    INSERT INTO sessions (project_id, session_id, kind, agent_id, tool_use_id, agent_type, agent_desc,
                          file_path, file_size, file_mtime_ms, title, last_ts, model, git_branch)
    VALUES (@projectId, @sessionId, @kind, @agentId, @toolUseId, @agentType, @agentDesc,
            @filePath, @fileSize, @fileMtimeMs, @title, @lastTs, @model, @gitBranch)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      title = COALESCE(excluded.title, sessions.title),
      last_ts = COALESCE(excluded.last_ts, sessions.last_ts),
      model = COALESCE(excluded.model, sessions.model),
      git_branch = COALESCE(excluded.git_branch, sessions.git_branch)
  `).run({
    projectId: s.projectId, sessionId: s.sessionId, kind: s.kind,
    agentId: s.agentId ?? null, toolUseId: s.toolUseId ?? null,
    agentType: s.agentType ?? null, agentDesc: s.agentDesc ?? null,
    filePath: s.filePath, fileSize: s.fileSize, fileMtimeMs: s.fileMtimeMs,
    title: s.title ?? null, lastTs: s.lastTs ?? null,
    model: s.model ?? null, gitBranch: s.gitBranch ?? null
  })
  const row = db.prepare('SELECT id FROM sessions WHERE file_path = ?').get(s.filePath) as { id: number }
  return row.id
}

export function listProjects(db: Catalog): ProjectSummary[] {
  return db.prepare(`
    SELECT p.id, p.dir_name AS dirName, p.cwd,
           COUNT(s.id) AS sessionCount,
           MAX(s.last_ts) AS lastActivity,
           (SELECT m.text
              FROM messages m
              JOIN sessions s2 ON s2.id = m.session_pk
             WHERE s2.project_id = p.id AND s2.kind = 'main'
               AND m.is_sidechain = 0 AND m.text IS NOT NULL AND m.text <> ''
               -- Skip Claude Code's synthetic background-task pings (injected as
               -- user rows) so the nav preview never shows a raw <task-notification>.
               AND m.text NOT LIKE '<task-notification>%'
               -- Claude Code's own notes about a stopped turn, not anyone's words.
               AND m.rewound = 0 AND m.text NOT LIKE '[Request interrupted by user%'
               AND m.text <> 'No response requested.'
               AND COALESCE(m.model, '') <> '<synthetic>'
               -- The CLI's own context notes, for chats indexed before these
               -- rows were recognised (see jsonl/synthetic.ts for newer ones).
               AND m.text NOT LIKE '<local-command%'
               AND m.text NOT LIKE '<command-%'
               AND m.text NOT LIKE '<bash-%'
               AND m.text NOT LIKE '<system-reminder>%'
               AND m.text NOT LIKE '[Image: %'
               AND m.text NOT LIKE 'Base directory for this skill:%'
               AND m.text NOT LIKE 'This session is being continued from a previous conversation%'
             ORDER BY m.ts DESC, m.seq DESC
             LIMIT 1) AS preview
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id AND s.kind = 'main'
    GROUP BY p.id
    ORDER BY lastActivity DESC NULLS LAST, p.dir_name
  `).all() as ProjectSummary[]
}

const SESSION_COLUMNS = `
  id, session_id AS sessionId, COALESCE(custom_title, ai_title, title) AS title, message_count AS messageCount,
  last_ts AS lastTs, model, git_branch AS gitBranch,
  input_tokens AS inputTokens, output_tokens AS outputTokens,
  cache_read AS cacheRead, cache_write AS cacheWrite
`

export function listSessions(db: Catalog, projectId: number): SessionSummary[] {
  return db.prepare(`
    SELECT ${SESSION_COLUMNS} FROM sessions
    WHERE project_id = ? AND kind = 'main'
    ORDER BY last_ts DESC NULLS LAST, id DESC
  `).all(projectId) as SessionSummary[]
}

/** Total estimated USD cost across EVERY session (main + subagent), each
 *  row priced at its own recorded model -- the headline figure in the nav
 *  header. Summed per row (not per project) so a project whose sessions used
 *  different models is still costed correctly. */
export function sumTotalCostUsd(db: Catalog): number {
  const rows = db.prepare(`
    SELECT model,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read AS cacheRead, cache_write AS cacheWrite
    FROM sessions
  `).all() as Array<{ model: string | null; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }>
  let total = 0
  for (const r of rows) total += costOfSession(r.model, r)
  return total
}

export function listSubagents(db: Catalog, toolUseId: string): SessionSummary[] {
  return db.prepare(`
    SELECT ${SESSION_COLUMNS} FROM sessions
    WHERE kind = 'subagent' AND tool_use_id = ?
    ORDER BY id
  `).all(toolUseId) as SessionSummary[]
}

/** Everything the write-path engine coordinator (src/main/engine/
 *  coordinator.ts) needs to resolve a sessionPk into a spawnable session:
 *  the durable file it should keep appending to, the cwd to run `claude` in,
 *  and the durable `session_id` to `--resume` in place. Structurally
 *  identical to coordinator.ts's `SessionInfo` minus `sessionKey` (which the
 *  IPC wiring derives from `filePath` -- the schema's own unique key for a
 *  session file, and the natural "same file = same writer" identity the
 *  pool's two-writer guard cares about). */
export type EngineSessionInfo = {
  sessionPk: number
  filePath: string
  cwd: string
  resumeId: string
  indexedOffset: number
  /** True when `filePath` does not yet exist on disk -- i.e. this session
   *  has never actually been spawned against (a brand-new chat registered
   *  by Task 8's startNewChat, before its first Composer send). The
   *  coordinator (src/main/engine/coordinator.ts) uses this to decide
   *  `--session-id` (create) vs `--resume` (continue in place): checking
   *  the real filesystem rather than the catalog's own message_count/
   *  indexed_offset bookkeeping means the answer is correct even before the
   *  indexer has had a chance to catch up on a just-created session's file. */
  isNew: boolean
}

/** A session with no recorded project cwd (an older/partial index, or a
 *  project whose cwd was never observed) can't be spawned against -- there is
 *  nowhere to run `claude`. Treated the same as "session not found" by the
 *  caller (null), rather than spawning with a bogus empty-string cwd. */
export function getEngineSessionInfo(db: Catalog, sessionPk: number): EngineSessionInfo | null {
  const row = db.prepare(`
    SELECT s.file_path AS filePath, s.session_id AS resumeId, s.indexed_offset AS indexedOffset, p.cwd AS cwd
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(sessionPk) as { filePath: string; resumeId: string; indexedOffset: number; cwd: string | null } | undefined

  if (row === undefined || row.cwd === null || row.cwd.length === 0) return null

  return {
    sessionPk,
    filePath: row.filePath,
    cwd: row.cwd,
    resumeId: row.resumeId,
    indexedOffset: row.indexedOffset,
    isNew: !existsSync(row.filePath)
  }
}
