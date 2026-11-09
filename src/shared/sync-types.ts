/** Project sync: keeps chosen projects' chats the same across PCs through a private
 *  GitHub repo the user owns. Shared between the main process and the renderer. */

export const SYNC_IPC = {
  status: 'sync:status',
  changed: 'sync:changed',
  findRepo: 'sync:findRepo',
  setupNew: 'sync:setupNew',
  setupExisting: 'sync:setupExisting',
  setDeviceName: 'sync:setDeviceName',
  setAuto: 'sync:setAuto',
  scanProject: 'sync:scanProject',
  scanProgress: 'sync:scanProgress',
  enableProject: 'sync:enableProject',
  enableProgress: 'sync:enableProgress',
  incoming: 'sync:incoming',
  incomingNow: 'sync:incomingNow',
  disableProject: 'sync:disableProject',
  linkProject: 'sync:linkProject',
  syncNow: 'sync:now',
  decideFindings: 'sync:decideFindings',
  resolveConflict: 'sync:resolveConflict',
  chatInfo: 'sync:chatInfo',
  beforeSend: 'sync:beforeSend',
  removeFromGithub: 'sync:removeFromGithub',
  startFresh: 'sync:startFresh',
  recoveryKey: 'sync:recoveryKey',
  turnOn: 'sync:turnOn',
  replaceRecoveryKey: 'sync:replaceRecoveryKey',
  disconnect: 'sync:disconnect'
} as const

export type SecretConfidence = 'definite' | 'possible'

/** One likely secret, grouped across a project. The secret itself never leaves the scanner. */
export type SecretFinding = {
  fingerprint: string
  rule: string
  confidence: SecretConfidence
  /** First and last characters only. */
  masked: string
  /** Text around it, with the secret masked. */
  context: string
  sessionIds: string[]
  /** Where outside a transcript it was found, such as a memory file. */
  files: string[]
  count: number
}

export type ProjectScan = {
  workingDir: string
  chats: number
  bytes: number
  findings: SecretFinding[]
  /** Pictures can't be scanned, so a key in a screenshot wouldn't be found. */
  images: number
}

export type ScanProgress = { workingDir: string; done: number; total: number }

/** A chat getting messages from another PC. While it is, it can't be written to here: the
 *  chat box waits, and the chat reloads once they're in. `download` has no total yet;
 *  `write` counts the messages added so far. */
export type SyncIncoming = { sessionId: string; from: string; phase: 'download' | 'write'; done: number; total: number }

/** A project's first sync, or setting one up from another PC. `pack` counts chats; `upload`
 *  counts percent; `clone` (the project's own repo) and `download` have no total. */
export type EnableProgress = { workingDir: string; phase: 'clone' | 'download' | 'pack' | 'upload'; done: number; total: number }

/** What to do with each finding when a project is opted in. */
export type FindingDecisions = {
  redact: string[]
  allow: string[]
  excludeChats: string[]
}

export type SyncProjectRow = {
  workingDir: string
  name: string
  chats: number
  sizeBytes: number
  github: string | null
  /** Set once the project is opted in. */
  projectId: string | null
  lastSyncAt: number | null
  excludedChats: number
  /** New findings waiting for a decision. Those chats don't upload until then. */
  pendingFindings: SecretFinding[]
  warnings: string[]
}

/** A project in the sync repo that isn't set up on this PC yet. */
export type RemoteProject = {
  projectId: string
  name: string
  github: string | null
  branch: string | null
  chats: number
  updatedBy: string
  updatedAt: number
  /** Commits not pushed on the PC that uploaded it, so a clone won't have them. */
  unpushed: number
  /** Changed files not committed there, so a clone won't have them either. */
  uncommitted: number
  /** A suggested folder on this PC. */
  suggestedFolder: string
}

export type SyncConflict = {
  sessionId: string
  projectId: string
  title: string
  /** The other PC's name. */
  otherDevice: string
  otherAt: number
  localRows: number
  remoteRows: number
  sessionPk: number | null
}

export type SyncDevice = { id: string; name: string; hostname: string; lastSeenAt: number; openChats: string[]; isThisPc: boolean }

export type GithubState = { state: 'missing' | 'signed_out' | 'ready'; account: string | null }

export type SyncStatus = {
  github: GithubState
  configured: boolean
  /** Sync repos found on the account the last time it was checked. */
  discoveredRepos: string[]
  /** This PC chose to disconnect from sync. */
  leftSync: boolean
  repo: string | null
  encrypted: boolean
  auto: boolean
  deviceName: string
  hostname: string
  busy: boolean
  /** What it's doing right now, when busy. */
  activity: string | null
  lastSyncAt: number | null
  lastCheckAt: number | null
  lastError: string | null
  /** The sync repo's size on GitHub, when known. */
  repoSizeBytes: number | null
  /** This PC saved the recovery key when it made the repo or was linked with it. */
  hasRecoveryKey: boolean
  /** GitHub repos with synced chats. Known without the key, so New chat can mark them. */
  syncedRepos: string[]
  projects: SyncProjectRow[]
  remoteProjects: RemoteProject[]
  conflicts: SyncConflict[]
  devices: SyncDevice[]
}

/** What to show for one chat. */
export type SyncChatInfo = {
  synced: boolean
  /** Another PC has this chat open now, or had it open last. */
  elsewhere: { device: string; hostname: string; lastSeenAt: number; active: boolean } | null
  conflict: SyncConflict | null
  /** Waiting for a decision about a likely secret, so it isn't uploading. */
  pendingSecrets: number
  /** The project folder here isn't on the commit this chat last used. */
  codeNote: string | null
}

