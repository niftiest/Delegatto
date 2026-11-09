// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Transcript } from '../../src/renderer/components/Transcript'

const run = (output: string) => [
  { kind: 'text' as const, uuid: 'r1', role: 'user' as const, ts: '2026-11-09T10:00:00Z', model: null, text: '!az login' },
  { kind: 'text' as const, uuid: 'r1', role: 'assistant' as const, ts: '2026-11-09T10:00:00Z', model: null, text: output, literal: true }
]
const show = (output: string, pinned: ReadonlySet<string> = new Set()) =>
  render(<Transcript items={run(output)} hasMore={false} loadingOlder={false} loading={false} onReachTop={() => {}} pinnedUuids={pinned} />).container

describe('what a ! command printed', () => {
  it('is folded to one line until it is opened', () => {
    const c = show('To sign in, open https://microsoft.com/devicelogin\nand enter the code ABC123\n[exit code 0]')
    const details = c.querySelector('.shell-output-card details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(c.querySelector('.shell-output-label')?.textContent).toBe('Output · 3 lines')
    expect(c.querySelector('.shell-output-preview')?.textContent).toBe('To sign in, open https://microsoft.com/devicelogin')
    expect(details.querySelector('pre.shell-output')?.textContent).toContain('ABC123')
  })

  it('says 1 line for one line, and still shows the command as typed', () => {
    const c = show('az: command not found')
    expect(c.querySelector('.shell-output-label')?.textContent).toBe('Output · 1 line')
    expect(c.querySelector('.bubble-me')?.textContent).toBe('!az login')
  })

  it('keeps its pin visible while folded', () => {
    const c = show('done', new Set(['r1']))
    expect(c.querySelector('.shell-output-card > .pin-badge')).not.toBeNull()
  })
})
