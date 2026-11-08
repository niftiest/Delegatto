import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { parse as parsePath } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { Catalog } from './catalog/db'
import { retireRenamedProject } from './delete-channel'
import type { EngineIpcHandle } from './engine/engine-ipc'
import { defaultPaths, type ClaudePaths } from './manage/paths'
import { getLiveSessions } from './manage/live'
import { endAll } from './manage/terminate'
import { DeleteWizard, endSessions, type ManageDeps } from './manage/wizard'
import { ManageController } from './manage/controller'
import type { FileRemover } from './manage/types'
import {
  MANAGE_IPC, type ContentSearchEvent, type DeleteOutcome, type DeleteTarget, type ManageResult
} from '../shared/manage-types'

/** Electron boundary for the Manage features: wires the electron-free
 *  src/main/manage services (Delete wizard + Manage screen) to the Recycle Bin
 *  (shell.trashItem), native file dialogs, the shell (open / show in folder),
 *  Delegatto's own process pool (closed gracefully, never killed) and the
 *  catalog (rows dropped / re-synced after Claude's data changed). */

/** Local fixed drives (letters, upper-case) -- the ones with a Recycle Bin.
 *  Queried once via a hidden PowerShell call; network shares (UNC) and
 *  removable drives delete permanently and the wizard flags them. */
export function fixedDrives(): Promise<Set<string>> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve(new Set()); return }
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }"],
    { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) {
        // Fail toward "permanent" except the system drive, which always has one.
        const sys = (process.env.SystemDrive ?? 'C:').toUpperCase()
        resolve(new Set([sys[0]!]))
        return
      }
      resolve(new Set(stdout.split(/\r?\n/).map(l => l.trim().toUpperCase()).filter(l => /^[A-Z]:$/.test(l)).map(l => l[0]!)))
    })
  })
}

export function recycleBinRemover(drives: Set<string>): FileRemover {
  return {
    async removeDirectory(path) { await shell.trashItem(path) },
    async removeFile(path) { await shell.trashItem(path) },
    recyclable(path) {
      const root = parsePath(path).root
      if (root.startsWith('\\\\')) return false // UNC / network share
      return drives.has(root.slice(0, 1).toUpperCase())
    }
  }
}

function windowOf(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined
}

async function saveZip(e: IpcMainInvokeEvent, title: string, defaultName: string): Promise<string | null> {
  const opts = { title, defaultPath: defaultName, filters: [{ name: 'Zip files', extensions: ['zip'] }] }
  const w = windowOf(e)
  const r = w !== undefined ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
  return r.canceled || r.filePath === undefined || r.filePath === '' ? null : r.filePath
}

