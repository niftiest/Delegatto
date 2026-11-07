import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import type { WizardProcess } from '../../../shared/manage-types'
import { ConfirmDialog, END_ALL_WARNING, endAndWait } from './common'

/** Manage → Live sessions (port of ClaudeMemoryTool's LiveSessionsForm): the
 *  running Claude Code sessions from ~/.claude/sessions. End all closes
 *  Delegatto's own processes through its pool and ends the rest only after
 *  verifying each process's start time. */
export function LiveTab({ active }: { active: boolean }) {
  const [procs, setProcs] = useState<WizardProcess[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setBusy(true)
    try { setProcs(await api.liveSessions()); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { if (active) void check() }, [active, check])

  const endAll = async (): Promise<void> => {
    if (procs === null || procs.length === 0) return
    setConfirm(false); setBusy(true); setErrors([])
    try {
      const r = await endAndWait(procs)
      setErrors(r.errors)
      setProcs(r.left)
    } finally { setBusy(false) }
  }

  const n = procs?.length ?? 0
  return (
    <div className="mg-tab">
      <div className="mg-toolbar">
        <div className="mg-buttons">
          <button type="button" className="btn-secondary mg-btn" disabled={busy} onClick={() => void check()}>Check again</button>
          <button type="button" className="btn-danger mg-btn" disabled={busy || n === 0} onClick={() => setConfirm(true)}>End all…</button>
        </div>
      </div>
      <p className="mg-info">
        {procs === null ? 'Checking…' : n === 0
          ? 'No Claude Code sessions are running.'
          : `${n} Claude Code session(s) running. Delete of a project, Rename, project Import and Restore need every session closed.`}
      </p>
      {errors.length > 0 && <ul className="dw-errors mg-errors">{errors.map(e => <li key={e}>{e}</li>)}</ul>}
      <div className="mg-table-wrap mg-full" aria-label="Live sessions">
        <table className="mg-table">
          <thead><tr><th className="mg-c-owner">Owner</th><th>Name</th><th>Working dir</th><th className="mg-num">PID</th></tr></thead>
          <tbody>
            {(procs ?? []).map(p => (
              <tr key={p.pid}>
                <td className="mg-c-owner"><span className={`dw-owner ${p.owner}`}>{p.owner === 'app' ? 'Delegatto' : 'Terminal'}</span></td>
                <td>{p.name ?? (p.sessionId ? p.sessionId.slice(0, 8) : '')}</td>
                <td className="mg-c-dir" title={p.cwd}>{p.cwd || '(unreadable session file)'}</td>
                <td className="mg-num">{p.pid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mg-status" role="status">{error !== null ? `Could not check sessions: ${error}` : busy ? 'Working…' : `${n} running`}</div>

      {confirm && (
        <ConfirmDialog title="End all sessions" danger confirmLabel={`End ${n} session${n === 1 ? '' : 's'}`}
          onCancel={() => setConfirm(false)} onConfirm={() => void endAll()}>
          <p className="dw-note">End all {n} running Claude Code session(s)?</p>
          <p className="dw-hint">{END_ALL_WARNING} Delegatto's own chats are closed through its process pool; other processes are ended
            only after checking each one is the session Claude Code recorded (its start time must match).</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
