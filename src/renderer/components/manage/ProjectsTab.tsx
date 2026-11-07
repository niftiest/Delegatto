import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import type { DeleteTarget, DetailRow, ManageResult, MatchPlace, ProjectRow, RenamePlanView } from '../../../shared/manage-types'
import {
  formatDate, formatSize, listKeys, LiveGate, Modal, ResultDialog, SortTh, useImportFlow, useMultiSelect, type Sort
} from './common'

/** Manage → Projects (port of ClaudeMemoryTool's MainForm): every project
 *  Claude Code has data for, searchable by path (instant) and by memory /
 *  chat content (debounced, cancelled on new input), multi-select Delete /
 *  Export, Rename/Move, Import, and a detail pane of everything Claude keeps. */

type Col = 'dir' | 'exists' | 'sessions' | 'lastUsed' | 'size' | 'match'

const DESC_FIRST: ReadonlySet<Col> = new Set<Col>(['sessions', 'lastUsed', 'size'])

const KIND_LABEL: Record<string, string> = {
  ProjectFolder: 'Project folder', Memory: 'Memory', ClaudeJsonEntry: '.claude.json', GithubRepoPath: 'GitHub repo link',
  HistoryLines: 'Prompt history', TempScratch: 'Temp', FileHistory: 'File history', SessionEnv: 'Session env',
  Tasks: 'Tasks', Uploads: 'Uploads', Todos: 'Todos', Job: 'Background job', InDirClaudeFolder: 'Working .claude',
  InDirClaudeMd: 'CLAUDE.md'
}

/** Same rule as main's matchPath: the working dir or encoded folder name contains q. */
function pathMatch(p: ProjectRow, q: string): boolean {
  const l = q.toLowerCase()
  return p.workingDir.toLowerCase().includes(l) || p.encodedName.toLowerCase().includes(l)
}

/** What the Delete wizard calls this project (see DeleteTarget). */
export function deleteKey(p: ProjectRow): string {
  return p.projectDir !== null ? p.encodedName : p.workingDir
}

