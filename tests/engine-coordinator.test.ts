import { describe, it, expect } from 'vitest'
import {
  EngineCoordinator,
  alwaysAllowChanges,
  type PoolLike,
  type WatcherLike,
  type BridgeLike,
  type RulesStore,
  type SessionInfo,
  type EngineDefaults
} from '../src/main/engine/coordinator'
import type { SpawnSpec } from '../src/main/engine/transport'
import type { LiveEvent, PermissionRequest, PermissionDecision } from '../src/shared/engine-types'
import type { StreamedRow } from '../src/main/jsonl/stream'
import type { ContentBlock } from '../src/shared/types'

// ---------------------------------------------------------------------------
// Fakes -- no real child processes, no real chokidar watch, no real MCP wire.
// ---------------------------------------------------------------------------

class FakePool implements PoolLike {
  wake(): void {}
  sent: Array<{ sessionKey: string; spec: SpawnSpec; msg: object }> = []
  interruptCalls: string[] = []
  turnRunning = false
  isTurnRunning(): boolean { return this.turnRunning }
  responses: Array<{ requestId: string; response: unknown }> = []
  respond(_sessionKey: string, requestId: string, response: unknown): void { this.responses.push({ requestId, response }) }
  private subscribers = new Map<string, Array<(e: LiveEvent) => void>>()

  send(sessionKey: string, spec: SpawnSpec, msg: object): void {
    this.sent.push({ sessionKey, spec, msg })
  }

  interrupt(sessionKey: string): void {
    this.interruptCalls.push(sessionKey)
  }

  on(sessionKey: string, cb: (e: LiveEvent) => void): void {
    const list = this.subscribers.get(sessionKey)
    if (list !== undefined) list.push(cb)
    else this.subscribers.set(sessionKey, [cb])
  }

  emit(sessionKey: string, e: LiveEvent): void {
    for (const cb of this.subscribers.get(sessionKey) ?? []) cb(e)
  }

  subscriberCount(sessionKey: string): number {
    return this.subscribers.get(sessionKey)?.length ?? 0
  }
}

class FakeWatcher implements WatcherLike {
  watchCalls: Array<{ filePath: string; fromOffset: number }> = []
  stopCalls = 0
  private onRows: ((rows: StreamedRow[], endOffset: number) => void) | null = null

  watch(filePath: string, fromOffset: number, onRows: (rows: StreamedRow[], endOffset: number) => void): void {
    this.watchCalls.push({ filePath, fromOffset })
    this.onRows = onRows
  }

  stop(): void {
    this.stopCalls++
  }

  emitRows(rows: StreamedRow[], endOffset = 0): void {
    this.onRows?.(rows, endOffset)
  }
}

class FakeBridge implements BridgeLike {
  readonly toolName: string
  resolveCalls: Array<{ id: string; decision: PermissionDecision }> = []
  private requestListeners: Array<(req: PermissionRequest) => void> = []

  constructor(toolName = 'mcp__delegatto__approve') {
    this.toolName = toolName
  }

  onRequest(cb: (req: PermissionRequest) => void): void {
    this.requestListeners.push(cb)
  }

  resolve(id: string, decision: PermissionDecision): void {
    this.resolveCalls.push({ id, decision })
  }

  handled: Array<{ args: unknown; sessionKey: string; settle: (result: unknown) => void; id: string }> = []
  cancelled: string[] = []

  handleRequest(args: unknown, sessionKey: string): { id: string; answer: Promise<unknown> } {
    const id = `perm-${this.handled.length + 1}`
    const answer = new Promise<unknown>(settle => { this.handled.push({ args, sessionKey, settle, id }) })
    return { id, answer }
  }

  cancel(id: string): boolean {
    this.cancelled.push(id)
    return true
  }

  fireRequest(req: PermissionRequest): void {
    for (const cb of this.requestListeners) cb(req)
  }
}

class FakeRulesStore implements RulesStore {
  private rules = new Map<string, string[]>()

