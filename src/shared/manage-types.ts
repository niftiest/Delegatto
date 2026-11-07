/** IPC surface for the Manage features (port of ClaudeMemoryTool): the Delete
 *  wizard (sidebar + Manage screen) and the Manage screen's Projects / Notes /
 *  Restore points / Live sessions tabs. Renderer <-> main only; the actual
 *  work lives in src/main/manage (electron-free) behind src/main/manage-ipc.ts. */

export const MANAGE_IPC = {
  // Delete wizard
  planDelete: 'manage:planDelete',
  checkSessions: 'manage:checkSessions',
  endSessions: 'manage:endSessions',
  executeDelete: 'manage:executeDelete',
  showInFolder: 'manage:showInFolder',
  // Projects tab
  listProjects: 'manage:listProjects',
  projectDetail: 'manage:projectDetail',
  searchStart: 'manage:searchStart',
  searchCancel: 'manage:searchCancel',
  /** main -> renderer: ContentSearchEvent */
  searchEvent: 'manage:searchEvent',
  exportProjects: 'manage:exportProjects',
  pickImport: 'manage:pickImport',
  readArchive: 'manage:readArchive',
  importArchive: 'manage:importArchive',
  renamePlan: 'manage:renamePlan',
  renameExecute: 'manage:renameExecute',
  // Restore points tab
  listRestorePoints: 'manage:listRestorePoints',
  deleteRestorePoints: 'manage:deleteRestorePoints',
  openRestorePointsFolder: 'manage:openRestorePointsFolder',
  // Notes tab
  findNotes: 'manage:findNotes',
  searchNotes: 'manage:searchNotes',
  deleteNotes: 'manage:deleteNotes',
  previewNote: 'manage:previewNote',
  exportNotes: 'manage:exportNotes',
  openInEditor: 'manage:openInEditor',
  // Live sessions tab
  liveSessions: 'manage:liveSessions'
} as const

/** What to delete: one chat (by catalog session pk), a whole project (by its
 *  ~/.claude/projects/<dirName> folder), or several projects at once (Manage
 *  screen multi-select). In `projects`, each entry is the project's encoded
 *  folder name -- or, for a project Claude only knows from .claude.json (no
 *  projects folder), its full working dir (a path with `:`/`\`, which an
 *  encoded name never contains). The batch gets one restore point. */
export type DeleteTarget =
  | { scope: 'chat'; sessionPk: number }
  | { scope: 'project'; dirName: string }
  | { scope: 'projects'; dirNames: string[] }

/** One row of the review step. */
export type WizardItem = {
  /** Unique per row (several rows can share a path, e.g. two .claude.json edits). */
  key: string
  path: string
  kind: string
  description: string
  sizeBytes: number
  /** Opt-in (the working folder's own .claude\ / CLAUDE.md): starts unticked. */
  optional: boolean
  /** Removed for good (no Recycle Bin on that drive): starts unticked. */
  permanent: boolean
  defaultSelected: boolean
  /** Goes with this containing folder (no checkbox of its own). */
  containedIn: string | null
  /** An edit inside .claude.json / history.jsonl rather than a file removal. */
  sharedEdit: boolean
  /** The project's working dir, for grouping a multi-project review (null otherwise). */
  group: string | null
}

/** A running `claude` process the wizard may need closed. */
export type WizardProcess = {
  pid: number
  sessionId: string
  cwd: string
  name: string | null
  /** Delegatto's own pooled process (closed gracefully) vs. anything else. */
  owner: 'app' | 'external'
}

export type DeletePlan = {
  target: DeleteTarget
  /** "Delete chat “…”" / "Delete project D:\GIT\X" / "Delete 3 projects". */
  title: string
  workingDir: string
  items: WizardItem[]
  /** Processes holding THIS chat/project open. */
  blocking: WizardProcess[]
  /** Every running session (needed closed for .claude.json / history.jsonl edits). */
  allLive: WizardProcess[]
  /** Size of the project data a restore point would hold. */
  restorePointBytes: number
  /** Things the review step must point out (e.g. another working dir sharing
   *  the encoded project folder, projects with no Claude data). */
  warnings: string[]
}

export type SessionCheck = { blocking: WizardProcess[]; allLive: WizardProcess[] }

export type EndSessionsResult = { ended: number[]; failures: Array<{ pid: number; error: string }> }

export type Failure = { path: string; error: string }

export type DeleteOutcome =
  | {
      ok: true
      done: string[]
      failures: Failure[]
      /** Where .claude.json / history.jsonl were copied before editing. */
      backupDir: string | null
      /** The zip made first, when asked for. */
      restorePoint: string | null
    }
  | { ok: false; error: string; sessions?: WizardProcess[] }

// ---------------------------------------------------------------- Manage screen

/** One project of the Projects table (a ProjectInfo, flattened for the wire). */
export type ProjectRow = {
  workingDir: string
  workingDirKnown: boolean
  encodedName: string
  /** ~/.claude/projects/<encoded>, or null for a .claude.json-only project. */
  projectDir: string | null
  sessions: number
  /** Epoch ms of the newest transcript. */
  lastUsed: number | null
  sizeBytes: number
  exists: boolean
  worktreeOf: string | null
}

