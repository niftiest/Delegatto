import { describe, it, expect } from 'vitest'
import { SessionPool, type TransportLike, type TransportFactory } from '../src/main/engine/pool'
import type { SpawnSpec } from '../src/main/engine/transport'
import type { LiveEvent } from '../src/shared/engine-types'

// ---------------------------------------------------------------------------
// Fake transport + factory -- no real processes anywhere in this file.
// ---------------------------------------------------------------------------

class FakeTransport implements TransportLike {
  started = false
  sent: object[] = []
  interruptCalls = 0
  closeCalls = 0
  pid: number | null = null
  private eventListeners: Array<(e: LiveEvent) => void> = []
  private exitListeners: Array<(code: number | null) => void> = []

  constructor(public readonly spec: SpawnSpec) {}

  start(): void {
    this.started = true
  }

  send(msg: object): void {
    this.sent.push(msg)
  }

  interrupt(): void {
    this.interruptCalls++
  }

  close(): void {
    this.closeCalls++
  }

  on(cb: (e: LiveEvent) => void): void {
    this.eventListeners.push(cb)
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitListeners.push(cb)
  }

  // Test-only helpers -- simulate the transport doing something on its own.
  emit(e: LiveEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  fireExit(code: number | null): void {
    for (const cb of this.exitListeners) cb(code)
  }
}

function makeFactory(): { factory: TransportFactory; transports: FakeTransport[] } {
  const transports: FakeTransport[] = []
  const factory: TransportFactory = (spec) => {
    const t = new FakeTransport(spec)
    transports.push(t)
    return t
  }
  return { factory, transports }
}

/** A mutable clock cell so tests can advance "now" deterministically. */
function makeClock(start = 0): { now: () => number; set: (t: number) => void; advance: (dt: number) => void } {
  let t = start
  return {
    now: () => t,
    set: (v: number) => {
      t = v
    },
    advance: (dt: number) => {
      t += dt
    }
  }
}

const spec = (cwd = 'C:\\work'): SpawnSpec => ({ cwd, skipPermissions: false })

// ---------------------------------------------------------------------------

describe('SessionPool — lazy spawn + reuse', () => {
  it('spawns via the factory on first send, starts it, and sends the message', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { type: 'user', message: { role: 'user', content: 'hi' } })

    expect(transports).toHaveLength(1)
    expect(transports[0]!.started).toBe(true)
    expect(transports[0]!.sent).toEqual([{ type: 'user', message: { role: 'user', content: 'hi' } }])
    expect(pool.isLive('s1')).toBe(true)
  })

  it('reuses the same transport for a second send to a live key (no re-spawn)', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    pool.send('s1', spec(), { n: 2 })

    expect(transports).toHaveLength(1)
    expect(transports[0]!.sent).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('spawns independent transports for independent keys', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    pool.send('s2', spec(), { n: 2 })

    expect(transports).toHaveLength(2)
    expect(pool.isLive('s1')).toBe(true)
    expect(pool.isLive('s2')).toBe(true)
  })
})

describe('SessionPool — turnInfo', () => {
  it('reports the running turn, keeps it across messages, and starts over on the next turn', () => {
    const { factory, transports } = makeFactory()
    let now = 1000
    const pool = new SessionPool({ idleReapMs: 100000, transportFactory: factory, now: () => now })
    expect(pool.turnInfo('s1')).toBeNull()

    pool.send('s1', spec(), { n: 1 })
    now = 2000
    transports[0]!.emit({ kind: 'usage', outputTokens: 40 })
    transports[0]!.emit({ kind: 'usage', outputTokens: 2 })
    expect(pool.turnInfo('s1')).toEqual({ startedAt: 1000, tokens: 42, lastActivity: 2000 })

    now = 2500
    pool.send('s1', spec(), { n: 2 }) // joins the same turn
    expect(pool.turnInfo('s1')?.startedAt).toBe(1000)

    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: 'done' })
    expect(pool.turnInfo('s1')).toBeNull()

    now = 3000
    pool.send('s1', spec(), { n: 3 })
    expect(pool.turnInfo('s1')).toEqual({ startedAt: 3000, tokens: 0, lastActivity: 3000 })
  })
})

