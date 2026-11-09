import { describe, it, expect } from 'vitest'
import {
  SPLIT_LAYOUTS, paneCount, layoutColumns, layoutRows, defaultRatios, clampRatios, gridTemplate, coerceSplitState, splitTitle,
  focusShortcut, nudgeRatios, sameProjectDir, rearrange, panesToClose, shownProjects, paneShowing, swapPanes
} from '../src/shared/split-view'

describe('split layouts', () => {
  it('counts panes', () => {
    expect(SPLIT_LAYOUTS).toEqual(['halves', 'wide-narrow', 'thirds', 'one-two', 'grid'])
    expect(SPLIT_LAYOUTS.map(paneCount)).toEqual([2, 2, 3, 3, 4])
  })
  it('knows how many columns and rows each layout has', () => {
    expect(SPLIT_LAYOUTS.map(layoutColumns)).toEqual([2, 2, 3, 2, 2])
    expect(SPLIT_LAYOUTS.map(layoutRows)).toEqual([1, 1, 1, 2, 2])
  })
  it('has the spec defaults', () => {
    expect(defaultRatios('halves').col).toBe(0.5)
    expect(defaultRatios('wide-narrow').col).toBeCloseTo(2 / 3)
    expect(defaultRatios('grid')).toEqual({ col: 0.5, row: 0.5 })
  })
  it('keeps every pane at least 360x280', () => {
    const r = clampRatios('grid', { col: 0.05, row: 0.98 }, { width: 1600, height: 1000 })
    expect(r.col * 1600).toBeGreaterThanOrEqual(360)
    expect((1 - r.row) * 1000).toBeGreaterThanOrEqual(280)
  })
  it('splits evenly when the window is too small for the minimums', () => {
    expect(clampRatios('halves', { col: 0.9, row: 0.5 }, { width: 600, height: 500 }).col).toBe(0.5)
  })
  it('places one-two panes: p1 full height on the left, p2 over p3 on the right', () => {
    expect(gridTemplate('one-two', { col: 0.5, row: 0.5 }).areas).toEqual(['"p1 p2"', '"p1 p3"'])
  })
  it('places grid panes in reading order', () => {
    expect(gridTemplate('grid', { col: 0.5, row: 0.5 }).areas).toEqual(['"p1 p2"', '"p3 p4"'])
  })
  it('writes fr tracks, with one row for the two-pane layouts', () => {
    expect(gridTemplate('halves', { col: 0.5, row: 0.5 })).toEqual({ columns: '0.5fr 0.5fr', rows: '1fr', areas: ['"p1 p2"'] })
    expect(gridTemplate('grid', { col: 0.25, row: 0.75 }).rows).toBe('0.75fr 0.25fr')
  })
})

describe('three side by side', () => {
  it('starts as three equal columns', () => {
    expect(defaultRatios('thirds')).toEqual({ col: 1 / 3, row: 0.5, col2: 2 / 3 })
  })
  it('places p1, p2 and p3 in one row, one column each', () => {
    expect(gridTemplate('thirds', { col: 0.25, row: 0.5, col2: 0.75 })).toEqual({ columns: '0.25fr 0.5fr 0.25fr', rows: '1fr', areas: ['"p1 p2 p3"'] })
  })
  it('falls back to equal columns when the second divider is missing', () => {
    expect(gridTemplate('thirds', { col: 0.5, row: 0.5 }).columns).toBe(gridTemplate('thirds', defaultRatios('thirds')).columns)
    expect(clampRatios('thirds', { col: 0.5, row: 0.5 }, { width: 1800, height: 900 })).toEqual({ col: 1 / 3, row: 0.5, col2: 2 / 3 })
  })
  it('keeps all three columns at least 360 wide', () => {
    const w = 1600
    for (const r of [{ col: 0.05, row: 0.5, col2: 0.1 }, { col: 0.9, row: 0.5, col2: 0.95 }, { col: 0.4, row: 0.5, col2: 0.42 }]) {
      const c = clampRatios('thirds', r, { width: w, height: 900 })
      expect(c.col * w).toBeGreaterThanOrEqual(360 - 1e-9)
      expect((c.col2! - c.col) * w).toBeGreaterThanOrEqual(360 - 1e-9)
      expect((1 - c.col2!) * w).toBeGreaterThanOrEqual(360 - 1e-9)
    }
  })
  it('splits into equal thirds when the window is too narrow for three minimums', () => {
    expect(clampRatios('thirds', { col: 0.2, row: 0.5, col2: 0.9 }, { width: 1000, height: 900 })).toEqual({ col: 1 / 3, row: 0.5, col2: 2 / 3 })
  })
  it('moves each divider on its own, and the first stops at the second', () => {
    const size = { width: 1800, height: 900 }
    const start = defaultRatios('thirds')
    const second = nudgeRatios('thirds', start, 180, 0, size, 'col2')
    expect(second.col).toBeCloseTo(1 / 3)
    expect(second.col2).toBeCloseTo(0.7667, 3)
    const first = nudgeRatios('thirds', start, 5000, 0, size, 'col')
    expect(first.col2).toBeCloseTo(2 / 3)
    expect((first.col2! - first.col) * 1800).toBeCloseTo(360)
  })
  it('leaves the second divider out of the other layouts', () => {
    expect(clampRatios('halves', { col: 0.5, row: 0.5, col2: 0.8 }, { width: 1600, height: 900 })).toEqual({ col: 0.5, row: 0.5 })
  })
})

