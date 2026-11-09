import { app, BrowserWindow, Menu, dialog, ipcMain, screen, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSplash, type Splash } from './splash'
import { IPC, type VisibleChats } from '../shared/ipc'
import { openCatalog } from './catalog/db'
import { registerIpc } from './ipc'
import { registerEngineIpc, type EngineIpcHandle } from './engine/engine-ipc'
import { registerManageIpc } from './manage-ipc'
import { registerSyncIpc, type SyncIpcHandle } from './sync-ipc'
import { installFileLog } from './file-log'
import { registerUpdater } from './updater'
import { registerTextMenu } from './text-menu'
import { saveResume, takeResume, usableBounds } from './update-resume'
import { getSettings, setLocalThemeCheck, updateSettings } from './catalog/settings'
import { projectIdsOfSessions, repairProjectCwds } from './catalog/repos'
import { hasLocalTheme, localThemesDir } from './local-themes'
import { AUTOSTART_ARG } from './ipc'
import { applyStartupSettings, ELEVATED_RELAUNCH_ARG, LOCK_RETRY_EVERY_MS, shouldRetryInstanceLock } from './elevation'
import { registerClaudeSettingsIpc } from './claude-settings-ipc'
import { createDesktop, type Desktop } from './desktop'
import { AppDialogs } from './app-dialog'
import { WindowHub } from './window-hub'
import { registerSplitWindow, type SplitWindowHandle } from './split-window'
import type { MainDialogRequest } from '../shared/app-dialog'
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
let dialogs: AppDialogs<WebContents> | null = null
let splitWindow: SplitWindowHandle | null = null
/** Every open window. Renderer events go to all of them. */
const hub = new WindowHub()

/** Longest the splash may stand in for the main window. The splash tracks the
 *  startup index, so a big first-run archive legitimately takes a while; past
 *  this cap the main window is shown anyway (its own progress overlay takes
 *  over) so a stuck renderer can never strand the user on the splash. */
const SPLASH_MAX_MS = 120_000

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

/** Window icon for dev runs; a packaged build uses the icon embedded in the exe. */
function devIcon(): string | undefined {
  const p = join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(p) ? p : undefined
}

