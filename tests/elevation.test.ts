import { describe, it, expect } from 'vitest'
import {
  runKeyAddArgs, runKeyDeleteArgs, schtasksCreateArgs, schtasksDeleteArgs,
  elevatedRelaunchArgs, TASK_NAME, RUN_VALUE_NAME, RUN_KEY,
  ELEVATED_RELAUNCH_ARG, LOCK_RETRY_FOR_MS, LOCK_RETRY_EVERY_MS, relaunchEnv, shouldRetryInstanceLock
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

  it('elevatedRelaunchArgs passes the relaunch marker to the elevated instance', () => {
    const a = elevatedRelaunchArgs(exe, [ELEVATED_RELAUNCH_ARG])
    const cmd = a[a.indexOf('-Command') + 1]!
    expect(ELEVATED_RELAUNCH_ARG).toBe('--elevated-relaunch')
    expect(cmd).toContain(`-ArgumentList '${ELEVATED_RELAUNCH_ARG}'`)
  })

  it('elevatedRelaunchArgs exits non-zero when Start-Process fails (UAC declined)', () => {
    const a = elevatedRelaunchArgs(exe)
    expect(a).toContain('-NonInteractive')
    const cmd = a[a.indexOf('-Command') + 1]!
    expect(cmd).toMatch(/^try \{ Start-Process .* -ErrorAction Stop \} catch \{ exit 1 \}$/)
  })
})

describe('relaunchEnv', () => {
  it('drops the portable launcher variables and keeps the rest', () => {
    const env = relaunchEnv({ PATH: 'C:\\x', PORTABLE_EXECUTABLE_FILE: 'a', PORTABLE_EXECUTABLE_DIR: 'b', PORTABLE_EXECUTABLE_APP_FILENAME: 'c' })
    expect(env).toEqual({ PATH: 'C:\\x' })
  })
})

describe('shouldRetryInstanceLock', () => {
  it('never retries a normal launch: a second launch quits at once as before', () => {
    expect(shouldRetryInstanceLock(['Delegatto.exe'], 0)).toBe(false)
    expect(shouldRetryInstanceLock(['Delegatto.exe', '--autostart'], 0)).toBe(false)
  })

  it('retries an elevated relaunch while the old instance is quitting', () => {
    const argv = ['Delegatto.exe', ELEVATED_RELAUNCH_ARG]
    expect(shouldRetryInstanceLock(argv, 0)).toBe(true)
    expect(shouldRetryInstanceLock(argv, LOCK_RETRY_FOR_MS - 1)).toBe(true)
  })

  it('gives up after about ten seconds', () => {
    const argv = ['Delegatto.exe', ELEVATED_RELAUNCH_ARG]
    expect(LOCK_RETRY_FOR_MS).toBe(10_000)
    expect(LOCK_RETRY_EVERY_MS).toBe(250)
    expect(shouldRetryInstanceLock(argv, LOCK_RETRY_FOR_MS)).toBe(false)
    expect(shouldRetryInstanceLock(argv, LOCK_RETRY_FOR_MS + 5_000)).toBe(false)
  })
})
