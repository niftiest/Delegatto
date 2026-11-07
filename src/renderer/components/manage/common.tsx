import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../../api'
import type { ArchiveSummary, ManageResult, WizardProcess } from '../../../shared/manage-types'

/** Shared pieces of the Manage screen (port of ClaudeMemoryTool's dialogs):
 *  multi-select, confirm / result dialogs, the "close Claude Code first" gate
 *  and the Import / Restore flow. */

export function formatSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function formatDate(ms: number | null, seconds = false): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` +
    (seconds ? `:${p(d.getSeconds())}` : '')
}

// ------------------------------------------------------------- multi-select

export type MultiSelect = {
  selected: Set<string>
  /** Click / Ctrl-click / Shift-click on a row of the visible `order`. */
  onRowClick: (e: React.MouseEvent, key: string) => void
  selectAll: () => void
  set: (keys: Iterable<string>) => void
  /** The row clicked last (drives a single-item preview / detail pane). */
  focus: string | null
}

/** Explorer-style selection over the rows in `order` (the visible, sorted keys). */
export function useMultiSelect(order: string[]): MultiSelect {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order

  // Rows that left the view (filter, delete) leave the selection too.
  useEffect(() => {
    const visible = new Set(order)
    setSelected(prev => {
      let changed = false
      const next = new Set<string>()
      for (const k of prev) { if (visible.has(k)) next.add(k); else changed = true }
      return changed ? next : prev
    })
    setFocus(f => (f !== null && !visible.has(f) ? null : f))
  }, [order])

  const onRowClick = useCallback((e: React.MouseEvent, key: string) => {
    const rows = orderRef.current
    if (e.shiftKey && anchor.current !== null && rows.includes(anchor.current)) {
      const a = rows.indexOf(anchor.current)
      const b = rows.indexOf(key)
      const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1)
      setSelected(prev => (e.ctrlKey || e.metaKey ? new Set([...prev, ...range]) : new Set(range)))
    } else if (e.ctrlKey || e.metaKey) {
      setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
      anchor.current = key
    } else {
      setSelected(new Set([key]))
      anchor.current = key
    }
    setFocus(key)
  }, [])

  const selectAll = useCallback(() => setSelected(new Set(orderRef.current)), [])
  const set = useCallback((keys: Iterable<string>) => setSelected(new Set(keys)), [])
  return { selected, onRowClick, selectAll, set, focus }
}

/** Ctrl+A / Del on a focused list. */
export function listKeys(e: React.KeyboardEvent, sel: MultiSelect, onDelete: (() => void) | null): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); sel.selectAll() }
  else if (e.key === 'Delete' && onDelete !== null && sel.selected.size > 0) { e.preventDefault(); onDelete() }
}

// ------------------------------------------------------------- sortable header

export type Sort<C extends string> = { col: C; desc: boolean }

export function SortTh<C extends string>({ col, sort, onSort, children, className, descFirst = false }: {
  col: C; sort: Sort<C>; onSort: (s: Sort<C>) => void; children: ReactNode; className?: string
  /** A first click on this column sorts descending (numbers, dates). */
  descFirst?: boolean
}) {
  const active = sort.col === col
  return (
    <th className={className} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="mg-th" onClick={() => onSort(active ? { col, desc: !sort.desc } : { col, desc: descFirst })}>
        {children}<span className="mg-sort" aria-hidden="true">{active ? (sort.desc ? '▾' : '▴') : ''}</span>
      </button>
    </th>
  )
}

// ------------------------------------------------------------- dialogs

export function Modal({ title, wide, onClose, children, busy = false }: {
  title: string; wide?: boolean; onClose: () => void; children: ReactNode; busy?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, busy])
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`modal mg-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="mg-dialog-body">{children}</div>
      <div className="modal-actions">
        {/* Cancel first and focused: Enter must not confirm a destructive action. */}
        <button type="button" className="btn-secondary" autoFocus onClick={onCancel}>Cancel</button>
        <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}

export function PathLine({ label, path }: { label: string; path: string }) {
  return (
    <p className="dw-path">{label}: <code>{path}</code>{' '}
      <button type="button" className="btn-link" onClick={() => void api.showInFolder(path)}>Show in folder</button></p>
  )
}

