export type MemoryFile = {
  id: string
  label: string
  /** What the file is for. */
  note: string
  /** False for a file that can be created by saving it. */
  exists: boolean
}

export type MemoryFileContent = {
  text: string
  /** Null when the file doesn't exist yet. */
  mtimeMs: number | null
}

/** What saving meant for the project's running chats. */
export type MemorySaveResult =
  | { ok: true; content: MemoryFileContent; restarted: number; afterTurn: number; inTerminal: number }
  | { ok: false; error: string }
