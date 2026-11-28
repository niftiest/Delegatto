import type { BackgroundTask } from '../../shared/engine-types'

/** Jobs Claude scheduled in a chat with CronCreate (and `/loop`'s ScheduleWakeup). Claude Code
 *  doesn't list them to hosts: they're read off Claude's own tool calls and their results, and
 *  CronList's answer replaces the lot. They're session-only ("dies when Claude exits"), which is
 *  why a chat holding one isn't closed for being idle. */

export type ScheduledJob = {
  id: string
  prompt: string
  /** Five-field cron in local time, or null for a one-time wake-up at `at`. */
  cron: string | null
  recurring: boolean
  /** Epoch ms of a one-time wake-up, when that's all there is. */
  at: number | null
  createdAt: number
}

type Pending = { name: string; input: Record<string, unknown> }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One cron field matched against a value: `*`, lists, ranges and steps. */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some(part => {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return false
    let lo: number, hi: number
    if (range === '*') { lo = min; hi = max } else if (range!.includes('-')) {
      const [a, b] = range!.split('-').map(Number); lo = a!; hi = b!
    } else { lo = Number(range); hi = stepText === undefined ? lo : max }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false
    return value >= lo && value <= hi && (value - lo) % step === 0
  })
}

/** The next time, after `from`, a five-field cron runs in local time, within ~32 days; else null. */
export function nextCronRun(expr: string, from: number): number | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return null
  const [mi, ho, dom, mon, dow] = f as [string, string, string, string, string]
  const t = new Date(from)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  for (let i = 0; i < 60 * 24 * 32; i++) {
    const day = t.getDay()
    const domOk = fieldMatches(dom, t.getDate(), 1, 31)
    const dowOk = fieldMatches(dow, day, 0, 7) || (day === 0 && fieldMatches(dow, 7, 0, 7))
    // Cron's rule: with both day fields restricted, either may match.
    const dayOk = dom !== '*' && dow !== '*' ? domOk || dowOk : domOk && dowOk
    if (fieldMatches(mi, t.getMinutes(), 0, 59) && fieldMatches(ho, t.getHours(), 0, 23) && dayOk && fieldMatches(mon, t.getMonth() + 1, 1, 12)) return t.getTime()
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}

/** CronList's lines: `2781e439 — 7,37 * * * * (recurring) [session-only], next run …: say tick`. */
export function parseCronList(text: string, now: number): ScheduledJob[] | null {
  if (/no (scheduled|cron) (jobs|tasks)|no jobs/i.test(text)) return []
  const jobs: ScheduledJob[] = []
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{6,})\s+[—-]\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\((recurring|one-shot)\)(.*)$/.exec(line.trim())
    if (m === null) continue
    // The prompt follows the next-run time ("next run Nov 27 11:39pm: say tick"), whose own colon isn't the end.
    const rest = m[4]!
    const after = /next run\b.*?\d{1,2}:\d{2}\s*(?:[ap]m)?:\s/i.exec(rest) ?? /:\s/.exec(rest)
    const prompt = after === null ? '' : rest.slice(after.index + after[0].length).trim()
    jobs.push({ id: m[1]!, cron: m[2]!, recurring: m[3] === 'recurring', prompt, at: null, createdAt: now })
  }
  return jobs.length > 0 ? jobs : null
}

export class ScheduledJobs {
  private jobs: ScheduledJob[] = []
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Claude's tool calls, from one of its messages. True when the list changed. */
  onToolUse(blocks: readonly unknown[]): boolean {
    let changed = false
    for (const b of blocks) {
      if (!isObj(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
      const input = isObj(b.input) ? b.input : {}
      if (b.name === 'CronCreate' || b.name === 'CronDelete' || b.name === 'CronList') this.pending.set(b.id, { name: b.name, input })
      if (b.name === 'ScheduleWakeup') {
        // `/loop`'s next wake-up replaces the last one; `stop` ends the loop.
        this.jobs = this.jobs.filter(j => !j.id.startsWith('wakeup:'))
        const delay = typeof input.delaySeconds === 'number' ? input.delaySeconds : NaN
        if (input.stop !== true && Number.isFinite(delay) && delay > 0) {
          const prompt = typeof input.prompt === 'string' ? input.prompt : ''
          this.jobs.push({ id: `wakeup:${b.id}`, prompt: prompt === '<<autonomous-loop-dynamic>>' ? '/loop' : prompt, cron: null, recurring: false, at: this.now() + delay * 1000, createdAt: this.now() })
        }
        changed = true
      }
    }
    return changed
  }

  /** A tool's result. True when the list changed. */
  onToolResult(toolUseId: string, text: string, isError: boolean): boolean {
    const call = this.pending.get(toolUseId)
    if (call === undefined) return false
    this.pending.delete(toolUseId)
    if (isError) return false
    if (call.name === 'CronCreate') {
      const id = /\b(?:job|task)\s+([0-9a-f]{6,})\b/i.exec(text)?.[1]
      const cron = typeof call.input.cron === 'string' ? call.input.cron : null
      if (id === undefined || cron === null) return false
      this.jobs = this.jobs.filter(j => j.id !== id)
      this.jobs.push({ id, cron, recurring: call.input.recurring !== false, prompt: typeof call.input.prompt === 'string' ? call.input.prompt : '', at: null, createdAt: this.now() })
      return true
    }
    if (call.name === 'CronDelete') {
      const id = typeof call.input.id === 'string' ? call.input.id : null
      if (id === null || !/cancel|delet|remov/i.test(text)) return false
      const before = this.jobs.length
      this.jobs = this.jobs.filter(j => j.id !== id)
      return this.jobs.length !== before
    }
    const listed = parseCronList(text, this.now())
    if (listed === null) return false
    this.jobs = [...this.jobs.filter(j => j.id.startsWith('wakeup:')), ...listed.map(j => this.jobs.find(k => k.id === j.id) ?? j)]
    return true
  }

  /** A job fired (`scheduled_task_fire`): a one-time job whose prompt it names is done. */
  onFire(content: string): boolean {
    const before = this.jobs.length
    const once = this.jobs.filter(j => !j.recurring && j.cron !== null && j.prompt.length > 0 && content.includes(j.prompt))
    if (once.length > 0) this.jobs = this.jobs.filter(j => j !== once[0])
    return this.jobs.length !== before
  }

  /** The jobs still to run, as background tasks for the chat's task line. */
  list(): BackgroundTask[] {
    const now = this.now()
    // A wake-up whose time has passed has fired; Claude schedules the next if the loop goes on.
    this.jobs = this.jobs.filter(j => j.at === null || j.at > now - 60_000)
    return this.jobs.map(j => ({
      id: j.id.startsWith('wakeup:') ? j.id : `cron:${j.id}`,
      type: 'scheduled',
      description: j.prompt,
      agent: null,
      startedAt: j.createdAt,
      lastTool: null,
      tokens: null,
      schedule: { recurring: j.recurring, nextRun: j.at ?? (j.cron === null ? null : nextCronRun(j.cron, now)) }
    }))
  }
}
