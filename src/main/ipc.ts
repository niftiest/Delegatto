import { ipcMain, app, shell, dialog, type BrowserWindow, type WebContents } from 'electron'
import type { WindowHub } from './window-hub'
import { copyFile, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { applyTheme, cleanThemeValues, deleteTheme, hasTheme, listThemes, parseThemeFile, saveTheme, themeFileText } from './catalog/themes'
import {
  LOCAL_THEME_PREFIX, MAX_THEME_FILE_BYTES, MAX_THEME_NAME, THEME_FILE_EXTENSION, cleanThemeName, isBuiltInThemeName, themeFileName, themeNameFromPath, themeValuesOf,
  type ExportThemeResult, type ImportThemeResult, type SaveThemeResult, type ThemeValues
} from '../shared/themes'
import type { MainDialogRequest } from '../shared/app-dialog'
import { applyStartupSettings, relaunchElevated, isElevated, ELEVATED_RELAUNCH_ARG } from './elevation'
import type { Catalog } from './catalog/db'
import { listProjects, listSubagents, sumTotalCostUsd } from './catalog/repos'
import { backupCatalogOnce, chatsToShow, folderGone, isConversationText, moveCustomisations, withoutMovedChats } from './catalog/archive'
import { displayText } from './jsonl/synthetic'
import { readOriginRepo } from './engine/github'
import { search, searchProject } from './catalog/search'
import { getSettings, updateSettings } from './catalog/settings'
import { MAX_LOCAL_THEME_BYTES, ensureLocalThemesDir, listLocalThemes, localThemeName, localThemesDir } from './local-themes'
import type { AppSettings, AppTheme, ChannelMeta } from '../shared/shell-types'
import {
  getChannelMeta, setFriendlyName, setStarred, setChannelIcon, setChannelGroup,
  listGroups, createGroup, renameGroup, deleteGroup, setHidden, setGroupIcon
} from './catalog/metadata'
import { deleteChannel } from './delete-channel'
import { listMcpServers, listSkills } from './mcp-skills'
import { readFsTree } from './fs-tree'
import { listProjectFiles } from './project-files'
import { generateAvatar, fetchImageModels, fetchUsage } from './openrouter'
import { saveImage } from './save-image'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runIndex } from './indexer/indexer'
import { syncSessionIfStale } from './engine/external-sync'
import { streamRange } from './jsonl/stream'
import { isDisplayRow, type LocalCommandRow } from './jsonl/parse'
import { rewoundUuids } from './jsonl/rewound'
import { buildRenderItems } from './jsonl/render'
import type { MessageRow } from './jsonl/rows'
import type { TranscriptPage, ChannelRow, IndexProgress, RenderItem } from '../shared/types'
import type { ChannelIcon } from '../shared/shell-types'
import { IPC } from '../shared/ipc'
import { launchExePath } from './portable-update'
import { loadModelPrices } from './engine/model-prices'
import { setModelPrices } from '../shared/models'

/** Messages per page. Scrolling up requests the previous page. */
export const PAGE_SIZE = 60
/** Rows read past a page's end so a boundary tool_use finds its tool_result. */
const LOOKAHEAD_ROWS = 5
const JUMP_CONTEXT_ROWS = 10

type NodeRow = { uuid: string; seq: number }
type PageNodes = { window: NodeRow[]; hasMore: boolean }

/** The newest page of messages, or the page just before `before`, oldest first. Reads only
 *  those rows plus one (to know whether there are more), newest first through the
 *  (session_pk, seq) index. The open chat reloads this page every few seconds while Claude
 *  works, so it must not walk every message of a long chat. Null when there are none. */
function newestPage(db: Catalog, sessionPk: number, chainFilter: string, limit: number, before: number | undefined): PageNodes | null {
  const rows = (before === undefined
    ? db.prepare(`SELECT uuid, seq FROM messages WHERE session_pk = ? ${chainFilter} ORDER BY seq DESC LIMIT ?`).all(sessionPk, limit + 1)
    : db.prepare(`SELECT uuid, seq FROM messages WHERE session_pk = ? ${chainFilter} AND seq < ? ORDER BY seq DESC LIMIT ?`).all(sessionPk, before, limit + 1)
  ) as NodeRow[]
  if (rows.length === 0) return null
  return { window: rows.slice(0, limit).reverse(), hasMore: rows.length > limit }
}

