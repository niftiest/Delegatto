// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BlockedBanner, waitedFor } from '../../src/renderer/components/BlockedBanner'

const noop = (): void => {}

describe('the bar for another chat waiting on an answer', () => {
  it('counts how long it has waited, since nothing ends the wait but an answer', () => {
    expect(waitedFor(20_000)).toBe('just now')
    expect(waitedFor(4 * 60_000 + 59_000)).toBe('4m')
    expect(waitedFor(72 * 60_000)).toBe('1h 12m')
  })

  it('shows the wait so far, and no time left', () => {
    const { container } = render(<BlockedBanner channelName="Demo" tool="Bash" arrivedAt={Date.now() - 12 * 60_000}
      onReview={noop} onDeny={noop} onDismiss={noop} />)
    expect(container.textContent).toContain('Demo is waiting')
    expect(container.textContent).toContain('for 12m')
    expect(container.textContent).not.toContain('left')
  })
})
