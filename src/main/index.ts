import { app, BrowserWindow, Menu, dialog, ipcMain, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSplash, type Splash } from './splash'
import { IPC } from '../shared/ipc'
import { openCatalog } from './catalog/db'
import { registerIpc } from './ipc'
import { registerEngineIpc, type EngineIpcHandle } from './engine/engine-ipc'
import { registerManageIpc } from './manage-ipc'
import { registerSyncIpc, type SyncIpcHandle } from './sync-ipc'
import { registerUpdater } from './updater'
import { registerTextMenu } from './text-menu'
import { saveResume, takeResume, usableBounds } from './update-resume'
import { getSettings, setLocalThemeCheck, updateSettings } from './catalog/settings'
import { repairProjectCwds } from './catalog/repos'
import { hasLocalTheme, localThemesDir } from './local-themes'
import { AUTOSTART_ARG } from './ipc'
import { applyStartupSettings } from './elevation'
import { registerClaudeSettingsIpc } from './claude-settings-ipc'
import { createDesktop, type Desktop } from './desktop'
import { AppDialogs } from './app-dialog'
import type { AppDialogRequest } from '../shared/app-dialog'
import { isDeletablePrevious, launchExePath, previousFromArgv, removePrevious, UPDATED_HIDDEN_ARG } from './portable-update'

// Module-level so every app-lifecycle listener below can reach the same
// handle -- `registerEngineIpc`'s own `dispose()` is idempotent (Plan 2
// review Fix 3), so it is safe for more than one of these overlapping events
// to fire for the same teardown (e.g. the window closing AND before-quit).
let engine: EngineIpcHandle | null = null
let sync: SyncIpcHandle | null = null
let mainWindow: BrowserWindow | null = null
let splash: Splash | null = null
let desktop: Desktop | null = null
/** True once the window has been shown for the first time (the splash is gone). */
let revealed = false
/** Set when the app is really quitting, so "close to tray" lets the window close. */
let quitting = false
/** Set once closing has been agreed, so the window's close goes through this time. */
let closeAgreed = false
/** A close or quit is waiting on the user's answer. */
let closeQuestionOpen = false
let dialogs: AppDialogs | null = null

/** Longest the splash may stand in for the main window. The splash tracks the
 *  startup index, so a big first-run archive legitimately takes a while; past
 *  this cap the main window is shown anyway (its own progress overlay takes
 *  over) so a stuck renderer can never strand the user on the splash. */
const SPLASH_MAX_MS = 120_000

/** Window icon for dev runs; a packaged build uses the icon embedded in the exe. */
function devIcon(): string | undefined {
  const p = join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(p) ? p : undefined
}

