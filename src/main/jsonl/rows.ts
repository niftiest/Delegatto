export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: 'image'; source: unknown }
  | { type: string; [k: string]: unknown }

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type MessageRow = {
  type: 'user' | 'assistant'
  uuid: string
  parentUuid: string | null
  sessionId?: string
  cwd?: string
  gitBranch?: string
  version?: string
  timestamp?: string
  isSidechain?: boolean
  /** Context for the model; the CLI never shows it. */
  isMeta?: boolean
  /** The summary a compaction left behind. */
  isCompactSummary?: boolean
  permissionMode?: string
  todos?: unknown[]
  /** Claude Code's own record of a failed API call, not something Claude said. */
  isApiErrorMessage?: boolean
  /** `id` is the API message. One spans several rows, each repeating its usage. */
  message: { role: string; id?: string; model?: string; content: string | ContentBlock[]; usage?: Usage }
}

export type OtherRow = { type: string; [k: string]: unknown }
export type RawRow = MessageRow | OtherRow
