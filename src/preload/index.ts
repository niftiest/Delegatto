import type { TextMenuRequest } from '../shared/text-menu'
import type { PlanUsage } from '../shared/plan-usage'
import type { AppDialogRequest } from '../shared/app-dialog'
import type { ShellRun } from '../shared/shell-run-types'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type DelegattoApi, type IndexProgress, type MainAction, type VisibleChats } from '../shared/ipc'
import type { SplitState } from '../shared/split-view'
import { ENGINE_IPC, type EngineApi, type NewProjectOptions, type NewChatOutcome } from '../shared/engine-ipc-contract'
import type { LiveEvent, PermissionRequest, ExternalLock, RemoteSession } from '../shared/engine-types'
import type { StreamedRow } from '../main/jsonl/stream'
import { MANAGE_IPC, type ContentSearchEvent, type ManageApi } from '../shared/manage-types'
import { UPDATE_IPC, type UpdateApi, type UpdateStatus } from '../shared/update-types'
import { CLAUDE_SETTINGS_IPC, type AutoCleanResult, type ClaudeSettingsApi } from '../shared/claude-settings-types'
import { SYNC_IPC, type EnableProgress, type SyncIncoming, type ScanProgress, type SyncApi, type SyncStatus } from '../shared/sync-types'
import type { LoginState } from '../shared/login-types'
import type { AppSettings } from '../shared/shell-types'