  add(cwd: string, rule: string): void {
    const list = this.rules.get(cwd) ?? []
    list.push(rule)
    this.rules.set(cwd, list)
  }

  get(cwd: string): string[] {
    return this.rules.get(cwd) ?? []
  }
}

const SESSION: SessionInfo = {
  sessionPk: 1,
  sessionKey: 'session-1',
  filePath: 'C:\\proj\\.claude\\session-1.jsonl',
  cwd: 'C:\\proj',
  resumeId: 'abc-123',
  indexedOffset: 42
}

function makeLookup(...sessions: SessionInfo[]): (pk: number) => SessionInfo | null {
  const map = new Map(sessions.map((s) => [s.sessionPk, s]))
  return (pk) => map.get(pk) ?? null
}

function makeDefaults(overrides: Partial<EngineDefaults> = {}): EngineDefaults {
  return {
    skipPermissions: false,
    claudeBin: 'claude',
    ...overrides
  }
}

function makeCoordinator(opts: {
  pool?: FakePool
  watchers?: FakeWatcher[]
  bridge?: FakeBridge
  lookupSession?: (pk: number) => SessionInfo | null
  rulesStore?: FakeRulesStore
  defaults?: EngineDefaults
  isExternallyLive?: (sessionKey: string) => boolean
  contextForMessage?: (sessionPk: number) => ContentBlock[]
} = {}): {
  coordinator: EngineCoordinator
  pool: FakePool
  watchers: FakeWatcher[]
  bridge: FakeBridge
  rulesStore: FakeRulesStore
} {
  const pool = opts.pool ?? new FakePool()
  const watchers = opts.watchers ?? []
  const bridge = opts.bridge ?? new FakeBridge()
  const rulesStore = opts.rulesStore ?? new FakeRulesStore()
  const makeWatcher = (): WatcherLike => {
    const w = new FakeWatcher()
    watchers.push(w)
    return w
  }

  const coordinator = new EngineCoordinator({
    pool,
    makeWatcher,
    bridge,
    lookupSession: opts.lookupSession ?? makeLookup(SESSION),
    rulesStore,
    defaults: opts.defaults ?? makeDefaults(),
    isExternallyLive: opts.isExternallyLive ?? (() => false),
    ...(opts.contextForMessage !== undefined ? { contextForMessage: opts.contextForMessage } : {})
  })

  return { coordinator, pool, watchers, bridge, rulesStore }
}

// ---------------------------------------------------------------------------