describe('stored split state', () => {
  const exists = (pk: number) => pk !== 99
  it('rejects garbage and unknown layouts', () => {
    expect(coerceSplitState('nope', exists)).toBeNull()
    expect(coerceSplitState({ layout: 'triple', panes: [] }, exists)).toBeNull()
  })
  it('empties slots whose chat is gone and pads or trims to the pane count', () => {
    const s = coerceSplitState({ layout: 'one-two', panes: [{ sessionPk: 1, projectDir: 'a' }, { sessionPk: 99, projectDir: 'b' }], open: true }, exists)
    expect(s?.panes).toEqual([{ sessionPk: 1, projectDir: 'a' }, null, null])
  })
  it('drops ratios that are out of range', () => {
    const s = coerceSplitState({ layout: 'halves', panes: [], ratios: { halves: { col: 7, row: 0.5 } } }, exists)
    expect(s?.ratios.halves).toBeUndefined()
  })
  it('keeps good ratios and bounds, and nulls bad bounds', () => {
    const good = coerceSplitState({ layout: 'grid', panes: [], ratios: { grid: { col: 0.4, row: 0.6 } }, bounds: { x: 1, y: 2, width: 800, height: 600 } }, exists)
    expect(good?.ratios.grid).toEqual({ col: 0.4, row: 0.6 })
    expect(good?.bounds).toEqual({ x: 1, y: 2, width: 800, height: 600 })
    expect(coerceSplitState({ layout: 'grid', panes: [], bounds: { x: 1, y: 2, width: NaN, height: 600 } }, exists)?.bounds).toBeNull()
  })
  it('keeps the window flags only when they are really true', () => {
    const s = coerceSplitState({ layout: 'grid', panes: [], maximized: true, minimized: true, open: 'yes' }, exists)
    expect(s && { maximized: s.maximized, minimized: s.minimized, open: s.open }).toEqual({ maximized: true, minimized: true, open: false })
    expect(coerceSplitState({ layout: 'grid', panes: [] }, exists)?.minimized).toBe(false)
  })
  it('lets a project fill only one pane: a later pane of the same project is emptied', () => {
    const s = coerceSplitState({ layout: 'grid', panes: [
      { sessionPk: 1, projectDir: 'C:\\Work\\Plant' },
      { sessionPk: 2, projectDir: 'other' },
      { sessionPk: 3, projectDir: 'c:/work/plant/' },
      { sessionPk: 4, projectDir: 'C:\\Work\\Plant' }
    ] }, exists)
    expect(s?.panes).toEqual([{ sessionPk: 1, projectDir: 'C:\\Work\\Plant' }, { sessionPk: 2, projectDir: 'other' }, null, null])
  })
  it('keeps the first pane of a project even when an earlier slot is empty', () => {
    const s = coerceSplitState({ layout: 'one-two', panes: [null, { sessionPk: 1, projectDir: 'a' }, { sessionPk: 2, projectDir: 'A' }] }, exists)
    expect(s?.panes).toEqual([null, { sessionPk: 1, projectDir: 'a' }, null])
  })
  it('does not let a deleted chat hold its project against a later pane', () => {
    const s = coerceSplitState({ layout: 'halves', panes: [{ sessionPk: 99, projectDir: 'a' }, { sessionPk: 1, projectDir: 'a' }] }, exists)
    expect(s?.panes).toEqual([null, { sessionPk: 1, projectDir: 'a' }])
  })
  it('loads a state saved before three side by side existed', () => {
    const old = {
      layout: 'one-two',
      ratios: { halves: { col: 0.45, row: 0.5 }, 'wide-narrow': { col: 0.7, row: 0.5 }, 'one-two': { col: 0.4, row: 0.6 }, grid: { col: 0.5, row: 0.3 } },
      panes: [{ sessionPk: 1, projectDir: 'a' }, { sessionPk: 2, projectDir: 'b' }, null],
      bounds: { x: 0, y: 0, width: 1600, height: 900 }, maximized: false, minimized: false, open: true
    }
    const s = coerceSplitState(old, exists)
    expect(s?.layout).toBe('one-two')
    expect(s?.ratios).toEqual(old.ratios)
    expect(s?.ratios.thirds).toBeUndefined()
    expect(s?.panes).toEqual(old.panes)
  })
  it('keeps both of three side by side\'s dividers, and drops them when they are out of order', () => {
    const keep = coerceSplitState({ layout: 'thirds', panes: [], ratios: { thirds: { col: 0.3, row: 0.5, col2: 0.6 } } }, exists)
    expect(keep?.ratios.thirds).toEqual({ col: 0.3, row: 0.5, col2: 0.6 })
    expect(keep?.panes).toEqual([null, null, null])
    expect(coerceSplitState({ layout: 'thirds', panes: [], ratios: { thirds: { col: 0.6, row: 0.5, col2: 0.3 } } }, exists)?.ratios.thirds).toBeUndefined()
    expect(coerceSplitState({ layout: 'thirds', panes: [], ratios: { thirds: { col: 0.3, row: 0.5 } } }, exists)?.ratios.thirds).toBeUndefined()
  })
  it('keeps a second divider only for three side by side', () => {
    const s = coerceSplitState({ layout: 'halves', panes: [], ratios: { halves: { col: 0.4, row: 0.5, col2: 0.8 } } }, exists)
    expect(s?.ratios.halves).toEqual({ col: 0.4, row: 0.5 })
  })
  it('compares project folders the way Windows does', () => {
    expect(sameProjectDir('C:\\Work\\Plant', 'c:/work/plant')).toBe(true)
    expect(sameProjectDir('C:\\Work\\Plant\\', 'C:\\Work\\Plant')).toBe(true)
    expect(sameProjectDir('C:\\Work\\Plant', 'C:\\Work\\Plants')).toBe(false)
  })
})