const api: DelegattoApi & EngineApi = {
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  listSessions: projectId => ipcRenderer.invoke(IPC.listSessions, projectId),
  loadTranscript: (sessionPk, opts) => ipcRenderer.invoke(IPC.loadTranscript, sessionPk, opts),
  syncSessionIfStale: sessionPk => ipcRenderer.invoke(IPC.syncSessionIfStale, sessionPk),
  listSubagents: toolUseId => ipcRenderer.invoke(IPC.listSubagents, toolUseId),
  search: query => ipcRenderer.invoke(IPC.search, query),
  searchProject: (projectId, query) => ipcRenderer.invoke(IPC.searchProject, projectId, query),
  runIndex: () => ipcRenderer.invoke(IPC.indexRun),
  appReady: () => ipcRenderer.send(IPC.appReady),
  appLog: (text: string) => ipcRenderer.send(IPC.appLog, String(text).slice(0, 2000)),
  setVisibleChats: (pks: number[]) => ipcRenderer.send(IPC.visibleChats, pks),
  onVisibleChatsChanged: cb => {
    const listener = (_e: IpcRendererEvent, shown: VisibleChats) => cb(shown)
    ipcRenderer.on(IPC.visibleChatsChanged, listener)
    return () => { ipcRenderer.off(IPC.visibleChatsChanged, listener) }
  },
  onAppDialog: cb => {
    const listener = (_e: IpcRendererEvent, request: AppDialogRequest) => cb(request)
    ipcRenderer.on(IPC.appDialogAsk, listener)
    return () => { ipcRenderer.off(IPC.appDialogAsk, listener) }
  },
  appDialogShown: id => ipcRenderer.send(IPC.appDialogShown, id),
  appDialogAnswer: (id, index) => ipcRenderer.send(IPC.appDialogAnswer, id, index),
  onTextMenu: cb => {
    const listener = (_e: IpcRendererEvent, menu: TextMenuRequest) => cb(menu)
    ipcRenderer.on(IPC.textMenuOpen, listener)
    return () => { ipcRenderer.off(IPC.textMenuOpen, listener) }
  },
  textMenuAction: action => ipcRenderer.send(IPC.textMenuAction, action),
  onIndexProgress: cb => {
    const listener = (_e: IpcRendererEvent, p: IndexProgress) => cb(p)
    ipcRenderer.on(IPC.indexProgress, listener)
    return () => { ipcRenderer.off(IPC.indexProgress, listener) }
  },
  splitViewOpen: (layout, panes) => ipcRenderer.invoke(IPC.splitViewOpen, layout, panes),
  splitViewGet: () => ipcRenderer.invoke(IPC.splitViewGet),
  splitViewSetLayout: (layout, panes) => ipcRenderer.invoke(IPC.splitViewSetLayout, layout, panes),
  splitViewSetPane: (index, pane) => ipcRenderer.invoke(IPC.splitViewSetPane, index, pane),
  splitViewSetRatios: (layout, ratios) => ipcRenderer.invoke(IPC.splitViewSetRatios, layout, ratios),
  splitViewSwap: (a, b) => ipcRenderer.invoke(IPC.splitViewSwap, a, b),
  onSplitViewChanged: cb => {
    const listener = (_e: IpcRendererEvent, state: SplitState | null) => cb(state)
    ipcRenderer.on(IPC.splitViewChanged, listener)
    return () => { ipcRenderer.off(IPC.splitViewChanged, listener) }
  },
  focusMain: action => ipcRenderer.send(IPC.focusMain, action),
  onMainAction: cb => {
    const listener = (_e: IpcRendererEvent, action: MainAction) => cb(action)
    ipcRenderer.on(IPC.mainAction, listener)
    return () => { ipcRenderer.off(IPC.mainAction, listener) }
  },

  listChannels: () => ipcRenderer.invoke(IPC.listChannels),
  totalCost: () => ipcRenderer.invoke(IPC.totalCost),
  modelPrices: () => ipcRenderer.invoke(IPC.modelPrices),
  listGroups: () => ipcRenderer.invoke(IPC.listGroups),
  setFriendlyName: (dirName, name) => ipcRenderer.invoke(IPC.setFriendlyName, dirName, name),
  setStarred: (dirName, starred) => ipcRenderer.invoke(IPC.setStarred, dirName, starred),
  setChannelIcon: (dirName, icon) => ipcRenderer.invoke(IPC.setChannelIcon, dirName, icon),
  setChannelGroup: (dirName, groupId) => ipcRenderer.invoke(IPC.setChannelGroup, dirName, groupId),
  createGroup: name => ipcRenderer.invoke(IPC.createGroup, name),
  renameGroup: (id, name) => ipcRenderer.invoke(IPC.renameGroup, id, name),
  setGroupIcon: (id, icon) => ipcRenderer.invoke(IPC.setGroupIcon, id, icon),
  deleteGroup: id => ipcRenderer.invoke(IPC.deleteGroup, id),
  setChannelHidden: (dirName, hidden) => ipcRenderer.invoke(IPC.setChannelHidden, dirName, hidden),
  deleteChannel: dirName => ipcRenderer.invoke(IPC.deleteChannel, dirName),
  listMcpServers: (projectCwd) => ipcRenderer.invoke(IPC.listMcpServers, projectCwd),
  listSkills: (projectCwd) => ipcRenderer.invoke(IPC.listSkills, projectCwd),
  fsTree: (cwd) => ipcRenderer.invoke(IPC.fsTree, cwd),
  openLink: (url) => ipcRenderer.invoke(IPC.openLink, url),
  listProjectFiles: (cwd) => ipcRenderer.invoke(IPC.listProjectFiles, cwd),
  generateAvatar: (prompt, size, model) => ipcRenderer.invoke(IPC.generateAvatar, prompt, size, model),
  listImageModels: () => ipcRenderer.invoke(IPC.listImageModels),
  openRouterUsage: () => ipcRenderer.invoke(IPC.openRouterUsage),
  saveImage: (cwd, relPath, dataUrl) => ipcRenderer.invoke(IPC.saveImage, cwd, relPath, dataUrl),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: patch => ipcRenderer.invoke(IPC.updateSettings, patch),
  onAppSettingsChanged: cb => {
    const listener = (_e: IpcRendererEvent, settings: AppSettings) => cb(settings)
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => { ipcRenderer.off(IPC.settingsChanged, listener) }
  },
  listThemes: () => ipcRenderer.invoke(IPC.listThemes),
  listLocalThemes: () => ipcRenderer.invoke(IPC.listLocalThemes),
  openLocalThemes: () => ipcRenderer.invoke(IPC.openLocalThemes),
  saveTheme: (name, values) => ipcRenderer.invoke(IPC.saveTheme, name, values),
  applyTheme: name => ipcRenderer.invoke(IPC.applyTheme, name),
  deleteTheme: name => ipcRenderer.invoke(IPC.deleteTheme, name),
  exportTheme: suggestedName => ipcRenderer.invoke(IPC.exportTheme, suggestedName),
  importTheme: () => ipcRenderer.invoke(IPC.importTheme),
  isElevated: () => ipcRenderer.invoke(IPC.isElevated),

  send: (sessionPk, text, images, uuid) => { ipcRenderer.send(ENGINE_IPC.send, sessionPk, text, images, uuid) },
  withdrawQueued: (sessionPk, uuid) => ipcRenderer.invoke(ENGINE_IPC.withdrawQueued, sessionPk, uuid),
  rewindUnanswered: (sessionPk, uuid) => ipcRenderer.invoke(ENGINE_IPC.rewindUnanswered, sessionPk, uuid),
  rewindPoints: sessionPk => ipcRenderer.invoke(ENGINE_IPC.rewindPoints, sessionPk),
  rewindCheck: (sessionPk, uuid) => ipcRenderer.invoke(ENGINE_IPC.rewindCheck, sessionPk, uuid),
  rewindTo: (sessionPk, uuid, mode) => ipcRenderer.invoke(ENGINE_IPC.rewindTo, sessionPk, uuid, mode),
  taskOutput: (sessionPk, taskId) => ipcRenderer.invoke(ENGINE_IPC.taskOutput, sessionPk, taskId),
  pinMessage: (sessionPk, uuid) => ipcRenderer.invoke(ENGINE_IPC.pinMessage, sessionPk, uuid),
  unpinMessage: (sessionPk, uuid) => ipcRenderer.invoke(ENGINE_IPC.unpinMessage, sessionPk, uuid),
  listPins: projectId => ipcRenderer.invoke(ENGINE_IPC.listPins, projectId),
  interrupt: sessionPk => { ipcRenderer.send(ENGINE_IPC.interrupt, sessionPk) },
  resolvePermission: (id, decision, editedInput, denyMessage) => {
    ipcRenderer.send(ENGINE_IPC.resolvePermission, id, decision, editedInput, denyMessage)
  },
  setSessionOverrides: (sessionPk, overrides) => {
    ipcRenderer.send(ENGINE_IPC.setSessionOverrides, sessionPk, overrides)
  },
  newChat: (options: NewProjectOptions): Promise<NewChatOutcome> => ipcRenderer.invoke(ENGINE_IPC.newChat, options),
  listEngines: () => ipcRenderer.invoke(ENGINE_IPC.listEngines),
  planUsage: () => ipcRenderer.invoke(ENGINE_IPC.planUsage),
  onPlanUsageChanged: cb => {
    const listener = (_e: unknown, usage: PlanUsage): void => cb(usage)
    ipcRenderer.on(ENGINE_IPC.planUsageChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.planUsageChanged, listener) }
  },
  loginState: () => ipcRenderer.invoke(ENGINE_IPC.loginState),
  loginStart: () => ipcRenderer.invoke(ENGINE_IPC.loginStart),
  loginSubmitCode: (code: string) => ipcRenderer.invoke(ENGINE_IPC.loginSubmitCode, code),
  loginCancel: () => ipcRenderer.invoke(ENGINE_IPC.loginCancel),
  onLoginChanged: cb => {
    const listener = (_e: unknown, state: LoginState): void => cb(state)
    ipcRenderer.on(ENGINE_IPC.loginChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.loginChanged, listener) }
  },
  killEngine: (pid: number) => ipcRenderer.invoke(ENGINE_IPC.killEngine, pid),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(ENGINE_IPC.pickDirectory),
  isSessionLive: (sessionPk: number): Promise<boolean> => ipcRenderer.invoke(ENGINE_IPC.isSessionLive, sessionPk),
  turnInfo: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.turnInfo, sessionPk),
  backgroundTasks: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.backgroundTasks, sessionPk),
  stopTask: (sessionPk, taskId) => ipcRenderer.invoke(ENGINE_IPC.stopTask, sessionPk, taskId),
  chatMode: sessionPk => ipcRenderer.invoke(ENGINE_IPC.chatMode, sessionPk),
  promptHistory: sessionPk => ipcRenderer.invoke(ENGINE_IPC.promptHistory, sessionPk),
  claudeFound: () => ipcRenderer.invoke(ENGINE_IPC.claudeFound),
  keepInHistory: (sessionPk, text) => ipcRenderer.invoke(ENGINE_IPC.keepInHistory, sessionPk, text),
  indexNow: () => ipcRenderer.invoke(ENGINE_IPC.indexNow),
  renameChat: (sessionPk, title) => ipcRenderer.invoke(ENGINE_IPC.renameChat, sessionPk, title),
  forkChat: sessionPk => ipcRenderer.invoke(ENGINE_IPC.forkChat, sessionPk),
  sideQuestion: (sessionPk, question) => ipcRenderer.invoke(ENGINE_IPC.sideQuestion, sessionPk, question),
  setChatMode: (sessionPk, mode) => ipcRenderer.invoke(ENGINE_IPC.setChatMode, sessionPk, mode),
  answerElicitation: (sessionPk, requestId, answer) => ipcRenderer.invoke(ENGINE_IPC.answerElicitation, sessionPk, requestId, answer),
  pendingPermissions: () => ipcRenderer.invoke(ENGINE_IPC.pendingPermissions),
  pendingQuestions: () => ipcRenderer.invoke(ENGINE_IPC.pendingQuestions),
  onEvent: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, ev: LiveEvent) => cb(sessionPk, ev)
    ipcRenderer.on(ENGINE_IPC.event, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.event, listener) }
  },
  onRows: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, rows: StreamedRow[]) => cb(sessionPk, rows)
    ipcRenderer.on(ENGINE_IPC.rows, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.rows, listener) }
  },
  onPermission: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, req: PermissionRequest) => cb(sessionPk, req)
    ipcRenderer.on(ENGINE_IPC.permission, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.permission, listener) }
  },
  onIndexed: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number) => cb(sessionPk)
    ipcRenderer.on(ENGINE_IPC.indexed, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.indexed, listener) }
  },
  getLock: (sessionPk: number): Promise<ExternalLock | null> => ipcRenderer.invoke(ENGINE_IPC.getLock, sessionPk),
  openInTerminal: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.openInTerminal, sessionPk),
  clearChat: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.clearChat, sessionPk),
  claudeInfo: (cwd: string | null, refresh?: boolean) => ipcRenderer.invoke(ENGINE_IPC.claudeInfo, cwd, refresh),
  mcpStatus: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.mcpStatus, sessionPk),
  mcpReconnect: (sessionPk: number, name: string) => ipcRenderer.invoke(ENGINE_IPC.mcpReconnect, sessionPk, name),
  mcpToggle: (sessionPk: number, name: string, enabled: boolean) => ipcRenderer.invoke(ENGINE_IPC.mcpToggle, sessionPk, name, enabled),
  hooksListing: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.hooksListing, sessionPk),
  addHook: (sessionPk: number, scope: string, hook: object) => ipcRenderer.invoke(ENGINE_IPC.addHook, sessionPk, scope, hook),
  removeHook: (sessionPk: number, hook: object) => ipcRenderer.invoke(ENGINE_IPC.removeHook, sessionPk, hook),
  workspaceDiff: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.workspaceDiff, sessionPk),
  exportChat: (sessionPk: number, mode: string, fileName?: string) => ipcRenderer.invoke(ENGINE_IPC.exportChat, sessionPk, mode, fileName),
  pluginsList: (cwd: string | null) => ipcRenderer.invoke(ENGINE_IPC.pluginsList, cwd),
  pluginAction: (cwd: string | null, args: string[]) => ipcRenderer.invoke(ENGINE_IPC.pluginAction, cwd, args),
  mcpCheck: (cwd: string | null) => ipcRenderer.invoke(ENGINE_IPC.mcpCheck, cwd),
  mcpLogin: (cwd: string | null, name: string) => ipcRenderer.invoke(ENGINE_IPC.mcpLogin, cwd, name),
  hijackChat: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.hijackChat, sessionPk),
  showProjectFolder: (projectId: number) => ipcRenderer.invoke(ENGINE_IPC.showProjectFolder, projectId),
  memoryList: (projectId: number) => ipcRenderer.invoke(ENGINE_IPC.memoryList, projectId),
  memoryRead: (projectId: number, fileId: string) => ipcRenderer.invoke(ENGINE_IPC.memoryRead, projectId, fileId),
  memorySave: (projectId: number, fileId: string, text: string, expectedMtimeMs: number | null) => ipcRenderer.invoke(ENGINE_IPC.memorySave, projectId, fileId, text, expectedMtimeMs),
  contextUsage: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.contextUsage, sessionPk),
  getProjectSettings: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.getProjectSettings, sessionPk),
  folderSettings: (cwd: string) => ipcRenderer.invoke(ENGINE_IPC.folderSettings, cwd),
  setProjectSettings: (sessionPk: number, patch) => ipcRenderer.invoke(ENGINE_IPC.setProjectSettings, sessionPk, patch),
  addProjectDir: (sessionPk: number, path: string | null) => ipcRenderer.invoke(ENGINE_IPC.addProjectDir, sessionPk, path),
  shellRun: (sessionPk: number, command: string) => ipcRenderer.invoke(ENGINE_IPC.shellRun, sessionPk, command),
  shellStop: (id: string) => ipcRenderer.invoke(ENGINE_IPC.shellStop, id),
  shellDismiss: (id: string) => ipcRenderer.invoke(ENGINE_IPC.shellDismiss, id),
  shellList: (sessionPk: number) => ipcRenderer.invoke(ENGINE_IPC.shellList, sessionPk),
  onShellChanged: (cb) => {
    const listener = (_e: unknown, sessionPk: number, runs: ShellRun[]): void => cb(sessionPk, runs)
    ipcRenderer.on(ENGINE_IPC.shellChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.shellChanged, listener) }
  },
  folderTrust: (cwd: string) => ipcRenderer.invoke(ENGINE_IPC.folderTrust, cwd),
  trustFolder: (cwd: string) => ipcRenderer.invoke(ENGINE_IPC.trustFolder, cwd),
  githubStatus: () => ipcRenderer.invoke(ENGINE_IPC.githubStatus),
  githubRepos: () => ipcRenderer.invoke(ENGINE_IPC.githubRepos),
  githubPrepare: (options: { repo: string; cwd: string }) => ipcRenderer.invoke(ENGINE_IPC.githubPrepare, options),
  onLockChanged: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, lock: ExternalLock | null) => cb(sessionPk, lock)
    ipcRenderer.on(ENGINE_IPC.lockChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.lockChanged, listener) }
  },
  listRemote: (): Promise<RemoteSession[]> => ipcRenderer.invoke(ENGINE_IPC.listRemote),
  onRemoteChanged: cb => {
    const listener = (_e: IpcRendererEvent, remote: RemoteSession[]) => cb(remote)
    ipcRenderer.on(ENGINE_IPC.remoteChanged, listener)
    return () => { ipcRenderer.off(ENGINE_IPC.remoteChanged, listener) }
  }
}

