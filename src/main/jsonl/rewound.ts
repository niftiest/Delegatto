import type { RawRow } from './rows'

/** Messages Claude Code has rewound past, so Claude no longer has them. They stay in the
 *  transcript, and this reads Claude Code's own record of it: after the note that a turn
 *  was interrupted, a `last-prompt` row says where the chat now resumes from, and that's
 *  somewhere before the message. A later message can say the same by sharing its parent.
 *
 *  Deliberately narrow: only a message stopped before any reply. A chat's history is
 *  otherwise shown in full (see loadTranscript for why it isn't walked as a tree). */

const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/

type Row = {
  type?: unknown
  uuid?: unknown
  parentUuid?: unknown
  leafUuid?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  message?: { content?: unknown }
}

function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const block = content.find((b: { type?: unknown }) => b?.type === 'text') as { text?: unknown } | undefined
  return typeof block?.text === 'string' ? block.text : ''
}

function isToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b: { type?: unknown }) => b?.type === 'tool_result')
}

export function rewoundUuids(rows: readonly RawRow[]): Set<string> {
  const out = new Set<string>()
  let open: { prompt: string; parent: unknown; marker: string | null; seen: Set<string> } | null = null
  const settle = (): void => {
    if (open?.marker) { out.add(open.prompt); out.add(open.marker) }
    open = null
  }
  for (const raw of rows) {
    const row = raw as unknown as Row
    if (row.isSidechain === true) continue
    if (row.type === 'last-prompt') {
      // A leaf from before the message, or no leaf at all: the chat has gone back past it.
      const leaf = typeof row.leafUuid === 'string' ? row.leafUuid : null
      if (open?.marker && (leaf === null || !open.seen.has(leaf))) settle()
      continue
    }
    if (row.type === 'assistant') { open = null; continue }
    // Claude Code's own note about a picture, say: not something typed.
    if (row.type === 'user' && row.isMeta !== true && typeof row.uuid === 'string') {
      const content = row.message?.content
      if (open !== null && open.marker === null && INTERRUPTED.test(firstText(content).trim())) {
        open.marker = row.uuid
        open.seen.add(row.uuid)
        continue
      }
      if (isToolResult(content)) { open = null; continue }
      if (open?.marker && row.parentUuid === open.parent) settle()
      open = { prompt: row.uuid, parent: row.parentUuid, marker: null, seen: new Set([row.uuid]) }
      continue
    }
    if (typeof row.uuid === 'string') open?.seen.add(row.uuid)
  }
  return out
}
