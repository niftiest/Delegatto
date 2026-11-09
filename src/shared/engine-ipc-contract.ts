import type { PlanUsage } from './plan-usage'
import type { GithubRepoList, GithubStatus, PrepareRepoOutcome } from './github-types'
import type { FolderTrust, ShellRun } from './shell-run-types'
import type { MemoryFile, MemoryFileContent, MemorySaveResult } from './project-memory-types'
import type { ProjectSettings, ContextUsage } from './project-options'
import type { ClaudeInfoResult, McpCheckResult, McpServerStatus } from './claude-info-types'
import type { SessionSummary } from './types'
import type { ExportChatResult, HookEntry, HookScope, HooksListing, PanelResult, PluginActionResult, PluginsState, WorkspaceDiff } from './command-panels-types'
import type { Elicitation, ElicitationAnswer, LiveEvent, PermissionRequest, PermissionDecision, EngineSnapshot, ExternalLock, RemoteSession, TurnInfo, BackgroundTask } from './engine-types'
export type { EngineSnapshot, ExternalLock, RemoteSession } from './engine-types'
// Type-only import: StreamedRow's home module reads real files (node:fs), but
// importing just its *type* here is erased at compile time -- the same
// pattern shared/types.ts already uses for ContentBlock/Usage from
// ../main/jsonl/rows. No runtime code (and no electron) crosses into this
// module, which the renderer also imports.
import type { StreamedRow } from '../main/jsonl/stream'
import type { LoginState } from './login-types'

/** Channel names for the write-path engine IPC surface (Plan 2 Task 6).
 *  `send`/`interrupt`/`resolvePermission` are fire-and-forget commands
 *  (renderer -> main, no reply expected -- `ipcRenderer.send` /
 *  `ipcMain.on`); `event`/`rows`/`permission` are broadcasts the main process
 *  pushes to the renderer (`webContents.send` / `ipcRenderer.on`), same shape
 *  as Plan 1's `indexProgress` channel. */
export type PinnedMessage = { sessionPk: number; uuid: string; seq: number; role: string; ts: string | null; text: string | null; chatTitle: string | null; pinnedAt: number }
export type RewindMode = 'both' | 'conversation' | 'code'
export type RewindPoint = { uuid: string; text: string; ts: string | null }
export type RewindCheck = { canRewind: boolean; error: string | null; files: string[]; insertions: number; deletions: number }

