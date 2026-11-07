import { readFileSync, writeFileSync } from 'node:fs'
import { NO_PLAN_USAGE, type PlanReading, type PlanUsage, type PlanWindow } from '../../shared/plan-usage'

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A window in `get_usage`'s form: percent 0-100, ISO reset time. */
function usageWindow(raw: unknown): PlanWindow | null {
  if (!isObj(raw) || typeof raw.utilization !== 'number') return null
  const at = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN
  return { percent: raw.utilization, resetsAt: Number.isNaN(at) ? null : at }
}

/** What Claude Code has said about the account and its limits. Every reply brings
 *  a fresh reading; a brief process at launch supplies the plan and, when the usage
 *  endpoint answers, the windows. The last reading is saved, since the endpoint
 *  doesn't always answer and the next reply may be a while off. */
export class PlanUsageTracker {
  private usage: PlanUsage
  private readonly listeners: Array<(u: PlanUsage) => void> = []

  constructor(private readonly file: string | null, private readonly now: () => number = Date.now) {
    this.usage = file === null ? NO_PLAN_USAGE : load(file)
  }

  get(): PlanUsage { return this.usage }

  onChange(cb: (u: PlanUsage) => void): void { this.listeners.push(cb) }

  /** From a reply's `rate_limit_event`. */
  applyReading(r: PlanReading): void {
    if (r.fiveHour === undefined && r.sevenDay === undefined && r.usingExtra === undefined) return
    this.set({
      ...this.usage,
      limitsApply: true,
      fiveHour: r.fiveHour ?? this.usage.fiveHour,
      sevenDay: r.sevenDay ?? this.usage.sevenDay,
      usingExtra: r.usingExtra ?? this.usage.usingExtra,
      updatedAt: r.fiveHour !== undefined || r.sevenDay !== undefined ? this.now() : this.usage.updatedAt
    })
  }

  /** From a `get_usage` answer. `rate_limits` can be null even on a plan, so that
   *  leaves earlier readings alone; only "limits don't apply" clears them. */
  applyAnswer(raw: unknown): void {
    if (!isObj(raw)) return
    const plan = typeof raw.subscription_type === 'string' && raw.subscription_type.length > 0 ? raw.subscription_type : null
    if (raw.rate_limits_available === false) {
      this.set({ ...NO_PLAN_USAGE, plan, limitsApply: false })
      return
    }
    const limits = isObj(raw.rate_limits) ? raw.rate_limits : {}
    const fiveHour = usageWindow(limits.five_hour)
    const sevenDay = usageWindow(limits.seven_day)
    this.set({
      ...this.usage,
      plan,
      limitsApply: raw.rate_limits_available === true ? true : this.usage.limitsApply,
      fiveHour: fiveHour ?? this.usage.fiveHour,
      sevenDay: sevenDay ?? this.usage.sevenDay,
      updatedAt: fiveHour !== null || sevenDay !== null ? this.now() : this.usage.updatedAt
    })
  }

  private set(next: PlanUsage): void {
    this.usage = next
    if (this.file !== null) {
      try { writeFileSync(this.file, JSON.stringify(next)) } catch (err) { console.warn('[plan-usage] could not save', err) }
    }
    for (const cb of this.listeners) cb(next)
  }
}

function load(file: string): PlanUsage {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObj(saved) ? { ...NO_PLAN_USAGE, ...saved } : NO_PLAN_USAGE
  } catch {
    return NO_PLAN_USAGE
  }
}
