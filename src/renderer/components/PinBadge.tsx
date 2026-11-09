import { createContext, useContext } from 'react'

/** The open chat's pinned messages, by uuid, for the messages to mark themselves. */
export const PinnedMessages = createContext<ReadonlySet<string>>(new Set())

/** A pin, as an icon. The context rail uses it too. */
export function PinIcon({ size = 15 }: { size?: number }) {
  return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true"><path fill="currentColor" d="M9.8 1.3a.8.8 0 0 1 1.1 0l3.8 3.8a.8.8 0 0 1 0 1.1l-.5.5a1.5 1.5 0 0 1-1.6.3l-2.3 2.7.2 2.3a.8.8 0 0 1-.2.6l-.6.6a.8.8 0 0 1-1.1 0L6.2 10.4l-3.7 3.7-.6-.6 3.7-3.7L3.2 7.4a.8.8 0 0 1 0-1.1l.6-.6a.8.8 0 0 1 .6-.2l2.3.2 2.7-2.3a1.5 1.5 0 0 1 .3-1.6z" /></svg>
}

/** A small round pin at a pinned message's top right corner. Nothing for any other message. */
export function PinBadge({ uuid }: { uuid: string | undefined }) {
  const pinned = useContext(PinnedMessages)
  if (uuid === undefined || !pinned.has(uuid)) return null
  return <span className="pin-badge" title="Pinned" role="img" aria-label="Pinned"><PinIcon size={11} /></span>
}

