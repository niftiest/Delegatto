import type { RenderItem } from '../shared/types'

/** A chat as plain text, the way Claude Code's /export writes it: your messages after
 *  "> ", Claude's after "⏺ ", and each tool call with the start of what it returned. */

const RESULT_LINES = 12

function oneLine(v: unknown, max = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What a tool call was about, in a few words: the command, the file, the pattern. */
function toolArgument(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const i = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']) {
    if (typeof i[key] === 'string' && i[key] !== '') return oneLine(i[key])
  }
  return name.startsWith('mcp__') ? '' : oneLine(input, 100)
}

function indent(text: string, first: string, rest: string): string {
  return text.split('\n').map((line, n) => `${n === 0 ? first : rest}${line}`.trimEnd()).join('\n')
}

export function exportText(items: RenderItem[], header: { title: string; cwd: string | null }): string {
  const parts: string[] = [`# ${header.title}`]
  if (header.cwd !== null && header.cwd !== '') parts.push(`Folder: ${header.cwd}`)
  for (const it of items) {
    switch (it.kind) {
      case 'text':
        if (it.text.trim() === '') break
        parts.push(it.role === 'user' ? indent(it.text.trim(), '> ', '  ') : indent(it.text.trim(), '⏺ ', '  '))
        break
      case 'tool': {
        if (it.subagentToolUseId !== null) break
        const arg = toolArgument(it.name, it.input)
        let block = `⏺ ${it.name}${arg !== '' ? `(${arg})` : ''}`
        if (it.result !== null && it.result.text.trim() !== '') {
          const lines = it.result.text.trimEnd().split('\n')
          const shown = lines.slice(0, RESULT_LINES).join('\n')
          const more = lines.length > RESULT_LINES ? `\n… ${lines.length - RESULT_LINES} more lines` : ''
          block += '\n' + indent(`${it.result.isError ? 'Error: ' : ''}${shown}${more}`, '  ⎿  ', '     ')
        }
        parts.push(block)
        break
      }
      case 'notice':
        parts.push(indent(it.text.trim(), '※ ', '  '))
        break
      case 'image':
        parts.push(it.role === 'user' ? '> [Image]' : '⏺ [Image]')
        break
      default:
        break
    }
  }
  return parts.join('\n\n') + '\n'
}

/** Claude Code's own default name for an export. */
export function exportFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `conversation-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.txt`
}
