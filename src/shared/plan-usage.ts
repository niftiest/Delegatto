/** How much of a Claude plan has been used, for the chat-list footer. Lives here
 *  because main keeps it and the renderer draws it. */

export interface PlanWindow {
  /** 0-100. Can pass 100: Claude lets some work run over a window's cap. */
  percent: number
  /** Epoch ms when the window starts over, if known. */
  resetsAt: number | null
}

export interface PlanUsage {
  /** 'max', 'pro', 'team', 'enterprise'; null on an API key or third-party provider. */
  plan: string | null
  /** False on an API key, Bedrock or Vertex; null until Claude Code has said. */
  limitsApply: boolean | null
  fiveHour: PlanWindow | null
  sevenDay: PlanWindow | null
  /** Past the plan's limits and drawing on extra usage. */
  usingExtra: boolean
  /** Epoch ms of the last reading of the windows. */
  updatedAt: number | null
}

export const NO_PLAN_USAGE: PlanUsage = { plan: null, limitsApply: null, fiveHour: null, sevenDay: null, usingExtra: false, updatedAt: null }

/** What a `rate_limit_event` adds, already on the 0-100 scale. */
export interface PlanReading {
  fiveHour?: PlanWindow
  sevenDay?: PlanWindow
  usingExtra?: boolean
}

/** A window whose reset time has passed has started over, whatever was last read. */
export function currentWindow(w: PlanWindow | null, now: number): PlanWindow | null {
  if (w === null) return null
  return w.resetsAt !== null && w.resetsAt <= now ? { percent: 0, resetsAt: null } : w
}

export function planLabel(plan: string | null): string {
  return plan === null || plan.length === 0 ? 'Plan usage' : `${plan[0]!.toUpperCase()}${plan.slice(1)} plan`
}

/** On a plan, show its limits. Readings count as proof even before Claude Code has said. */
export function showsPlan(u: PlanUsage): boolean {
  return u.limitsApply !== false && (u.plan !== null || u.fiveHour !== null || u.sevenDay !== null)
}

/** "8:30 PM" within the day, "Mon 4:00 PM" beyond it. */
export function formatReset(at: number, now: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`
}