describe('SessionPool — isTurnRunning (busy vs idle-but-pooled)', () => {
  it('is true while a turn streams and false once its result lands (but stays isLive)', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    expect(pool.isTurnRunning('s1')).toBe(true)

    transports[0]!.emit({ kind: 'delta', text: 'thinking…' })
    expect(pool.isTurnRunning('s1')).toBe(true) // mid-turn events don't end it

    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: 'done' })
    // Turn over: no longer running, but the process stays pooled.
    expect(pool.isTurnRunning('s1')).toBe(false)
    expect(pool.isLive('s1')).toBe(true)
  })

  it('goes busy again on a reused-transport send (the next turn)', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: 'a' })
    expect(pool.isTurnRunning('s1')).toBe(false)

    pool.send('s1', spec(), { n: 2 }) // reuse -> new turn
    expect(pool.isTurnRunning('s1')).toBe(true)
    expect(transports).toHaveLength(1) // no re-spawn
  })

  it('is false for a key that was never sent', () => {
    const { factory } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })
    expect(pool.isTurnRunning('nope')).toBe(false)
  })
})

describe('SessionPool — no limit on chats', () => {
  it('starts every chat straight away, however many are running', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    for (let n = 0; n < 40; n++) pool.send(`s${n}`, spec(), { n })

    expect(transports).toHaveLength(40)
    expect(transports.every(t => t.sent.length === 1)).toBe(true)
    expect(pool.snapshot()).toHaveLength(40)
  })
})

describe('SessionPool — idle reap', () => {
  const done: LiveEvent = { kind: 'result', isError: false, costUsd: 0, text: '' }

  it('gracefully closes a process with nothing running once it has been idle too long', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit(done)

    clock.advance(150)
    pool.reapIdle(clock.now())

    expect(transports[0]!.closeCalls).toBe(1)      // graceful close, not a hard interrupt
    expect(transports[0]!.interruptCalls).toBe(0)
    expect(pool.isLive('s1')).toBe(false)
  })

  it('never closes a chat mid-turn, however long it has been silent', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 }) // a long command, or waiting on a permission answer
    clock.advance(1_000_000)
    pool.reapIdle(clock.now())

    expect(transports[0]!.closeCalls).toBe(0)
    expect(pool.isLive('s1')).toBe(true)

    transports[0]!.emit(done)
    clock.advance(150)
    pool.reapIdle(clock.now())
    expect(pool.isLive('s1')).toBe(false)
  })

  it('uses the idle limit as it stands now, so changing the setting needs no restart', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    let limit = 1000
    const pool = new SessionPool({ idleReapMs: () => limit, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit(done)
    clock.advance(500)
    pool.reapIdle(clock.now())
    expect(pool.isLive('s1')).toBe(true)

    limit = 100
    pool.reapIdle(clock.now())
    expect(pool.isLive('s1')).toBe(false)
  })

  it('counts idle time from when the turn ended', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 })
    clock.advance(500)
    transports[0]!.emit(done)
    clock.advance(50)
    pool.reapIdle(clock.now())

    expect(pool.isLive('s1')).toBe(true)
  })

  it('a message sent while the process is closing waits for it to exit, then resumes', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    let oldLockStands = true
    const refused: LiveEvent[] = []
    const pool = new SessionPool({
      idleReapMs: 100, transportFactory: factory, now: clock.now,
      isExternallyLive: () => transports.length > 0 && oldLockStands
    })
    oldLockStands = false
    pool.on('s1', e => { if (e.kind === 'other') refused.push(e) })

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit(done)
    clock.advance(150)
    pool.reapIdle(clock.now())

    oldLockStands = true // the old process hasn't exited, so its session lock is still there
    pool.send('s1', spec(), { n: 2 })
    pool.send('s1', spec(), { n: 3 })
    expect(transports).toHaveLength(1)
    expect(refused).toEqual([])

    oldLockStands = false
    transports[0]!.fireExit(0)

    expect(transports).toHaveLength(2)
    expect(transports[1]!.sent).toEqual([{ n: 2 }, { n: 3 }])
    expect(refused).toEqual([])
  })

  it('does not reap a transport within the idle window', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 })
    clock.advance(50)
    pool.reapIdle(clock.now())

    expect(transports[0]!.closeCalls).toBe(0)
    expect(pool.isLive('s1')).toBe(true)
  })

  it('activity from an event resets the idle clock, so a busy transport is not reaped', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 })
    clock.advance(80)
    transports[0]!.emit({ kind: 'delta', text: 'x' }) // bumps lastActivity to 80

    clock.advance(80) // now=160, only 80ms since last activity -- under 100
    pool.reapIdle(clock.now())

    expect(transports[0]!.closeCalls).toBe(0)
    expect(pool.isLive('s1')).toBe(true)
  })

  it('reapIdle is a no-op when nothing is idle', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    pool.send('s1', spec(), { n: 1 })
    pool.reapIdle(clock.now())

    expect(transports[0]!.closeCalls).toBe(0)
    expect(pool.isLive('s1')).toBe(true)
  })
})

