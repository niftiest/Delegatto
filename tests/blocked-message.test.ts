import { describe, it, expect } from 'vitest'
import { ComposeStore, promptEndingNotice, writesLostNotice } from '../src/renderer/compose-store'
import { addDirCommandOf, terminalOnlyCommand, type ComposerImage } from '../src/renderer/lib'
import { parseEvent } from '../src/main/engine/events'
import { SessionPool, type TransportLike } from '../src/main/engine/pool'
import type { SpawnSpec } from '../src/main/engine/transport'
import type { LiveEvent } from '../src/shared/engine-types'

// Copied from what Claude Code 2.1.318 sent when a UserPromptSubmit hook exited 2.
const BLOCKED = JSON.stringify({
  type: 'system', subtype: 'informational', level: 'warning', prevent_continuation: true,
  content: 'UserPromptSubmit operation blocked by hook:\nNope\n\nOriginal prompt: hello',
  prompt_submit_outcome: { kind: 'blocked_by_hook', prompt_kept: false, reason: 'Nope' }
})
const STOPPED = JSON.stringify({
  type: 'system', subtype: 'informational', level: 'warning', prevent_continuation: true,
  content: 'Operation stopped by hook: Enough',
  prompt_submit_outcome: { kind: 'stopped_by_hook', prompt_kept: true, reason: 'Enough' }
})
const image = { id: 'i', name: 'a.png', mediaType: 'image/png', dataBase64: 'x' } as unknown as ComposerImage
const result = { kind: 'result', isError: false, costUsd: 0, text: '' } as LiveEvent

function setup() {
  const store = new ComposeStore()
  const event = (ev: LiveEvent | string, pk = 1): void => {
    store.handleEvent(pk, typeof ev === 'string' ? parseEvent(ev)! : ev, () => {})
  }
  return { store, event }
}

describe('a message that ends before reaching Claude', () => {
  it('reads what Claude Code says about it', () => {
    expect(parseEvent(BLOCKED)).toMatchObject({ kind: 'informational', level: 'warning', ending: { kind: 'blocked_by_hook', kept: false, reason: 'Nope' } })
    expect(parseEvent(JSON.stringify({ type: 'system', subtype: 'informational', level: 'notice', content: 'hi' }))).toEqual({ kind: 'informational', text: 'hi', level: 'notice' })
  })

  it('tells a hook saying no from a hook going wrong', () => {
    const line = (code: number): string => JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'h', hook_event: 'UserPromptSubmit', outcome: 'error', exit_code: code })
    expect(parseEvent(line(2))).toMatchObject({ exitCode: 2 })
    expect(parseEvent(line(1))).toMatchObject({ exitCode: 1 })
  })

  it('puts a blocked message and its pictures back, with the reason', () => {
    const { store, event } = setup()
    store.noteSent(1, 'my long careful message', [image])
    event(BLOCKED)
    expect(store.get(1).returned).toBe('my long careful message')
    expect(store.get(1).images).toEqual([image])
    expect(store.get(1).notice).toBe("A hook blocked this message. Nope. It's back in the message box.")
    expect(store.hasUnsent()).toBe(true)
  })

  it('leaves a kept message where it is', () => {
    const { store, event } = setup()
    store.noteSent(1, 'stays', [])
    event(STOPPED)
    expect(store.get(1).returned).toBeUndefined()
    expect(store.get(1).notice).toBe('A hook stopped this message before Claude replied. Enough. Claude will see it with your next message.')
  })

  it('returns the message that was running, not a later one in the queue', () => {
    const { store, event } = setup()
    store.noteSent(1, 'first', [])
    event(result)
    store.noteSent(1, 'second', [], 'u2')
    store.noteSent(1, 'third', [], 'u3')
    event({ kind: 'commandLifecycle', uuid: 'u2', state: 'queued' })
    event({ kind: 'commandLifecycle', uuid: 'u2', state: 'started' })
    event(BLOCKED)
    expect(store.get(1).returned).toBe('second')
  })

  it('keeps every chat apart, and holds what happens in one not on screen', () => {
    const { store, event } = setup()
    store.setOpen(2)
    store.noteSent(1, 'in chat one', [])
    store.noteSent(2, 'in chat two', [])
    event(BLOCKED, 1)
    expect(store.get(1).returned).toBe('in chat one')
    expect(store.get(2).returned).toBeUndefined()
  })

  it('has nothing to return once the turn is over', () => {
    const { store, event } = setup()
    store.noteSent(1, 'done', [])
    event(result)
    event(BLOCKED)
    expect(store.get(1).returned).toBeUndefined()
    expect(store.get(1).notice).toBe('A hook blocked this message. Nope.')
  })

  it('still says something for an ending it does not know', () => {
    expect(promptEndingNotice({ kind: null, kept: false, reason: null }, false)).toBe("This message didn't reach Claude.")
    expect(promptEndingNotice({ kind: 'something_new', kept: false, reason: null }, true)).toBe("This message didn't reach Claude. It's back in the message box.")
  })

  it('shows other warnings, and leaves quieter lines alone', () => {
    const { store, event } = setup()
    event(JSON.stringify({ type: 'system', subtype: 'informational', level: 'notice', content: 'quiet' }))
    expect(store.get(1).notice).toBeUndefined()
    event(JSON.stringify({ type: 'system', subtype: 'informational', level: 'warning', content: 'Stop hook said no' }))
    expect(store.get(1).notice).toBe('Stop hook said no')
  })
})