describe('dragging a divider', () => {
  it('adds every move to where the divider is now', () => {
    const size = { width: 1600, height: 1000 }
    let r = { col: 0.5, row: 0.5 }
    for (let i = 0; i < 10; i++) r = nudgeRatios('grid', r, 16, -10, size)
    expect(r.col).toBeCloseTo(0.6)
    expect(r.row).toBeCloseTo(0.4)
  })
  it('stops at the minimum pane size', () => {
    const r = nudgeRatios('halves', { col: 0.5, row: 0.5 }, 5000, 0, { width: 1600, height: 1000 })
    expect((1 - r.col) * 1600).toBeCloseTo(360)
  })
})

describe('pane focus shortcuts', () => {
  it('focuses pane 3 of 4 with Ctrl+3', () => {
    expect(focusShortcut({ ctrlKey: true, key: '3' }, 4)).toBe(2)
  })
  it('ignores a pane the layout does not have', () => {
    expect(focusShortcut({ ctrlKey: true, key: '3' }, 2)).toBeNull()
  })
  it('needs Ctrl', () => {
    expect(focusShortcut({ ctrlKey: false, key: '1' }, 4)).toBeNull()
  })
  it('ignores other keys', () => {
    expect(focusShortcut({ ctrlKey: true, key: '0' }, 4)).toBeNull()
    expect(focusShortcut({ ctrlKey: true, key: '5' }, 4)).toBeNull()
    expect(focusShortcut({ ctrlKey: true, key: 'f' }, 4)).toBeNull()
    expect(focusShortcut({ ctrlKey: true, key: '1' }, 2)).toBe(0)
  })
})

describe('split window title', () => {
  it('lists the projects in pane order and skips empty slots', () => {
    expect(splitTitle(['PlantPal', null, 'LedgerLite'])).toBe('Delegatto: Split view (PlantPal, LedgerLite)')
    expect(splitTitle([null, null])).toBe('Delegatto: Split view')
  })
})

