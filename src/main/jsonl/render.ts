import { blocksOf, type LocalCommandRow } from './parse'
import type { MessageRow } from './rows'
import { bashEcho, commandEcho, commandOutput, COMPACT_LABEL } from './synthetic'
import type { RenderItem, ToolResult } from '../../shared/types'

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // Filter to text blocks *before* joining — mapping non-text blocks to '' and
    // joining unconditionally would insert a spurious blank line wherever an
    // image (or other structured) block sits between two text blocks.
    return content
      .filter((block): block is { type: 'text'; text?: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
      )
      .map(block => String(block.text ?? ''))
      .join('\n')
      .trim()
  }
  return ''
}

// The CLI injects a synthetic user text turn alongside a pasted image, telling
// the model the image's dimensions and how to map click coordinates -- e.g.
// "[Image: original 3296x514, displayed at 2000x312. Multiply coordinates by
// 1.65 to map to original image.]". It's plumbing for the model, never meant
// for a human reading the chat, so we drop it from the render stream. Matched
// narrowly (an [Image: ...] wrapper that ends in the coordinate-mapping phrase)
// so an ordinary message that merely starts with "[Image:" is never hidden.
const IMAGE_COORD_META = /^\[Image:[^\]]*map to original image\.?\]$/i

// Claude Code injects a synthetic user-role turn each time a background task or
// agent finishes, feeding the result back into the model's context wrapped in
// <task-notification>…</task-notification>. It's machine plumbing the user never
// typed (origin.kind === 'task-notification', promptSource 'system' in the raw
// row), so rendering it as a "You" bubble wrongly attributes it to them. We
// keep it — the wrapper can carry a real agent result worth reading — but tag it
// as a `notice` so the UI shows a muted, collapsible system note instead. Match
// only the exact wrapper so an ordinary message mentioning the tag isn't caught.
const TASK_NOTIFICATION = /^<task-notification>[\s\S]*<\/task-notification>$/

// Claude Code's own record of a stopped turn, stored as if the user had typed it.
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/

// Not something Claude said: Claude Code writes this reply itself when a chat is
// resumed after its process died mid-turn, to keep the transcript well-formed.
const SYNTHETIC_MODEL = '<synthetic>'
const NO_RESPONSE_REQUESTED = 'No response requested.'

/** A compaction's own "Compacted" receipt: its summary card already says so. */
function isCompactReceipt(output: string): boolean {
  return /^compacted\b/i.test(output)
}

/** The display form of a slash-command echo or output, or null for plain text. */
function commandItem(uuid: string, ts: string | null, text: string): RenderItem[] | null {
  const slash = commandEcho(text)
  if (slash !== null) return [{ kind: 'text', uuid, role: 'user', ts, model: null, text: slash, command: 'echo' }]
  const shell = bashEcho(text)
  if (shell !== null) return [{ kind: 'text', uuid, role: 'user', ts, model: null, text: shell }]
  const output = commandOutput(text)
  if (output === null) return null
  if (output.length === 0 || isCompactReceipt(output)) return []
  const item: RenderItem = { kind: 'text', uuid, role: 'assistant', ts, model: null, text: output }
  return [text.trimStart().startsWith('<bash-') ? { ...item, literal: true } : { ...item, command: 'output' }]
}

function localCommandItems(row: LocalCommandRow): RenderItem[] {
  const ts = row.timestamp ?? null
  const text = row.content.trim()
  const items = commandItem(row.uuid, ts, text)
  if (items !== null) return items
  // A refused command is echoed bare ("/export"); anything else is its output.
  if (text.length === 0) return []
  return [text.startsWith('/')
    ? { kind: 'text', uuid: row.uuid, role: 'user', ts, model: null, text, command: 'echo' }
    : { kind: 'text', uuid: row.uuid, role: 'assistant', ts, model: null, text, command: 'output' }]
}

/** `rows` may include local-command `system` rows, which have no entry in the
 *  message catalog: when paging with `emitFor` they belong to the page holding
 *  the message right before them. */