describe('EngineCoordinator — send() SpawnSpec construction', () => {
  it('builds a resume-in-place spec (resumeId from the session, never sessionId/fork)', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.send(1, 'hello')

    expect(pool.sent).toHaveLength(1)
    const { sessionKey, spec } = pool.sent[0]!
    expect(sessionKey).toBe('session-1')
    expect(spec.cwd).toBe('C:\\proj')
    expect(spec.resumeId).toBe('abc-123')
    expect(spec.sessionId).toBeUndefined()
  })

  it('skipPermissions=false wires the permission tool + mcp-config + any persisted rules', () => {
    const rulesStore = new FakeRulesStore()
    rulesStore.add('C:\\proj', 'Bash(npm run *)')
    const bridge = new FakeBridge('mcp__delegatto__approve')
    const { coordinator, pool } = makeCoordinator({
      rulesStore,
      bridge,
      defaults: makeDefaults({ skipPermissions: false })
    })

    coordinator.send(1, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.permissionPromptTool).toBe('stdio')
    expect(spec.extraArgs).toContain('--allowedTools')
    expect(spec.extraArgs![spec.extraArgs!.indexOf('--allowedTools') + 1]).toBe('Bash(npm run *)')
  })

  it('skipPermissions=false with no persisted rules still wires the prompt tool but no --allowedTools', () => {
    const { coordinator, pool } = makeCoordinator({ defaults: makeDefaults({ skipPermissions: false }) })
    coordinator.send(1, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.permissionPromptTool).toBe('stdio')
    expect(spec.extraArgs).toBeUndefined()
  })

  it('skipPermissions=true sets the flag, and still asks over stdio so questions work', () => {
    const { coordinator, pool } = makeCoordinator({ defaults: makeDefaults({ skipPermissions: true }) })
    coordinator.send(1, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.skipPermissions).toBe(true)
    expect(spec.permissionPromptTool).toBe('stdio')
    expect(spec.extraArgs).toBeUndefined()
  })

  it('passes model/effort/permissionMode through from defaults', () => {
    const { coordinator, pool } = makeCoordinator({
      defaults: makeDefaults({ model: 'opus', effort: 'high', permissionMode: 'plan' })
    })
    coordinator.send(1, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.model).toBe('opus')
    expect(spec.effort).toBe('high')
    expect(spec.permissionMode).toBe('plan')
  })

  it('builds a text-only string content when no images are given', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.send(1, 'plain text')

    expect(pool.sent[0]!.msg).toEqual({ type: 'user', message: { role: 'user', content: 'plain text' } })
  })

  it('builds text + image content blocks when images are given', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.send(1, 'look at this', [{ mediaType: 'image/png', dataBase64: 'ZmFrZQ==' }])

    expect(pool.sent[0]!.msg).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } }
        ]
      }
    })
  })

  it('an unknown sessionPk surfaces an error event instead of crashing', () => {
    const { coordinator, pool } = makeCoordinator({ lookupSession: () => null })
    const events: Array<{ pk: number; e: LiveEvent }> = []
    coordinator.onEvent((pk, e) => events.push({ pk, e }))

    expect(() => coordinator.send(999, 'hi')).not.toThrow()
    expect(pool.sent).toHaveLength(0)
    expect(events).toEqual([{ pk: 999, e: { kind: 'other', type: 'unknown-session' } }])
  })

  it('refuses to spawn against a session flagged externally-live (pool guard)', () => {
    const { coordinator, pool } = makeCoordinator({ isExternallyLive: (key) => key === 'session-1' })
    const events: Array<{ pk: number; e: LiveEvent }> = []
    coordinator.onEvent((pk, e) => events.push({ pk, e }))

    coordinator.send(1, 'hi')

    expect(pool.sent).toHaveLength(0)
    expect(events).toEqual([{ pk: 1, e: { kind: 'other', type: 'refused-external-live' } }])
  })
})

describe('EngineCoordinator — --session-id vs --resume (Task 8)', () => {
  const NEW_SESSION: SessionInfo = {
    sessionPk: 2,
    sessionKey: 'session-2',
    filePath: 'C:\\proj\\.claude\\session-2.jsonl',
    cwd: 'C:\\proj',
    resumeId: 'fresh-uuid-1',
    indexedOffset: 0,
    isNew: true
  }

  it('a brand-new session (isNew: true) is spawned with --session-id, never --resume', () => {
    const { coordinator, pool } = makeCoordinator({ lookupSession: makeLookup(NEW_SESSION) })
    coordinator.send(2, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.sessionId).toBe('fresh-uuid-1')
    expect(spec.resumeId).toBeUndefined()
  })

  it('a session with isNew explicitly false resumes in place, same as an omitted isNew', () => {
    const { coordinator, pool } = makeCoordinator({
      lookupSession: makeLookup({ ...NEW_SESSION, isNew: false })
    })
    coordinator.send(2, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.resumeId).toBe('fresh-uuid-1')
    expect(spec.sessionId).toBeUndefined()
  })

  it('an established session (SESSION fixture, isNew omitted) resumes in place -- unchanged pre-Task-8 behavior', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.send(1, 'hello')

    const { spec } = pool.sent[0]!
    expect(spec.resumeId).toBe('abc-123')
    expect(spec.sessionId).toBeUndefined()
  })
})

