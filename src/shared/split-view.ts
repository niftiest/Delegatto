// The split view layout model: which layouts exist, how their panes are
// placed, how divider positions are kept within sane limits, and how the
// saved state is read back. Pure, so the main process and the renderer share it.

export type SplitLayout = 'halves' | 'wide-narrow' | 'thirds' | 'one-two' | 'grid'

/** In the order the layout menu shows them. */
export const SPLIT_LAYOUTS: readonly SplitLayout[] = ['halves', 'wide-narrow', 'thirds', 'one-two', 'grid']

/** Smallest size a pane may be dragged down to. */
export const MIN_PANE = { width: 360, height: 280 }

/** Where the dividers sit, each as a share of the window from its left or top edge. `col` is
 *  the first column divider; `row` is the row divider on the side that splits (unused by the
 *  one-row layouts). `col2` is the second column divider, used by thirds only and always to
 *  the right of `col`. States saved before thirds existed have no `col2`, which is fine. */
export type SplitRatios = { col: number; row: number; col2?: number }

export type SplitPane = { sessionPk: number; projectDir: string } | null

export type SplitBounds = { x: number; y: number; width: number; height: number }

export type SplitState = {
  layout: SplitLayout
  ratios: Partial<Record<SplitLayout, SplitRatios>>
  panes: SplitPane[]
  bounds: SplitBounds | null
  maximized: boolean
  minimized: boolean
  open: boolean
}

const PANES: Record<SplitLayout, 2 | 3 | 4> = { halves: 2, 'wide-narrow': 2, thirds: 3, 'one-two': 3, grid: 4 }

export function paneCount(layout: SplitLayout): 2 | 3 | 4 {
  return PANES[layout]
}

/** How many columns of panes the layout has side by side at its widest. */
export function layoutColumns(layout: SplitLayout): 2 | 3 {
  return layout === 'thirds' ? 3 : 2
}

/** How many rows of panes the layout has stacked at its tallest. */
export function layoutRows(layout: SplitLayout): 1 | 2 {
  return layout === 'one-two' || layout === 'grid' ? 2 : 1
}

export function defaultRatios(layout: SplitLayout): SplitRatios {
  if (layout === 'thirds') return { col: 1 / 3, row: 0.5, col2: 2 / 3 }
  return { col: layout === 'wide-narrow' ? 2 / 3 : 0.5, row: 0.5 }
}

/** Keeps a divider at least `min` px from both edges, or centers it when `total` can't fit two minimums. */
function clampShare(share: number, total: number, min: number): number {
  if (total < min * 2) return 0.5
  return Math.min(Math.max(share, min / total), 1 - min / total)
}

/** Thirds' two dividers, each column at least `min` px wide, or equal thirds when `total`
 *  can't fit three minimums. A missing or out-of-order second divider starts from the default. */
function clampThirds(ratios: SplitRatios, total: number, min: number): { col: number; col2: number } {
  const d = defaultRatios('thirds')
  if (total < min * 3) return { col: d.col, col2: d.col2! }
  const m = min / total
  const ordered = ratios.col2 !== undefined && ratios.col2 > ratios.col
  const col = Math.min(Math.max(ordered ? ratios.col : d.col, m), 1 - 2 * m)
  const col2 = Math.min(Math.max(ordered ? ratios.col2! : d.col2!, col + m), 1 - m)
  return { col, col2 }
}

export function clampRatios(layout: SplitLayout, ratios: SplitRatios, size: { width: number; height: number }): SplitRatios {
  const row = layoutRows(layout) > 1 ? clampShare(ratios.row, size.height, MIN_PANE.height) : ratios.row
  if (layout === 'thirds') return { ...clampThirds(ratios, size.width, MIN_PANE.width), row }
  return { col: clampShare(ratios.col, size.width, MIN_PANE.width), row }
}

/** A divider moved by (dx, dy) px from where it is now, kept to the minimum pane size. In
 *  thirds, `which` says which column divider dx moves; the first stops at the second. */
export function nudgeRatios(
  layout: SplitLayout, ratios: SplitRatios, dx: number, dy: number, size: { width: number; height: number }, which: 'col' | 'col2' = 'col'
): SplitRatios {
  const row = ratios.row + dy / size.height
  if (layout !== 'thirds') return clampRatios(layout, { col: ratios.col + dx / size.width, row }, size)
  const now = clampRatios(layout, ratios, size)
  if (which === 'col2') return clampRatios(layout, { col: now.col, row, col2: now.col2! + dx / size.width }, size)
  const col = Math.min(now.col + dx / size.width, now.col2! - MIN_PANE.width / size.width)
  return clampRatios(layout, { col, row, col2: now.col2 }, size)
}

