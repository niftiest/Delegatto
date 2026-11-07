import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LockMonitor, type LockTarget } from '../src/main/engine/lock-monitor'
import type { LiveSessionEntry, OwnedProcess } from '../src/main/engine/live-sessions'
import type { ExternalLock } from '../src/shared/engine-types'

const TARGETS: Record<string, LockTarget> = {
  aaa: { sessionPk: 1, filePath: 'p/aaa.jsonl', projectId: 10 },
  bbb: { sessionPk: 2, filePath: 'p/bbb.jsonl', projectId: 20 }
}

function make(opts: { sessions: () => LiveSessionEntry[]; owned?: () => OwnedProcess[]; alive?: (pid: number) => boolean }) {
  const changes: Array<[number, ExternalLock | null]> = []
  const m = new LockMonitor({
    sessionsDir: 'unused',
    owned: opts.owned ?? (() => []),
    resolve: id => TARGETS[id] ?? null,
    onChange: (t, lock) => changes.push([t.sessionPk, lock]),
    readSessions: opts.sessions,
    isAlive: opts.alive ?? (() => true)
  })
  return { m, changes }
}

describe('LockMonitor.refresh', () => {
  it('reports a terminal taking a chat, status changes, and its release -- once each', () => {
    let sessions: LiveSessionEntry[] = [{ pid: 9, sessionId: 'aaa', cwd: '', entrypoint: 'cli', status: 'idle' }]
    const { m, changes } = make({ sessions: () => sessions })
    m.refresh()
    m.refresh() // no change -> no duplicate event
    expect(changes).toEqual([[1, { pid: 9, entrypoint: 'cli', status: 'idle' }]])
    expect(m.get(1)).toEqual({ pid: 9, entrypoint: 'cli', status: 'idle' })
    expect(m.get(2)).toBeNull()

    sessions = [{ pid: 9, sessionId: 'aaa', cwd: '', entrypoint: 'cli', status: 'busy' }]
    m.refresh()
    expect(changes.at(-1)).toEqual([1, { pid: 9, entrypoint: 'cli', status: 'busy' }])

    sessions = []
    m.refresh()
    expect(changes.at(-1)).toEqual([1, null])
    expect(m.get(1)).toBeNull()
  })

  it('ignores our own process, unknown sessions, and dead pids', () => {
    const { m, changes } = make({
      sessions: () => [
        { pid: 5, sessionId: 'aaa', cwd: '', entrypoint: 'sdk-cli' },   // ours
        { pid: 6, sessionId: 'zzz', cwd: '', entrypoint: 'cli' },       // not in catalog
        { pid: 7, sessionId: 'bbb', cwd: '', entrypoint: 'cli' }        // crashed (dead pid)
      ],
      owned: () => [{ sessionKey: 'p/aaa.jsonl', pid: 5, startedAt: 0 }],
      alive: pid => pid !== 7
    })
    m.refresh()
    expect(changes).toEqual([])
  })

  it('unlocks when the holding pid dies without removing its lock file', () => {
    let alive = true
    const { m, changes } = make({
      sessions: () => [{ pid: 9, sessionId: 'aaa', cwd: '', entrypoint: 'cli' }],
      alive: () => alive
    })
    m.refresh()
    alive = false
    m.refresh()
    expect(changes.map(c => c[1] === null)).toEqual([false, true])
  })
})

describe('LockMonitor remote control', () => {
  it('reports chats whose live lock carries a bridgeSessionId (ours or not), only on change', () => {
    let sessions: LiveSessionEntry[] = [
      { pid: 5, sessionId: 'aaa', cwd: '', entrypoint: 'sdk-cli', bridgeSessionId: 'session_x' }, // ours
      { pid: 7, sessionId: 'bbb', cwd: '', entrypoint: 'cli' }                                    // no RC
    ]
    const remotes: unknown[] = []
    const m = new LockMonitor({
      sessionsDir: 'unused', owned: () => [{ sessionKey: 'p/aaa.jsonl', pid: 5, startedAt: 0 }],
      resolve: id => TARGETS[id] ?? null, onChange: () => {}, onRemoteChange: r => remotes.push(r),
      readSessions: () => sessions, isAlive: () => true
    })
    m.refresh(); m.refresh()
    expect(remotes).toEqual([[{ sessionPk: 1, projectId: 10 }]])
    expect(m.getRemote()).toEqual([{ sessionPk: 1, projectId: 10 }])
    sessions = [{ pid: 7, sessionId: 'bbb', cwd: '', entrypoint: 'cli', bridgeSessionId: 'session_y' }]
    m.refresh()
    expect(remotes.at(-1)).toEqual([{ sessionPk: 2, projectId: 20 }])
    sessions = []
    m.refresh()
    expect(remotes.at(-1)).toEqual([])
  })
})

describe('LockMonitor watch (real fs)', () => {
  let dir: string | null = null
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null })

  it('notices a lock file appearing and disappearing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-lockmon-'))
    const changes: Array<[number, ExternalLock | null]> = []
    const m = new LockMonitor({
      sessionsDir: dir, owned: () => [], resolve: id => TARGETS[id] ?? null,
      onChange: (t, lock) => changes.push([t.sessionPk, lock]),
      isAlive: () => true, debounceMs: 20
    })
    m.start()
    await new Promise(r => setTimeout(r, 300)) // let chokidar attach
    writeFileSync(join(dir, '9.json'), JSON.stringify({ pid: 9, sessionId: 'aaa', cwd: '', entrypoint: 'cli' }))
    await waitFor(() => changes.length === 1)
    rmSync(join(dir, '9.json'))
    await waitFor(() => changes.length === 2)
    expect(changes[1]).toEqual([1, null])
    m.dispose()
  }, 10_000)
})

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 25))
  }
}
