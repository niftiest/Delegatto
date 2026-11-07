// ContentBlock/Usage are defined once, in the read path's row-shape module
// (src/main/jsonl/rows.ts), since they describe the Anthropic message content
// shape shared verbatim between durable JSONL rows and live stream-json
// events. Re-exported here so shared/ (and anything importing shared/types)
// has a single, electron-free import path for them.
export type { ContentBlock, Usage } from '../main/jsonl/rows'
import type { ChannelMeta } from './shell-types'

export type ProjectSummary = {
  id: number; dirName: string; cwd: string | null
  sessionCount: number; lastActivity: string | null
  /** Snippet of the most recent message in the channel's newest main session,
   *  for the nav preview line (Google-Messages style). Null when the channel
   *  has no text messages yet. */
  preview: string | null
}

/** A ProjectSummary with its app-owned metadata (rename/star/group/icon)
 *  merged in -- what the nav actually renders (Plan 3 Task 2). Declared here
 *  (not in shell-types.ts) since it's a composite of ProjectSummary (defined
 *  in this file) and ChannelMeta (shell-types.ts) -- the canonical shape for
 *  the IPC boundary (`listChannels`) both the main-process merge and the
 *  renderer's nav cross. */
export type ChannelRow = ProjectSummary & {
  meta: ChannelMeta
  /** `owner/name` when the project's folder is a clone of a GitHub repo. */
  repo?: string | null
  /** The project's folder no longer exists, so its chats are read-only history. */
  archived?: boolean
}

export type SessionSummary = {
  id: number; sessionId: string; title: string | null; messageCount: number
  lastTs: string | null; model: string | null; gitBranch: string | null
  inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number
}

export type SearchHit = {
  sessionPk: number; sessionId: string; projectDir: string
  seq: number; ts: string | null; snippet: string
}

/** Declared here — not in shared/ipc.ts — so src/main/indexer/ can import it
 *  without reaching into a module that names IPC channels. */
export type IndexProgress = {
  done: number; total: number; bytesDone: number; bytesTotal: number; current: string
}

export type ToolResult = { text: string; isError: boolean }

export type RenderItem =
  /** `literal`: shell output, shown exactly as printed rather than as markdown. */
  /** `command`: a slash command as typed ('echo') or what it printed ('output'). */
  | { kind: 'text'; uuid: string; role: 'user' | 'assistant'; ts: string | null; model: string | null; text: string; literal?: boolean; command?: 'echo' | 'output' }
  | { kind: 'thinking'; uuid: string; ts: string | null; text: string }
  | { kind: 'notice'; uuid: string; ts: string | null; text: string; label?: string }
  | { kind: 'tool'; uuid: string; toolUseId: string; ts?: string | null; name: string; input: unknown; result: ToolResult | null; subagentToolUseId: string | null }
  | { kind: 'image'; uuid: string; role: 'user' | 'assistant'; source: unknown }

export type TranscriptPage = {
  items: RenderItem[]; oldestSeq: number | null; hasMore: boolean
  /** The transcript has gone, and this is the text the catalog saved of it. */
  savedTextOnly?: boolean
  /** True when the catalog has indexed messages for this session but its JSONL
   *  file is no longer on disk (Claude Code deletes transcripts older than its
   *  cleanupPeriodDays, default 30). The cost/metadata survive in the catalog;
   *  the transcript body can't be rendered. Lets the UI say "archived" instead
   *  of the misleading "no messages". */
  fileMissing?: boolean
}
