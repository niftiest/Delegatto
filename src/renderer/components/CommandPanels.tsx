import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogTarget } from './DialogHost'
import { escapeIsFor } from '../escape-scope'
import { api } from '../api'
import { backgroundTaskLabel, taskHasOutput } from '../lib'
import type { BackgroundTask } from '../../shared/engine-types'
import type { DiffFile, HookEntry, HookScope, HooksListing, WorkspaceDiff } from '../../shared/command-panels-types'

/** Delegatto's screens for Claude Code's /hooks, /diff, /tasks and /export. */

function PanelModal({ title, label, wide = false, onClose, children, actions }: {
  title: string; label: string; wide?: boolean; onClose: () => void; children: ReactNode; actions?: ReactNode
}) {
  const dialogTarget = useDialogTarget()
  useEffect(() => {
    // Ahead of everything else: behind this dialog, Esc would act on the message box.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !escapeIsFor(dialogTarget, e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, dialogTarget])
  return createPortal(
    <div className="modal-overlay app-dialog-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={wide ? 'modal command-panel command-panel-wide' : 'modal command-panel'} role="dialog" aria-modal="true" aria-label={label}>
        <h2 className="modal-title">{title}</h2>
        <div className="command-panel-body">{children}</div>
        <div className="modal-actions">
          {actions}
          <button type="button" className="btn-primary" autoFocus onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    dialogTarget
  )
}

const SCOPE_NAMES: Record<HookScope, string> = { user: 'All projects (~/.claude/settings.json)', project: 'This project, shared (.claude/settings.json)', local: 'This project, just you (.claude/settings.local.json)' }

/** /hooks: every hook Claude Code has for this chat, by event, and where each one comes from.
 *  Hooks in a settings file can be removed, and new ones added, as the terminal's screen allows. */
export function HooksDialog({ sessionPk, onClose }: { sessionPk: number; onClose: () => void }) {
  const [listing, setListing] = useState<HooksListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ event: 'PreToolUse', matcher: '', command: '', scope: 'user' as HookScope })
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setError(null)
    void api.hooksListing(sessionPk).then(r => { if (r.ok) setListing(r.value); else setError(r.error) })
  }, [sessionPk])
  useEffect(load, [load])

  const byEvent = useMemo(() => {
    const groups = new Map<string, HookEntry[]>()
    for (const h of listing?.hooks ?? []) groups.set(h.event, [...(groups.get(h.event) ?? []), h])
    return [...groups.entries()]
  }, [listing])
  const summaryOf = (event: string): string => listing?.catalog.find(e => e.name === event)?.summary ?? ''
  const formEvent = listing?.catalog.find(e => e.name === form.event)

  async function remove(h: HookEntry): Promise<void> {
    setBusy(true)
    const r = await api.removeHook(sessionPk, h)
    setBusy(false)
    if (r.ok) setListing(r.value)
    else if (!('cancelled' in r)) setError(r.error)
  }
  async function add(): Promise<void> {
    setBusy(true)
    const r = await api.addHook(sessionPk, form.scope, { event: form.event, matcher: formEvent?.supportsMatcher === true && form.matcher.trim() !== '' ? form.matcher : null, command: form.command })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setListing(r.value)
    setAdding(false)
    setForm({ ...form, matcher: '', command: '' })
  }

  return (
    <PanelModal title="Hooks" label="Hooks" wide onClose={onClose}
      actions={listing !== null && !adding ? <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>Add hook…</button> : undefined}>
      <p className="app-dialog-detail">Commands Claude Code runs at points in a chat, such as before a tool runs. Changes apply to this folder’s chats when they next start; Delegatto restarts idle ones for you.</p>
      {error !== null && <div className="cc-err">{error}</div>}
      {listing === null && error === null && <p className="settings-note">Asking Claude Code…</p>}
      {listing?.policyNote != null && <div className="cc-warn">{listing.policyNote}</div>}
      {adding && listing !== null && (
        <div className="hook-form">
          <label>Event
            <select value={form.event} onChange={e => setForm({ ...form, event: e.target.value })}>
              {listing.catalog.map(e => <option key={e.name} value={e.name}>{e.name}: {e.summary}</option>)}
            </select>
          </label>
          {formEvent?.supportsMatcher === true && (
            <label>Matcher <span className="settings-hint">Which tools (or sources) it runs for, such as Bash or Edit|Write. Empty means all.</span>
              <input type="text" value={form.matcher} onChange={e => setForm({ ...form, matcher: e.target.value })} placeholder="All" />
            </label>
          )}
          <label>Command
            <input type="text" value={form.command} onChange={e => setForm({ ...form, command: e.target.value })} placeholder="e.g. npm run lint" autoFocus />
          </label>
          <label>Save in
            <select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value as HookScope })}>
              {(['user', 'project', 'local'] as const).map(s => <option key={s} value={s}>{SCOPE_NAMES[s]}</option>)}
            </select>
          </label>
          <div className="hook-form-actions">
            <button type="button" className="btn-primary" disabled={busy || form.command.trim() === ''} onClick={() => void add()}>Add</button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {listing !== null && byEvent.length === 0 && !adding && <p className="settings-note">No hooks are set up for this chat.</p>}
      {byEvent.map(([event, list]) => (
        <section key={event} className="hook-event">
          <h3>{event} <span className="settings-hint">{summaryOf(event)}</span></h3>
          <div className="ms-list">
            {list.map((h, i) => (
              <div key={`${h.source}:${h.matcher ?? ''}:${i}`} className="ms-item">
                <div className="ms-item-head">
                  {h.matcher !== null && <span className="ms-badge" title="Matcher">{h.matcher}</span>}
                  <span className="ms-scope" title={h.sourceLabel}>{h.pluginName !== null ? `plugin ${h.pluginName}` : h.sourceLabel.replace(/\s*\(.*\)$/, '')}</span>
                  {h.type !== 'command' && <span className="ms-badge">{h.type}</span>}
                  <span className="mcp-item-actions">
                    {h.scope !== null && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void remove(h)}>Remove</button>}
                  </span>
                </div>
                <code className="hook-text">{h.text}</code>
              </div>
            ))}
          </div>
        </section>
      ))}
    </PanelModal>
  )
}

