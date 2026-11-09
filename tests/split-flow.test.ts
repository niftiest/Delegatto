import { describe, it, expect } from 'vitest'
import type { ChannelRow } from '../src/shared/types'
import type { SplitPane, SplitState } from '../src/shared/split-view'
import type { AppDialogRequest } from '../src/shared/app-dialog'
import { applyPicks, newSlotsRun, planLayoutChange } from '../src/renderer/split-flow'

const a = { sessionPk: 1, projectDir: 'C--A' }
const b = { sessionPk: 2, projectDir: 'C--B' }
const c = { sessionPk: 3, projectDir: 'C--C' }
const d = { sessionPk: 4, projectDir: 'C--D' }

function state(layout: SplitState['layout'], panes: SplitPane[]): SplitState {
  return { layout, ratios: {}, panes, bounds: null, maximized: false, minimized: false, open: true }
}
const channels: ChannelRow[] = [{
  id: 3, dirName: 'C--C', cwd: 'D:\\GIT\\Cee', sessionCount: 1, lastActivity: null, preview: null,
  meta: { dirName: 'C--C', friendlyName: 'Cee', starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false }
}]

describe('planning a layout change', () => {
  type Q = Omit<AppDialogRequest, 'id'>
  const keepDefaults = async (q: Q) => ({ button: 1, picked: q.choice!.selected })

  it('asks which panes to close, listing every filled pane, and gives up on Cancel', async () => {
    const asked: Q[] = []
    const result = await planLayoutChange(state('grid', [a, b, c, d]), 'halves', channels, async q => { asked.push(q); return { button: q.cancelIndex, picked: [] } })
    expect(result).toBeNull()
    expect(asked).toHaveLength(1)
    const q = asked[0]!
    expect(q.title).toBe('Close 2 panes?')
    expect(q.choice).toEqual({ label: 'Pick 2 panes to close', options: ['C--A', 'C--B', 'Cee', 'C--D'], count: 2, selected: [2, 3] })
    expect(q.buttons[1]).toEqual({ label: 'Close panes', kind: 'danger' })
    expect(q.detail.join(' ')).toContain('chat list')
  })
  it('closes the last filled panes by default', async () => {
    expect(await planLayoutChange(state('grid', [a, b, c, d]), 'halves', channels, keepDefaults)).toEqual([a, b])
  })
  it('asks with a dropdown for one pane, the last filled one chosen', async () => {
    const asked: Q[] = []
    await planLayoutChange(state('grid', [a, b, null, d]), 'halves', channels, async q => { asked.push(q); return keepDefaults(q) })
    expect(asked[0]!.title).toBe('Close 1 pane?')
    expect(asked[0]!.choice).toMatchObject({ options: ['C--A', 'C--B', 'C--D'], count: 1, selected: [2] })
    expect(asked[0]!.buttons[1]!.label).toBe('Close pane')
  })
  it('closes a chosen middle pane and keeps the others in order', async () => {
    const result = await planLayoutChange(state('grid', [a, b, c, d]), 'thirds', channels, async () => ({ button: 1, picked: [1] }))
    expect(result).toEqual([a, c, d])
  })
  it('maps the picks past empty slots to the right panes', async () => {
    // Options are a, c, d; picking the first closes a.
    const result = await planLayoutChange(state('grid', [a, null, c, d]), 'halves', channels, async () => ({ button: 1, picked: [0] }))
    expect(result).toEqual([c, d])
  })
  it('gives up when the picks are not the number asked for', async () => {
    expect(await planLayoutChange(state('grid', [a, b, c, d]), 'halves', channels, async () => ({ button: 1, picked: [0] }))).toBeNull()
  })
  it('does not ask when only empty slots go', async () => {
    let asked = false
    const ask = async () => { asked = true; return { button: 0, picked: [] } }
    expect(await planLayoutChange(state('one-two', [a, b, null]), 'halves', channels, ask)).toEqual([a, b])
    expect(await planLayoutChange(state('grid', [a, null, c, null]), 'wide-narrow', channels, ask)).toEqual([a, c])
    expect(asked).toBe(false)
  })
})

describe('the picker run for added slots', () => {
  const done = (): void => {}
  it('is null when the layout adds no slots', () => {
    expect(newSlotsRun(2, [a, b], 'wide-narrow', done)).toBeNull()
    expect(newSlotsRun(4, [a, b], 'halves', done)).toBeNull()
  })
  it('covers the added slots and leaves out the projects shown', () => {
    const run = newSlotsRun(2, [a, b, null, null], 'grid', done)
    expect(run).toMatchObject({ layout: 'grid', startIndex: 2, count: 2, exclude: ['C--A', 'C--B'] })
  })
})

describe('applying the picks', () => {
  it('fills the added slots of the latest panes', () => {
    expect(applyPicks([a, b], 'grid', 2, [c, null])).toEqual([a, b, c, null])
  })
  it('skips a pick whose project a pane gained meanwhile, and a slot no longer empty', () => {
    expect(applyPicks([a, { sessionPk: 9, projectDir: 'c--c' }], 'grid', 2, [c, d])).toEqual([a, { sessionPk: 9, projectDir: 'c--c' }, null, d])
    expect(applyPicks([a, b, b, null], 'grid', 2, [c, d])).toEqual([a, b, b, d])
  })
})
