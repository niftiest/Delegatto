import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../api'
import type { ManageResult, NoteHitRow, NotePreview, NotesIndex } from '../../../shared/manage-types'
import {
  ConfirmDialog, formatDate, listKeys, ResultDialog, SortTh, useImportFlow, useMultiSelect, type Sort
} from './common'

/** Manage → Notes (port of ClaudeMemoryTool's NotesPanel): the *.md files
 *  inside the projects' working folders, searched by name and content. Empty
 *  search = every note, newest first. Preview highlights the matches;
 *  double-click opens the file in the editor. */

type Col = 'project' | 'file' | 'matches' | 'first' | 'modified'
const MAX_HIGHLIGHTS = 300

function highlight(text: string, q: string): { nodes: ReactNode[]; count: number } {
  if (q === '') return { nodes: [text], count: 0 }
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const nodes: ReactNode[] = []
  let at = 0
  let count = 0
  for (let i = lower.indexOf(ql); i >= 0 && count < MAX_HIGHLIGHTS; i = lower.indexOf(ql, i + ql.length), count++) {
    if (i > at) nodes.push(text.slice(at, i))
    nodes.push(<mark key={i} className={count === 0 ? 'mg-hl first' : 'mg-hl'}>{text.slice(i, i + q.length)}</mark>)
    at = i + q.length
  }
  nodes.push(text.slice(at))
  return { nodes, count }
}