/** Every tool_result in these rows, by the id of the tool call it answers. */
export function collectToolResults(rows: Array<MessageRow | LocalCommandRow>): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>()
  for (const row of rows) {
    if (row.type === 'system') continue
    for (const block of blocksOf(row)) {
      if (block.type !== 'tool_result') continue
      const id = (block as { tool_use_id?: unknown }).tool_use_id
      if (typeof id !== 'string' || id.length === 0) continue
      results.set(id, {
        text: resultText((block as { content?: unknown }).content),
        isError: (block as { is_error?: unknown }).is_error === true
      })
    }
  }
  return results
}

export function buildRenderItems(rows: Array<MessageRow | LocalCommandRow>, emitFor?: ReadonlySet<string>): RenderItem[] {
  // First pass: collect every tool_result — including from lookahead rows that
  // will not themselves render — so a tool card at a page boundary is complete.
  const results = collectToolResults(rows)

  const items: RenderItem[] = []
  let previousMessageEmitted = false
  for (const row of rows) {
    if (row.type === 'system') {
      if (emitFor === undefined || previousMessageEmitted) items.push(...localCommandItems(row))
      continue
    }
    previousMessageEmitted = emitFor === undefined || emitFor.has(row.uuid)
    if (!previousMessageEmitted) continue // lookahead row: results-only, no render
    if (row.isMeta === true) continue // the CLI's context notes: never part of the conversation
    const role = row.type
    const ts = row.timestamp ?? null
    const model = row.message.model ?? null

    for (const block of blocksOf(row)) {
      switch (block.type) {
        case 'thinking': {
          const text = String((block as { thinking?: unknown }).thinking ?? '').trim()
          if (text.length > 0) items.push({ kind: 'thinking', uuid: row.uuid, ts, text })
          break
        }
        case 'text': {
          const text = String((block as { text?: unknown }).text ?? '').trim()
          if (text.length === 0 || IMAGE_COORD_META.test(text)) break
          if (role === 'assistant' && model === SYNTHETIC_MODEL && text === NO_RESPONSE_REQUESTED) break
          // Anything else Claude Code writes in Claude's place: a failed API call, a limit.
          if (role === 'assistant' && (model === SYNTHETIC_MODEL || row.isApiErrorMessage === true)) {
            items.push({ kind: 'notice', uuid: row.uuid, ts, text, label: text.split('\n')[0]!.slice(0, 160) })
            break
          }
          const command = role === 'user' ? commandItem(row.uuid, ts, text) : null
          if (command !== null) {
            // The CLI stores a compaction's summary before the /compact that asked
            // for it; show them in the order they happened.
            const previous = items[items.length - 1]
            if (command[0]?.kind === 'text' && /^\/compact\b/.test(command[0].text) && previous?.kind === 'notice' && previous.label === COMPACT_LABEL) {
              items.splice(items.length - 1, 0, ...command)
            } else {
              items.push(...command)
            }
          } else if (role === 'user' && row.isCompactSummary === true) {
            items.push({ kind: 'notice', uuid: row.uuid, ts, text, label: COMPACT_LABEL })
          } else if (role === 'user' && INTERRUPTED.test(text)) {
            items.push({ kind: 'notice', uuid: row.uuid, ts, text, label: 'Interrupted' })
          } else if (role === 'user' && TASK_NOTIFICATION.test(text)) {
            items.push({ kind: 'notice', uuid: row.uuid, ts, text })
          } else {
            items.push({ kind: 'text', uuid: row.uuid, role, ts, model, text })
          }
          break
        }
        case 'tool_use': {
          // A missing/non-string id can't be trusted to key the results map — an
          // empty-string fallback would risk colliding with a (pathological) empty
          // tool_use_id on some unrelated tool_result. Treat it as unmatched instead.
          const rawId = (block as { id?: unknown }).id
          const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : null
          const name = String((block as { name?: unknown }).name ?? 'unknown')
          items.push({
            kind: 'tool',
            uuid: row.uuid,
            toolUseId: id ?? '',
            ts,
            name,
            input: (block as { input?: unknown }).input,
            result: id !== null ? (results.get(id) ?? null) : null,
            subagentToolUseId: name === 'Task' ? id : null
          })
          break
        }
        case 'image': {
          items.push({ kind: 'image', uuid: row.uuid, role, source: (block as { source?: unknown }).source })
          break
        }
        default:
          break // tool_result is consumed in the first pass; unknown block types are ignored
      }
    }
  }
  return items
}
