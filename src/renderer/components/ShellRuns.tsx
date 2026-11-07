import { api } from '../api'
import type { ShellRun } from '../../shared/shell-run-types'

/** `!` commands above the composer, until Claude has their output and they become part
 *  of the transcript. A finished one goes to Claude by itself; one that was stopped, or
 *  can't go yet, waits for the next message. */
export function ShellRuns({ runs }: { runs: ShellRun[] }) {
  if (runs.length === 0) return null
  const waiting = runs.some(run => run.state !== 'running')
  return (
    <div className="shell-runs" aria-label="Shell commands">
      {runs.map(run => (
        <div key={run.id} className={`shell-run shell-run-${run.state}`}>
          <div className="shell-run-head">
            <code className="shell-run-cmd">!{run.command}</code>
            <span className="shell-run-status">{status(run)}</span>
            <span className="shell-run-actions">
              {run.state === 'running'
                ? <button type="button" className="btn-secondary" onClick={() => void api.shellStop(run.id)}>Stop</button>
                : <button type="button" className="btn-secondary" title="Don’t send this to Claude" onClick={() => void api.shellDismiss(run.id)}>Leave out</button>}
            </span>
          </div>
          {run.output !== '' && <pre className="shell-run-output">{run.output.trimEnd()}</pre>}
        </div>
      ))}
      {waiting && <div className="composer-hint">Claude sees this with your next message.</div>}
    </div>
  )
}

function status(run: ShellRun): string {
  if (run.state === 'running') return 'Running…'
  if (run.state === 'stopped') return 'Stopped'
  return run.exitCode === null || run.exitCode === 0 ? 'Done' : `Exit code ${run.exitCode}`
}
