// The steps of changing a split window's layout, without the IPC, so both windows share
// them and tests can run them. The windows do the asking and the saving.
import type { ChannelRow } from '../shared/types'
import type { AppDialogRequest } from '../shared/app-dialog'
import { paneShowing, panesToClose, rearrange, shownProjects, type SplitLayout, type SplitPane, type SplitState } from '../shared/split-view'
import { resolveChannelName } from './lib'

/** Asks a question with options to pick, and resolves to the button pressed and the picks. */
export type AskChoice = (request: Omit<AppDialogRequest, 'id'>) => Promise<{ button: number; picked: number[] }>

/** One run of the slot picker, and what to do with its picks. */
export type PickRun = { layout: SplitLayout; startIndex: number; count: number; exclude: string[]; done(picked: SplitPane[]): void }

const paneName = (p: NonNullable<SplitPane>, channels: ChannelRow[]): string => {
  const c = channels.find(ch => ch.dirName === p.projectDir)
  return c === undefined ? p.projectDir : resolveChannelName(c.meta, c.cwd, c.dirName)
}

/** "Close N panes?", offering every filled pane, the last `count` picked to start with.
 *  The options are the filled panes in order. Button 1 closes the picked ones. */
export function closePanesQuestion(filled: NonNullable<SplitPane>[], count: number, channels: ChannelRow[]): Omit<AppDialogRequest, 'id'> {
  const one = count === 1
  return {
    title: `Close ${count} pane${one ? '' : 's'}?`,
    detail: [one
      ? 'The new layout has room for one pane fewer. Choose the pane to close. Its chat stays in the chat list.'
      : `The new layout has room for ${count} panes fewer. Choose the panes to close. Their chats stay in the chat list.`],
    choice: {
      label: one ? 'Pane to close' : `Pick ${count} panes to close`,
      options: filled.map(p => paneName(p, channels)),
      count,
      selected: filled.map((_, i) => i).slice(filled.length - count)
    },
    buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: one ? 'Close pane' : 'Close panes', kind: 'danger' }],
    defaultIndex: 0,
    cancelIndex: 0
  }
}

/** The panes an open split window would have in another layout. Growing adds empty slots at
 *  the end; shrinking removes empty slots first and asks which filled panes to close only when
 *  that isn't enough. Null means the user kept the old layout. Nothing is saved here. */
export async function planLayoutChange(state: SplitState, to: SplitLayout, channels: ChannelRow[], ask: AskChoice): Promise<SplitPane[] | null> {
  const count = panesToClose(state.panes, to)
  if (count === 0) return rearrange(state.panes, to).panes
  const filledAt = state.panes.flatMap((p, i) => (p === null ? [] : [i]))
  const filled = filledAt.map(i => state.panes[i]!)
  const answer = await ask(closePanesQuestion(filled, count, channels))
  const picked = new Set(answer.picked)
  if (answer.button !== 1 || picked.size !== count || [...picked].some(k => filledAt[k] === undefined)) return null
  return rearrange(state.panes, to, [...picked].map(k => filledAt[k]!)).panes
}

/** The picker run for the slots a layout change added, or null when it added none. */
export function newSlotsRun(before: number, panes: SplitPane[], layout: SplitLayout, done: (picked: SplitPane[]) => void): PickRun | null {
  if (panes.length <= before) return null
  return { layout, startIndex: before, count: panes.length - before, exclude: shownProjects(panes), done }
}

/** The latest panes in the new layout, with the picks in the added slots from `before`. A
 *  pick goes only into a slot still empty, and not when another pane has since come to show
 *  its project. */
export function applyPicks(latest: SplitPane[], to: SplitLayout, before: number, picked: SplitPane[]): SplitPane[] {
  const panes = rearrange(latest, to).panes
  picked.forEach((pick, k) => {
    const i = before + k
    if (pick === null || i >= panes.length || panes[i] !== null) return
    if (paneShowing(panes, pick.projectDir, i) !== -1) return
    panes[i] = pick
  })
  return panes
}
