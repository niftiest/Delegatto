import { describe, it, expect } from 'vitest'
import { classifyEvent, classifyPermission, inQuietHours, notificationBody, shouldNotify } from '../src/main/notify-rules'
import { DEFAULT_SETTINGS } from '../src/main/catalog/settings'
import { safeExtraFlags, buildArgs } from '../src/main/engine/transport'

const at = (h: number, m = 0): Date => new Date(2026, 0, 1, h, m)

describe('notifications', () => {
  it('quiet hours, including a window across midnight', () => {
    expect(inQuietHours('22:00', '07:00', at(23))).toBe(true)
    expect(inQuietHours('22:00', '07:00', at(6, 59))).toBe(true)
    expect(inQuietHours('22:00', '07:00', at(7))).toBe(false)
    expect(inQuietHours('12:00', '13:00', at(12, 30))).toBe(true)
    expect(inQuietHours('12:00', '13:00', at(13))).toBe(false)
    expect(inQuietHours(null, '07:00', at(3))).toBe(false)
    expect(inQuietHours('25:00', '07:00', at(3))).toBe(false)
  })

  it('respects each toggle, do not disturb and quiet hours', () => {
    expect(shouldNotify('turnComplete', DEFAULT_SETTINGS, at(12))).toBe(true)
    expect(shouldNotify('turnComplete', { ...DEFAULT_SETTINGS, notifyTurnComplete: false }, at(12))).toBe(false)
    expect(shouldNotify('permission', { ...DEFAULT_SETTINGS, doNotDisturb: true }, at(12))).toBe(false)
    expect(shouldNotify('error', { ...DEFAULT_SETTINGS, quietHoursStart: '11:00', quietHoursEnd: '13:00' }, at(12))).toBe(false)
  })

  it('classifies events and requests', () => {
    expect(classifyEvent({ kind: 'result', isError: false, costUsd: 0, text: 'done' })).toBe('turnComplete')
    expect(classifyEvent({ kind: 'result', isError: true, costUsd: 0, text: 'x' })).toBe('error')
    expect(classifyEvent({ kind: 'exit', code: 1 })).toBe('error')
    expect(classifyEvent({ kind: 'exit', code: 0 })).toBeNull()
    expect(classifyEvent({ kind: 'exit', code: null })).toBeNull() // Esc / interrupt
    expect(classifyEvent({ kind: 'delta', text: 'x' })).toBeNull()
    expect(classifyPermission({ id: '1', tool: 'ExitPlanMode', input: {}, sessionKey: 'k' })).toBe('inputNeeded')
    expect(classifyPermission({ id: '1', tool: 'Bash', input: {}, sessionKey: 'k' })).toBe('permission')
    expect(notificationBody('permission', { tool: 'Bash' })).toMatch(/Bash/)
    expect(notificationBody('turnComplete', { text: 'a'.repeat(500) }).length).toBeLessThanOrEqual(140)
  })
})

describe('extra CLI flags and the spending cap', () => {
  it('drops flags Delegatto manages, with their values', () => {
    expect(safeExtraFlags(['--add-dir', 'D:\\x', '--resume', 'abc', '--verbose', '--output-format=json', '-p', '--model', 'opus']))
      .toEqual(['--add-dir', 'D:\\x', '--verbose', '--model', 'opus'])
  })

  it('passes --max-budget-usd only for a positive cap', () => {
    expect(buildArgs({ cwd: 'C:\\x', skipPermissions: true, maxBudgetUsd: 2.5 })).toEqual(expect.arrayContaining(['--max-budget-usd', '2.5']))
    expect(buildArgs({ cwd: 'C:\\x', skipPermissions: true })).not.toContain('--max-budget-usd')
  })
})