export function NotesTab({ active, epoch, onChanged }: {
  active: boolean
  /** Bumped when the projects changed: the notes index is rebuilt on next view. */
  epoch: number
  onChanged: () => void
}) {
  const [index, setIndex] = useState<NotesIndex | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [hits, setHits] = useState<NoteHitRow[]>([])
  const [searchedFor, setSearchedFor] = useState('')
  const [searchMs, setSearchMs] = useState(0)
  const [searching, setSearching] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort<Col>>({ col: 'modified', desc: true })
  const [preview, setPreview] = useState<{ path: string; p: NotePreview } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<NoteHitRow[] | null>(null)
  const [result, setResult] = useState<{ title: string; result: ManageResult; note?: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLPreElement>(null)
  const indexGen = useRef(0)
  const searchGen = useRef(0)
  const builtFor = useRef<number | null>(null)

  const q = query.trim()
  const queryRef = useRef(q)
  queryRef.current = q

  const search = useCallback(async (text: string) => {
    const gen = ++searchGen.current
    setSearching(true)
    try {
      const r = await api.searchNotes(text)
      if (gen !== searchGen.current || !r.ok) return
      setHits(r.hits)
      setSearchedFor(text)
      setSearchMs(r.searchMs)
      setStatus(null)
    } catch (e) {
      if (gen === searchGen.current) setStatus('Search failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (gen === searchGen.current) setSearching(false)
    }
  }, [])

  const rebuild = useCallback(async (rescan: boolean) => {
    const gen = ++indexGen.current
    ++searchGen.current // a search over the old list must not land on top of the new scan
    setIndexing(true)
    setStatus('Finding .md files in project folders…')
    try {
      const r = await api.findNotes(rescan)
      if (gen !== indexGen.current) return
      setIndex(r)
      setStatus(null)
      await search(queryRef.current)
    } catch (e) {
      if (gen === indexGen.current) { setStatus('Could not list notes: ' + (e instanceof Error ? e.message : String(e))); builtFor.current = null }
    } finally {
      if (gen === indexGen.current) setIndexing(false)
    }
  }, [search])

  // Built on first view, and again on the next view after the projects changed.
  useEffect(() => {
    if (!active || builtFor.current === epoch) return
    builtFor.current = epoch
    void rebuild(false)
  }, [active, epoch, rebuild])

  // Debounced search; main cancels an older one when a newer one starts.
  const firstQuery = useRef(true)
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return }
    if (index === null || indexing) return
    const t = setTimeout(() => void search(q), 300)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const dir = sort.desc ? -1 : 1
    const cmp = (a: NoteHitRow, b: NoteHitRow): number => {
      switch (sort.col) {
        case 'file': return a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' })
        case 'matches': return a.matchCount - b.matchCount
        case 'first': return a.firstLineText.localeCompare(b.firstLineText, undefined, { sensitivity: 'base' })
        case 'modified': return a.modified - b.modified
        default: return a.workingDir.localeCompare(b.workingDir, undefined, { sensitivity: 'base' })
      }
    }
    return [...hits].sort((a, b) => cmp(a, b) * dir || a.path.localeCompare(b.path))
  }, [hits, sort])

  const order = useMemo(() => rows.map(r => r.path), [rows])
  const sel = useMultiSelect(order)
  const selected = useMemo(() => rows.filter(r => sel.selected.has(r.path)), [rows, sel.selected])
  const focused = sel.focus !== null && sel.selected.has(sel.focus) ? rows.find(r => r.path === sel.focus) ?? null : selected[0] ?? null

  // Preview the focused note.
  useEffect(() => {
    if (focused === null) { setPreview(null); return }
    let cancelled = false
    void api.previewNote(focused.path).then(p => { if (!cancelled) setPreview({ path: focused.path, p }) })
    return () => { cancelled = true }
  }, [focused?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    if (preview === null || preview.p.kind !== 'text') return null
    return highlight(preview.p.text, searchedFor)
  }, [preview, searchedFor])

  // Scroll the first match into view.
  useEffect(() => {
    const el = previewRef.current?.querySelector('mark.first')
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' })
    else previewRef.current?.scrollTo({ top: 0 })
  }, [shown])

  const open = (path: string): void => {
    void api.openInEditor(path).then(err => { if (err !== null) setStatus('Could not open: ' + err) })
  }

  const doDelete = async (notes: NoteHitRow[]): Promise<void> => {
    setConfirmDelete(null)
    ++searchGen.current // a running search would put the deleted notes back
    setStatus('Deleting notes…')
    const r = await api.deleteNotes(notes.map(n => n.path))
    if (r.kind === 'done') {
      const gone = new Set(r.done.map(d => d.toLowerCase()))
      setHits(prev => prev.filter(h => !gone.has(h.path.toLowerCase())))
      setIndex(prev => prev === null ? prev : { ...prev, notes: prev.notes.filter(n => !gone.has(n.path.toLowerCase())) })
      setStatus(`Moved ${r.done.length} note(s) to the Recycle Bin` + (r.failures.length === 0 ? '' : `, ${r.failures.length} failed`))
      if (r.failures.length > 0) setResult({ title: 'Delete notes', result: r })
    } else {
      setStatus(null)
      setResult({ title: 'Delete notes', result: r })
    }
  }

  const doExport = async (): Promise<void> => {
    if (selected.length === 0) return
    setStatus('Exporting notes…')
    const r = await api.exportNotes(selected.map(n => n.path))
    setStatus(r.kind === 'done' ? `Exported ${selected.length - r.failures.length} note(s) to ${r.zip ?? ''}` : null)
    if (r.kind !== 'cancelled') {
      setResult({ title: r.kind === 'done' ? 'Export finished' : 'Export', result: r,
        note: 'Import the zip (on either tab) to put the notes back where they were.' })
    }
  }

  const afterImport = useCallback(() => { onChanged(); void rebuild(true) }, [onChanged, rebuild])
  const importFlow = useImportFlow(afterImport)

  const projectsWithHits = new Set(hits.map(h => h.workingDir.toLowerCase())).size
  const summary = index === null ? '' : (searchedFor === ''
    ? `${hits.length} notes in ${projectsWithHits} projects`
    : `${hits.length} of ${index.notes.length} notes match in ${projectsWithHits} projects`) +
    ` · scan ${(index.scanMs / 1000).toFixed(1)}s, search ${(searchMs / 1000).toFixed(1)}s`

  return (
    <div className="mg-tab">
      <div className="mg-toolbar">
        <div className="mg-buttons">
          <button type="button" className="btn-secondary mg-btn" disabled={indexing} onClick={() => void rebuild(true)}>Rescan notes</button>
          <button type="button" className="btn-danger mg-btn" disabled={selected.length === 0} onClick={() => setConfirmDelete(selected)}>Delete…</button>
          <button type="button" className="btn-secondary mg-btn" disabled={selected.length === 0} onClick={() => void doExport()}>Export…</button>
          <button type="button" className="btn-secondary mg-btn" onClick={() => importFlow.start()}>Import…</button>
        </div>
        <input className="field-input mg-search" type="search" placeholder="Search .md files in project folders…"
          aria-label="Search notes" value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      {index !== null && index.truncated.length > 0 && (
        <div className="mg-notice" role="note">
          Partly scanned (folder tree too large, walked up to 20,000 folders): {index.truncated.join(', ')}
        </div>
      )}

      <div className="mg-split">
        <div className="mg-table-wrap" ref={listRef} tabIndex={0} aria-label="Notes"
          onKeyDown={e => listKeys(e, sel, () => setConfirmDelete(selected))}>
          <table className="mg-table" aria-multiselectable="true">
            <thead>
              <tr>
                <SortTh col="project" sort={sort} onSort={setSort}>Project</SortTh>
                <SortTh col="file" sort={sort} onSort={setSort}>File</SortTh>
                <SortTh col="matches" sort={sort} onSort={setSort} className="mg-num" descFirst>Matches</SortTh>
                <SortTh col="first" sort={sort} onSort={setSort}>First match</SortTh>
                <SortTh col="modified" sort={sort} onSort={setSort} className="mg-c-date" descFirst>Modified</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.map(h => {
                const isSel = sel.selected.has(h.path)
                return (
                  <tr key={h.path} aria-selected={isSel} className={isSel ? 'sel' : ''} title={h.path}
                    onMouseDown={e => { if (e.shiftKey) e.preventDefault() }}
                    onClick={e => { sel.onRowClick(e, h.path); listRef.current?.focus() }}
                    onDoubleClick={() => open(h.path)}>
                    <td className="mg-c-dir">{h.workingDir}</td>
                    <td className="mg-c-file">{h.relativePath}{h.cloudOnly && <span className="mg-tag" title="Online-only (OneDrive) — never downloaded">online-only</span>}</td>
                    <td className="mg-num">{searchedFor === '' ? '' : h.matchCount}</td>
                    <td className="mg-c-first">{h.matchCount > 0 ? `${h.firstLineNumber}: ${h.firstLineText}` : h.nameMatch ? '(file name)' : ''}</td>
                    <td className="mg-c-date">{formatDate(h.modified)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {index !== null && !indexing && rows.length === 0 && (
            <div className="mg-empty">{searching ? 'Searching…' : searchedFor === '' ? 'No notes found.' : 'No note matches.'}</div>
          )}
          {index === null && <div className="mg-empty">{status ?? 'Finding notes…'}</div>}
        </div>

        <div className="mg-detail mg-note-preview" aria-label="Preview">
          {focused === null ? (
            <div className="mg-empty">{selected.length > 1 ? `${selected.length} notes selected.` : 'Select a note to preview it. Double-click opens it in your editor.'}</div>
          ) : (
            <>
              <div className="mg-detail-head">
                <span className="mg-detail-title" title={focused.path}>{focused.path}</span>
                {shown !== null && searchedFor !== '' && <span className="mg-muted">{shown.count >= MAX_HIGHLIGHTS ? `${MAX_HIGHLIGHTS}+` : shown.count} highlighted</span>}
                <button type="button" className="btn-link" onClick={() => open(focused.path)}>Open</button>
                <button type="button" className="btn-link" onClick={() => void api.showInFolder(focused.path)}>Show in folder</button>
              </div>
              {preview === null || preview.path !== focused.path ? <div className="mg-empty">Loading…</div>
                : preview.p.kind === 'message' ? <div className="mg-empty">{preview.p.text}</div>
                : <pre ref={previewRef} className="mg-pre">{shown?.nodes.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</pre>}
            </>
          )}
        </div>
      </div>

      <div className="mg-status" role="status">
        {status ?? summary}
        {searching && index !== null && ' · searching…'}
        {selected.length > 1 && ` · ${selected.length} selected`}
      </div>

      {confirmDelete !== null && confirmDelete.length > 0 && (
        <ConfirmDialog title="Delete notes" danger confirmLabel={`Move ${confirmDelete.length} to Recycle Bin`}
          onCancel={() => setConfirmDelete(null)} onConfirm={() => void doDelete(confirmDelete)}>
          <p className="dw-note">Move {confirmDelete.length} note(s) to the Recycle Bin?</p>
          <ul className="mg-plain-list">
            {confirmDelete.slice(0, 12).map(n => <li key={n.path}><code>{n.path}</code></li>)}
            {confirmDelete.length > 12 && <li className="mg-muted">… and {confirmDelete.length - 12} more</li>}
          </ul>
          <p className="dw-hint">These are files in your project folders, not Claude's data. Files on drives without a Recycle Bin
            (network shares) are deleted permanently.</p>
        </ConfirmDialog>
      )}
      {importFlow.element}
      {result !== null && <ResultDialog title={result.title} result={result.result} note={result.note} onClose={() => setResult(null)} />}
    </div>
  )
}