export function ProjectsTab({ active, epoch, onDelete, onChanged, onOpenRestorePoints }: {
  active: boolean
  /** Bumped by the app after the Delete wizard removed something: rescan. */
  epoch: number
  onDelete: (target: DeleteTarget) => void
  /** Claude data changed (rename / import): refresh the sidebar. */
  onChanged: () => void
  onOpenRestorePoints: () => void
}) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [content, setContent] = useState<Map<string, MatchPlace[]>>(new Map())
  const [contentSearching, setContentSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort<Col>>({ col: 'lastUsed', desc: true })
  const [detail, setDetail] = useState<{ for: string; rows: DetailRow[] | null; error: string | null } | null>(null)
  const [renameFor, setRenameFor] = useState<ProjectRow | null>(null)
  const [renameGate, setRenameGate] = useState<ProjectRow | null>(null)
  const [result, setResult] = useState<{ title: string; result: ManageResult; note?: string; showBackup?: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const searchId = useRef(0)
  const scanGen = useRef(0)
  const tableRef = useRef<HTMLDivElement>(null)
  const keepSelected = useRef<string[] | null>(null)

  // ---- scan
  const rescan = useCallback(async (select?: string) => {
    const gen = ++scanGen.current
    setScanning(true)
    setScanError(null)
    if (select !== undefined) keepSelected.current = [select]
    try {
      const list = await api.manageProjects()
      if (gen !== scanGen.current) return
      setProjects(list)
      setDetail(null)
    } catch (e) {
      if (gen === scanGen.current) setScanError(e instanceof Error ? e.message : String(e))
    } finally {
      if (gen === scanGen.current) setScanning(false)
    }
  }, [])

  const started = useRef(false)
  useEffect(() => {
    if (active && !started.current) { started.current = true; void rescan() }
  }, [active, rescan])
  const lastEpoch = useRef(epoch)
  useEffect(() => {
    if (epoch !== lastEpoch.current) { lastEpoch.current = epoch; void rescan() }
  }, [epoch, rescan])

  // ---- content search: debounced, a newer query cancels the older one
  useEffect(() => {
    const off = api.onSearchEvent(e => {
      if (e.id !== searchId.current) return
      if (e.type === 'match') setContent(prev => new Map(prev).set(e.workingDir, e.places))
      else if (e.type === 'done') setContentSearching(false)
      else { setContentSearching(false); setSearchError(e.error) }
    })
    return () => { off(); void api.searchCancel(searchId.current) }
  }, [])

  const q = query.trim()
  useEffect(() => {
    void api.searchCancel(searchId.current)
    const id = ++searchId.current
    setContent(new Map())
    setSearchError(null)
    setContentSearching(false)
    if (q === '' || projects === null) return
    const t = setTimeout(() => {
      setContentSearching(true)
      void api.searchStart(id, q)
    }, 300)
    return () => clearTimeout(t)
  }, [q, projects])

  // ---- filter + sort
  const rows = useMemo(() => {
    if (projects === null) return []
    const out: Array<{ p: ProjectRow; places: MatchPlace[] }> = []
    for (const p of projects) {
      const places: MatchPlace[] = []
      if (q !== '') {
        if (pathMatch(p, q)) places.push('path')
        for (const pl of content.get(p.workingDir) ?? []) if (!places.includes(pl)) places.push(pl)
        if (places.length === 0) continue
      }
      out.push({ p, places })
    }
    const dir = sort.desc ? -1 : 1
    const cmp = (a: typeof out[number], b: typeof out[number]): number => {
      switch (sort.col) {
        case 'exists': return Number(a.p.exists) - Number(b.p.exists)
        case 'sessions': return a.p.sessions - b.p.sessions
        case 'lastUsed': return (a.p.lastUsed ?? -Infinity) - (b.p.lastUsed ?? -Infinity)
        case 'size': return a.p.sizeBytes - b.p.sizeBytes
        case 'match': return a.places.join(',').localeCompare(b.places.join(','))
        default: return a.p.workingDir.localeCompare(b.p.workingDir, undefined, { sensitivity: 'base' })
      }
    }
    return out.sort((a, b) => cmp(a, b) * dir || a.p.workingDir.localeCompare(b.p.workingDir))
  }, [projects, q, content, sort])

  const order = useMemo(() => rows.map(r => r.p.workingDir), [rows])
  const sel = useMultiSelect(order)
  const selectedRows = useMemo(() => rows.filter(r => sel.selected.has(r.p.workingDir)).map(r => r.p), [rows, sel.selected])
  const single = selectedRows.length === 1 ? selectedRows[0]! : null

  // Re-select after a rescan (rename selects the new path).
  useEffect(() => {
    if (keepSelected.current === null || projects === null) return
    const want = keepSelected.current.map(k => k.toLowerCase())
    const hit = order.filter(k => want.includes(k.toLowerCase()))
    if (hit.length > 0) { sel.set(hit); keepSelected.current = null }
  }, [order, projects, sel])

  // ---- detail pane for exactly one project
  useEffect(() => {
    if (single === null) { setDetail(null); return }
    let cancelled = false
    setDetail({ for: single.workingDir, rows: null, error: null })
    api.projectDetail(single.workingDir)
      .then(r => { if (!cancelled) setDetail({ for: single.workingDir, rows: r, error: null }) })
      .catch(e => { if (!cancelled) setDetail({ for: single.workingDir, rows: [], error: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [single])

  const total = rows.reduce((s, r) => s + r.p.sizeBytes, 0)

  // ---- actions
  const doDelete = useCallback(() => {
    if (selectedRows.length === 0) return
    onDelete({ scope: 'projects', dirNames: selectedRows.map(deleteKey) })
  }, [selectedRows, onDelete])

  const doExport = useCallback(async () => {
    if (selectedRows.length === 0) return
    setBusy('Exporting…')
    try {
      const r = await api.exportProjects(selectedRows.map(p => p.workingDir))
      if (r.kind !== 'cancelled') {
        setResult({ title: r.kind === 'done' ? 'Export finished' : 'Export', result: r,
          note: 'The zip holds the chats, memory, settings entry, prompt history and session files. Import it to restore them.' })
      }
    } finally { setBusy(null) }
  }, [selectedRows])

  const afterImport = useCallback(() => { onChanged(); void rescan() }, [onChanged, rescan])
  const importFlow = useImportFlow(afterImport)

  const openItem = (d: DetailRow): void => {
    setOpenError(null)
    if (d.editable) void api.openInEditor(d.path).then(err => setOpenError(err))
    else void api.showInFolder(d.path)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => listKeys(e, sel, doDelete)

  return (
    <div className="mg-tab">
      <div className="mg-toolbar">
        <div className="mg-buttons">
          <button type="button" className="btn-danger mg-btn" disabled={selectedRows.length === 0} onClick={doDelete}>Delete…</button>
          <button type="button" className="btn-secondary mg-btn" disabled={single === null || !single.workingDirKnown}
            title={single !== null && !single.workingDirKnown ? "The real path of this project is unknown" : undefined}
            onClick={() => single !== null && setRenameGate(single)}>Rename/Move…</button>
          <button type="button" className="btn-secondary mg-btn" disabled={selectedRows.length === 0} onClick={() => void doExport()}>Export…</button>
          <button type="button" className="btn-secondary mg-btn" onClick={() => importFlow.start()}>Import…</button>
          <button type="button" className="btn-secondary mg-btn" onClick={onOpenRestorePoints}>Restore points…</button>
          <button type="button" className="btn-secondary mg-btn" disabled={scanning} onClick={() => void rescan()}>Refresh</button>
        </div>
        <input className="field-input mg-search" type="search" placeholder="Search projects, chats, memory…"
          aria-label="Search projects, chats and memory" value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      <div className="mg-split">
        <div className="mg-table-wrap" ref={tableRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Projects">
          <table className="mg-table" aria-multiselectable="true">
            <thead>
              <tr>
                <SortTh col="dir" sort={sort} onSort={setSort}>Working dir</SortTh>
                <SortTh col="exists" sort={sort} onSort={setSort} className="mg-c-exists">Exists</SortTh>
                <SortTh col="sessions" sort={sort} onSort={setSort} className="mg-num" descFirst={DESC_FIRST.has('sessions')}>Sessions</SortTh>
                <SortTh col="lastUsed" sort={sort} onSort={setSort} className="mg-c-date" descFirst>Last used</SortTh>
                <SortTh col="size" sort={sort} onSort={setSort} className="mg-num" descFirst>Size</SortTh>
                {q !== '' && <SortTh col="match" sort={sort} onSort={setSort} className="mg-c-match">Matched in</SortTh>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, places }) => {
                const isSel = sel.selected.has(p.workingDir)
                return (
                  <tr key={p.workingDir} aria-selected={isSel} className={`${isSel ? 'sel' : ''}${p.exists ? '' : ' gone'}`}
                    onMouseDown={e => { if (e.shiftKey) e.preventDefault() }}
                    onClick={e => { sel.onRowClick(e, p.workingDir); tableRef.current?.focus() }}>
                    <td className="mg-c-dir" title={p.workingDir}>
                      {!p.workingDirKnown && <span className="mg-unknown" title="Real path unknown (only the encoded folder name)">?</span>}
                      {p.workingDir}
                      {p.worktreeOf !== null && <span className="mg-tag" title={`git worktree of ${p.worktreeOf}`}>worktree of {p.worktreeOf}</span>}
                    </td>
                    <td className="mg-c-exists">{p.exists ? 'yes' : 'no'}</td>
                    <td className="mg-num">{p.sessions}</td>
                    <td className="mg-c-date">{formatDate(p.lastUsed)}</td>
                    <td className="mg-num">{formatSize(p.sizeBytes)}</td>
                    {q !== '' && <td className="mg-c-match">{places.map(pl => <span key={pl} className={`mg-place ${pl}`}>{pl}</span>)}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {projects !== null && rows.length === 0 && (
            <div className="mg-empty">{q === '' ? 'No projects found.' : contentSearching ? 'Searching…' : 'No project matches.'}</div>
          )}
          {projects === null && <div className="mg-empty">{scanError ?? 'Scanning…'}</div>}
        </div>

        <div className="mg-detail" aria-label="Project details">
          {single === null ? (
            <div className="mg-empty">{selectedRows.length > 1 ? `${selectedRows.length} projects selected.` : 'Select a project to see everything Claude keeps for it.'}</div>
          ) : (
            <>
              <div className="mg-detail-head">
                <span className="mg-detail-title" title={single.workingDir}>{single.workingDir}</span>
                {openError !== null && <span className="dw-warn-inline">{openError}</span>}
              </div>
              {detail?.error != null && <p className="dw-error">Could not list files: {detail.error}</p>}
              {detail?.rows == null ? <div className="mg-empty">Collecting…</div> : (
                <table className="mg-table mg-detail-table">
                  <thead><tr><th>Kind</th><th>Path</th><th>Details</th><th className="mg-num">Size</th><th /></tr></thead>
                  <tbody>
                    {detail.rows.map((d, i) => (
                      <tr key={i} className={d.child ? 'child' : ''} onDoubleClick={() => openItem(d)}>
                        <td className="mg-c-kind">{d.child ? '↳ ' : ''}{KIND_LABEL[d.kind] ?? d.kind}</td>
                        <td className="mg-c-path" title={d.path}>{d.path}</td>
                        <td className="mg-c-desc">{d.description}{d.optional ? ' (optional)' : ''}</td>
                        <td className="mg-num">{d.sharedEdit ? '' : formatSize(d.sizeBytes)}</td>
                        <td className="mg-c-act">
                          <button type="button" className="btn-link" onClick={() => openItem(d)}>{d.editable ? 'Open' : 'Show in folder'}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mg-status" role="status">
        {projects === null ? (scanError !== null ? `Scan failed: ${scanError}` : 'Scanning…') : (
          <>
            {rows.length} project{rows.length === 1 ? '' : 's'} · {formatSize(total)}
            {selectedRows.length > 1 && ` · ${selectedRows.length} selected`}
            {scanning && ' · rescanning…'}
            {contentSearching && ' · searching chats and memory…'}
            {searchError !== null && ` · search failed: ${searchError}`}
            {busy !== null && ` · ${busy}`}
          </>
        )}
      </div>

      {renameGate !== null && (
        <LiveGate what="Rename" onCancel={() => setRenameGate(null)}
          onContinue={() => { setRenameFor(renameGate); setRenameGate(null) }} />
      )}
      {renameFor !== null && (
        <RenameDialog project={renameFor} onClose={() => setRenameFor(null)}
          onFinished={(r, newDir) => {
            setRenameFor(null)
            setResult({
              title: 'Rename finished', result: r, showBackup: true,
              note: r.kind === 'done' && r.failures.length > 0
                ? 'The rename stopped at the first failure. Fix the problem (for example, close programs using the folder), then run Rename again with the same paths to finish.'
                : undefined
            })
            onChanged()
            void rescan(r.kind === 'done' && r.failures.length === 0 ? newDir : undefined)
          }} />
      )}
      {importFlow.element}
      {result !== null && <ResultDialog title={result.title} result={result.result} note={result.note}
        showBackup={result.showBackup} onClose={() => setResult(null)} />}
    </div>
  )
}

/** Collects the new path and previews the plan (the C# RenameForm). Nothing
 *  changes until Rename, which re-plans and only runs the plan the user saw. */
function RenameDialog({ project, onClose, onFinished }: {
  project: ProjectRow
  onClose: () => void
  onFinished: (r: ManageResult, newDir: string) => void
}) {
  const [newDir, setNewDir] = useState(project.workingDir)
  const [plan, setPlan] = useState<{ for: string; view: RenamePlanView } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The box starts with the old path: select its last segment so typing replaces just the name.
  useEffect(() => {
    const el = input.current
    if (el === null) return
    el.focus()
    const t = el.value.replace(/[\\/]+$/, '')
    const start = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1
    el.setSelectionRange(start, el.value.length)
  }, [])

  const previewed = plan !== null && plan.for === newDir

  async function preview(): Promise<void> {
    const text = newDir
    setBusy(true); setError(null); setBanner(null)
    try {
      const r = await api.renamePlan(project.workingDir, text)
      if (r.ok) setPlan({ for: text, view: r.plan })
      else { setPlan(null); setError(r.error) }
    } finally { setBusy(false) }
  }

  async function rename(): Promise<void> {
    if (!previewed || plan === null) return
    setBusy(true); setError(null)
    try {
      const r = await api.renameExecute(project.workingDir, newDir, plan.view.signature)
      if (r.kind === 'changed') {
        setPlan({ for: newDir, view: r.plan })
        setBanner('The plan changed since Preview. Review it and click Rename again.')
        return
      }
      if (r.kind === 'error') { setError(r.error); return }
      onFinished(r, plan.view.newDir)
    } finally { setBusy(false) }
  }

  async function browse(): Promise<void> {
    const dir = await api.pickDirectory()
    if (dir === null) return
    const name = project.workingDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    setNewDir(dir.replace(/[\\/]+$/, '') + '\\' + name)
  }

  return (
    <Modal title="Rename / move project" wide onClose={onClose} busy={busy}>
      <label className="field">
        <span className="field-label">Old path</span>
        <input className="field-input" value={project.workingDir} readOnly />
      </label>
      <label className="field">
        <span className="field-label">New path</span>
        <span className="field-row">
          <input ref={input} className="field-input" value={newDir} spellCheck={false}
            onChange={e => { setNewDir(e.target.value); setBanner(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && !previewed) { e.preventDefault(); void preview() } }} />
          <button type="button" className="btn-secondary" onClick={() => void browse()}>Browse…</button>
        </span>
      </label>
      <p className="dw-hint">Moves the working folder (if it exists) and repoints every Claude Code reference at or under the old
        path, in every project. .claude.json and history.jsonl are backed up first. Refused while any Claude Code session runs.</p>
      <div className={`mg-preview-box${error !== null ? ' bad' : plan?.view.warning != null || banner !== null ? ' warn' : ''}`}>
        {error !== null ? <>Cannot rename: {error}<br /><br />Nothing has been changed.</>
          : !previewed ? 'Enter the new path, then click Preview to see what will change.'
          : (
            <>
              {banner !== null && <p className="dw-warn">{banner}</p>}
              <div className="mg-preview-head">{plan!.view.lines[0]}</div>
              <ul>{plan!.view.lines.slice(1).map(l => <li key={l}>{l}</li>)}</ul>
              {plan!.view.warning !== null && <p className="dw-warn">Warning: {plan!.view.warning}</p>}
            </>
          )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn-secondary" onClick={() => void preview()} disabled={busy}>Preview</button>
        <button type="button" className="btn-danger" onClick={() => void rename()} disabled={busy || !previewed}>
          {busy ? 'Working…' : 'Rename'}
        </button>
      </div>
    </Modal>
  )
}
