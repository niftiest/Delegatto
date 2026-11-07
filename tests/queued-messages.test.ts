import { describe, expect, it } from 'vitest'
import { parseEvent } from '../src/main/engine/events'
import { parseLine, isMessageRow, textOf, blocksOf } from '../src/main/jsonl/parse'
import type { MessageRow } from '../src/main/jsonl/rows'
import { buildRenderItems } from '../src/main/jsonl/render'
import { SessionPool, type TransportLike } from '../src/main/engine/pool'
import type { SpawnSpec } from '../src/main/engine/transport'
import { queueReducer, type QueuedMessage } from '../src/renderer/lib'
import { openCatalog } from '../src/main/catalog/db'
import { MIGRATIONS } from '../src/main/catalog/schema'

// Shape recorded from a real transcript, Claude Code 2.1.316.
const attachment = (attachment: object, extra: object = {}): string => JSON.stringify({
  parentUuid: 'p1', isSidechain: false, type: 'attachment', uuid: 'q1', timestamp: '2026-11-01T07:52:20.115Z',
  attachment: { type: 'queued_command', source_uuid: 's1', origin: { kind: 'human' }, humanTurn: true, ...attachment }, ...extra
})

describe('a message sent while Claude was working', () => {
  it('reads as a user message, with the text as typed', () => {
    const row = parseLine(attachment({ commandMode: 'prompt', prompt: 'also do this' }))!
    expect(isMessageRow(row)).toBe(true)
    expect(textOf(row as MessageRow)).toBe('also do this')
    expect(buildRenderItems([row as MessageRow])).toEqual([expect.objectContaining({ kind: 'text', role: 'user', text: 'also do this', uuid: 'q1' })])
  })

  it('keeps its images', () => {
    const prompt = [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]
    const row = parseLine(attachment({ commandMode: 'prompt', prompt }))! as MessageRow
    expect(blocksOf(row).map(b => b.type)).toEqual(['text', 'image'])
  })

  it('leaves background-task pings and other attachments alone', () => {
    expect(parseLine(attachment({ commandMode: 'task-notification', prompt: '<task-notification/>' }))!.type).toBe('attachment')
    expect(parseLine(JSON.stringify({ type: 'attachment', uuid: 'x', attachment: { type: 'todo' } }))!.type).toBe('attachment')
    expect(parseLine(attachment({ commandMode: 'prompt' }))!.type).toBe('attachment')
    expect(parseLine(attachment({ commandMode: 'prompt', prompt: 'hi' }, { uuid: undefined }))!.type).toBe('attachment')
  })

  it("doesn't take a hidden message, or one from another session, for the person's", () => {
    expect(parseLine(attachment({ commandMode: 'prompt', prompt: 'hi', isMeta: true }))!.type).toBe('attachment')
    expect(parseLine(attachment({ commandMode: 'prompt', prompt: 'hi', origin: { kind: 'peer' } }))!.type).toBe('attachment')
    expect(parseLine(attachment({ commandMode: 'prompt', prompt: 'hi', origin: undefined }))!.type).toBe('user')
  })

  it('gets older chats re-read when the app updates', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO projects (dir_name) VALUES ('C--x')").run()
    db.prepare("INSERT INTO sessions (project_id, session_id, kind, file_path, file_size, file_mtime_ms, indexed_offset) VALUES (1, 's', 'main', '/f', 100, 1, 100)").run()
    MIGRATIONS.find(m => m.toVersion === 7)!.apply(db)
    const { indexed_offset } = db.prepare('SELECT indexed_offset FROM sessions').get() as { indexed_offset: number }
    expect(indexed_offset).toBeGreaterThan(100)
  })
})

describe('reading what became of a queued message', () => {
  it('reads each state', () => {
    expect(parseEvent(JSON.stringify({ type: 'command_lifecycle', command_uuid: 'u', state: 'started', uuid: 'frame', session_id: 's' })))
      .toEqual({ kind: 'commandLifecycle', uuid: 'u', state: 'started' })
  })
  it('ignores a frame with no message named', () => {
    expect(parseEvent(JSON.stringify({ type: 'command_lifecycle', state: 'started' }))).toEqual({ kind: 'other', type: 'command_lifecycle' })
  })
})

describe('the queue', () => {
  const a: QueuedMessage = { id: 'a', text: 'a', images: [], uuid: 'ua' }
  const b: QueuedMessage = { id: 'b', text: 'b', images: [], uuid: 'ub' }
  const held: QueuedMessage = { id: 'c', text: '/compact', images: [], uuid: null }

  it('drops a message when Claude Code takes it in, and only that one', () => {
    expect(queueReducer([a, b, held], { type: 'removeUuid', uuid: 'ua' })).toEqual([b, held])
  })
  it('holds everything when the process that had them dies', () => {
    expect(queueReducer([a, held], { type: 'holdAll' }).map(m => m.uuid)).toEqual([null, null])
  })
  it('can be replaced outright after a reorder', () => {
    expect(queueReducer([a], { type: 'set', items: [b, a] })).toEqual([b, a])
  })
})

describe('a chat process', () => {
  const start = () => {
    const calls: unknown[][] = []
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: (): TransportLike => ({
      start() {}, send() {}, interrupt() {}, close() {}, on() {}, onExit() {},
      request: (...args: unknown[]) => { calls.push(args); return Promise.resolve({}) }
    }) })
    pool.send('k', { cwd: 'c' } as SpawnSpec, {})
    return { pool, calls }
  }
  it('declares it can stop tasks one by one, so Esc spares background agents', () => {
    expect(start().calls[0]!.slice(0, 2)).toEqual(['initialize', { perTaskStopAffordance: true }])
  })
  it('stops one background task on request', () => {
    const t = start()
    t.pool.stopTask('k', 'task1')
    expect(t.calls.at(-1)!.slice(0, 2)).toEqual(['stop_task', { task_id: 'task1' }])
  })
  it('copes with stopping a task in a chat with no process', () => {
    expect(() => start().pool.stopTask('nothing', 'task1')).not.toThrow()
  })
})

describe('taking a message back', () => {
  function setup(answer: unknown = { cancelled: true }) {
    const calls: unknown[][] = []
    const factory = (): TransportLike => ({
      start() {}, send() {}, interrupt() {}, close() {}, on() {}, onExit() {},
      request: (...args: unknown[]) => { calls.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) }
    })
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })
    return { pool, calls, spec: { cwd: 'c' } as SpawnSpec }
  }

  it('asks the process, and reports what it said', async () => {
    const t = setup({ cancelled: true })
    t.pool.send('k', t.spec, {})
    expect(await t.pool.withdraw('k', 'u1')).toBe(true)
    expect(t.calls.at(-1)!.slice(0, 2)).toEqual(['cancel_async_message', { message_uuid: 'u1' }])
    const late = setup({ cancelled: false })
    late.pool.send('k', late.spec, {})
    expect(await late.pool.withdraw('k', 'u1')).toBe(false)
  })

  it('counts no answer as too late, so nothing is sent twice', async () => {
    const t = setup(new Error('no answer'))
    t.pool.send('k', t.spec, {})
    expect(await t.pool.withdraw('k', 'u1')).toBe(false)
  })

  it('is free when no process holds it', async () => {
    expect(await setup().pool.withdraw('nothing', 'u1')).toBe(true)
  })
})