/** Going to a message: everything from it on, so the view stays one unbroken run, plus a few
 *  before it to read it in context. Rare enough to walk the whole chat. */
function jumpPage(db: Catalog, sessionPk: number, chainFilter: string, limit: number, before: number | undefined, fromSeq: number): PageNodes | null {
  const nodes = db.prepare(
    `SELECT uuid, seq FROM messages WHERE session_pk = ? ${chainFilter} ORDER BY seq`
  ).all(sessionPk) as NodeRow[]
  const eligible = before === undefined ? nodes : nodes.filter(n => n.seq < before)
  if (eligible.length === 0) return null
  const target = eligible.findIndex(n => n.seq >= fromSeq)
  const windowStart = target === -1
    ? Math.max(0, eligible.length - limit)
    : Math.min(Math.max(0, target - JUMP_CONTEXT_ROWS), Math.max(0, eligible.length - limit))
  const window = eligible.slice(windowStart)
  return { window, hasMore: eligible.length > window.length }
}

/** A chat whose transcript has gone, from the text the catalog saved of it. Tool calls and
 *  their output weren't saved. Null when there's no text to show. */
function savedTextPage(db: Catalog, sessionPk: number, window: string[], oldestSeq: number, hasMore: boolean, chainFilter: string): TranscriptPage | null {
  const wanted = new Set(window)
  const rows = db.prepare(
    `SELECT uuid, role, ts, model, text FROM messages WHERE session_pk = ? ${chainFilter} AND seq >= ? ORDER BY seq`
  ).all(sessionPk, oldestSeq) as Array<{ uuid: string; role: string; ts: string | null; model: string | null; text: string | null }>
  const items: RenderItem[] = []
  for (const row of rows) {
    if (!wanted.has(row.uuid) || !isConversationText(row.text) || (row.role !== 'user' && row.role !== 'assistant')) continue
    const text = displayText({}, row.text)
    if (text.length > 0) items.push({ kind: 'text', uuid: row.uuid, role: row.role, ts: row.ts, model: row.model, text })
  }
  // Older pages may still have some, even if this one is all tool calls.
  if (items.length === 0 && !hasMore) return null
  return { items, oldestSeq, hasMore, savedTextOnly: true }
}