const manage: ManageApi = {
  planDelete: target => ipcRenderer.invoke(MANAGE_IPC.planDelete, target),
  checkSessions: target => ipcRenderer.invoke(MANAGE_IPC.checkSessions, target),
  endSessions: pids => ipcRenderer.invoke(MANAGE_IPC.endSessions, pids),
  executeDelete: (target, keys, restorePoint) => ipcRenderer.invoke(MANAGE_IPC.executeDelete, target, keys, restorePoint),
  showInFolder: path => ipcRenderer.invoke(MANAGE_IPC.showInFolder, path),

  manageProjects: () => ipcRenderer.invoke(MANAGE_IPC.listProjects),
  projectDetail: workingDir => ipcRenderer.invoke(MANAGE_IPC.projectDetail, workingDir),
  searchStart: (id, query) => ipcRenderer.invoke(MANAGE_IPC.searchStart, id, query),
  searchCancel: id => ipcRenderer.invoke(MANAGE_IPC.searchCancel, id),
  onSearchEvent: cb => {
    const listener = (_e: IpcRendererEvent, ev: ContentSearchEvent) => cb(ev)
    ipcRenderer.on(MANAGE_IPC.searchEvent, listener)
    return () => { ipcRenderer.off(MANAGE_IPC.searchEvent, listener) }
  },
  exportProjects: workingDirs => ipcRenderer.invoke(MANAGE_IPC.exportProjects, workingDirs),
  pickImport: () => ipcRenderer.invoke(MANAGE_IPC.pickImport),
  readArchive: zip => ipcRenderer.invoke(MANAGE_IPC.readArchive, zip),
  importArchive: zip => ipcRenderer.invoke(MANAGE_IPC.importArchive, zip),
  renamePlan: (oldDir, newDir) => ipcRenderer.invoke(MANAGE_IPC.renamePlan, oldDir, newDir),
  renameExecute: (oldDir, newDir, signature) => ipcRenderer.invoke(MANAGE_IPC.renameExecute, oldDir, newDir, signature),
  listRestorePoints: () => ipcRenderer.invoke(MANAGE_IPC.listRestorePoints),
  deleteRestorePoints: list => ipcRenderer.invoke(MANAGE_IPC.deleteRestorePoints, list),
  openRestorePointsFolder: () => ipcRenderer.invoke(MANAGE_IPC.openRestorePointsFolder),
  findNotes: rescan => ipcRenderer.invoke(MANAGE_IPC.findNotes, rescan),
  searchNotes: query => ipcRenderer.invoke(MANAGE_IPC.searchNotes, query),
  deleteNotes: list => ipcRenderer.invoke(MANAGE_IPC.deleteNotes, list),
  previewNote: path => ipcRenderer.invoke(MANAGE_IPC.previewNote, path),
  exportNotes: list => ipcRenderer.invoke(MANAGE_IPC.exportNotes, list),
  openInEditor: path => ipcRenderer.invoke(MANAGE_IPC.openInEditor, path),
  liveSessions: () => ipcRenderer.invoke(MANAGE_IPC.liveSessions)
}

