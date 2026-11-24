// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Composer, runningHint } from '../../src/renderer/components/Composer'
import { WorkingLine } from '../../src/renderer/components/WorkingLine'

describe("the Enter/Esc note while Claude works", () => {
  it('sits at the right of the working line', () => {
    const { container } = render(<WorkingLine startedAt={Date.now()} tokens={0} pending={[]} lastActivity={Date.now()}
      status="compacting" waitingOnYou={false} hint={runningHint(0)} />)
    const line = container.querySelector('.working-line')!
    expect(line.querySelector('.working-line-main')?.textContent).toContain('Compacting conversation')
    expect(line.querySelector('.working-line-hint')?.textContent).toBe("Enter queues for Claude's next step · Esc stops")
  })

  it('leaves the working line alone without a note', () => {
    const { container } = render(<WorkingLine startedAt={Date.now()} tokens={0} pending={[]} lastActivity={Date.now()}
      status={null} waitingOnYou={false} />)
    expect(container.querySelector('.working-line-hint')).toBeNull()
  })

  it('is no longer a row under the message box, which hands it to the chat instead', () => {
    const onRunHint = vi.fn()
    const { container, rerender } = render(<Composer sessionPk={9301} running onSend={() => {}} onInterrupt={() => {}} onRunHint={onRunHint} />)
    expect(container.textContent).not.toContain('Esc stops')
    expect(onRunHint).toHaveBeenLastCalledWith("Enter queues for Claude's next step · Esc stops")
    rerender(<Composer sessionPk={9301} running={false} onSend={() => {}} onInterrupt={() => {}} onRunHint={onRunHint} />)
    expect(onRunHint).toHaveBeenLastCalledWith(null)
  })

  it('says what Esc does once something is queued', () => {
    expect(runningHint(2)).toBe('Claude reads queued messages at its next step · Esc takes the last one back')
  })
})