export async function loadTranscript(
  db: Catalog,
  sessionPk: number,
  opts: { before?: number; limit?: number; fromSeq?: number } = {}
): Promise<TranscriptPage> {
  const empty: TranscriptPage = { items: [], oldestSeq: null, hasMore: false }

  const session = db.prepare('SELECT file_path, kind FROM sessions WHERE id = ?').get(sessionPk) as
    | { file_path: string; kind: string }
    | undefined
  if (session === undefined) return empty
  // Everything a subagent says is on a side chain, so in its own transcript that's the point.
  // What a rewind went past isn't part of the chat any more.
  const chainFilter = session.kind === 'subagent' ? 'AND rewound = 0' : 'AND is_sidechain = 0 AND rewound = 0'

  // A chat-history viewer shows EVERY message in chronological order (like a
  // chat app), not a pruned "live branch". Earlier this walked the parentUuid
  // tree to drop abandoned rewind branches — but that truncated real sessions
  // catastrophically, for two reasons proven against live data:
  //   1. parentUuid threads through NON-message rows (attachment, summary,
  //      file-history-snapshot, system, …) which aren't in this message-only
  //      projection, so the walk hit a "dangling" parent and stopped — leaving
  //      only the last unbroken message-to-message run (e.g. 6 of 4,520).
  //   2. Long sessions are compacted/resumed over days, producing MULTIPLE
  //      parentUuid roots (a forest); a walk from the newest leaf can never
  //      reach earlier segments anyway.
  // So we render all message rows in seq (write) order and window over them.
  // Sidechain rows stay excluded — subagent traffic belongs nested in its Task
  // card, not inline in the main timeline.
  // A caller-supplied limit of 0 or negative would otherwise slice an empty
  // (or backwards) window; clamp to at least one message per page.
  const limit = Math.max(1, opts.limit ?? PAGE_SIZE)
  const page = opts.fromSeq === undefined
    ? newestPage(db, sessionPk, chainFilter, limit, opts.before)
    : jumpPage(db, sessionPk, chainFilter, limit, opts.before, opts.fromSeq)
  if (page === null) return empty
  const { window, hasMore } = page
  const windowSet = new Set(window.map(n => n.uuid))
  const firstSeq = window[0]!.seq
  const lastSeq = window[window.length - 1]!.seq

  const start = db.prepare(
    'SELECT byte_offset AS o FROM messages WHERE session_pk = ? AND seq = ?'
  ).get(sessionPk, firstSeq) as { o: number } | undefined
  if (start === undefined) return empty

  // Read to just before the first row beyond the lookahead window; if there is
  // none, read to end of file.
  //
  // `seq` is assigned to every parsed JSONL line (streamRows), not just
  // message rows -- non-message rows (file-history-snapshot, summary,
  // attachment, ...) consume seq slots but never reach this table, so seq is
  // NOT message-contiguous. Doing arithmetic on it (seq > lastSeq + N) counts
  // line-space, not message-space: a run of non-message rows longer than
  // LOOKAHEAD_ROWS would push the next real message's seq past the threshold
  // and exclude it -- dropping the boundary tool_result the lookahead exists
  // to include. Walking the ordered message rows with OFFSET instead counts
  // actual message rows, so the result is exactly LOOKAHEAD_ROWS messages of
  // lookahead regardless of how many non-message rows are interleaved.
  const stop = db.prepare(
    `SELECT byte_offset AS o FROM messages
     WHERE session_pk = ? AND seq > ?
     ORDER BY seq
     LIMIT 1 OFFSET ?`
  ).get(sessionPk, lastSeq, LOOKAHEAD_ROWS) as { o: number } | undefined
  const toOffset = stop === undefined ? undefined : stop.o - 1

  // The catalog can outlive the transcript file (moved, pruned, on a
  // disconnected drive); a page load must degrade to "nothing to show"
  // rather than crash the whole IPC round trip. But only a genuinely
  // missing file justifies that: swallowing every error here would also
  // hide a real corruption (streamRange rejects with a MAX_LINE_BYTES
  // error on an oversized line) behind an indistinguishable empty page.
  let messages: Array<MessageRow | LocalCommandRow>
  try {
    const { rows } = await streamRange(session.file_path, start.o, toOffset)
    messages = []
    const rewound = rewoundUuids(rows.map(r => r.row))
    for (const { row } of rows) if (isDisplayRow(row) && !rewound.has(row.uuid)) messages.push(row)
  } catch (err) {
    // The catalog knew about messages (nodes were found above) but the JSONL is
    // gone -- almost always Claude Code's cleanupPeriodDays pruning an old chat.
    // Flag it so the UI shows an "archived / removed from disk" state rather
    // than an empty "no messages" one.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return savedTextPage(db, sessionPk, window.map(n => n.uuid), firstSeq, hasMore, chainFilter) ?? { ...empty, fileMissing: true }
    throw err
  }

  return {
    items: buildRenderItems(messages, windowSet),
    oldestSeq: firstSeq,
    hasMore
  }
}

/** A project with no chats stays in the list only if the user made it theirs by favoriting,
 *  naming, or giving it an icon. This is worked out on each read and removes nothing: chats
 *  coming back bring the project back. */
export function keepWithoutChats(meta: ChannelMeta): boolean {
  return meta.starred || meta.friendlyName !== null || meta.icon.kind !== 'initials'
}

/** Merges each project row with its app-owned ChannelMeta (Plan 3 Task 2) --
 *  the nav's actual data source. One `getChannelMeta` SELECT per channel
 *  rather than a bulk `allChannelMeta` map lookup: simpler, and the nav's
 *  channel count is small (one row per ~/.claude project directory) so the
 *  extra queries are not a real cost. `getChannelMeta` already returns sane
 *  defaults for a channel with no metadata row yet, so every project always
 *  gets a `meta`, never undefined. */
