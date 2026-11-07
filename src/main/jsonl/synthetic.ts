/** Claude Code stores some transcript rows that were never typed by anyone:
 *  its own context notes for the model, slash-command echoes wrapped in tags,
 *  command output, and compaction summaries. Its terminal UI knows to hide or
 *  reformat them; this does the same for Delegatto's transcript, chat-list
 *  previews and search. Pure and electron-free (the renderer uses it too). */

export type SyntheticFlags = { isMeta?: unknown; isCompactSummary?: unknown }

export const COMPACT_LABEL = 'Conversation compacted'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

function tagContent(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return m === null ? null : m[1]!
}

/** `<command-name>/x</command-name>…<command-args>y</command-args>` as the user
 *  would have typed it ("/x y"), or null when `text` isn't a command echo. */
export function commandEcho(text: string): string | null {
  const t = text.trimStart()
  if (!t.startsWith('<command-name>') && !t.startsWith('<command-message>')) return null
  const name = tagContent(t, 'command-name')?.trim()
  if (name === undefined || name.length === 0) return null
  const args = tagContent(t, 'command-args')?.trim() ?? ''
  return args.length > 0 ? `${name} ${args}` : name
}

/** What a shell command or local slash command printed, or null when `text`
 *  isn't command output. An empty string means it printed nothing. */
export function commandOutput(text: string): string | null {
  const t = text.trimStart()
  if (!t.startsWith('<local-command-std') && !t.startsWith('<bash-std')) return null
  return ['local-command-stdout', 'local-command-stderr', 'bash-stdout', 'bash-stderr']
    .map(tag => tagContent(t, tag)?.replace(ANSI, '').trim() ?? '')
    .filter(s => s.length > 0)
    .join('\n')
}

/** `<bash-input>x</bash-input>` (a terminal `!x`) as typed, or null. */
export function bashEcho(text: string): string | null {
  const t = text.trimStart()
  if (!t.startsWith('<bash-input>')) return null
  const input = tagContent(t, 'bash-input')
  return input === null ? null : `!${input.trim()}`
}

/** The text a human would recognise from a stored row, for chat-list previews,
 *  titles and search. Empty for rows that aren't part of the conversation. */
export function displayText(flags: SyntheticFlags, text: string): string {
  if (flags.isMeta === true || flags.isCompactSummary === true) return ''
  return commandEcho(text) ?? bashEcho(text) ?? commandOutput(text) ?? text
}
