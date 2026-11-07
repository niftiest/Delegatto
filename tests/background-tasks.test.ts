import { describe, expect, it } from 'vitest'
import { parseEvent } from '../src/main/engine/events'
import { SessionPool, type TransportLike } from '../src/main/engine/pool'
import { backgroundTaskLabel } from '../src/renderer/lib'
import type { BackgroundTask, LiveEvent } from '../src/shared/engine-types'
import type { SpawnSpec } from '../src/main/engine/transport'

// Lines recorded from Claude Code 2.1.316 while a background agent ran.
const CHANGED = { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', run_id: 'r', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Run slow.py' }] }
const PROGRESS = { type: 'system', subtype: 'task_progress', task_id: 'a1', description: 'Running it', usage: { total_tokens: 21890, tool_uses: 1, duration_ms: 1618 }, last_tool_name: 'Bash' }
const EMPTY = { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
const INIT = { kind: 'init', sessionId: 's', cwd: 'c', model: 'm', permissionMode: 'default' } as LiveEvent
const parsed = (o: object): LiveEvent => parseEvent(JSON.stringify(o))!

describe('reading background tasks off the stream', () => {
  it('reads the task list and progress', () => {
    expect(parsed(CHANGED)).toEqual({ kind: 'background', tasks: [{ id: 'a1', type: 'local_agent', description: 'Run slow.py', agent: 'general-purpose', startedAt: 0, lastTool: null, tokens: null }] })
    expect(parsed(PROGRESS)).toEqual({ kind: 'taskProgress', taskId: 'a1', lastTool: 'Bash', tokens: 21890 })
  })

  it("doesn't take a subagent's words or tokens for Claude's own", () => {
    const content = [{ type: 'text', text: 'from the subagent' }]
    expect(parsed({ type: 'assistant', uuid: 'u', parent_tool_use_id: 'toolu_1', message: { content } }).kind).toBe('subagentStep')
    expect(parsed({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { content } }).kind).toBe('assistant')
    expect(parsed({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }).kind).toBe('other')
  })
})

function setup() {
  let time = 1000
  let emit: (e: LiveEvent) => void = () => {}
  const spawned: Array<{ closed: boolean; sent: number }> = []
  const factory = (): TransportLike => {
    const t = { closed: false, sent: 0 }
    spawned.push(t)
    return {
      start() {}, send() { t.sent++ }, interrupt() {}, close() { t.closed = true },
      on(cb) { emit = cb }, onExit() {}
    }
  }
  const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: () => time })
  const events: LiveEvent[] = []
  pool.on('k', e => events.push(e))
  const spec = { cwd: 'c' } as SpawnSpec
  const finishTurn = (): void => emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
  return { pool, events, spawned, spec, finishTurn, emit: (o: object) => emit(parsed(o)), raw: (e: LiveEvent) => emit(e), tick: (ms: number) => { time += ms; return time } }
}

describe('the pool and background work', () => {
  it('keeps when each task started as the list changes, and folds in progress', () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.emit(CHANGED)
    t.tick(50)
    t.emit(PROGRESS)
    t.emit(CHANGED)
    expect(t.pool.backgroundTasks('k')).toMatchObject([{ id: 'a1', startedAt: 1000, lastTool: 'Bash', tokens: 21890 }])
    expect(t.events[t.events.length - 1]).toMatchObject({ kind: 'background', tasks: [{ startedAt: 1000 }] })
    expect(t.events.some(e => e.kind === 'taskProgress')).toBe(false)
    t.emit(EMPTY)
    expect(t.pool.backgroundTasks('k')).toEqual([])
  })

  it("doesn't reap a process with background work, however quiet, then does once it's done", () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.emit(CHANGED)
    t.finishTurn()
    t.pool.reapIdle(t.tick(10_000))
    expect(t.spawned[0]!.closed).toBe(false)
    t.emit(EMPTY)
    t.pool.reapIdle(t.tick(10_000))
    expect(t.spawned[0]!.closed).toBe(true)
  })

  it("won't release or replace a process with background work", () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.emit(CHANGED)
    t.finishTurn()
    expect(t.pool.releaseIdle('k')).toBe(false)
    t.pool.send('k', { ...t.spec, model: 'other' } as SpawnSpec, {})
    expect(t.spawned).toHaveLength(1)
    expect(t.spawned[0]).toMatchObject({ closed: false, sent: 2 })
    expect(t.pool.restartForReload('k')).toBe('afterTurn')
  })

  it('counts a turn Claude Code starts by itself when a task finishes', () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.finishTurn()
    expect(t.pool.isTurnRunning('k')).toBe(false)
    const later = t.tick(500)
    t.raw(INIT)
    expect(t.pool.isTurnRunning('k')).toBe(true)
    expect(t.pool.turnInfo('k')).toMatchObject({ startedAt: later, tokens: 0 })
    t.finishTurn()
    expect(t.pool.isTurnRunning('k')).toBe(false)
  })

  it("doesn't restart the timer for the init of a turn already running", () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.tick(500)
    t.raw(INIT)
    expect(t.pool.turnInfo('k')?.startedAt).toBe(1000)
  })

  it('shows the count in the HUD snapshot', () => {
    const t = setup()
    t.pool.send('k', t.spec, {})
    t.emit(CHANGED)
    expect(t.pool.snapshot()[0]).toMatchObject({ background: 1 })
  })
})

describe('backgroundTaskLabel', () => {
  const base: BackgroundTask = { id: 'a', type: 'local_bash', description: 'Run slow.py', agent: null, startedAt: 0, lastTool: null, tokens: null }

  it('says what kind of work it is and how long it has taken', () => {
    expect(backgroundTaskLabel(base, 65_000)).toEqual({ title: 'Bash: Run slow.py', details: ['1m 5s'] })
  })

  it('adds an agent\'s latest step and tokens', () => {
    expect(backgroundTaskLabel({ ...base, type: 'local_agent', agent: 'Explore', lastTool: 'Grep', tokens: 21890 }, 3000))
      .toEqual({ title: 'Explore: Run slow.py', details: ['3s', 'Grep', '21.9k context'] })
  })

  it('copes with an unknown kind and no description', () => {
    expect(backgroundTaskLabel({ ...base, type: 'workflow', description: '' }, 0).title).toBe('workflow')
  })
})
