import { useEffect, useState } from 'react'
import { api } from '../api'
import type { LoginState } from '../../shared/login-types'

/** Signs in to Claude Code without a terminal, for when its login has expired or is missing.
 *  The browser opens by itself and the sign-in finishes when it's done there. A code can be
 *  pasted instead, for signing in on another device. */
export function SignInDialog({ reason, onClose }: {
  /** Why it opened: an expired login, or the user asked (`/login`). */
  reason: 'expired' | 'asked'
  onClose: () => void
}) {
  const [state, setState] = useState<LoginState>({ state: 'idle' })
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void api.loginState().then(setState).catch(() => {})
    return api.onLoginChanged(setState)
  }, [])

  const close = (): void => {
    if (state.state === 'waiting' || state.state === 'starting') void api.loginCancel()
    onClose()
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <div className="modal sync-dialog" role="dialog" aria-modal="true" aria-label="Sign in to Claude">
        <h2 className="modal-title">{state.state === 'done' ? 'Signed in' : reason === 'expired' ? 'You’re signed out of Claude' : 'Sign in to Claude'}</h2>

        {(state.state === 'idle' || state.state === 'failed') && <>
          <p className="settings-note">
            {reason === 'expired'
              ? 'Claude Code’s sign-in on this PC has expired, so it can’t reply. Sign in again to carry on. Nothing in your chats is lost.'
              : 'Sign in with your Claude account. This replaces the account Claude Code uses on this PC.'}
          </p>
          {state.state === 'failed' && <div className="modal-error">Signing in didn’t work: {state.error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
            <button type="button" className="btn-primary" autoFocus onClick={() => void api.loginStart().then(setState)}>{state.state === 'failed' ? 'Try again' : 'Sign in'}</button>
          </div>
        </>}

        {state.state === 'starting' && <p className="settings-note">Opening the sign-in page…</p>}

        {state.state === 'waiting' && <>
          <p className="settings-note">Finish signing in in the browser window that just opened. This closes by itself when you’re done.</p>
          <div className="sync-progress busy" role="progressbar" aria-label="Waiting for sign-in"><i /></div>
          <div className="sync-actions">
            <button type="button" className="btn-secondary" onClick={() => void api.loginStart()}>Open the page again</button>
          </div>
          <details className="sync-advanced">
            <summary>Signing in on another device?</summary>
            <p className="settings-note">Open this link there. When it shows a code, paste it here.</p>
            <div className="sync-actions">
              <button type="button" className="btn-secondary" onClick={() => {
                void navigator.clipboard.writeText(state.manualUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
              }}>{copied ? 'Copied' : 'Copy the link'}</button>
            </div>
            <input className="field-input" type="text" value={code} placeholder="Paste the code" aria-label="Sign-in code"
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && code.trim().length > 0 && !state.submitting) void api.loginSubmitCode(code) }} />
            {state.error !== null && <div className="modal-error">{state.error}</div>}
            <div className="sync-actions">
              <button type="button" className="btn-primary" disabled={code.trim().length === 0 || state.submitting} onClick={() => void api.loginSubmitCode(code)}>
                {state.submitting ? 'Checking…' : 'Use this code'}
              </button>
            </div>
          </details>
          <div className="modal-actions"><button type="button" className="btn-secondary" onClick={close}>Cancel</button></div>
        </>}

        {state.state === 'done' && <>
          <p className="settings-note">
            Signed in{state.email !== null ? ` as ${state.email}` : ''}{state.plan !== null ? ` (${state.plan})` : ''}.
            {reason === 'expired' ? ' Send your message again to carry on.' : ''}
          </p>
          <div className="modal-actions"><button type="button" className="btn-primary" autoFocus onClick={onClose}>Done</button></div>
        </>}
      </div>
    </div>
  )
}