function DiffLines({ file }: { file: DiffFile }) {
  if (file.binary) return <p className="settings-note">A binary file; there are no lines to show.</p>
  if (file.hunks.length === 0) return <p className="settings-note">{file.untracked ? 'A new file Git isn’t tracking yet.' : 'No line changes to show.'}</p>
  return <>
    {file.hunks.map((h, i) => {
      let oldNo = h.oldStart, newNo = h.newStart
      return (
        <div key={i} className="diff-hunk">
          <div className="diff-hunk-head">@@ line {h.newStart} @@</div>
          {h.lines.map((line, j) => {
            const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
            const no = kind === 'del' ? oldNo++ : (kind === 'add' ? newNo++ : (oldNo++, newNo++))
            return <div key={j} className={`diff-line diff-${kind}`}><span className="diff-no">{no}</span><span className="diff-text">{line}</span></div>
          })}
        </div>
      )
    })}
  </>
}

/** /diff: what has changed in the chat's folder, file by file, as Claude Code's /diff shows. */
export function DiffDialog({ sessionPk, onClose }: { sessionPk: number; onClose: () => void }) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const load = useCallback(() => {
    setError(null)
    setDiff(null)
    void api.workspaceDiff(sessionPk).then(r => {
      if (!r.ok) { setError(r.error); return }
      setDiff(r.value)
      setSelected(s => s ?? r.value.files[0]?.path ?? null)
    })
  }, [sessionPk])
  useEffect(load, [load])
  const file = diff?.files.find(f => f.path === selected) ?? null
  const title = diff === null ? 'Changes' : diff.files.length === 0 ? 'No changes' : `${diff.files.length} file${diff.files.length === 1 ? '' : 's'} changed`
  return (
    <PanelModal title={title} label="Changes" wide onClose={onClose} actions={<button type="button" className="btn-secondary" onClick={load}>Refresh</button>}>
      {error !== null && <div className="cc-err">Couldn’t get the changes: {error}</div>}
      {diff === null && error === null && <p className="settings-note">Asking Claude Code what has changed…</p>}
      {diff !== null && <>
        <p className="app-dialog-detail">
          <span className="diff-plus">+{diff.added}</span> <span className="diff-minus">−{diff.removed}</span>{' '}
          {diff.baseBranch !== null ? `compared with ${diff.baseBranch}, including changes not yet committed.` : 'not yet committed.'}
          {diff.skipped.length > 0 && ` Too big to show: ${diff.skipped.join(', ')}.`}
        </p>
        {diff.files.length > 0 && (
          <div className="diff-split">
            <div className="diff-files" role="listbox" aria-label="Changed files">
              {diff.files.map(f => (
                <button key={f.path} type="button" role="option" aria-selected={f.path === selected} className={f.path === selected ? 'diff-file active' : 'diff-file'} onClick={() => setSelected(f.path)} title={f.path}>
                  <span className="diff-file-name">{f.path}</span>
                  <span className="diff-file-stat">{f.untracked || f.status === 'added' ? 'new ' : f.status === 'deleted' ? 'deleted ' : ''}<span className="diff-plus">+{f.added}</span> <span className="diff-minus">−{f.removed}</span></span>
                </button>
              ))}
            </div>
            <div className="diff-view">{file !== null && <DiffLines file={file} />}</div>
          </div>
        )}
      </>}
    </PanelModal>
  )
}