export function listChannels(db: Catalog): ChannelRow[] {
  return listProjects(db).flatMap((p): ChannelRow[] => {
    const meta = getChannelMeta(db, p.dirName)
    if (p.sessionCount === 0 && !keepWithoutChats(meta)) return []
    if (!folderGone(p.cwd)) return [{ ...p, meta, repo: p.cwd !== null && p.cwd.length > 0 ? readOriginRepo(p.cwd) : null }]
    // Every chat here moved with the project, so this row has nothing of its own to show.
    const chats = chatsToShow(db, p.id).length
    if (p.sessionCount > 0 && chats === 0) return []
    return [{ ...p, sessionCount: chats, meta, repo: null, archived: true }]
  })
}

/** One-time seed of secrets from a git-ignored `local-secrets.json` at the
 *  project root (dev convenience): if it carries an `openRouterKey` and the
 *  stored setting is still empty, persist it. Keeps a live API key OUT of the
 *  committed source while still pre-filling it on this machine. Best-effort --
 *  a missing/malformed file is silently ignored. */
function seedLocalSecrets(db: Catalog): void {
  try {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'local-secrets.json'), 'utf8')) as { openRouterKey?: unknown }
    const key = typeof parsed.openRouterKey === 'string' ? parsed.openRouterKey : ''
    if (key.length > 0 && getSettings(db).openRouterKey.length === 0) updateSettings(db, { openRouterKey: key })
  } catch { /* no local-secrets.json -- nothing to seed */ }
}

export type IpcHooks = {
  /** Mirrors startup index progress somewhere besides the main window (the
   *  launch splash, while the main window is still hidden). */
  onIndexProgress?: (p: IndexProgress) => void
  /** Settings were saved (tray options may have changed). */
  onSettingsChanged?: (s: AppSettings) => void
  /** A question in the app's own window. Answers with the button's index. */
  ask?: (request: Omit<MainDialogRequest, 'id'>, from?: WebContents) => Promise<number>
  /** Before a restart stops chats that are working: true when nothing is working or
   *  the user agrees. The same question the close button asks. */
  confirmRestart?: () => Promise<boolean>
}

/** Startup registrations launch Delegatto with this, so "Start minimized"
 *  applies to a login start, not to the user opening the app themselves. */
export const AUTOSTART_ARG = '--autostart'

