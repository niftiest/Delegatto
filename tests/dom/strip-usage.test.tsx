// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StripUsage } from '../../src/renderer/components/UsageFooter'
import { NO_PLAN_USAGE } from '../../src/shared/plan-usage'

const HOUR = 3_600_000

describe('plan usage in the split window strip', () => {
  it('shows the plan, both windows and when each resets', () => {
    const now = Date.now()
    const { container } = render(<StripUsage usage={{
      ...NO_PLAN_USAGE, plan: 'Ultra', limitsApply: true,
      fiveHour: { percent: 42, resetsAt: now + 2 * HOUR }, sevenDay: { percent: 85, resetsAt: now + 72 * HOUR }
    }} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Ultra plan')
    expect(text).toContain('5-hour 42%')
    expect(text).toContain('Week 85%')
    expect(container.querySelectorAll('.usage-window-reset')).toHaveLength(2)
    expect(container.querySelectorAll('.strip-usage-window.warn')).toHaveLength(1)
  })

  it('shows only the weekly window when the plan has no 5-hour one', () => {
    const { container } = render(<StripUsage usage={{ ...NO_PLAN_USAGE, plan: 'Ultra', limitsApply: true, sevenDay: { percent: 2, resetsAt: Date.now() + HOUR } }} />)
    expect(container.textContent).not.toContain('5-hour')
    expect(container.textContent).toContain('Week 2%')
  })

  it('says when there is nothing to show yet, and shows nothing off a plan', () => {
    expect(render(<StripUsage usage={{ ...NO_PLAN_USAGE, plan: 'max' }} />).container.textContent).toContain('Usage shows after the next reply')
    expect(render(<StripUsage usage={{ ...NO_PLAN_USAGE, limitsApply: false }} />).container.innerHTML).toBe('')
  })
})
