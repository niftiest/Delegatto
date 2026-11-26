// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { fake } from './fake-api'
import { channel, flush, renderSettled, session } from './render'
import { SplitApp, emptyHeadStyle } from '../../src/renderer/SplitApp'
import type { SplitState } from '../../src/shared/split-view'

const plant = channel(1, 'PlantPal')
const ledger = channel(2, 'LedgerLite')
const chats = new Map([[plant.id, [session(11, 'Water schedule')]], [ledger.id, [session(22, 'Invoices')]]])

/** Three slots: two projects, then an empty one. */
const STATE: SplitState = {
  layout: 'thirds', ratios: {}, bounds: null, maximized: false, minimized: false, open: true,
  panes: [{ sessionPk: 11, projectDir: plant.dirName }, { sessionPk: 22, projectDir: ledger.dirName }, null]
}

async function mountSplit(state: SplitState = STATE): Promise<void> {
  fake.override({
    splitViewGet: () => Promise.resolve(state),
    listChannels: () => Promise.resolve([plant, ledger]),
    listSessions: projectId => Promise.resolve(chats.get(projectId) ?? []),
    splitViewSwap: () => Promise.resolve(),
    splitViewSetPane: () => Promise.resolve()
  })
  await renderSettled(<SplitApp />)
  await flush(5)
}

/** Main sending the window's new state, as it does after every change. */
async function mainSends(state: SplitState): Promise<void> {
  await act(async () => { fake.emit('onSplitViewChanged', state) })
  await flush()
}

const pane = (index: number): HTMLElement => document.querySelector<HTMLElement>(`[data-pane="${index}"]`)!
const boxIn = (index: number): HTMLTextAreaElement => {
  const box = pane(index).querySelector<HTMLTextAreaElement>('.composer textarea')
  if (box === null) throw new Error(`pane ${index} has no message box`)
  return box
}
const gripIn = (index: number): HTMLElement => pane(index).querySelector<HTMLElement>('.split-pane-grip')!
const shell = (): HTMLElement => document.querySelector<HTMLElement>('.split-shell')!
const pointer = (pointerId: number, x: number, y: number) => ({ pointerId, button: 0, clientX: x, clientY: y, bubbles: true })