describe('EngineCoordinator — per-session overrides (Task 8 New-Chat dialog)', () => {
  it('setSessionDefaults overrides model/effort/skipPermissions for that sessionPk only, leaving others on the global default', () => {
    const OTHER_SESSION: SessionInfo = { ...SESSION, sessionPk: 2, sessionKey: 'session-2' }
    const { coordinator, pool } = makeCoordinator({
      defaults: makeDefaults({ skipPermissions: true, model: 'sonnet' }),
      lookupSession: makeLookup(SESSION, OTHER_SESSION)
    })
    coordinator.setSessionDefaults(2, { skipPermissions: false, model: 'opus', effort: 'high' })

    coordinator.send(1, 'hi') // untouched session: still the global defaults
    coordinator.send(2, 'hi') // overridden session

    const untouched = pool.sent[0]!.spec
    expect(untouched.skipPermissions).toBe(true)
    expect(untouched.model).toBe('sonnet')
    expect(untouched.effort).toBeUndefined()

    const overridden = pool.sent[1]!.spec
    expect(overridden.skipPermissions).toBe(false)
    expect(overridden.model).toBe('opus')
    expect(overridden.effort).toBe('high')
  })

  it('an override that omits a field falls back to the global default for it, not undefined', () => {
    const { coordinator, pool } = makeCoordinator({
      defaults: makeDefaults({ skipPermissions: true, model: 'sonnet', effort: 'low' })
    })
    // Only overriding skipPermissions -- model/effort must still come from
    // the global default, exactly as if the New-Chat dialog's model/effort
    // fields were left blank (engine-ipc.ts only sets defined fields on the
    // overrides object for this same reason).
    coordinator.setSessionDefaults(1, { skipPermissions: false })
    coordinator.send(1, 'hi')

    const { spec } = pool.sent[0]!
    expect(spec.skipPermissions).toBe(false)
    expect(spec.model).toBe('sonnet')
    expect(spec.effort).toBe('low')
  })

  it('a session with no registered overrides behaves exactly as before Task 8', () => {
    const { coordinator, pool } = makeCoordinator({ defaults: makeDefaults({ model: 'opus' }) })
    coordinator.send(1, 'hi')
    expect(pool.sent[0]!.spec.model).toBe('opus')
  })
})

describe('EngineCoordinator — watcher lifecycle', () => {
  it('starts exactly one watcher from the session\'s indexedOffset and forwards rows tagged with sessionPk', () => {
    const { coordinator, watchers } = makeCoordinator()
    const rows: Array<{ pk: number; rows: StreamedRow[] }> = []
    coordinator.onRows((pk, r) => rows.push({ pk, rows: r }))

    coordinator.send(1, 'hi')
    expect(watchers).toHaveLength(1)
    expect(watchers[0]!.watchCalls).toEqual([{ filePath: SESSION.filePath, fromOffset: 42 }])

    const fakeRow = { row: { type: 'other' }, byteOffset: 42, seq: 0 } as unknown as StreamedRow
    watchers[0]!.emitRows([fakeRow])

    expect(rows).toEqual([{ pk: 1, rows: [fakeRow] }])
  })

  it('a second send to the same session reuses the running watcher (no leak)', () => {
    const { coordinator, watchers } = makeCoordinator()
    coordinator.send(1, 'first')
    coordinator.send(1, 'second')

    expect(watchers).toHaveLength(1)
  })

  it('disposeSession stops the watcher; a later send starts a fresh one', () => {
    const { coordinator, watchers } = makeCoordinator()
    coordinator.send(1, 'first')
    expect(watchers).toHaveLength(1)

    coordinator.disposeSession(1)
    expect(watchers[0]!.stopCalls).toBe(1)

    coordinator.send(1, 'again')
    expect(watchers).toHaveLength(2)
  })

  it('disposeSession is a safe no-op for a session with no running watcher', () => {
    const { coordinator } = makeCoordinator()
    expect(() => coordinator.disposeSession(999)).not.toThrow()
  })
})