export const ENGINE_IPC = {
  send: 'engine:send',
  interrupt: 'engine:interrupt',
  resolvePermission: 'engine:resolvePermission',
  setSessionOverrides: 'engine:setSessionOverrides',
  newChat: 'engine:newChat',
  listEngines: 'engine:list',
  /** invoke: what's known of the account's plan and how much of it is used. */
  planUsage: 'engine:planUsage',
  /** push: the same, when it changes. */
  planUsageChanged: 'engine:planUsageChanged',
  killEngine: 'engine:kill',
  pickDirectory: 'dialog:pickDirectory',
  event: 'engine:event',
  rows: 'engine:rows',
  permission: 'engine:permission',
  indexed: 'engine:indexed',
  isSessionLive: 'engine:isSessionLive',
  turnInfo: 'engine:turnInfo',
  backgroundTasks: 'engine:backgroundTasks',
  withdrawQueued: 'engine:withdrawQueued',
  rewindUnanswered: 'engine:rewindUnanswered',
  rewindPoints: 'engine:rewindPoints',
  rewindCheck: 'engine:rewindCheck',
  rewindTo: 'engine:rewindTo',
  taskOutput: 'engine:taskOutput',
  pinMessage: 'engine:pinMessage',
  unpinMessage: 'engine:unpinMessage',
  listPins: 'engine:listPins',
  stopTask: 'engine:stopTask',
  answerElicitation: 'engine:answerElicitation',
  // What's still waiting on an answer, for a window opened after it was asked.
  pendingPermissions: 'engine:pendingPermissions',
  pendingQuestions: 'engine:pendingQuestions',
  chatMode: 'engine:chatMode',
  promptHistory: 'engine:promptHistory',
  claudeFound: 'engine:claudeFound',
  keepInHistory: 'engine:keepInHistory',
  indexNow: 'engine:indexNow',
  renameChat: 'engine:renameChat',
  forkChat: 'engine:forkChat',
  sideQuestion: 'engine:sideQuestion',
  setChatMode: 'engine:setChatMode',
  /** invoke: the chat's current external lock (a terminal holding it), or null. */
  getLock: 'engine:getLock',
  /** invoke: open the chat in a real Claude Code terminal (claude --resume). */
  openInTerminal: 'engine:openInTerminal',
  /** invoke: /clear -- open a new chat in the same folder with the same settings. */
  clearChat: 'engine:clearChat',
  /** invoke: what Claude Code has available for a folder (commands, skills). */
  claudeInfo: 'engine:claudeInfo',
  /** invoke: how this chat's running process sees its MCP servers, or null. */
  mcpStatus: 'engine:mcpStatus',
  /** invoke: reconnect one MCP server in this chat's running process. */
  mcpReconnect: 'engine:mcpReconnect',
  mcpToggle: 'engine:mcpToggle',
  /** invoke: /hooks -- the hooks Claude Code has for this chat, and adding or removing one. */
  hooksListing: 'engine:hooksListing',
  addHook: 'engine:addHook',
  removeHook: 'engine:removeHook',
  /** invoke: /diff -- what has changed in the chat's folder. */
  workspaceDiff: 'engine:workspaceDiff',
  /** invoke: /export -- the chat as text, saved to a file or handed back. */
  exportChat: 'engine:exportChat',
  /** invoke: /plugin -- installed and available plugins, and running `claude plugin ...`. */
  pluginsList: 'engine:pluginsList',
  pluginAction: 'engine:pluginAction',
  /** invoke: start a folder's MCP servers in a brief process and report on them. */
  mcpCheck: 'engine:mcpCheck',
  /** invoke: open `claude mcp login` in a terminal. */
  mcpLogin: 'engine:mcpLogin',
  /** invoke: end the idle terminal holding a chat, so Delegatto can use it. */
  hijackChat: 'engine:hijackChat',
  showProjectFolder: 'engine:showProjectFolder',
  memoryList: 'engine:memoryList',
  memoryRead: 'engine:memoryRead',
  memorySave: 'engine:memorySave',
  /** invoke: how full this chat's context is, from its running process. */
  contextUsage: 'engine:contextUsage',
  /** Signing in to Claude Code from the app: state, start, a pasted code, cancel; and its changes. */
  loginState: 'engine:loginState',
  loginStart: 'engine:loginStart',
  loginSubmitCode: 'engine:loginSubmitCode',
  loginCancel: 'engine:loginCancel',
  loginChanged: 'engine:loginChanged',
  getProjectSettings: 'engine:getProjectSettings',
  /** invoke: the settings saved for a folder, for the New Chat dialog. */
  folderSettings: 'engine:folderSettings',
  setProjectSettings: 'engine:setProjectSettings',
  addProjectDir: 'engine:addProjectDir',
  /** invoke: run a `!` command in the chat's folder. */
  shellRun: 'engine:shellRun',
  shellStop: 'engine:shellStop',
  shellDismiss: 'engine:shellDismiss',
  shellList: 'engine:shellList',
  /** broadcast: (sessionPk, ShellRun[]) whenever a chat's `!` commands change. */
  shellChanged: 'engine:shellChanged',
  /** invoke: whether a new chat may start in a folder without asking. */
  folderTrust: 'engine:folderTrust',
  trustFolder: 'engine:trustFolder',
  /** invoke: is the GitHub CLI installed and signed in. */
  githubStatus: 'engine:githubStatus',
  /** invoke: the user's repos that have no project yet. */
  githubRepos: 'engine:githubRepos',
  /** invoke: clone or pull a repo, ready for a new chat there. */
  githubPrepare: 'engine:githubPrepare',
  /** broadcast: (sessionPk, ExternalLock | null) whenever a chat's lock changes. */
  lockChanged: 'engine:lockChanged',
  /** invoke: every chat currently under Remote Control. */
  listRemote: 'engine:listRemote',
  /** broadcast: (RemoteSession[]) whenever that set changes. */
  remoteChanged: 'engine:remoteChanged'
} as const

