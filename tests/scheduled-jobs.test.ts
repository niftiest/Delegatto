import { describe, expect, it } from 'vitest'
import { parseEvent } from '../src/main/engine/events'
import { SessionPool, type TransportLike } from '../src/main/engine/pool'
import { ScheduledJobs, nextCronRun, parseCronList } from '../src/main/engine/scheduled-jobs'
import { backgroundTaskLabel } from '../src/renderer/lib'
import type { LiveEvent } from '../src/shared/engine-types'
import type { SpawnSpec } from '../src/main/engine/transport'

// Tool calls and results recorded from Claude Code 2.1.332 in a headless session.
const CREATE_RECURRING = { type: 'tool_use', id: 't1', name: 'CronCreate', input: { cron: '7,37 * * * *', prompt: 'say tick', recurring: true } }
const CREATE_RECURRING_RESULT = 'Scheduled recurring job 2781e439 (7,37 * * * *). Next run: Nov 27 11:39pm. Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.'
const CREATE_ONCE = { type: 'tool_use', id: 't2', name: 'CronCreate', input: { cron: '36 1 28 11 *', prompt: 'say once', recurring: false } }
const CREATE_ONCE_RESULT = 'Scheduled one-shot task ad93d99d (36 1 28 11 *). Next run: Nov 28 1:36am. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.'
const LIST_RESULT = '2781e439 — 7,37 * * * * (recurring) [session-only], next run Nov 27 11:39pm: say tick\nad93d99d — 36 1 28 11 * (one-shot) [session-only], next run Nov 28 1:36am: say once'
const DELETE = { type: 'tool_use', id: 't3', name: 'CronDelete', input: { id: '2781e439' } }

const at = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo - 1, d, h, mi).getTime()

describe('when a cron runs next', () => {
  it('reads lists, ranges, steps and stars, in local time', () => {
    expect(nextCronRun('7,37 * * * *', at(2026, 11, 27, 23, 36))).toBe(at(2026, 11, 27, 23, 37))
    expect(nextCronRun('7,37 * * * *', at(2026, 11, 27, 23, 37))).toBe(at(2026, 11, 28, 0, 7))
    expect(nextCronRun('*/15 9-17 * * *', at(2026, 11, 27, 17, 50))).toBe(at(2026, 11, 28, 9, 0))
    expect(nextCronRun('36 1 28 11 *', at(2026, 11, 27, 23, 36))).toBe(at(2026, 11, 28, 1, 36))
    expect(nextCronRun('0 9 * * 1', at(2026, 11, 27, 12, 0))).toBe(at(2026, 11, 30, 9, 0)) // the next Monday
    expect(nextCronRun('not a cron', 0)).toBeNull()
  })
})

describe('scheduled jobs from Claude\'s tool calls', () => {
  it('adds a job once its result names it, and drops it when cancelled', () => {
    const jobs = new ScheduledJobs(() => at(2026, 11, 27, 23, 36))
    jobs.onToolUse([CREATE_RECURRING])
    expect(jobs.list()).toEqual([]) // not until the result says it was scheduled
    expect(jobs.onToolResult('t1', CREATE_RECURRING_RESULT, false)).toBe(true)
    expect(jobs.list()).toMatchObject([{ id: 'cron:2781e439', type: 'scheduled', description: 'say tick', schedule: { recurring: true, nextRun: at(2026, 11, 27, 23, 37) } }])
    jobs.onToolUse([DELETE])
    expect(jobs.onToolResult('t3', 'Cancelled job 2781e439.', false)).toBe(true)
    expect(jobs.list()).toEqual([])
  })

  it('ignores a call that failed', () => {
    const jobs = new ScheduledJobs()
    jobs.onToolUse([CREATE_RECURRING])
    expect(jobs.onToolResult('t1', 'Invalid cron expression', true)).toBe(false)
    expect(jobs.list()).toEqual([])
  })

  it("takes CronList's answer as the whole list", () => {
    expect(parseCronList(LIST_RESULT, 0)?.map(j => [j.id, j.recurring, j.prompt])).toEqual([['2781e439', true, 'say tick'], ['ad93d99d', false, 'say once']])
    const jobs = new ScheduledJobs()
    jobs.onToolUse([{ type: 'tool_use', id: 'l1', name: 'CronList', input: {} }])
    jobs.onToolResult('l1', LIST_RESULT, false)
    expect(jobs.list().map(t => t.id)).toEqual(['cron:2781e439', 'cron:ad93d99d'])
  })

  it('drops a one-time job once it fires, but keeps a repeating one', () => {
    const jobs = new ScheduledJobs()
    jobs.onToolUse([CREATE_RECURRING, CREATE_ONCE])
    jobs.onToolResult('t1', CREATE_RECURRING_RESULT, false)
    jobs.onToolResult('t2', CREATE_ONCE_RESULT, false)
    expect(jobs.onFire('Scheduled task fired: say once')).toBe(true)
    expect(jobs.list().map(t => t.description)).toEqual(['say tick'])
  })

  it("keeps /loop's next wake-up until its time has passed", () => {
    let now = 1_000_000
    const jobs = new ScheduledJobs(() => now)
    jobs.onToolUse([{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 1200, prompt: '<<autonomous-loop-dynamic>>', reason: 'x' } }])
    expect(jobs.list()).toMatchObject([{ description: '/loop', schedule: { recurring: false, nextRun: 1_000_000 + 1_200_000 } }])
    now += 1_200_000 + 61_000
    expect(jobs.list()).toEqual([])
  })

  it('names the job, says whether it repeats, and when it runs next', () => {
    const now = at(2026, 11, 27, 23, 36)
    const label = backgroundTaskLabel({ id: 'cron:1', type: 'scheduled', description: 'say tick', agent: null, startedAt: now, lastTool: null, tokens: null, schedule: { recurring: true, nextRun: at(2026, 11, 27, 23, 37) } }, now)
    expect(label.title).toBe('Scheduled: say tick')
    expect(label.details[0]).toBe('repeats')
    expect(label.details[1]).toMatch(/^next 11:37/)
  })
})

