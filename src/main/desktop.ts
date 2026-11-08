import { app, Menu, Notification, Tray, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog } from './catalog/db'
import { getSettings } from './catalog/settings'
import { getChannelMeta } from './catalog/metadata'
import { classifyEvent, classifyPermission, notificationBody, shouldNotify, type NotifyKind } from './notify-rules'
import type { LiveEvent, PermissionRequest } from '../shared/engine-types'
import { CLAUDE_SETTINGS_IPC } from '../shared/claude-settings-types'

/** Desktop integration: notifications for chats that need you while
 *  Delegatto isn't in front, and the tray icon (close to tray, start
 *  minimized). */

/** The app icon: bundled next to the exe when packaged, in resources/ when run from source. */
export function appIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.ico')]
    : [join(app.getAppPath(), 'resources', 'icon.ico'), join(app.getAppPath(), 'resources', 'icon.png')]
  return candidates.find(p => existsSync(p))
}

export type Desktop = {
  onEvent(sessionPk: number, e: LiveEvent): void
  onPermission(sessionPk: number, req: PermissionRequest): void
  /** Re-read the tray settings (after Settings changed). */
  syncTray(): void
  /** Whether a tray icon is showing (so hiding the window is safe). */
  hasTray(): boolean
  dispose(): void
}

export function createDesktop(db: Catalog, getWindow: () => BrowserWindow | null, opts: { quit: () => void }): Desktop {
  let tray: Tray | null = null
  // One notification per chat per few seconds: a failing turn sends both an
  // error result and a non-zero exit.
  const lastShown = new Map<number, number>()

  const describe = (sessionPk: number): { title: string; dirName: string } | null => {
    const row = db.prepare(`
      SELECT COALESCE(s.custom_title, s.ai_title, s.title) AS title, p.dir_name AS dirName, p.cwd AS cwd
      FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
    `).get(sessionPk) as { title: string | null; dirName: string; cwd: string | null } | undefined
    if (row === undefined) return null
    const meta = getChannelMeta(db, row.dirName)
    const project = meta.friendlyName ?? (row.cwd !== null ? row.cwd.split(/[\\/]/).filter(Boolean).pop() ?? row.cwd : row.dirName)
    const chat = row.title !== null && row.title.trim() !== '' ? row.title.trim() : null
    return { title: chat !== null ? `${project} · ${chat.length > 60 ? chat.slice(0, 57) + '…' : chat}` : project, dirName: row.dirName }
  }

  const showWindow = (): void => {
    const w = getWindow()
    if (w === null || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  const notify = (sessionPk: number, kind: NotifyKind, detail: { text?: string; tool?: string }): void => {
    const w = getWindow()
    if (w === null || w.isDestroyed()) return
    // In front and visible: the app itself shows it.
    if (w.isVisible() && w.isFocused() && !w.isMinimized()) return
    if (!Notification.isSupported() || !shouldNotify(kind, getSettings(db), new Date())) return
    const now = Date.now()
    if (now - (lastShown.get(sessionPk) ?? 0) < 5000) return
    lastShown.set(sessionPk, now)
    const who = describe(sessionPk)
    const icon = appIconPath()
    const n = new Notification({
      title: who?.title ?? 'Delegatto',
      body: notificationBody(kind, detail),
      ...(icon !== undefined ? { icon } : {})
    })
    n.on('click', () => {
      showWindow()
      const target = getWindow()
      if (who !== null && target !== null && !target.isDestroyed()) target.webContents.send(CLAUDE_SETTINGS_IPC.openChat, sessionPk, who.dirName)
    })
    n.show()
  }

  const syncTray = (): void => {
    const s = getSettings(db)
    const want = s.showTrayIcon || s.closeAction === 'tray'
    if (!want) {
      tray?.destroy()
      tray = null
      return
    }
    if (tray !== null) return
    const icon = appIconPath()
    tray = new Tray(icon !== undefined ? nativeImage.createFromPath(icon) : nativeImage.createEmpty())
    tray.setToolTip('Delegatto')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Delegatto', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Delegatto', click: () => opts.quit() }
    ]))
    tray.on('click', showWindow)
  }

  return {
    onEvent(sessionPk, e) {
      const kind = classifyEvent(e)
      if (kind !== null) notify(sessionPk, kind, { text: e.kind === 'result' ? e.text : undefined })
    },
    onPermission(sessionPk, req) {
      notify(sessionPk, classifyPermission(req), { tool: req.tool })
    },
    syncTray,
    hasTray: () => tray !== null,
    dispose() {
      tray?.destroy()
      tray = null
    }
  }
}
