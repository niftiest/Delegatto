import type { RenderItem } from '../shared/types'

/** Claude Code's note that a usage or spend limit stopped a reply, such as "You've hit your
 *  monthly spend limit · …" or "You've hit your 5-hour limit · resets 2pm". */
export function isLimitNotice(item: RenderItem): boolean {
  return item.kind === 'notice' && /^you['’]ve hit your\b[^\n·]*\blimit\b/i.test(item.text.trim())
}

/** Drops limit notices that are known to be over: a reply came after them in this chat, or
 *  some chat got a reply after they were written (`clearedAt`, epoch ms). A limit hit
 *  again writes a new notice, newer than both, which shows. */
export function hideClearedLimitNotices(items: RenderItem[], clearedAt: number | null): RenderItem[] {
  if (!items.some(isLimitNotice)) return items
  let replyAfter = false
  const keep: boolean[] = new Array(items.length)
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (isLimitNotice(it)) {
      const ts = it.kind === 'notice' && it.ts !== null ? Date.parse(it.ts) : NaN
      keep[i] = !replyAfter && !(clearedAt !== null && Number.isFinite(ts) && ts < clearedAt)
      continue
    }
    keep[i] = true
    // Claude's own words or work. Not a `!` command's output, or a slash command's: neither needs the API.
    const fromClaude = it.kind === 'text' ? it.role === 'assistant' && it.literal !== true && it.command === undefined : it.kind === 'tool' || it.kind === 'thinking'
    if (fromClaude) replyAfter = true
  }
  return items.filter((_, i) => keep[i])
}

const KEY = 'cc.limitClearedAt'
const listeners = new Set<() => void>()

/** When a chat last got a real reply from Claude, so limit notices written before then are
 *  over in every chat. Kept in localStorage, which every window of the app shares. */
export const limitCleared = {
  get(): number | null {
    const n = Number(window.localStorage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  },
  mark(at: number = Date.now()): void {
    const prev = limitCleared.get()
    if (prev !== null && prev >= at) return
    window.localStorage.setItem(KEY, String(at))
    for (const l of listeners) l()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    // Another window marked it.
    const onStorage = (e: StorageEvent): void => { if (e.key === KEY) listener() }
    window.addEventListener('storage', onStorage)
    return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
  }
}