/** Loads the renderer: the dev server in development, the built files otherwise. `query` picks a view, e.g. `view=split`. */
function loadRenderer(win: BrowserWindow, query = ''): void {
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(query === '' ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}?${query}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), query === '' ? {} : { search: query })
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
    void applyStartupSettings({ startWithWindows: true, startWithAdmin: false, exePath: launchExePath(app.getPath('exe')), appArgs: [AUTOSTART_ARG] })
  }
  // Just restarted as administrator from Settings: the unelevated instance couldn't create
  // the highest-privilege logon task, so this one does.
  if (startup.startWithWindows && startup.startWithAdmin && app.isPackaged && process.argv.includes(ELEVATED_RELAUNCH_ARG)) {
    void applyStartupSettings({ startWithWindows: true, startWithAdmin: true, exePath: launchExePath(app.getPath('exe')), appArgs: [AUTOSTART_ARG] })
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
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Created on a monitor whose scaling differs from the main one, a window comes out scaled
  // by the difference. It's on the right monitor by now, so the same size sticks.
  if (resumedBounds !== null) win.setBounds(resumedBounds)

  mainWindow = win
  hub.register(win, 'main')
  registerTextMenu(win)

  const updaterChats = (): string[] => (engine?.busySessionIds() ?? []).map(id => {
    const row = db.prepare("SELECT COALESCE(custom_title, ai_title, title) AS title FROM sessions WHERE LOWER(session_id) = ? AND kind = 'main'").get(id) as { title: string | null } | undefined
    return row?.title ?? 'Untitled chat'
  })
  // A question goes to the window that asked; one from main itself goes to the main window.
  const dialogWindow = (to: WebContents | undefined): BrowserWindow | null => (to !== undefined ? hub.fromContents(to) : null) ?? hub.main()
  dialogs = new AppDialogs<WebContents>(
    (request, to) => {
      const target = dialogWindow(to)
      if (target === null) throw new Error('No window to ask in.')
      target.webContents.send(IPC.appDialogAsk, request)
    },
    (request, to) => askNatively(dialogWindow(to) ?? win, request)
  )
  const onDialogShown = (e: Electron.IpcMainEvent, id: number): void => { if (hub.fromContents(e.sender) !== null) dialogs?.shown(id) }
  const onDialogAnswer = (e: Electron.IpcMainEvent, id: number, index: number): void => { if (hub.fromContents(e.sender) !== null) dialogs?.answer(id, index) }
  ipcMain.on(IPC.appDialogShown, onDialogShown)
  ipcMain.on(IPC.appDialogAnswer, onDialogAnswer)
  win.on('closed', () => {
    ipcMain.removeListener(IPC.appDialogShown, onDialogShown)
    ipcMain.removeListener(IPC.appDialogAnswer, onDialogAnswer)
    dialogs?.cancelAll()
  })

  // Every chat shown in any window, and their projects.
  const visibleChatsPayload = (): VisibleChats => {
    const chats = hub.visibility.all()
    return { chats, projects: chats.length === 0 ? [] : projectIdsOfSessions(db, chats) }
  }
  splitWindow = registerSplitWindow(db, hub, {
    preload: preloadPath(),
    load: loadRenderer,
    ...(icon !== undefined ? { icon } : {}),
    onCreated: split => {
      const stopTextMenu = registerTextMenu(split)
      split.on('closed', stopTextMenu)
      // It may load after the last change, so it starts from what every window shows now.
      split.webContents.on('did-finish-load', () => { if (!split.isDestroyed()) split.webContents.send(IPC.visibleChatsChanged, visibleChatsPayload()) })
    },
    // A question it was showing would otherwise wait for an answer that can't come.
    onClosed: contents => dialogs?.cancelFor(contents),
    // A crashed page has lost the question too, and a reloaded one won't show it again.
    onRendererGone: contents => dialogs?.cancelFor(contents)
  })

  desktop = createDesktop(db, hub, { quit: () => {
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
    // Reopen the split window if it was open when the app quit, without jumping in front
    // of anything the main window didn't.
    splitWindow?.restore({ inactive: quietly, minimized: startHidden })
  }
  // Only the main window's first load ends the splash.
  const onAppReady = (e: Electron.IpcMainEvent): void => {
    const from = hub.fromContents(e.sender)
    if (from !== null && from === hub.main()) reveal()
  }
  ipcMain.on(IPC.appReady, onAppReady)
  ipcMain.on(IPC.appLog, (e, text: unknown) => { if (hub.fromContents(e.sender) !== null) console.log(`[window] ${String(text)}`) })
  // Each window says which chats it shows; kept per window.
  ipcMain.on(IPC.visibleChats, (e, pks: unknown) => {
    const from = hub.fromContents(e.sender)
    if (from === null || !Array.isArray(pks)) return
    hub.visibility.set(from.id, pks.filter((pk): pk is number => typeof pk === 'number'))
  })
  // Every window hears what all of them show: a chat shown anywhere counts as read.
  hub.onVisibilityChange(() => {
    hub.send(IPC.visibleChatsChanged, visibleChatsPayload())
  })
  const revealTimer = setTimeout(reveal, SPLASH_MAX_MS)
  // A renderer that fails to load or crashes would never send app:ready --
  // show the window (with whatever error state it has) rather than hang.
  win.webContents.on('did-fail-load', reveal)
  win.webContents.on('render-process-gone', reveal)

  registerIpc(db, hub, {
    onIndexProgress: p => splash?.showIndexProgress(p),
    onSettingsChanged: s => {
      desktop?.syncTray()
      // Every window follows, so the split window keeps the main window's theme and sizes.
      hub.send(IPC.settingsChanged, s)
    },
    ask: (request, from) => dialogs!.ask(request, from),
    // One close/quit/restart question at a time.
    confirmRestart: async () => {
      if (closeQuestionOpen) { bringToFront(win); return false }
      closeQuestionOpen = true
      try { return await confirmStoppingWork(win, updaterChats(), 'restart') } finally { closeQuestionOpen = false }
    }
  })
  engine = registerEngineIpc(db, hub, {
    onEvent: (pk, e) => {
      desktop?.onEvent(pk, e)
      if (e.kind === 'result') sync?.turnEnded(pk)
    },
    onPermission: (pk, req) => desktop?.onPermission(pk, req),
    ask: (request, from) => dialogs!.ask(request, from)
  })
  sync = registerSyncIpc(db, hub, engine)
  const manage = registerManageIpc(db, engine, undefined, (from, to) => { void sync?.projectFolderRenamed(from, to) },
    workingDir => { void sync?.projectDeleted(workingDir) })
  const claudeSettings = registerClaudeSettingsIpc(db, hub, engine)
  const updater = registerUpdater(hub, {
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
  // Exiting from the main window takes the split window with it. It stays remembered as
  // open, so it comes back next time.
  win.on('closed', () => {
    splitWindow?.dispose()
    splitWindow = null
    const split = hub.split()
    if (split !== null) split.close()
  })
  win.on('closed', () => { desktop?.dispose(); desktop = null })
  win.on('closed', () => claudeSettings.dispose())
  win.on('closed', () => updater.dispose())
  win.on('closed', () => manage.dispose())
  win.on('closed', () => { sync?.dispose(); sync = null })
  win.on('closed', () => engine?.dispose())

  loadRenderer(win)
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
  // An elevated relaunch starts while the instance that launched it is still quitting, so
  // it tries again for a while. Any other second launch quits at once.
  const startedAt = Date.now()
  const attempt = (): void => {
    if (app.requestSingleInstanceLock()) { begin(); return }
    if (shouldRetryInstanceLock(process.argv, Date.now() - startedAt)) { setTimeout(attempt, LOCK_RETRY_EVERY_MS); return }
    app.quit()
  }
  attempt()
}

function begin(): void {
  // Only the app that's actually running writes it, so two launches never share the file.
  if (app.isPackaged) installFileLog(join(app.getPath('userData'), 'logs'))
  app.on('second-instance', () => {
    // Quitting: an elevated relaunch knocking for the lock mustn't bring this window back.
    if (quitting) return
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
async function askNatively(win: BrowserWindow, request: MainDialogRequest): Promise<number> {
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
async function confirmStoppingWork(win: BrowserWindow, chats: string[], action: 'close' | 'restart' = 'close'): Promise<boolean> {
  if (chats.length === 0) return true
  bringToFront(win)
  const choice = await dialogs!.ask({
    title: chats.length === 1 ? 'Claude is still working in 1 chat' : `Claude is still working in ${chats.length} chats`,
    items: chats.length > 5 ? [...chats.slice(0, 5), `and ${chats.length - 5} more`] : chats,
    detail: [`${action === 'restart' ? 'Restarting' : 'Closing'} stops this work. A command already started may keep running and could still change files.`],
    buttons: [{ label: action === 'restart' ? 'Restart anyway' : 'Close anyway', kind: 'danger' }, { label: 'Keep working', kind: 'primary' }],
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
app.on('before-quit', () => {
  quitting = true
  // Before the windows close, so closing the split window doesn't forget it was open.
  splitWindow?.dispose()
  engine?.dispose()
})
app.on('will-quit', () => { engine?.dispose() })
