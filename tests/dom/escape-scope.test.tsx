// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { renderSettled } from './render'
import { DialogTarget } from '../../src/renderer/components/DialogHost'
import { TaskOutputDialog } from '../../src/renderer/components/TaskOutputDialog'
import { RewindDialog } from '../../src/renderer/components/RewindDialog'

/** Two split panes as SplitPaneView lays them out: a message box, then the pane's dialog slot. */
function twoPanes(): { boxA: HTMLTextAreaElement; slotA: HTMLElement; boxB: HTMLTextAreaElement; remove: () => void } {
  const pane = (index: number): { section: HTMLElement; box: HTMLTextAreaElement; slot: HTMLElement } => {
    const section = document.createElement('section')
    section.dataset.pane = String(index)
    const composer = section.appendChild(document.createElement('div'))
    composer.className = 'composer'
    const box = composer.appendChild(document.createElement('textarea'))
    const slot = section.appendChild(document.createElement('div'))
    slot.className = 'split-dialog-host'
    document.body.appendChild(section)
    return { section, box, slot }
  }
  const a = pane(0)
  const b = pane(1)
  return { boxA: a.box, slotA: a.slot, boxB: b.box, remove: () => { a.section.remove(); b.section.remove() } }
}

const dialogs: Array<{ name: string; make: (onClose: () => void) => ReactElement }> = [
  { name: 'TaskOutputDialog', make: onClose => <TaskOutputDialog sessionPk={7} taskId="t1" title="npm test" onClose={onClose} /> },
  { name: 'RewindDialog', make: onClose => <RewindDialog sessionPk={7} onClose={onClose} onDone={() => {}} /> }
]

describe.each(dialogs)('Esc and $name', ({ make }) => {
  it('Esc in another pane leaves a pane\'s dialog open', async () => {
    const { boxB, slotA, remove } = twoPanes()
    const onClose = vi.fn()
    await renderSettled(<DialogTarget.Provider value={slotA}>{make(onClose)}</DialogTarget.Provider>)
    expect(slotA.querySelector('[role="dialog"]')).not.toBeNull()

    boxB.focus()
    fireEvent.keyDown(boxB, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    remove()
  })

  it('Esc in the dialog\'s own pane closes it, even from that pane\'s message box', async () => {
    const { boxA, slotA, remove } = twoPanes()
    const onClose = vi.fn()
    await renderSettled(<DialogTarget.Provider value={slotA}>{make(onClose)}</DialogTarget.Provider>)

    boxA.focus()
    fireEvent.keyDown(boxA, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    remove()
  })

  it('in the main window (the page as target), Esc from anywhere closes it', async () => {
    const { boxB, remove } = twoPanes()
    const onClose = vi.fn()
    await renderSettled(make(onClose))
    expect(screen.getByRole('dialog').closest('[data-pane]')).toBeNull()

    boxB.focus()
    fireEvent.keyDown(boxB, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    remove()
  })
})