/** What an operation did and what failed, plus backup / restore-point paths (the C# ResultForm). */
export function ResultDialog({ title, result, note, showBackup = false, onClose }: {
  title: string; result: ManageResult; note?: ReactNode; showBackup?: boolean; onClose: () => void
}) {
  return (
    <Modal title={title} wide onClose={onClose}>
      {result.kind === 'done' ? (
        <div className="mg-result">
          <p className={result.failures.length === 0 ? 'dw-ok' : 'dw-warn'}>
            {result.failures.length === 0 ? 'Finished without errors.' : `Finished with ${result.failures.length} failure(s).`}
          </p>
          {note !== undefined && <div className="dw-note">{note}</div>}
          {result.failures.length > 0 && (
            <>
              <div className="mg-result-head">Failed ({result.failures.length})</div>
              <ul className="mg-result-list bad">
                {result.failures.map((f, i) => <li key={i}><code>{f.path}</code><span>{f.error}</span></li>)}
              </ul>
            </>
          )}
          <div className="mg-result-head">Done ({result.done.length})</div>
          <ul className="mg-result-list">
            {result.done.length === 0 ? <li className="mg-muted">(nothing)</li> : result.done.map((d, i) => <li key={i}><code>{d}</code></li>)}
          </ul>
          {result.zip !== undefined && result.zip !== null && <PathLine label="Saved to" path={result.zip} />}
          {result.backupDir !== null
            ? <PathLine label="Backup of .claude.json / history.jsonl" path={result.backupDir} />
            : showBackup && <p className="dw-path mg-muted">Backup folder: none (.claude.json and history.jsonl were not edited).</p>}
        </div>
      ) : result.kind === 'sessions' ? (
        <div className="mg-result">
          <p className="dw-warn">{result.error}</p>
          <ProcList procs={result.sessions} />
        </div>
      ) : result.kind === 'error' ? (
        <p className="dw-error">{result.error}</p>
      ) : (
        <p className="dw-note">Canceled.</p>
      )}
      <div className="modal-actions"><button type="button" className="btn-primary" autoFocus onClick={onClose}>Close</button></div>
    </Modal>
  )
}

export function ProcList({ procs }: { procs: WizardProcess[] }) {
  return (
    <ul className="dw-procs">
      {procs.map(p => (
        <li key={p.pid}>
          <span className={`dw-owner ${p.owner}`}>{p.owner === 'app' ? 'Delegatto' : 'Terminal'}</span>
          <span className="dw-proc-name">{p.name ?? (p.sessionId ? p.sessionId.slice(0, 8) : '(unnamed)')}</span>
          <span className="dw-proc-meta">PID {p.pid} · {p.cwd || '(unreadable session file)'}</span>
        </li>
      ))}
    </ul>
  )
}

/** Ends the given processes (Delegatto's own via the pool, others verified),
 *  then waits briefly for their locks to go. Returns failure lines. */
export async function endAndWait(procs: WizardProcess[]): Promise<{ left: WizardProcess[]; errors: string[] }> {
  const r = await api.endSessions(procs.map(p => p.pid))
  const errors = r.failures.map(f => `PID ${f.pid}: ${f.error}`)
  let left = await api.liveSessions()
  for (let i = 0; i < 10 && left.some(l => procs.some(p => p.pid === l.pid)); i++) {
    await new Promise(res => setTimeout(res, 500))
    left = await api.liveSessions()
  }
  return { left, errors }
}

export const END_ALL_WARNING =
  'Any reply in progress is lost. Chat history already saved is kept, and the sessions can be resumed later.'

/** "Close Claude Code first" (the C# LiveSessionsForm): changes to
 *  .claude.json / history.jsonl need every session closed. Goes straight on
 *  when nothing is running at the first look; otherwise Continue unlocks once
 *  Check again (or End all) finds none. Advisory: the operation itself checks
 *  again right before its first change and refuses with `sessions`. */
