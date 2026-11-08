import { listPins, pinMessage, unpinMessage } from '../catalog/pins'
import { markRewoundFrom } from './chat-actions'
import { PlanUsageTracker } from './plan-usage'
import { app, dialog, ipcMain, type BrowserWindow, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { Catalog } from '../catalog/db'
import { getEngineSessionInfo } from '../catalog/repos'
import { getSettings, updateSettings } from '../catalog/settings'
import { claudeHome } from '../indexer/discover'
import { ENGINE_IPC, type RewindMode, type ClearChatOutcome, type EngineImageInput, type NewProjectOptions, type NewChatOutcome } from '../../shared/engine-ipc-contract'
import { EngineCoordinator, type EngineDefaults, type RulesStore, type SessionInfo } from './coordinator'
import { SessionPool } from './pool'
import { findClaude, LIVE_DETAIL_FLAGS, supportsLiveDetail } from './find-claude'
import { execFile } from 'node:child_process'
import { SessionWatcher } from './watcher'
import { ClaudeLogin } from './claude-login'
import { ClaudeInfoService, parseContextUsage } from './claude-info'
import { getProjectSettings, getProjectSettingsByDir, updateProjectSettings } from '../catalog/project-settings'
import { suggestionsWanted, type ProjectSettings, type ContextUsage } from '../../shared/project-options'
import { hijackChat } from './hijack'
import { listMemoryFiles, readMemoryFile, writeMemoryFile } from '../project-memory'
import type { MemoryFile, MemoryFileContent, MemorySaveResult } from '../../shared/project-memory-types'
import { ShellRunner, shellRunBlocks } from './shell-run'
import { claudeTrusts, folderContents, listTrusts, repoRoot, sameFolder, trustKey } from './folder-trust'
import { cwdToProjectDir } from '../indexer/discover'
import type { FolderTrust } from '../../shared/shell-run-types'
import { homedir } from 'node:os'
import { parseMcpServers } from './mcp-status'
import type { ClaudeInfoResult, McpCheckResult, McpServerStatus } from '../../shared/claude-info-types'
import { Transport } from './transport'
import { PermissionBridge } from './permission-bridge'
import { startNewChat } from './new-chat'
import { availableRepos, defaultCloneRoot, githubStatus, listGithubRepos, prepareRepo, readOriginRepo, realRunner } from './github'
import type { GithubRepoList } from '../../shared/github-types'
import { createIndexDebouncer, syncSessionToCatalog } from './catalog-sync'
import { isExternallyLiveSession, sweepStaleSdkLocks, type OwnedProcess } from './live-sessions'
import { LockMonitor } from './lock-monitor'
import { chromeEnabledFor, claudeChromeDefault, findWindowsTerminal, mcpLoginCommand, openTerminal, terminalCommand } from './terminal'
import { createPeriodicSweep, sweepExternalChanges } from './external-sync'
import { appendHistory, forkTranscript, promptHistory, readHistory, rewindPoints, titleRow } from './chat-actions'
import { listSessions } from '../catalog/repos'
import type { SessionSummary } from '../../shared/types'
import { isCatalogSettled } from '../indexer/indexer'
import { addAllowRule, defaultManagedFiles } from '../claude-settings/files'
import { addHook, removeHook } from '../claude-settings/hooks-edit'
import { loadTranscript } from '../ipc'
import { exportFileName, exportText } from '../export-chat'
import {
  parseHooksListing, parsePlugins, parseWorkspaceDiff, pluginArgsAllowed,
  type ExportChatResult, type HookEntry, type HookScope, type HooksListing, type PanelResult, type PluginActionResult, type PluginsState, type WorkspaceDiff
} from '../../shared/command-panels-types'
import { BYPASS_ACCEPT_INDEX, BYPASS_QUESTION, bypassAccepted, recordBypassAccepted } from './bypass-consent'
import type { AppDialogRequest } from '../../shared/app-dialog'
import type { ElicitationAnswer, LiveEvent, PermissionRequest } from '../../shared/engine-types'

/** The electron boundary for Plan 2's write path (Task 6): constructs the
 *  engine's real dependencies (a real SessionPool spawning real Transports,
 *  a real-watcher factory, a real PermissionBridge, catalog-backed session
 *  lookup, a JSON-file rules store) and wires EngineCoordinator's callbacks
 *  to `ipcMain`/`webContents`. This file MAY import electron -- it is the one
 *  file under src/main/engine the architecture test exempts (by filename,
 *  `*-ipc.ts`) precisely so the coordinator, pool, watcher, transport, and
 *  permission bridge stay electron-free and independently testable.
 *
 *  The real end-to-end (an actual `claude` process, a real MCP config file
 *  the CLI connects to, and terminal-liveness detection) is Task 10 -- this
 *  file wires the pieces together with defensible defaults, not a finished
 *  product. */

function isPlainRecordOfStringArrays(value: unknown): value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
}

/** Minimal JSON-file-backed RulesStore: one file, `{ [cwd]: rule[] }`,
 *  re-read/re-written on every call. Simple and correct is preferred over
 *  fast here -- "allow always" decisions are rare (a handful per session at
 *  most), never on a hot path. Corrupt/missing/malformed file degrades to an
 *  empty rule set rather than throwing -- a broken rules file must never
 *  block a chat from sending. */