export function registerIpc(db: Catalog, hub: WindowHub, hooks: IpcHooks = {}): void {
  /** The window a request came from, for a native dialog's parent; else the main window. */
  const windowOf = (sender: WebContents): BrowserWindow | null => hub.fromContents(sender) ?? hub.main()
  seedLocalSecrets(db)
  ipcMain.handle(IPC.listProjects, () => listProjects(db))
  ipcMain.handle(IPC.listSessions, (_e, projectId: number) => chatsToShow(db, projectId))
  ipcMain.handle(IPC.loadTranscript, (_e, sessionPk: number, opts?: { before?: number; limit?: number; fromSeq?: number }) =>
    loadTranscript(db, sessionPk, opts))
  ipcMain.handle(IPC.syncSessionIfStale, (_e, sessionPk: number) => syncSessionIfStale(db, sessionPk))
  ipcMain.handle(IPC.listSubagents, (_e, toolUseId: string) => listSubagents(db, toolUseId))
  ipcMain.handle(IPC.search, (_e, query: string) => withoutMovedChats(db, search(db, query)))
  ipcMain.handle(IPC.searchProject, (_e, projectId: number, query: string) => searchProject(db, projectId, query))
  ipcMain.handle(IPC.indexRun, async () => {
    await runIndex(db, {
      onProgress: p => {
        hub.send(IPC.indexProgress, p)
        hooks.onIndexProgress?.(p)
      }
    })
  })

  ipcMain.handle(IPC.listChannels, () => {
    if (db.name !== ':memory:') {
      try {
        moveCustomisations(db, () => backupCatalogOnce(db, join(dirname(db.name), 'catalog-before-archive.db')))
      } catch (err) {
        // Without its backup nothing moves. The nav still has to load.
        console.warn('[archive] could not move a project\'s star and name', err)
      }
    }
    return listChannels(db)
  })
  const pricesReady = loadModelPrices(db, homedir()).then(prices => {
    setModelPrices(prices)
    return prices
  })
  ipcMain.handle(IPC.modelPrices, () => pricesReady)
  ipcMain.handle(IPC.totalCost, async () => {
    await pricesReady
    return sumTotalCostUsd(db)
  })
  ipcMain.handle(IPC.listGroups, () => listGroups(db))
  ipcMain.handle(IPC.setFriendlyName, (_e, dirName: string, name: string | null) => setFriendlyName(db, dirName, name))
  ipcMain.handle(IPC.setStarred, (_e, dirName: string, starred: boolean) => setStarred(db, dirName, starred))
  ipcMain.handle(IPC.setChannelIcon, (_e, dirName: string, icon: ChannelIcon) => setChannelIcon(db, dirName, icon))
  ipcMain.handle(IPC.setChannelGroup, (_e, dirName: string, groupId: number | null) => setChannelGroup(db, dirName, groupId))
  ipcMain.handle(IPC.createGroup, (_e, name: string) => createGroup(db, name))
  ipcMain.handle(IPC.renameGroup, (_e, id: number, name: string) => renameGroup(db, id, name))
  ipcMain.handle(IPC.setGroupIcon, (_e, id: number, icon: ChannelIcon) => setGroupIcon(db, id, icon))
  ipcMain.handle(IPC.deleteGroup, (_e, id: number) => deleteGroup(db, id))
  ipcMain.handle(IPC.setChannelHidden, (_e, dirName: string, hidden: boolean) => setHidden(db, dirName, hidden))
  ipcMain.handle(IPC.deleteChannel, (_e, dirName: string) => {
    const { deletedSessions } = deleteChannel(db, dirName)
    return { deletedSessions }
  })
  ipcMain.handle(IPC.listMcpServers, (_e, projectCwd?: string | null) =>
    listMcpServers({ homeDir: homedir(), projectCwd }))
  ipcMain.handle(IPC.listSkills, (_e, projectCwd?: string | null) =>
    listSkills({ homeDir: homedir(), projectCwd }))
  ipcMain.handle(IPC.fsTree, (_e, cwd: string | null) => readFsTree(cwd))
  ipcMain.handle(IPC.openLink, async (_e, url: string) => {
    if (typeof url === 'string' && /^(https?:\/\/|mailto:)/i.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(IPC.listProjectFiles, (_e, cwd: string | null) => listProjectFiles(cwd))
  ipcMain.handle(IPC.generateAvatar, (_e, prompt: string, size?: string, model?: string) => {
    const s = getSettings(db)
    // A per-generation model override (from the picker) wins; else the setting.
    return generateAvatar({ apiKey: s.openRouterKey, model: model && model.length > 0 ? model : s.avatarModel, prompt, size })
  })
  ipcMain.handle(IPC.listImageModels, () => fetchImageModels())
  ipcMain.handle(IPC.openRouterUsage, () => fetchUsage(getSettings(db).openRouterKey))
  ipcMain.handle(IPC.saveImage, (_e, cwd: string, relPath: string, dataUrl: string) => saveImage({ cwd, relPath, dataUrl }))
  ipcMain.handle(IPC.getSettings, () => getSettings(db))
  ipcMain.handle(IPC.updateSettings, async (e, patch: Partial<AppSettings>) => {
    const before = getSettings(db)
    let after = updateSettings(db, patch)
    const applyStartup = (s: AppSettings): void => { void applyStartupSettings({
      startWithWindows: s.startWithWindows,
      startWithAdmin: s.startWithAdmin,
      exePath: launchExePath(app.getPath('exe')),
      appArgs: [AUTOSTART_ARG]
    }) }
    // Reconcile OS startup registration when a startup/admin field changed.
    if (before.startWithWindows !== after.startWithWindows || before.startWithAdmin !== after.startWithAdmin) {
      // Newly enabling admin: relaunch elevated (one UAC prompt). This instance quits only
      // once the elevated one has started; otherwise the setting goes back off. The startup
      // registration is left alone until then: only the elevated instance can create the
      // admin logon task, and it does so when it starts.
      const relaunching = after.startWithAdmin && !before.startWithAdmin && process.platform === 'win32' && !isElevated()
      if (!relaunching) applyStartup(after)
      if (relaunching) {
        const outcome = await restartElevated(e.sender)
        if (outcome === 'started') {
          app.quit()
        } else {
          after = updateSettings(db, { startWithAdmin: false })
          applyStartup(after)
        }
      }
    }
    hooks.onSettingsChanged?.(after)
    return after
  })
  /** Asks about working chats, then raises the UAC prompt. A notice says why when it didn't
   *  restart for a reason other than the user saying no to the chats question. */
  async function restartElevated(from: WebContents): Promise<'started' | 'cancelled' | 'failed'> {
    const notice = (title: string, detail: string): void => {
      void hooks.ask?.({ title, detail: [detail], buttons: [{ label: 'OK', kind: 'primary' }], defaultIndex: 0, cancelIndex: 0 }, from)
    }
    // A development run's exe is Electron itself, which can't start this app on its own.
    if (!app.isPackaged) {
      notice('Delegatto can’t restart as administrator here', 'Restarting as administrator only works in the installed or portable app.')
      return 'failed'
    }
    if (hooks.confirmRestart !== undefined && !(await hooks.confirmRestart())) return 'cancelled'
    const outcome = await relaunchElevated(launchExePath(app.getPath('exe')), [ELEVATED_RELAUNCH_ARG])
    if (outcome === 'started') return 'started'
    notice('Windows didn’t allow Delegatto to restart as administrator', 'Start with Admin Rights is off again. Turn it on to try again, and choose Yes when Windows asks.')
    return 'failed'
  }
  ipcMain.handle(IPC.isElevated, () => isElevated())

  ipcMain.handle(IPC.listThemes, () => listThemes(db))
  ipcMain.handle(IPC.listLocalThemes, () => listLocalThemes(localThemesDir(app.getPath('userData'))))
  ipcMain.handle(IPC.openLocalThemes, async () => { await shell.openPath(ensureLocalThemesDir(localThemesDir(app.getPath('userData')))) })
  ipcMain.handle(IPC.saveTheme, async (e, rawName: unknown, values: ThemeValues | null): Promise<SaveThemeResult> => {
    const name = cleanThemeName(rawName)
    if (name === null) return { ok: false, reason: 'name', message: `Enter a name of up to ${MAX_THEME_NAME} characters.` }
    if (isBuiltInThemeName(name)) return { ok: false, reason: 'builtin', message: `${name} is a built-in theme, which can't be overwritten. Choose another name.` }
    if (hasTheme(db, name)) {
      const choice = await hooks.ask?.({
        title: `Overwrite ${name}?`,
        detail: ['You already have a theme with this name. Saving replaces it, and it can’t be brought back.'],
        buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Overwrite', kind: 'danger' }],
        defaultIndex: 0,
        cancelIndex: 0
      }, e.sender)
      if (choice !== 1) return { ok: false, reason: 'cancelled' }
    }
    const saved = saveTheme(db, name, values === null || values === undefined ? null : values)
    hooks.onSettingsChanged?.(saved.settings)
    return { ok: true, ...saved }
  })
  ipcMain.handle(IPC.applyTheme, (_e, name: unknown) => {
    const after = typeof name === 'string' ? applyTheme(db, name) : null
    if (after !== null) hooks.onSettingsChanged?.(after)
    return after
  })
  ipcMain.handle(IPC.deleteTheme, async (e, name: unknown) => {
    if (typeof name !== 'string' || !hasTheme(db, name)) return null
    const choice = await hooks.ask?.({
      title: `Delete ${name}?`,
      detail: ['The app keeps looking the way it does now. The saved theme can’t be brought back unless you have exported it.'],
      buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Delete', kind: 'danger' }],
      defaultIndex: 0,
      cancelIndex: 0
    }, e.sender)
    if (choice !== 1) return null
    return deleteTheme(db, name)
  })
  ipcMain.handle(IPC.exportTheme, async (e, suggestedName: unknown): Promise<ExportThemeResult> => {
    const parent = windowOf(e.sender)
    const options: Electron.SaveDialogOptions = {
      title: 'Export theme',
      defaultPath: themeFileName(cleanThemeName(suggestedName) ?? 'My theme'),
      filters: [{ name: 'Delegatto theme', extensions: [THEME_FILE_EXTENSION] }]
    }
    const result = parent !== null ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || result.filePath === undefined) return { status: 'cancelled' }
    // The name it comes back with is the one the user gave the file.
    const name = cleanThemeName(themeNameFromPath(result.filePath)) ?? 'Theme'
    try {
      await writeFile(result.filePath, themeFileText(name, cleanThemeValues(themeValuesOf(getSettings(db)))), 'utf8')
      return { status: 'saved', path: result.filePath }
    } catch (e) {
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) }
    }
  })
  /** A .css theme goes into this PC's themes folder, where the app looks for them. A file
   *  already there (picked from that folder) is used as it is. */
  async function importCssTheme(path: string, from: WebContents): Promise<ImportThemeResult> {
    const name = localThemeName(basename(path))
    if (name === null) return { status: 'invalid', message: `${basename(path)} can’t be a theme name. Rename the file, keeping .css, and import it again.` }
    try {
      if ((await stat(path)).size > MAX_LOCAL_THEME_BYTES) return { status: 'invalid', message: `${basename(path)} is too big for a theme (the limit is 256 KB).` }
      const dir = ensureLocalThemesDir(localThemesDir(app.getPath('userData')))
      const target = join(dir, `${name}.css`)
      if (resolve(target).toLowerCase() !== resolve(path).toLowerCase()) {
        const existing = listLocalThemes(dir).find(t => t.name.toLowerCase() === name.toLowerCase())
        if (existing !== undefined) {
          const choice = await hooks.ask?.({
            title: `Replace ${existing.name}?`,
            detail: [`Your themes folder already has ${existing.name}.css. Importing replaces it with this file.`],
            buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Replace', kind: 'danger' }],
            defaultIndex: 0,
            cancelIndex: 0
          }, from)
          if (choice !== 1) return { status: 'cancelled' }
          // A file named Midnight.css replaces midnight.css, rather than sitting next to it.
          if (existing.name !== name) await unlink(join(dir, `${existing.name}.css`)).catch(() => undefined)
        }
        await copyFile(path, target)
      }
      return { status: 'css', name, id: `${LOCAL_THEME_PREFIX}${name}` as AppTheme }
    } catch (e) {
      return { status: 'invalid', message: `Couldn’t import ${basename(path)}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  ipcMain.handle(IPC.importTheme, async (e): Promise<ImportThemeResult> => {
    const parent = windowOf(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import theme',
      properties: ['openFile'],
      filters: [
        { name: 'Themes', extensions: [THEME_FILE_EXTENSION, 'json', 'css'] },
        { name: 'Delegatto theme', extensions: [THEME_FILE_EXTENSION, 'json'] },
        { name: 'Theme stylesheet (this PC only)', extensions: ['css'] }
      ]
    }
    const result = parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || path === undefined) return { status: 'cancelled' }
    if (/\.css$/i.test(path)) return importCssTheme(path, e.sender)
    const notTheme = { status: 'invalid', message: `${basename(path)} isn’t a Delegatto theme file.` } as const
    let text: string
    try {
      if ((await stat(path)).size > MAX_THEME_FILE_BYTES) return notTheme
      text = await readFile(path, 'utf8')
    } catch (e) {
      return { status: 'invalid', message: `Couldn’t read ${basename(path)}: ${e instanceof Error ? e.message : String(e)}` }
    }
    const file = parseThemeFile(text)
    if (file === null) return notTheme
    const name = file.name ?? cleanThemeName(themeNameFromPath(path)) ?? 'Imported theme'
    return { status: 'ready', name, values: file.values, conflict: isBuiltInThemeName(name) ? 'builtin' : hasTheme(db, name) ? 'custom' : 'none' }
  })
}
