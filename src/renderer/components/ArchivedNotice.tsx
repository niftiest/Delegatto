import { resolveChannelName } from '../lib'
import type { ChannelRow } from '../../shared/types'

const SEEN_KEY = 'cc.archived.seen'
const NAMES_SHOWN = 5

/** Projects the user has already been told about. */
export function readArchivedSeen(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

export function writeArchivedSeen(dirNames: string[]): void {
  window.localStorage.setItem(SEEN_KEY, JSON.stringify(dirNames))
}

export function archivedNoticeText(names: string[]): string {
  const listed = names.slice(0, NAMES_SHOWN).join(', ')
  const more = names.length - NAMES_SHOWN
  const who = more > 0 ? `${listed} and ${more} more` : listed
  return names.length === 1
    ? `${who}'s folder was moved or deleted, so it's now under Archived at the bottom of the chat list. Its chats are kept to read.`
    : `The folders of ${who} were moved or deleted, so they're now under Archived at the bottom of the chat list. Their chats are kept to read.`
}

/** What the notice shows, and the projects to remember as told about, after the chat
 *  list changes. A project counts as told about as soon as it's on show, so the notice
 *  lasts this run at most (until dismissed) and never comes back at the next launch.
 *  `shown` is what's on show now; `seen` is what was remembered before. */
export function archivedNotice(archived: ChannelRow[], seen: string[], shown: ChannelRow[]): { shown: ChannelRow[]; seen: string[] } {
  const archivedDirs = new Set(archived.map(c => c.dirName))
  // A folder that came back is forgotten, so losing it again is news.
  const kept = seen.filter(d => archivedDirs.has(d))
  const fresh = archived.filter(c => !kept.includes(c.dirName))
  const stillShown = shown.filter(c => archivedDirs.has(c.dirName))
  const shownDirs = new Set(stillShown.map(c => c.dirName))
  return {
    shown: [...stillShown, ...fresh.filter(c => !shownDirs.has(c.dirName))],
    seen: [...kept, ...fresh.map(c => c.dirName)]
  }
}

/** One notice however many there are, and only for ones not mentioned before. */
export function ArchivedNotice({ projects, onShow, onDismiss }: { projects: ChannelRow[]; onShow: () => void; onDismiss: () => void }) {
  const names = projects.map(p => resolveChannelName(p.meta, p.cwd, p.dirName))
  return (
    <div className="update-bar" role="status">
      <span>{archivedNoticeText(names)}</span>
      <button type="button" className="update-bar-btn" onClick={onShow}>Show</button>
      <button type="button" className="update-bar-btn update-bar-btn-next" onClick={onDismiss}>Got it</button>
    </div>
  )
}