describe('SessionPool — external-live refusal', () => {
  it('refuses to spawn and emits a refused-external-live event instead', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({
      idleReapMs: 1000,
      transportFactory: factory,
      isExternallyLive: (key) => key === 's1'
    })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e))

    pool.send('s1', spec(), { n: 1 })

    expect(transports).toHaveLength(0)
    expect(pool.isLive('s1')).toBe(false)
    expect(events).toEqual([{ kind: 'other', type: 'refused-external-live' }])
  })

  it('does not refuse a key that is already live under the pool (only gates new spawns)', () => {
    const { factory, transports } = makeFactory()
    let external = false
    const pool = new SessionPool({
      idleReapMs: 1000,
      transportFactory: factory,
      isExternallyLive: () => external
    })

    // Spawn s1 while the predicate is false, then flip it true -- an
    // already-live transport under the pool keeps working normally; the
    // predicate only gates the decision to spawn a NEW one.
    pool.send('s1', spec(), { n: 1 })
    external = true
    pool.send('s1', spec(), { n: 2 })

    expect(transports).toHaveLength(1)
    expect(transports[0]!.sent).toEqual([{ n: 1 }, { n: 2 }])
  })
})

describe('SessionPool — interrupt()', () => {
  it('forwards interrupt to a live transport', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    pool.interrupt('s1')

    expect(transports[0]!.interruptCalls).toBe(1)
  })

  it('is a no-op for a key that is not live', () => {
    const { transports, factory } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    expect(() => pool.interrupt('nope')).not.toThrow()
    expect(transports).toHaveLength(0)
  })

  it('interrupt reaches only the chat it was meant for', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    pool.send('s2', spec(), { n: 2 }) // separate live key, unrelated

    pool.interrupt('s1')

    expect(transports[0]!.interruptCalls).toBe(1)
    expect(transports[1]!.interruptCalls).toBe(0)
    expect(pool.isLive('s1')).toBe(true) // interrupt doesn't dispose by itself
  })
})