export type EngineImageInput = { mediaType: string; dataBase64: string }

/** Everything a New-Chat dialog (Plan 2 Task 8) submits to create a fresh
 *  chat: a working directory (required), whether to run with
 *  `--dangerously-skip-permissions`, and optional model/effort/name. The
 *  canonical definition lives here (the IPC boundary both the renderer's
 *  dialog and the main process's `startNewChat` cross) -- `src/renderer/
 *  lib.ts` re-exports it via a type-only import so `resolveNewProjectOptions`
 *  never has to duplicate the shape. */
export type NewProjectOptions = {
  cwd: string
  skipPermissions: boolean
  model?: string
  effort?: string
  name?: string
}

/** Result of `engine:newChat`: either the new session's catalog identity
 *  (sessionPk to address it by, plus its durable session_id/uuid), or a
 *  reason it couldn't be created -- e.g. the chosen cwd doesn't exist on
 *  disk. Never throws across the IPC boundary; the dialog surfaces `error`
 *  to the user instead. */
export type NewChatOutcome =
  | { ok: true; sessionPk: number; sessionId: string }
  | { ok: false; error: string }

export type ClearChatOutcome =
  | { ok: true; cwd: string; sessionId: string; unchanged: boolean }
  | { ok: false; error: string }

export type EngineApi = {
  /** /clear: leaves this chat in the history and opens a new one in its folder
   *  with the same settings. `unchanged` when this chat has no messages yet. */
  clearChat(sessionPk: number): Promise<ClearChatOutcome>
  /** What Claude Code offers for a folder (null: the home folder). Starts a brief
   *  process the first time, then caches; uses no tokens. */
  claudeInfo(cwd: string | null, refresh?: boolean): Promise<ClaudeInfoResult>
  /** Null when the chat has no process running. */
  mcpStatus(sessionPk: number): Promise<McpServerStatus[] | null>
  mcpReconnect(sessionPk: number, name: string): Promise<McpCheckResult>
  /** Turns a server off or on in this chat. Claude Code remembers it, as `/mcp disable` does. */
  mcpToggle(sessionPk: number, name: string, enabled: boolean): Promise<McpCheckResult>
  /** The chat's own process answers if it has one, otherwise a brief one in its folder. */
  hooksListing(sessionPk: number): Promise<PanelResult<HooksListing>>
  addHook(sessionPk: number, scope: HookScope, hook: { event: string; matcher: string | null; command: string; timeout?: number }): Promise<PanelResult<HooksListing>>
  /** Asks first, in the app's own dialog. */
  removeHook(sessionPk: number, hook: HookEntry): Promise<PanelResult<HooksListing> | { ok: false; cancelled: true }>
  workspaceDiff(sessionPk: number): Promise<PanelResult<WorkspaceDiff>>
  /** 'file' asks where to save (or uses `fileName` in the chat's folder, as `/export name` does);
   *  'text' just returns it, for the clipboard. */
  exportChat(sessionPk: number, mode: 'file' | 'text', fileName?: string): Promise<ExportChatResult>
  pluginsList(cwd: string | null): Promise<PanelResult<PluginsState>>
  /** Runs `claude plugin <args>` in the folder, then has running chats reload their plugins. */
  pluginAction(cwd: string | null, args: string[]): Promise<PluginActionResult>
  /** Starts the folder's MCP servers briefly, as a chat would. Uses no tokens. */
  mcpCheck(cwd: string | null): Promise<McpCheckResult>
  mcpLogin(cwd: string | null, name: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Ends the terminal holding this chat. Refused unless it's idle, waiting at its prompt. */
  hijackChat(sessionPk: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** Opens the project's folder in File Explorer. */
  showProjectFolder(projectId: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** The files that shape what Claude remembers for a project. */
  memoryList(projectId: number): Promise<MemoryFile[]>
  memoryRead(projectId: number, fileId: string): Promise<MemoryFileContent>
  /** `expectedMtimeMs` is from the read: saving refuses if the file has changed since. */
  memorySave(projectId: number, fileId: string, text: string, expectedMtimeMs: number | null): Promise<MemorySaveResult>
  /** Null when the chat has no process running. */
  contextUsage(sessionPk: number): Promise<ContextUsage | null>
  /** Signing in to Claude Code: where it's got to. */
  loginState(): Promise<LoginState>
  /** Starts signing in and opens the browser. */
  loginStart(): Promise<LoginState>
  /** A code pasted from the sign-in page, for signing in from another device. */
  loginSubmitCode(code: string): Promise<LoginState>
  loginCancel(): Promise<void>
  onLoginChanged(cb: (state: LoginState) => void): () => void
  /** The settings of the project this chat belongs to. */
  getProjectSettings(sessionPk: number): Promise<ProjectSettings>
  folderSettings(cwd: string): Promise<ProjectSettings>
  setProjectSettings(sessionPk: number, patch: Partial<ProjectSettings>): Promise<ProjectSettings>
  /** Lets Claude use a folder outside the project. With no path, asks the user to pick one. */
  addProjectDir(sessionPk: number, path: string | null): Promise<{ ok: true; added: string | null; settings: ProjectSettings } | { ok: false; error: string }>
  /** Runs a command in the chat's folder, without Claude. */
  shellRun(sessionPk: number, command: string): Promise<void>
  shellStop(id: string): Promise<void>
  /** Stops it if running, and keeps it from going to Claude. */
  shellDismiss(id: string): Promise<void>
  shellList(sessionPk: number): Promise<ShellRun[]>
  onShellChanged(cb: (sessionPk: number, runs: ShellRun[]) => void): () => void
  folderTrust(cwd: string): Promise<FolderTrust>
  trustFolder(cwd: string): Promise<void>
  githubStatus(): Promise<GithubStatus>
  githubRepos(): Promise<GithubRepoList>
  githubPrepare(options: { repo: string; cwd: string }): Promise<PrepareRepoOutcome>
  send(sessionPk: number, text: string, images?: EngineImageInput[], uuid?: string): void
  /** Takes back a queued message. False if Claude already has it. */
  withdrawQueued(sessionPk: number, uuid: string): Promise<boolean>
  /** Makes Claude forget a message stopped before any reply. False if it couldn't. */
  rewindUnanswered(sessionPk: number, uuid: string): Promise<boolean>
  /** The messages this chat can go back to, newest first. */
  rewindPoints(sessionPk: number): Promise<RewindPoint[]>
  /** What restoring files to before a message would change. Changes nothing. */
  rewindCheck(sessionPk: number, uuid: string): Promise<RewindCheck>
  /** Goes back to before a message. `prefill` is its text, when the conversation went back. */
  rewindTo(sessionPk: number, uuid: string, mode: RewindMode): Promise<{ ok: true; prefill: string | null } | { ok: false; error: string }>
  /** Pins a message of a chat. False if it couldn't be found. */
  pinMessage(sessionPk: number, uuid: string): Promise<boolean>
  unpinMessage(sessionPk: number, uuid: string): Promise<void>
  /** A project's pinned messages, newest pin first. */
  listPins(projectId: number): Promise<PinnedMessage[]>
  /** The end of a background command's output, or null if it can't be read. */
  taskOutput(sessionPk: number, taskId: string): Promise<{ output: string; truncated: boolean } | null>
  interrupt(sessionPk: number): void
  resolvePermission(
    id: string,
    decision: 'allow' | 'allow_always' | 'allow_folder' | 'deny',
    editedInput?: unknown,
    denyMessage?: string
  ): void
  /** Live per-chat model/effort override, applied on the NEXT turn (a spawned
   *  transport can't change model mid-flight). Fire-and-forget; omit a field
   *  to leave it at the coordinator's default. Wired to the chat header's
   *  model/effort selectors. */
  setSessionOverrides(sessionPk: number, overrides: { model?: string; effort?: string }): void
  /** Registers a brand-new chat (Task 8) and returns its catalog identity.
   *  Does not spawn anything -- the pool spawns lazily on the first
   *  Composer send, same as any other session. */
  newChat(options: NewProjectOptions): Promise<NewChatOutcome>
  /** Snapshot of every live engine process for the pool HUD. */
  listEngines(): Promise<EngineSnapshot[]>
  planUsage(): Promise<PlanUsage>
  onPlanUsageChanged(cb: (usage: PlanUsage) => void): () => void
  /** Gracefully stop the engine with this pid; resolves true if one was found. */
  killEngine(pid: number): Promise<boolean>
  /** Opens a native "choose a folder" dialog for the New-Chat working
   *  directory field. Resolves to the chosen absolute path, or null if the
   *  user cancelled. */
  pickDirectory(): Promise<string | null>
  /** Whether the pool currently owns a live transport for this session, so
   *  App can re-derive `running` when switching back to a streaming chat
   *  (Plan 2 review Finding #6 / Plan 3 Task 8). */
  isSessionLive(sessionPk: number): Promise<boolean>
  /** The open chat's running turn, or null when none is running. */
  turnInfo(sessionPk: number): Promise<TurnInfo | null>
  backgroundTasks(sessionPk: number): Promise<BackgroundTask[]>
  stopTask(sessionPk: number, taskId: string): Promise<void>
  answerElicitation(sessionPk: number, requestId: string, answer: ElicitationAnswer): Promise<void>
  /** Permission requests still waiting on an answer, in every chat. */
  pendingPermissions(): Promise<Array<{ sessionPk: number; req: PermissionRequest }>>
  /** Questions MCP servers are still waiting on, in every chat. */
  pendingQuestions(): Promise<Array<{ sessionPk: number; request: Elicitation }>>
  chatMode(sessionPk: number): Promise<string>
  /** Picks up what changed on disk without waiting for the next sweep. */
  indexNow(): Promise<void>
  /** What was typed in this chat's project, newest first. */
  promptHistory(sessionPk: number): Promise<string[]>
  /** Whether Claude Code can be found on this PC. */
  claudeFound(): Promise<boolean>
  /** Keeps text in Claude Code's history file, for Up here and in the terminal. */
  keepInHistory(sessionPk: number, text: string): Promise<void>
  renameChat(sessionPk: number, title: string): Promise<void>
  forkChat(sessionPk: number): Promise<{ ok: true; session: SessionSummary } | { ok: false; error: string }>
  sideQuestion(sessionPk: number, question: string): Promise<{ ok: true; answer: string } | { ok: false; error: string }>
  setChatMode(sessionPk: number, mode: string): Promise<void>
  /** Returns an unsubscribe function, matching Plan 1's onIndexProgress. */
  onEvent(cb: (sessionPk: number, e: LiveEvent) => void): () => void
  onRows(cb: (sessionPk: number, rows: StreamedRow[]) => void): () => void
  onPermission(cb: (sessionPk: number, req: PermissionRequest) => void): () => void
  /** Broadcasts once a live turn's durable rows have been synced into the
   *  catalog (Task 10 review Finding 1's fix -- see engine-ipc.ts's
   *  indexDebouncer): the catalog is now current for `sessionPk`, so a
   *  renderer with that session open should reload its transcript via
   *  `loadTranscript` to replace the live-appended render with the
   *  authoritative, freshly-indexed one. */
  onIndexed(cb: (sessionPk: number) => void): () => void
  /** The process outside Delegatto (a terminal) holding this chat, or null.
   *  While non-null the chat must be read-only. */
  getLock(sessionPk: number): Promise<ExternalLock | null>
  /** Fires when a chat is taken over by / released from an outside process. */
  onLockChanged(cb: (sessionPk: number, lock: ExternalLock | null) => void): () => void
  /** Opens the chat in an interactive Claude Code terminal (for /mcp, /login…). */
  /** cancelled: the user said no to Claude Code's bypass-mode question, so nothing opened. */
  openInTerminal(sessionPk: number): Promise<{ ok: true } | { ok: false; error: string; cancelled?: true }>
  /** Chats currently under Remote Control (/rc). */
  listRemote(): Promise<RemoteSession[]>
  onRemoteChanged(cb: (remote: RemoteSession[]) => void): () => void
}

export type { PermissionDecision }
