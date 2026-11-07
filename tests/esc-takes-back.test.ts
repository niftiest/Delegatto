import { describe, it, expect } from 'vitest'
import { ComposeStore } from '../src/renderer/compose-store'
import { dropCancelledMessage, type ComposerImage } from '../src/renderer/lib'
import { rewoundUuids } from '../src/main/jsonl/rewound'
import { SessionPool, type TransportLike } from '../src/main/engine/pool'
import type { SpawnSpec } from '../src/main/engine/transport'
import type { LiveEvent } from '../src/shared/engine-types'
import type { RawRow } from '../src/main/jsonl/rows'
import type { RenderItem } from '../src/shared/types'

const image = { id: 'i', name: 'a.png', mediaType: 'image/png', dataBase64: 'x' } as unknown as ComposerImage
const result = { kind: 'result', isError: false, costUsd: 0, text: '', interrupted: true } as LiveEvent

function setup() {
  const store = new ComposeStore()
  const event = (ev: LiveEvent, pk = 1): void => { store.handleEvent(pk, ev, () => {}) }
  return { store, event }
}

describe('Esc before Claude has replied', () => {
  it('offers the message back once the turn has stopped', () => {
    const { store, event } = setup()
    store.noteSent(1, 'with a typo', [image], undefined, 'u1')
    store.beginCancel(1)
    const settled = store.settleCancel(1, result)
    event(result)
    expect(settled).toMatchObject({ text: 'with a typo', images: [image], uuid: 'u1' })
    store.returnMessage(1, settled!)
    expect(store.get(1).returned).toBe('with a typo')
    expect(store.get(1).images).toEqual([image])
  })

  it('leaves it alone if Claude had started replying', () => {
    for (const reply of [
      { kind: 'delta', text: 'Sure' },
      { kind: 'assistant', uuid: 'a', blocks: [{ type: 'text', text: 'Sure' }] },
      { kind: 'assistant', uuid: 'a', blocks: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] }
    ] as LiveEvent[]) {
      const { store, event } = setup()
      store.noteSent(1, 'hello', [], undefined, 'u1')
      event(reply)
      store.beginCancel(1)
      expect(store.settleCancel(1, result)).toBeNull()
    }
  })

  it('notices a reply that lands between the key and the stop', () => {
    const { store, event } = setup()
    store.noteSent(1, 'hello', [], undefined, 'u1')
    store.beginCancel(1)
    event({ kind: 'delta', text: 'Sure' })
    expect(store.settleCancel(1, result)).toBeNull()
  })

  it('still counts as unanswered while Claude is only thinking', () => {
    const { store, event } = setup()
    store.noteSent(1, 'hello', [], undefined, 'u1')
    event({ kind: 'assistant', uuid: 'a', blocks: [{ type: 'thinking', thinking: '' }] } as LiveEvent)
    store.beginCancel(1)
    expect(store.settleCancel(1, result)).not.toBeNull()
  })

  it('does not take back a command', () => {
    const { store } = setup()
    store.noteSent(1, '/compact', [], undefined, 'u1')
    store.beginCancel(1)
    expect(store.settleCancel(1, result)).toBeNull()
  })

  it('does not take back a message Claude read part way through a turn', () => {
    const { store, event } = setup()
    store.noteSent(1, 'first', [], undefined, 'u1')
    event({ kind: 'assistant', uuid: 'a', blocks: [{ type: 'text', text: 'working' }] } as LiveEvent)
    store.noteSent(1, 'second', [], 'u2')
    event({ kind: 'commandLifecycle', uuid: 'u2', state: 'started' })
    store.beginCancel(1)
    expect(store.settleCancel(1, result)).toBeNull()
  })

  it('takes back a queued message that started its own turn', () => {
    const { store, event } = setup()
    store.noteSent(1, 'first', [], undefined, 'u1')
    event({ kind: 'assistant', uuid: 'a', blocks: [{ type: 'text', text: 'working' }] } as LiveEvent)
    store.noteSent(1, 'second', [], 'u2')
    event(result)
    event({ kind: 'commandLifecycle', uuid: 'u2', state: 'started' })
    store.beginCancel(1)
    expect(store.settleCancel(1, result)).toMatchObject({ text: 'second', uuid: 'u2' })
  })

  it('does nothing when no Esc was pressed, or the process died instead', () => {
    const { store } = setup()
    store.noteSent(1, 'hello', [], undefined, 'u1')
    expect(store.settleCancel(1, result)).toBeNull()
    store.beginCancel(1)
    expect(store.settleCancel(1, { kind: 'exit', code: 1 })).toBeNull()
  })

  it('keeps chats apart', () => {
    const { store } = setup()
    store.noteSent(1, 'one', [], undefined, 'u1')
    store.noteSent(2, 'two', [], undefined, 'u2')
    store.beginCancel(1)
    expect(store.settleCancel(2, result)).toBeNull()
    expect(store.settleCancel(1, result)).toMatchObject({ text: 'one' })
  })
})

describe('the chat after a message is taken back', () => {
  const text = (uuid: string): RenderItem => ({ kind: 'text', uuid, role: 'assistant', text: uuid, ts: null }) as RenderItem
  it('loses the message and the note that it was interrupted', () => {
    const items = [text('a'), text('bad'), text('marker')]
    expect(dropCancelledMessage(items, 'bad').map(i => i.uuid)).toEqual(['a'])
  })
  it('stays as it is if the message never showed', () => {
    const items = [text('a')]
    expect(dropCancelledMessage(items, 'bad')).toBe(items)
  })
})

