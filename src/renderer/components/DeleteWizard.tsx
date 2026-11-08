import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { DeleteOutcome, DeletePlan, DeleteTarget, WizardProcess } from '../../shared/manage-types'

/** Step-by-step delete for one chat or a whole project (port of
 *  ClaudeMemoryTool's Delete flow): 1) close anything holding it open,
 *  2) optional restore point, 3) review exactly what goes, 4) delete + report.
 *  Only Claude's data is removed -- never the working folder itself. */

type Step = 'running' | 'backup' | 'review' | 'deleting' | 'done'
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'running', label: 'Running sessions' },
  { id: 'backup', label: 'Backup' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Delete' }
]

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    SessionTranscript: 'Chat', SessionFolder: 'Subagents', ProjectFolder: 'Project folder', Memory: 'Memory',
    ClaudeJsonEntry: '.claude.json', GithubRepoPath: '.claude.json', HistoryLines: 'Prompt history',
    TempScratch: 'Temp', FileHistory: 'File history', SessionEnv: 'Session env', Tasks: 'Tasks',
    Uploads: 'Uploads', Todos: 'Todos', Job: 'Job', InDirClaudeFolder: 'Working folder', InDirClaudeMd: 'Working folder'
  }
  return map[kind] ?? kind
}

export function DeleteWizard({ target, onClose, onDeleted }: {
  target: DeleteTarget
  onClose: () => void
  /** Called once after a delete that removed anything (refresh the nav). */
  onDeleted: () => void
}) {
  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('running')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [restorePoint, setRestorePoint] = useState(true)
  const [blocking, setBlocking] = useState<WizardProcess[]>([])
  const [ending, setEnding] = useState(false)
  const [endErrors, setEndErrors] = useState<string[]>([])
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [outcome, setOutcome] = useState<DeleteOutcome | null>(null)

  // Which processes must be closed: the project's/chat's own, or -- when the
  // delete edits .claude.json / history.jsonl -- every running session.
  const needsAllClosed = (p: DeletePlan, sel: Set<string>): boolean =>
    p.listOnly === undefined && (p.target.scope !== 'chat' || p.items.some(i => i.sharedEdit && sel.has(i.key)))
  const relevant = (p: DeletePlan, sel: Set<string>, check: { blocking: WizardProcess[]; allLive: WizardProcess[] }): WizardProcess[] =>
    needsAllClosed(p, sel) ? check.allLive : check.blocking

  useEffect(() => {
    let cancelled = false
    api.planDelete(target).then(p => {
      if (cancelled) return
      // A chat's prompt-history lines start unticked: editing history.jsonl would
      // require closing EVERY Claude session, too much for one chat by default.
      const sel = new Set(p.items
        .filter(i => i.defaultSelected && i.containedIn === null && !(p.target.scope === 'chat' && i.kind === 'HistoryLines'))
        .map(i => i.key))
      setPlan(p)
      setSelected(sel)
      const procs = relevant(p, sel, p)
      setBlocking(procs)
      setStep(procs.length > 0 ? 'running' : 'backup')
    }).catch(err => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && step !== 'deleting') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  async function recheck(): Promise<WizardProcess[]> {
    if (plan === null) return []
    const c = await api.checkSessions(plan.target)
    const procs = relevant(plan, selected, c)
    setBlocking(procs)
    return procs
  }

  async function endProcesses(): Promise<void> {
    setEnding(true); setEndErrors([]); setConfirmEnd(false)
    try {
      const r = await api.endSessions(blocking.map(p => p.pid))
      setEndErrors(r.failures.map(f => `PID ${f.pid}: ${f.error}`))
      // Give exiting processes a moment to remove their lock files.
      for (let i = 0; i < 10; i++) {
        const left = await recheck()
        if (left.length === 0) break
        await new Promise(res => setTimeout(res, 500))
      }
    } finally {
      setEnding(false)
    }
  }

  const totals = useMemo(() => {
    if (plan === null) return { count: 0, bytes: 0, permanent: 0 }
    const sel = plan.items.filter(i => selected.has(i.key))
    return {
      count: sel.length,
      bytes: sel.reduce((s, i) => s + i.sizeBytes, 0),
      permanent: sel.filter(i => i.permanent).length
    }
  }, [plan, selected])

  async function runDelete(): Promise<void> {
    if (plan === null) return
    // Shared-file edits need every session closed; re-check right before.
    const procs = await recheck()
    if (procs.length > 0) { setStep('running'); return }
    setStep('deleting')
    const r = await api.executeDelete(plan.target, [...selected], restorePoint)
    if (!r.ok && r.sessions !== undefined && r.sessions.length > 0) {
      setBlocking(r.sessions)
      setStep('running')
      return
    }
    setOutcome(r)
    setStep('done')
    if (r.ok && r.done.length > 0) onDeleted()
  }

  const toggle = (key: string): void =>
    setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  const stepIndex = step === 'deleting' ? 3 : STEPS.findIndex(s => s.id === step)

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && step !== 'deleting') onClose() }}>
      <div className="modal dw" role="dialog" aria-modal="true" aria-label={plan?.title ?? 'Delete'}>
        <h2 className="modal-title dw-title">{plan?.title ?? (loadError !== null ? 'Delete' : 'Preparing…')}</h2>
        {plan !== null && <div className="dw-sub">{plan.workingDir}</div>}

        {plan?.listOnly === undefined && <ol className="dw-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''}>
              <span className="dw-step-num">{i < stepIndex ? '✓' : i + 1}</span>{s.label}
            </li>
          ))}
        </ol>}

        {loadError !== null && (
          <>
            <p className="dw-error">{loadError}</p>
            <div className="modal-actions"><button type="button" className="btn-secondary" onClick={onClose}>Close</button></div>
          </>
        )}

        {plan === null && loadError === null && <p className="dw-note">Collecting everything Claude keeps for this…</p>}

        {plan !== null && step === 'running' && (
          <section className="dw-body">
            {blocking.length === 0 ? (
              <p className="dw-ok">Nothing is running for this. ✓</p>
            ) : (
              <>
                <p className="dw-note">
                  {needsAllClosed(plan, selected)
                    ? 'This delete edits Claude Code’s shared files (.claude.json / prompt history), so every running Claude Code session must be closed first.'
                    : 'These Claude Code processes have this chat open. Close them first.'}
                </p>
                <ul className="dw-procs">
                  {blocking.map(p => (
                    <li key={p.pid}>
                      <span className={`dw-owner ${p.owner}`}>{p.owner === 'app' ? 'Delegatto' : 'Terminal'}</span>
                      <span className="dw-proc-name">{p.name ?? p.sessionId.slice(0, 8)}</span>
                      <span className="dw-proc-meta">PID {p.pid} · {p.cwd}</span>
                    </li>
                  ))}
                </ul>
                {endErrors.length > 0 && <ul className="dw-errors">{endErrors.map(e => <li key={e}>{e}</li>)}</ul>}
                {confirmEnd ? (
                  <div className="dw-confirm">
                    End {blocking.length} process{blocking.length === 1 ? '' : 'es'}? Any reply in progress is lost; saved chats are kept and can be resumed.
                    <div className="modal-actions">
                      <button type="button" className="btn-secondary" onClick={() => setConfirmEnd(false)}>Cancel</button>
                      <button type="button" className="btn-danger" onClick={() => void endProcesses()}>End them</button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
            {!confirmEnd && (
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
                {blocking.length > 0 && <>
                  <button type="button" className="btn-secondary" disabled={ending} onClick={() => void recheck()}>Check again</button>
                  <button type="button" className="btn-danger" disabled={ending} onClick={() => setConfirmEnd(true)}>
                    {ending ? 'Ending…' : blocking.length === 1 ? 'End it…' : 'End all…'}
                  </button>
                </>}
                <button type="button" className="btn-primary" disabled={blocking.length > 0} onClick={() => setStep('backup')}>Next</button>
              </div>
            )}
          </section>
        )}

        {plan?.listOnly !== undefined && (step === 'backup' || step === 'review') && (
          <section className="dw-body">
            <p className="dw-note">
              Claude’s own files for this are already gone, so there’s nothing left on disk to delete.
              {' '}Delegatto still has a saved copy of {plan.listOnly.chats === 1 ? 'its chat' : `its ${plan.listOnly.chats} chats`}, which is why it’s still in the list.
            </p>
            <p className="dw-note">Deleting removes that copy and takes it off the list. This can’t be undone.</p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-danger" onClick={() => void runDelete()}>Delete</button>
            </div>
          </section>
        )}

        {plan !== null && plan.listOnly === undefined && step === 'backup' && (
          <section className="dw-body">
            <label className="dw-check">
              <input type="checkbox" checked={restorePoint} onChange={e => setRestorePoint(e.target.checked)} />
              <span>
                <b>Create a restore point first</b> (recommended)
                <span className="dw-hint">
                  Saves {plan.target.scope === 'projects' && new Set(plan.items.map(i => i.group)).size > 1 ? 'these projects’' : 'this project’s'} Claude data ({formatBytes(plan.restorePointBytes)}) to one zip in
                  {' '}<code>~\.claude\backups\memory-tool\restore-points</code> before anything is removed.
                  If it can’t be saved, nothing is deleted. It can be restored later, and it’s compatible with Claude Memory Tool.
                </span>
              </span>
            </label>
            {!restorePoint && (
              <p className="dw-warn">Without a restore point, folders still go to the Recycle Bin, but removed .claude.json entries and prompt-history lines are gone for good.</p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setStep('running')}>Back</button>
              <button type="button" className="btn-primary" onClick={() => setStep('review')}>Next</button>
            </div>
          </section>
        )}

        {plan !== null && plan.listOnly === undefined && step === 'review' && (
          <section className="dw-body">
            <p className="dw-note">Everything Claude keeps for this. Your working folder itself is never deleted.</p>
            {plan.warnings.map(w => <p key={w} className="dw-warn">{w}</p>)}
            <ul className="dw-items">
              {plan.items.map((i, idx) => {
                const inside = i.containedIn !== null
                const groupHead = i.group !== null && (idx === 0 || plan.items[idx - 1]!.group !== i.group)
                return (
                  <Fragment key={i.key}>
                  {groupHead && <li className="dw-group">{i.group}</li>}
                  <li className={inside ? 'inside' : ''}>
                    <label>
                      <input type="checkbox" disabled={inside}
                        checked={inside ? selected.has(plan.items.find(x => x.path === i.containedIn && x.group === i.group)?.key ?? '') : selected.has(i.key)}
                        onChange={() => toggle(i.key)} />
                      <span className="dw-kind">{kindLabel(i.kind)}</span>
                      <span className="dw-desc" title={i.path}>{i.description}</span>
                      {i.permanent && <span className="dw-badge perm" title="This drive has no Recycle Bin">deleted permanently</span>}
                      {i.optional && <span className="dw-badge opt" title="Inside your working folder; off by default">optional</span>}
                      {i.sharedEdit && <span className="dw-badge edit">edit</span>}
                      <span className="dw-size">{i.sharedEdit ? '' : formatBytes(i.sizeBytes)}</span>
                    </label>
                  </li>
                  </Fragment>
                )
              })}
            </ul>
            <div className="dw-total">
              {totals.count} item{totals.count === 1 ? '' : 's'} · {formatBytes(totals.bytes)}
              {totals.permanent > 0 && <> · <span className="dw-warn-inline">{totals.permanent} permanent</span></>}
              {' '}· goes to the Recycle Bin{restorePoint ? ' after a restore point' : ''}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setStep('backup')}>Back</button>
              <button type="button" className="btn-danger" disabled={totals.count === 0} onClick={() => void runDelete()}>
                Delete {totals.count} item{totals.count === 1 ? '' : 's'}
              </button>
            </div>
          </section>
        )}

        {step === 'deleting' && (
          <section className="dw-body">
            <p className="dw-note">{restorePoint && plan?.listOnly === undefined ? 'Saving the restore point, then deleting…' : 'Deleting…'}</p>
            <div className="dw-progress"><i /></div>
          </section>
        )}

        {step === 'done' && outcome !== null && (
          <section className="dw-body">
            {outcome.ok ? (
              <>
                <p className={outcome.failures.length === 0 ? 'dw-ok' : 'dw-warn'}>
                  {plan?.listOnly !== undefined ? 'Done. It’s off the list.' : outcome.failures.length === 0
                    ? `Done. ${outcome.done.length} item${outcome.done.length === 1 ? '' : 's'} removed.`
                    : `${outcome.done.length} removed, ${outcome.failures.length} could not be.`}
                </p>
                {outcome.failures.length > 0 && (
                  <ul className="dw-errors">{outcome.failures.map(f => <li key={f.path + f.error}><code>{f.path}</code>: {f.error}</li>)}</ul>
                )}
                {outcome.restorePoint !== null && (
                  <p className="dw-path">Restore point: <code>{outcome.restorePoint}</code>{' '}
                    <button type="button" className="btn-link" onClick={() => void api.showInFolder(outcome.restorePoint!)}>Show in folder</button></p>
                )}
                {outcome.backupDir !== null && (
                  <p className="dw-path">Backup of .claude.json / history: <code>{outcome.backupDir}</code>{' '}
                    <button type="button" className="btn-link" onClick={() => void api.showInFolder(outcome.backupDir!)}>Show in folder</button></p>
                )}
              </>
            ) : (
              <p className="dw-error">{outcome.error}</p>
            )}
            <div className="modal-actions"><button type="button" className="btn-primary" onClick={onClose}>Close</button></div>
          </section>
        )}
      </div>
    </div>
  )
}