describe('EngineCoordinator — disposeAll() (Task 10 review Fix 3)', () => {
  const OTHER_SESSION: SessionInfo = { ...SESSION, sessionPk: 2, sessionKey: 'session-2' }

  it('stops every active watcher across every session', () => {
    const { coordinator, watchers } = makeCoordinator({ lookupSession: makeLookup(SESSION, OTHER_SESSION) })
    coordinator.send(1, 'hi')
    coordinator.send(2, 'hi')
    expect(watchers).toHaveLength(2)

    coordinator.disposeAll()

    expect(watchers[0]!.stopCalls).toBe(1)
    expect(watchers[1]!.stopCalls).toBe(1)
  })

  it('clears sessionInfo/sessionKey/defaults bookkeeping -- a later send behaves like a brand-new coordinator', () => {
    const { coordinator, pool, watchers } = makeCoordinator()
    coordinator.setSessionDefaults(1, { skipPermissions: false, model: 'opus' })
    coordinator.send(1, 'hi')
    expect(watchers).toHaveLength(1)

    coordinator.disposeAll()

    // A send after disposeAll re-resolves via lookupSession (cache cleared),
    // starts a FRESH watcher (the old one's map entry is gone), and no
    // longer applies the cleared per-session override.
    coordinator.send(1, 'again')
    expect(watchers).toHaveLength(2)
    expect(pool.sent[1]!.spec.model).toBeUndefined()
  })

  it('re-subscribes to pool events after disposeAll (subscribedKeys cleared) instead of silently dropping them', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.send(1, 'hi')
    expect(pool.subscriberCount('session-1')).toBe(1)

    coordinator.disposeAll()
    coordinator.send(1, 'again')

    expect(pool.subscriberCount('session-1')).toBe(2)
  })

  it('is idempotent -- calling disposeAll twice does not throw', () => {
    const { coordinator } = makeCoordinator()
    coordinator.send(1, 'hi')
    coordinator.disposeAll()
    expect(() => coordinator.disposeAll()).not.toThrow()
  })
})

describe('EngineCoordinator — pool event fan-out', () => {
  it('forwards pool events tagged with the sessionPk, and does not double-subscribe on repeated sends', () => {
    const { coordinator, pool } = makeCoordinator()
    const events: Array<{ pk: number; e: LiveEvent }> = []
    coordinator.onEvent((pk, e) => events.push({ pk, e }))

    coordinator.send(1, 'first')
    coordinator.send(1, 'second')
    expect(pool.subscriberCount('session-1')).toBe(1)

    pool.emit('session-1', { kind: 'delta', text: 'hi' })
    expect(events).toEqual([{ pk: 1, e: { kind: 'delta', text: 'hi' } }])
  })

  it('forwards a pool exit event tagged with the sessionPk (Task 10 review Fix 1)', () => {
    const { coordinator, pool } = makeCoordinator()
    const events: Array<{ pk: number; e: LiveEvent }> = []
    coordinator.onEvent((pk, e) => events.push({ pk, e }))

    coordinator.send(1, 'hi')
    pool.emit('session-1', { kind: 'exit', code: null })

    expect(events).toEqual([{ pk: 1, e: { kind: 'exit', code: null } }])
  })
})

describe('EngineCoordinator — permission requests', () => {
  it('forwards a parked permission request tagged with its sessionPk', () => {
    const { coordinator, bridge } = makeCoordinator()
    const reqs: Array<{ pk: number; req: PermissionRequest }> = []
    coordinator.onPermission((pk, req) => reqs.push({ pk, req }))

    coordinator.send(1, 'hi') // establishes the sessionKey -> sessionPk mapping

    const req: PermissionRequest = { id: 'perm-1', tool: 'Bash', input: { command: 'ls' }, sessionKey: 'session-1' }
    bridge.fireRequest(req)

    expect(reqs).toEqual([{ pk: 1, req }])
  })

  it('drops a permission request whose sessionKey cannot be mapped back to a sessionPk (no send happened yet)', () => {
    const { bridge } = makeCoordinator()
    const reqs: Array<{ pk: number; req: PermissionRequest }> = []
    // (coordinator constructed but never sent for 'ghost-session')
    const { coordinator } = makeCoordinator({ bridge })
    coordinator.onPermission((pk, req) => reqs.push({ pk, req }))

    expect(() =>
      bridge.fireRequest({ id: 'perm-x', tool: 'Bash', input: {}, sessionKey: 'ghost-session' })
    ).not.toThrow()
    expect(reqs).toEqual([])
  })
})

