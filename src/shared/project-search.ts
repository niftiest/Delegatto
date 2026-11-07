/** Ctrl+F: find messages in one project's chats. Unlike the app-wide search (Ctrl+K),
 *  this matches the way find-in-page does: any part of a word, punctuation included,
 *  so "conf" finds "config" and "config.py" means exactly that. */

export type ProjectSearchHit = {
  id: number
  sessionPk: number
  /** Which message it is, for going to it in its chat. */
  uuid: string
  seq: number
  /** The chat it's in. */
  title: string | null
  role: 'user' | 'assistant'
  ts: string | null
  text: string
  /** `text` is only the part of a long message around the first match. */
  trimmed: boolean
}

export type ProjectSearchResult = {
  /** Oldest first, like the chat. The newest ones when there are too many to show. */
  hits: ProjectSearchHit[]
  /** How many messages match in all. */
  total: number
}

/** Every word has to appear in a message, in any order. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(t => t.length > 0))]
}

/** Where the terms appear in a piece of text, ignoring case. */
export function findTermRanges(text: string, terms: string[]): Array<{ start: number; end: number }> {
  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  // Lower-casing can change a string's length (İ), which would misplace every range after it.
  if (lower.length !== text.length) return ranges
  for (const term of terms) {
    const needle = term.toLowerCase()
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      ranges.push({ start: at, end: at + needle.length })
    }
  }
  return ranges
}

/** A long message is cut down to the part around its first match. */
export function excerptAround(text: string, terms: string[], max = 4000): { text: string; trimmed: boolean } {
  if (text.length <= max) return { text, trimmed: false }
  const first = Math.min(...findTermRanges(text, terms).map(r => r.start), text.length)
  const start = first === text.length ? 0 : Math.max(0, Math.min(first - Math.floor(max / 4), text.length - max))
  const part = text.slice(start, start + max)
  return { text: `${start > 0 ? '…' : ''}${part}${start + max < text.length ? '…' : ''}`, trimmed: true }
}
