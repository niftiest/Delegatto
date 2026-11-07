import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveSessions, isPidAlive, sessionIdFromFilePath, isExternallyLiveSession, sweepStaleSdkLocks, parseProcStart } from '../src/main/engine/live-sessions'

describe('live-sessions', () => {
  it('reads and tolerantly parses sessions/*.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ls-'))
    try {
      writeFileSync(join(dir, '111.json'), JSON.stringify({ pid: 111, sessionId: 'aaa', cwd: 'C:\\x', status: 'busy' }))
      writeFileSync(join(dir, '222.json'), JSON.stringify({ pid: 222, sessionId: 'bbb' }))
      writeFileSync(join(dir, 'bad.json'), 'not json{')
      writeFileSync(join(dir, 'nopid.json'), JSON.stringify({ sessionId: 'ccc' }))
      writeFileSync(join(dir, 'ignore.txt'), 'x')
      const s = readLiveSessions(dir)
      expect(s.map(e => e.sessionId).sort()).toEqual(['aaa', 'bbb'])
      expect(s.find(e => e.pid === 111)?.status).toBe('busy')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns [] for a missing sessions dir', () => {
    expect(readLiveSessions('/no/such/dir/xyz')).toEqual([])
  })

  it('isPidAlive: ESRCH -> dead, EPERM -> alive, no throw -> alive', () => {
    expect(isPidAlive(1, () => { const e = new Error() as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e })).toBe(false)
    expect(isPidAlive(1, () => { const e = new Error() as NodeJS.ErrnoException; e.code = 'EPERM'; throw e })).toBe(true)
    expect(isPidAlive(1, () => {})).toBe(true)
  })

  it('sessionIdFromFilePath strips the .jsonl', () => {
    expect(sessionIdFromFilePath('C:\\p\\C--Demo\\7600a514.jsonl')).toBe('7600a514')
  })

  const ours = (pid: number | null, startedAt = 1000) => () => [{ sessionKey: 'x/aaa.jsonl', pid, startedAt }]
  const none = () => []

  it('isExternallyLiveSession: a lock whose pid is our own spawn is never flagged', () => {
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: ours(111),
      readSessions: () => [{ pid: 111, sessionId: 'aaa', cwd: '', entrypoint: 'sdk-cli' }], isAlive: () => true
    })).toBe(false)
  })

  it('isExternallyLiveSession: an sdk-cli lock from a relaunched child of our spawn is ours', () => {
    // Observed on Windows: claude.exe relaunches itself; the CHILD pid writes the lock.
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: ours(111, 1000),
      readSessions: () => [{ pid: 222, sessionId: 'aaa', cwd: '', entrypoint: 'sdk-cli', startedAt: 1500 }], isAlive: () => true
    })).toBe(false)
  })

  it('isExternallyLiveSession: a terminal that resumed a chat our pool holds idle IS external', () => {
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: ours(111, 1000),
      readSessions: () => [
        { pid: 111, sessionId: 'aaa', cwd: '', entrypoint: 'sdk-cli', startedAt: 1000 },
        { pid: 333, sessionId: 'aaa', cwd: '', entrypoint: 'cli', startedAt: 5000 }
      ], isAlive: () => true
    })).toBe(true)
  })

  it('isExternallyLiveSession: an sdk-cli lock that predates our spawn is not ours', () => {
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: ours(111, 100_000),
      readSessions: () => [{ pid: 222, sessionId: 'aaa', cwd: '', entrypoint: 'sdk-cli', startedAt: 1000 }], isAlive: () => true
    })).toBe(true)
  })

  it('isExternallyLiveSession: an unowned session with a matching live pid IS external', () => {
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: none,
      readSessions: () => [{ pid: 111, sessionId: 'aaa', cwd: '' }], isAlive: () => true
    })).toBe(true)
  })

  it('isExternallyLiveSession: a matching session whose pid is DEAD is not external (stale file)', () => {
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: none,
      readSessions: () => [{ pid: 111, sessionId: 'aaa', cwd: '' }], isAlive: () => false
    })).toBe(false)
  })

  it('isExternallyLiveSession: no matching sessionId is not external', () => {
    expect(isExternallyLiveSession('x/aaa.jsonl', {
      sessionsDir: 'd', owned: none,
      readSessions: () => [{ pid: 111, sessionId: 'other', cwd: '' }], isAlive: () => true
    })).toBe(false)
  })

  it('readLiveSessions captures bridgeSessionId (Remote Control) only when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ls-'))
    try {
      writeFileSync(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'a', cwd: '', bridgeSessionId: 'session_01' }))
      writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'b', cwd: '' }))
      const all = readLiveSessions(dir)
      expect(all.find(e => e.pid === 1)?.bridgeSessionId).toBe('session_01')
      expect(all.find(e => e.pid === 2)?.bridgeSessionId).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('readLiveSessions captures the entrypoint field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ls-'))
    try {
      writeFileSync(join(dir, '111.json'), JSON.stringify({ pid: 111, sessionId: 'aaa', cwd: 'C:\\x', entrypoint: 'sdk-cli' }))
      expect(readLiveSessions(dir).find(e => e.pid === 111)?.entrypoint).toBe('sdk-cli')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('readLiveSessions captures procStart (exact, as a string) and a non-empty name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ls-'))
    try {
      writeFileSync(join(dir, '1.json'), '{"pid":1,"sessionId":"a","procStart":"134379903492969987","name":"git-b2"}')
      writeFileSync(join(dir, '2.json'), '{"pid":2,"sessionId":"b","procStart":134379903492969987,"name":""}')
      writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: 'c' }))
      const by = new Map(readLiveSessions(dir).map(e => [e.pid, e]))
      expect(by.get(1)).toMatchObject({ procStart: '134379903492969987', name: 'git-b2' })
      expect(by.get(2)!.procStart).toBe('134379903492969987')
      expect(by.get(2)!.name).toBeUndefined()
      expect('procStart' in by.get(3)!).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('parseProcStart: digits-only strings, int64 numbers, else undefined', () => {
    expect(parseProcStart('0042')).toBe('42')
    expect(parseProcStart(42)).toBe('42')
    expect(parseProcStart(' 42')).toBeUndefined()
    expect(parseProcStart('-1')).toBeUndefined()
    expect(parseProcStart('99999999999999999999')).toBeUndefined()
    expect(parseProcStart(1.5)).toBeUndefined()
    expect(parseProcStart(null)).toBeUndefined()
    // Unsafe number without the raw text: can't be exact, so refused.
    expect(parseProcStart(134379903492969987)).toBeUndefined()
  })

  describe('sweepStaleSdkLocks', () => {
    it('removes only dead-pid sdk-cli locks, leaving live ones and non-sdk locks alone', () => {
      const removed: string[] = []
      const sessions = [
        { pid: 1, sessionId: 'a', cwd: '', entrypoint: 'sdk-cli' },   // dead + ours -> remove
        { pid: 2, sessionId: 'b', cwd: '', entrypoint: 'sdk-cli' },   // alive + ours -> keep
        { pid: 3, sessionId: 'c', cwd: '', entrypoint: 'cli' },       // dead but a real terminal -> keep
        { pid: 4, sessionId: 'd', cwd: '' }                            // dead, unknown entrypoint -> keep
      ]
      const alivePids = new Set([2])
      const n = sweepStaleSdkLocks('sess', {
        readSessions: () => sessions,
        isAlive: (pid) => alivePids.has(pid),
        unlink: (p) => removed.push(p)
      })
      expect(n).toBe(1)
      expect(removed).toEqual([join('sess', '1.json')])
    })

    it('removes nothing when there are no stale sdk-cli locks', () => {
      const removed: string[] = []
      const n = sweepStaleSdkLocks('sess', {
        readSessions: () => [{ pid: 9, sessionId: 'z', cwd: '', entrypoint: 'sdk-cli' }],
        isAlive: () => true,
        unlink: (p) => removed.push(p)
      })
      expect(n).toBe(0)
      expect(removed).toEqual([])
    })

    it('actually deletes the file on disk end-to-end', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cc-sweep-'))
      try {
        writeFileSync(join(dir, '5.json'), JSON.stringify({ pid: 5, sessionId: 'a', cwd: '', entrypoint: 'sdk-cli' }))
        writeFileSync(join(dir, '6.json'), JSON.stringify({ pid: 6, sessionId: 'b', cwd: '', entrypoint: 'cli' }))
        const n = sweepStaleSdkLocks(dir, { isAlive: () => false })
        expect(n).toBe(1)
        expect(readLiveSessions(dir).map(e => e.pid)).toEqual([6]) // only the cli lock remains
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  })
})
