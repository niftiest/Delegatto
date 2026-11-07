import { useEffect, useState } from 'react'
import type { DeleteTarget } from '../../../shared/manage-types'
import { ProjectsTab } from './ProjectsTab'
import { NotesTab } from './NotesTab'
import { RestoreTab } from './RestoreTab'
import { LiveTab } from './LiveTab'

/** The Manage screen (port of ClaudeMemoryTool): replaces the chat pane and
 *  the chat list while open. Browsing and search are read-only; every change
 *  goes through a confirm step and reports what it did. Tabs stay mounted so
 *  switching keeps their state (search, selection, scans). */

export type ManageTabId = 'projects' | 'notes' | 'restore' | 'live'
const TABS: Array<{ id: ManageTabId; label: string }> = [
  { id: 'projects', label: 'Projects' },
  { id: 'notes', label: 'Notes' },
  { id: 'restore', label: 'Restore points' },
  { id: 'live', label: 'Live sessions' }
]

export function ManageView({ epoch, onClose, onDelete, onChanged }: {
  /** Bumped when Claude data changed elsewhere (the Delete wizard). */
  epoch: number
  onClose: () => void
  onDelete: (target: DeleteTarget) => void
  /** Claude data changed from this screen: refresh the sidebar / open chat. */
  onChanged: () => void
}) {
  const [tab, setTab] = useState<ManageTabId>('projects')
  const [localEpoch, setLocalEpoch] = useState(0)
  const changed = (): void => { setLocalEpoch(e => e + 1); onChanged() }
  const all = epoch + localEpoch

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.modal-overlay') !== null) return
      if (e.target instanceof HTMLInputElement && e.target.value !== '') return // Esc clears a search box first
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <section className="mg" aria-label="Manage">
      <header className="mg-head">
        <h1>Manage</h1>
        <nav className="mg-tabs" role="tablist" aria-label="Manage sections">
          {TABS.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              className={`mg-tabbtn${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <span className="mg-head-hint">Claude Code's data on this PC · browsing and search never change anything</span>
        <button type="button" className="mg-close" title="Close (Esc)" aria-label="Close Manage" onClick={onClose}>✕</button>
      </header>
      <div className="mg-body">
        <div hidden={tab !== 'projects'} className="mg-pane">
          <ProjectsTab active={tab === 'projects'} epoch={all} onDelete={onDelete} onChanged={changed}
            onOpenRestorePoints={() => setTab('restore')} />
        </div>
        <div hidden={tab !== 'notes'} className="mg-pane">
          <NotesTab active={tab === 'notes'} epoch={all} onChanged={changed} />
        </div>
        <div hidden={tab !== 'restore'} className="mg-pane">
          <RestoreTab active={tab === 'restore'} epoch={all} onChanged={changed} />
        </div>
        <div hidden={tab !== 'live'} className="mg-pane">
          <LiveTab active={tab === 'live'} />
        </div>
      </div>
    </section>
  )
}
