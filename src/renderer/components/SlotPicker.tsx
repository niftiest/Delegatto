import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import type { ChannelRow } from '../../shared/types'
import type { ChannelGroup, AppSettings } from '../../shared/shell-types'
import { paneCount, type SplitLayout, type SplitPane } from '../../shared/split-view'
import { resolveChannelIcon, resolveChannelName, type ResolvedIcon } from '../lib'
import { pickerEmptyText, pickerSections } from '../project-picker'
import { findCreated, startChatIn } from '../start-chat'
import { LayoutGlyph } from './LayoutMenu'

export function ProjectIcon({ icon }: { icon: ResolvedIcon }) {
  const style: React.CSSProperties = icon.kind === 'initials' || icon.kind === 'color' ? { background: icon.color } : {}
  return (
    <span className={`split-pane-icon${icon.kind === 'emoji' ? ' emoji' : ''}`} style={style} aria-hidden="true">
      {icon.kind === 'initials' ? icon.text : icon.kind === 'emoji' ? icon.emoji : icon.kind === 'image' ? <img src={icon.dataUrl} alt="" /> : null}
    </span>
  )
}

/** Asks for a project for each slot from `startIndex`, `count` slots in all. Each project
 *  opens its most recent chat; one with no chats gets a new chat. Projects in `exclude`
 *  (shown in other panes) and those picked earlier in this run aren't offered. */
const NO_DIRS: string[] = []

