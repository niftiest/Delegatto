// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { fake } from './fake-api'
import { channel, renderSettled } from './render'
import { SearchOverlay, matchingProjects } from '../../src/renderer/components/SearchOverlay'
import type { ChatTitleHit, SearchHit } from '../../src/shared/types'

const plant = channel(1, 'PlantPal')
const ledger = channel(2, 'LedgerLite', {}, { friendlyName: 'Plant ledger' })
const chatHit: ChatTitleHit = { sessionPk: 11, projectDir: plant.dirName, title: 'Plant watering schedule', lastTs: null }
const mainHit: SearchHit = { sessionPk: 22, sessionId: 's22', projectDir: ledger.dirName, seq: 40, ts: null, snippet: 'water the <mark>plant</mark> daily', uuid: 'msg-40' }
const agentHit: SearchHit = { sessionPk: 22, sessionId: 's22', projectDir: ledger.dirName, seq: 3, ts: null, snippet: 'a subagent said <mark>plant</mark>', uuid: null }

async function typeQuery(text: string): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search projects, chats and messages' }), { target: { value: text } })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
}

async function mount() {
  fake.override({ search: () => Promise.resolve([mainHit, agentHit]), searchChats: () => Promise.resolve([chatHit]) })
  const onOpen = vi.fn(), onOpenProject = vi.fn(), onClose = vi.fn()
  await renderSettled(<SearchOverlay channels={[plant, ledger]} onClose={onClose} onOpen={onOpen} onOpenProject={onOpenProject} />)
  await typeQuery('plant')
  return { onOpen, onOpenProject }
}

describe('searching everything', () => {
  it('matches projects by the name the chat list shows', () => {
    expect(matchingProjects([plant, ledger], 'PLANT').map(c => c.id)).toEqual([1, 2])
    expect(matchingProjects([plant, ledger], 'ledger').map(c => c.id)).toEqual([2])
    expect(matchingProjects([plant, ledger], ' ')).toEqual([])
  })

  it('shows names on top and what was said below, each in its own section', async () => {
    await mount()
    const sections = document.querySelectorAll('.search-section')
    expect([...sections].map(s => s.querySelector('.search-section-head')?.textContent)).toEqual(['Projects / Chats', 'Chat history 2 matches'])
    expect(within(sections[0] as HTMLElement).getAllByRole('option').map(o => o.textContent)).toEqual([
      'ProjectPlantPal', 'ProjectPlant ledger', expect.stringContaining('Plant watering schedule')
    ])
  })

  it('opens a project or chat as it is, and goes to the very message from a history match', async () => {
    const { onOpen, onOpenProject } = await mount()
    const options = screen.getAllByRole('option')
    fireEvent.click(options[0]!)
    expect(onOpenProject).toHaveBeenCalledWith(plant)
    fireEvent.click(options[2]!)
    expect(onOpen).toHaveBeenLastCalledWith(11, plant.dirName, null)
    fireEvent.click(options[3]!)
    expect(onOpen).toHaveBeenLastCalledWith(22, ledger.dirName, { uuid: 'msg-40', seq: 40 })
    // A subagent's words can't be shown in the chat, so that match only opens it.
    fireEvent.click(options[4]!)
    expect(onOpen).toHaveBeenLastCalledWith(22, ledger.dirName, null)
  })

  it('moves through both sections with the arrow keys, in the order shown', async () => {
    const { onOpen } = await mount()
    const box = screen.getByRole('textbox', { name: 'Search projects, chats and messages' })
    for (let i = 0; i < 3; i++) fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[3]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(22, ledger.dirName, { uuid: 'msg-40', seq: 40 })
  })
})
