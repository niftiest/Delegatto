import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { formatClock } from '../lib'
import type { RewindCheck, RewindMode, RewindPoint } from '../../shared/engine-ipc-contract'

/** Going back to an earlier message, as Esc Esc and /rewind do in the terminal. Pick the
 *  message, then what to restore. It takes effect only on the last click. */
export function RewindDialog({ sessionPk, onClose, onDone }: {
  sessionPk: number
  onClose: () => void
  onDone: (result: { mode: RewindMode; uuid: string; prefill: string | null }) => void
}) {
  const [points, setPoints] = useState<RewindPoint[] | null>(null)
  const [picked, setPicked] = useState<RewindPoint | null>(null)
  const [check, setCheck] = useState<RewindCheck | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void api.rewindPoints(sessionPk).then(setPoints).catch(() => setPoints([])) }, [sessionPk])
  useEffect(() => {
    if (picked === null) return
    let alive = true
    setCheck(null)
    void api.rewindCheck(sessionPk, picked.uuid).then(c => { if (alive) setCheck(c) })
    return () => { alive = false }
  }, [picked, sessionPk])
  useEffect(() => {
    // Ahead of everything else: behind this dialog, Esc would act on the message box.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (working) return
      if (picked !== null) { setPicked(null); setError(null) } else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [picked, working, onClose])

  const go = (mode: RewindMode): void => {
    if (picked === null) return
    setWorking(true)
    setError(null)
    void api.rewindTo(sessionPk, picked.uuid, mode).then(r => {
      setWorking(false)
      if (r.ok) onDone({ mode, uuid: picked.uuid, prefill: r.prefill })
      else setError(r.error)
    })
  }

  const changed = check !== null && check.canRewind && check.files.length > 0
  return createPortal(
    <div className="modal-overlay app-dialog-overlay" role="presentation">
      <div className="modal rewind-dialog" role="dialog" aria-modal="true" aria-label="Rewind">
        <h2 className="modal-title">Rewind</h2>
        {picked === null && (
          <>
            <p className="app-dialog-detail">Go back to before one of your messages.</p>
            {points === null && <p className="app-dialog-detail">Loading…</p>}
            {points !== null && points.length === 0 && <p className="app-dialog-detail">There's nothing to go back to in this chat yet.</p>}
            {points !== null && points.length > 0 && (
              <div className="rewind-points">
                {points.map(p => (
                  <button type="button" key={p.uuid} className="rewind-point" title={p.text} onClick={() => setPicked(p)}>
                    <span className="rewind-point-text">{p.text}</span>
                    <time className="rewind-point-time">{formatClock(p.ts)}</time>
                  </button>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
        {picked !== null && (
          <>
            <p className="app-dialog-detail">Back to before:</p>
            <blockquote className="rewind-quote">{picked.text}</blockquote>
            {check === null && <p className="app-dialog-detail">Checking what changed since then…</p>}
            {check !== null && !check.canRewind && <p className="app-dialog-detail">Files can't be restored from here: {(check.error ?? 'nothing was recorded for this message').replace(/\.+$/, '')}. The conversation still can be.</p>}
            {check !== null && check.canRewind && check.files.length === 0 && <p className="app-dialog-detail">No files have changed since then.</p>}
            {changed && (
              <>
                <p className="app-dialog-detail">{check.files.length === 1 ? '1 file' : `${check.files.length} files`} changed since then (+{check.insertions} −{check.deletions}):</p>
                <ul className="rewind-files">
                  {check.files.slice(0, 8).map(f => <li key={f} title={f}>{f}</li>)}
                  {check.files.length > 8 && <li>and {check.files.length - 8} more</li>}
                </ul>
              </>
            )}
            {error !== null && <p className="term-prompt-error">{error}</p>}
            <div className="modal-actions rewind-actions">
              <button type="button" className="btn-secondary" disabled={working} onClick={() => { setPicked(null); setError(null) }}>Back</button>
              <button type="button" className="btn-secondary" disabled={working || check === null} onClick={() => go('conversation')}>Conversation only</button>
              {changed && <button type="button" className="btn-secondary" disabled={working} onClick={() => go('code')}>Code only</button>}
              {changed && <button type="button" className="btn-primary" disabled={working} onClick={() => go('both')}>Code and conversation</button>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
