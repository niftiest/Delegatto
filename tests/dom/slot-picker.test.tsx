// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { fake } from './fake-api'
import { channel, flush, mouseMoveInit, renderSettled, session } from './render'
import { SlotPicker } from '../../src/renderer/components/SlotPicker'
import type { ChannelGroup } from '../../src/shared/shell-types'
import type { SessionSummary } from '../../src/shared/types'

const plant = channel(1, 'PlantPal')
const ledger = channel(2, 'LedgerLite')
const site = channel(3, 'Site', {}, { groupId: 7 })
const channels = [plant, ledger, site]
const work: ChannelGroup = { id: 7, name: 'Work', sortOrder: 0, icon: { kind: 'initials' } }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function picker(props: Partial<Parameters<typeof SlotPicker>[0]> = {}) {
  const onDone = vi.fn()
  const onCancel = vi.fn()
  const ui = <SlotPicker layout="halves" startIndex={0} count={1} channels={channels} settings={null} onDone={onDone} onCancel={onCancel} {...props} />
  return { ui, onDone, onCancel }
}

const rows = (): HTMLElement[] => screen.getAllByRole('option')
const activeName = (): string | null => rows().find(r => r.getAttribute('aria-selected') === 'true')?.querySelector('.slot-picker-name')?.textContent ?? null

describe('SlotPicker', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a mousemove from the list changing under a still pointer picks out nothing and scrolls nothing', async () => {
    const groups = deferred<ChannelGroup[]>()
    fake.override({ listGroups: () => groups.promise })
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    await renderSettled(picker().ui)
    const list = screen.getByRole('listbox')
    expect(activeName()).toBe('PlantPal')

    // The pointer rests over the second row: the first move only says where it is.
    fireEvent.mouseMove(rows()[1]!, mouseMoveInit(200, 120))
    expect(activeName()).toBe('PlantPal')

    // The groups arrive and the rows move under the pointer (Site now heads the list, in Work).
    // The list goes back to its very top, so the first section's title stays in view.
    list.scrollTop = 40
    await act(async () => { groups.resolve([work]) })
    await flush()
    expect(rows().map(r => r.querySelector('.slot-picker-name')?.textContent)).toEqual(['Site', 'PlantPal', 'LedgerLite'])
    expect(list.scrollTop).toBe(0)
    scroll.mockClear()

    // Chromium then sends a mousemove at the same spot, over whichever row is there now.
    fireEvent.mouseMove(rows()[1]!, mouseMoveInit(200, 120))
    fireEvent.mouseMove(rows()[2]!, mouseMoveInit(200, 120))
    expect(activeName()).toBe('Site')
    expect(scroll).not.toHaveBeenCalled()
    expect(list.scrollTop).toBe(0)
  })

  it('a real mouse move picks out the row under the pointer', async () => {
    await renderSettled(picker().ui)
    fireEvent.mouseMove(rows()[0]!, mouseMoveInit(200, 100))
    fireEvent.mouseMove(rows()[1]!, mouseMoveInit(200, 130))
    expect(activeName()).toBe('LedgerLite')
    fireEvent.mouseMove(rows()[2]!, mouseMoveInit(201, 160))
    expect(activeName()).toBe('Site')
  })

  it('Esc cancels and gives the focus back to what had it when the picker opened', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Select project'
    document.body.appendChild(opener)
    opener.focus()
    const { ui, onCancel, onDone } = picker()
    await renderSettled(ui)
    // The picker takes the focus for its search box.
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('Cancel while a pick is still loading means the pick never lands', async () => {
    const chats = deferred<SessionSummary[]>()
    fake.override({ listSessions: () => chats.promise })
    const { ui, onCancel, onDone } = picker()
    await renderSettled(ui)

    fireEvent.click(rows()[1]!)
    expect(fake.fn('listSessions')).toHaveBeenCalledWith(ledger.id)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    // The project's chats come in after Cancel: nothing more happens.
    await act(async () => { chats.resolve([session(21)]) })
    await flush()
    expect(onDone).not.toHaveBeenCalled()
    expect(fake.fn('focusMain')).not.toHaveBeenCalled()
  })

  it('without Cancel, the same pick does land (the test above is not passing by accident)', async () => {
    const chats = deferred<SessionSummary[]>()
    fake.override({ listSessions: () => chats.promise })
    const { ui, onDone } = picker()
    await renderSettled(ui)
    fireEvent.click(rows()[1]!)
    await act(async () => { chats.resolve([session(21)]) })
    await flush()
    expect(onDone).toHaveBeenCalledWith([{ sessionPk: 21, projectDir: ledger.dirName }])
  })
})