/** /tasks (and /bashes): every background task in this chat, with its output and a stop button. */
export function TasksDialog({ tasks, onStop, onShowOutput, onClose }: {
  tasks: BackgroundTask[]; onStop: (taskId: string) => void; onShowOutput: (taskId: string, title: string) => void; onClose: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return (
    <PanelModal title="Background tasks" label="Background tasks" onClose={onClose}>
      {tasks.length === 0 && <p className="settings-note">Nothing is running in the background in this chat.</p>}
      <div className="ms-list">
        {tasks.map(task => {
          const { title, details } = backgroundTaskLabel(task, now)
          return (
            <div key={task.id} className="ms-item">
              <div className="ms-item-head">
                <span className="ms-name task-title" title={title}>{title}</span>
                <span className="mcp-item-actions">
                  {taskHasOutput(task.type) && <button type="button" className="btn-secondary" onClick={() => onShowOutput(task.id, title)}>Output</button>}
                  <button type="button" className="btn-secondary" onClick={() => onStop(task.id)}>Stop</button>
                </span>
              </div>
              <div className="ms-detail">{details.join(' · ')}</div>
            </div>
          )
        })}
      </div>
    </PanelModal>
  )
}

/** /export: the chat as text, copied or saved, as the terminal's /export offers. */
export function ExportDialog({ sessionPk, onClose, onDone }: { sessionPk: number; onClose: () => void; onDone: (text: string, good: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  async function copy(): Promise<void> {
    setBusy(true)
    const r = await api.exportChat(sessionPk, 'text')
    setBusy(false)
    if (r.status !== 'text') { onDone(r.status === 'failed' ? `Couldn’t export: ${r.message}` : 'Couldn’t export this chat.', false); return }
    try { await navigator.clipboard.writeText(r.text); onDone('Copied this chat to the clipboard.', true) } catch { onDone('Couldn’t copy to the clipboard.', false) }
  }
  async function save(): Promise<void> {
    setBusy(true)
    const r = await api.exportChat(sessionPk, 'file')
    setBusy(false)
    if (r.status === 'cancelled') return
    if (r.status === 'saved') onDone(`Saved this chat to ${r.path}`, true)
    else onDone(r.status === 'failed' ? `Couldn’t export: ${r.message}` : 'Couldn’t export this chat.', false)
  }
  return (
    <PanelModal title="Export this chat" label="Export chat" onClose={onClose}
      actions={<>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void copy()}>Copy to clipboard</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void save()}>Save to file…</button>
      </>}>
      <p className="app-dialog-detail">The whole conversation as plain text: your messages, Claude’s replies, and each tool call with the start of what it returned. Thinking is left out. <code>/export name</code> saves straight to the chat’s folder.</p>
    </PanelModal>
  )
}