function createWindow(): void {
  const icon = devIcon()
  setLocalThemeCheck(name => hasLocalTheme(localThemesDir(app.getPath('userData')), name))
  const db = openCatalog(join(app.getPath('userData'), 'catalog.db'))
  repairProjectCwds(db)
  const startup = getSettings(db)
  // A login start with "Start minimized": no splash, window stays in the tray
  // (or minimized to the taskbar when there's no tray icon).
  const resumePath = join(app.getPath('userData'), 'update-resume.json')
  // Just restarted for an update: put things back as they were.
  const resumed = takeResume(resumePath, Date.now())
  const startHidden = (startup.startMinimized && process.argv.includes(AUTOSTART_ARG)) || process.argv.includes(UPDATED_HIDDEN_ARG) || resumed?.hidden === true
  // Nothing should jump in front of what the user is doing if it updated behind them.
  const quietly = resumed !== null && (!resumed.focused || resumed.minimized)
  if (!startHidden && !quietly) splash = createSplash(icon)
  // Older registrations didn't pass AUTOSTART_ARG; refresh the plain Run key
  // (the admin scheduled task is only rewritten from Settings, elevated).
  if (startup.startWithWindows && !startup.startWithAdmin && app.isPackaged) {
    applyStartupSettings({ startWithWindows: true, startWithAdmin: false, exePath: launchExePath(app.getPath('exe')), appArgs: [AUTOSTART_ARG] })
  }

  // Never open bigger than the screen: 1080p at 150% scaling is only 1280x720.
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const resumedBounds = resumed === null ? null : usableBounds(resumed.bounds, screen.getAllDisplays().map(d => d.workArea))
  const win = new BrowserWindow({
    ...(resumedBounds ?? { width: Math.min(1600, workArea.width), height: Math.min(1000, workArea.height) }),
    // Hidden until the renderer reports it has loaded (app:ready) -- the
    // splash is all the user sees until then.
    show: false,
    title: 'Delegatto',
    ...(icon !== undefined ? { icon } : {}),
    backgroundColor: '#080B13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Created on a monitor whose scaling differs from the main one, a window comes out scaled
  // by the difference. It's on the right monitor by now, so the same size sticks.
  if (resumedBounds !== null) win.setBounds(resumedBounds)

  mainWindow = win
  registerTextMenu(win)

  const updaterChats = (): string[] => (engine?.busySessionIds() ?? []).map(id => {
    const row = db.prepare("SELECT COALESCE(custom_title, ai_title, title) AS title FROM sessions WHERE LOWER(session_id) = ? AND kind = 'main'").get(id) as { title: string | null } | undefined
    return row?.title ?? 'Untitled chat'
  })
  dialogs = new AppDialogs(
    request => { win.webContents.send(IPC.appDialogAsk, request) },
    request => askNatively(win, request)
  )
  const onDialogShown = (e: Electron.IpcMainEvent, id: number): void => { if (e.sender === win.webContents) dialogs?.shown(id) }
  const onDialogAnswer = (e: Electron.IpcMainEvent, id: number, index: number): void => { if (e.sender === win.webContents) dialogs?.answer(id, index) }
  ipcMain.on(IPC.appDialogShown, onDialogShown)
  ipcMain.on(IPC.appDialogAnswer, onDialogAnswer)
  win.on('closed', () => {
    ipcMain.removeListener(IPC.appDialogShown, onDialogShown)
    ipcMain.removeListener(IPC.appDialogAnswer, onDialogAnswer)
    dialogs?.cancelAll()
  })

  desktop = createDesktop(db, () => mainWindow, { quit: () => {
    // The question shows in the window, which may be in the tray.
    if (closeQuestionOpen) { bringToFront(win); return }
    closeQuestionOpen = true
    void confirmStoppingWork(win, updaterChats()).then(agreed => {
      if (!agreed) return
      quitting = true
      app.quit()
    }).finally(() => { closeQuestionOpen = false })
  } })
  desktop.syncTray()

  const reveal = (): void => {
    if (revealed) return
    revealed = true
    clearTimeout(revealTimer)
    ipcMain.removeListener(IPC.appReady, onAppReady)
    if (!win.isDestroyed()) {
      if (resumed?.minimized === true && !startHidden) {
        if (resumed.maximized) win.maximize()
        win.showInactive()
        win.minimize()
      } else if (!startHidden) {
        if (resumed?.maximized === true) win.maximize()
        if (quietly) {
          win.showInactive()
        } else {
          win.show()
          win.focus()
        }
      } else if (!(desktop?.hasTray() ?? false)) {
        win.showInactive()
        win.minimize()
      }
    }
    splash?.close()
    splash = null
  }
  const onAppReady = (e: Electron.IpcMainEvent): void => { if (e.sender === win.webContents) reveal() }
  ipcMain.on(IPC.appReady, onAppReady)
  const revealTimer = setTimeout(reveal, SPLASH_MAX_MS)
  // A renderer that fails to load or crashes would never send app:ready --
  // show the window (with whatever error state it has) rather than hang.
  win.webContents.on('did-fail-load', reveal)
  win.webContents.on('render-process-gone', reveal)

  registerIpc(db, win, {
    onIndexProgress: p => splash?.showIndexProgress(p),
    onSettingsChanged: () => desktop?.syncTray(),
    ask: request => dialogs!.ask(request)
  })
  engine = registerEngineIpc(db, win, {
    onEvent: (pk, e) => {
      desktop?.onEvent(pk, e)
      if (e.kind === 'result') sync?.turnEnded(pk)
    },
    onPermission: (pk, req) => desktop?.onPermission(pk, req),
    ask: request => dialogs!.ask(request)
  })
  sync = registerSyncIpc(db, win, engine)
  const manage = registerManageIpc(db, engine, undefined, (from, to) => { void sync?.projectFolderRenamed(from, to) })
  const claudeSettings = registerClaudeSettingsIpc(db, win, engine)
  const updater = registerUpdater(win, {
    autoCheck: () => getSettings(db).autoCheckUpdates,
    autoInstall: () => getSettings(db).autoInstallUpdates,
    activeWork: () => engine?.activeWork() ?? 0,
    activeChats: updaterChats,
    resumedChat: resumed?.chat ?? null,
    saveForRestart: chat => {
      if (win.isDestroyed()) return
      const minimized = win.isMinimized()
      saveResume(resumePath, {
        at: Date.now(),
        bounds: win.getNormalBounds(),
        maximized: win.isMaximized(),
        minimized,
        hidden: !win.isVisible() && !minimized,
        focused: win.isFocused(),
        chat
      })
    }
  })

  // The close button exits or hides to the tray, as the user chose the first time. A real
  // quit (tray menu, update install, Windows shutting down) never comes through here.
  const closeAsChosen = async (): Promise<void> => {
    let action = getSettings(db).closeAction
    if (action === 'ask') {
      const chosen = await askCloseAction(win)
      if (chosen === null || win.isDestroyed()) return
      updateSettings(db, { closeAction: chosen })
      desktop?.syncTray()
      action = chosen
    }
    if (action === 'tray' && (desktop?.hasTray() ?? false)) {
      win.hide()
      return
    }
    if (!(await confirmStoppingWork(win, updaterChats())) || win.isDestroyed()) return
    closeAgreed = true
    win.close()
  }
  win.on('close', e => {
    if (quitting || closeAgreed) return
    e.preventDefault()
    if (closeQuestionOpen) { bringToFront(win); return }
    closeQuestionOpen = true
    void closeAsChosen().finally(() => { closeQuestionOpen = false })
  })
  // Windows is shutting down: nobody is there to answer a question.
  win.on('session-end', () => { quitting = true })
  win.on('closed', () => { desktop?.dispose(); desktop = null })
  win.on('closed', () => claudeSettings.dispose())
  win.on('closed', () => updater.dispose())
  win.on('closed', () => manage.dispose())
  win.on('closed', () => { sync?.dispose(); sync = null })
  win.on('closed', () => engine?.dispose())

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Drop Electron's default application menu (File / Edit / View / Window / Help)
// -- Delegatto is a chrome-less shell; none of those items apply. This also
// removes the menu bar from the window on Windows/Linux.
Menu.setApplicationMenu(null)
// Windows groups notifications (and the taskbar entry) by this id; it matches
// the installer's shortcut, so toasts show as "Delegatto".
if (process.platform === 'win32') app.setAppUserModelId('com.niftiestpixel.delegatto')

// One Delegatto at a time: a second launch (double-clicking the shortcut
// again) focuses the running window instead of starting a second app against
// the same catalog and the same claude sessions.
function start(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const w = mainWindow
    if (w === null || w.isDestroyed() || !revealed) return // still on the splash
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  app.whenReady().then(createWindow)
}

// Started by the previous portable version as it quits: it holds the single-instance
// lock until it has exited, which is also when its exe can be deleted.
const previousExe = previousFromArgv(process.argv)
const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
if (previousExe !== null && portableExe !== undefined && isDeletablePrevious(previousExe, portableExe)) {
  void removePrevious(previousExe).finally(start)
} else {
  start()
}
function bringToFront(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** A question for a window that can't show one itself. */
async function askNatively(win: BrowserWindow, request: AppDialogRequest): Promise<number> {
  const options = {
    type: 'question' as const,
    title: 'Delegatto',
    message: request.title,
    detail: [...(request.items ?? []), ...request.detail].join('\n\n'),
    buttons: request.buttons.map(b => b.label),
    defaultId: request.defaultIndex,
    cancelId: request.cancelIndex,
    noLink: true
  }
  const { response } = win.isDestroyed() ? await dialog.showMessageBox(options) : await dialog.showMessageBox(win, options)
  return response
}

/** The first time the window is closed: exit, or keep running in the tray. Null is Cancel. */
async function askCloseAction(win: BrowserWindow): Promise<'exit' | 'tray' | null> {
  bringToFront(win)
  const choice = await dialogs!.ask({
    title: 'When you close Delegatto',
    detail: [
      'Should it exit, or minimize to the tray? In the tray it keeps running and notifying you, and you quit from the tray icon.',
      'This will be remembered. You can change it in Settings, under Startup & System.'
    ],
    buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Exit', kind: 'secondary' }, { label: 'Minimize to tray', kind: 'primary' }],
    defaultIndex: 2,
    cancelIndex: 0
  })
  return choice === 2 ? 'tray' : choice === 1 ? 'exit' : null
}

/** Closing with chats working stops them, so it asks first. Quitting for an update has its
 *  own question and doesn't come through here. */
async function confirmStoppingWork(win: BrowserWindow, chats: string[]): Promise<boolean> {
  if (chats.length === 0) return true
  bringToFront(win)
  const choice = await dialogs!.ask({
    title: chats.length === 1 ? 'Claude is still working in 1 chat' : `Claude is still working in ${chats.length} chats`,
    items: chats.length > 5 ? [...chats.slice(0, 5), `and ${chats.length - 5} more`] : chats,
    detail: ['Closing stops this work. A command already started may keep running and could still change files.'],
    buttons: [{ label: 'Close anyway', kind: 'danger' }, { label: 'Keep working', kind: 'primary' }],
    defaultIndex: 1,
    cancelIndex: 1
  })
  return choice === 0
}

app.on('window-all-closed', () => {
  // Fix 3: tear the engine down (pool/bridge/watchers) before quitting --
  // not just on the window's own 'closed' event above, which covers the
  // single-window-open path this app has today but not every quit path
  // (e.g. a future multi-window flow, or the app quitting via another
  // route that never fires 'closed' first).
  engine?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
// Belt-and-suspenders teardown for quit paths that bypass window-all-closed
// entirely (e.g. Cmd+Q on macOS while windows are still open, or the OS
// terminating the app). Both handlers -- and win.on('closed') above --
// converge on the same idempotent dispose(), so no ordering between them
// matters.
app.on('before-quit', () => { quitting = true; engine?.dispose() })
app.on('will-quit', () => { engine?.dispose() })