describe('SessionPool — event fan-out', () => {
  it('delivers events to all subscribers of a key', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    const a: LiveEvent[] = []
    const b: LiveEvent[] = []
    pool.on('s1', (e) => a.push(e))
    pool.on('s1', (e) => b.push(e))

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit({ kind: 'delta', text: 'x' })

    expect(a).toEqual([{ kind: 'delta', text: 'x' }])
    expect(b).toEqual([{ kind: 'delta', text: 'x' }])
  })

  it('a subscriber registered before the first spawn still receives events once it spawns', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e)) // no transport exists yet

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit({ kind: 'delta', text: 'y' })

    expect(events).toEqual([{ kind: 'delta', text: 'y' }])
  })

  it('a stale (reaped) transport emitting late does not leak into a fresh spawn under the same key', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e))

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    events.length = 0

    clock.advance(150)
    pool.reapIdle(clock.now()) // reaps s1 (graceful close)

    // s1's OLD transport fires a delayed event after being reaped/disposed.
    transports[0]!.emit({ kind: 'other', type: 'late-noise' })

    // Must not appear -- the entry it was wired to is disposed.
    expect(events).toEqual([])
  })

  it('a same-key respawn: the OLD disposed transport late-firing an event and onExit must not touch the NEW transport', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e))

    // Spawn A under key s1.
    pool.send('s1', spec(), { n: 1 })
    expect(transports).toHaveLength(1)
    const transportA = transports[0]!
    transportA.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    events.length = 0

    // Reap A past the idle window -- disposes it.
    clock.advance(150)
    pool.reapIdle(clock.now())
    expect(transportA.closeCalls).toBe(1)
    expect(pool.isLive('s1')).toBe(false)

    // Send to s1 AGAIN -- once A has gone, spawns a distinct transport B under the same key.
    pool.send('s1', spec(), { n: 2 })
    expect(transports).toHaveLength(1)
    transportA.fireExit(0)
    expect(transports).toHaveLength(2)
    const transportB = transports[1]!
    expect(transportB).not.toBe(transportA)
    expect(pool.isLive('s1')).toBe(true)
    expect(transportB.sent).toEqual([{ n: 2 }])

    // The OLD transport A fires a late event after B has been spawned under the same key.
    transportA.emit({ kind: 'other', type: 'late-noise' })

    // No stale event from A reached s1's subscribers.
    expect(events).toEqual([])
    // B is untouched: still live, unaffected by A's late exit.
    expect(pool.isLive('s1')).toBe(true)
    // B is still the sole live entry, still exactly the transport instance
    // spawned for the second send.
    expect(transports).toHaveLength(2)

    // B still receives its own events normally.
    transportB.emit({ kind: 'delta', text: 'from B' })
    expect(events).toEqual([{ kind: 'delta', text: 'from B' }])
  })
})

describe('SessionPool — exit event (Task 10 review Fix 1)', () => {
  it('fans out a {kind: exit, code} event to subscribers when a transport exits WITHOUT ever emitting a result', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e))

    pool.send('s1', spec(), { n: 1 })
    // No delta/assistant/result ever emitted -- e.g. a spawn error or a
    // SIGINT from an interrupt -- just the transport exiting on its own.
    transports[0]!.fireExit(null)

    expect(events).toEqual([{ kind: 'exit', code: null }])
    expect(pool.isLive('s1')).toBe(false)
  })

  it('still fans out exit even after a normal result event, with the exit code preserved', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e))

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0.01, text: 'ok' })
    transports[0]!.fireExit(0)

    expect(events).toEqual([
      { kind: 'result', isError: false, costUsd: 0.01, text: 'ok' },
      { kind: 'exit', code: 0 }
    ])
  })

  it('a disposed (reaped) entry never fires a late exit event -- disposed-flag guard still applies', () => {
    const clock = makeClock(0)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 100, transportFactory: factory, now: clock.now })

    const events: LiveEvent[] = []
    pool.on('s1', (e) => events.push(e))

    pool.send('s1', spec(), { n: 1 })
    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    events.length = 0
    clock.advance(150)
    pool.reapIdle(clock.now()) // disposes s1 via close(), not onExit

    // The OS-level exit for the reaped transport arrives late.
    transports[0]!.fireExit(0)

    expect(events).toEqual([])
  })
})

