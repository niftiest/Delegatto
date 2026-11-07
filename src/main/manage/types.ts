export type ArtifactKind =
  | 'ProjectFolder' | 'Memory' | 'ClaudeJsonEntry' | 'GithubRepoPath' | 'HistoryLines' | 'TempScratch'
  | 'FileHistory' | 'SessionEnv' | 'Tasks' | 'Uploads' | 'Todos' | 'Job' | 'InDirClaudeFolder' | 'InDirClaudeMd'
  // Per-chat scope (Delegatto addition): one session's transcript + its subagent folder.
  | 'SessionTranscript' | 'SessionFolder'

/** One thing Claude keeps for a project/chat. `parent` marks display-only children
 *  (memory/*.md under the memory folder) -- never removal targets. `optional` items
 *  (the working folder's own .claude\ and CLAUDE.md) start unticked. */
export type Artifact = {
  kind: ArtifactKind
  path: string
  description: string
  sizeBytes: number
  optional: boolean
  parent?: string
}

export type ProjectInfo = {
  workingDir: string
  /** False when the real path couldn't be recovered (only the lossy encoded name is known). */
  workingDirKnown: boolean
  encodedName: string
  /** ~/.claude/projects/<encoded>, or null for a .claude.json-only project. */
  projectDir: string | null
  sessionIds: string[]
  /** Epoch ms of the newest transcript, or null. */
  lastUsed: number | null
  sizeBytes: number
  /** The working folder exists on disk. */
  exists: boolean
  worktreeOf: string | null
}

/** What a delete does to a path: move to the Recycle Bin, or remove for good. */
export interface FileRemover {
  removeDirectory(path: string): Promise<void>
  removeFile(path: string): Promise<void>
  /** False when `path`'s drive has no Recycle Bin (network/removable) -- the
   *  delete would be permanent. The permanent remover always says false. */
  recyclable(path: string): boolean
}