describe('EngineCoordinator — resolvePermission (T5 pairing)', () => {
  it('allow_always derives the rule from the pending request, persists it under the cwd, THEN resolves allow', () => {
    const rulesStore = new FakeRulesStore()
    const { coordinator, bridge } = makeCoordinator({ rulesStore })
    coordinator.send(1, 'hi') // maps session-1 -> pk 1, caches cwd

    bridge.fireRequest({ id: 'perm-1', tool: 'Bash', input: { command: 'npx playwright test' }, sessionKey: 'session-1' })
    expect(rulesStore.get('C:\\proj')).toEqual([])

    coordinator.resolvePermission('perm-1', 'allow_always')

    expect(rulesStore.get('C:\\proj')).toEqual(['Bash(npx playwright *)'])
    expect(bridge.resolveCalls).toEqual([
      { id: 'perm-1', decision: { behavior: 'allow', updatedInput: { command: 'npx playwright test' } } }
    ])
  })

  it('allow resolves allow with the original input (no rule persisted)', () => {
    const rulesStore = new FakeRulesStore()
    const { coordinator, bridge } = makeCoordinator({ rulesStore })
    coordinator.send(1, 'hi')

    bridge.fireRequest({ id: 'perm-2', tool: 'Read', input: { file_path: 'C:\\proj\\a.txt' }, sessionKey: 'session-1' })
    coordinator.resolvePermission('perm-2', 'allow')

    expect(rulesStore.get('C:\\proj')).toEqual([])
    expect(bridge.resolveCalls).toEqual([
      { id: 'perm-2', decision: { behavior: 'allow', updatedInput: { file_path: 'C:\\proj\\a.txt' } } }
    ])
  })

  it('allow with an edited input uses the edited input, not the original', () => {
    const { coordinator, bridge } = makeCoordinator()
    coordinator.send(1, 'hi')

    bridge.fireRequest({ id: 'perm-3', tool: 'Write', input: { file_path: 'a.txt' }, sessionKey: 'session-1' })
    coordinator.resolvePermission('perm-3', 'allow', { file_path: 'b.txt' })

    expect(bridge.resolveCalls).toEqual([
      { id: 'perm-3', decision: { behavior: 'allow', updatedInput: { file_path: 'b.txt' } } }
    ])
  })

  it('deny resolves deny with the given (or default) message', () => {
    const { coordinator, bridge } = makeCoordinator()
    coordinator.send(1, 'hi')

    bridge.fireRequest({ id: 'perm-4', tool: 'Bash', input: { command: 'rm -rf /' }, sessionKey: 'session-1' })
    coordinator.resolvePermission('perm-4', 'deny')

    expect(bridge.resolveCalls).toEqual([{ id: 'perm-4', decision: { behavior: 'deny', message: 'Denied by user' } }])
  })

  it('deny with a custom message forwards it', () => {
    const { coordinator, bridge } = makeCoordinator()
    coordinator.send(1, 'hi')
    bridge.fireRequest({ id: 'perm-5', tool: 'Bash', input: {}, sessionKey: 'session-1' })
    coordinator.resolvePermission('perm-5', 'deny', undefined, 'not today')

    expect(bridge.resolveCalls).toEqual([{ id: 'perm-5', decision: { behavior: 'deny', message: 'not today' } }])
  })

  it('resolving an unknown id does not throw and leaves no pending entry behind', () => {
    const { coordinator, bridge } = makeCoordinator()

    expect(() => coordinator.resolvePermission('never-parked', 'allow')).not.toThrow()
    expect(bridge.resolveCalls).toEqual([{ id: 'never-parked', decision: { behavior: 'allow', updatedInput: undefined } }])

    // Resolving it again is still a no-op-ish forward, not a crash or a
    // second consumption of some leaked state.
    expect(() => coordinator.resolvePermission('never-parked', 'deny')).not.toThrow()
  })
})

