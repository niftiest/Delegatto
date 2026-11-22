import { useEffect, useState } from 'react'

/** How long a request has waited: "just now", "4m", "1h 12m". It waits for an answer
 *  however long that takes, as in the terminal, so this counts up, never down. */
export function waitedFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** App-wide bar shown above the chat header when a chat OTHER than the open one
 *  is waiting on a permission decision (so it isn't missed). Review switches to
 *  that chat; Deny answers it in place; ✕ just dismisses the banner. */
export function BlockedBanner({ channelName, tool, arrivedAt, onReview, onDeny, onDismiss }: {
  channelName: string
  tool: string
  arrivedAt: number | null
  onReview: () => void
  onDeny: () => void
  onDismiss: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  const waited = arrivedAt === null ? null : waitedFor(Math.max(0, now - arrivedAt))

  return (
    <div className="blocked-bar" role="alert">
      <span className="blocked-dot" aria-hidden="true">●</span>
      <span className="blocked-msg"><b>{channelName}</b> is waiting</span>
      <span className="blocked-tool">{tool}</span>
      {waited !== null && (
        <span className="blocked-count" title="It waits for your answer however long that takes">
          {waited === 'just now' ? 'just now' : `for ${waited}`}
        </span>
      )}
      <span className="blocked-actions">
        <button type="button" className="blocked-review" onClick={onReview}>Review</button>
        <button type="button" className="blocked-deny" onClick={onDeny}>Deny</button>
        <button type="button" className="blocked-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>✕</button>
      </span>
    </div>
  )
}
