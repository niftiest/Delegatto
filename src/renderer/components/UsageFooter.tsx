import { useEffect, useState } from 'react'
import type { SessionSummary } from '../../shared/types'
import { costOfSession, formatCost } from '../../shared/models'
import { currentWindow, formatReset, planLabel, showsPlan, type PlanUsage, type PlanWindow } from '../../shared/plan-usage'

const WARN_PERCENT = 80
const TICK_MS = 60_000

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function WindowRow({ label, window: w, now }: { label: string; window: PlanWindow; now: number }) {
  const level = w.percent >= 100 ? ' full' : w.percent >= WARN_PERCENT ? ' warn' : ''
  return (
    <div className={`usage-window${level}`}>
      <div className="usage-window-text">
        <span>{label} <span className="usage-window-pct">{Math.round(w.percent)}%</span></span>
        {w.resetsAt !== null && <span className="usage-window-reset">resets {formatReset(w.resetsAt, now)}</span>}
      </div>
      <div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.min(100, w.percent)}%` }} /></div>
    </div>
  )
}

/** On a plan, how much of its limits is used. Otherwise each token is paid for, so
 *  it's what the open chat has used and what that costs. */
export function UsageFooter({ usage, session }: { usage: PlanUsage; session: SessionSummary | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])
  // The readings arrive with replies, so the clock has to catch up with them too.
  useEffect(() => setNow(Date.now()), [usage])

  if (showsPlan(usage)) {
    const fiveHour = currentWindow(usage.fiveHour, now)
    const sevenDay = currentWindow(usage.sevenDay, now)
    return (
      <>
        <div className="usage-head">
          {planLabel(usage.plan)}
          {usage.usingExtra && <span className="usage-extra"> · extra usage</span>}
        </div>
        {fiveHour !== null && <WindowRow label="5-hour" window={fiveHour} now={now} />}
        {sevenDay !== null && <WindowRow label="Week" window={sevenDay} now={now} />}
        {fiveHour === null && sevenDay === null && <div className="nav-foot-sub">Usage shows after the next reply</div>}
      </>
    )
  }
  if (session === null) return <div className="nav-foot-sub">Open a chat to see its tokens and cost</div>
  const tokens = { inputTokens: session.inputTokens, outputTokens: session.outputTokens, cacheRead: session.cacheRead, cacheWrite: session.cacheWrite }
  return (
    <>
      <div className="usage-head" title="Estimated list-price cost of this chat's token usage">This chat · {formatCost(costOfSession(session.model, tokens))}</div>
      <div className="nav-foot-sub" title={`Cache: ${compact(session.cacheRead)} read, ${compact(session.cacheWrite)} written`}>
        {compact(session.inputTokens)} in · {compact(session.outputTokens)} out · {compact(session.cacheRead + session.cacheWrite)} cache
      </div>
    </>
  )
}