/** Two project folders are the same on Windows whatever their case, slashes or trailing slash. */
export function sameProjectDir(a: string, b: string): boolean {
  const clean = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

/** How many filled panes a change to `to` has no room for. Empty slots go first, so this is
 *  above zero only when the filled panes alone are more than the layout holds. */
export function panesToClose(panes: SplitPane[], to: SplitLayout): number {
  return Math.max(0, panes.filter(p => p !== null).length - paneCount(to))
}

/** The panes for another layout. A bigger one keeps every pane where it is and adds empty
 *  slots at the end. A smaller one removes empty slots first, then closes filled panes: the
 *  ones at `drop` (indexes into `panes`) when that names exactly as many filled panes as must
 *  go, otherwise the last filled ones. The panes that stay keep their order and fill the
 *  slots from the start. `dropped` holds only the filled panes that were closed. */
export function rearrange(panes: SplitPane[], to: SplitLayout, drop?: readonly number[]): { panes: SplitPane[]; dropped: SplitPane[] } {
  const n = paneCount(to)
  if (panes.length <= n) return { panes: Array.from({ length: n }, (_, i) => panes[i] ?? null), dropped: [] }

  const filled = panes.flatMap((p, i) => (p === null ? [] : [i]))
  const go = Math.max(0, filled.length - n)
  const chosen = new Set(drop ?? [])
  const fits = drop !== undefined && chosen.size === go && [...chosen].every(i => filled.includes(i))
  const closing = new Set(fits ? chosen : filled.slice(filled.length - go))

  const kept: SplitPane[] = filled.filter(i => !closing.has(i)).map(i => panes[i]!)
  const dropped = filled.filter(i => closing.has(i)).map(i => panes[i]!)
  while (kept.length < n) kept.push(null)
  return { panes: kept, dropped }
}

/** The panes with slots `a` and `b` swapped: a pane dropped on an empty slot moves there and
 *  leaves its old slot empty. The same index, or one that isn't a slot, gives an unchanged copy. */
export function swapPanes(panes: readonly SplitPane[], a: number, b: number): SplitPane[] {
  const next = [...panes]
  const slot = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < panes.length
  if (a === b || !slot(a) || !slot(b)) return next
  next[a] = panes[b] ?? null
  next[b] = panes[a] ?? null
  return next
}

/** The project folders the filled panes show, leaving out pane `except` (one being replaced). */
export function shownProjects(panes: SplitPane[], except?: number): string[] {
  return panes.flatMap((p, i) => (p === null || i === except ? [] : [p.projectDir]))
}

/** Which pane other than `except` shows this project, or -1. */
export function paneShowing(panes: SplitPane[], projectDir: string, except: number): number {
  return panes.findIndex((p, i) => i !== except && p !== null && sameProjectDir(p.projectDir, projectDir))
}

export function gridTemplate(layout: SplitLayout, ratios: SplitRatios): { columns: string; rows: string; areas: string[] } {
  if (layout === 'thirds') {
    const ordered = ratios.col2 !== undefined && ratios.col2 > ratios.col
    const [c1, c2] = ordered ? [ratios.col, ratios.col2!] : [1 / 3, 2 / 3]
    return { columns: `${c1}fr ${c2 - c1}fr ${1 - c2}fr`, rows: '1fr', areas: ['"p1 p2 p3"'] }
  }
  const columns = `${ratios.col}fr ${1 - ratios.col}fr`
  if (paneCount(layout) === 2) return { columns, rows: '1fr', areas: ['"p1 p2"'] }
  const rows = `${ratios.row}fr ${1 - ratios.row}fr`
  return { columns, rows, areas: layout === 'one-two' ? ['"p1 p2"', '"p1 p3"'] : ['"p1 p2"', '"p3 p4"'] }
}

const isRatio = (x: unknown): x is number => typeof x === 'number' && x > 0 && x < 1
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null

/** Reads a saved split state, dropping anything malformed or pointing at a chat that no longer exists. */
export function coerceSplitState(raw: unknown, chatExists: (pk: number) => boolean): SplitState | null {
  if (!isObj(raw)) return null
  const layout = SPLIT_LAYOUTS.find((l) => l === raw.layout)
  if (!layout) return null

  const ratios: SplitState['ratios'] = {}
  if (isObj(raw.ratios)) {
    for (const l of SPLIT_LAYOUTS) {
      const r = raw.ratios[l]
      if (!isObj(r) || !isRatio(r.col) || !isRatio(r.row)) continue
      // Thirds needs its second divider, to the right of the first; the others have none.
      if (l !== 'thirds') ratios[l] = { col: r.col, row: r.row }
      else if (isRatio(r.col2) && r.col2 > r.col) ratios[l] = { col: r.col, row: r.row, col2: r.col2 }
    }
  }

  // A project fills one pane at most: a later pane showing one already shown is emptied.
  const given = Array.isArray(raw.panes) ? raw.panes : []
  const panes: SplitPane[] = []
  for (let i = 0; i < paneCount(layout); i++) {
    const p = given[i]
    const ok = isObj(p) && typeof p.sessionPk === 'number' && typeof p.projectDir === 'string' && chatExists(p.sessionPk)
      && !panes.some(q => q !== null && sameProjectDir(q.projectDir, p.projectDir as string))
    panes.push(ok ? { sessionPk: p.sessionPk as number, projectDir: p.projectDir as string } : null)
  }

  const b = raw.bounds
  const bounds =
    isObj(b) && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
      : null

  return { layout, ratios, panes, bounds, maximized: raw.maximized === true, minimized: raw.minimized === true, open: raw.open === true }
}

/** Ctrl+1 to Ctrl+4: the pane to focus (0 to 3), or null when it isn't one of those keys or
 *  the layout has no such pane. */
export function focusShortcut(e: { ctrlKey: boolean; key: string }, paneCount: number): number | null {
  if (!e.ctrlKey || !/^[1-4]$/.test(e.key)) return null
  const index = Number(e.key) - 1
  return index < paneCount ? index : null
}

/** Window title: the project names in pane order, skipping empty slots. */
export function splitTitle(names: (string | null)[]): string {
  const shown = names.filter((n): n is string => !!n)
  return shown.length ? `Delegatto: Split view (${shown.join(', ')})` : 'Delegatto: Split view'
}