function makeJsonRulesStore(filePath: string): RulesStore {
  function load(): Record<string, string[]> {
    if (!existsSync(filePath)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      return isPlainRecordOfStringArrays(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  function save(data: Record<string, string[]>): void {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  return {
    add(cwd: string, rule: string): void {
      const data = load()
      const existing = data[cwd] ?? []
      if (!existing.includes(rule)) existing.push(rule)
      data[cwd] = existing
      save(data)
    },
    get(cwd: string): string[] {
      return load()[cwd] ?? []
    }
  }
}

/** True when `cwd` exists on disk as a directory. A stat failure of any
 *  kind (missing path, a file where a directory is expected, permission
 *  denied) degrades to "doesn't exist" -- startNewChat's guard treats that
 *  as a rejection, never a crash across the IPC boundary. */
function cwdExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/** "Allow always" rules go where Claude Code itself saves "don't ask again":
 *  the project's .claude/settings.local.json, so the terminal honours them too
 *  and the Settings window can show and remove them. Rules saved by older
 *  Delegatto versions (its private JSON file) are still passed on spawn. If
 *  the project file can't be written, the rule falls back to that file. */
function makeClaudeRulesStore(legacy: RulesStore): RulesStore {
  const loc = { claudeDir: claudeHome(), managedFiles: defaultManagedFiles() }
  return {
    add(cwd, rule) {
      try {
        addAllowRule(loc, cwd, rule)
      } catch (err) {
        console.warn('[engine] could not save the rule to Claude Code settings; keeping it in Delegatto', err)
        legacy.add(cwd, rule)
      }
    },
    get: cwd => legacy.get(cwd)
  }
}

/** Optional observers of every chat's activity (desktop notifications). */
export type EngineHooks = {
  onEvent?: (sessionPk: number, e: LiveEvent) => void
  onPermission?: (sessionPk: number, req: PermissionRequest) => void
  /** Asks a question in the app's own window; resolves to the button chosen. */
  ask?: (question: Omit<AppDialogRequest, 'id'>) => Promise<number>
}

export type EngineIpcHandle = {
  dispose(): void
  /** Chats with a turn or background task running: a restart now would cut them off. */
  activeWork(): number
  /** Lower-cased session ids of chats with a turn or background task running. */
  busySessionIds(): string[]
  /** OS pids of Delegatto's own pooled `claude` processes, by session id. */
  ownedProcesses(): Array<{ sessionId: string; pid: number | null }>
  /** Gracefully close Delegatto's own processes for these session ids (lets
   *  each exit and remove its lock). Returns how many were closed. */
  stopOwned(sessionIds: string[]): number
  /** Re-sync the catalog with ~/.claude now (after a Manage operation changed
   *  Claude's data): the same sweep the 30 s timer runs, broadcasting
   *  `engine:indexed` for each changed chat. */
  resync(): Promise<void>
}

/** How often to look for idle processes. A process closes within this long of the
 *  idle limit, which is close enough. */
const REAP_INTERVAL_MS = 60 * 1000
const SIDE_QUESTION_MS = 120_000

/** Claude waits up to 30s for a server to connect, so give it longer than that. */
const MCP_RECONNECT_TIMEOUT_MS = 40_000

const PLAN_CHECK_DELAY_MS = 3000
/** /hooks and /diff: a big diff takes Claude Code a while to gather. */
const PANEL_TIMEOUT_MS = 45_000
const PLUGIN_CLI_TIMEOUT_MS = 60_000
/** Installing clones the plugin's repo. */
const PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60_000


export function registerEngineIpc(db: Catalog, window: BrowserWindow, hooks: EngineHooks = {}): EngineIpcHandle {
  // Read persisted settings once at startup for the engine
  // binary (Plan 3 Task 4/5). Per-new-chat defaults (model/effort/skip) are
  // read below into the coordinator's `defaults`; changing the
  // binary takes effect on next app launch, which is fine.
  const s = getSettings(db)
  const claudeBin = (): string => findClaude(s.claudeBin).bin
  // Thinking text and subagent steps need flags an older Claude Code would refuse to start
  // with, so they're only passed to a version known to have them.
  let liveDetail: boolean | null = null
  const checkLiveDetail = (): void => {
    execFile(claudeBin(), ['--version'], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      if (err === null) liveDetail = supportsLiveDetail(String(stdout))
    })
  }
  checkLiveDetail()
  const rulesStore = makeClaudeRulesStore(makeJsonRulesStore(join(app.getPath('userData'), 'permission-rules.json')))

  // Authoritative two-writers guard (Plan 3 Task 8): a session is externally
  // live iff a ~/.claude/sessions/<pid>.json names its sessionId with a still-
  // running PID that our pool doesn't own. `pool` is only read at call time
  // (inside isSessionExternallyLive's body), long after this setup runs, so
  // the forward reference to `pool` below is safe. This replaces Plan 2's
  // interim mtime<5s heuristic (which false-negatived a live-but-quiet terminal).
  const sessionsDir = join(claudeHome(), 'sessions')
  // Startup hygiene: clear any of our OWN orphaned session locks (headless
  // spawns whose PID died without cleaning up) so a `claude --continue` in
  // those dirs isn't wrongly told "no previous conversation". Scoped to
  // sdk-cli + dead-PID only -- never touches a live process or a real
  // terminal's lock. Best-effort; a failure here must not block engine setup.
  try {
    const swept = sweepStaleSdkLocks(sessionsDir)
    if (swept > 0) console.log(`[engine] cleared ${swept} orphaned session lock(s)`)
  } catch (err) {
    console.error('[engine] stale-lock sweep failed', err)
  }
  // Each lock entry is judged on its own (live-sessions.ts isOwnLock), not
  // short-circuited by "our pool owns this chat" -- so a terminal that resumed
  // a chat Delegatto holds idle is still caught.
  const ownedProcesses = (): OwnedProcess[] =>
    pool.snapshot().map(e => ({ sessionKey: e.sessionKey, pid: e.pid, startedAt: e.startedAt }))
  function isSessionExternallyLive(sessionKey: string): boolean {
    return isExternallyLiveSession(sessionKey, { sessionsDir, owned: ownedProcesses })
  }

  const pool = new SessionPool({
    idleReapMs: () => getSettings(db).idleReapMin * 60 * 1000,
    transportFactory: (spec) => new Transport(spec, { claudeBin: claudeBin() }),
    isExternallyLive: isSessionExternallyLive,
    trustToAttest: cwd => trustToAttest(cwd)
  })

  // Fix 2: without this tick, reapIdle() was never called in production --
  // see REAP_INTERVAL_MS's own comment above. `unref()` so this timer alone
  // never keeps the app process alive (mirrors PermissionBridge's own
  // per-request timeout, which does the same for the same reason).
  const reapInterval = setInterval(() => pool.reapIdle(Date.now()), REAP_INTERVAL_MS)
  reapInterval.unref?.()

  // Bare MCP tool name -- the CLI advertises it under the server as `approve`
  // and prefixes the server itself, resolving --permission-prompt-tool to
  // `mcp__delegatto__approve` (the relay computes that fully-qualified name).
  // Confirmed live: the CLI's tools/call sends params.name === "approve".
  // Like the terminal, it waits as long as it takes: Claude Code is holding the tool call.
  const bridge = new PermissionBridge({ toolName: 'approve', timeoutMs: 0 })

  /** The user's own Claude Code settings can turn suggestions off altogether. */
  const claudeAllowsSuggestions = (): boolean => {
    try {
      return (JSON.parse(readFileSync(join(claudeHome(), 'settings.json'), 'utf8')) as { promptSuggestionEnabled?: unknown }).promptSuggestionEnabled !== false
    } catch {
      return true
    }
  }
  const shellRunner = new ShellRunner({
    storePath: join(app.getPath('userData'), 'pending-shell-runs.json'),
    onChange: (sessionPk, runs) => { if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.shellChanged, sessionPk, runs) },
    onFinished: run => coordinator.deliverShellOutput(run.sessionPk)
  })
  const coordinator = new EngineCoordinator({
    folderExists: existsSync,
    contextForMessage: sessionPk => shellRunBlocks(shellRunner.takeFinished(sessionPk)),
    wantsSuggestions: sessionPk => suggestionsWanted(getSettings(db).promptSuggestions, getProjectSettings(db, sessionPk), claudeAllowsSuggestions()),
    // A folder that has gone would stop Claude from starting at all.
    projectDirs: sessionPk => (getProjectSettings(db, sessionPk).extraDirs ?? []).filter(d => existsSync(d)),
    addProjectDir: (sessionPk, dir) => {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
      const known = getProjectSettings(db, sessionPk).extraDirs ?? []
      if (!known.some(d => d.toLowerCase() === dir.toLowerCase())) updateProjectSettings(db, sessionPk, { extraDirs: [...known, dir] })
      return true
    },
    projectDefaults: {
      load: sessionPk => {
        const c = getProjectSettings(db, sessionPk)
        return { ...(c.model !== undefined ? { model: c.model } : {}), ...(c.effort !== undefined ? { effort: c.effort } : {}), ...(c.skipPermissions !== undefined ? { skipPermissions: c.skipPermissions } : {}) }
      },
      save: (sessionPk, o) => { updateProjectSettings(db, sessionPk, { model: o.model, effort: o.effort, skipPermissions: o.skipPermissions }) }
    },
    pool,
    makeWatcher: () => new SessionWatcher(),
    bridge,
    lookupSession: (sessionPk): SessionInfo | null => {
      const info = getEngineSessionInfo(db, sessionPk)
      if (info === null) return null
      // EngineSessionInfo is coordinator's SessionInfo minus `sessionKey`:
      // the file path is the schema's own unique key for a session file, and
      // the natural "same file = same writer" identity the pool's
      // two-writer guard cares about.
      return { ...info, sessionKey: info.filePath }
    },
    rulesStore,
    defaults: {
      // Plan 3 Task 5: real persisted new-chat defaults. A per-chat override
      // (from the New-Chat dialog) still spreads over these via
      // EngineCoordinator.effectiveDefaults.
      skipPermissions: s.defaultSkipPermissions,
      model: s.defaultModel ?? undefined,
      effort: s.defaultEffort ?? undefined,
      claudeBin: s.claudeBin
    },
    isExternallyLive: isSessionExternallyLive,
    chromeEnabled: () => chromeEnabledFor(getSettings(db).chromeIntegration, () => claudeChromeDefault()),
    liveDetailFlags: () => {
      if (liveDetail === null) checkLiveDetail()
      return liveDetail === true ? LIVE_DETAIL_FLAGS : []
    },
    spawnExtras: () => {
      const cur = getSettings(db)
      return { maxBudgetUsd: cur.defaultBudgetUsd, extraFlags: cur.extraFlags }
    }
  })

  // External-lock monitor: makes a chat read-only in the UI while a terminal
  // holds it. On takeover it (a) releases Delegatto's own IDLE process for
  // that chat -- its in-memory conversation is now stale, so the next send
  // must respawn with a fresh --resume rather than fork the transcript -- and
  // (b) tails the chat's file so the terminal's turns stream into the open
  // transcript live.
  const resolveLockTarget = db.prepare(
    `SELECT id AS sessionPk, file_path AS filePath, project_id AS projectId FROM sessions WHERE session_id = ? AND kind = 'main'`
  )
  const lockMonitor = new LockMonitor({
    sessionsDir,
    owned: ownedProcesses,
    resolve: (sessionId) =>
      (resolveLockTarget.get(sessionId) as { sessionPk: number; filePath: string; projectId: number } | undefined) ?? null,
    onChange: (target, lock) => {
      if (lock !== null) {
        pool.releaseIdle(target.filePath)
        coordinator.watchSession(target.sessionPk)
      }
      if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.lockChanged, target.sessionPk, lock)
    },
    onRemoteChange: (remote) => {
      if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.remoteChanged, remote)
    }
  })
  lockMonitor.start()
  ipcMain.handle(ENGINE_IPC.listRemote, () => {
    lockMonitor.refresh()
    return lockMonitor.getRemote()
  })
  ipcMain.handle(ENGINE_IPC.getLock, (_e, sessionPk: number) => {
    // Fresh read (not just the cached state): the open-chat check must not
    // miss a lock whose fs event is still inside the debounce window.
    lockMonitor.refresh()
    return lockMonitor.get(sessionPk)
  })

  const onSend = (_e: unknown, sessionPk: number, text: string, images?: EngineImageInput[], uuid?: string): void => {
    coordinator.send(sessionPk, text, images, uuid)
  }
  const onInterrupt = (_e: unknown, sessionPk: number): void => {
    coordinator.interrupt(sessionPk)
  }
  const onResolvePermission = (
    _e: unknown,
    id: string,
    decision: 'allow' | 'allow_always' | 'allow_folder' | 'deny',
    editedInput?: unknown,
    denyMessage?: string
  ): void => {
    coordinator.resolvePermission(id, decision, editedInput, denyMessage)
  }

  const liveModelChange = (sessionPk: number, overrides: { model?: unknown }): void => {
    if (typeof overrides.model === 'string' && overrides.model.length > 0) void coordinator.setLiveModel(sessionPk, overrides.model)
  }

  const onSetSessionOverrides = (
    _e: unknown,
    sessionPk: number,
    overrides: { model?: string; effort?: string }
  ): void => {
    // Only pass through fields that are actually set — the coordinator spreads
    // this over its global defaults, so a stray `undefined` would clobber one.
    // An empty value is "Default" in the pickers: it clears the chat's own choice.
    const clean: Partial<EngineDefaults> = {}
    if (typeof overrides?.model === 'string') clean.model = overrides.model.length > 0 ? overrides.model : undefined
    if (typeof overrides?.effort === 'string') clean.effort = overrides.effort.length > 0 ? overrides.effort : undefined
    coordinator.mergeSessionDefaults(sessionPk, clean)
    liveModelChange(sessionPk, overrides)
  }

  const countChats = db.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.dir_name = ?`)
  const readClaudeJson = (): string | null => {
    try { return readFileSync(join(homedir(), '.claude.json'), 'utf8') } catch { return null } // none yet
  }
  const isHome = (cwd: string): boolean => sameFolder(cwd, homedir())
  /** The home folder, once the user trusts it: for this run only, as in Claude Code. */
  let homeTrusted = false
  /** A folder is fine if Claude Code or the user already trusts it, or chats have
   *  already run there; only a folder Claude has never worked in gets asked about. */
  const isFolderTrusted = (cwd: string): boolean => {
    if (!existsSync(cwd)) return true // creating the chat reports this properly
    if (isHome(cwd)) return homeTrusted
    if (listTrusts(cwd, getSettings(db).trustedFolders) !== null) return true
    if ((countChats.get(cwdToProjectDir(cwd)) as { n: number }).n > 0) return true
    return claudeTrusts(cwd, readClaudeJson())
  }
  /** Tell Claude Code only what the user answered in Delegatto's prompt, and only
   *  while Claude Code doesn't already trust the folder. */
  const trustToAttest = (cwd: string): string | null => {
    if (!existsSync(cwd)) return null
    if (isHome(cwd)) return homeTrusted ? cwd : null
    if (listTrusts(cwd, getSettings(db).trustedFolders) === null) return null
    return claudeTrusts(cwd, readClaudeJson()) ? null : trustKey(cwd)
  }
  const onNewChat = (_e: unknown, options: NewProjectOptions): NewChatOutcome => {
    if (!isFolderTrusted(options.cwd.trim())) return { ok: false, error: "That folder hasn't been trusted yet." }
    const outcome = startNewChat(
      { db, makeSessionId: () => randomUUID(), cwdExists, claudeHomeDir: claudeHome() },
      options
    )
    if (!outcome.ok) return { ok: false, error: outcome.error }

    // Task 8's per-chat overrides: only set fields the dialog actually gave
    // a value for. Setting e.g. `model: undefined` explicitly would spread
    // over (and clobber) the coordinator's global default for this session
    // -- see EngineCoordinator.effectiveDefaults, which spreads this object
    // directly over deps.defaults.
    const overrides: Partial<EngineDefaults> = { skipPermissions: options.skipPermissions }
    if (options.model !== undefined) overrides.model = options.model
    if (options.effort !== undefined) overrides.effort = options.effort
    // Merged, not replaced: these belong to the project, which may already have others.
    coordinator.mergeSessionDefaults(outcome.result.sessionPk, overrides)

    return { ok: true, sessionPk: outcome.result.sessionPk, sessionId: outcome.result.sessionId }
  }
  const onPickDirectory = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  }

  ipcMain.on(ENGINE_IPC.send, onSend)
  ipcMain.on(ENGINE_IPC.interrupt, onInterrupt)
  ipcMain.on(ENGINE_IPC.resolvePermission, onResolvePermission)
  ipcMain.on(ENGINE_IPC.setSessionOverrides, onSetSessionOverrides)
  ipcMain.handle(ENGINE_IPC.newChat, onNewChat)
  ipcMain.handle(ENGINE_IPC.pickDirectory, onPickDirectory)
  // "Open in terminal": hands a chat to the real interactive Claude Code (for
  // /mcp, /login and anything else headless mode can't do). Delegatto's own
  // idle process for the chat is closed first so the two never write at once;
  // the lock monitor then keeps the chat read-only here until the terminal exits.
  ipcMain.handle(ENGINE_IPC.openInTerminal, async (_e, sessionPk: number): Promise<{ ok: true } | { ok: false; error: string; cancelled?: true }> => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) return { ok: false, error: 'That chat is no longer available.' }
    if (pool.isTurnRunning(info.filePath)) {
      return { ok: false, error: 'Claude is still replying here. Wait for it to finish, or press Esc to stop it, then try again.' }
    }
    if (info.cwd === null || info.cwd.length === 0 || !existsSync(info.cwd)) {
      return { ok: false, error: "This chat's folder no longer exists, so it can't be opened in a terminal." }
    }
    const flags = coordinator.terminalFlags(sessionPk)
    // Claude Code asks this once in the terminal; Delegatto asks it first, in its own window.
    if (flags.includes('--dangerously-skip-permissions') && hooks.ask !== undefined) {
      const loc = { claudeDir: claudeHome(), managedFiles: defaultManagedFiles() }
      if (!bypassAccepted(loc, info.cwd, readClaudeJson())) {
        if (await hooks.ask(BYPASS_QUESTION) !== BYPASS_ACCEPT_INDEX) return { ok: false, error: '', cancelled: true }
        // If the file can't be written, the terminal just asks for itself.
        try { recordBypassAccepted(loc) } catch (err) { console.warn('Could not record bypass acceptance', err) }
      }
    }
    try {
      pool.releaseIdle(info.filePath)
      await openTerminal(terminalCommand(info.cwd, info.resumeId, findClaude(getSettings(db).claudeBin).bin, findWindowsTerminal(), flags), info.cwd)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `Couldn't open a terminal: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
  ipcMain.handle(ENGINE_IPC.shellRun, (_e, sessionPk: number, command: string): void => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null || info.cwd === null || info.cwd.length === 0) return
    shellRunner.run(sessionPk, info.cwd, command)
  })
  ipcMain.handle(ENGINE_IPC.shellStop, (_e, id: string): void => shellRunner.stop(id))
  ipcMain.handle(ENGINE_IPC.shellDismiss, (_e, id: string): void => shellRunner.dismiss(id))
  ipcMain.handle(ENGINE_IPC.shellList, (_e, sessionPk: number) => shellRunner.list(sessionPk))
  ipcMain.handle(ENGINE_IPC.folderTrust, (_e, cwd: string): FolderTrust => {
    const root = repoRoot(cwd)
    return { trusted: isFolderTrusted(cwd), contents: folderContents(cwd), repoRoot: root !== null && !sameFolder(root, cwd) ? root : null, home: isHome(cwd) }
  })
  // Kept for the repository root when there is one: Claude Code trusts the whole repository too.
  ipcMain.handle(ENGINE_IPC.trustFolder, (_e, cwd: string): void => {
    if (isHome(cwd)) { homeTrusted = true; return }
    const key = trustKey(cwd)
    const current = getSettings(db).trustedFolders
    if (!current.some(f => sameFolder(f, key))) updateSettings(db, { trustedFolders: [...current, key] })
  })
  ipcMain.handle(ENGINE_IPC.githubStatus, () => githubStatus(realRunner))
  ipcMain.handle(ENGINE_IPC.githubRepos, async (): Promise<GithubRepoList> => {
    try {
      const repos = await listGithubRepos(realRunner)
      const cwds = (db.prepare("SELECT cwd FROM projects WHERE cwd IS NOT NULL AND cwd <> ''").all() as Array<{ cwd: string }>).map(r => r.cwd)
      const root = defaultCloneRoot(cwds.filter(cwd => readOriginRepo(cwd) !== null), homedir())
      return { ok: true, repos: availableRepos(repos, cwds, root) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.githubPrepare, (_e, options: { repo: string; cwd: string }) => prepareRepo(realRunner, options))
  ipcMain.handle(ENGINE_IPC.contextUsage, async (_e, sessionPk: number): Promise<ContextUsage | null> => {
    const info = getEngineSessionInfo(db, sessionPk)
    const answer = info === null ? null : pool.request(info.filePath, 'get_context_usage')
    if (answer === null) return null
    try { return parseContextUsage(await answer) } catch { return null }
  })
  ipcMain.handle(ENGINE_IPC.getProjectSettings, (_e, sessionPk: number) => getProjectSettings(db, sessionPk))
  ipcMain.handle(ENGINE_IPC.folderSettings, (_e, cwd: string) => getProjectSettingsByDir(db, cwdToProjectDir(cwd.trim())))
  ipcMain.handle(ENGINE_IPC.setProjectSettings, (_e, sessionPk: number, patch: Partial<ProjectSettings>) =>
    updateProjectSettings(db, sessionPk, {
      ...('promptSuggestions' in patch ? { promptSuggestions: patch.promptSuggestions } : {}),
      ...('toolDisplay' in patch ? { toolDisplay: patch.toolDisplay } : {}),
      ...('thinkingDisplay' in patch ? { thinkingDisplay: patch.thinkingDisplay } : {}),
      ...('filesExpanded' in patch ? { filesExpanded: patch.filesExpanded } : {}),
      ...('extraDirs' in patch ? { extraDirs: patch.extraDirs } : {})
    }))
  // `/add-dir` with a folder, or the folder picker with none. A picker closed without choosing adds nothing.
  ipcMain.handle(ENGINE_IPC.addProjectDir, async (_e, sessionPk: number, path: string | null) => {
    const current = getProjectSettings(db, sessionPk)
    const chosen = path ?? await onPickDirectory()
    if (chosen === null) return { ok: true, added: null, settings: current }
    const info = getEngineSessionInfo(db, sessionPk)
    const dir = resolve(info?.cwd ?? '', chosen)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, error: `Couldn't add ${dir}: that folder doesn't exist.` }
    const known = current.extraDirs ?? []
    if (known.some(d => d.toLowerCase() === dir.toLowerCase())) return { ok: true, added: dir, settings: current }
    return { ok: true, added: dir, settings: updateProjectSettings(db, sessionPk, { extraDirs: [...known, dir] }) }
  })
  const projectLookup = db.prepare('SELECT dir_name AS dirName, cwd FROM projects WHERE id = ?')
  const projectChats = db.prepare("SELECT id, file_path AS filePath FROM sessions WHERE project_id = ? AND kind = 'main'")
  const projectPaths = (projectId: number): { cwd: string | null; projectDir: string } => {
    const row = projectLookup.get(projectId) as { dirName: string; cwd: string | null } | undefined
    if (row === undefined) throw new Error('That project is no longer available.')
    return { cwd: row.cwd, projectDir: join(claudeHome(), 'projects', row.dirName) }
  }
  ipcMain.handle(ENGINE_IPC.showProjectFolder, async (_e, projectId: number): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { cwd } = projectPaths(projectId)
    if (cwd === null || cwd.length === 0 || !existsSync(cwd)) return { ok: false, error: "This project's folder no longer exists." }
    const problem = await shell.openPath(cwd)
    return problem.length === 0 ? { ok: true } : { ok: false, error: problem }
  })
  ipcMain.handle(ENGINE_IPC.memoryList, (_e, projectId: number): MemoryFile[] => {
    const { cwd, projectDir } = projectPaths(projectId)
    return listMemoryFiles(cwd, projectDir).map(({ id, label, note, exists }) => ({ id, label, note, exists }))
  })
  ipcMain.handle(ENGINE_IPC.memoryRead, (_e, projectId: number, fileId: string): MemoryFileContent => {
    const { cwd, projectDir } = projectPaths(projectId)
    return readMemoryFile(cwd, projectDir, fileId)
  })
  ipcMain.handle(ENGINE_IPC.memorySave, (_e, projectId: number, fileId: string, text: string, expectedMtimeMs: number | null): MemorySaveResult => {
    try {
      const { cwd, projectDir } = projectPaths(projectId)
      const content = writeMemoryFile(cwd, projectDir, fileId, text, expectedMtimeMs)
      let restarted = 0, afterTurn = 0, inTerminal = 0
      for (const chat of projectChats.all(projectId) as Array<{ id: number; filePath: string }>) {
        const outcome = pool.restartForReload(chat.filePath)
        if (outcome === 'restarted') restarted++
        if (outcome === 'afterTurn') afterTurn++
        if (lockMonitor.get(chat.id) !== null) inTerminal++
      }
      return { ok: true, content, restarted, afterTurn, inTerminal }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.hijackChat, async (_e, sessionPk: number): Promise<{ ok: true } | { ok: false; error: string }> => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) return { ok: false, error: 'That chat is no longer available.' }
    try {
      const result = await hijackChat(info.filePath, { sessionsDir, owned: ownedProcesses })
      lockMonitor.refresh() // unlocks the chat now, rather than on the next sweep
      externalSweep.poke() // picks up whatever the terminal wrote last
      return result
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.clearChat, (_e, sessionPk: number): ClearChatOutcome => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) return { ok: false, error: 'That chat is no longer available.' }
    if (info.cwd === null || info.cwd.length === 0) return { ok: false, error: "This chat's folder is unknown, so a new chat can't start there." }
    if (pool.isTurnRunning(info.filePath)) return { ok: false, error: 'Claude is still replying here. Wait for it to finish, or press Esc to stop it, then try again.' }
    if (!existsSync(info.filePath)) return { ok: true, cwd: info.cwd, sessionId: info.resumeId, unchanged: true }
    const outcome = startNewChat({ db, makeSessionId: () => randomUUID(), cwdExists, claudeHomeDir: claudeHome() }, { cwd: info.cwd, skipPermissions: false })
    if (!outcome.ok) return { ok: false, error: outcome.error }
    pool.releaseIdle(info.filePath)
    return { ok: true, cwd: info.cwd, sessionId: outcome.result.sessionId, unchanged: false }
  })
  const chromeOn = (): boolean => chromeEnabledFor(getSettings(db).chromeIntegration, () => claudeChromeDefault())
  const claudeInfo = new ClaudeInfoService({ claudeBin, chromeEnabled: chromeOn })
  const planUsage = new PlanUsageTracker(join(app.getPath('userData'), 'plan-usage.json'))
  planUsage.onChange(u => { if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.planUsageChanged, u) })
  ipcMain.handle(ENGINE_IPC.planUsage, () => planUsage.get())
  // Left until the app has settled: nothing depends on it, and it starts a process.
  const planCheck = setTimeout(() => {
    claudeInfo.planUsage(homedir()).then(a => planUsage.applyAnswer(a)).catch(err => console.warn('[engine] plan usage check failed', err))
  }, PLAN_CHECK_DELAY_MS)
  planCheck.unref?.()
  const planUsageRefresh = (): void => {
    claudeInfo.planUsage(homedir()).then(a => planUsage.applyAnswer(a)).catch(err => console.warn('[engine] plan usage check failed', err))
  }
  const folderOrHome =(cwd: string | null): string => cwd !== null && cwd.length > 0 && existsSync(cwd) ? cwd : homedir()
  const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err)
  const chatMcpStatus = async (sessionPk: number): Promise<McpServerStatus[] | null> => {
    const info = getEngineSessionInfo(db, sessionPk)
    const answer = info === null ? null : pool.request(info.filePath, 'mcp_status')
    if (answer === null) return null
    const value = await answer as { mcpServers?: unknown } | null
    return parseMcpServers(value?.mcpServers)
  }
  ipcMain.handle(ENGINE_IPC.mcpStatus, async (_e, sessionPk: number): Promise<McpServerStatus[] | null> => {
    try { return await chatMcpStatus(sessionPk) } catch { return null }
  })
  /** A request to the chat's own Claude process about one server, then where things stand. */
  const chatMcpRequest = async (sessionPk: number, subtype: string, body: object): Promise<McpCheckResult> => {
    const info = getEngineSessionInfo(db, sessionPk)
    const answer = info === null ? null : pool.request(info.filePath, subtype, body, MCP_RECONNECT_TIMEOUT_MS)
    if (answer === null) return { ok: false, error: 'This chat has no process running. Send a message to start one.' }
    try {
      await answer
      return { ok: true, servers: await chatMcpStatus(sessionPk) ?? [] }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  }
  ipcMain.handle(ENGINE_IPC.mcpReconnect, (_e, sessionPk: number, name: string): Promise<McpCheckResult> =>
    chatMcpRequest(sessionPk, 'mcp_reconnect', { serverName: name }))
  // Claude Code saves this itself, so it lasts past the chat's process, as `/mcp disable` does.
  ipcMain.handle(ENGINE_IPC.mcpToggle, (_e, sessionPk: number, name: string, enabled: boolean): Promise<McpCheckResult> =>
    chatMcpRequest(sessionPk, 'mcp_toggle', { serverName: name, enabled: enabled === true }))
  /** A question for Claude Code about a chat: its own process if it has one, so the answer is
   *  that chat's, otherwise a brief process in its folder. */
  const askAboutChat = async (sessionPk: number, subtype: string, opts: { quiet?: boolean } = {}): Promise<unknown> => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) throw new Error('That chat is no longer available.')
    const live = pool.request(info.filePath, subtype, {}, PANEL_TIMEOUT_MS)
    if (live !== null) return await live
    return await claudeInfo.control(folderOrHome(info.cwd), subtype, {}, opts)
  }
  const hooksOf = async (sessionPk: number): Promise<PanelResult<HooksListing>> => {
    try { return { ok: true, value: parseHooksListing(await askAboutChat(sessionPk, 'get_hooks_listing')) } } catch (err) { return { ok: false, error: errorText(err) } }
  }
  /** Hooks are read when a process starts, so running chats in the folder start again. */
  const reloadChatsIn = (cwd: string | null): void => {
    for (const s of pool.snapshot()) {
      const row = db.prepare('SELECT p.cwd AS cwd FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.file_path = ?').get(s.sessionKey) as { cwd: string | null } | undefined
      if (cwd === null || (row?.cwd != null && sameFolder(row.cwd, cwd))) pool.restartForReload(s.sessionKey)
    }
  }
  // Signing in to Claude Code from the app. Once signed in, running chats start again on the new login.
  const login = new ClaudeLogin({
    claudeBin,
    cwd: () => homedir(),
    openUrl: url => { void shell.openExternal(url) },
    onChange: state => { if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.loginChanged, state) },
    onSignedIn: () => { reloadChatsIn(null); planUsageRefresh() }
  })
  ipcMain.handle(ENGINE_IPC.loginState, () => login.state)
  ipcMain.handle(ENGINE_IPC.loginStart, () => login.start())
  ipcMain.handle(ENGINE_IPC.loginSubmitCode, (_e, code: unknown) => login.submitCode(typeof code === 'string' ? code : ''))
  ipcMain.handle(ENGINE_IPC.loginCancel, () => { login.cancel() })
  const settingsLoc = () => ({ claudeDir: claudeHome(), managedFiles: defaultManagedFiles() })
  ipcMain.handle(ENGINE_IPC.hooksListing, (_e, sessionPk: number) => hooksOf(sessionPk))
  ipcMain.handle(ENGINE_IPC.addHook, async (_e, sessionPk: number, scope: HookScope, hook: { event: string; matcher: string | null; command: string; timeout?: number }): Promise<PanelResult<HooksListing>> => {
    const cwd = getEngineSessionInfo(db, sessionPk)?.cwd ?? null
    try { addHook(settingsLoc(), scope, cwd, hook) } catch (err) { return { ok: false, error: errorText(err) } }
    reloadChatsIn(scope === 'user' ? null : cwd)
    return hooksOf(sessionPk)
  })
  ipcMain.handle(ENGINE_IPC.removeHook, async (_e, sessionPk: number, hook: HookEntry): Promise<PanelResult<HooksListing> | { ok: false; cancelled: true }> => {
    if (hook.scope === null || hook.config === null) return { ok: false, error: 'That hook isn’t in a settings file Delegatto can change.' }
    const choice = await hooks.ask?.({
      title: 'Remove this hook?',
      detail: [`${hook.event}${hook.matcher !== null ? ` (${hook.matcher})` : ''}: ${hook.text}`, `It’s taken out of ${hook.sourceLabel}.`],
      buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Remove', kind: 'danger' }],
      defaultIndex: 0,
      cancelIndex: 0
    })
    if (choice !== 1) return { ok: false, cancelled: true }
    const cwd = getEngineSessionInfo(db, sessionPk)?.cwd ?? null
    try {
      if (!removeHook(settingsLoc(), hook.scope, cwd, { event: hook.event, matcher: hook.matcher, config: hook.config })) return { ok: false, error: 'That hook isn’t in the file any more. It may have been changed elsewhere.' }
    } catch (err) { return { ok: false, error: errorText(err) } }
    reloadChatsIn(hook.scope === 'user' ? null : cwd)
    return hooksOf(sessionPk)
  })
  ipcMain.handle(ENGINE_IPC.workspaceDiff, async (_e, sessionPk: number): Promise<PanelResult<WorkspaceDiff>> => {
    try { return { ok: true, value: parseWorkspaceDiff(await askAboutChat(sessionPk, 'get_workspace_diff', { quiet: true })) } } catch (err) { return { ok: false, error: errorText(err) } }
  })
  ipcMain.handle(ENGINE_IPC.exportChat, async (_e, sessionPk: number, mode: 'file' | 'text', fileName?: string): Promise<ExportChatResult> => {
    try {
      const row = db.prepare('SELECT COALESCE(s.custom_title, s.ai_title, s.title) AS title, p.cwd AS cwd FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(sessionPk) as { title: string | null; cwd: string | null } | undefined
      if (row === undefined) return { status: 'failed', message: 'That chat is no longer available.' }
      const page = await loadTranscript(db, sessionPk, { limit: Number.MAX_SAFE_INTEGER })
      const text = exportText(page.items, { title: row.title ?? 'Chat', cwd: row.cwd })
      if (mode === 'text') return { status: 'text', text }
      let path: string
      const named = (fileName ?? '').trim()
      if (named !== '' && row.cwd !== null && existsSync(row.cwd)) {
        // As `/export name` does in the terminal: into the chat's folder, as .txt.
        path = resolve(row.cwd, /\.[a-z0-9]+$/i.test(named) ? named : `${named}.txt`)
      } else {
        const picked = await dialog.showSaveDialog(window, {
          title: 'Export chat',
          defaultPath: join(row.cwd !== null && existsSync(row.cwd) ? row.cwd : homedir(), exportFileName()),
          filters: [{ name: 'Text', extensions: ['txt', 'md'] }]
        })
        if (picked.canceled || picked.filePath === undefined) return { status: 'cancelled' }
        path = picked.filePath
      }
      writeFileSync(path, text, 'utf8')
      return { status: 'saved', path }
    } catch (err) {
      return { status: 'failed', message: errorText(err) }
    }
  })
  /** `claude plugin …`, run in the folder (project-scope plugins are per folder). */
  const runPluginCli = (cwd: string | null, args: string[], timeoutMs = PLUGIN_CLI_TIMEOUT_MS): Promise<string> => new Promise((done, fail) => {
    execFile(claudeBin(), ['plugin', ...args], { cwd: folderOrHome(cwd), windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) fail(new Error((String(stderr).trim() || String(stdout).trim() || err.message).split('\n').slice(-6).join('\n')))
      else done(String(stdout))
    })
  })
  ipcMain.handle(ENGINE_IPC.pluginsList, async (_e, cwd: string | null): Promise<PanelResult<PluginsState>> => {
    try {
      const [list, markets] = await Promise.all([runPluginCli(cwd, ['list', '--json', '--available']), runPluginCli(cwd, ['marketplace', 'list', '--json'])])
      return { ok: true, value: parsePlugins(JSON.parse(list), JSON.parse(markets)) }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.pluginAction, async (_e, cwd: string | null, args: string[]): Promise<PluginActionResult> => {
    if (!pluginArgsAllowed(args)) {
      return { ok: false, error: 'Delegatto doesn’t run that plugin command.' }
    }
    try {
      const output = await runPluginCli(cwd, args, PLUGIN_INSTALL_TIMEOUT_MS)
      // What the terminal's /reload-plugins does, for every chat with a process running.
      let reloaded = 0
      await Promise.all(pool.snapshot().map(async s => {
        const answer = pool.request(s.sessionKey, 'reload_plugins', {}, PANEL_TIMEOUT_MS)
        if (answer === null) return
        try { await answer; reloaded++ } catch { pool.restartForReload(s.sessionKey); reloaded++ }
      }))
      claudeInfo.forget()
      return { ok: true, output: output.trim(), reloaded }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.mcpCheck, async (_e, cwd: string | null): Promise<McpCheckResult> => {
    try {
      return { ok: true, servers: await claudeInfo.mcpCheck(folderOrHome(cwd)) }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.mcpLogin, async (_e, cwd: string | null, name: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const folder = folderOrHome(cwd)
    try {
      await openTerminal(mcpLoginCommand(folder, name, claudeBin(), findWindowsTerminal()), folder)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `Couldn't open a terminal: ${errorText(err)}` }
    }
  })
  ipcMain.handle(ENGINE_IPC.claudeInfo, async (_e, cwd: string | null, refresh?: boolean): Promise<ClaudeInfoResult> => {
    try {
      return { ok: true, info: await claudeInfo.get(folderOrHome(cwd), { refresh: refresh === true }) }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.isSessionLive, (_e, sessionPk: number) => {
    const info = getEngineSessionInfo(db, sessionPk)
    // Turn-running (not merely process-pooled): App reads this to re-derive the
    // composer's `running` state on reopen. An idle-but-pooled transport is
    // isLive() true but isTurnRunning() false, so reopening a chat whose last
    // turn already finished no longer wedges the composer into queue mode.
    return info !== null && pool.isTurnRunning(info.filePath)
  })
  ipcMain.handle(ENGINE_IPC.turnInfo, (_e, sessionPk: number) => {
    const info = getEngineSessionInfo(db, sessionPk)
    return info === null ? null : pool.turnInfo(info.filePath)
  })
  ipcMain.handle(ENGINE_IPC.answerElicitation, (_e, sessionPk: number, requestId: string, answer: ElicitationAnswer) => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info !== null) pool.respond(info.filePath, requestId, answer)
  })
  ipcMain.handle(ENGINE_IPC.chatMode, (_e, sessionPk: number) => coordinator.modeOf(sessionPk))
  // A subagent that just finished isn't indexed until the next sweep, and there's no need to wait.
  ipcMain.handle(ENGINE_IPC.indexNow, async (): Promise<void> => {
    await sweepExternalChanges(db, { skip: fp => pool.isTurnRunning(fp) })
  })
  const historyFile = (): string => join(claudeHome(), 'history.jsonl')
  ipcMain.handle(ENGINE_IPC.claudeFound, () => findClaude(getSettings(db).claudeBin).found)
  ipcMain.handle(ENGINE_IPC.promptHistory, async (_e, sessionPk: number) => {
    const info = getEngineSessionInfo(db, sessionPk)
    return promptHistory(db, sessionPk, info === null || info.cwd.length === 0 ? [] : await readHistory(historyFile(), info.cwd))
  })
  ipcMain.handle(ENGINE_IPC.keepInHistory, async (_e, sessionPk: number, text: string) => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null || info.cwd.length === 0) return
    await appendHistory(historyFile(), { text, project: info.cwd, sessionId: info.resumeId, at: Date.now() }).catch(err => console.error('Could not keep cleared text', err))
  })
  ipcMain.handle(ENGINE_IPC.renameChat, async (_e, sessionPk: number, title: string): Promise<void> => {
    const info = getEngineSessionInfo(db, sessionPk)
    const name = title.trim()
    if (info === null || name.length === 0) return
    // A running process keeps its own idea of the name, so it has to write it.
    const asked = pool.request(info.filePath, 'rename_session', { title: name })
    const done = asked === null ? false : await asked.then(() => true, () => false)
    if (!done) appendFileSync(info.filePath, titleRow(info.resumeId, name), 'utf8')
    db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(name, sessionPk)
  })
  ipcMain.handle(ENGINE_IPC.forkChat, async (_e, sessionPk: number): Promise<{ ok: true; session: SessionSummary } | { ok: false; error: string }> => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) return { ok: false, error: 'That chat no longer exists.' }
    if (pool.isTurnRunning(info.filePath)) return { ok: false, error: "Wait for Claude to finish, or press Esc to stop it, then fork." }
    if (!existsSync(info.filePath)) return { ok: false, error: "This chat's transcript no longer exists, so it can't be forked." }
    const row = db.prepare('SELECT project_id AS projectId, COALESCE(custom_title, ai_title, title) AS title FROM sessions WHERE id = ?').get(sessionPk) as { projectId: number; title: string | null }
    const newId = randomUUID()
    try {
      await forkTranscript(info.filePath, info.resumeId, newId, `${(row.title ?? 'Chat').slice(0, 80)} (fork)`)
      await sweepExternalChanges(db, { skip: fp => pool.isTurnRunning(fp) })
    } catch (err) {
      return { ok: false, error: `Couldn't fork this chat: ${err instanceof Error ? err.message : String(err)}` }
    }
    const session = listSessions(db, row.projectId).find(s => s.sessionId === newId)
    return session === undefined ? { ok: false, error: "The fork was made, but it hasn't appeared yet." } : { ok: true, session }
  })
  ipcMain.handle(ENGINE_IPC.sideQuestion, async (_e, sessionPk: number, question: string): Promise<{ ok: true; answer: string } | { ok: false; error: string }> => {
    const info = getEngineSessionInfo(db, sessionPk)
    const asked = info === null ? null : pool.request(info.filePath, 'side_question', { question }, SIDE_QUESTION_MS)
    if (asked === null) return { ok: false, error: "A side question needs Claude running in this chat. Send a message first." }
    try {
      const reply = await asked as { response?: unknown } | null
      return { ok: true, answer: typeof reply?.response === 'string' ? reply.response : '' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(ENGINE_IPC.setChatMode, (_e, sessionPk: number, mode: string) => coordinator.setPermissionMode(sessionPk, mode))
  ipcMain.handle(ENGINE_IPC.stopTask, (_e, sessionPk: number, taskId: string) => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info !== null) pool.stopTask(info.filePath, taskId)
  })
  ipcMain.handle(ENGINE_IPC.withdrawQueued, (_e, sessionPk: number, uuid: string) => {
    const info = getEngineSessionInfo(db, sessionPk)
    return info === null ? true : pool.withdraw(info.filePath, uuid)
  })
  ipcMain.handle(ENGINE_IPC.rewindUnanswered, async (_e, sessionPk: number, uuid: string) => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) return false
    const rewound = await pool.rewind(info.filePath, uuid)
    // A reload from when the turn stopped may be on its way, showing the message as it
    // was. This one reads the transcript as it is now, and overtakes it.
    if (rewound && !window.isDestroyed()) window.webContents.send(ENGINE_IPC.indexed, sessionPk)
    return rewound
  })
  ipcMain.handle(ENGINE_IPC.taskOutput, (_e, sessionPk: number, taskId: string) => {
    const info = getEngineSessionInfo(db, sessionPk)
    return info === null ? null : pool.taskOutput(info.filePath, taskId)
  })
  ipcMain.handle(ENGINE_IPC.rewindPoints, (_e, sessionPk: number) => rewindPoints(db, sessionPk))
  ipcMain.handle(ENGINE_IPC.pinMessage, async (_e, sessionPk: number, uuid: string) => {
    if (pinMessage(db, sessionPk, uuid, Date.now())) return true
    // It may have only just arrived, and not reached the catalog yet.
    await syncSessionToCatalog(db, sessionPk).catch(err => console.error('Could not index before pinning', err))
    return pinMessage(db, sessionPk, uuid, Date.now())
  })
  ipcMain.handle(ENGINE_IPC.unpinMessage, (_e, sessionPk: number, uuid: string) => unpinMessage(db, sessionPk, uuid))
  ipcMain.handle(ENGINE_IPC.listPins, (_e, projectId: number) => listPins(db, projectId))
  const NO_REWIND = { canRewind: false, files: [], insertions: 0, deletions: 0 }
  ipcMain.handle(ENGINE_IPC.rewindCheck, async (_e, sessionPk: number, uuid: string) => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null || pool.isTurnRunning(info.filePath) || !coordinator.wake(sessionPk)) return { ...NO_REWIND, error: "this chat can't be reached right now" }
    return await pool.rewindFiles(info.filePath, uuid, true) ?? { ...NO_REWIND, error: "this chat can't be reached right now" }
  })
  ipcMain.handle(ENGINE_IPC.rewindTo, async (_e, sessionPk: number, uuid: string, mode: RewindMode) => {
    const info = getEngineSessionInfo(db, sessionPk)
    if (info === null) return { ok: false, error: 'That chat is no longer available.' }
    if (pool.isTurnRunning(info.filePath)) return { ok: false, error: 'Claude is still replying here. Press Esc to stop it, then try again.' }
    if (!coordinator.wake(sessionPk)) return { ok: false, error: "This chat can't be reached right now. It may be open in a terminal." }
    // Files first: if they can't go back, the conversation stays as it is too.
    if (mode !== 'conversation') {
      const files = await pool.rewindFiles(info.filePath, uuid, false)
      if (files === null || !files.canRewind) return { ok: false, error: `The files couldn't be restored${files?.error != null ? `: ${files.error.replace(/\.+$/, '')}.` : '.'}` }
    }
    let prefill: string | null = null
    if (mode !== 'code') {
      const back = await pool.rewindConversation(info.filePath, uuid)
      if (back === null) return { ok: false, error: mode === 'both' ? "The files were restored, but the conversation couldn't go back." : "The conversation couldn't go back." }
      prefill = back.prefill
      await syncSessionToCatalog(db, sessionPk).catch(err => console.error('Could not index the rewind', err))
      // The transcript says this by itself, except going back to a chat's first message.
      markRewoundFrom(db, sessionPk, uuid)
      if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.indexed, sessionPk)
    }
    return { ok: true, prefill }
  })
  ipcMain.handle(ENGINE_IPC.backgroundTasks, (_e, sessionPk: number) => {
    const info = getEngineSessionInfo(db, sessionPk)
    return info === null ? [] : pool.backgroundTasks(info.filePath)
  })
  ipcMain.handle(ENGINE_IPC.listEngines, () => pool.snapshot())
  ipcMain.handle(ENGINE_IPC.killEngine, (_e, pid: number) => pool.killByPid(pid))

  // Task 10 review Finding 1: `loadTranscript` (src/main/ipc.ts) only ever
  // reads from the catalog, and the catalog was previously only ever
  // populated by runIndex() at app mount -- a live turn's watcher tails new
  // durable rows straight to the renderer for display, but nothing re-indexed
  // the file, so reopening a session after a completed turn showed a stale
  // (pre-turn) catalog render. The debouncer below advances THIS session's
  // catalog entry via the same incremental indexFile() runIndex() uses (never
  // a second full archive walk), then tells the renderer via `engine:indexed`
  // so App.tsx can reload that one session's transcript from the now-current
  // catalog if it's the one currently open. A burst of onRows mid-stream
  // collapses to one indexFile pass; `result` runs it immediately (no reason
  // to wait out the debounce once the turn has actually settled).
  const indexDebouncer = createIndexDebouncer(
    (sessionPk) => syncSessionToCatalog(db, sessionPk),
    (sessionPk) => { if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.indexed, sessionPk) }
  )

  // External-change sweep: picks up transcripts written outside Delegatto (a
  // terminal `claude` continuing a chat, or starting a new one) every 30s and
  // whenever the window regains focus (throttled). Each changed top-level chat
  // fires the same `engine:indexed` broadcast a live turn does, so the renderer
  // re-sorts the nav, refreshes its preview, and reloads the open transcript.
  // Skips a session with a Delegatto turn mid-stream (its watcher already
  // owns that file's indexing) and waits for the startup runIndex to settle.
  const sweepOnce = async (): Promise<void> => {
    if (!isCatalogSettled()) return
    const { changedMain } = await sweepExternalChanges(db, { skip: (fp) => pool.isTurnRunning(fp) })
    if (window.isDestroyed()) return
    for (const sessionPk of changedMain) window.webContents.send(ENGINE_IPC.indexed, sessionPk)
    // Re-check locks too: catches a terminal that crashed without removing
    // its lock (no fs event), and a brand-new terminal chat the catalog only
    // just learned about in this sweep.
    lockMonitor.refresh()
  }
  // Serialised: the periodic sweep and an on-demand resync (after a Manage
  // operation) never index the same file concurrently.
  let sweepChain: Promise<void> = Promise.resolve()
  const serialSweep = (): Promise<void> => {
    const next = sweepChain.then(sweepOnce, sweepOnce)
    sweepChain = next.catch(() => {})
    return next
  }
  const externalSweep = createPeriodicSweep(serialSweep)
  const onWindowFocus = (): void => externalSweep.poke()
  window.on('focus', onWindowFocus)

  coordinator.onEvent((sessionPk, e) => {
    if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.event, sessionPk, e)
    if (e.kind === 'result') indexDebouncer.now(sessionPk)
    if (e.kind === 'rate_limit' && e.reading !== undefined) planUsage.applyReading(e.reading)
    try { hooks.onEvent?.(sessionPk, e) } catch (err) { console.error('[engine] event hook failed', err) }
  })
  coordinator.onRows((sessionPk, rows) => {
    if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.rows, sessionPk, rows)
    indexDebouncer.schedule(sessionPk)
  })
  coordinator.onPermission((sessionPk, req) => {
    if (!window.isDestroyed()) window.webContents.send(ENGINE_IPC.permission, sessionPk, req)
    try { hooks.onPermission?.(sessionPk, req) } catch (err) { console.error('[engine] permission hook failed', err) }
  })

  // Fix 3: guards dispose() so calling it more than once (main/index.ts now
  // wires it to several overlapping app-lifecycle events -- a window
  // closing, window-all-closed, before-quit, will-quit -- any of which may
  // fire for the same teardown) is a safe no-op the second time, rather than
  // double-removing listeners/double-shutting-down the pool and bridge
  // (both of those are themselves idempotent, but there is no reason to rely
  // on that here too).
  let disposed = false

  const sessionIdOf = (sessionKey: string): string => basename(sessionKey).replace(/\.jsonl$/i, '')

  return {
    resync: serialSweep,
    ownedProcesses() {
      return pool.snapshot().map(e => ({ sessionId: sessionIdOf(e.sessionKey), pid: e.pid }))
    },
    activeWork() {
      return this.busySessionIds().length
    },
    busySessionIds() {
      const turns = pool.snapshot().filter(e => e.busy || e.background > 0).map(e => sessionIdOf(e.sessionKey).toLowerCase())
      // A `!` still running is work too: quitting would stop it.
      const commands = shellRunner.runningChats().flatMap(pk => {
        const info = getEngineSessionInfo(db, pk)
        return info === null ? [] : [sessionIdOf(info.filePath).toLowerCase()]
      })
      return [...new Set([...turns, ...commands])]
    },
    stopOwned(sessionIds) {
      const want = new Set(sessionIds.map(s => s.toLowerCase()))
      let n = 0
      for (const e of pool.snapshot()) {
        if (e.pid !== null && want.has(sessionIdOf(e.sessionKey).toLowerCase()) && pool.killByPid(e.pid)) n++
      }
      return n
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      ipcMain.removeListener(ENGINE_IPC.send, onSend)
      ipcMain.removeListener(ENGINE_IPC.interrupt, onInterrupt)
      ipcMain.removeListener(ENGINE_IPC.resolvePermission, onResolvePermission)
      ipcMain.removeListener(ENGINE_IPC.setSessionOverrides, onSetSessionOverrides)
      ipcMain.removeHandler(ENGINE_IPC.newChat)
      ipcMain.removeHandler(ENGINE_IPC.githubStatus)
      ipcMain.removeHandler(ENGINE_IPC.githubRepos)
      ipcMain.removeHandler(ENGINE_IPC.githubPrepare)
      ipcMain.removeHandler(ENGINE_IPC.pickDirectory)
      ipcMain.removeHandler(ENGINE_IPC.isSessionLive)
      ipcMain.removeHandler(ENGINE_IPC.turnInfo)
      ipcMain.removeHandler(ENGINE_IPC.backgroundTasks)
      ipcMain.removeHandler(ENGINE_IPC.withdrawQueued)
      ipcMain.removeHandler(ENGINE_IPC.rewindUnanswered)
      for (const channel of [ENGINE_IPC.rewindPoints, ENGINE_IPC.rewindCheck, ENGINE_IPC.rewindTo, ENGINE_IPC.taskOutput, ENGINE_IPC.pinMessage, ENGINE_IPC.unpinMessage, ENGINE_IPC.listPins]) ipcMain.removeHandler(channel)
      ipcMain.removeHandler(ENGINE_IPC.stopTask)
      ipcMain.removeHandler(ENGINE_IPC.answerElicitation)
      ipcMain.removeHandler(ENGINE_IPC.chatMode)
      for (const channel of [ENGINE_IPC.indexNow, ENGINE_IPC.claudeFound, ENGINE_IPC.promptHistory, ENGINE_IPC.keepInHistory, ENGINE_IPC.renameChat, ENGINE_IPC.forkChat, ENGINE_IPC.sideQuestion]) ipcMain.removeHandler(channel)
      ipcMain.removeHandler(ENGINE_IPC.setChatMode)
      ipcMain.removeHandler(ENGINE_IPC.getLock)
      ipcMain.removeHandler(ENGINE_IPC.openInTerminal)
      ipcMain.removeHandler(ENGINE_IPC.listRemote)
      lockMonitor.dispose()
      ipcMain.removeHandler(ENGINE_IPC.listEngines)
      ipcMain.removeHandler(ENGINE_IPC.planUsage)
      for (const ch of [ENGINE_IPC.loginState, ENGINE_IPC.loginStart, ENGINE_IPC.loginSubmitCode, ENGINE_IPC.loginCancel]) ipcMain.removeHandler(ch)
      login.cancel()
      clearTimeout(planCheck)
      ipcMain.removeHandler(ENGINE_IPC.clearChat)
      ipcMain.removeHandler(ENGINE_IPC.claudeInfo)
      ipcMain.removeHandler(ENGINE_IPC.mcpStatus)
      ipcMain.removeHandler(ENGINE_IPC.mcpReconnect)
      ipcMain.removeHandler(ENGINE_IPC.mcpToggle)
      ipcMain.removeHandler(ENGINE_IPC.mcpCheck)
      ipcMain.removeHandler(ENGINE_IPC.mcpLogin)
      ipcMain.removeHandler(ENGINE_IPC.hijackChat)
      for (const channel of [ENGINE_IPC.showProjectFolder, ENGINE_IPC.memoryList, ENGINE_IPC.memoryRead, ENGINE_IPC.memorySave]) ipcMain.removeHandler(channel)
      for (const channel of [ENGINE_IPC.folderSettings, ENGINE_IPC.contextUsage, ENGINE_IPC.getProjectSettings, ENGINE_IPC.setProjectSettings, ENGINE_IPC.addProjectDir]) ipcMain.removeHandler(channel)
      for (const channel of [ENGINE_IPC.shellRun, ENGINE_IPC.shellStop, ENGINE_IPC.shellDismiss, ENGINE_IPC.shellList, ENGINE_IPC.folderTrust, ENGINE_IPC.trustFolder]) ipcMain.removeHandler(channel)
      shellRunner.dispose()
      ipcMain.removeHandler(ENGINE_IPC.killEngine)
      clearInterval(reapInterval)
      indexDebouncer.dispose()
      externalSweep.dispose()
      if (!window.isDestroyed()) window.removeListener('focus', onWindowFocus)
      // Fix 3: tears down every SessionWatcher this coordinator ever
      // started -- previously nothing called disposeSession/disposeAll, so
      // every watcher leaked for the app's full life.
      coordinator.disposeAll()
      pool.shutdown()
      bridge.shutdown()
    }
  }
}
