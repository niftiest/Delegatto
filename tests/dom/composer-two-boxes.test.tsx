// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { flush } from './render'
import { Composer } from '../../src/renderer/components/Composer'
import { composeStore } from '../../src/renderer/compose-store'

/** One chat in two panes: a message box for it in each, as SplitApp can show it. */
function TwoBoxes({ pk, running, focused, onSendA, onSendB }: {
  pk: number; running: boolean; focused: 'a' | 'b'; onSendA: () => void; onSendB: () => void
}) {
  return (
    <>
      <div data-testid="a"><Composer sessionPk={pk} running={running} focused={focused === 'a'} onSend={onSendA} onInterrupt={() => {}} /></div>
      <div data-testid="b"><Composer sessionPk={pk} running={running} focused={focused === 'b'} onSend={onSendB} onInterrupt={() => {}} /></div>
    </>
  )
}

function mount(pk: number, focused: 'a' | 'b', running = false) {
  const onSendA = vi.fn()
  const onSendB = vi.fn()
  const props = { pk, focused, running, onSendA, onSendB }
  const view = render(<TwoBoxes {...props} />)
  const box = (which: 'a' | 'b'): HTMLTextAreaElement => view.getByTestId(which).querySelector('textarea')!
  const update = (next: Partial<Pick<typeof props, 'running' | 'focused'>>): void => {
    Object.assign(props, next)
    view.rerender(<TwoBoxes {...props} />)
  }
  return { view, box, update, onSendA, onSendB }
}

/** A message held in the app's queue (a slash command waits for the turn to end there). */
function hold(pk: number, id: string, text: string): void {
  act(() => { composeStore.dispatch(pk, { type: 'add', msg: { id, text, images: [], uuid: null } }) })
}

describe('one chat in two message boxes', () => {
  it('a held message is sent once, by the focused box, when the turn ends', async () => {
    const pk = 101
    const { update, onSendA, onSendB } = mount(pk, 'b', true)
    hold(pk, 'q1', '/compact')
    await flush()

    update({ running: false })
    await flush()
    expect(onSendB).toHaveBeenCalledTimes(1)
    expect(onSendB).toHaveBeenCalledWith('/compact', [], [], undefined, true)
    expect(onSendA).not.toHaveBeenCalled()
    expect(composeStore.get(pk).queue).toEqual([])
  })

  it('the box that takes held messages follows the focus', async () => {
    const pk = 102
    const { update, onSendA, onSendB } = mount(pk, 'b', true)
    update({ focused: 'a' })
    hold(pk, 'q2', '/cost')
    await flush()

    update({ running: false })
    await flush()
    expect(onSendA).toHaveBeenCalledTimes(1)
    expect(onSendA).toHaveBeenCalledWith('/cost', [], [], undefined, true)
    expect(onSendB).not.toHaveBeenCalled()
  })

  it('a message coming back goes into the focused box only, and sends once from there', async () => {
    const pk = 103
    const { box, onSendA, onSendB } = mount(pk, 'b')
    await flush()

    act(() => { composeStore.returnMessage(pk, { text: 'fix the tests', images: [] }) })
    await flush()
    expect(box('b').value).toBe('fix the tests')
    expect(box('a').value).toBe('')
    expect(composeStore.get(pk).returned).toBeNull()
    expect(document.activeElement).toBe(box('b'))

    fireEvent.keyDown(box('b'), { key: 'Enter' })
    fireEvent.keyDown(box('a'), { key: 'Enter' })
    expect(onSendB).toHaveBeenCalledTimes(1)
    expect(onSendB.mock.calls[0]?.[0]).toBe('fix the tests')
    expect(onSendA).not.toHaveBeenCalled()
  })
})
