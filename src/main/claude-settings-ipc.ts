import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { Catalog } from './catalog/db'
import { getSettings } from './catalog/settings'
import { listProjects } from './catalog/repos'
import { claudeHome } from './indexer/discover'
import { isCatalogSettled } from './indexer/indexer'
import type { EngineIpcHandle } from './engine/engine-ipc'
import { defaultPaths } from './manage/paths'
import { getLiveSessions } from './manage/live'
import type { FileRemover } from './manage/types'
import { fixedDrives, recycleBinRemover } from './manage-ipc'
import { defaultManagedFiles, readSettingsText, readSettingsView, writeSettings, writeSettingsText, type SettingsLocations } from './claude-settings/files'
import { findCandidates, isPolicyActive, previewOf, readRetentionStatus, runAutoClean, type RetentionPolicy } from './claude-settings/retention'
import {
  CLAUDE_SETTINGS_IPC, type AutoCleanResult, type ClaudeSettingsPatch, type ClaudeSettingsTarget,
  type ClaudeSettingsUpdateResult, type RetentionStatus
} from '../shared/claude-settings-types'
import type { AppSettings } from '../shared/shell-types'

/** Electron boundary for Claude Code's settings files and chat retention:
 *  the Settings window's "Claude Code" and "Chat history" sections, and the
 *  scheduled auto-clean (a few minutes after launch, then every 6 hours, only
 *  while a retention period is set). */

const FIRST_RUN_MS = 3 * 60 * 1000
const EVERY_MS = 6 * 60 * 60 * 1000

export function settingsLocations(): SettingsLocations {
  return { claudeDir: claudeHome(), managedFiles: defaultManagedFiles() }
}

export function policyOf(s: AppSettings): RetentionPolicy {
  return { globalDays: s.autoCleanDays, projects: s.autoCleanProjects }
}

function validTarget(t: unknown): ClaudeSettingsTarget {
  const o = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>
  if (o.scope === 'user') return { scope: 'user' }
  if ((o.scope === 'project' || o.scope === 'local') && typeof o.cwd === 'string' && /^([A-Za-z]:[\\/]|\\\\|\/)/.test(o.cwd)) {
    return { scope: o.scope, cwd: o.cwd }
  }
  throw new Error('Not a settings location.')
}

export function registerClaudeSettingsIpc(db: Catalog, window: BrowserWindow, engine: EngineIpcHandle): { dispose(): void } {
  const loc = settingsLocations()
  const paths = defaultPaths()
  let remover: Promise<FileRemover> | null = null
  let lastRun: AutoCleanResult | null = null
  let running: Promise<AutoCleanResult> | null = null

  const knownCwds = (): string[] => listProjects(db).map(p => p.cwd).filter((c): c is string => typeof c === 'string' && c.length > 0)

  const cleanNow = (): Promise<AutoCleanResult> => {
    running ??= (async () => {
      try {
        const cands = findCandidates(db, policyOf(getSettings(db)), Date.now())
        const r = await runAutoClean(db, cands, {
          paths,
          remover: await (remover ??= fixedDrives().then(recycleBinRemover)),
          live: () => getLiveSessions(paths),
          ownedSessionIds: () => engine.ownedProcesses().map(o => o.sessionId)
        })
        lastRun = r
        if (r.removed > 0 && !window.isDestroyed()) window.webContents.send(CLAUDE_SETTINGS_IPC.retentionCleaned, r)
        return r
      } finally {
        running = null
      }
    })()
    return running
  }

  const scheduled = (): void => {
    if (!isCatalogSettled() || !isPolicyActive(policyOf(getSettings(db)))) return
    void cleanNow().catch(err => console.error('[retention] auto-clean failed', err))
  }
  const first = setTimeout(scheduled, FIRST_RUN_MS)
  const every = setInterval(scheduled, EVERY_MS)

  const handlers: Record<string, (e: IpcMainInvokeEvent, ...args: never[]) => unknown> = {
    [CLAUDE_SETTINGS_IPC.get]: (_e, target: ClaudeSettingsTarget) => readSettingsView(loc, validTarget(target)),
    [CLAUDE_SETTINGS_IPC.update]: (_e, target: ClaudeSettingsTarget, patch: ClaudeSettingsPatch): ClaudeSettingsUpdateResult => {
      try {
        const t = validTarget(target)
        writeSettings(loc, t, typeof patch === 'object' && patch !== null ? patch : {})
        return { ok: true, view: readSettingsView(loc, t) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    [CLAUDE_SETTINGS_IPC.getText]: (_e, target: ClaudeSettingsTarget) => readSettingsText(loc, validTarget(target)),
    [CLAUDE_SETTINGS_IPC.saveText]: (_e, target: ClaudeSettingsTarget, text: string): ClaudeSettingsUpdateResult => {
      try {
        const t = validTarget(target)
        writeSettingsText(loc, t, String(text))
        return { ok: true, view: readSettingsView(loc, t) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    [CLAUDE_SETTINGS_IPC.retentionStatus]: (): RetentionStatus => ({ ...readRetentionStatus(loc, knownCwds()), lastRun }),
    [CLAUDE_SETTINGS_IPC.retentionPreview]: () => previewOf(findCandidates(db, policyOf(getSettings(db)), Date.now())),
    [CLAUDE_SETTINGS_IPC.retentionRunNow]: () => cleanNow()
  }
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn as (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown)

  return {
    dispose() {
      clearTimeout(first)
      clearInterval(every)
      for (const ch of Object.keys(handlers)) ipcMain.removeHandler(ch)
    }
  }
}