export function LiveGate({ what, onContinue, onCancel }: { what: string; onContinue: () => void; onCancel: () => void }) {
  const [procs, setProcs] = useState<WizardProcess[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const first = useRef(true)

  const check = useCallback(async () => {
    setBusy(true)
    try {
      const list = await api.liveSessions()
      if (first.current && list.length === 0) { first.current = false; onContinue(); return }
      first.current = false
      setProcs(list)
    } finally { setBusy(false) }
  }, [onContinue])
  useEffect(() => { void check() }, [])

  if (procs === null) return null
  const none = procs.length === 0
  return (
    <Modal title="Claude Code sessions are running" wide onClose={onCancel} busy={busy}>
      <div className="dw-body">
        <p className="dw-note">
          {none
            ? 'No Claude Code sessions are running. You can continue.'
            : `${procs.length} Claude Code session(s) are running. ${what} needs every Claude Code session to be closed ` +
              '(it edits .claude.json / history.jsonl). Close them, then click Check again, or end them from here.'}
        </p>
        {!none && <ProcList procs={procs} />}
        {errors.length > 0 && <ul className="dw-errors">{errors.map(e => <li key={e}>{e}</li>)}</ul>}
        {confirm && (
          <div className="dw-confirm">
            End all {procs.length} running Claude Code session(s)? {END_ALL_WARNING}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" autoFocus onClick={() => setConfirm(false)}>Cancel</button>
              <button type="button" className="btn-danger" onClick={() => {
                setConfirm(false); setBusy(true)
                void endAndWait(procs).then(r => { setErrors(r.errors); setProcs(r.left) }).finally(() => setBusy(false))
              }}>End all</button>
            </div>
          </div>
        )}
        {!confirm && (
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void check()}>Check again</button>
            {!none && <button type="button" className="btn-danger" disabled={busy} onClick={() => setConfirm(true)}>End all sessions…</button>}
            <button type="button" className="btn-primary" disabled={!none || busy} onClick={onContinue}>Continue</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------- import / restore flow

type ImportStep =
  | { s: 'idle' }
  | { s: 'reading'; zip: string }
  | { s: 'confirm'; zip: string; summary: ArchiveSummary }
  | { s: 'gate'; zip: string; summary: ArchiveSummary }
  | { s: 'running'; zip: string; summary: ArchiveSummary }
  | { s: 'result'; summary: ArchiveSummary | null; result: ManageResult }

/** Import… (and Restore…): pick a zip (unless given) -> read what it holds ->
 *  confirm -> close sessions for a projects export -> import -> result.
 *  `onDone` runs after an import that may have changed something. */
export function useImportFlow(onDone: () => void, restore = false): { start: (zip?: string) => void; element: ReactNode } {
  const [step, setStep] = useState<ImportStep>({ s: 'idle' })
  const label = restore ? 'Restore' : 'Import'

  const start = useCallback((zip?: string) => {
    void (async () => {
      const path = zip ?? await api.pickImport()
      if (path === null) return
      setStep({ s: 'reading', zip: path })
      try {
        setStep({ s: 'confirm', zip: path, summary: await api.readArchive(path) })
      } catch (e) {
        setStep({ s: 'result', summary: null, result: { kind: 'error', error: e instanceof Error ? e.message : String(e) } })
      }
    })()
  }, [])

  const run = useCallback((zip: string, summary: ArchiveSummary) => {
    setStep({ s: 'running', zip, summary })
    void api.importArchive(zip).then(result => {
      setStep({ s: 'result', summary, result })
      if (result.kind !== 'sessions') onDone()
    })
  }, [onDone])

  let element: ReactNode = null
  if (step.s === 'reading' || step.s === 'running') {
    element = (
      <Modal title={label} onClose={() => {}} busy>
        <p className="dw-note">{step.s === 'reading' ? 'Reading the export…' : `${restore ? 'Restoring' : 'Importing'}…`}</p>
        <div className="dw-progress"><i /></div>
      </Modal>
    )
  } else if (step.s === 'confirm') {
    const m = step.summary
    const items = m.kind === 'Projects'
      ? m.projects.map(p => `${p.workingDir}  (${p.files} files${p.historyLines > 0 ? `, ${p.historyLines} history lines` : ''})`)
      : m.notes
    element = (
      <ConfirmDialog title={label} confirmLabel={label} onCancel={() => setStep({ s: 'idle' })}
        onConfirm={() => m.kind === 'Projects' ? setStep({ s: 'gate', zip: step.zip, summary: m }) : run(step.zip, m)}>
        <p className="dw-note">
          Restore {m.kind === 'Projects' ? `Claude data for ${m.projects.length} project(s)` : `${m.notes.length} note(s)`}
          {' '}exported {formatDate(m.created)} on {m.machine || 'an unknown machine'}?
        </p>
        <ul className="mg-plain-list">
          {items.slice(0, 12).map(i => <li key={i}><code>{i}</code></li>)}
          {items.length > 12 && <li className="mg-muted">… and {items.length - 12} more</li>}
        </ul>
        <p className="dw-hint">Files go back to their original locations. Anything that already exists is kept as it is (never overwritten).
          {m.kind === 'Projects' && ' This edits .claude.json and history.jsonl (after a backup), so every Claude Code session must be closed.'}</p>
      </ConfirmDialog>
    )
  } else if (step.s === 'gate') {
    element = <LiveGate what={label} onCancel={() => setStep({ s: 'idle' })} onContinue={() => run(step.zip, step.summary)} />
  } else if (step.s === 'result') {
    element = <ResultDialog title={step.result.kind === 'done' ? `${label} finished` : label} result={step.result}
      showBackup={step.summary?.kind === 'Projects'} onClose={() => setStep({ s: 'idle' })} />
  }
  return { start, element }
}