describe('EngineCoordinator — interrupt()', () => {
  it('forwards interrupt to the pool using the resolved sessionKey', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.send(1, 'hi')
    coordinator.interrupt(1)

    expect(pool.interruptCalls).toEqual(['session-1'])
  })

  it('resolves the sessionKey via lookup even if interrupt is called before any send', () => {
    const { coordinator, pool } = makeCoordinator()
    coordinator.interrupt(1)

    expect(pool.interruptCalls).toEqual(['session-1'])
  })

  it('is a safe no-op for an unknown sessionPk', () => {
    const { coordinator, pool } = makeCoordinator({ lookupSession: () => null })
    expect(() => coordinator.interrupt(999)).not.toThrow()
    expect(pool.interruptCalls).toEqual([])
  })
})

describe('EngineCoordinator.watchSession (read-only tailing while locked)', () => {
  it('starts one watcher from the indexed offset without sending, and forwards rows', () => {
    const { coordinator, pool, watchers } = makeCoordinator()
    const got: number[] = []
    coordinator.onRows((pk) => got.push(pk))
    expect(coordinator.watchSession(1)).toBe(true)
    expect(coordinator.watchSession(1)).toBe(true) // idempotent
    expect(watchers).toHaveLength(1)
    expect(watchers[0]!.watchCalls[0]).toEqual({ filePath: SESSION.filePath, fromOffset: 42 })
    expect(pool.sent).toHaveLength(0)
    watchers[0]!.emitRows([])
    expect(got).toEqual([1])
  })

  it('returns false for an unknown session', () => {
    const { coordinator, watchers } = makeCoordinator()
    expect(coordinator.watchSession(999)).toBe(false)
    expect(watchers).toHaveLength(0)
  })
})

describe('EngineCoordinator -- permission requests from Claude Code', () => {
  const asked = (requestId: string, tool = 'Bash'): LiveEvent => ({ kind: 'permissionAsked', requestId, args: { tool_name: tool, input: {} } })
  const answered = (pool: FakePool): Array<{ requestId: string; response: unknown }> => pool.responses

  it('parks a request, keeps it from the window, and answers with what was decided', async () => {
    const { coordinator, pool, bridge } = makeCoordinator()
    const seen: LiveEvent[] = []
    coordinator.onEvent((_pk, e) => seen.push(e))
    coordinator.send(1, 'hello')
    pool.emit('session-1', asked('r1'))
    expect(bridge.handled).toHaveLength(1)
    expect(seen.some(e => e.kind === 'permissionAsked')).toBe(false)
    bridge.handled[0]!.settle({ behavior: 'allow', updatedInput: {} })
    await new Promise(r => setTimeout(r, 0))
    expect(answered(pool)).toEqual([{ requestId: 'r1', response: { behavior: 'allow', updatedInput: {} } }])
  })

  it('takes the card back when Claude Code stops waiting, and sends no late answer', async () => {
    const { coordinator, pool, bridge } = makeCoordinator()
    const seen: LiveEvent[] = []
    coordinator.onEvent((_pk, e) => seen.push(e))
    coordinator.send(1, 'hello')
    pool.emit('session-1', asked('r1'))
    pool.emit('session-1', { kind: 'permissionCancelled', requestId: 'r1' })
    expect(bridge.cancelled).toEqual(['perm-1'])
    expect(seen).toContainEqual({ kind: 'permissionGone', id: 'perm-1' })
    bridge.handled[0]!.settle({ behavior: 'deny', message: 'x' })
    await new Promise(r => setTimeout(r, 0))
    expect(answered(pool)).toEqual([])
  })

  it('takes back every card of a process that exits, and only that chat', () => {
    const other: SessionInfo = { ...SESSION, sessionPk: 2, sessionKey: 'session-2', filePath: 'C:\\proj\\.claude\\session-2.jsonl' }
    const { coordinator, pool, bridge } = makeCoordinator({ lookupSession: makeLookup(SESSION, other) })
    coordinator.send(1, 'hello')
    coordinator.send(2, 'hello')
    pool.emit('session-1', asked('r1'))
    pool.emit('session-2', asked('r2'))
    pool.emit('session-1', { kind: 'exit', code: 0 })
    expect(bridge.cancelled).toEqual(['perm-1'])
  })
})

