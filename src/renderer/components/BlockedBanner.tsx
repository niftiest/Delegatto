import { useEffect, useState } from 'react'

/** The permission bridge denies a parked request after this long (mirrors
 *  DEFAULT_TIMEOUT_MS in permission-bridge.ts) -- the banner counts down to it. */
const PARK_TIMEOUT_MS = 10 * 60 * 1000

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
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const remaining = arrivedAt === null ? null : Math.max(0, PARK_TIMEOUT_MS - (now - arrivedAt))
  const countdown = remaining === null ? null
    : `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')} left`

  return (
    <div className="blocked-bar" role="alert">
      <span className="blocked-dot" aria-hidden="true">●</span>
      <span className="blocked-msg"><b>{channelName}</b> is waiting</span>
      <span className="blocked-tool">{tool}</span>
      {countdown && <span className="blocked-count">{countdown}</span>}
      <span className="blocked-actions">
        <button type="button" className="blocked-review" onClick={onReview}>Review</button>
        <button type="button" className="blocked-deny" onClick={onDeny}>Deny</button>
        <button type="button" className="blocked-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>✕</button>
      </span>
    </div>
  )
}