describe('reading a rewind from the transcript', () => {
  const user = (uuid: string, parentUuid: string, content: unknown): RawRow => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content } }) as unknown as RawRow
  const assistant = (uuid: string, parentUuid: string): RawRow => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) as unknown as RawRow
  const attachment = (uuid: string, parentUuid: string): RawRow => ({ type: 'attachment', uuid, parentUuid }) as unknown as RawRow
  const leaf = (leafUuid: string): RawRow => ({ type: 'last-prompt', lastPrompt: 'x', leafUuid }) as unknown as RawRow
  const MARK = [{ type: 'text', text: '[Request interrupted by user]' }]

  it('finds the rows Claude Code rewound past, as 2.1.318 writes them', () => {
    const rows = [user('h', 'p', 'Remember'), assistant('a', 'h'), attachment('s', 'a'), user('bad', 's', 'Plover'), attachment('t', 'bad'), leaf('t'), user('m', 't', MARK), leaf('a')]
    expect([...rewoundUuids(rows)].sort()).toEqual(['bad', 'm'])
  })

  it('finds them on a first message too, when the leaf is empty', () => {
    const rows = [user('bad', 'x', 'Plover'), user('m', 'bad', MARK), { type: 'last-prompt', lastPrompt: 'x' } as unknown as RawRow]
    expect([...rewoundUuids(rows)].sort()).toEqual(['bad', 'm'])
  })

  it('finds them past the note Claude Code adds about a picture', () => {
    const meta = { ...(user('note', 'bad', '[Image: source: x]') as object), isMeta: true } as unknown as RawRow
    const rows = [assistant('a', 'h'), user('bad', 'a', 'Plover'), meta, user('m', 'note', MARK), leaf('a')]
    expect([...rewoundUuids(rows)].sort()).toEqual(['bad', 'm'])
  })

  it('also finds them from a later message on the same parent', () => {
    const rows = [assistant('a', 'h'), attachment('s', 'a'), user('bad', 's', 'Plover'), user('m', 'bad', MARK), user('next', 's', 'Real')]
    expect([...rewoundUuids(rows)].sort()).toEqual(['bad', 'm'])
  })

  it('leaves a stopped turn that was not rewound', () => {
    const plain = [assistant('a', 'h'), user('kept', 'a', 'Plover'), user('m', 'kept', MARK), leaf('m'), user('next', 'm', 'Real')]
    expect(rewoundUuids(plain).size).toBe(0)
  })

  it('leaves a turn Claude had replied in', () => {
    const replied = [assistant('a', 'h'), user('q', 'a', 'Do it'), assistant('b', 'q'), user('m', 'b', MARK), leaf('a')]
    expect(rewoundUuids(replied).size).toBe(0)
  })

  it('ignores the leaf written before the stop', () => {
    const rows = [assistant('a', 'h'), user('kept', 'a', 'Plover'), leaf('a'), user('m', 'kept', MARK)]
    expect(rewoundUuids(rows).size).toBe(0)
  })
})

describe('Esc while an old process is still closing', () => {
  it('never sends the held message, and says it was never sent', async () => {
    const exits: Array<() => void> = [], sent: object[] = [], emit: Array<(e: LiveEvent) => void> = []
    const transport = (): TransportLike => ({
      pid: null, start() {}, send(m: object) { sent.push(m) }, interrupt() {}, close() {}, request: async () => null,
      on(cb: (e: LiveEvent) => void) { emit.push(cb) }, onExit(cb: () => void) { exits.push(cb) }
    }) as unknown as TransportLike
    const pool = new SessionPool({ idleReapMs: 100000, transportFactory: transport, now: () => 0 })
    const heard: LiveEvent[] = []
    pool.on('k', e => heard.push(e))
    const base = { cwd: 'x', skipPermissions: false } as SpawnSpec
    pool.send('k', base, { uuid: 'first' })
    emit[0]!({ kind: 'result', isError: false, costUsd: 0, text: '' })
    pool.send('k', { ...base, extraArgs: ['--add-dir', 'b'] }, { uuid: 'held' })
    pool.interrupt('k')
    expect(heard.at(-1)).toMatchObject({ kind: 'result', interrupted: true })
    expect(await pool.rewind('k', 'held')).toBe(true)
    for (const exit of [...exits]) exit()
    expect(sent.map(m => (m as { uuid: string }).uuid).filter(u => u !== undefined)).toEqual(['first'])
  })

  it('reports whether a live process rewound', async () => {
    const answers: unknown[] = []
    const transport: TransportLike = {
      pid: null, start() {}, send() {}, interrupt() {}, close() {},
      request: async (subtype: string, extra: object) => { answers.push([subtype, extra]); return { rewound: true } },
      on() {}, onExit() {}
    } as unknown as TransportLike
    const pool = new SessionPool({ idleReapMs: 100000, transportFactory: () => transport, now: () => 0 })
    pool.send('k', { cwd: 'x', skipPermissions: false } as SpawnSpec, {})
    expect(await pool.rewind('k', 'u1')).toBe(true)
    expect(answers.at(-1)).toEqual(['rewind_conversation', { target_message_uuid: 'u1' }])
    expect(await pool.rewind('nobody', 'u1')).toBe(false)
  })
})