export function SlotPicker({ layout, startIndex, count, channels, exclude = NO_DIRS, settings, onDone, onCancel }: {
  layout: SplitLayout
  startIndex: number
  count: number
  channels: ChannelRow[]
  /** Project folders (dirName) already shown in another pane. */
  exclude?: string[]
  /** The New chat defaults, for a project with no chats. */
  settings: AppSettings | null
  onDone(picked: SplitPane[]): void
  onCancel(): void
}) {
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<SplitPane[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<ChannelGroup[]>([])
  // A project whose new chat needs the New chat dialog: it opens in the main window once
  // the picker is done, and its slot is left empty.
  const deferred = useRef<{ cwd: string | null } | null>(null)
  // Projects sent to that dialog: not offered again for a later slot.
  const [deferredDirs, setDeferredDirs] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // A row picked out by the mouse is already on screen, so the list doesn't scroll to it.
  const byMouse = useRef(false)
  // Chromium sends a mousemove when the list changes under a still pointer (the groups arriving
  // a moment after opening); only a real move picks out a row.
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const hover = (i: number, e: React.MouseEvent): void => {
    const last = lastPointer.current
    lastPointer.current = { x: e.screenX, y: e.screenY }
    if (last === null || (last.x === e.screenX && last.y === e.screenY) || i === active) return
    byMouse.current = true
    setActive(i)
  }
  // Set by Cancel, Esc and unmounting: a pick still loading then comes to nothing.
  const stopped = useRef(false)
  useEffect(() => () => { stopped.current = true }, [])
  // Where the focus was when the picker opened, given back when it closes.
  const [returnTo] = useState<Element | null>(() => document.activeElement)
  const giveFocusBack = (): void => {
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus()
  }
  const cancel = (): void => {
    stopped.current = true
    giveFocusBack()
    onCancel()
  }

  useEffect(() => { void api.listGroups().then(setGroups).catch(() => {}) }, [])

  const taken = useMemo(() => [...exclude, ...deferredDirs, ...picked.flatMap(p => (p === null ? [] : [p.projectDir]))], [exclude, deferredDirs, picked])
  const sections = useMemo(() => pickerSections(channels, groups, query, taken), [channels, groups, query, taken])
  const rows = useMemo(() => sections.flatMap(s => s.channels), [sections])

  useEffect(() => { setActive(0) }, [query, step])
  useEffect(() => { inputRef.current?.focus() }, [step])
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    // The first row sits under its section's title: show the list from the very top, or the
    // title gets nudged out of view when the groups arrive a moment after opening.
    if (byMouse.current) { byMouse.current = false; return }
    if (active === 0) { list.scrollTop = 0; return }
    list.querySelector<HTMLElement>('.slot-picker-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [active, rows])

  const slot = startIndex + step
  const advance = (pane: SplitPane): void => {
    if (stopped.current) return
    const next = [...picked, pane]
    setError(null)
    setQuery('')
    if (next.length < count) { setPicked(next); setStep(s => s + 1); return }
    stopped.current = true
    giveFocusBack()
    onDone(next)
    const later = deferred.current
    if (later !== null) api.focusMain({ kind: 'newChat', cwd: later.cwd })
  }

  // Each await is checked: after Cancel, Esc or closing, nothing more happens. A chat
  // already created by then stays, in the chat list.
  const choose = async (project: ChannelRow): Promise<void> => {
    if (busy || stopped.current) return
    setBusy(true)
    setError(null)
    try {
      const chats = await api.listSessions(project.id)
      if (stopped.current) return
      const recent = chats[0]
      if (recent !== undefined) { advance({ sessionPk: recent.id, projectDir: project.dirName }); return }
      const started = await startChatIn(project, settings)
      if (stopped.current) return
      if (started.kind === 'error') { setError(started.message); return }
      if (started.kind === 'dialog') {
        deferred.current ??= { cwd: started.cwd }
        setDeferredDirs(dirs => [...dirs, project.dirName])
        advance(null)
        return
      }
      const found = await findCreated(started.cwd, started.sessionId)
      if (stopped.current) return
      if (found.created === null || found.project === null) {
        setError('The new chat is ready, but the chat list doesn’t have it yet. Pick the project again in a moment.')
        return
      }
      advance({ sessionPk: found.created.id, projectDir: found.project.dirName })
    } catch (err) {
      if (!stopped.current) setError(`Couldn't open that project: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (!stopped.current) setBusy(false)
    }
  }

  // Ahead of everything else: behind this dialog, Esc would stop a running turn, and the
  // window's shortcuts (find, search, Ctrl+1 to Ctrl+4) would act on the chats beneath it.
  // An app dialog on top of the picker takes its own Esc.
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && /^[1-4fk]$/i.test(e.key)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      if (e.key !== 'Escape' || document.querySelector('.app-dialog-overlay') !== null) return
      e.preventDefault()
      e.stopImmediatePropagation()
      cancelRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, Math.max(0, rows.length - 1))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active]
      if (row !== undefined) void choose(row)
    }
  }

  let index = 0
  return createPortal(
    <div className="modal-overlay slot-picker-overlay" role="presentation">
      <div className="modal slot-picker" role="dialog" aria-modal="true" aria-label={`Pick a project for pane ${slot + 1}`}>
        <div className="slot-picker-head">
          <LayoutGlyph layout={layout} highlight={slot} className="slot-picker-thumb" />
          <div className="slot-picker-heading">
            <h2 className="modal-title">Pick a project</h2>
            <div className="slot-picker-step">Pane {slot + 1} of {paneCount(layout)}</div>
          </div>
        </div>
        <input ref={inputRef} type="search" className="field-input slot-picker-search" placeholder="Search projects" aria-label="Search projects"
          value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} />
        <div className="slot-picker-list" ref={listRef} role="listbox" aria-label="Projects" aria-busy={busy}>
          {rows.length === 0 && <div className="slot-picker-empty">{pickerEmptyText(channels.length, query)}</div>}
          {sections.map(section => (
            <div key={section.title} className="slot-picker-section">
              <div className="slot-picker-section-title">{section.title}</div>
              {section.channels.map(c => {
                const i = index++
                const name = resolveChannelName(c.meta, c.cwd, c.dirName)
                return (
                  <button key={c.id} type="button" role="option" aria-selected={i === active} tabIndex={-1}
                    className={`slot-picker-row${i === active ? ' active' : ''}`} disabled={busy}
                    onMouseMove={e => hover(i, e)} onClick={() => void choose(c)}>
                    <ProjectIcon icon={resolveChannelIcon(c.meta, name)} />
                    <span className="slot-picker-name">{name}</span>
                    {c.cwd !== null && <span className="slot-picker-path">{c.cwd}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {error !== null && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={cancel}>Cancel</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => advance(null)}>Skip</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