/** One item of the Projects detail pane (everything Claude keeps for it). */
export type DetailRow = {
  kind: string
  path: string
  description: string
  sizeBytes: number
  optional: boolean
  /** A memory file shown under the memory folder (display only). */
  child: boolean
  /** Opens in the default editor (memory .md files) rather than in Explorer. */
  editable: boolean
  /** An edit inside .claude.json / history.jsonl (no size of its own). */
  sharedEdit: boolean
}

export type MatchPlace = 'path' | 'memory' | 'chat'

/** Streamed content-search progress for request `id`. */
export type ContentSearchEvent =
  | { id: number; type: 'match'; workingDir: string; places: MatchPlace[] }
  | { id: number; type: 'done' }
  | { id: number; type: 'error'; error: string }

/** Outcome of a Manage operation that changes (or writes) files. */
export type ManageResult =
  | {
      kind: 'done'
      done: string[]
      failures: Failure[]
      /** Where .claude.json / history.jsonl were copied before editing. */
      backupDir: string | null
      /** The zip written (export), if any. */
      zip?: string | null
    }
  /** The user dismissed a native file dialog: nothing happened. */
  | { kind: 'cancelled' }
  /** Refused before any change because Claude Code sessions are running. */
  | { kind: 'sessions'; error: string; sessions: WizardProcess[] }
  | { kind: 'error'; error: string }

/** What an export zip holds (read before Import / Restore asks to confirm). */
export type ArchiveSummary = {
  kind: 'Projects' | 'Notes'
  /** Epoch ms. */
  created: number
  machine: string
  projects: Array<{ workingDir: string; files: number; historyLines: number }>
  notes: string[]
}

export type RestorePointRow = {
  path: string
  /** Epoch ms. */
  created: number
  projects: string[]
  sizeBytes: number
  error: string | null
}

export type RenamePlanView = {
  oldDir: string
  newDir: string
  /** Human-readable steps (the C# RenameForm preview). */
  lines: string[]
  warning: string | null
  /** Opaque: identical iff the plan is unchanged (Rename re-plans and compares). */
  signature: string
}

export type RenameExecuteResult = ManageResult | { kind: 'changed'; plan: RenamePlanView }

export type NoteRow = {
  path: string
  workingDir: string
  relativePath: string
  /** Epoch ms. */
  modified: number
  sizeBytes: number
  cloudOnly: boolean
}

export type NotesIndex = {
  notes: NoteRow[]
  /** Working folders too large to walk completely ("partly scanned"). */
  truncated: string[]
  scanMs: number
}

export type NoteHitRow = NoteRow & {
  matchCount: number
  firstLineNumber: number
  firstLineText: string
  nameMatch: boolean
}

export type NoteSearchResult = { ok: true; hits: NoteHitRow[]; searchMs: number } | { ok: false; cancelled: true }

/** A note preview: its text, or a message why it isn't shown (cloud-only, too large, unreadable). */
export type NotePreview = { kind: 'text'; text: string } | { kind: 'message'; text: string }

export type ManageApi = {
  planDelete(target: DeleteTarget): Promise<DeletePlan>
  checkSessions(target: DeleteTarget): Promise<SessionCheck>
  endSessions(pids: number[]): Promise<EndSessionsResult>
  executeDelete(target: DeleteTarget, selectedKeys: string[], restorePoint: boolean): Promise<DeleteOutcome>
  showInFolder(path: string): Promise<void>

  /** Scans every project Claude Code has data for (walks the disk). */
  manageProjects(): Promise<ProjectRow[]>
  projectDetail(workingDir: string): Promise<DetailRow[]>
  /** Starts a memory+chat content search; matches arrive via onSearchEvent with this id. */
  searchStart(id: number, query: string): Promise<void>
  searchCancel(id: number): Promise<void>
  onSearchEvent(cb: (e: ContentSearchEvent) => void): () => void
  /** Native save dialog, then the export. */
  exportProjects(workingDirs: string[]): Promise<ManageResult>
  /** Native open dialog; the chosen zip, or null. */
  pickImport(): Promise<string | null>
  readArchive(zipPath: string): Promise<ArchiveSummary>
  importArchive(zipPath: string): Promise<ManageResult>
  renamePlan(oldDir: string, newDir: string): Promise<{ ok: true; plan: RenamePlanView } | { ok: false; error: string }>
  renameExecute(oldDir: string, newDir: string, signature: string): Promise<RenameExecuteResult>

  listRestorePoints(): Promise<RestorePointRow[]>
  deleteRestorePoints(paths: string[]): Promise<ManageResult>
  openRestorePointsFolder(): Promise<void>

  /** The notes index (rebuilt when `rescan`, or when the projects were rescanned since). */
  findNotes(rescan: boolean): Promise<NotesIndex>
  /** Searches the current notes index; a newer call cancels an older one. */
  searchNotes(query: string): Promise<NoteSearchResult>
  deleteNotes(paths: string[]): Promise<ManageResult>
  previewNote(path: string): Promise<NotePreview>
  exportNotes(paths: string[]): Promise<ManageResult>
  /** Opens a .md file (note or memory file) in the default editor; an error message, or null. */
  openInEditor(path: string): Promise<string | null>

  liveSessions(): Promise<WizardProcess[]>
}
