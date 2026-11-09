import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ChannelRow, SessionSummary } from '../../shared/types'
import type { AppSettings } from '../../shared/shell-types'
import { paneCount, type SplitLayout, type SplitPane, type SplitState } from '../../shared/split-view'
import { applyPicks, newSlotsRun, planLayoutChange, type PickRun } from '../split-flow'
import { askChoiceInApp } from './AppDialog'
import { LayoutMenu } from './LayoutMenu'
import { SlotPicker } from './SlotPicker'

/** The split window's state as main reports it: asked for once, then followed. */
export function useSplitState(): SplitState | null {
  const [split, setSplit] = useState<SplitState | null>(null)
  useEffect(() => {
    let heard = false
    const off = api.onSplitViewChanged(s => { heard = true; setSplit(s) })
    void api.splitViewGet().then(s => { if (!heard) setSplit(s) }).catch(() => {})
    return off
  }, [])
  return split
}

/** The main window's split view button, in the chat header. Picking a layout makes this
 *  chat pane 1 and asks for the rest; with a split window open, it rearranges that window. */
export function SplitLauncher({ session, project, channels, settings }: {
  session: SessionSummary
  project: ChannelRow
  channels: ChannelRow[]
  settings: AppSettings | null
}) {
  const split = useSplitState()
  const splitRef = useRef(split)
  splitRef.current = split
  const [run, setRun] = useState<PickRun | null>(null)
  const current = split !== null && split.open ? split.layout : null

  const fail = (err: unknown): void => console.error('Changing the split view failed', err)
  const onPick = async (to: SplitLayout): Promise<void> => {
    const s = splitRef.current
    if (s !== null && s.open) {
      // The same layout again: just bring the window up.
      if (to === s.layout) { await api.splitViewOpen(s.layout, s.panes); return }
      const before = s.panes.length
      const panes = await planLayoutChange(s, to, channels, askChoiceInApp)
      if (panes === null) return
      // New slots are picked first; Cancel there keeps the old layout. Done applies the
      // layout and the picks to the window as it is by then, and brings it up.
      const next = newSlotsRun(before, panes, to, picked => {
        const latest = splitRef.current?.panes ?? s.panes
        void api.splitViewOpen(to, applyPicks(latest, to, before, picked)).catch(fail)
      })
      if (next !== null) { setRun(next); return }
      // The panes the user kept go with the layout, so main doesn't pick its own to close.
      await api.splitViewSetLayout(to, panes)
      await api.splitViewOpen(to, panes)
      return
    }
    const first: SplitPane = { sessionPk: session.id, projectDir: project.dirName }
    setRun({
      layout: to, startIndex: 1, count: paneCount(to) - 1, exclude: [project.dirName],
      done: picked => void api.splitViewOpen(to, [first, ...picked]).catch(fail)
    })
  }

  return (
    <>
      <LayoutMenu current={current} onPick={to => void onPick(to).catch(fail)} />
      {run !== null && (
        <SlotPicker layout={run.layout} startIndex={run.startIndex} count={run.count} channels={channels}
          exclude={run.exclude} settings={settings}
          onDone={picked => { setRun(null); run.done(picked) }}
          onCancel={() => setRun(null)} />
      )}
    </>
  )
}
