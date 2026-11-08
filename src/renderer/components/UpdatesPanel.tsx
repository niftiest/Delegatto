import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { describeRestartWait, nothingToInterrupt, type RestartWork, type UpdateStatus } from '../../shared/update-types'

/** Plain-language line for an update status. */
export function describeUpdate(s: UpdateStatus, autoInstall = false): string {
  switch (s.state) {
    case 'idle': return 'Not checked yet.'
    case 'checking': return 'Checking for updates…'
    case 'none': return 'You have the latest version.'
    case 'available': return s.reason !== undefined
      ? `Version ${s.version} is available, but it can't be downloaded from here: ${s.reason}`
      : `Version ${s.version} is available.`
    case 'downloading': return s.restartAfterDownload
      ? `Downloading version ${s.version}… ${s.percent}%. Delegatto restarts into it when it’s done.`
      : `Downloading version ${s.version}… ${s.percent}%`
    case 'ready': return autoInstall
      ? `Version ${s.version} is ready. It installs the next time Delegatto is idle, or restart now.`
      : `Version ${s.version} is ready. Restart Delegatto to install it.`
    case 'error': return `Couldn't check for updates: ${s.message}`
    case 'unsupported': return s.reason
  }
}

/** "Update and restart": downloads if needed, installs and restarts, straight away if that
 *  interrupts nothing, otherwise it asks first. */
function useRestartRequest(): { request: () => void; dialog: ReactNode } {
  const [work, setWork] = useState<RestartWork | null>(null)
  const open = work !== null
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { void api.updateRestartWork().then(setWork).catch(() => {}) }, 2000)
    return () => clearInterval(timer)
  }, [open])
  const request = (): void => {
    void api.updateRestartWork().then(w => {
      if (nothingToInterrupt(w)) void api.updateAndRestart('whenFinished')
      else setWork(w)
    })
  }
  return { request, dialog: work === null ? null : <RestartDialog work={work} onClose={() => setWork(null)} /> }
}

