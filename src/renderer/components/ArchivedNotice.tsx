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

/** One notice however many there are, and only for ones not mentioned before. */
export function ArchivedNotice({ projects, onDismiss }: { projects: ChannelRow[]; onDismiss: () => void }) {
  const names = projects.map(p => resolveChannelName(p.meta, p.cwd, p.dirName))
  return (
    <div className="update-bar" role="status">
      <span>{archivedNoticeText(names)}</span>
      <button type="button" className="update-bar-x" aria-label="Dismiss" title="Got it" onClick={onDismiss}>✕</button>
    </div>
  )
}
