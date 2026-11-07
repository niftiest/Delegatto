import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLiveSessions } from '../../src/main/manage/live'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

describe('getLiveSessions (port of LiveSessionDetectorTests)', () => {
  it('returns only alive pids', () => {
    const t = tree()
    t.addLiveSession(100, 's1', 'D:\\GIT\\a', 'alpha')
    t.addLiveSession(200, 's2', 'D:\\GIT\\b', 'beta')
    const result = getLiveSessions(t.paths, pid => pid === 200)
    expect(result).toEqual([{ pid: 200, sessionId: 's2', cwd: 'D:\\GIT\\b', name: 'beta', procStart: null }])
  })

  it('reads procStart as a string or a number, exactly', () => {
    const t = tree()
    mkdirSync(t.paths.sessionsDir, { recursive: true })
    writeFileSync(join(t.paths.sessionsDir, '1.json'), '{"pid":1,"procStart":"134378081698279310"}')
    writeFileSync(join(t.paths.sessionsDir, '2.json'), '{"pid":2,"procStart":42}')
    // A JSON number past 2^53: JSON.parse rounds it, the raw literal must be kept.
    writeFileSync(join(t.paths.sessionsDir, '4.json'), '{"pid":4,"procStart":134379903492969987}')
    writeFileSync(join(t.paths.sessionsDir, '5.json'), '{"pid":5,"procStart":"-5"}')
    t.addLiveSession(3, 's3', 'D:\\c')
    const byPid = new Map(getLiveSessions(t.paths, () => true).map(s => [s.pid, s]))
    expect(byPid.get(1)!.procStart).toBe('134378081698279310')
    expect(byPid.get(2)!.procStart).toBe('42')
    expect(byPid.get(4)!.procStart).toBe('134379903492969987')
    expect(byPid.get(5)!.procStart).toBeNull()
    expect(byPid.get(3)!.procStart).toBeNull()
  })

  it('ignores .bak and garbage files', () => {
    const t = tree()
    const f = t.addLiveSession(100, 's1', 'D:\\GIT\\a')
    copyFileSync(f, f + '.bak')
    writeFileSync(join(t.paths.sessionsDir, '100.abc123.key'), 'secret')
    writeFileSync(join(t.paths.sessionsDir, 'garbage.json'), '{not json')
    expect(getLiveSessions(t.paths, () => true).map(s => s.pid)).toEqual([100])
  })

  it('an unparseable pid-named file falls back to the pid in its name', () => {
    const t = tree()
    mkdirSync(t.paths.sessionsDir, { recursive: true })
    writeFileSync(join(t.paths.sessionsDir, '4242.json'), '{not json')
    const s = getLiveSessions(t.paths, pid => pid === 4242)
    expect(s).toEqual([{ pid: 4242, sessionId: '', cwd: '', name: null, procStart: null }])
  })

  it('a lock without a sessionId still counts as live (the engine reader skips it)', () => {
    const t = tree()
    mkdirSync(t.paths.sessionsDir, { recursive: true })
    writeFileSync(join(t.paths.sessionsDir, '9.json'), '{"pid":9,"cwd":"D:\\\\x","name":""}')
    expect(getLiveSessions(t.paths, () => true)).toEqual([{ pid: 9, sessionId: '', cwd: 'D:\\x', name: null, procStart: null }])
  })

  it('a missing sessions dir means no sessions', () => {
    expect(getLiveSessions(tree().paths, () => true)).toEqual([])
  })

  it('the default isAlive detects the current process and a missing pid', () => {
    const t = tree()
    t.addLiveSession(process.pid, 's1', 'D:\\x')
    t.addLiveSession(2147483647, 's2', 'D:\\y')
    expect(getLiveSessions(t.paths).map(s => s.pid)).toEqual([process.pid])
  })
})