function RestartDialog({ work, onClose }: { work: RestartWork; onClose: () => void }) {
  const clear = nothingToInterrupt(work)
  const working = work.chats.length > 0
  return createPortal(
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Restart to update">
      <div className="modal restart-dialog">
        <h2 className="modal-title">{clear ? 'Nothing is running now' : working ? 'Claude is still working' : 'You have an unsent message'}</h2>
        {working && (
          <ul className="restart-chats">
            {work.chats.map((title, i) => <li key={i}>{title}</li>)}
          </ul>
        )}
        {working && <p className="settings-note">Restarting now stops {work.chats.length === 1 ? 'this chat' : 'these chats'}. What’s saved so far stays, but you’d have to tell Claude to carry on. A command already running can keep going after the restart with nothing watching it, so it may still change files.</p>}
        {work.unsent && <p className="settings-note">A message you’ve typed, queued or attached hasn’t been sent. Restarting now loses it.</p>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          {clear
            ? <button type="button" className="btn-primary" onClick={() => { onClose(); void api.updateAndRestart('whenFinished') }}>Update and restart</button>
            : <>
                <button type="button" className="btn-secondary" onClick={() => { onClose(); void api.updateAndRestart('now') }}>Restart now</button>
                <button type="button" className="btn-primary" autoFocus onClick={() => { onClose(); void api.updateAndRestart('whenFinished') }}>Restart when finished</button>
              </>}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Live update status (subscribes to main's broadcasts). */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.getUpdateStatus().then(setStatus).catch(() => {})
    return api.onUpdateStatus(setStatus)
  }, [])
  return status
}

/** Settings > Updates: current version, status, and the actions that apply. */
export function UpdatesPanel({ autoInstall }: { autoInstall: boolean }) {
  const status = useUpdateStatus()
  const restart = useRestartRequest()
  // Opening this tab checks right away. Main ignores it when a check is already running, or
  // when an update is downloading or ready, and development builds never check.
  useEffect(() => { void api.checkForUpdates().catch(() => {}) }, [])
  if (status === null) return null
  const busy = status.state === 'checking' || status.state === 'downloading'
  return (
    <div className="updates-panel">
      <div className="settings-row">
        <div className="settings-row-label">Delegatto {status.currentVersion}
          <span className="settings-hint">
            {status.channel === 'portable' ? 'Portable version: a new version downloads beside this file, starts, and removes the old one.' : status.channel === 'dev' ? 'Development build.' : 'Installed version: a new version downloads only when you click Update and restart.'}
          </span>
        </div>
      </div>
      <p className={`updates-status updates-${status.state}`}>{status.restartWaiting !== null ? `${describeRestartWait(status.restartWaiting)}.` : describeUpdate(status, autoInstall)}</p>
      <div className="updates-actions">
        {status.channel !== 'dev' && status.state !== 'ready' && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void api.checkForUpdates()}>
            {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {status.state === 'ready' && status.restartWaiting === null && (
          <button type="button" className="btn-primary" onClick={restart.request}>Restart to update</button>
        )}
        {status.state === 'downloading' && status.restartAfterDownload && (
          <button type="button" className="btn-secondary" onClick={() => void api.cancelUpdateRestart()}>Don’t restart</button>
        )}
        {status.state === 'ready' && status.restartWaiting !== null && (
          <>
            <button type="button" className="btn-secondary" onClick={() => void api.cancelUpdateRestart()}>Don’t restart</button>
            <button type="button" className="btn-primary" onClick={() => void api.installUpdate()}>Restart now</button>
          </>
        )}
        {status.state === 'available' && (status.reason !== undefined
          ? <button type="button" className="btn-primary" onClick={() => void api.openUpdateDownload()}>Open the download page</button>
          : <button type="button" className="btn-primary" onClick={restart.request}>Update and restart</button>)}
      </div>
      {restart.dialog}
    </div>
  )
}

/** The corner icon: there's a new version, and a click updates. */
export function UpdateIcon() {
  const status = useUpdateStatus()
  const restart = useRestartRequest()
  if (status === null) return null
  // Waiting to restart has its own bar, with a way to change your mind.
  if (status.restartWaiting !== null || status.restartAfterDownload) return null
  const downloading = status.state === 'downloading'
  const canAct = status.state === 'ready' || status.state === 'available'
  if (!downloading && !canAct) return null
  return (
    <>
      <button type="button" className={`update-icon${downloading ? ' update-icon-busy' : ''}`} disabled={downloading}
        title={downloading ? `A new version is downloading (${status.percent}%)` : status.state === 'ready' ? 'A new version is ready, click to restart into it' : 'A new version is available, click to update and restart'}
        aria-label={downloading ? 'A new version is downloading' : status.state === 'ready' ? 'A new version is ready, click to restart into it' : 'A new version is available, click to update and restart'}
        onClick={() => {
          if (status.state === 'ready' || (status.state === 'available' && status.reason === undefined)) restart.request()
          else void api.openUpdateDownload()
        }}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.8 8 10.3l3.5-3.5M3 13.5h10" /></svg>
      </button>
      {restart.dialog}
    </>
  )
}

/** A slim bar for what the icon can't say: the restart being held for you, or an update
 *  that just happened. */
export function UpdateBar() {
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (status === null) return null
  if (status.state === 'downloading' && status.restartAfterDownload) {
    return (
      <div className="update-bar" role="status">
        <span>Updating to Delegatto {status.version}: downloading, {status.percent}%. It restarts by itself when it’s done.</span>
        <button type="button" className="update-bar-btn" onClick={() => void api.cancelUpdateRestart()}>Don’t restart</button>
      </div>
    )
  }
  if (status.state === 'ready' && status.restartWaiting !== null) {
    return (
      <div className="update-bar" role="status">
        <span>Delegatto {status.version}: {describeRestartWait(status.restartWaiting).toLowerCase()}.</span>
        <button type="button" className="update-bar-btn" onClick={() => void api.installUpdate()}>Restart now</button>
        <button type="button" className="update-bar-btn update-bar-btn-next" onClick={() => void api.cancelUpdateRestart()}>Don’t restart</button>
      </div>
    )
  }
  if (!status.justUpdated || dismissed === status.currentVersion) return null
  return (
    <div className="update-bar" role="status">
      <span>Updated to Delegatto {status.currentVersion}.</span>
      <button type="button" className="update-bar-x" aria-label="Dismiss" onClick={() => setDismissed(status.currentVersion)}>✕</button>
    </div>
  )
}