describe('SplitApp', () => {
  it('mounts a pane for each project, each with its own message box', async () => {
    await mountSplit()
    expect(within(pane(0)).getByText('PlantPal')).toBeTruthy()
    expect(within(pane(1)).getByText('LedgerLite')).toBeTruthy()
    expect(boxIn(0)).not.toBe(boxIn(1))
  })

  it('a click on a pane\'s name, with no drag, puts the cursor in that pane\'s message box', async () => {
    await mountSplit()
    act(() => { boxIn(0).focus() })
    expect(document.activeElement).toBe(boxIn(0))
    fireEvent.pointerDown(gripIn(1), pointer(1, 50, 20))
    fireEvent.pointerUp(document, pointer(1, 50, 20))
    expect(document.activeElement).toBe(boxIn(1))
    expect(pane(1).classList.contains('focused')).toBe(true)
    expect(fake.fn('splitViewSwap')).not.toHaveBeenCalled()
    await flush()
  })

  it('Ctrl+2 focuses the second pane, and Ctrl+1 the first', async () => {
    await mountSplit()
    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    expect(document.activeElement).toBe(boxIn(1))
    expect(pane(1).classList.contains('focused')).toBe(true)
    fireEvent.keyDown(window, { key: '1', ctrlKey: true })
    expect(document.activeElement).toBe(boxIn(0))
    expect(pane(0).classList.contains('focused')).toBe(true)
  })

  it('a pane dragged onto another keeps the cursor: typing goes to the chat that moved', async () => {
    await mountSplit()
    const plantBox = boxIn(0)
    // The cursor starts in the other pane, the one the drag lands on.
    act(() => { boxIn(1).focus() })
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => pane(1))
    fireEvent.pointerDown(gripIn(0), pointer(2, 50, 20))
    fireEvent.pointerMove(document, pointer(2, 400, 20))
    expect(shell().classList.contains('pane-dragging')).toBe(true)
    fireEvent.pointerUp(document, pointer(2, 400, 20))
    expect(fake.fn('splitViewSwap')).toHaveBeenCalledWith(0, 1)

    // Main swaps them: PlantPal is in the second slot now, and the cursor stays in its box.
    await mainSends({ ...STATE, panes: [STATE.panes[1]!, STATE.panes[0]!, null] })
    expect(boxIn(1)).toBe(plantBox)
    expect(document.activeElement).toBe(plantBox)
    expect(pane(1).classList.contains('focused')).toBe(true)
  })

  it('a pane emptied while it is being dragged ends the drag, and the next drag can start', async () => {
    await mountSplit()
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => pane(1))
    fireEvent.pointerDown(gripIn(0), pointer(3, 50, 20))
    fireEvent.pointerMove(document, pointer(3, 400, 20))
    expect(shell().classList.contains('pane-dragging')).toBe(true)

    await mainSends({ ...STATE, panes: [null, STATE.panes[1]!, null] })
    expect(shell().classList.contains('pane-dragging')).toBe(false)
    // The old pointer's events do nothing now.
    fireEvent.pointerUp(document, pointer(3, 400, 20))
    expect(fake.fn('splitViewSwap')).not.toHaveBeenCalled()

    // A new drag from the pane that's left works.
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => pane(0))
    fireEvent.pointerDown(gripIn(1), pointer(4, 400, 20))
    fireEvent.pointerMove(document, pointer(4, 50, 20))
    expect(shell().classList.contains('pane-dragging')).toBe(true)
    fireEvent.pointerUp(document, pointer(4, 50, 20))
    expect(fake.fn('splitViewSwap')).toHaveBeenCalledWith(1, 0)
  })

  it("an empty slot's ✕ steps the layout down one pane, without that slot", async () => {
    await mountSplit({ ...STATE, panes: [STATE.panes[0]!, null, STATE.panes[1]!] })
    fake.override({ splitViewSetLayout: () => Promise.resolve() })
    fireEvent.click(within(pane(1)).getByRole('button', { name: 'Remove this pane' }))
    await flush()
    expect(fake.fn('splitViewSetLayout')).toHaveBeenCalledWith('halves', [STATE.panes[0], STATE.panes[1]])
  })

  it("a single empty pane's ✕ closes the window", async () => {
    await mountSplit({ ...STATE, layout: 'single', panes: [null] })
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    fireEvent.click(within(pane(0)).getByRole('button', { name: 'Close the window' }))
    expect(close).toHaveBeenCalled()
    close.mockRestore()
  })

  it('shows one chat on its own, with no divider', async () => {
    await mountSplit({ ...STATE, layout: 'single', panes: [STATE.panes[0]!] })
    expect(boxIn(0)).toBeTruthy()
    expect(document.querySelector('[data-pane="1"]')).toBeNull()
    expect(document.querySelector('.split-divider')).toBeNull()
  })

  it('an empty slot shows one Select project button, in the middle of the slot', async () => {
    await mountSplit()
    const empty = pane(2)
    expect(empty.classList.contains('split-empty')).toBe(true)
    const button = within(empty).getByRole('button', { name: 'Select project' })
    expect(button.querySelector('svg path')?.getAttribute('d')).toBe('M8 3v10M3 8h10')
    // Beside it, only the ✕ that takes the slot out of the layout.
    expect(within(empty).getAllByRole('button')).toEqual([within(empty).getByRole('button', { name: 'Remove this pane' }), button])

    // The window's own stylesheet centers it.
    const style = document.createElement('style')
    style.textContent = readFileSync(resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')
    document.head.appendChild(style)
    const css = getComputedStyle(empty)
    expect(css.display).toBe('flex')
    expect(css.alignItems).toBe('center')
    expect(css.justifyContent).toBe('center')
    style.remove()

    fireEvent.click(button)
    await flush()
    expect(screen.getByRole('dialog', { name: 'Pick a project for pane 3' })).toBeTruthy()
  })
})

describe("the empty pane's ✕ lands where the pane's ✕ was", () => {
  it('in a one-row header: a band like a one-row header, the ✕ centered in it', () => {
    expect(emptyHeadStyle(13)).toEqual({ minHeight: 52 })
  })
  it('in a header wrapped to two rows: a band as tall, the ✕ at its bottom', () => {
    expect(emptyHeadStyle(40)).toEqual({ minHeight: 72, alignItems: 'flex-end' })
  })
  it('the usual band when nothing was remembered', () => {
    expect(emptyHeadStyle(undefined)).toBeUndefined()
    expect(emptyHeadStyle(Number.NaN)).toBeUndefined()
  })
})