describe('rearranging the panes for another layout', () => {
  const a = { sessionPk: 1, projectDir: 'C--A' }
  const b = { sessionPk: 2, projectDir: 'C--B' }
  const c = { sessionPk: 3, projectDir: 'C--C' }
  const d = { sessionPk: 4, projectDir: 'C--D' }
  it('keeps the first panes and drops the rest from the end', () => {
    expect(rearrange([a, b, c, d], 'halves')).toEqual({ panes: [a, b], dropped: [c, d] })
  })
  it('pads a bigger layout with empty slots and drops nothing', () => {
    expect(rearrange([a, b], 'one-two')).toEqual({ panes: [a, b, null], dropped: [] })
  })
  it('removes empty slots first, and the panes that stay fill the slots from the start', () => {
    expect(rearrange([a, null, c, null], 'wide-narrow')).toEqual({ panes: [a, c], dropped: [] })
    expect(rearrange([null, b, null, d], 'thirds')).toEqual({ panes: [b, d, null], dropped: [] })
    expect(rearrange([a, null, c, d], 'halves')).toEqual({ panes: [a, c], dropped: [d] })
  })
  it('fills a short pane list up to the layout', () => {
    expect(rearrange([], 'grid')).toEqual({ panes: [null, null, null, null], dropped: [] })
  })
  it('closes the chosen panes and keeps the others in order', () => {
    expect(rearrange([a, b, c, d], 'thirds', [1])).toEqual({ panes: [a, c, d], dropped: [b] })
    expect(rearrange([a, b, c, d], 'halves', [0, 2])).toEqual({ panes: [b, d], dropped: [a, c] })
    expect(rearrange([a, null, c, d], 'halves', [0])).toEqual({ panes: [c, d], dropped: [a] })
  })
  it('falls back to the last panes when the choice is not the right number of filled panes', () => {
    expect(rearrange([a, b, c, d], 'halves', [1])).toEqual({ panes: [a, b], dropped: [c, d] })
    expect(rearrange([a, null, c, d], 'halves', [1])).toEqual({ panes: [a, c], dropped: [d] })
  })
  it('goes to three side by side and back', () => {
    expect(rearrange([a, b], 'thirds')).toEqual({ panes: [a, b, null], dropped: [] })
    expect(rearrange([a, b, c, d], 'thirds')).toEqual({ panes: [a, b, c], dropped: [d] })
    expect(rearrange([a, b, c], 'one-two')).toEqual({ panes: [a, b, c], dropped: [] })
    expect(rearrange([a, b, c], 'grid')).toEqual({ panes: [a, b, c, null], dropped: [] })
    expect(rearrange([a, b, c], 'halves', [0])).toEqual({ panes: [b, c], dropped: [a] })
  })
  it('counts the filled panes a smaller layout has no room for', () => {
    expect(panesToClose([a, b, c, d], 'halves')).toBe(2)
    expect(panesToClose([a, null, c, d], 'thirds')).toBe(0)
    expect(panesToClose([a, null, c, d], 'halves')).toBe(1)
    expect(panesToClose([a, b], 'grid')).toBe(0)
  })
})

describe('the projects the panes already show', () => {
  const a = { sessionPk: 1, projectDir: 'C--A' }
  const b = { sessionPk: 2, projectDir: 'C--B' }
  it('lists every filled pane, or every one but the pane being replaced', () => {
    expect(shownProjects([a, null, b])).toEqual(['C--A', 'C--B'])
    expect(shownProjects([a, null, b], 2)).toEqual(['C--A'])
  })
  it('finds another pane showing a project, whatever its case or slashes', () => {
    expect(paneShowing([a, null, b], 'c--b', 0)).toBe(2)
    expect(paneShowing([a, null, b], 'C--B', 2)).toBe(-1)
    expect(paneShowing([a, null, b], 'C--Z', 0)).toBe(-1)
  })
})

describe('swapping two panes', () => {
  const a = { sessionPk: 1, projectDir: 'C--A' }
  const b = { sessionPk: 2, projectDir: 'C--B' }
  const c = { sessionPk: 3, projectDir: 'C--C' }
  it('swaps two filled panes and leaves the others where they are', () => {
    expect(swapPanes([a, b, c], 0, 2)).toEqual([c, b, a])
  })
  it('moves a pane into an empty slot and leaves its old slot empty', () => {
    expect(swapPanes([a, null, b], 0, 1)).toEqual([null, a, b])
    expect(swapPanes([a, null, b], 1, 2)).toEqual([a, b, null])
  })
  it('does not change the panes it was given', () => {
    const panes = [a, b]
    swapPanes(panes, 0, 1)
    expect(panes).toEqual([a, b])
  })
  it('returns the same panes for the same index or one outside them', () => {
    expect(swapPanes([a, b], 1, 1)).toEqual([a, b])
    expect(swapPanes([a, b], 0, 2)).toEqual([a, b])
    expect(swapPanes([a, b], -1, 0)).toEqual([a, b])
    expect(swapPanes([a, b], 0.5, 1)).toEqual([a, b])
  })
})
