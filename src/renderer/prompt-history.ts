/** Going back through what was typed: Up and Down step through it, as in the terminal. */

/** The next place in `list` (newest first), or null if there's nowhere further. `at` is -1
 *  for the draft being written, before anything was recalled. */
export function stepHistory(list: string[], at: number, dir: 'older' | 'newer'): { at: number; text: string } | null {
  if (dir === 'older') {
    const next = at + 1
    return next < list.length ? { at: next, text: list[next]! } : null
  }
  if (at === -1) return null
  return at === 0 ? { at: -1, text: '' } : { at: at - 1, text: list[at - 1]! }
}

/** Ctrl+R: entries containing every word typed, ignoring case, keeping their order. */
export function filterHistory(list: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return list
  return list.filter(entry => { const t = entry.toLowerCase(); return words.every(w => t.includes(w)) })
}
