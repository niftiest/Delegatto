import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import type { ManageResult, RestorePointRow } from '../../../shared/manage-types'
import { ConfirmDialog, formatDate, formatSize, listKeys, ResultDialog, useImportFlow, useMultiSelect } from './common'

/** Manage → Restore points (port of ClaudeMemoryTool's RestorePointsForm):
 *  the zips Delete made, newest first. Restore… imports one (every session
 *  must be closed); Delete moves them to the Recycle Bin. */
export function RestoreTab({ active, epoch, onChanged }: { active: boolean; epoch: number; onChanged: () => void }) {
  const [points, setPoints] = useState<RestorePointRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<RestorePointRow[] | null>(null)
  const [result, setResult] = useState<ManageResult | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async () => {
    try { setPoints(await api.listRestorePoints()); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { if (active) void reload() }, [active, epoch, reload])

  const order = useMemo(() => (points ?? []).map(p => p.path), [points])
  const sel = useMultiSelect(order)
  const selected = (points ?? []).filter(p => sel.selected.has(p.path))
  const restorable = selected.length === 1 && selected[0]!.error === null ? selected[0]! : null

  const afterRestore = useCallback(() => { onChanged(); void reload() }, [onChanged, reload])
  const flow = useImportFlow(afterRestore, true)

  const doDelete = async (list: RestorePointRow[]): Promise<void> => {
    setConfirm(null)
    const r = await api.deleteRestorePoints(list.map(p => p.path))
    await reload()
    if (r.kind !== 'done' || r.failures.length > 0) setResult(r)
  }

  return (
    <div className="mg-tab">
      <div className="mg-toolbar">
        <div className="mg-buttons">
          <button type="button" className="btn-primary mg-btn" disabled={restorable === null} onClick={() => restorable && flow.start(restorable.path)}>Restore…</button>
          <button type="button" className="btn-danger mg-btn" disabled={selected.length === 0} onClick={() => setConfirm(selected)}>Delete</button>
          <button type="button" className="btn-secondary mg-btn" onClick={() => void api.openRestorePointsFolder()}>Open folder</button>
          <button type="button" className="btn-secondary mg-btn" onClick={() => void reload()}>Refresh</button>
        </div>
      </div>
      <p className="mg-info">
        {points !== null && points.length === 0
          ? 'No restore points yet. Delete makes one when “Create a restore point first” is ticked.'
          : 'Each restore point holds the Claude data of the projects it lists, saved just before they were deleted. ' +
            'Restore puts it back (nothing that already exists is overwritten; every Claude Code session must be closed). ' +
            'Delete moves restore points to the Recycle Bin; they are never removed automatically.'}
      </p>
      <div className="mg-table-wrap mg-full" ref={listRef} tabIndex={0} aria-label="Restore points"
        onKeyDown={e => listKeys(e, sel, () => setConfirm(selected))}>
        <table className="mg-table" aria-multiselectable="true">
          <thead><tr><th className="mg-c-date">Created</th><th>Projects</th><th className="mg-num">Size</th></tr></thead>
          <tbody>
            {(points ?? []).map(p => {
              const isSel = sel.selected.has(p.path)
              return (
                <tr key={p.path} aria-selected={isSel} className={`${isSel ? 'sel' : ''}${p.error !== null ? ' gone' : ''}`} title={p.path}
                  onMouseDown={e => { if (e.shiftKey) e.preventDefault() }}
                  onClick={e => { sel.onRowClick(e, p.path); listRef.current?.focus() }}
                  onDoubleClick={() => { if (p.error === null) flow.start(p.path) }}>
                  <td className="mg-c-date">{formatDate(p.created, true)}</td>
                  <td className="mg-c-dir">{p.error === null ? p.projects.join('; ') : `${p.path.split('\\').pop()} (can't be read: ${p.error})`}</td>
                  <td className="mg-num">{formatSize(p.sizeBytes)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {points === null && <div className="mg-empty">{error ?? 'Loading…'}</div>}
      </div>
      <div className="mg-status" role="status">
        {error !== null ? `Could not list restore points: ${error}` : points === null ? '' : `${points.length} restore point${points.length === 1 ? '' : 's'}`}
      </div>

      {confirm !== null && confirm.length > 0 && (
        <ConfirmDialog title="Delete restore points" danger confirmLabel="Move to Recycle Bin"
          onCancel={() => setConfirm(null)} onConfirm={() => void doDelete(confirm)}>
          <p className="dw-note">{confirm.length === 1
            ? `Move the restore point from ${formatDate(confirm[0]!.created)} to the Recycle Bin?`
            : `Move ${confirm.length} restore points to the Recycle Bin?`}</p>
        </ConfirmDialog>
      )}
      {flow.element}
      {result !== null && <ResultDialog title="Delete restore points" result={result} onClose={() => setResult(null)} />}
    </div>
  )
}