export type SetupOutcome =
  | { ok: true; repo: string; recoveryKey: string | null; encrypted: boolean }
  | { ok: false; error: string }

/** Turning sync on: `needsKey` means the account already has a sync repo, so ask for its key. */
export type TurnOnOutcome = SetupOutcome | { ok: false; needsKey: true; repo: string }

export type LinkOutcome =
  | { ok: true; workingDir: string; chats: number; warnings: string[] }
  | { ok: false; error: string }

export type ResolveOutcome =
  | { ok: true; branchSessionId: string; summary: string; sessionPk: number | null; branchPk: number | null; projectDir: string }
  | { ok: false; error: string }

export type SyncResult = { ok: true } | { ok: false; error: string }

/** What the chat list says about something waiting on GitHub. `ids` are what dismissing it covers. */
export type SyncOffer = { text: string; ids: string[] }

/** Dismissing covers what's listed now: anything new brings the offer back. */
export function syncOffer(status: SyncStatus, dismissed: ReadonlySet<string>): SyncOffer | null {
  if (status.github.state !== 'ready') return null
  if (status.configured) {
    const ids = status.remoteProjects.map(r => r.projectId)
    if (ids.every(id => dismissed.has(id))) return null
    const from = new Set(status.remoteProjects.map(r => r.updatedBy))
    return { ids, text: `${ids.length} project${ids.length === 1 ? '' : 's'} available from ${from.size === 1 ? [...from][0] : 'your other PCs'}` }
  }
  if (status.repo !== null || status.leftSync || status.discoveredRepos.every(r => dismissed.has(r))) return null
  return { ids: status.discoveredRepos, text: 'Found your sync repo. Link this PC to see its projects.' }
}

/** What the chat list can offer for one project. No value means sync doesn't apply to it. */
export type ProjectSyncState =
  | { kind: 'setup' }
  | { kind: 'off'; workingDir: string; name: string }
  | { kind: 'on'; projectId: string }

const samePath = (a: string, b: string): boolean => {
  const clean = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

/** `setup` means this PC has to link to a sync repo first. A folder sync doesn't list, such as
 *  a worktree, can't be synced on its own. */
export function projectSyncState(status: SyncStatus, project: { cwd: string | null; archived?: boolean }): ProjectSyncState | null {
  if (status.github.state !== 'ready' || project.cwd === null || project.cwd.length === 0 || project.archived === true) return null
  if (!status.configured) return { kind: 'setup' }
  const cwd = project.cwd
  const row = status.projects.find(p => samePath(p.workingDir, cwd))
  if (row === undefined) return null
  return row.projectId !== null ? { kind: 'on', projectId: row.projectId } : { kind: 'off', workingDir: row.workingDir, name: row.name }
}

export type RepoSearch = { repo: string; exists: boolean; isPrivate: boolean | null; encrypted: boolean | null; isSyncRepo: boolean; error: string | null }

export type SyncApi = {
  syncStatus(): Promise<SyncStatus>
  onSyncChanged(cb: (s: SyncStatus) => void): () => void
  syncFindRepo(name: string): Promise<RepoSearch>
  syncSetupNew(options: { name: string; encrypted: boolean }): Promise<SetupOutcome>
  syncSetupExisting(options: { name: string; recoveryKey: string }): Promise<SetupOutcome>
  syncSetDeviceName(name: string): Promise<void>
  syncSetAuto(on: boolean): Promise<void>
  syncScanProject(workingDir: string): Promise<ProjectScan>
  onSyncScanProgress(cb: (p: ScanProgress) => void): () => void
  syncEnableProject(workingDir: string, decisions: FindingDecisions): Promise<SyncResult>
  onSyncEnableProgress(cb: (p: EnableProgress) => void): () => void
  /** Chats getting messages from another PC right now. */
  syncIncoming(): Promise<SyncIncoming[]>
  onSyncIncoming(cb: (list: SyncIncoming[]) => void): () => void
  syncDisableProject(projectId: string): Promise<SyncResult>
  /** Progress arrives through onSyncEnableProgress, for the folder. */
  syncLinkProject(projectId: string, folder: string): Promise<LinkOutcome>
  syncNow(): Promise<SyncResult>
  syncDecideFindings(projectId: string, decisions: FindingDecisions): Promise<SyncResult>
  syncResolveConflict(sessionId: string): Promise<ResolveOutcome>
  syncChatInfo(sessionPk: number): Promise<SyncChatInfo>
  /** Checks for newer messages if the last check is a few minutes old. */
  syncBeforeSend(sessionPk: number): Promise<SyncChatInfo>
  syncRemoveFromGithub(projectId: string): Promise<SyncResult>
  syncStartFresh(): Promise<SyncResult>
  /** Links to the account's sync repo with this key, or makes one when there's none. */
  syncTurnOn(recoveryKey: string | null): Promise<TurnOnOutcome>
  /** The recovery key, when this PC saved it; null otherwise. */
  syncRecoveryKey(): Promise<string | null>
  /** Re-encrypts the repo under a new recovery key, which comes back once to show. */
  syncReplaceRecoveryKey(): Promise<SetupOutcome>
  syncDisconnect(): Promise<SyncResult>
}