describe('don\'t ask again', () => {
  it('adds rules and folders, but never changes the mode as a side effect', () => {
    const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }
    const dir = { type: 'addDirectories', directories: ['C:\\x'] }
    expect(alwaysAllowChanges([rule, dir, { type: 'setMode', mode: 'acceptEdits' }])).toEqual([rule, dir])
  })
})

describe('EngineCoordinator -- a project folder that has gone', () => {
  it('says so instead of trying to start Claude there', () => {
    const pool = new FakePool()
    const coordinator = new EngineCoordinator({
      pool, makeWatcher: () => new FakeWatcher(), bridge: new FakeBridge(), lookupSession: makeLookup(SESSION),
      rulesStore: new FakeRulesStore(), defaults: makeDefaults(), isExternallyLive: () => false, folderExists: () => false
    })
    const types: string[] = []
    coordinator.onEvent((_pk, e) => { if (e.kind === 'other') types.push(e.type) })
    coordinator.send(1, 'hello')
    expect(pool.sent).toHaveLength(0)
    expect(types).toEqual(['folder-missing'])
  })
})

describe('EngineCoordinator -- ! output', () => {
  const OUTPUT: ContentBlock[] = [{ type: 'text', text: '<bash-input>ls</bash-input>' }, { type: 'text', text: '<bash-stdout>a</bash-stdout>' }]
  /** Hands the output over once, as the shell runner does. */
  const once = (): (() => ContentBlock[]) => {
    let left = OUTPUT
    return () => { const out = left; left = []; return out }
  }
  const contentOf = (sent: { msg: object }): unknown => (sent.msg as { message: { content: unknown } }).message.content
  const result = { kind: 'result', isError: false, text: '' } as unknown as LiveEvent

  it('gives Claude finished output as a message of its own, with no empty text block', () => {
    const { coordinator, pool } = makeCoordinator({ contextForMessage: once() })
    coordinator.deliverShellOutput(1)
    expect(pool.sent).toHaveLength(1)
    expect(contentOf(pool.sent[0]!)).toEqual(OUTPUT)
  })

  it('says when output is on its way, and only then', () => {
    const { coordinator } = makeCoordinator({ contextForMessage: once() })
    const types: string[] = []
    coordinator.onEvent((_pk, e) => { if (e.kind === 'other') types.push(e.type) })
    coordinator.deliverShellOutput(1)
    coordinator.deliverShellOutput(1)
    coordinator.send(1, 'hello')
    expect(types).toEqual(['shell-output-sent'])
  })

  it('waits for a running turn to end', () => {
    const { coordinator, pool } = makeCoordinator({ contextForMessage: once() })
    pool.turnRunning = true
    coordinator.deliverShellOutput(1)
    expect(pool.sent).toHaveLength(0)
    pool.emit('session-1', { kind: 'usage', outputTokens: 1 } as unknown as LiveEvent)
    expect(pool.sent).toHaveLength(0)
    pool.turnRunning = false
    pool.emit('session-1', result)
    expect(pool.sent).toHaveLength(1)
    pool.emit('session-1', result)
    expect(pool.sent).toHaveLength(1)
  })

  it('sends nothing when a message has already carried the output', () => {
    const { coordinator, pool } = makeCoordinator({ contextForMessage: once() })
    coordinator.send(1, 'hello')
    expect(pool.sent).toHaveLength(1)
    coordinator.deliverShellOutput(1)
    expect(pool.sent).toHaveLength(1)
  })

  it('leaves it for the next message while something else holds the chat', () => {
    let taken = 0
    const { coordinator, pool } = makeCoordinator({ isExternallyLive: () => true, contextForMessage: () => { taken++; return OUTPUT } })
    coordinator.deliverShellOutput(1)
    expect(pool.sent).toHaveLength(0)
    expect(taken).toBe(0)
  })
})