describe('reading the stream', () => {
  const parsed = (o: object): LiveEvent => parseEvent(JSON.stringify(o))!
  it('reads tool results, a fired job, and ambient or off-host tasks', () => {
    expect(parsed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: CREATE_RECURRING_RESULT }] } }))
      .toEqual({ kind: 'toolResults', results: [{ toolUseId: 't1', text: CREATE_RECURRING_RESULT, isError: false }] })
    expect(parsed({ type: 'user', message: { role: 'user', content: 'hi' } })).toEqual({ kind: 'other', type: 'user' })
    expect(parsed({ type: 'system', subtype: 'scheduled_task_fire', content: 'say tick' })).toEqual({ kind: 'scheduledFire', content: 'say tick' })
    expect(parsed({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', task_type: 'monitor', description: 'm', ambient: true }, { task_id: 'b', task_type: 'remote_agent', description: 'r', off_host: true }] }))
      .toMatchObject({ kind: 'background', tasks: [{ id: 'a', ambient: true }, { id: 'b', offHost: true }] })
  })
})

describe('the pool keeps a chat with scheduled jobs open', () => {
  function setup() {
    let time = 1000
    let emit: (e: LiveEvent) => void = () => {}
    const spawned: Array<{ closed: boolean }> = []
    const factory = (): TransportLike => {
      const t = { closed: false }
      spawned.push(t)
      return { start() {}, send() {}, interrupt() {}, close() { t.closed = true }, on(cb) { emit = cb }, onExit() {} }
    }
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: () => time })
    const events: LiveEvent[] = []
    pool.on('k', e => events.push(e))
    return { pool, events, spawned, spec: { cwd: 'c' } as SpawnSpec, raw: (o: object) => emit(parseEvent(JSON.stringify(o))!), tick: (ms: number) => (time += ms) }
  }

  it("doesn't close an idle chat that has a scheduled job, then does once it's cancelled", () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.raw({ type: 'assistant', uuid: 'a1', message: { content: [CREATE_RECURRING] } })
    t.raw({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: CREATE_RECURRING_RESULT }] } })
    t.raw({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    expect(t.pool.backgroundTasks('k').map(x => x.type)).toEqual(['scheduled'])
    expect(t.events.some(e => e.kind === 'background' && e.tasks.length === 1)).toBe(true)
    t.pool.reapIdle(t.tick(10_000))
    expect(t.spawned[0]!.closed).toBe(false)
    expect(t.pool.releaseIdle('k')).toBe(false)
    t.raw({ type: 'assistant', uuid: 'a2', message: { content: [DELETE] } })
    t.raw({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Cancelled job 2781e439.' }] } })
    t.pool.reapIdle(t.tick(10_000))
    expect(t.spawned[0]!.closed).toBe(true)
  })

  it("lets an idle chat close when its only task is ambient housekeeping", () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.raw({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', task_type: 'monitor', description: 'watcher', ambient: true }] })
    t.raw({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    t.pool.reapIdle(t.tick(10_000))
    expect(t.spawned[0]!.closed).toBe(true)
  })
})
