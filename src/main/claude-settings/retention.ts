import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Catalog } from '../catalog/db'
import { removeChatFromCatalog } from '../delete-channel'
import { DeleteService, SessionsLiveError } from '../manage/delete'
import type { ClaudePaths } from '../manage/paths'
import type { LiveSession } from '../manage/live'
import type { FileRemover } from '../manage/types'
import { getPath, readJsonFile, settingsPath, type SettingsLocations } from './files'
import {
  CLAUDE_DEFAULT_CLEANUP_DAYS, type AutoCleanPreview, type AutoCleanResult, type RetentionOverride, type RetentionStatus
} from '../../shared/claude-settings-types'

/** Chat retention (electron-free).
 *
 *  Claude Code deletes chats older than `cleanupPeriodDays` (default 30) when a
 *  session starts, across every project, and the setting can't be made
 *  per-project reliably. Delegatto's own auto-clean is the per-project
 *  control: chats untouched for N days (globally, or per project) go to the
 *  Recycle Bin through the same delete path as the Delete wizard. Never a chat
 *  that is open anywhere, never a permanent delete, and never history.jsonl
 *  (Claude Code's own cleanup keeps it too). */

export type RetentionPolicy = {
  /** Days for every project without its own setting; null = never. */
  globalDays: number | null
  /** Per-project (projects-folder name): days, or null = never. Absent = global. */
  projects: Record<string, number | null>
}

export const DAY_MS = 24 * 60 * 60 * 1000

export function daysFor(policy: RetentionPolicy, dirName: string): number | null {
  return Object.prototype.hasOwnProperty.call(policy.projects, dirName) ? policy.projects[dirName]! : policy.globalDays
}

export function isPolicyActive(policy: RetentionPolicy): boolean {
  return policy.globalDays !== null || Object.values(policy.projects).some(v => v !== null)
}

function validDays(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null
}

/** Claude Code's own retention: the user file's value, and any project files that set one. */
export function readRetentionStatus(loc: SettingsLocations, cwds: string[]): Omit<RetentionStatus, 'lastRun'> {
  const user = readJsonFile(settingsPath(loc, { scope: 'user' }))
  const set = validDays(getPath(user.data, 'cleanupPeriodDays'))
  const overrides: RetentionOverride[] = []
  const seen = new Set<string>()
  for (const cwd of cwds) {
    const k = cwd.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    for (const scope of ['project', 'local'] as const) {
      const file = settingsPath(loc, { scope, cwd })
      const days = validDays(getPath(readJsonFile(file).data, 'cleanupPeriodDays'))
      if (days !== null) overrides.push({ cwd, file, days })
    }
  }
  return { claudeDays: set ?? CLAUDE_DEFAULT_CLEANUP_DAYS, claudeDaysSet: set !== null, overrides }
}

export type CleanCandidate = {
  sessionPk: number
  sessionId: string
  filePath: string
  dirName: string
  cwd: string | null
  mtimeMs: number
  sizeBytes: number
}

/** Top-level chats older than their project's retention, by the transcript's
 *  last-modified time on disk (a missing file is skipped: nothing to clean). */
export function findCandidates(db: Catalog, policy: RetentionPolicy, now: number): CleanCandidate[] {
  if (!isPolicyActive(policy)) return []
  const rows = db.prepare(`
    SELECT s.id AS sessionPk, s.session_id AS sessionId, s.file_path AS filePath, p.dir_name AS dirName, p.cwd AS cwd
    FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.kind = 'main'
  `).all() as Array<Omit<CleanCandidate, 'mtimeMs' | 'sizeBytes'>>
  const out: CleanCandidate[] = []
  for (const r of rows) {
    const days = daysFor(policy, r.dirName)
    if (days === null) continue
    let st: { mtimeMs: number; size: number }
    try { st = statSync(r.filePath) } catch { continue }
    if (now - st.mtimeMs > days * DAY_MS) out.push({ ...r, mtimeMs: st.mtimeMs, sizeBytes: st.size })
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

export function previewOf(cands: CleanCandidate[]): AutoCleanPreview {
  const by = new Map<string, AutoCleanPreview['byProject'][number]>()
  for (const c of cands) {
    const e = by.get(c.dirName) ?? { dirName: c.dirName, cwd: c.cwd, count: 0, sizeBytes: 0 }
    e.count++
    e.sizeBytes += c.sizeBytes
    by.set(c.dirName, e)
  }
  return {
    count: cands.length,
    sizeBytes: cands.reduce((s, c) => s + c.sizeBytes, 0),
    byProject: [...by.values()].sort((a, b) => b.count - a.count)
  }
}

export type AutoCleanDeps = {
  paths: ClaudePaths
  remover: FileRemover
  /** Every running Claude Code session. */
  live: () => LiveSession[]
  /** Session ids Delegatto itself has a process for. */
  ownedSessionIds: () => string[]
  now?: () => number
}

/** Sends each candidate chat to the Recycle Bin (transcript, subagent and tool
 *  output, per-session folders). Re-checks liveness per chat. */
export async function runAutoClean(db: Catalog, cands: CleanCandidate[], deps: AutoCleanDeps): Promise<AutoCleanResult> {
  const result: AutoCleanResult = { at: (deps.now ?? Date.now)(), removed: 0, sizeBytes: 0, skipped: 0, errors: [] }
  if (cands.length === 0) return result
  const svc = new DeleteService(deps.paths, deps.remover, deps.live)
  const owned = new Set(deps.ownedSessionIds().map(s => s.toLowerCase()))
  const live = new Set(deps.live().map(s => s.sessionId.toLowerCase()))
  for (const c of cands) {
    const id = c.sessionId.toLowerCase()
    if (owned.has(id) || live.has(id) || !deps.remover.recyclable(c.filePath)) { result.skipped++; continue }
    try {
      const projectDir = dirname(c.filePath)
      const plan = (await svc.planChat(projectDir, c.sessionId)).filter(a => a.kind !== 'HistoryLines' && !a.permanent)
      if (!plan.some(a => a.kind === 'SessionTranscript')) { result.skipped++; continue }
      const r = await svc.executeChat(projectDir, c.sessionId, plan, { backup: false })
      for (const f of r.failures) result.errors.push(`${f.path}: ${f.error}`)
      const transcript = plan.find(a => a.kind === 'SessionTranscript')!
      if (r.done.includes(transcript.path)) {
        removeChatFromCatalog(db, c.sessionPk)
        result.removed++
        result.sizeBytes += plan.filter(a => r.done.includes(a.path)).reduce((s, a) => s + a.sizeBytes, 0)
      }
    } catch (e) {
      if (e instanceof SessionsLiveError) { result.skipped++; continue }
      result.errors.push(`${c.filePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}
