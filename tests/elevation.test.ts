import { describe, it, expect } from 'vitest'
import {
  runKeyAddArgs, runKeyDeleteArgs, schtasksCreateArgs, schtasksDeleteArgs,
  elevatedRelaunchArgs, TASK_NAME, RUN_VALUE_NAME, RUN_KEY
} from '../src/main/elevation'

describe('elevation command builders', () => {
  const exe = 'C:\\Program Files\\Delegatto\\Delegatto.exe'

  it('runKeyAddArgs registers a quoted REG_SZ launch command under HKCU Run', () => {
    const a = runKeyAddArgs(exe)
    expect(a).toEqual(['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', `"${exe}"`, '/f'])
  })

  it('runKeyAddArgs appends app args into the launch command', () => {
    const a = runKeyAddArgs(exe, ['--minimized'])
    expect(a[a.indexOf('/d') + 1]).toBe(`"${exe}" --minimized`)
  })

  it('runKeyDeleteArgs removes the value', () => {
    expect(runKeyDeleteArgs()).toEqual(['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f'])
  })

  it('schtasksCreateArgs sets the two load-bearing flags: /RL HIGHEST and /SC ONLOGON', () => {
    const a = schtasksCreateArgs(exe)
    expect(a).toContain('/rl'); expect(a[a.indexOf('/rl') + 1]).toBe('HIGHEST')
    expect(a).toContain('/sc'); expect(a[a.indexOf('/sc') + 1]).toBe('ONLOGON')
    expect(a).toContain('/tn'); expect(a[a.indexOf('/tn') + 1]).toBe(TASK_NAME)
    expect(a[a.indexOf('/tr') + 1]).toBe(`"${exe}"`)
    expect(a).toContain('/f')
  })

  it('schtasksDeleteArgs removes the task by name', () => {
    expect(schtasksDeleteArgs()).toEqual(['/delete', '/tn', TASK_NAME, '/f'])
  })

  it('elevatedRelaunchArgs uses Start-Process -Verb RunAs (the UAC trigger)', () => {
    const a = elevatedRelaunchArgs(exe)
    const cmd = a[a.indexOf('-Command') + 1]!
    expect(cmd).toContain('Start-Process')
    expect(cmd).toContain('-Verb RunAs')
    expect(cmd).toContain(exe)
  })

  it('elevatedRelaunchArgs passes app args and escapes single quotes', () => {
    const a = elevatedRelaunchArgs(exe, ["--name=it's"])
    const cmd = a[a.indexOf('-Command') + 1]!
    expect(cmd).toContain('-ArgumentList')
    expect(cmd).toContain("it''s") // single quote doubled for PS
  })
})
