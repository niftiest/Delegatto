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
   *  leaves earlier readings alone; only "limits don't apply" clears them.
   *  `displayName` is the plan's own name ("Ultra"), which `subscription_type` lacks:
   *  it has only pro, max, team and enterprise. Used only on a plan, as Claude Code does. */
  applyAnswer(raw: unknown, displayName: string | null = null): boolean {
    if (!isObj(raw)) return false
    const type = typeof raw.subscription_type === 'string' && raw.subscription_type.length > 0 ? raw.subscription_type : null
    const plan = type === null ? null : displayName ?? type
    // Off a plan (an API key, Bedrock, Vertex) limits don't apply. On a plan, "unavailable"
    // only means this login can't read them (a token without the profile scope): the
    // plan still has limits, and every reply still reports them.
    if (raw.rate_limits_available === false && type === null) {
      this.set({ ...NO_PLAN_USAGE, plan, limitsApply: false })
      return false
    }
    const limits = isObj(raw.rate_limits) ? raw.rate_limits : {}
    const fiveHour = usageWindow(limits.five_hour)
    const sevenDay = usageWindow(limits.seven_day)
    this.set({
      ...this.usage,
      plan,
      limitsApply: raw.rate_limits_available === true || type !== null ? true : this.usage.limitsApply,
      fiveHour: fiveHour ?? this.usage.fiveHour,
      sevenDay: sevenDay ?? this.usage.sevenDay,
      updatedAt: fiveHour !== null || sevenDay !== null ? this.now() : this.usage.updatedAt
    })
    return fiveHour !== null || sevenDay !== null
  }

  /** What one `get_usage` answer said, for the log: why there were no windows, if there weren't. */
  static describe(raw: unknown): string {
    if (!isObj(raw)) return 'no answer'
    const plan = typeof raw.subscription_type === 'string' ? raw.subscription_type : 'none'
    if (raw.rate_limits_available === false) return `plan ${plan}; this login can't read its limits`
    if (!isObj(raw.rate_limits)) return `plan ${plan}; the usage service didn't answer`
    const l = raw.rate_limits
    return `plan ${plan}; 5-hour ${usageWindow(l.five_hour)?.percent ?? 'none'}, week ${usageWindow(l.seven_day)?.percent ?? 'none'}`
  }

  private set(next: PlanUsage): void {
    this.usage = next
    if (this.file !== null) {
      try { writeFileSync(this.file, JSON.stringify(next)) } catch (err) { console.warn('[plan-usage] could not save', err) }
    }
    for (const cb of this.listeners) cb(next)
  }
}

/** How often the plan's usage is read again while the app runs, so use elsewhere (the
 *  terminal, another PC, claude.ai) shows without starting a chat. */
export const PLAN_REFRESH_MS = 10 * 60_000
/** After a check that got no windows: sooner at first, then the usual pace. */
const PLAN_RETRY_MS = [30_000, 2 * 60_000, 5 * 60_000]

/** When to read the plan's usage next, after a check that did (`got`) or didn't get its windows.
 *  `misses` counts the checks in a row that didn't, this one included. */
export function nextPlanCheck(got: boolean, misses: number): number {
  return got ? PLAN_REFRESH_MS : PLAN_RETRY_MS[misses - 1] ?? PLAN_REFRESH_MS
}

/** The plan's name as Claude Code shows it, from the account it keeps in
 *  `.claude.json` (`oauthAccount.planDisplayName`), or null. Read only. */
export function planDisplayName(claudeJson: string | null): string | null {
  if (claudeJson === null) return null
  let root: unknown
  try { root = JSON.parse(claudeJson) } catch { return null }
  const account = isObj(root) && isObj(root.oauthAccount) ? root.oauthAccount : null
  const name = typeof account?.planDisplayName === 'string' ? account.planDisplayName.trim() : ''
  return name.length > 0 && name.length <= 40 ? name : null
}

function load(file: string): PlanUsage {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObj(saved) ? { ...NO_PLAN_USAGE, ...saved } : NO_PLAN_USAGE
  } catch {
    return NO_PLAN_USAGE
  }
}
