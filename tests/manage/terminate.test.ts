import { describe, it, expect } from 'vitest'
import {
  endAll, buildInspectScript, parseInspectOutput, windowsProcessControl, type ProcessControl, type ProcessInfo
} from '../../src/main/manage/terminate'
import type { LiveSession } from '../../src/main/manage/live'

/** A fake OS: no real process is ever looked up or killed. */
function fakeControl(procs: ProcessInfo[], opts: { ownPid?: number; exits?: boolean; killError?: NodeJS.ErrnoException } = {}) {
  const killed: number[] = []
  const inspected: number[][] = []
  const control: ProcessControl = {
    ownPid: opts.ownPid ?? 1,
    async inspect(pids) {
      inspected.push(pids)
      return new Map(procs.filter(p => pids.includes(p.pid)).map(p => [p.pid, p]))
    },
    kill(pid) {
      if (opts.killError) throw opts.killError
      killed.push(pid)
    },
    async waitForExit() { return opts.exits ?? true }
  }
  return { control, killed, inspected }
}

const START = '134379903492969987'
const running = (pid: number, name = 'ping', start: string | null = START, error: string | null = null): ProcessInfo =>
  ({ pid, found: true, name, exited: false, startFileTime: start, error })
const session = (pid: number, procStart: string | null = null): LiveSession =>
  ({ pid, sessionId: 's' + pid, cwd: 'D:\\x', name: 'a', procStart })

describe('endAll (port of SessionTerminatorTests)', () => {
  it('ends a process whose start time matches', async () => {
    const f = fakeControl([running(100)])
    const r = await endAll([session(100, START)], f.control)
    expect(r.failures).toEqual([])
    expect(r.ended.map(s => s.pid)).toEqual([100])
    expect(f.killed).toEqual([100])
  })

  it('compares start times exactly as integers (no precision loss)', async () => {
    const f = fakeControl([running(100, 'ping', '0' + START)])
    const r = await endAll([session(100, START)], f.control)
    expect(r.ended.map(s => s.pid)).toEqual([100])
  })

  it('refuses a reused pid with another start time (off by one tick)', async () => {
    const f = fakeControl([running(100)])
    const r = await endAll([session(100, (BigInt(START) - 1n).toString())], f.control)
    expect(r.ended).toEqual([])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.error).toContain('different time')
    expect(f.killed).toEqual([])
  })

  it('without a start time, refuses a process not named claude', async () => {
    const f = fakeControl([running(100, 'ping')])
    const r = await endAll([session(100)], f.control)
    expect(r.ended).toEqual([])
    expect(r.failures[0]!.error).toContain('could not confirm')
    expect(r.failures[0]!.error).toContain('"ping"')
    expect(f.killed).toEqual([])
  })

  it('without a start time, ends a process named claude*', async () => {
    const f = fakeControl([running(100, 'Claude')])
    const r = await endAll([session(100)], f.control)
    expect(r.ended.map(s => s.pid)).toEqual([100])
    expect(f.killed).toEqual([100])
  })

  it('a gone process counts as ended and the own process is never ended', async () => {
    const f = fakeControl([], { ownPid: 4242 })
    const r = await endAll([session(2147483647), session(4242)], f.control)
    expect(r.ended.map(s => s.pid)).toEqual([2147483647])
    expect(r.failures.map(s => s.session.pid)).toEqual([4242])
    expect(f.inspected).toEqual([[2147483647]])
    expect(f.killed).toEqual([])
  })

  it('an already-exited process counts as ended without a kill', async () => {
    const f = fakeControl([{ pid: 100, found: true, name: 'ping', exited: true, startFileTime: null, error: null }])
    const r = await endAll([session(100, START)], f.control)
    expect(r.ended.map(s => s.pid)).toEqual([100])
    expect(f.killed).toEqual([])
  })

  it('an unreadable start time is a refusal, not a kill', async () => {
    const f = fakeControl([running(100, 'claude', null, 'Access is denied')])
    const r = await endAll([session(100, START)], f.control)
    expect(r.ended).toEqual([])
    expect(r.failures[0]!.error).toContain('Access is denied')
    expect(f.killed).toEqual([])
  })

  it('reports a process that did not exit in time', async () => {
    const f = fakeControl([running(100)], { exits: false })
    const r = await endAll([session(100, START)], f.control)
    expect(r.failures.map(x => x.error)).toEqual(['The process did not exit in time.'])
  })

  it('reports a kill error; ESRCH means it already exited', async () => {
    const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    let r = await endAll([session(100, START)], fakeControl([running(100)], { killError: eperm }).control)
    expect(r.failures.map(x => x.error)).toEqual(['kill EPERM'])
    const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    r = await endAll([session(100, START)], fakeControl([running(100)], { killError: esrch }).control)
    expect(r.ended.map(s => s.pid)).toEqual([100])
  })

  it('duplicates by pid are handled once, and one lookup covers every pid', async () => {
    const f = fakeControl([running(100), running(200)])
    const r = await endAll([session(100, START), session(100, START), session(200, START)], f.control)
    expect(r.ended.map(s => s.pid)).toEqual([100, 200])
    expect(f.inspected).toEqual([[100, 200]])
  })

  it('a failed lookup fails every session and kills nothing', async () => {
    const control: ProcessControl = {
      ownPid: 1, async inspect() { throw new Error('powershell missing') },
      kill() { throw new Error('must not kill') }, async waitForExit() { return true }
    }
    const r = await endAll([session(100, START)], control)
    expect(r.ended).toEqual([])
    expect(r.failures[0]!.error).toContain('powershell missing')
  })
})

describe('PowerShell inspector', () => {
  it('builds a script only from integer pids', () => {
    expect(buildInspectScript([12, 34])).toContain('@(12,34)')
    expect(() => buildInspectScript([1.5])).toThrow()
    expect(() => buildInspectScript([-1])).toThrow()
  })

  it('parses an array, a single object, and empty output', () => {
    const m = parseInspectOutput(JSON.stringify([
      { pid: 1, found: false },
      { pid: 2, found: true, name: 'claude', exited: false, start: START, error: null }
    ]))
    expect(m.get(1)).toEqual({ pid: 1, found: false })
    expect(m.get(2)).toEqual({ pid: 2, found: true, name: 'claude', exited: false, startFileTime: START, error: null })
    expect(parseInspectOutput('{"pid":3,"found":false}').get(3)).toEqual({ pid: 3, found: false })
    expect(parseInspectOutput('  ').size).toBe(0)
  })

  // Read-only: looks up this test process and a pid that can't exist. Never kills.
  it.runIf(process.platform === 'win32')('reads the real start time of this process at full FILETIME precision', async () => {
    const m = await windowsProcessControl.inspect([process.pid, 2147483644])
    const self = m.get(process.pid)
    expect(self?.found).toBe(true)
    if (self?.found) {
      expect(self.startFileTime).toMatch(/^\d{17,18}$/)
      // FILETIME of the start, within a day of now.
      const ms = Number(BigInt(self.startFileTime!) / 10000n) - 11644473600000
      expect(Math.abs(Date.now() - ms)).toBeLessThan(86_400_000)
      expect(self.name.length).toBeGreaterThan(0)
    }
    expect(m.get(2147483644)).toEqual({ pid: 2147483644, found: false })
  }, 30_000)
})
