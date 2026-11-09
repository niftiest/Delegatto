import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from './api'
import type { ChannelRow } from '../shared/types'
import type { FsEntry } from '../shared/ipc'
import type { PinnedMessage } from '../shared/engine-ipc-contract'
import type { RailView } from './components/ContextRail'

/** Boolean UI prefs (sidebar/rail collapse) persist in localStorage, same as
 *  panel widths -- window-local chrome state, no need to round-trip the DB. */
export function readStoredBool(key: string, fallback: boolean): boolean {
  const raw = window.localStorage.getItem(`cc.ui.${key}`)
  return raw === null ? fallback : raw === '1'
}

/** The context rail's state for one project: its files, its pins, and which list shows. It
 *  follows the project rather than the chat, so switching chats doesn't reload it, and the
 *  rail still shows while the project has no chat open. */
export type ProjectRail = {
  fsEntries: FsEntry[]
  setFsEntries: Dispatch<SetStateAction<FsEntry[]>>
  pins: PinnedMessage[]
  refreshPins: () => void
  pinnedUuids: Set<string>
  view: RailView
  setView: Dispatch<SetStateAction<RailView>>
  expanded: boolean
  setExpanded: Dispatch<SetStateAction<boolean>>
  /** The Create image dialog, which saves into the project's folder. */
  createImageOpen: boolean
  setCreateImageOpen: Dispatch<SetStateAction<boolean>>
}

export function useProjectRail(project: ChannelRow | null): ProjectRail {
  const [expanded, setExpanded] = useState(() => readStoredBool('rail', true))
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([])
  const [view, setView] = useState<RailView>(() => window.localStorage.getItem('cc.ui.railView') === 'pins' ? 'pins' : 'files')
  useEffect(() => { window.localStorage.setItem('cc.ui.railView', view) }, [view])
  const [pins, setPins] = useState<PinnedMessage[]>([])
  const [createImageOpen, setCreateImageOpen] = useState(false)

  // Load the project's file tree + git status for the context rail whenever the
  // open project changes. Walked on demand (no watcher yet); cheap + bounded.
  useEffect(() => {
    const cwd = project?.cwd ?? null
    if (cwd === null) { setFsEntries([]); return }
    let cancelled = false
    void api.fsTree(cwd).then(entries => { if (!cancelled) setFsEntries(entries) }).catch(() => { if (!cancelled) setFsEntries([]) })
    return () => { cancelled = true }
  }, [project?.cwd])

  // Pinned messages of the open project.
  const pinProjectId = project?.id ?? null
  const refreshPins = useCallback((): void => {
    if (pinProjectId === null) { setPins([]); return }
    void api.listPins(pinProjectId).then(setPins).catch(() => {})
  }, [pinProjectId])
  useEffect(() => { refreshPins() }, [refreshPins])
  const pinnedUuids = useMemo(() => new Set(pins.map(p => p.uuid)), [pins])

  return { fsEntries, setFsEntries, pins, refreshPins, pinnedUuids, view, setView, expanded, setExpanded, createImageOpen, setCreateImageOpen }
}
