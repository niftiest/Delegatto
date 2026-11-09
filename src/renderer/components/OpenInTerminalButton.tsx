import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogTarget } from './DialogHost'
import { escapeIsFor } from '../escape-scope'

/** The header's terminal button. Moving a chat to a terminal takes it out of the app's
 *  hands, so it asks first. While Claude is replying the move can't happen, so going
 *  straight on lets `onOpen` say so rather than asking about something that won't work. */
export function OpenInTerminalButton({ running, onOpen }: { running: boolean; onOpen: () => void }) {
  const dialogTarget = useDialogTarget()
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    // Ahead of everything else: behind this dialog, Esc would act on the message box.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !escapeIsFor(dialogTarget, e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setAsking(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [asking, dialogTarget])
  return (
    <>
      <button type="button" className="chead-term chead-term-icon" title="Open in terminal" aria-label="Open in terminal"
        onClick={() => { if (running) onOpen(); else setAsking(true) }}>
        <svg viewBox="0 0 20 18" aria-hidden="true">
          <rect x=".5" y=".5" width="19" height="17" rx="1.5" fill="#0c0c0c" stroke="#8a8a8a" />
          <rect x="1" y="1" width="18" height="3.5" fill="#c9c9c9" />
          <path d="M4 7.5l3.2 2.7L4 12.9M9 13.5h5.5" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {asking && createPortal(
        <div className="modal-overlay app-dialog-overlay" role="presentation">
          <div className="modal app-dialog" role="alertdialog" aria-modal="true" aria-label="Move this chat to a terminal?">
            <h2 className="modal-title">Move this chat to a terminal?</h2>
            <p className="app-dialog-detail">Claude Code will open this chat in a terminal and take control of it from Delegatto.</p>
            <p className="app-dialog-detail">While it's open there, the chat is read-only here, though new messages still show up. Close the terminal to carry on here.</p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setAsking(false)}>Cancel</button>
              <button type="button" className="btn-primary" autoFocus onClick={() => { setAsking(false); onOpen() }}>Continue</button>
            </div>
          </div>
        </div>,
        dialogTarget
      )}
    </>
  )
}