describe('when Claude Code cannot save', () => {
  it('reads the warning and says what was lost', () => {
    const ev = parseEvent(JSON.stringify({ type: 'system', subtype: 'session_writes_lost', error_code: 'ENOSPC', lost: ['transcript', 'global_config'], transcript_session_ids: ['s'], uuid: 'u', session_id: 's' }))
    expect(ev).toEqual({ kind: 'writesLost', errorCode: 'ENOSPC', lost: ['transcript', 'global_config'] })
    expect(writesLostNotice('ENOSPC', ['transcript'])).toContain('part of a chat because your disk is full')
    expect(writesLostNotice('EDQUOT', ['global_config'])).toContain("Claude Code's settings because your disk quota is used up")
  })

  it('still hears it from a process being closed', () => {
    const emit: Array<(e: LiveEvent) => void> = []
    const transport: TransportLike = {
      pid: null, start() {}, send() {}, interrupt() {}, close() {},
      on(cb: (e: LiveEvent) => void) { emit.push(cb) }, onExit() {}
    } as unknown as TransportLike
    const pool = new SessionPool({ idleReapMs: 1, transportFactory: () => transport, now: () => 0 })
    const heard: LiveEvent[] = []
    pool.on('k', e => heard.push(e))
    pool.send('k', { cwd: 'x', skipPermissions: false } as SpawnSpec, {})
    emit[0]!({ kind: 'result', isError: false, costUsd: 0, text: '' })
    pool.shutdown()
    heard.length = 0
    emit[0]!({ kind: 'delta', text: 'late' })
    emit[0]!({ kind: 'writesLost', errorCode: 'ENOSPC', lost: ['transcript'] })
    expect(heard).toEqual([{ kind: 'writesLost', errorCode: 'ENOSPC', lost: ['transcript'] }])
  })
})

describe('other folders for a project', () => {
  it('reads /add-dir with and without a folder', () => {
    expect(addDirCommandOf('/add-dir D:\\shared')).toBe('D:\\shared')
    expect(addDirCommandOf('/add-dir "D:\\my folder"')).toBe('D:\\my folder')
    expect(addDirCommandOf('/add-dir')).toBe('')
    expect(addDirCommandOf('/add-directory x')).toBeNull()
    expect(addDirCommandOf('please /add-dir x')).toBeNull()
  })

  it('starts a new process when the folders change, not otherwise', () => {
    const made: SpawnSpec[] = []
    const events: Array<(e: LiveEvent) => void> = []
    const exits: Array<(c: number | null) => void> = []
    const pool = new SessionPool({
      idleReapMs: 1000,
      now: () => 0,
      transportFactory: spec => {
        made.push(spec)
        return { pid: null, start() {}, send() {}, interrupt() {}, close() {}, on(cb: (e: LiveEvent) => void) { events.push(cb) }, onExit(cb: (c: number | null) => void) { exits.push(cb) } } as unknown as TransportLike
      }
    })
    const finishTurn = (): void => events.at(-1)!({ kind: 'result', isError: false, costUsd: 0, text: '' })
    const base = { cwd: 'x', skipPermissions: false } as SpawnSpec
    pool.send('k', { ...base, extraArgs: ['--add-dir', 'a'] }, {})
    finishTurn()
    pool.send('k', { ...base, extraArgs: ['--add-dir', 'a'] }, {})
    finishTurn()
    expect(made).toHaveLength(1)
    pool.send('k', { ...base, extraArgs: ['--add-dir', 'a', '--add-dir', 'b'] }, {})
    for (const exit of [...exits]) exit(0)
    expect(made).toHaveLength(2)
    expect(made[1]!.extraArgs).toEqual(['--add-dir', 'a', '--add-dir', 'b'])
  })
})

describe('commands with no way to work here', () => {
  it('offers the terminal for them instead of spending a turn', () => {
    for (const c of ['/tui', '/voice', '/sandbox']) expect(terminalOnlyCommand(c)).toBe(c)
    expect(terminalOnlyCommand('/add-dir D:\\x')).toBeNull()
  })
})