const update: UpdateApi = {
  getUpdateStatus: () => ipcRenderer.invoke(UPDATE_IPC.getStatus),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_IPC.check),
  installUpdate: () => ipcRenderer.invoke(UPDATE_IPC.install),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_IPC.download),
  updateAndRestart: mode => ipcRenderer.invoke(UPDATE_IPC.updateAndRestart, mode),
  setUpdateHold: hold => ipcRenderer.invoke(UPDATE_IPC.setHold, hold),
  setUpdateOpenChat: chat => ipcRenderer.invoke(UPDATE_IPC.setOpenChat, chat),
  takeResumedChat: () => ipcRenderer.invoke(UPDATE_IPC.takeResumedChat),
  updateRestartWork: () => ipcRenderer.invoke(UPDATE_IPC.work),
  restartWhenFinished: () => ipcRenderer.invoke(UPDATE_IPC.restartWhenFinished),
  cancelUpdateRestart: () => ipcRenderer.invoke(UPDATE_IPC.cancelRestart),
  openUpdateDownload: () => ipcRenderer.invoke(UPDATE_IPC.openDownload),
  onUpdateStatus: cb => {
    const listener = (_e: IpcRendererEvent, s: UpdateStatus) => cb(s)
    ipcRenderer.on(UPDATE_IPC.status, listener)
    return () => { ipcRenderer.off(UPDATE_IPC.status, listener) }
  }
}

