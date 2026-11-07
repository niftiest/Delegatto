import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/api', () => ({ api: {} }))
import { retentionWarning } from '../src/renderer/components/RetentionNotice'
import type { RetentionStatus } from '../src/shared/claude-settings-types'

const status = (s: Partial<RetentionStatus>): RetentionStatus => ({ claudeDays: 30, claudeDaysSet: false, overrides: [], ...s }) as RetentionStatus

describe('retentionWarning', () => {
  it('warns about the default the user never chose', () => {
    expect(retentionWarning(status({}))).toContain('unless you change it')
  })
  it('stays quiet once the user has set a period, even a short one', () => {
    expect(retentionWarning(status({ claudeDays: 3650, claudeDaysSet: true }))).toBeNull()
    expect(retentionWarning(status({ claudeDays: 30, claudeDaysSet: true }))).toBeNull()
  })
  it('still warns when a project file sets a shorter period', () => {
    const overrides = [{ file: 'x', cwd: 'x', days: 7 }] as RetentionStatus['overrides']
    expect(retentionWarning(status({ claudeDays: 3650, claudeDaysSet: true, overrides }))).toContain('7 days')
  })
})