export function registerManageIpc(db: Catalog, engine: EngineIpcHandle, paths: ClaudePaths = defaultPaths(),
  onProjectFolderRenamed?: (from: string, to: string) => void, onProjectDeleted?: (workingDir: string) => void): { dispose(): void } {
  const drives = fixedDrives()
  let remover: FileRemover | null = null

  // The controller is created below; the wizard reads its last scan lazily.
  let controller: ManageController | null = null
  const deps: ManageDeps = {
    paths,
    getRemover: async () => (remover ??= recycleBinRemover(await drives)),
    live: () => getLiveSessions(paths),
    ownedSessionIds: () => engine.ownedProcesses().map(o => o.sessionId),
    stopOwned: ids => { engine.stopOwned(ids) },
    endExternal: sessions => endAll(sessions),
    knownProjects: () => controller?.known() ?? null,
    projectDeleted: workingDir => onProjectDeleted?.(workingDir)
  }
  const wizard = new DeleteWizard(db, deps)
  controller = new ManageController(deps, {
    // Catalog follows the files: carry renamed channels over, then pick up
    // whatever changed on disk (new/renamed/restored transcripts).
    projectFoldersRenamed: pairs => { for (const p of pairs) { retireRenamedProject(db, p.from, p.to); onProjectFolderRenamed?.(p.from, p.to) } },
    changed: () => engine.resync()
  })
  const ctl = controller

  const onExecute = async (_e: unknown, target: DeleteTarget, selectedKeys: string[], restorePoint: boolean): Promise<DeleteOutcome> => {
    ctl.cancelAllSearches()
    const r = await wizard.execute(target, selectedKeys, restorePoint)
    if (r.ok) await ctl.afterChange()
    return r
  }

  const handlers: Record<string, (e: IpcMainInvokeEvent, ...args: never[]) => unknown> = {
    // ---- Delete wizard
    [MANAGE_IPC.planDelete]: (_e, target: DeleteTarget) => wizard.plan(target),
    [MANAGE_IPC.checkSessions]: (_e, target: DeleteTarget) => wizard.check(target),
    [MANAGE_IPC.endSessions]: (_e, pids: number[]) => endSessions(deps, Array.isArray(pids) ? pids : []),
    [MANAGE_IPC.executeDelete]: onExecute,
    [MANAGE_IPC.showInFolder]: (_e, path: string) => { if (typeof path === 'string' && path) shell.showItemInFolder(path) },

    // ---- Projects
    [MANAGE_IPC.listProjects]: () => ctl.listProjects(),
    [MANAGE_IPC.projectDetail]: (_e, workingDir: string) => ctl.projectDetail(workingDir),
    [MANAGE_IPC.searchStart]: (e, id: number, query: string) => {
      const sender = e.sender
      ctl.startSearch(id, String(query ?? ''), (ev: ContentSearchEvent) => {
        if (!sender.isDestroyed()) sender.send(MANAGE_IPC.searchEvent, ev)
      })
    },
    [MANAGE_IPC.searchCancel]: (_e, id: number) => ctl.cancelSearch(id),
    [MANAGE_IPC.exportProjects]: async (e, workingDirs: string[]): Promise<ManageResult> => {
      const list = Array.isArray(workingDirs) ? workingDirs : []
      if (list.length === 0) return { kind: 'error', error: 'No projects were selected.' }
      const zip = await saveZip(e, list.length === 1 ? `Export Claude data for ${list[0]}` : `Export Claude data for ${list.length} projects`,
        ctl.exportName(list))
      return zip === null ? { kind: 'cancelled' } : ctl.exportProjects(list, zip)
    },
    [MANAGE_IPC.pickImport]: async (e): Promise<string | null> => {
      const opts = { title: 'Import a Claude Memory Tool / Delegatto export', properties: ['openFile' as const],
        filters: [{ name: 'Zip files', extensions: ['zip'] }] }
      const w = windowOf(e)
      const r = w !== undefined ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!
    },
    [MANAGE_IPC.readArchive]: (_e, zip: string) => ctl.readArchive(zip),
    [MANAGE_IPC.importArchive]: (_e, zip: string) => ctl.importArchive(zip),
    [MANAGE_IPC.renamePlan]: (_e, oldDir: string, newDir: string) => ctl.renamePlan(oldDir, String(newDir ?? '')),
    [MANAGE_IPC.renameExecute]: (_e, oldDir: string, newDir: string, signature: string) =>
      ctl.renameExecute(oldDir, String(newDir ?? ''), String(signature ?? '')),

    // ---- Restore points
    [MANAGE_IPC.listRestorePoints]: () => ctl.listRestorePoints(),
    [MANAGE_IPC.deleteRestorePoints]: (_e, list: string[]) => ctl.deleteRestorePoints(Array.isArray(list) ? list : []),
    [MANAGE_IPC.openRestorePointsFolder]: async () => {
      mkdirSync(paths.restorePointsDir, { recursive: true })
      await shell.openPath(paths.restorePointsDir)
    },

    // ---- Notes
    [MANAGE_IPC.findNotes]: (_e, rescan: boolean) => ctl.findNotes(rescan === true),
    [MANAGE_IPC.searchNotes]: (_e, query: string) => ctl.searchNotes(String(query ?? '')),
    [MANAGE_IPC.deleteNotes]: (_e, list: string[]) => ctl.deleteNotes(Array.isArray(list) ? list : []),
    [MANAGE_IPC.previewNote]: (_e, path: string) => ctl.previewNote(path),
    [MANAGE_IPC.exportNotes]: async (e, list: string[]): Promise<ManageResult> => {
      const notes = Array.isArray(list) ? list : []
      if (notes.length === 0) return { kind: 'error', error: 'No notes were selected.' }
      const zip = await saveZip(e, `Export ${notes.length} note(s)`, ctl.notesExportName())
      return zip === null ? { kind: 'cancelled' } : ctl.exportNotes(notes, zip)
    },
    [MANAGE_IPC.openInEditor]: async (_e, path: string): Promise<string | null> => {
      if (!await ctl.canOpenInEditor(path)) return 'Only listed notes and memory files open here.'
      const err = await shell.openPath(path)
      return err === '' ? null : err
    },

    // ---- Live sessions
    [MANAGE_IPC.liveSessions]: () => ctl.liveSessions()
  }

  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn as (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown)

  return {
    dispose() {
      ctl.cancelAllSearches()
      for (const ch of Object.keys(handlers)) ipcMain.removeHandler(ch)
    }
  }
}
