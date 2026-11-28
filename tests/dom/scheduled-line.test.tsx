// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BackgroundTasksLine } from '../../src/renderer/components/WorkingLine'
import type { BackgroundTask } from '../../src/shared/engine-types'

const noop = (): void => {}
const task = (over: Partial<BackgroundTask>): BackgroundTask => ({ id: 'x', type: 'local_bash', description: 'sleep 60', agent: null, startedAt: Date.now(), lastTool: null, tokens: null, ...over })
const tick = task({ id: 'cron:1', type: 'scheduled', description: 'say tick', schedule: { recurring: true, nextRun: Date.now() + 60_000 } })

describe('the chat line for background work and scheduled jobs', () => {
  it('says a chat with only scheduled jobs has them, not that it is waiting, and offers no stop button for them', () => {
    const { container } = render(<BackgroundTasksLine tasks={[tick]} running={false} onStop={noop} />)
    const text = container.textContent ?? ''
    expect(text).toContain('1 scheduled task in this chat')
    expect(text).not.toContain('Waiting on')
    expect(text).toContain('Scheduled: say tick')
    expect(container.querySelector('.background-task-stop')).toBeNull()
  })

  it('counts only real work in "Waiting on", and lists the scheduled job too', () => {
    const { container } = render(<BackgroundTasksLine tasks={[task({}), tick]} running={false} onStop={noop} />)
    expect(container.textContent).toContain('Waiting on 1 background task')
    expect(container.querySelectorAll('.background-task')).toHaveLength(2)
    expect(container.querySelectorAll('.background-task-stop')).toHaveLength(1)
  })

  it('hides housekeeping that Claude Code marks ambient', () => {
    const { container } = render(<BackgroundTasksLine tasks={[task({ ambient: true })]} running={false} onStop={noop} />)
    expect(container.innerHTML).toBe('')
  })
})
