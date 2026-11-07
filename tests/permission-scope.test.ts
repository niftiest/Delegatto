import { describe, it, expect } from 'vitest'
import { onlyForSession, outsideFolder, sessionRuleStrings } from '../src/shared/permission-scope'
import { EngineCoordinator, type BridgeLike, type PoolLike, type RulesStore, type SessionInfo, type WatcherLike } from '../src/main/engine/coordinator'
import { SessionPool } from '../src/main/engine/pool'
import { parsePermissionArgs } from '../src/main/engine/permission-bridge'
import type { SpawnSpec } from '../src/main/engine/transport'
import type { TransportLike } from '../src/main/engine/pool'
import type { LiveEvent, PermissionDecision, PermissionRequest, PermissionSuggestion } from '../src/shared/engine-types'

// Exactly what Claude Code 2.1.318 sent, captured live.
const READ_OFFER: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//d/GIT/TradingLib/**' }], behavior: 'allow', destination: 'session' }]
const WRITE_OFFER: PermissionSuggestion[] = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: ['D:\\GIT\\TradingLib'], destination: 'session' }]
const BASH_OFFER: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls "D:/GIT/TradingLib"' }], behavior: 'allow', destination: 'localSettings' }, READ_OFFER[0]!]

describe('the folder a request is about', () => {
  it('comes from a read rule, as a real Windows path', () => {
    expect(outsideFolder({ reasonType: 'workingDir', suggestions: READ_OFFER })).toBe('D:\\GIT\\TradingLib')
  })
  it('comes from what a write offers', () => {
    expect(outsideFolder({ reasonType: 'workingDir', suggestions: WRITE_OFFER })).toBe('D:\\GIT\\TradingLib')
  })
  it('keeps spaces in the path', () => {
    expect(outsideFolder({ reasonType: 'workingDir', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//c/My Stuff/lib/**' }], destination: 'session' }] })).toBe('C:\\My Stuff\\lib')
  })
  it('is never a whole drive', () => {
    expect(outsideFolder({ reasonType: 'workingDir', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//c/**' }], destination: 'session' }] })).toBeNull()
  })
  it('only counts when being outside the project is why it asks', () => {
    expect(outsideFolder({ suggestions: BASH_OFFER })).toBeNull()
    expect(outsideFolder({ reasonType: 'rule', suggestions: READ_OFFER })).toBeNull()
  })
  it('is null with nothing to go on', () => {
    expect(outsideFolder({ reasonType: 'workingDir' })).toBeNull()
    expect(outsideFolder({ reasonType: 'workingDir', suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] })).toBeNull()
  })
  it('reads the reason from the request', () => {
    expect(parsePermissionArgs({ tool_name: 'Read', decision_reason_type: 'workingDir' }, 'i', 'k').reasonType).toBe('workingDir')
    expect(parsePermissionArgs({ tool_name: 'Read' }, 'i', 'k').reasonType).toBeUndefined()
  })
})

describe('how long an offer lasts', () => {
  it('session rules and folders end with the session', () => {
    expect(onlyForSession(READ_OFFER)).toBe(true)
    expect(onlyForSession(WRITE_OFFER)).toBe(true) // the mode change isn't applied
  })
  it('anything saved makes it not session-only', () => {
    expect(onlyForSession(BASH_OFFER)).toBe(false)
  })
  it('nothing on offer is not session-only', () => {
    expect(onlyForSession([])).toBe(false)
    expect(onlyForSession([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])).toBe(false)
  })
  it('session rules read the way --allowedTools takes them', () => {
    expect(sessionRuleStrings(BASH_OFFER)).toEqual(['Read(//d/GIT/TradingLib/**)'])
    expect(sessionRuleStrings(WRITE_OFFER)).toEqual([])
  })
})

function setup(addProjectDir?: (pk: number, dir: string) => boolean) {
  const session: SessionInfo = { sessionKey: 'k', filePath: 'f', cwd: 'C:\\proj', resumeId: 'r' } as SessionInfo
  const sent: SpawnSpec[] = []
  const noted: string[] = []
  const resolved: Array<{ id: string; decision: PermissionDecision }> = []
  let fire: (r: PermissionRequest) => void = () => {}
  const pool: PoolLike = {
    send: (_k, spec) => { sent.push(spec) }, interrupt() {}, wake() {}, on() {}, isTurnRunning: () => false,
    noteDirAdded: (_k, dir) => { noted.push(dir) }
  }
  const bridge: BridgeLike = {
    toolName: 't', onRequest: cb => { fire = cb }, resolve: (id, decision) => { resolved.push({ id, decision }) },
    handleRequest: () => ({ id: 'x', answer: Promise.resolve(null) }), cancel: () => true
  }
  const rules: string[] = []
  const rulesStore: RulesStore = { get: () => rules, add: (_c, r) => { rules.push(r) } } as RulesStore
  const watcher: WatcherLike = { watch() {}, stop() {} }
  const dirs: string[] = []
  const coordinator = new EngineCoordinator({
    pool, bridge, rulesStore, makeWatcher: () => watcher, lookupSession: () => session, isExternallyLive: () => false,
    defaults: { skipPermissions: false } as never,
    projectDirs: () => dirs,
    ...(addProjectDir === undefined ? {} : { addProjectDir: (pk: number, dir: string) => { const ok = addProjectDir(pk, dir); if (ok) dirs.push(dir); return ok } })
  })
  coordinator.send(1, 'hi')
  return { coordinator, sent, noted, resolved, rules, dirs, ask: (r: Partial<PermissionRequest>) => fire({ id: 'p', tool: 'Read', input: { file_path: 'x' }, sessionKey: 'k', reasonType: 'workingDir', ...r }) }
}

describe('answering a folder question', () => {
  it('Always allow adds it to the project and tells the running process, with no saved rule', () => {
    const t = setup(() => true)
    t.ask({ suggestions: READ_OFFER })
    t.coordinator.resolvePermission('p', 'allow_folder')
    expect(t.dirs).toEqual(['D:\\GIT\\TradingLib'])
    expect(t.noted).toEqual(['D:\\GIT\\TradingLib'])
    expect(t.rules).toEqual([])
    expect(t.resolved[0]!.decision).toEqual({ behavior: 'allow', updatedInput: { file_path: 'x' }, updatedPermissions: [{ type: 'addDirectories', directories: ['D:\\GIT\\TradingLib'], destination: 'session' }] })
    t.coordinator.send(1, 'next')
    expect(t.sent.at(-1)!.extraArgs).toEqual(['--add-dir', 'D:\\GIT\\TradingLib'])
  })

  it('Always allow on a folder that can\'t be saved still gets the session', () => {
    const t = setup(() => false)
    t.ask({ suggestions: READ_OFFER })
    t.coordinator.resolvePermission('p', 'allow_folder')
    expect(t.dirs).toEqual([])
    expect(t.resolved[0]!.decision).toMatchObject({ behavior: 'allow', updatedPermissions: READ_OFFER })
  })

  it('Allow for this session saves nothing to the project', () => {
    const t = setup(() => true)
    t.ask({ suggestions: READ_OFFER })
    t.coordinator.resolvePermission('p', 'allow_always')
    expect(t.dirs).toEqual([])
    expect(t.rules).toEqual([])
    expect(t.resolved[0]!.decision).toMatchObject({ behavior: 'allow', updatedPermissions: READ_OFFER })
  })

  it('and a read stays a read when the chat\'s process comes back', () => {
    const t = setup(() => true)
    t.ask({ suggestions: READ_OFFER })
    t.coordinator.resolvePermission('p', 'allow_always')
    t.coordinator.send(1, 'next')
    expect(t.sent.at(-1)!.extraArgs).toEqual(['--allowedTools', 'Read(//d/GIT/TradingLib/**)'])
  })

  it('a write\'s session folder comes back too, and never the mode change', () => {
    const t = setup(() => true)
    t.ask({ tool: 'Write', suggestions: WRITE_OFFER })
    t.coordinator.resolvePermission('p', 'allow_always')
    expect(t.noted).toEqual(['D:\\GIT\\TradingLib'])
    expect(t.resolved[0]!.decision).toMatchObject({ updatedPermissions: [WRITE_OFFER[1]] })
    t.coordinator.send(1, 'next')
    expect(t.sent.at(-1)!.extraArgs).toEqual(['--add-dir', 'D:\\GIT\\TradingLib'])
    expect(t.sent.at(-1)!.permissionMode).toBeUndefined()
  })

  it('plain Allow remembers nothing', () => {
    const t = setup(() => true)
    t.ask({ suggestions: READ_OFFER })
    t.coordinator.resolvePermission('p', 'allow')
    t.coordinator.send(1, 'next')
    expect(t.sent.at(-1)!.extraArgs).toBeUndefined()
  })

  it('Deny remembers nothing', () => {
    const t = setup(() => true)
    t.ask({ suggestions: READ_OFFER })
    t.coordinator.resolvePermission('p', 'deny')
    expect(t.dirs).toEqual([])
    expect(t.resolved[0]!.decision.behavior).toBe('deny')
  })
})

describe('adding a folder to a running chat', () => {
  function pool() {
    const made: SpawnSpec[] = []
    const events: Array<(e: LiveEvent) => void> = []
    const p = new SessionPool({
      idleReapMs: 1000, now: () => 0,
      transportFactory: spec => {
        made.push(spec)
        return { pid: null, start() {}, send() {}, interrupt() {}, close() {}, on(cb: (e: LiveEvent) => void) { events.push(cb) }, onExit() {} } as unknown as TransportLike
      }
    })
    const finishTurn = (): void => events.at(-1)!({ kind: 'result', isError: false, costUsd: 0, text: '' })
    return { p, made, finishTurn }
  }
  const base = { cwd: 'x', skipPermissions: false } as SpawnSpec

  it('needs no restart once the process has been told', () => {
    const { p, made, finishTurn } = pool()
    p.send('k', base, {})
    p.noteDirAdded('k', 'D:\\lib')
    finishTurn()
    p.send('k', { ...base, extraArgs: ['--add-dir', 'D:\\lib'] }, {})
    expect(made).toHaveLength(1)
  })

  it('doesn\'t mind the order or the case of the folders', () => {
    const { p, made, finishTurn } = pool()
    p.send('k', { ...base, extraArgs: ['--add-dir', 'D:\\b'] }, {})
    p.noteDirAdded('k', 'd:\\A')
    finishTurn()
    p.send('k', { ...base, extraArgs: ['--add-dir', 'D:\\a', '--add-dir', 'D:\\b'] }, {})
    expect(made).toHaveLength(1)
  })

  it('still restarts a chat that wasn\'t told', () => {
    const { p, made, finishTurn } = pool()
    p.send('k', base, {})
    finishTurn()
    p.send('k', { ...base, extraArgs: ['--add-dir', 'D:\\lib'] }, {})
    expect(made).toHaveLength(1) // closing first, the new process follows its exit
    expect((p as unknown as { waitingForExit: Map<string, unknown[]> }).waitingForExit.get('k')).toHaveLength(1)
  })

  it('ignores a chat with no process', () => {
    const { p } = pool()
    expect(() => p.noteDirAdded('gone', 'D:\\lib')).not.toThrow()
  })
})