describe('SessionPool — snapshot() + killByPid()', () => {
  it('snapshot lists live engines with their spec model/effort and pid', () => {
    const clock = makeClock(1000)
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory, now: clock.now })

    pool.send('s1', { cwd: 'C:\\a', skipPermissions: false, model: 'opus', effort: 'high' }, { n: 1 })
    transports[0]!.pid = 4242

    const snap = pool.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ sessionKey: 's1', pid: 4242, model: 'opus', effort: 'high', startedAt: 1000 })
  })

  it('snapshot says whether a turn is running, not just whether the process is loaded', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })
    pool.send('s1', spec(), { n: 1 })
    expect(pool.snapshot()[0]!.busy).toBe(true)
    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: 'done' })
    expect(pool.snapshot()).toHaveLength(1)
    expect(pool.snapshot()[0]!.busy).toBe(false)
  })

  it('killByPid disposes the matching engine (graceful close) and frees its slot', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })
    pool.send('s1', spec(), { n: 1 })
    transports[0]!.pid = 999

    expect(pool.killByPid(999)).toBe(true)
    expect(transports[0]!.closeCalls).toBe(1)
    expect(pool.isLive('s1')).toBe(false)
    expect(pool.killByPid(123456)).toBe(false) // unknown pid
  })
})

describe('SessionPool — shutdown()', () => {
  it('closes every live transport, and nothing starts up again afterwards', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })
    pool.send('s2', spec(), { n: 2 })

    pool.shutdown()

    expect(transports[0]!.closeCalls).toBe(1)
    expect(transports[1]!.closeCalls).toBe(1)
    expect(pool.isLive('s1')).toBe(false)
    expect(pool.isLive('s2')).toBe(false)

    transports[0]!.fireExit(0)
    expect(transports).toHaveLength(2)
  })

  it('is idempotent: calling shutdown() twice does not throw or double-close', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.send('s1', spec(), { n: 1 })

    pool.shutdown()
    expect(() => pool.shutdown()).not.toThrow()
    expect(transports[0]!.closeCalls).toBe(1)
  })

  it('use after shutdown: send() is a safe no-op and spawns nothing', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.shutdown()

    expect(() => pool.send('s1', spec(), { n: 1 })).not.toThrow()
    expect(transports).toHaveLength(0)
    expect(pool.isLive('s1')).toBe(false)
  })

  it('use after shutdown: interrupt() and reapIdle() are also safe no-ops', () => {
    const { factory } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 1000, transportFactory: factory })

    pool.shutdown()

    expect(() => pool.interrupt('s1')).not.toThrow()
    expect(() => pool.reapIdle(999999)).not.toThrow()
  })
})

describe('SessionPool.releaseIdle (terminal takeover)', () => {
  const spec: SpawnSpec = { cwd: 'C:\proj', skipPermissions: true, resumeId: 'r' }

  it('closes an idle pooled transport so the next send respawns fresh', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 60_000, transportFactory: factory })
    pool.send('k', spec, { n: 1 })
    transports[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: 'done' }) // turn finished -> idle
    expect(pool.releaseIdle('k')).toBe(true)
    expect(transports[0]!.closeCalls).toBe(1)
    expect(pool.isLive('k')).toBe(false)
    pool.send('k', spec, { n: 2 })
    expect(transports).toHaveLength(2) // respawned, not reused
  })

  it('leaves a mid-turn transport alone', () => {
    const { factory, transports } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 60_000, transportFactory: factory })
    pool.send('k', spec, { n: 1 })
    expect(pool.releaseIdle('k')).toBe(false)
    expect(transports[0]!.closeCalls).toBe(0)
    expect(pool.isLive('k')).toBe(true)
  })

  it('is a no-op for an unknown key', () => {
    const { factory } = makeFactory()
    const pool = new SessionPool({ idleReapMs: 60_000, transportFactory: factory })
    expect(pool.releaseIdle('nope')).toBe(false)
  })
})