const claudeSettings: ClaudeSettingsApi = {
  claudeSettingsGet: target => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.get, target),
  claudeSettingsUpdate: (target, patch) => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.update, target, patch),
  claudeSettingsText: target => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.getText, target),
  claudeSettingsSaveText: (target, text) => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.saveText, target, text),
  retentionStatus: () => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.retentionStatus),
  retentionPreview: () => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.retentionPreview),
  retentionRunNow: () => ipcRenderer.invoke(CLAUDE_SETTINGS_IPC.retentionRunNow),
  onRetentionCleaned: cb => {
    const listener = (_e: IpcRendererEvent, r: AutoCleanResult) => cb(r)
    ipcRenderer.on(CLAUDE_SETTINGS_IPC.retentionCleaned, listener)
    return () => { ipcRenderer.off(CLAUDE_SETTINGS_IPC.retentionCleaned, listener) }
  },
  onOpenChat: cb => {
    const listener = (_e: IpcRendererEvent, sessionPk: number, dirName: string) => cb(sessionPk, dirName)
    ipcRenderer.on(CLAUDE_SETTINGS_IPC.openChat, listener)
    return () => { ipcRenderer.off(CLAUDE_SETTINGS_IPC.openChat, listener) }
  }
}

const sync: SyncApi = {
  syncStatus: () => ipcRenderer.invoke(SYNC_IPC.status),
  onSyncChanged: cb => {
    const listener = (_e: IpcRendererEvent, s: SyncStatus) => cb(s)
    ipcRenderer.on(SYNC_IPC.changed, listener)
    return () => { ipcRenderer.off(SYNC_IPC.changed, listener) }
  },
  syncFindRepo: name => ipcRenderer.invoke(SYNC_IPC.findRepo, name),
  syncSetupNew: options => ipcRenderer.invoke(SYNC_IPC.setupNew, options),
  syncSetupExisting: options => ipcRenderer.invoke(SYNC_IPC.setupExisting, options),
  syncSetDeviceName: name => ipcRenderer.invoke(SYNC_IPC.setDeviceName, name),
  syncSetAuto: on => ipcRenderer.invoke(SYNC_IPC.setAuto, on),
  syncScanProject: dir => ipcRenderer.invoke(SYNC_IPC.scanProject, dir),
  onSyncScanProgress: cb => {
    const listener = (_e: IpcRendererEvent, p: ScanProgress) => cb(p)
    ipcRenderer.on(SYNC_IPC.scanProgress, listener)
    return () => { ipcRenderer.off(SYNC_IPC.scanProgress, listener) }
  },
  syncEnableProject: (dir, decisions) => ipcRenderer.invoke(SYNC_IPC.enableProject, dir, decisions),
  syncIncoming: () => ipcRenderer.invoke(SYNC_IPC.incomingNow),
  onSyncIncoming: cb => {
    const listener = (_e: IpcRendererEvent, list: SyncIncoming[]) => cb(list)
    ipcRenderer.on(SYNC_IPC.incoming, listener)
    return () => { ipcRenderer.off(SYNC_IPC.incoming, listener) }
  },
  onSyncEnableProgress: cb => {
    const listener = (_e: IpcRendererEvent, p: EnableProgress) => cb(p)
    ipcRenderer.on(SYNC_IPC.enableProgress, listener)
    return () => { ipcRenderer.off(SYNC_IPC.enableProgress, listener) }
  },
  syncDisableProject: id => ipcRenderer.invoke(SYNC_IPC.disableProject, id),
  syncLinkProject: (id, folder) => ipcRenderer.invoke(SYNC_IPC.linkProject, id, folder),
  syncNow: () => ipcRenderer.invoke(SYNC_IPC.syncNow),
  syncDecideFindings: (id, decisions) => ipcRenderer.invoke(SYNC_IPC.decideFindings, id, decisions),
  syncResolveConflict: id => ipcRenderer.invoke(SYNC_IPC.resolveConflict, id),
  syncChatInfo: pk => ipcRenderer.invoke(SYNC_IPC.chatInfo, pk),
  syncBeforeSend: pk => ipcRenderer.invoke(SYNC_IPC.beforeSend, pk),
  syncRemoveFromGithub: id => ipcRenderer.invoke(SYNC_IPC.removeFromGithub, id),
  syncStartFresh: () => ipcRenderer.invoke(SYNC_IPC.startFresh),
  syncRecoveryKey: () => ipcRenderer.invoke(SYNC_IPC.recoveryKey),
  syncTurnOn: key => ipcRenderer.invoke(SYNC_IPC.turnOn, key),
  syncReplaceRecoveryKey: () => ipcRenderer.invoke(SYNC_IPC.replaceRecoveryKey),
  syncDisconnect: () => ipcRenderer.invoke(SYNC_IPC.disconnect)
}

contextBridge.exposeInMainWorld('delegatto', { ...api, ...manage, ...update, ...claudeSettings, ...sync })
